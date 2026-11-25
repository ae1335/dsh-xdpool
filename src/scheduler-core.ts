/**
 * Pure helpers for the points automation scheduler: job-kind tables, time
 * zoning, and account eligibility.
 *
 * No file IO and no module-level mutable state.
 */

import type { WorkBuddyAccount } from './accounts'
import { regionOf } from './upstream'
import type { WorkBuddyRegion } from './upstream'
import { LIGHTHOUSE_EXPERT_ID } from './task-events.ts'
import type { MarketExpert } from './task-events.ts'
import type { AutomationAccountEarnings, AutomationAccountGain, AutomationJobKind, AutomationJobState, JobKind } from './scheduler-types.ts'

export const AUTOMATION_ACCOUNT_DELAY_MS = 800

export const EXPERT_SUMMON_GAP_MS = 6_000

export const EVENT_SCORE_WAIT_MS = 9_000

const BUDDY_APP_ID = 'cb_y5Dy46tPQGGWtueMxXbe'

const BUDDY_APP_NAME = '企鹅教师助手'

export const LIGHTHOUSE_EXPERT: MarketExpert = {
  expertId: LIGHTHOUSE_EXPERT_ID,
  expertType: 'agent',
  displayName: '腾讯轻量云专家',
  profession: '腾讯轻量云专家',
  version: '1.0.2',
  categories: [],
}

export const EVENT_CHAIN_BUILDERS: Readonly<Record<string, true>> = {
  Buddy_App: true,
  Buddy_App_QQ: true,
  create_canvas: true,
  automation_1: true,
  RichMeow_Chat: true,
  playbook_prompt: true,
  template_5: true,
  Hp_Appearance: true,
  Library_read: true,
  skill_1: true,
  expert_5: true,
  Expert_team_use_3: true,
  Expert_lighthouse: true,
  // The "体验XX专家" family (#98): +50 credits each, accept and claim already
  // worked, but progress stayed at 0/1 forever because the codes were not in
  // this map — `sendEventChains` skipped them, so no chain was ever sent and
  // there was nothing to score. The expert ids come from each task's own
  // `jump_url` (see `expertIdFromJumpUrl`): these experts are not listed in the
  // marketplace, so `expertChains` cannot find them by browsing.
  expert_use_maidehao: true,
  expert_use_douyinyin: true,
  expert_use_shangjia_xuanchuan: true,
  expert_use_bowangwang: true,
  // Same family, same shape, twice the reward. Kept out of the marketplace path
  // for the same reason; its deeplink carries the id like the others.
  WorkBuddy_Valorant: true,
}

export const AUTOMATION_TICK_MS = 60_000

export const AUTOMATION_JOB_KINDS: readonly AutomationJobKind[] = ['checkin', 'report', 'tasks', 'streak', 'travel', 'compensation']

export function isAutomationJobKind(value: unknown): value is AutomationJobKind {
  return typeof value === 'string' && (AUTOMATION_JOB_KINDS as readonly string[]).includes(value)
}

export const JOB_KINDS: readonly JobKind[] = AUTOMATION_JOB_KINDS

export function hoursOrDefault(configured: readonly number[] | undefined, fallback: readonly number[]): readonly number[] {
  return configured !== undefined && configured.length > 0 ? configured : fallback
}

export const EMPTY_JOB_STATE: AutomationJobState = { ok: 0, failed: 0, credit: 0, energy: 0, claimed: 0 }

export function diffEarnings(
  before: Record<string, AutomationAccountEarnings>,
  after: Record<string, AutomationAccountEarnings>,
): { credit: number; energy: number; claimed: number; accounts: Record<string, AutomationAccountGain> } {
  const accounts: Record<string, AutomationAccountGain> = {}
  let credit = 0
  let energy = 0
  let claimed = 0
  for (const [id, entry] of Object.entries(after)) {
    const was = before[id]
    const gain: AutomationAccountGain = {
      credit: entry.credit - (was?.credit ?? 0),
      energy: entry.energy - (was?.energy ?? 0),
      claimed: entry.claimed - (was?.claimed ?? 0),
      checkinCredit: entry.checkinCredit - (was?.checkinCredit ?? 0),
      bonusCredit: entry.bonusCredit - (was?.bonusCredit ?? 0),
      travelCredit: entry.travelCredit - (was?.travelCredit ?? 0),
      compensationCredit: entry.compensationCredit - (was?.compensationCredit ?? 0),
    }
    const empty = gain.credit === 0 && gain.energy === 0 && gain.claimed === 0
      && gain.checkinCredit === 0 && gain.bonusCredit === 0 && gain.travelCredit === 0
      && gain.compensationCredit === 0
    // An account that gained nothing is left out entirely, so the card can
    // list just the accounts that actually earned this run.
    if (empty) continue
    accounts[id] = gain
    credit += gain.credit
    energy += gain.energy
    claimed += gain.claimed
  }
  return { credit, energy, claimed, accounts }
}

export const AUTOMATION_TIME_ZONE = 'Asia/Shanghai'

export function zonedParts(date: Date, timeZone: string = AUTOMATION_TIME_ZONE): {
  year: string
  month: string
  day: string
  hour: string
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type: string): string => parts.find(part => part.type === type)?.value ?? '00'
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour') }
}

export function dayKey(date: Date, timeZone: string = AUTOMATION_TIME_ZONE): string {
  const { year, month, day } = zonedParts(date, timeZone)
  return `${year}-${month}-${day}`
}

export function slotKey(date: Date, timeZone: string = AUTOMATION_TIME_ZONE): string {
  const { hour } = zonedParts(date, timeZone)
  return `${dayKey(date, timeZone)}T${hour}`
}

export function isFireHour(now: Date, hours: readonly number[]): boolean {
  const { hour } = zonedParts(now)
  return hours.includes(Number(hour))
}

const JOB_REGION_SCOPE: Readonly<Record<string, readonly WorkBuddyRegion[]>> = {
  // Growth jobs are CN-only: the international gateway has no task centre, no
  // activity report and no streak ladder, so calling those endpoints there would
  // only produce 404s and noise.
  report: ['cn'],
  tasks: ['cn'],
  streak: ['cn'],
  travel: ['cn'],
  compensation: ['cn'],
  // Check-in is the one job that pays credits on both gateways, and it is the
  // safest to try: idempotent, one call, and "already checked in" is already
  // classified as success rather than failure. So a global account is allowed
  // here — if the endpoint turns out not to exist there, the run records one
  // skipped item and the rest of the pool is unaffected.
  checkin: ['cn', 'global'],
}

function jobAllowsRegion(job: string, region: WorkBuddyRegion): boolean {
  return (JOB_REGION_SCOPE[job] ?? ['cn']).includes(region)
}

export function eligible(account: WorkBuddyAccount, now: number, job?: string): boolean {
  if (account.cooldownUntilMs > now) return false
  // Per-job region scope, not a blanket exclusion: see JOB_REGION_SCOPE.
  if (job !== undefined && !jobAllowsRegion(job, regionOf(account.credential.domain))) return false
  return true
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })
