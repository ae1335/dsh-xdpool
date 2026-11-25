/**
 * Points automation: the daily pass that keeps every account earning.
 *
 * Three independent jobs run on their own hour lists:
 *
 * - `report` (default 10:00) sends one chat-activity event per account per day.
 *   This is what lights the growth streak and unlocks the `first_buddy` family,
 *   so it must run BEFORE the task-centre pass — otherwise the task list is
 *   read before its counters can have moved.
 * - `tasks`  (default 11:00) enrols every open task and claims every reward the
 *   account has already earned.
 * - `checkin` (default 09:00) is the plain daily check-in.
 *
 * Scheduling follows the reference panel's model rather than a cron: the loop
 * wakes once a minute, and a job fires when the local hour matches one of its
 * configured hours and it has not yet run today. "Run today" is tracked per job
 * as a `YYYY-MM-DD` string, which self-resets at midnight.
 *
 * Everything is serial and failure-isolated: one account throwing skips that
 * account and continues with the next, and one job throwing never stops the
 * loop. `global`-region accounts are skipped entirely — the international
 * gateway has no growth/task system, so calling it would only produce noise.
 */

import type { WorkBuddyAccount, WorkBuddyAccountPool, WorkBuddyCredential } from './accounts'
import { isAlreadyCheckin, isNoCompensation } from './upstream'
import type { WorkBuddyTask, WorkBuddyUpstreamClient } from './upstream'
import { APPEARANCE_THEME_KEY, LIGHTHOUSE_EXPERT_ID, appearanceChain, automationChain, buddyAppChain, canvasChain, chatChain, expertActualUseEvent, expertChatEvents, expertFromTask, expertIdFromJumpUrl, expertSummonEvents, libraryReadChain, playbookChain, skillChain, templateChains } from './task-events.ts'
import type { MarketExpert, TaskEventChain } from './task-events.ts'
import { DEFAULT_AUTOMATION_HOURS } from './status-paths.ts'
import type { PoolWebAutomationItem } from './status-paths.ts'
import { AUTOMATION_ACCOUNT_DELAY_MS, AUTOMATION_TICK_MS, EMPTY_JOB_STATE, EVENT_CHAIN_BUILDERS, EVENT_SCORE_WAIT_MS, EXPERT_SUMMON_GAP_MS, JOB_KINDS, LIGHTHOUSE_EXPERT, dayKey, diffEarnings, eligible, hoursOrDefault, sleep, slotKey, zonedParts } from './scheduler-core.ts'
import type { AutomationAccountEarnings, AutomationJobKind, AutomationJobState, AutomationLedger, AutomationOptions, AutomationRunSummary, AutomationStatus, JobKind, SchedulerLogger } from './scheduler-types.ts'

export class WorkBuddyScheduler {
  private readonly pool: WorkBuddyAccountPool

  private readonly client: WorkBuddyUpstreamClient

  private readonly logger: SchedulerLogger

  private readonly now: () => Date

  private readonly delayMs: number

  /**
   * How long to wait for event scoring before re-reading the task list.
   * Tests set 0 so a pass does not spend nine real seconds per account.
   */
  private readonly eventScoreWaitMs: number

  /**
   * Gap between two expert summon chains.
   * Tests set 0 so a pass does not spend six real seconds per expert.
   */
  private readonly expertGapMs: number

  private enabled: boolean

  private checkinHours: readonly number[]

  private taskHours: readonly number[]

  private reportHours: readonly number[]

  private streakHours: readonly number[]
  private travelHours: readonly number[]
  private compensationHours: readonly number[]

  private timer: NodeJS.Timeout | undefined

  private running = false

  /** Guards against a slow run overlapping the next tick. */
  private busy = false
  /** True while a manual run is in flight, so the card can poll it. */
  private runInFlight = false

  /**
   * Set once {@link stop} is called.
   *
   * Deliberately false before `start`: the loop is not running yet, but a
   * manual `tick` must still work. `stop` is what makes a run abandon the
   * accounts it has not reached yet.
   */
  private stopped = false

  private readonly states: Record<JobKind, AutomationJobState> = {
    checkin: { ...EMPTY_JOB_STATE },
    report: { ...EMPTY_JOB_STATE },
    tasks: { ...EMPTY_JOB_STATE },
    streak: { ...EMPTY_JOB_STATE },
    travel: { ...EMPTY_JOB_STATE },
    compensation: { ...EMPTY_JOB_STATE },
  }

  private claimableSeen = 0
  /**
   * Credits/energy/tasks earned per account TODAY, keyed by account id.
   *
   * Cleared whenever the day key rolls over, so the card always answers
   * "what did the automation get for THIS account today".
   */
  private earnings = new Map<string, AutomationAccountEarnings>()
  /** Day key the counters above belong to. */
  private earningsDate = ''
  /** Host hooks that persist the ledger across restarts. */
  private readonly loadEarnings: (() => AutomationLedger | undefined) | undefined
  private saveEarningsFn: ((ledger: AutomationLedger) => void | Promise<void>) | undefined

  /**
   * The most recent ledger write that may still be in flight.
   *
   * `persistEarnings` is synchronous from its callers' point of view, but the
   * host's settings write is not: it is an async document update. Keeping the
   * promise here is what lets {@link flushEarnings} wait for the write that
   * matters — the last one before a restart — without making every counter
   * update await disk.
   */
  private pendingEarningsWrite: Promise<void> = Promise.resolve()

  constructor(pool: WorkBuddyAccountPool, client: WorkBuddyUpstreamClient, options: AutomationOptions = {}) {
    this.pool = pool
    this.client = client
    this.logger = options.logger ?? {}
    this.now = options.now ?? (() => new Date())
    this.delayMs = options.accountDelayMs ?? AUTOMATION_ACCOUNT_DELAY_MS
    this.eventScoreWaitMs = options.eventScoreWaitMs ?? EVENT_SCORE_WAIT_MS
    this.expertGapMs = options.expertGapMs ?? EXPERT_SUMMON_GAP_MS
    this.loadEarnings = options.loadEarnings
    this.saveEarningsFn = options.saveEarnings
    // Restore today's ledger, discarding one from an earlier day: the counters
    // answer "what did the automation get TODAY", so yesterday's totals must not
    // be presented as today's.
    const restored = options.loadEarnings?.()
    const today = dayKey(this.now())
    if (restored !== undefined && restored.date === today) {
      for (const [id, entry] of Object.entries(restored.accounts)) this.earnings.set(id, entry)
      this.earningsDate = today
    }
    this.enabled = options.enabled ?? false
    this.checkinHours = hoursOrDefault(options.checkinHours, DEFAULT_AUTOMATION_HOURS.checkin)
    this.reportHours = hoursOrDefault(options.reportHours, DEFAULT_AUTOMATION_HOURS.report)
    this.taskHours = hoursOrDefault(options.taskHours, DEFAULT_AUTOMATION_HOURS.tasks)
    this.streakHours = hoursOrDefault(options.streakHours, DEFAULT_AUTOMATION_HOURS.streak)
    // Two passes, not one: a trip loop needs a departure AND a collection, and
    // a cat sent out at the single pass of the day would sit there until
    // tomorrow. Morning out, evening back — the reference panel settled on the
    // same pair for the same reason.
    this.travelHours = hoursOrDefault(options.travelHours, DEFAULT_AUTOMATION_HOURS.travel)
    // Late in the morning, on purpose: the compensation offer appears when the
    // outage is announced, so an early slot would find nothing. By mid-morning a
    // fresh offer is live and the deadline (typically days out) still has room.
    this.compensationHours = hoursOrDefault(options.compensationHours, DEFAULT_AUTOMATION_HOURS.compensation)
  }

  /** Apply a new configuration; safe to call while running. */
  /**
   * Install the persistence hook once the host settings service is available.
   *
   * Separate from the constructor because the scheduler is built with the pool,
   * long before the settings section exists; a ledger written before that point
   * would have nowhere to go.
   */
  setEarningsPersistence(save: (ledger: AutomationLedger) => void | Promise<void>): void {
    this.saveEarningsFn = save
  }

  /**
   * Wait for the ledger write that is (or was last) in flight.
   *
   * Called at the END of a task pass, right after the last claim, so the rewards
   * that were just collected are on disk before a restart can lose them. It is
   * deliberately NOT awaited on every counter bump: the settings document write
   * is the slow part, and paying it per account would slow the pass for no
   * benefit while the process is still alive.
   */
  async flushEarnings(): Promise<void> {
    await this.pendingEarningsWrite
  }

  /**
   * Fold a previously persisted ledger back in, when it belongs to today.
   *
   * Used after the settings document becomes readable, which happens after
   * construction; a ledger from an earlier day is ignored so the counters never
   * claim yesterday as today.
   */
  applyEarningsLedger(ledger: AutomationLedger): void {
    const today = dayKey(this.now())
    if (ledger.date !== today) return
    for (const [id, entry] of Object.entries(ledger.accounts)) this.earnings.set(id, entry)
    this.earningsDate = today
  }

  applyConfig(options: AutomationOptions): void {
    if (options.enabled !== undefined) this.enabled = options.enabled
    // Each hour list falls back to its default when it arrives EMPTY, for the
    // same reason the constructor does: an absent list is materialized as `[]`
    // by the settings schema, so a plain `!== undefined` test adopted the empty
    // array and the constructor defaults could never apply. That is how a
    // switched-ON automation ended up with no runnable hour at all.
    if (options.checkinHours !== undefined) {
      this.checkinHours = hoursOrDefault(options.checkinHours, DEFAULT_AUTOMATION_HOURS.checkin)
    }
    if (options.reportHours !== undefined) {
      this.reportHours = hoursOrDefault(options.reportHours, DEFAULT_AUTOMATION_HOURS.report)
    }
    if (options.taskHours !== undefined) {
      this.taskHours = hoursOrDefault(options.taskHours, DEFAULT_AUTOMATION_HOURS.tasks)
    }
    if (options.streakHours !== undefined) {
      this.streakHours = hoursOrDefault(options.streakHours, DEFAULT_AUTOMATION_HOURS.streak)
    }
    if (options.travelHours !== undefined) {
      this.travelHours = hoursOrDefault(options.travelHours, DEFAULT_AUTOMATION_HOURS.travel)
    }
    if (options.compensationHours !== undefined) {
      this.compensationHours = hoursOrDefault(options.compensationHours, DEFAULT_AUTOMATION_HOURS.compensation)
    }
  }

  /** Hours for one job, used by the loop and the status document. */
  private hoursOf(kind: JobKind): readonly number[] {
    switch (kind) {
      case 'checkin': return this.checkinHours
      case 'report': return this.reportHours
      case 'tasks': return this.taskHours
      case 'streak': return this.streakHours
      case 'travel': return this.travelHours
      case 'compensation': return this.compensationHours
    }
  }

  /** Start the loop. Idempotent. */
  start(): void {
    if (this.timer !== undefined) return
    this.stopped = false
    this.running = true
    // Unref so the plugin never keeps a host process alive on its own.
    this.timer = setInterval(() => { void this.tick() }, AUTOMATION_TICK_MS)
    this.timer.unref?.()
  }

