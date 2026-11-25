/**
 * Types for the points automation scheduler: job states, earnings, and options.
 *
 * Pure declarations — no runtime logic and no file IO.
 */

import type { PoolWebAutomationItem } from './status-paths.ts'

export interface AutomationLedger {
  date: string
  accounts: Record<string, AutomationAccountEarnings>
}

export interface AutomationOptions {
  /** Master switch; false stops every job. */
  enabled?: boolean
  /** Hour list for the daily check-in job. */
  checkinHours?: readonly number[]
  /** Hour list for the task-centre job (accept + claim). */
  taskHours?: readonly number[]
  /** Hour list for the activity-report job. */
  reportHours?: readonly number[]
  /** Hour list for the streak-redemption job. */
  streakHours?: readonly number[]
  /** Hour list for the buddy travel job. */
  travelHours?: readonly number[]
  /** Hour list for the outage-compensation claim. */
  compensationHours?: readonly number[]
  /** Per-account serial delay, in milliseconds. */
  accountDelayMs?: number
  /** Override the gap between expert chains, in milliseconds (tests use 0). */
  expertGapMs?: number
  /** Override the event-scoring wait, in milliseconds (tests use 0). */
  eventScoreWaitMs?: number
  /** Override the clock, for tests. */
  now?: () => Date
  /** Logger; defaults to a no-op so tests stay quiet. */
  logger?: SchedulerLogger
  /**
   * Persist the daily earnings ledger, and restore it on construction.
   *
   * The ledger cannot live only in memory: a host restart mid-day would wipe
   * what the automation already earned, and the card would show nothing for
   * rewards that really were collected.
   */
  loadEarnings?: () => AutomationLedger | undefined
  saveEarnings?: (ledger: AutomationLedger) => void
}

export interface SchedulerLogger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
}

export interface AutomationJobState {
  /** `YYYY-MM-DD` of the last completed run, or undefined if it never ran. */
  lastRunDate?: string
  /**
   * The scheduled SLOT of the last run, as `YYYY-MM-DDTHH`.
   *
   * The tick de-duplicates on this rather than on the date: keying on the date
   * alone caps every job at one run a day, which is wrong for a job with two
   * time points — blocking the cat loop's second pass would leave the cat out
   * until tomorrow. Per slot a job runs once in each configured hour, while a
   * repeat tick inside the same hour is still refused.
   */
  lastRunSlot?: string
  /**
   * Every configured slot consumed TODAY, as `YYYY-MM-DDTHH`.
   *
   * This is what actually gates a re-run, and it is a SET rather than a single
   * slot because one field could not express the contract: a job configured for
   * `[9, 21]` runs twice, and a single "last slot" value can only remember one
   * of them — the second run erased the first, so the 9 o'clock candidate looked
   * unconsumed again and the job re-fired every hour after 21:00.
   *
   * The values are the CONFIGURED hours that were spent, never the clock time
   * the run happened to finish at. Storing the finish time was the original
   * defect: the reader compared it against a configured candidate, so the two
   * almost never matched and the gate stayed open all day.
   *
   * In-memory like the rest of `states`: this is a per-process record, and the
   * catch-up design deliberately re-runs an hour that passed while DSH was
   * closed. See `automationEarnings` for the ledger that DOES persist.
   */
  firedSlots?: readonly string[]
  /**
   * The clock slot the last run STARTED in (`YYYY-MM-DDTHH`).
   *
   * Separate from {@link firedSlots} on purpose: this is a throttle ("do not
   * start twice inside the same hour"), while `firedSlots` is the schedule
   * ledger. Conflating the two is what let a catch-up run at 13:00 erase the
   * record of the 9 o'clock slot.
   */
  lastFiredHour?: string
  /** Epoch ms of the last completed run. */
  lastRunAtMs?: number
  /** Accounts that completed without throwing. */
  ok: number
  /** Accounts that threw (each one skipped, the run continued). */
  failed: number
  /** Credits claimed by the task job on the last run. */
  credit: number
  /** Energy claimed by the task job on the last run. */
  energy: number
  /** Tasks claimed by the task job on the last run. */
  claimed: number
  /** Human-readable summary of the last run. */
  /**
   * What this run actually did, in the words of the task board.
   *
   * `message` is a count ("3 accounts, 5 tasks claimed"); this is the list a
   * person can check off — the reward titles the pass collected. A row showing
   * only a bare number cannot answer "did it do the thing I care about", which
   * is the question the panel exists to answer.
   */
  detail?: readonly string[]
  /**
   * The same work with a status per item.
   *
   * `detail` is a flat list of sentences, so the card can print it but cannot
   * group it. This carries `claimed` / `already` / `skipped` / `failed` per
   * thing the job looked at, which is what separates "everything was already
   * done" from "nothing was claimable" from "the endpoint is down" — three
   * outcomes that all print as "0 claimed".
   */
  items?: readonly PoolWebAutomationItem[]
  /**
   * A pending milestone worth naming, when there is one.
   *
   * Streak tiers are why this exists: every tier reads `locked` until enough
   * consecutive days accumulate, and "locked" on its own reads as "broken"
   * rather than "come back in four days".
   */
  progress?: string
  message?: string
}

export interface AutomationAccountEarnings {
  /** Credits the automation claimed from the task centre today. */
  credit: number
  /** Energy claimed from the task centre today. */
  energy: number
  /** Tasks claimed today. */
  claimed: number
  /**
   * Credits the automation collected from check-in today.
   *
   * Kept separate from `credit` because they are different achievements and the
   * card shows them on their own lines: "the automation claimed 3 tasks" and
   * "the automation checked in" are not the same claim to the user.
   */
  checkinCredit: number
  /** Credits from streak redemption + lottery today. */
  bonusCredit: number
  /** Credits from the buddy adoption / travel loop today. */
  travelCredit: number
  /**
   * Credits collected from the outage-compensation offer today.
   *
   * Its own column for the same reason as `checkinCredit`: a 500-credit
   * outage refund is a different thing from a 100-credit daily check-in, and
   * the card lists what earned what.
   */
  compensationCredit: number
  /** Local date the counters belong to. */
  date: string
}

export interface AutomationAccountGain {
  credit: number
  energy: number
  claimed: number
  checkinCredit: number
  bonusCredit: number
  travelCredit: number
  compensationCredit: number
}

export interface AutomationRunSummary {
  /** How many jobs actually ran (a job with no hour is skipped). */
  jobsRun: number
  /** Accounts that finished without error, summed across jobs. */
  okCount: number
  /** Accounts that failed, summed across jobs. */
  failed: number
  credit: number
  energy: number
  claimed: number
  /**
   * What each account gained during THIS run, keyed by account id. Only
   * accounts that gained something appear.
   */
  accounts: Readonly<Record<string, AutomationAccountGain>>
}

export interface AutomationStatus {
  enabled: boolean
  /** Whether the loop is running. */
  running: boolean
  checkinHours: readonly number[]
  taskHours: readonly number[]
  reportHours: readonly number[]
  streakHours: readonly number[]
  travelHours: readonly number[]
  compensationHours: readonly number[]
  jobs: {
    checkin: AutomationJobState
    report: AutomationJobState
    tasks: AutomationJobState
    streak: AutomationJobState
    travel: AutomationJobState
    compensation: AutomationJobState
  }
  /** Claimable tasks seen on the most recent task pass, across accounts. */
  claimableSeen: number
  /**
   * Per-account totals for today, keyed by account id. Only accounts that
   * actually earned something appear, so the card can render "no earnings"
   * as an absence rather than a zero it has to explain.
   */
  earningsToday: Readonly<Record<string, AutomationAccountEarnings>>
  /**
   * Whether a manual run is in flight right now.
   *
   * A run takes tens of seconds (one upstream call per account per job, plus
   * the scoring wait), which is far too long for the card to hold a request
   * open. The button starts a run and the panel polls this flag instead.
   */
  runInProgress: boolean
}

export type AutomationJobKind = 'checkin' | 'tasks' | 'report' | 'streak' | 'travel' | 'compensation'

export type JobKind = AutomationJobKind