  /** Stop the loop. Idempotent, and safe before `start`. */
  stop(): void {
    this.stopped = true
    this.running = false
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Snapshot for the status document. */
  /**
   * Run one job immediately, regardless of the clock.
   *
   * Exists so the automation can be verified from the card without waiting for
   * its hour. A manual run is recorded exactly like a scheduled one, so the
   * timer will not repeat it later the same day: every job is idempotent, but a
   * second pass would still be wasted upstream calls.
   *
   * `force` ignores the already-ran-today guard, which is what pressing the
   * button a second time means.
   */
  async runNow(kind: AutomationJobKind, force = false): Promise<AutomationJobState> {
    const today = dayKey(this.now())
    const state = this.states[kind]
    // Throttle on the START hour, not on the schedule ledger: a manual run is
    // an explicit "do it now", so a second press inside the same hour is a
    // no-op, but it never pretends a scheduled slot ran.
    if (!force && state.lastFiredHour === slotKey(this.now())) return { ...state }
    // Same lock discipline as `tick`: never start a manual run while a pass
    // is already in flight, or the two would interleave on the same ledger.
    if (this.busy) return { ...state }
    this.busy = true
    try {
      // No `consumedSlot`: a manual run does not spend a scheduled candidate.
      await this.runJob(kind, today)
    } finally {
      this.busy = false
    }
    return { ...this.states[kind] }
  }

  /**
   * Run every job once, in the scheduled order.
   *
   * Order matters and is not configurable: the activity report has to land
   * before the task pass reads task progress, or the pass sees counters the
   * report would have moved. This is what the card's single button calls.
   */
  /**
   * Start a full pass in the background and return immediately.
   *
   * A pass takes tens of seconds - one upstream round trip per account per job,
   * plus the scoring wait - which is far too long to hold the card request open:
   * the browser or the host web server would time out, and the user would see
   * a hung button for a run that is actually working.
   *
   * Returns whether a run started. A second call while one is in flight is
   * ignored rather than queued: pressing the button twice means hurry up, and
   * the run already under way covers it.
   */
  startRunAll(): boolean {
    if (this.runInFlight) return false
    this.runInFlight = true
    void this.runAll()
      .catch((error: unknown) => {
        this.logger.warn?.('dsh-xdpool automation run failed:', error)
      })
      .finally(() => { this.runInFlight = false })
    return true
  }

  async runAll(): Promise<AutomationRunSummary> {
    // Refuse to interleave with a `tick` already in flight: both move the same
    // per-account ledger, and stepping in mid-pass would double-run a job.
    // (`startRunAll`'s `runInFlight` guards two button presses; this guards the
    // button against the timer.)
    if (this.busy) {
      return { jobsRun: 0, okCount: 0, failed: 0, credit: 0, energy: 0, claimed: 0, accounts: {} }
    }
    const today = dayKey(this.now())
    const before = this.earningsSnapshot()
    let okCount = 0
    let failed = 0
    let jobsRun = 0
    // Hold the busy lock for the WHOLE pass, not per job. Unlocking between
    // jobs opened a window where the timer's `tick` could step in and interleave
    // with the manual pass on the same ledger (two passes moving the same
    // counters at once). One lock for the whole pass matches `tick`'s discipline.
    this.busy = true
    try {
      for (const kind of JOB_KINDS) {
        // Runs EVERY job, including one whose hour list is empty: the button
        // is an explicit "do everything now", and a job with no schedule is
        // still one the user can want executed on demand.
        //
        // No `consumedSlot` is passed, deliberately. A manual pass is an EXTRA
        // run, not a substitute for the schedule: consuming the day's remaining
        // candidates here would mean one button press cancels today's 21:00 cat
        // trip. The scheduled hours still fire on their own; this only adds a
        // run on top. (The trade-off is that a manual pass does not suppress the
        // next automated one — which is the safer direction, and each job is
        // idempotent anyway.)
        jobsRun += 1
        await this.runJob(kind, today)
        okCount += this.states[kind].ok
        failed += this.states[kind].failed
      }
    } finally {
      this.busy = false
    }
    // Diff the ledger against the pre-run snapshot. Summing per-job state
    // would mix one job's counters into another's, and reporting the
    // absolute totals would re-count everything claimed earlier today.
    const after = this.earningsSnapshot()
    const gained = diffEarnings(before, after)
    return {
      jobsRun,
      okCount,
      failed,
      credit: gained.credit,
      energy: gained.energy,
      claimed: gained.claimed,
      accounts: gained.accounts,
    }
  }

  status(): AutomationStatus {
    const jobs = {} as AutomationStatus['jobs']
    for (const kind of JOB_KINDS) jobs[kind] = { ...this.states[kind] }
    return {
      enabled: this.enabled,
      running: this.running,
      checkinHours: this.checkinHours,
      taskHours: this.taskHours,
      reportHours: this.reportHours,
      streakHours: this.streakHours,
      travelHours: this.travelHours,
      compensationHours: this.compensationHours,
      jobs,
      claimableSeen: this.claimableSeen,
      earningsToday: this.earningsSnapshot(),
      runInProgress: this.runInFlight, 
    }
  }

  /**
   * One poll: run every due job, serially.
   *
   * Serial by design — the jobs share the same accounts and the upstream
   * rate-limits per account, so overlapping passes would only trip that limit.
   * A job that throws is recorded and the loop continues.
   */
  /**
   * Whether `kind` is due at `now`: its earliest configured hour has passed in
   * the scheduling timezone, and no hour of today has been consumed yet.
   *
   * Hours are consumed per SLOT (one entry per configured hour), so a job with
   * two hours still runs twice a day — but a job whose hour passed while DSH was
   * closed runs immediately on the next tick instead of waiting for tomorrow.
   */
  /**
   * The configured slot `kind` should consume at `now`, or undefined when none.
   *
   * Returns the SLOT STRING (not a boolean) because the caller must record the
   * same value it acted on. Returning a boolean was the original bug's enabler:
   * the tick asked "is it due", then `runJob` independently wrote "what time is
   * it now" — and those two answers were almost never equal.
   *
   * CATCH-UP semantics are deliberate: a candidate fires once its hour has
   * PASSED and its slot is still unconsumed, so a laptop that slept through
   * 10:00 still runs the job when it wakes, on the same day.
   *
   * The EARLIEST unconsumed candidate wins, which is what keeps a two-hour job
   * (`travelHours: [9, 21]`) whole: consuming the earliest due slot leaves the
   * later one for its own hour.
   */
  private dueSlot(kind: JobKind, now: Date): string | undefined {
    const hours = this.hoursOf(kind)
    if (hours.length === 0) return undefined
    const current = Number(zonedParts(now).hour)
    const today = dayKey(now)
    const fired = this.firedSlotsOf(kind)
    // Ordered by configured hour, so the first match is the earliest due one.
    for (const candidate of [...hours].sort((a, b) => a - b)) {
      if (candidate > current) break
      const slot = `${today}T${String(candidate).padStart(2, '0')}`
      if (!fired.has(slot)) return slot
    }
    return undefined
  }

  /** Today's consumed slots for one job, as a set. */
  private firedSlotsOf(kind: JobKind): Set<string> {
    const state = this.states[kind]
    const stored = state.firedSlots
    if (stored === undefined) return new Set<string>()
    // Drop entries from earlier days as we read: the set only ever answers
    // "has TODAY's candidate run", so carrying yesterday's keys forward would
    // grow it without bound and never change an answer.
    const today = dayKey(this.now())
    return new Set(stored.filter(slot => slot.startsWith(`${today}T`)))
  }

  /** Record one consumed slot on a job's state. */
  private consumeSlot(kind: JobKind, slot: string): void {
    const state = this.states[kind]
    const today = dayKey(this.now())
    const next = new Set([...this.firedSlotsOf(kind), slot])
    // Persist in a stable order so the status document (and any future
    // persistence of it) does not churn between reads.
    state.firedSlots = [...next].filter(entry => entry.startsWith(`${today}T`)).sort()
  }

  private async tick(): Promise<void> {
    if (!this.enabled || this.stopped || this.busy) return
    this.busy = true
    try {
      const now = this.now()
      const slot = slotKey(now)
      const today = dayKey(now)
      for (const kind of JOB_KINDS) {
        if (this.stopped) return
        // Throttle only: never start the same job twice inside one clock hour.
        // This is NOT the schedule ledger — that is `firedSlots`, checked by
        // `dueSlot` below. Tying the throttle to the ledger is what let a
        // catch-up run consume a slot it had not actually been scheduled for.
        if (this.states[kind].lastFiredHour === slot) continue
        // CATCH-UP: run if the configured hour has already PASSED and that
        // slot is still unconsumed. The old equality test (`hour === configured`)
        // silently skipped the day whenever DSH was not running at that exact
        // hour — a 09:00 check-in never ran if the app started at 10:00. Asking
        // "has the hour passed, and is that slot still unspent" makes a missed
        // schedule self-heal on the next tick, which is what a laptop that
        // slept through the hour needs.
        const consumed = this.dueSlot(kind, now)
        if (consumed === undefined) continue
        await this.runJob(kind, today, consumed)
      }
    } catch (error: unknown) {
      // A defect in the loop itself must not kill the timer.
      this.logger.warn?.('dsh-xdpool automation tick failed:', error)
    } finally {
      this.busy = false
    }
  }

  /** Run one job against every eligible account and record the outcome. */
  /**
   * Add one account's take to today's counters, resetting first if the day
   * rolled over. Called from the task pass, which is the only job that earns.
   */
  /**
   * Today's per-account earnings, as a plain object for the status document.
   *
   * Rolls the day first so a status read just after midnight does not report
   * yesterday's totals under today's date.
   */
  private earningsSnapshot(): Record<string, AutomationAccountEarnings> {
    this.rollEarnings(dayKey(this.now()))
    const out: Record<string, AutomationAccountEarnings> = {}
    for (const [id, entry] of this.earnings) out[id] = { ...entry }
    return out
  }

  /**
   * Add one account take to today counters, resetting first if the day rolled
   * over. Every source is tracked separately so the card can show what earned
   * what, rather than one opaque total.
   */
  private recordEarnings(
    accountId: string,
    today: string,
    delta: Partial<Omit<AutomationAccountEarnings, 'date'>>,
  ): void {
    this.rollEarnings(today)
    const credit = delta.credit ?? 0
    const energy = delta.energy ?? 0
    const claimed = delta.claimed ?? 0
    const checkinCredit = delta.checkinCredit ?? 0
    const bonusCredit = delta.bonusCredit ?? 0
    const travelCredit = delta.travelCredit ?? 0
    const compensationCredit = delta.compensationCredit ?? 0
    const empty = credit === 0 && energy === 0 && claimed === 0
      && checkinCredit === 0 && bonusCredit === 0 && travelCredit === 0
      && compensationCredit === 0
    if (empty) return
    const existing = this.earnings.get(accountId)
    this.earnings.set(accountId, {
      credit: (existing?.credit ?? 0) + credit,
      energy: (existing?.energy ?? 0) + energy,
      claimed: (existing?.claimed ?? 0) + claimed,
      checkinCredit: (existing?.checkinCredit ?? 0) + checkinCredit,
      bonusCredit: (existing?.bonusCredit ?? 0) + bonusCredit,
      travelCredit: (existing?.travelCredit ?? 0) + travelCredit,
      compensationCredit: (existing?.compensationCredit ?? 0) + compensationCredit,
      date: today,
    })
    // Persisted on every write: a restart mid-day must not wipe what was
    // already earned, or the card would show nothing for real rewards.
    //
    // The promise is also kept, so a run that is about to END can await the
    // LAST write: reported in #98, a task pass claimed 21 tasks and the process
    // restarted before the settings write reached disk, leaving the ledger at
    // `credit: 0` while the upstream had really paid out. Ordinary callers keep
    // ignoring it — that is what makes this synchronous from their side.
    this.pendingEarningsWrite = this.persistEarnings()
  }

  /** Clear the per-account counters when the local day changes. */
  private rollEarnings(today: string): void {
    if (this.earningsDate === today) return
    this.earningsDate = today
    this.earnings.clear()
    this.claimableSeen = 0
    this.persistEarnings()
  }

  /**
   * Write the ledger through the host hook, when one was supplied.
   *
   * Best effort on purpose: a failed save must never abort a run that has
   * already collected rewards, and the in-memory ledger keeps serving the card
   * for the rest of the session either way.
   *
   * The returned promise settles when the write has landed (or failed). Callers
   * that are about to END a run await it: reported in #98, a task pass that
   * claimed 21 tasks had its process restarted before the volatile settings
   * write reached disk, so `automationEarnings` still read `credit: 0` while
   * the upstream had really paid out. Fire-and-forget is fine for a counter the
   * card will re-read in this process; it is not fine for the last write before
   * exit.
   */
  private persistEarnings(): Promise<void> {
    const save = this.saveEarningsFn
    if (save === undefined) return Promise.resolve()
    const accounts: Record<string, AutomationAccountEarnings> = {}
    for (const [id, entry] of this.earnings) accounts[id] = entry
    const ledger = { date: this.earningsDate, accounts }
    try {
      const saved = save(ledger)
      // Attach the rejection handler to whatever the hook returns. `try` alone
      // catches only SYNCHRONOUS throws — an async rejection escapes, and the
      // host installs `installFailLoud`, which turns an unhandled rejection into
      // exit(1), so a failed save would take the process down instead of being
      // logged. The promise is RETURNED as well, so the caller about to end a
      // run can wait for the write to land.
      if (saved !== undefined && typeof saved.then === 'function') {
        return Promise.resolve(saved).then(undefined, (error: unknown) => {
          this.logger.warn?.('dsh-xdpool: could not persist automation earnings:', error)
        })
      }
      return Promise.resolve()
    } catch (error: unknown) {
      this.logger.warn?.('dsh-xdpool: could not persist automation earnings:', error)
      return Promise.resolve()
    }
  }


  /**
   * Run one job against every eligible account and record the outcome.
   *
   * `consumedSlot` is the configured slot this run spends (`dueSlot`'s answer).
   * It is passed IN rather than recomputed here so the value recorded is exactly
   * the value the schedule decided on — the defect this replaces wrote
   * `slotKey(now)` instead, i.e. the clock time the run finished at, which
   * almost never equals the configured candidate the gate had compared against.
   *
   * The task job runs in TWO passes. The first sends the event chains that light
   * up client-scored tasks; the second collects rewards. They are separate
   * because scoring lands asynchronously — a chain sent and claimed within the
   * same breath finds the task still un-scored — and because sending is fast
   * while claiming wants the whole pool to have been lit up first. Splitting
   * them costs one shared wait instead of one wait per account.
   */
  private async runJob(kind: JobKind, today: string, consumedSlot?: string): Promise<void> {
    const accountWord = kind === 'report' ? 'report' : kind
    let ok = 0
    let failed = 0
    let credit = 0
    let energy = 0
    let claimed = 0
    const detail: string[] = []
    /**
     * Every item this run considered, with a status attached.
     *
     * `detail` stays as the human-readable log line; this is the same work in a
     * shape the card can GROUP and COUNT, so "3 tasks unclaimed — locked" is
     * distinguishable from "0 tasks, everything already collected".
     */
    const items: PoolWebAutomationItem[] = []
    let progressNote: string | undefined
    
    // Give benched accounts a chance to come back BEFORE the run, not after.
    //
    // The cooldown that benches a rejected credential is a guess at how long the
    // problem lasts, and a wrong guess has a real cost: a token the user already
    // re-signed-into elsewhere stays out of rotation for the whole window, and an
    // upstream hiccup benches a healthy account for half an hour. Probing once per
    // run replaces "wait and hope" with "ask" — one cheap authenticated read per
    // benched account, and only a successful one clears the bench.
    //
    // `fetchCredits` is the probe because it is the cheapest call that proves the
    // credential itself is accepted: a read, no generation, and it is the same
    // endpoint the balance refresh already uses, so a passing probe also warms
    // the number the card shows.
    try {
      const revived = await this.pool.reviveBenched(credential => this.client.fetchCredits(credential))
      for (const account of revived) detail.push(`复活 ${account.label}`)
    } catch (error: unknown) {
      // A probe loop must never fail the run it was meant to help.
      this.logger.warn?.('automation: could not probe benched accounts:', error)
    }

    const accounts = this.accountsInOrder(kind)

    // Pass 1 (tasks only): light up the client-scored tasks for EVERY account
    // before claiming any of them. Claiming inside this loop would find each
    // chain still unscored, because scoring lands a few seconds later.
    if (kind === 'tasks') await this.sendEventChains(accounts)

    for (let index = 0; index < accounts.length; index++) {
      if (this.stopped) break
      const account = accounts[index]
      if (account === undefined) continue
      try {
        switch (kind) {
          case 'checkin': {
              // READ the state before spending a claim.
              //
              // The claim endpoint is idempotent — a repeat pays 0 and answers
              // with an "already checked in" error — so the old flow worked, but
              // it worked by deliberately provoking a failure. Two costs: the run
              // summary had to translate an upstream error back into success (and
              // `isAlreadyCheckin` only recognises a couple of phrasings, so an
              // unfamiliar wording turned a healthy account into a failure), and
              // every already-done account still spent a write request per run.
              //
              // Reading first makes the common case a GET: if the status already
              // says today is collected, there is nothing to claim and nothing to
              // classify. The read is allowed to fail — a status endpoint having a
              // bad minute must not cost the user their check-in — in which case
              // the old behaviour (claim, translate the error) is the fallback.
              let alreadyDone = false
              try {
                const status = await this.client.fetchCheckinStatus(account.credential)
                alreadyDone = status.todayCheckedIn === true
              } catch (error: unknown) {
                this.logger.warn?.(`automation checkin ${account.label}: status read failed, claiming anyway:`, error)
              }
              if (alreadyDone) {
                this.logger.info?.(`automation checkin ${account.label}: already done today (read, not claimed)`)
                break
              }
              try {
                const claim = await this.client.claimDailyCheckin(account.credential)
                // Check-in pays credits, so it belongs in the earnings ledger. A
                // repeat check-in pays 0, which records as a no-op.
                this.recordEarnings(account.id, today, { checkinCredit: claim.credit })
                if (claim.credit > 0) {
                  detail.push(`签到 +${claim.credit}`)
                  this.logger.info?.(`automation checkin ${account.label}: +${claim.credit} credit`)
                }
              } catch (error: unknown) {
                // Still translated, because the status read above can fail or
                // race another client: "already checked in" arriving as an error
                // is an idempotent success, and counting it as a failure would
                // make a healthy account look broken.
                if (!isAlreadyCheckin(error)) throw error
                this.logger.info?.(`automation checkin ${account.label}: already done today`)
              }
              break
            }
          case 'report': {
            const days = await this.reportOne(account)
            this.logger.info?.(`automation report ${account.label}: streak days=${days}`)
            break
          }
          case 'tasks': {
            const result = await this.runTasks(account)
            credit += result.credit
            energy += result.energy
            claimed += result.claimed
            detail.push(...result.titles)
            // Merged per item, not per account: the card shows one list of what
            // happened, and a task is the unit a person checks off.
            items.push(...result.items)
            this.claimableSeen += result.claimableCount
            this.recordEarnings(account.id, today, { credit: result.credit, energy: result.energy, claimed: result.claimed })
            this.logger.info?.(
              `automation tasks ${account.label}: ${result.claimed} claimed (+${result.credit} credit, +${result.energy} energy, ${result.claimableCount} claimable seen)`,
            )
            break
          }
          case 'streak': {
            const progress = await this.redeemStreak(account)
            if (progress !== undefined) progressNote = progress
            break
          }
          case 'travel': {
            await this.runTravel(account)
            break
          }
          case 'compensation': {
            try {
              const outcome = await this.runCompensation(account)
              // Only an offer that was actually collectable counts as earnings;
              // "no offer right now" is a successful no-op, not a failure.
              if (outcome.credit > 0) {
                detail.push(`补偿 +${outcome.credit}`)
                this.logger.info?.(`automation compensation ${account.label}: +${outcome.credit} credit`)
              }
            } catch (error: unknown) {
              // No offer for this account is the normal state for most of the
              // time, and upstream reports it as an error. Treating that as a
              // failure would make every healthy account look broken.
              if (!isNoCompensation(error)) throw error
              this.logger.info?.(`automation compensation ${account.label}: no offer to collect`)
            }
            break
          }

        }
        ok++
      } catch (error: unknown) {
        // One account failing never stops the pass: a dead token, a 429 or a
        // malformed payload on one account must not cost the other accounts
        // their daily points.
        failed++
        this.logger.warn?.(`automation ${accountWord} ${account.label} failed:`, error)
      }
      // Serial spacing, but never sleep after the final account.
      if (index < accounts.length - 1 && this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
    }

    const state = this.states[kind]
    // Three separate facts, three separate fields — collapsing any two of them
    // is what produced the "runs every hour" defect:
    //
    //   firedSlots    what the SCHEDULE spent (configured hours, a set)
    //   lastFiredHour when the run STARTED (throttle only)
    //   lastRunAtMs   when the run FINISHED (displayed on the card)
    //
    // A manual run passes no `consumedSlot`; it still stamps `lastFiredHour`
    // and `lastRunAtMs`, but it does NOT silently spend a scheduled slot it was
    // never meant to consume — pressing "run now" at 10:35 must not cancel the
    // 21:00 cat trip.
    if (consumedSlot !== undefined) this.consumeSlot(kind, consumedSlot)
    state.lastFiredHour = slotKey(this.now())
    state.lastRunDate = today
    state.lastRunAtMs = this.now().getTime()
    state.ok = ok
    state.failed = failed
    state.credit = credit
    state.energy = energy
    state.claimed = claimed
    state.message = this.summarise(kind, ok, failed, claimed, credit, energy)
    state.detail = detail
    state.items = items
    // Cleared explicitly when this run produced no milestone: `progress` is a
    // `?: string`, which under `exactOptionalPropertyTypes` cannot be assigned
    // `undefined`. Mutating a state object that may still hold LAST run's note is
    // why this deletes rather than skips.
    if (progressNote === undefined) delete state.progress
    else state.progress = progressNote
    this.logger.info?.(`automation ${accountWord}: ${state.message}`)
    // The rewards above are already recorded; make sure they are ACROSS the
    // process boundary before this run reports itself done. #98 hit the exact
    // window this closes: 21 tasks claimed, upstream paid, process restarted,
    // ledger still read `credit: 0`. Only the jobs that write earnings flush.
    if (kind === 'tasks' || kind === 'checkin' || kind === 'streak' || kind === 'travel' || kind === 'compensation') {
      await this.flushEarnings()
    }
  }

  /** Compose the one-line summary shown on the card. */
  private summarise(
    kind: JobKind,
    ok: number,
    failed: number,
    claimed: number,
    credit: number,
    energy: number,
  ): string {
    if (kind === 'tasks') {
      const suffix = failed > 0 ? `, ${failed} failed` : ''
      return `${ok} accounts, ${claimed} tasks claimed (+${credit} credit, +${energy} energy)${suffix}`
    }
    const suffix = failed > 0 ? `, ${failed} failed` : ''
    return `${ok} accounts ok${suffix}`
  }

  /**
   * Accounts to run against, in pool order.
   *
   * Disabled accounts are excluded here rather than filtered by the caller so a
   * card switch takes effect on the next pass without any event plumbing.
   *
   * `job` narrows the set by region scope: the growth jobs are CN-only while
   * check-in runs on both gateways, so eligibility cannot be decided without
   * knowing which job is about to run.
   */
  private accountsInOrder(job?: string): WorkBuddyAccount[] {
    const now = Date.now()
    return this.pool.list().filter(account => {
      if (this.pool.isDisabled(account.id)) return false
      return eligible(account, now, job)
    })
  }

  /**
   * Send one activity report, then verify it landed.
   *
   * The upstream answers 200 even when it drops the event, so the streak is
   * read back as the oracle: `days > 0` means it counted. A failed read-back is
   * logged and treated as a suspicious result, never as a retry — the report is
   * idempotent per day, and hammering it is exactly what the one-a-day quota
   * exists to avoid.
   */
  private async reportOne(account: WorkBuddyAccount): Promise<number> {
    await this.client.reportActivity(account.credential)
    try {
      const days = await this.client.growthStreakDays(account.credential)
      if (days === 0) {
        // Two innocent causes: a brand-new account whose streak is genuinely 0,
        // and the scoring lag - the counter is written asynchronously, so an
        // immediate read-back can still see the previous value (observed live
        // against one live account: 0 right after the report, 1 a minute later).
        // A later pass settles it; retrying here would only burn the quota.
        this.logger.warn?.(`automation report ${account.label}: streak days=0 right after report (new account or scoring lag?)`)
      }
      return days
    } catch (error: unknown) {
      this.logger.warn?.(`automation report ${account.label}: streak read-back failed:`, error)
      return -1
    }
  }
  private async sendEventChains(accounts: readonly WorkBuddyAccount[]): Promise<void> {
    let sentAnything = false
    for (const account of accounts) {
      if (this.stopped) return
      let tasks: readonly WorkBuddyTask[]
      try {
        tasks = await this.client.listTasks(account.credential)
      } catch (error: unknown) {
        // A read failure here is not fatal: the claim pass will read again and
        // record the failure there.
        this.logger.warn?.(`automation events ${account.label}: list failed:`, error)
        continue
      }
      // Every task still short of its target is a candidate. The chains build
      // their own ids, so there is nothing to cache between accounts.
      const pending = tasks.filter(task =>
        task.taskCode in EVENT_CHAIN_BUILDERS && !task.claimable && !task.locked)
      for (const task of pending) {
        if (this.stopped) return
        let chains: readonly TaskEventChain[]
        try {
          chains = await this.chainsFor(task, account.credential)
        } catch (error: unknown) {
          this.logger.warn?.(`automation events ${account.label}: ${task.taskCode} could not be built:`, error)
          continue
        }
        for (const chain of chains) {
          if (this.stopped) return
          try {
            await this.sendChain(account.credential, chain)
            this.logger.info?.(`automation events ${account.label}: ${task.taskCode} chain sent`)
            sentAnything = true
          } catch (error: unknown) {
            // One chain failing must not stop the others or the claim pass.
            this.logger.warn?.(`automation events ${account.label}: ${task.taskCode} failed:`, error)
            break
          }
          if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
        }
      }
    }
    // Scoring lands a few seconds after the events. Waiting it out here is what
    // lets the claim pass that follows collect the reward on THIS run instead of
    // leaving it for a later one. Paid once for the pool.
    if (sentAnything && this.eventScoreWaitMs > 0 && !this.stopped) await sleep(this.eventScoreWaitMs)
  }

  /**
   * Send one chain on the channel it was built for.
   *
   * The transport is not a detail of the sender: the scorer keys different
   * tasks to different fingerprint families, so a web-scored event posted as a
   * desktop event is accepted and then ignored.
   */
  private async sendChain(credential: WorkBuddyCredential, chain: TaskEventChain): Promise<void> {
    if (chain.transport === 'web') {
      const web = chain.web
      if (web === undefined) throw new Error('web chain without a web event')
      await this.client.reportWebEvent(credential, web.eventCode, web.pageUrl, web.elementId, web.elementName)
      return
    }
    await this.client.reportDesktopEvents(credential, chain.events ?? [])
  }

  /**
   * Build every chain that scores one task.
   *
   * Most tasks need a single chain; `template_5` needs five, because the scorer
   * counts distinct `template_used` events rather than a boolean. The two tasks
   * that join a conversation (skill, expert) open a real one first, which is why
   * this is async.
   */
  private async chainsFor(task: WorkBuddyTask, credential: WorkBuddyCredential): Promise<readonly TaskEventChain[]> {
    switch (task.taskCode) {
      case 'Buddy_App':
      case 'Buddy_App_QQ':
        return [buddyAppChain()]
      case 'create_canvas':
        return [canvasChain()]
      case 'automation_1':
        return [automationChain()]
      case 'RichMeow_Chat':
        return [chatChain()]
      case 'playbook_prompt':
        return [playbookChain()]
      case 'template_5':
        return templateChains()
      case 'Hp_Appearance':
        // The event alone is not the whole chain: the client first stores the
        // selected skin, then reports the apply on the way out of settings.
        await this.client.setAppearanceTheme(credential, APPEARANCE_THEME_KEY)
        if (this.delayMs > 0 && !this.stopped) await sleep(2_000)
        return [appearanceChain()]
      case 'Library_read':
        return [libraryReadChain()]
      case 'skill_1': {
        const chat = await this.client.openConversation(credential)
        if (chat === undefined) throw new Error('skill_1: no server conversation')
        return [skillChain(chat.conversationId, chat.requestId)]
      }
      case 'expert_5':
        return this.expertChains(credential, 'agent', task)
      case 'Expert_team_use_3':
        return this.expertChains(credential, 'team', task)
      case 'Expert_lighthouse':
        return this.lighthouseChains(credential)
      // The "体验XX专家" family, all of which behave like `Expert_lighthouse`
      // in every respect that matters: one named expert, summon then use, and
      // the id taken from the task rather than from a listing. They differ only
      // in that the use event keeps the DEFAULT `craft` mode — the LOCAL /
      // zero-cost shape is the lighthouse task's own criterion and was measured
      // to be wrong for these (#98 reports all four scoring with craft).
      case 'expert_use_maidehao':
      case 'expert_use_douyinyin':
      case 'expert_use_shangjia_xuanchuan':
      case 'expert_use_bowangwang':
      case 'WorkBuddy_Valorant':
        return this.taskExpertChains(credential, task)
      default:
        return []
    }
  }

  /**
   * Summon-and-use one expert NAMED BY THE TASK.
   *
   * Structurally `expertChains` minus the marketplace: the expert id is read
   * from the task's deeplink instead of by browsing `marketExpertList`, because
   * this family's experts are not listed there at all (#98 measured 500 entries
   * across both `agent` and `team`, zero hits).
   *
   * Returns `[]` — not a throw — when the task carries no usable id: the caller
   * logs "could not be built" only for exceptions, and a task shape this code
   * does not understand is information, not a fault.
   */
  /**
   * Find the expert a task is about, by matching its title against the
   * marketplace.
   *
   * The marketplace listing is ~500 entries across `agent` and `team`, and this
   * only runs for a task whose deeplink carried no id — at most a handful per
   * run — so the cost is acceptable. It is not cached because a freshly
   * published expert must become findable without a restart.
   *
   * Matching rules, all of them strict on purpose:
   *   - the task's title must appear IN the expert's name or profession, or the
   *     expert's display name must appear in the title (both directions, since
   *     the board and the marketplace word things differently);
   *   - comparison ignores case, whitespace and the punctuation vendors sprinkle
   *     through names;
   *   - several matches means NO answer. Summoning the wrong agent scores 0, so a
   *     guess costs an upstream call and still fails — worse than declining.
   */
  private async expertIdByKeyword(
    credential: WorkBuddyCredential,
    task: WorkBuddyTask,
  ): Promise<string | undefined> {
    const normalise = (value: string): string =>
      value.toLowerCase().replace(/[\s_\-·:：,，.。()（）【】[\]「」]/gu, '')
    const wanted = normalise(task.title)
    if (wanted === '') return undefined
    let candidates: readonly MarketExpert[]
    try {
      const [agents, teams] = await Promise.all([
        this.client.marketExpertList(credential, 'agent'),
        this.client.marketExpertList(credential, 'team'),
      ])
      candidates = [...agents, ...teams]
    } catch (error: unknown) {
      // A listing outage must not turn into a failed task: the caller treats a
      // throw as "this chain could not be built", and the task may still be
      // claimable through another route.
      this.logger.warn?.(`automation events ${task.taskCode}: marketplace lookup failed:`, error)
      return undefined
    }
    const matches = candidates.filter(candidate => {
      const name = normalise(candidate.displayName ?? '')
      const profession = normalise(candidate.profession ?? '')
      if (name === '' && profession === '') return false
      return (name !== '' && (name.includes(wanted) || wanted.includes(name)))
        || (profession !== '' && (profession.includes(wanted) || wanted.includes(profession)))
    })
    if (matches.length !== 1) {
      if (matches.length > 1) {
        this.logger.info?.(
          `automation events ${task.taskCode}: ${String(matches.length)} marketplace experts match "${task.title}", not guessing`,
        )
      }
      return undefined
    }
    const found = matches[0]
    if (found === undefined) return undefined
    this.logger.info?.(`automation events ${task.taskCode}: resolved expertId ${found.expertId} by keyword "${task.title}"`)
    return found.expertId
  }

  private async taskExpertChains(
    credential: WorkBuddyCredential,
    task: WorkBuddyTask,
  ): Promise<readonly TaskEventChain[]> {
    // Two ways to learn the expert id, in order of certainty.
    //
    // 1. The task's own deeplink. Best, because it cannot be wrong: the id came
    //    from the board that scores the task.
    // 2. A KEYWORD search of the marketplace. Added because #110's
    //    `WorkBuddy_Valorant` points at a bare `workbuddy://expert` with no query
    //    at all, so the deeplink path gave up and the task was permanently
    //    unclaimable — the id existed, it just was not written down in the one
    //    place this code looked.
    //
    // The keyword pass is deliberately conservative: it only runs when the
    // deeplink had nothing, it only accepts a match on the task's own title, and
    // it refuses when the title matches more than one expert. A wrong expert id
    // would summon somebody else's agent and still score 0, so "no answer" is
    // better than a guess.
    const fromLink = expertIdFromJumpUrl(task.jumpUrl)
    const expertId = fromLink ?? await this.expertIdByKeyword(credential, task)
    if (expertId === undefined) {
      this.logger.warn?.(`automation events ${task.taskCode}: no expertId in jump_url and no marketplace match, skipping`)
      return []
    }
    const expert = expertFromTask(expertId, task.title)
    await this.client.reportDesktopEvents(credential, expertSummonEvents(expert))
    if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
    const chat = await this.client.openConversation(credential, expert.expertId)
    if (chat === undefined) throw new Error(`${task.taskCode}: no server conversation`)
    return [{
      transport: 'desktop',
      events: [
        ...expertChatEvents(expert, chat.conversationId, chat.requestId),
        // Default `craft` mode on purpose; see the note in `chainsFor`.
        expertActualUseEvent(expert, chat.conversationId, chat.requestId),
      ],
    }]
  }

  /**
   * The summon-and-use chains for the expert tasks.
   *
   * Two steps per expert, and both are load-bearing: the summon events alone are
   * impressions, and a use event on its own scores nothing because the scorer
   * looks the conversation up. Only a real chat with `X-Expert-Id` produces an
   * id it will accept.
   */
  private async expertChains(
    credential: WorkBuddyCredential,
    expertType: 'agent' | 'team',
    task: WorkBuddyTask,
  ): Promise<readonly TaskEventChain[]> {
    // Only as many as are still missing, so a replay of the pass does not
    // re-chat experts the account already used.
    const needed = Math.max(0, task.target - task.current)
    if (needed === 0) return []
    const experts = await this.client.marketExpertList(credential, expertType)
    const out: TaskEventChain[] = []
    for (const expert of experts) {
      if (out.length >= needed) break
      if (this.stopped) break
      try {
        await this.client.reportDesktopEvents(credential, expertSummonEvents(expert))
        if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
        const chat = await this.client.openConversation(credential, expert.expertId)
        if (chat === undefined) continue
        out.push({
          transport: 'desktop',
          events: [
            ...expertChatEvents(expert, chat.conversationId, chat.requestId),
            expertActualUseEvent(expert, chat.conversationId, chat.requestId),
          ],
        })
      } catch (error: unknown) {
        this.logger.warn?.(`automation events expert ${expert.expertId}:`, error)
      }
      // Space the chains out: back-to-back uses collapse into one as far as the
      // scorer is concerned, which is what left this task one short.
      if (this.expertGapMs > 0 && !this.stopped) await sleep(this.expertGapMs)
    }
    return out
  }

  /**
   * The 腾讯轻量云 expert chain.
   *
   * Structurally the same as the expert task, with two differences the scorer
   * checks: `agent_task_created` has to name the expert, and the use event has
   * to report `mode: 'LOCAL'` with an empty type and zero cost — that is what
   * the lighthouse criterion looks for.
   */
  private async lighthouseChains(credential: WorkBuddyCredential): Promise<readonly TaskEventChain[]> {
    let expert = LIGHTHOUSE_EXPERT
    // Prefer the marketplace's own record when it lists this expert, so the
    // version and title come from the server rather than this constant.
    try {
      const listed = await this.client.marketExpertList(credential, 'agent')
      const found = listed.find(item => item.expertId === LIGHTHOUSE_EXPERT_ID)
      if (found !== undefined) expert = found
    } catch (error: unknown) {
      this.logger.warn?.('automation events lighthouse list:', error)
    }
    await this.client.reportDesktopEvents(credential, expertSummonEvents(expert))
    if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
    const chat = await this.client.openConversation(credential, expert.expertId)
    if (chat === undefined) throw new Error('Expert_lighthouse: no server conversation')
    const use = expertActualUseEvent(expert, chat.conversationId, chat.requestId, 'LOCAL')
    // Align with the real sample: the lighthouse expert reports no type and no
    // cost, and the scorer matches on that shape.
    use['type'] = ''
    use['cost'] = 0
    return [{
      transport: 'desktop',
      events: [...expertChatEvents(expert, chat.conversationId, chat.requestId), use],
    }]
  }


  /**
   * The task-centre pass for one account.
   *
   * Order matters: enrich first (enrol in everything open), then claim. Both
   * halves are idempotent — accepting an already-accepted task succeeds, and a
   * repeat claim answers `already_claimed` — so a pass that dies halfway is
   * safe to replay on the next tick.
   */
  private async runTasks(account: WorkBuddyAccount): Promise<{
    claimed: number
    credit: number
    energy: number
    claimableCount: number
    /** Reward titles collected on this pass, for the card to list. */
    titles: readonly string[]
    /** Every task the pass considered, with what happened to each. */
    items: readonly PoolWebAutomationItem[]
  }> {
    const credential = account.credential
    const tasks = await this.client.listTasks(credential)

    const open = tasks
      .filter(task => task.acceptStatus === 'not_accepted' && !task.locked)
      .map(task => task.taskCode)
    if (open.length > 0) await this.client.acceptTasks(credential, open)

    // Re-read once more: pass 1 may have lit up tasks in the meantime, and their
    // scoring has had time to land by the time this pass starts.
    const refreshed = await this.client.listTasks(credential)
    const claimable = refreshed.filter(task => task.claimable && !task.locked)

    let credit = 0
    let energy = 0
    let claimed = 0
    const titles: string[] = []
    // One entry per task the board showed, not just the ones that paid. The
    // distinction is the point: "0 claimed" is three different situations —
    // everything already collected, nothing claimable yet, or the endpoint
    // failing — and each needs a different action from the reader.
    const items: PoolWebAutomationItem[] = []
    for (const task of refreshed) {
      const blocked = task.locked === true || task.claimable !== true
      if (blocked) {
        items.push({
          title: task.title === '' ? task.taskCode : task.title,
          status: 'skipped',
          // Named so the card can say WHY without a second lookup: a locked task
          // is waiting on the client-side scoring pass, an unlocked-but-not-
          // claimable one has simply not been scored yet.
          note: task.locked === true ? 'locked' : (task.acceptStatus === 'not_accepted' ? 'not accepted' : 'not scored yet'),
        })
      }
    }
    for (const task of claimable) {
      if (this.stopped) break
      const reward = await this.client.claimTaskReward(credential, task.taskCode)
      credit += reward.credit
      energy += reward.energy
      const label = task.title === '' ? task.taskCode : task.title
      if (reward.credit > 0 || reward.energy > 0) {
        claimed++
        titles.push(task.title)
        items.push({
          title: label,
          status: 'claimed',
          ...reward.credit > 0 ? { credit: reward.credit } : {},
          ...reward.energy > 0 ? { energy: reward.energy } : {},
        })
        this.logger.info?.(`automation claim ${account.label}: ${task.title} +${reward.credit}c +${reward.energy}e`)
      } else {
        // already_claimed: the reward was collected on an earlier pass. A real
        // outcome, not a failure — the card would otherwise count it as one.
        items.push({ title: label, status: 'already' })
        this.logger.info?.(`automation claim ${account.label}: ${task.taskCode} already claimed`)
      }
      if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
    }

    return { claimed, credit, energy, claimableCount: claimable.length, titles, items }
  }

  /**
   * Streak redemption plus the lottery it unlocks.
   *
   * Tiers unlock on consecutive active days (7/14/28). Redeeming one pays
   * credits, energy, a makeup card and — the part nothing else grants — lottery
   * draws, so the draw runs straight after and only for the chances in hand.
   *
   * Everything here is idempotent: a tier already claimed is skipped by its
   * status, and a draw consumes one chance, so a replay cannot double-spend.
   */
  private async redeemStreak(account: WorkBuddyAccount): Promise<string | undefined> {
    const credential = account.credential
    const status = await this.client.growthStreakFull(credential)

    for (const tier of status.tiers) {
      if (this.stopped) return
      // `locked` is not a failure — it is the normal state until enough days
      // accumulate — and `claimed` needs no action.
      if (tier.status === 'locked' || tier.status === 'claimed') continue
      try {
        await this.client.redeemStreakTier(credential, tier.tier)
        this.logger.info?.(`automation streak ${account.label}: redeemed ${tier.tier} (+${tier.credit}c +${tier.energy}e +${tier.chances} draw(s))`)
        this.recordEarnings(account.id, dayKey(this.now()), { bonusCredit: tier.credit })
      } catch (error: unknown) {
        this.logger.warn?.(`automation streak ${account.label}: redeem ${tier.tier} failed:`, error)
      }
      if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
    }

    // Draw whatever the redemptions just granted, plus anything left over.
    const chances = await this.client.lotteryChances(credential)
    for (let draw = 0; draw < chances; draw += 1) {
      if (this.stopped) return
      try {
        const prize = await this.client.lotteryDraw(credential)
        this.logger.info?.(`automation lottery ${account.label}: draw ${draw + 1}/${chances} -> ${JSON.stringify(prize).slice(0, 120)}`)
      } catch (error: unknown) {
        this.logger.warn?.(`automation lottery ${account.label}: draw failed:`, error)
        // Stop drawing on the first failure: the loop is bounded by the count
        // read before it started, and a failing draw would otherwise spin.
        break
      }
      if (this.delayMs > 0 && !this.stopped) await sleep(this.delayMs)
    }

    // Nothing to redeem yet is the normal state, not a fault: hand back the
    // countdown so the card can say "5 more days" instead of showing a row that
    // looks like it silently failed.
    const pendingTier = status.tiers.find(tier => tier.status === 'locked')
    if (pendingTier !== undefined) {
      const remaining = Math.max(0, pendingTier.days - status.days)
      return remaining > 0
        ? `${pendingTier.tier} in ${remaining}d`
        : `${pendingTier.tier} ready`
    }
    return undefined
  }

  /**
   * One trip through the buddy travel loop for an account.
   *
   * A single pass advances the state machine by at most one step: a trip
   * that has arrived is collected, and an idle buddy is sent out. A buddy
   * already travelling is left alone — there is nothing to do until it lands.
   *
   * Measured against the live upstream: the departed trip reports
   * `dailyLimitReached` immediately, so the once-a-day limit needs no local
   * bookkeeping.
   */
  private async runTravel(account: WorkBuddyAccount): Promise<void> {
    const credential = account.credential
    const buddy = await this.client.buddyInfo(credential)
    if (buddy === undefined) {
      // No buddy yet: adoption is gated on that day's activity report, which
      // the report job has already sent by the time this runs. A rejection
      // here means the gate is not met yet, which is normal, not an error.
      try {
        await this.client.buddyAgree(credential)
        await this.client.buddyAdoptFirst(credential)
        this.logger.info?.(`automation travel ${account.label}: adopted first buddy`)
      } catch (error: unknown) {
        this.logger.info?.(`automation travel ${account.label}: adoption not available yet` + ' (' + String(error).slice(0, 80) + ')')
      }
      return
    }

    const travel = await this.client.buddyTravelStatus(credential)
    if (travel.state === 'arrived') {
      if (travel.recordId === 0) {
        // Arrived without a trip id cannot be claimed; nothing to do.
        this.logger.warn?.(`automation travel ${account.label}: arrived but no record id`)
        return
      }
      const reward = await this.client.buddyTravelClaim(credential, travel.recordId)
      this.recordEarnings(account.id, dayKey(this.now()), { travelCredit: reward })
      this.logger.info?.(`automation travel ${account.label}: claimed trip +${reward}c`)
      return
    }

    if (travel.state === 'idle' && !travel.dailyLimitReached) {
      await this.client.buddyTravelDepart(credential)
      this.logger.info?.(`automation travel ${account.label}: departed (arrives later, claimed next pass)`)
      return
    }

    this.logger.info?.(`automation travel ${account.label}: nothing to do (state=${travel.state})`)
  }

  /**
   * Collect the running service-outage compensation offer, if any.
   *
   * Read-then-claim, rather than claim-blind: a claim costs one mutation the
   * upstream may reject, and the status call is a free read that also tells us
   * the size on offer so the ledger records the real number instead of
   * assuming the usual 500.
   *
   * Returns the credits collected — 0 when there was nothing to collect, which
   * is the normal case for most of the year.
   */
  private async runCompensation(account: WorkBuddyAccount): Promise<{ credit: number }> {
    const credential = account.credential
    const status = await this.client.fetchCompensationStatus(credential)
    if (!status.active || status.claimed || status.creditNum <= 0) {
      return { credit: 0 }
    }
    const claim = await this.client.claimCompensation(credential)
    if (!claim.claimed) return { credit: 0 }
    // Upstream repeats the amount on the claim response; fall back to the
    // status read when it does not, since the status number is authoritative.
    const credit = claim.creditNum > 0 ? claim.creditNum : status.creditNum
    this.recordEarnings(account.id, dayKey(this.now()), { compensationCredit: credit })
    return { credit }
  }
}

export type { AutomationLedger, AutomationOptions, SchedulerLogger, AutomationJobState, AutomationAccountEarnings, AutomationAccountGain, AutomationRunSummary, AutomationStatus, AutomationJobKind } from './scheduler-types.ts'

export { AUTOMATION_ACCOUNT_DELAY_MS, EXPERT_SUMMON_GAP_MS, EVENT_SCORE_WAIT_MS, AUTOMATION_TICK_MS, AUTOMATION_JOB_KINDS, isAutomationJobKind, AUTOMATION_TIME_ZONE, dayKey, slotKey, isFireHour } from './scheduler-core.ts'
