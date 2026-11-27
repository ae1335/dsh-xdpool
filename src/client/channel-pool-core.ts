/**
 * Account-pool page, scan-channel section.
 *
 * The pool page's two region cards only ever showed the WorkBuddy lanes — the
 * thirteen scan-login channels lived in a parallel world on the login page.
 * This section closes that gap: every scan channel that holds at least one
 * account gets a card here, laid out like the reference build's channel card —
 * identity on top, a one-line note about what the vendor actually gives away,
 * a numbers row (accounts, models, credits), then two collapsible lists.
 *
 * Three decisions worth stating, because each of them is a way this could have
 * looked wrong:
 *
 * 1. The enable state IS the pack's model blacklist — `model.setDisabled` with
 *    `disabled: false` unhides a model, `disabled: true` hides it again — and
 *    each row saves on its own. A channel can publish thirty models; a Save
 *    button at the bottom of a list the user has to scroll back down to turns
 *    "pick the two you want" into bookkeeping.
 * 2. Credits come from the pack and are shown in the vendor's own unit, never
 *    normalised: Cline pays dollars, ZCode pays tokens, Gemini publishes
 *    percentage windows. A single "credits" column would be wrong for a third
 *    of the roster.
 * 3. Model descriptions are the ONE thing the pack cannot answer. Its
 *    `model.list` keeps only `id`, `name` and two flags, so descriptions come
 *    from the host's catalogue — the same one the model picker reads.
 *
 * @module dsh-xdpool/client/ChannelPoolSection
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { BrandTile } from './brand-tile.tsx'
import { channelIcon, channelInitials } from './channel-icons.ts'
import { ModelFactsRow } from './model-facts-row.tsx'
import { modelFactsFor, formatModelCapacity, type ModelFacts, baseName, multiplierOf, multiplierTone } from './model-facts.ts'
import { recommendUse } from './recommend-use.ts'
import { PASTE_ROUTES, WINDOW_LOGIN_ROUTES, canStartLoginInPlace, loginKindOf } from './login-routes.ts'
import {
  accountsFrom,
  autoCheckinFrom,
  balancesFrom,
  balancesTotal,
  balanceAmount,
  balancePackages,
  callPack,
  claimResultFrom,
  createdFrom,
  creditStatusesFrom,
  fetchChannelModels,
  fetchChannels,
  modelsFrom,
  pollFrom,
  providerStatusesFrom,
  setChannelModelContextBudget,
  sortChannelModels,
  type ChannelBalance,
  type ChannelCreditStatus,
  type ChannelModel,
  type ChannelProviderStatus,
} from './channel-rpc.ts'
import type { ChannelAccount, ChannelRpcEnvelope } from '../channels.ts'
import {
  POOL_ASTUDIO_WALLET_PATH,
  POOL_ACCIO_QUOTA_PATH,
  POOL_MONKEYCODE_CN_WALLET_PATH,
  POOL_MONKEYCODE_INTL_WALLET_PATH,
  POOL_BAIZHI_WALLET_PATH,
  POOL_AUTOCLAW_INTL_WALLET_PATH,
  POOL_AUTOCLAW_CN_WALLET_PATH,
  POOL_ASTUDIO_SESSION_PATH,
  POOL_ACCIO_SESSION_PATH,
  POOL_MONKEYCODE_CN_SESSION_PATH,
  POOL_BAIZHI_SESSION_PATH,
  POOL_AUTOCLAW_CN_SESSION_PATH,
  POOL_AUTOCLAW_INTL_SESSION_PATH,
  POOL_ASTUDIO_CHECKIN_PATH,
  POOL_BAIZHI_CHECKIN_PATH,
  POOL_MAGICREW_CN_CHECKIN_PATH,
  POOL_MAGICREW_INTL_CHECKIN_PATH,
  POOL_MAGICREW_CN_WALLET_PATH,
  POOL_MAGICREW_INTL_WALLET_PATH,
  POOL_ACCOUNT_PREFER_PATH,
  POOL_CHANNEL_USAGE_PATH,
} from '../status-paths.ts'

import {
  POOL_CATALOG_REFRESH_PATH,
  POOL_DOUBAO_CLAIM_PATH,
  POOL_DOUBAO_MODELS_PATH,
  POOL_DOUBAO_QUOTA_PATH,
  POOL_DOUBAO_SESSION_PATH,
  POOL_MARVIS_SESSION_PATH,
  POOL_MARVIS_WALLET_PATH,
} from '../status-paths.ts'
// The DATA module, not `doubao-llm.ts`: the latter reaches `node:fs`/`node:child_process`
// through the auth module, and a client bundle containing those does not load at all.
import { doubaoListing } from '../doubao-models.ts'
import { REGISTERED_CHANNELS } from '../channel-roster.ts'
import { DoubaoAutomationPane } from './DoubaoAutomationPane.tsx'
import type {
  PoolDistribution,
  PoolWebChannel,
  PoolWebChannelModel,
  PoolWebChannelPackCheckin,
} from '../status-paths.ts'
import type { XdPoolSettingsKey } from './locales.ts'

export type Translate = (key: XdPoolSettingsKey, params?: Record<string, unknown>) => string

/**
 * 积分自动化那一栏的渠道包摘要。
 *
 * 这一行读的是渠道包自己的台账（`auto-checkin.json`），不是插件 earnings：
 * 后者只记 WorkBuddy 桌面账号，用户看到「今日积分」只有那一份时会以为签到
 * 没跑。两笔账并列显示，日期原样带上，免得把昨天的台账说成今天的。
 */
export function packCheckinLineOf(t: Translate | undefined, summary: PoolWebChannelPackCheckin): string {
  const body = summary.credit > 0
    ? (t?.('channelpool.packCheckinGained', {
        credit: String(summary.credit), count: String(summary.channelCount),
      }) ?? `+${String(summary.credit)} 积分 · ${String(summary.channelCount)} 渠道`)
    : summary.channelCount > 0
      ? (t?.('channelpool.packCheckinNoCredit', { count: String(summary.channelCount) })
        ?? `${String(summary.channelCount)} 渠道`)
      : (t?.('channelpool.packCheckinEmpty') ?? '暂无签到记录')
  return t?.('channelpool.packCheckin', { date: summary.date ?? '--', body })
    ?? `渠道包签到（${summary.date ?? '--'}）：${body}`
}

/**
 * The last good answer, kept OUTSIDE the component.
 *
 * Switching tabs unmounts this section — the page body is a three-way ternary —
 * so component state cannot survive a tab change and every return re-ran the
 * whole chain, showing blank cards for the 2-4 seconds it took (#102). A
 * module-level store is the only place a value can live across mounts, which is
 * what lets the first frame after a remount render the previous cards and
 * revalidate behind them.
 *
 * Written BEFORE the `mountedRef` checks, deliberately: a request that lands
 * after this component unmounted still carries a correct answer, and it belongs
 * in the store whether or not anybody is looking at it. Ordering it the other
 * way is what made the previous code throw away results it had already paid
 * for — "the answer arrived while the reader was away".
 */
export interface ChannelPoolSnapshot {
  entries: readonly ChannelEntry[]
  /** The failure the last attempt reported, or undefined when it succeeded. */
  error?: string | undefined
}
export let poolSnapshot: ChannelPoolSnapshot | undefined

/**
 * The last answered counts, kept on disk so a RESTART does not start from zero.
 *
 * The in-memory snapshot above survives a tab switch; it does not survive the process, so
 * every launch of DSH re-walked thirteen account pools before the cards could show a number —
 * which is the "why is it loading again" a reader feels on each start.
 *
 * Only the counts and the balances are stored, never credentials: the card draws a number
 * whose worst case is being stale, and a stale number is what the reader already expects on
 * the first frame. The first successful read replaces it.
 *
 * Versioned, because the shape will change and a stale blob must not be fed to new code.
 */
export const COUNTS_STORE_KEY = 'dsh-xdpool.channel-counts.v1'

/** Where Doubao's own model selection lives. Versioned for the same reason as the counts. */
export const DOUBAO_SKIP_KEY = 'dsh-xdpool.doubao-skipped-models.v1'

/**
 * Whether the user pressed 「全关」 on the Doubao card.
 *
 * Kept beside the skip list because the skip list cannot express it: pressing
 * 全关 before the roster has loaded writes `[]`, which reads back as "nothing
 * switched off" and left the picker showing every model. This flag says exactly
 * what was pressed, and survives a card reopen.
 */
export const DOUBAO_HIDE_ALL_KEY = 'dsh-xdpool.doubao-hide-all.v1'

/** Read the 「全关」 flag; false when it was never set. */
export function readDoubaoHideAll(): boolean {
  try {
    return globalThis.localStorage?.getItem(DOUBAO_HIDE_ALL_KEY) === 'true'
  } catch {
    return false
  }
}

/** Record the 「全关」 flag. */
export function saveDoubaoHideAll(hidden: boolean): void {
  try {
    if (hidden) globalThis.localStorage?.setItem(DOUBAO_HIDE_ALL_KEY, 'true')
    else globalThis.localStorage?.removeItem(DOUBAO_HIDE_ALL_KEY)
  } catch {
    // A blocked storage leaves the flag unset; the id list still carries the rest.
  }
}

/**
 * The Doubao models the user switched off.
 *
 * `undefined` means "never configured", which is different from "none switched off": the first
 * shows everything, the second shows nothing. Collapsing them would make a fresh account look
 * as though the user had already made choices.
 */
export function readDoubaoSkipped(): ReadonlySet<string> | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(DOUBAO_SKIP_KEY)
    if (raw === null || raw === undefined) return undefined
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return undefined
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    return undefined
  }
}

/** Record one model as switched off, or back on. */
export async function saveDoubaoSkipped(modelId: string, disabled: boolean): Promise<void> {
  const current = readDoubaoSkipped() ?? new Set<string>()
  const next = new Set(current)
  if (disabled) next.add(modelId)
  else next.delete(modelId)
  globalThis.localStorage?.setItem(DOUBAO_SKIP_KEY, JSON.stringify([...next]))
}

/**
 * The disable-list last pushed to the host (this browser session), for dedupe.
 *
 * The card re-reads itself after every action, and every read mirrors — without
 * the fingerprint a single toggle would POST three times.
 */
export let lastMirroredDoubaoDisabled: string | undefined

/**
 * Push this browser's Doubao ticks into the host — issue #196.
 *
 * The picker is built in the host process, which cannot read this card's
 * localStorage; without the mirror it published the whole live roster however
 * few models the card showed as enabled ("4/16" on the card, 16 in the picker).
 *
 * An UNSAVED list is not pushed: `readDoubaoSkipped() === undefined` is "the
 * user never touched a tick", and leaving the host at its default (`[]`, meaning
 * "nothing switched off, show everything") is the honest reading. Pushing `[]`
 * there would be the same value but a different claim — and it also means a
 * cleared browser can never wipe a list the host is still honouring.
 *
 * A refused write is not recorded as mirrored, so the next card read retries it.
 */
export async function mirrorDoubaoDisabled(): Promise<void> {
  const skipped = readDoubaoSkipped()
  const hideAll = readDoubaoHideAll()
  if (skipped === undefined && !hideAll) return
  const ids = [...(skipped ?? [])]
  // The flag is part of the fingerprint: 全关 then 全开 sends the same (empty)
  // list twice, and the second one has to reach the host or the picker stays
  // empty.
  const fingerprint = JSON.stringify([[...ids].sort(), hideAll])
  if (fingerprint === lastMirroredDoubaoDisabled) return
  try {
    const response = await fetch(POOL_DOUBAO_MODELS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      // A Set serialises to `{}`, so the array is spelled out here.
      body: JSON.stringify({ disabledModelIds: ids, hideAll }),
    })
    // fetch does not reject on 4xx/5xx: a refused write stays unrecorded and is
    // retried on the next card read or toggle, not silently marked mirrored.
    if (!response.ok) return
    lastMirroredDoubaoDisabled = fingerprint
  } catch {
    // Host unreachable or the route is not mounted: the local tick still holds.
  }
}

/** What is stored per channel: counts, not accounts. */
export interface StoredCounts {
  /** Epoch ms of the read that produced these numbers. */
  at: number
  channels: Record<string, { accounts: number; models: number; balance?: number; unit?: string }>
}

/** Read the stored counts, or undefined when there is nothing usable. */
export function readStoredCounts(): StoredCounts | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(COUNTS_STORE_KEY)
    if (raw === null || raw === undefined) return undefined
    const parsed = JSON.parse(raw) as Partial<StoredCounts>
    if (typeof parsed.at !== 'number' || typeof parsed.channels !== 'object' || parsed.channels === null) {
      return undefined
    }
    return parsed as StoredCounts
  } catch {
    return undefined
  }
}

/** Store the counts as they are now. Failure is ignored: a full quota must not break a card. */
export function writeStoredCounts(entries: readonly ChannelEntry[]): void {
  try {
    const channels: StoredCounts['channels'] = {}
    for (const entry of entries) {
      const enabled = entry.accounts.filter(account => account.enabled !== false).length
      const total = balancesTotal(entry.balances)
      channels[entry.channel.id] = {
        accounts: entry.accounts.length === 0 ? enabled : entry.accounts.length,
        models: entry.models.length,
        ...(total === undefined ? {} : { balance: total }),
      }
    }
    globalThis.localStorage?.setItem(COUNTS_STORE_KEY, JSON.stringify({ at: Date.now(), channels }))
  } catch {
    // Private mode, a full quota, or no DOM: the counts simply are not remembered.
  }
}
/**
 * `provider.status` answered recently, kept across unmounts.
 *
 * One request counts EVERY named provider's accounts, so its cost is the sum of
 * thirteen pool walks. Re-running that on the next visit, for numbers that cannot
 * have moved, is what made this section feel slow on every open while the login page
 * (static metadata, no counting) appeared instantly.
 *
 * Module-level rather than component state on purpose: switching settings tabs
 * unmounts the section, and the whole point is that coming back is cheap.
 */
export let providerStatusCache: { at: number; key: string; answer: ChannelRpcEnvelope } | undefined
export const PROVIDER_STATUS_TTL_MS = 30_000

/**
 * 丢掉账号数缓存。
 *
 * 30 秒的缓存让「回到账号池」很便宜，但登录完一个账号后它就是错的：
 * 登录通道（不走缓存）显示 3，账号池（走缓存）还显示 1，要等半分钟才对上。
 * 任何会改变账号数量的动作之后都调一次。
 */
export function invalidateProviderStatusCache(): void {
  providerStatusCache = undefined
}

/**
 * Channels whose rewards are collected through `onboarding.claim`, not a daily
 * check-in.
 *
 * Kept as a literal rather than derived from `channel.credits`, because the two
 * rewards are different in kind: `credits.claim` is repeatable tomorrow and pays
 * daily points, while these pay once per account and are then gone. The pack exposes
 * them on separate endpoints for exactly that reason, and a channel can have either,
 * both, or neither:
 *
 *   - `raccoon` — the daily points arrive on their own (the server credits them),
 *     so its `credits` field is EMPTY on purpose. Only the desktop-login bonus is
 *     claimable, and it lives here.
 *   - `loomy` — onboarding tasks, topped up to a maximum rather than granted per
 *     task.
 *
 * Both are implemented in the pack; before this the card simply never called the
 * endpoint, so a signed-in Raccoon account had no way to collect the bonus its own
 * note told the reader to look for.
 */
export const ONBOARDING_CHANNELS: ReadonlySet<string> = new Set(['raccoon', 'loomy'])

/**
 * Drop the snapshot after anything that changes the data behind it.
 *
 * Logins, deletions, toggles and manual balance refreshes all make the snapshot
 * stale in a way a silent revalidation cannot hide: showing yesterday's account
 * list for a card the user just added an account to is worse than showing the
 * "reading" line for a moment.
 *
 * The provider-status cache is dropped with it, or a rescan that just found an
 * account would be invisible behind a 30-second-old count.
 */
export function invalidatePoolSnapshot(): void {
  poolSnapshot = undefined
  providerStatusCache = undefined
}

/** Which of the two lists a card has open. At most one, like the reference. */
export type Fold = 'accounts' | 'models'

/** How many automatic retries a cold-start mount gets before giving up. */
export const LOAD_RETRIES = 5
/** Gap between those retries, in milliseconds. */
export const RETRY_INTERVAL_MS = 2_000

/**
 * Channels whose accounts are shown by the two region cards instead.
 *
 * `buddy` (CodeBuddy CN) and `workbuddy` (WorkBuddy international) are the
 * two lanes the pool itself serves. A scan login for either writes into the
 * same place the desktop app's credentials land, so listing them again as
 * channel cards would show every account twice — once with credits and
 * cooldowns, once bare. They are filtered out here rather than special-cased
 * in the renderer, so an account added on the login page shows up in exactly
 * one place no matter which path created it.
 */
/**
 * The catalogue length at which a model search box earns its place.
 *
 * Below this the reader scrolls faster than they type, and the field would be
 * one more control to look past on every card.
 */
export const MODEL_SEARCH_THRESHOLD = 8

/** 设计稿 policies 分段按钮的顺序：优先 · 轮换 · 均衡 · 粘住 · 按到期。 */
export const MODE_ORDER: readonly PoolDistribution[] = ['priority', 'round-robin', 'balanced', 'sticky', 'expiry']
/** 五种策略的中文名。 */
export const MODE_LABEL: Record<PoolDistribution, (tr?: Translate) => string> = {
  priority: tr => tr?.('channelpool.modePrefer') ?? '优先',
  'round-robin': tr => tr?.('channelpool.modeRoundRobin') ?? '轮换',
  balanced: tr => tr?.('channelpool.modeBalanced') ?? '均衡',
  sticky: tr => tr?.('channelpool.modeSticky') ?? '粘住',
  expiry: tr => tr?.('channelpool.modeExpiry') ?? '按到期',
}
export function modeHint(tr: Translate | undefined, mode: PoolDistribution): string {
  if (mode === 'round-robin') return tr?.('channelpool.modeRoundRobinHint') ?? '轮换：每次请求依次用下一个账号。'
  if (mode === 'balanced') return tr?.('channelpool.modeBalancedHint') ?? '均衡：在还有额度的账号里随机挑。'
  if (mode === 'sticky') return tr?.('channelpool.modeStickyHint') ?? '粘住：一直用同一个，直到它不行了。'
  if (mode === 'expiry') return tr?.('channelpool.modeExpiryHint') ?? '按到期：先用即将到期的账号。'
  return tr?.('channelpool.modePreferHint') ?? '优先：总用排在前面的账号，它限流了才换下一个。'
}
/** channels/usage 路由的回答。 */
export interface ChannelUsageState {
  pool?: string
  channels?: Record<string, string>
}

/**
 * The window a channel model is capped to when the user does not ask for more.
 *
 * Same number as the region cards' `DEFAULT_CONTEXT_BUDGET`, and for the same
 * reason: a published window is a ceiling the vendor supports, not a size every
 * request can carry, so the picker offers a conservative default next to the
 * native figure instead of presenting the maximum as the everyday choice.
 */
export const CONTEXT_BUDGET_DEFAULT = 200_000

/**
 * 由区域卡管理的渠道。
 *
 * 曾经这个集合把 buddy / workbuddy 排除在外，因为它们的两张汇总卡
 * （WorkBuddy 国内版 / 国际版）由 PoolCard 单独渲染。
 *
 * 那两张卡已经不渲染了 —— 它们和渠道详情各占一格，把三列挤成一坨。
 * 所以这两家必须回到中栏，否则读者根本看不到自己能登什么。
 */
export const REGION_OWNED_CHANNELS: ReadonlySet<string> = new Set()

export interface ChannelEntry {
  channel: PoolWebChannel
  accounts: readonly ChannelAccount[]
  models: readonly ChannelModel[]
  /** Host-catalogue facts, keyed by model id. Empty when the host refused. */
  facts: ReadonlyMap<string, PoolWebChannelModel>
  /** One balance row per account, in the pack's order. */
  balances: readonly ChannelBalance[]
  /** Today's check-in state, when the pack reports one. */
  statuses: readonly ChannelCreditStatus[]
  /** True while the first balance read is in flight. */
  balancePending: boolean
  /** Why the balance read failed, in the pack's words. */
  balanceError?: string | undefined
  /**
   * Why `model.list` could not answer, when it refused. Surfaced instead of
   * being folded into "no models published": the pack's `model.list` needs the
   * host's `llm` service, and when that service is missing it answers an error
   * for a channel that in fact publishes a full catalogue.
   */
  modelError?: string | undefined
  /** The counts the pack reports, for the numbers row. */
  status?: ChannelProviderStatus | undefined
}

/**
 * Collapse repeated sign-ins of the same person into one row.
 *
 * The pack's `account.create` appends unconditionally — it has no idea an
 * account with the same nickname already exists — so clicking "add account"
 * twice leaves two entries. The pack prunes them on disk, but the prune only
 * runs at mount and on the next login, so a card can still render the
 * pre-prune list. Same provider plus same nickname is the same person (the
 * pack rewrites the nickname from a random id to the real display name the
 * moment a login lands), so the newest entry wins: it is the one whose
 * credential was written last.
 */
/**
 * Doubao's account, described in the pack's account shape.
 *
 * The lane is the plugin's own, so this reads its session route and translates the answer
 * into the row the rest of this page already knows how to draw. `undefined` means "no
 * session", which is the ordinary state before a sign-in.
 */
export async function readDoubaoAccount(): Promise<ChannelAccount | undefined> {
  try {
    const response = await fetch(POOL_DOUBAO_SESSION_PATH, { credentials: 'same-origin' })
    const body = await response.json().catch(() => undefined) as
      | { signedIn?: boolean; savedAt?: string; name?: string }
      | undefined
    if (body?.signedIn !== true) return undefined
    return {
      id: 'doubao:session',
      provider: 'doubao',
      // The vendor's own name for the user, so two Doubao accounts are distinguishable.
      nickname: typeof body.name === 'string' && body.name !== '' ? body.name : '豆包账号',
      enabled: true,
    }
  } catch {
    return undefined
  }
}

/**
 * Doubao's quota, in the pack's balance row shape.
 *
 * The card prints one number per account, so it is the NARROWEST window: that is the one
 * that stops the next request, and reporting the widest would overstate what is left.
 */
/**
 * The models Doubao's account may use, from the plugin's own route.
 *
 * The card used to build this list from the static catalogue while the picker read the
 * account's live roster, so the two could disagree — six on the card, twelve in the picker.
 */
export async function readDoubaoModels(): Promise<readonly { id: string; name: string; description?: string }[]> {
  try {
    const response = await fetch(POOL_DOUBAO_MODELS_PATH, { credentials: 'same-origin' })
    const body = await response.json().catch(() => undefined) as
      | { models?: { id?: string; name?: string; badge?: string; rate?: string; contextWindow?: number }[] }
      | undefined
    const models = Array.isArray(body?.models) ? body.models : []
    const rows = models
      .filter(model => typeof model.id === 'string' && typeof model.name === 'string')
      .map(model => ({
        id: model.id as string,
        /**
         * The multiplier is joined onto the name because that is the shape the card already
         * understands — every other channel writes it there (`DeepSeek-V4.1-Flash · x0.11`), and
         * `multiplierOf` splits it back out into its own badge. Doing it here keeps ONE rule for
         * every vendor instead of a Doubao-shaped exception in the renderer.
         */
        name: typeof model.rate === 'string' && model.rate !== ''
          ? `${model.name as string} · ${model.rate}`
          : model.name as string,
        ...(typeof model.badge === 'string' && model.badge !== '' ? { description: model.badge } : {}),
        ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
      }))
    /**
     * Close the restart gap — issue #196.
     *
     * A tick made before this fix, or in an earlier browser session, would leave
     * the host's list stale until the user happened to toggle something. Every
     * card read re-pushes the stored list, so opening the Doubao card once is
     * enough to make the picker agree with it.
     */
    await mirrorDoubaoDisabled()
    return rows
  } catch {
    return doubaoListing()
  }
}

export async function readDoubaoBalance(): Promise<readonly ChannelBalance[]> {
  try {
    const response = await fetch(POOL_DOUBAO_QUOTA_PATH, { credentials: 'same-origin' })
    const body = await response.json().catch(() => undefined) as
      | {
        signedIn?: boolean
        error?: string
        windows?: {
          type?: string
          label?: string
          usedPercent?: number
          remainingPercent?: number
          usedAmount?: number
          totalAmount?: number
        }[]
      }
      | undefined
    if (body?.signedIn !== true) return []
    const windows = Array.isArray(body.windows) ? body.windows : []
    if (windows.length === 0) {
      return [{
        accountId: 'doubao:session',
        nickname: '豆包账号',
        ...(typeof body.error === 'string' && body.error !== '' ? { error: body.error } : {}),
      }]
    }
    /**
     * One package per quota window, so the card's own expander lists them the way it lists a
     * WorkBuddy account's several credit buckets.
     *
     * The headline figure is the points actually left, summed across windows — that is what a
     * user reads as "my credits". Each package also carries its own remaining percentage and
     * total for the expanded view.
     */
    const packages = windows.map(window => {
      const remainingPercent = typeof window.remainingPercent === 'number'
        ? window.remainingPercent
        : Math.max(0, 100 - (typeof window.usedPercent === 'number' ? window.usedPercent : 0))
      const total = typeof window.totalAmount === 'number' ? window.totalAmount : undefined
      const used = typeof window.usedAmount === 'number' ? window.usedAmount : undefined
      const points = total !== undefined && used !== undefined ? Math.max(0, total - used) : undefined
      return {
        name: typeof window.label === 'string' && window.label !== '' ? window.label : '额度',
        unit: '点',
        remaining: remainingPercent,
        ...(total === undefined ? {} : { total }),
        ...(points === undefined ? {} : { points }),
      }
    })
    const pointsLeft = packages.reduce((sum, entry) => sum + (typeof entry.points === 'number' ? entry.points : 0), 0)
    const lowestPercent = packages.reduce((low, entry) => Math.min(low, entry.remaining), 100)
    return [{
      accountId: 'doubao:session',
      nickname: '豆包账号',
      balance: pointsLeft > 0 ? pointsLeft : Math.round(lowestPercent),
      extra: { unit: pointsLeft > 0 ? '点' : '%', windows: windows.length },
      packages,
    }]
  } catch {
    return []
  }
}
/* ---------------------------------------------------------------
   腾讯 Marvis：按 token 计的渠道（设计稿 marvis.html）。

   pack 没有 Marvis 适配器，account.list / model.list / credits.balances 都会答
   "unknown provider"，所以和豆包一样走插件自己的路由：
     - POOL_MARVIS_SESSION_PATH：存下的账号（openid / nickname / loginType）和模型
     - POOL_MARVIS_WALLET_PATH：每个账号自己的 token 钱包（accounts 数组，一号一行）
   每个账号每天有自己的 1000 万计费 token，卡片上画的是「已用 / 总量 + 重置时间」，
   不是渠道级别的汇总。
   --------------------------------------------------------------- */

/** 一个 Marvis 账号今天的 token 用量。 */
export interface MarvisQuota {
  openid: string
  nickname?: string | undefined
  used: number
  total: number
  available: number
  /** 今日额度重置的时刻（epoch ms）；后端没给就是 undefined。 */
  resetAt?: number | undefined
  /** 读不到时的原因（已转成中文）。 */
  error?: string | undefined
}

/** 上一次读到的用量，放在组件外面：切页回来第一帧就有数，不闪「…」。 */
export let marvisQuotaSnapshot: readonly MarvisQuota[] | undefined

/* ---------------------------------------------------------------
   整份账号池快照，存在本机（localStorage）。

   为什么：每次打开 DSH，账号池都要等 provider.status 把二十多家的账号池走一遍、
   再逐家 account.list / model.list，冷启动要好几秒，读者看到的是一排「—」。
   而上一次读到的账号和模型，99% 的情况下和这一次一样。

   所以：第一帧直接画上一次的真实数据（账号名、模型、余额），后台照常重读，
   读完再无声替换。读者感觉是「瞬时」的，数据也不会因此变旧 —— 旧的只多活几秒。

   存什么：只存显示用的字段。账号只留 id / 昵称 / 开关 / 到期时间 / 首选，
   不含任何 token 或 cookie（accountsFrom 本来就不带凭据，这里再白名单一遍）。
   版本号 v2：结构变了就换 key，旧 blob 不会喂给新代码。
   --------------------------------------------------------------- */
export const POOL_STORE_KEY = 'dsh-xdpool.pool-snapshot.v2'
/** 太旧的快照不用：一周没打开过，账号很可能已经变了，宁可显示占位。 */
export const POOL_STORE_MAX_AGE_MS = 7 * 24 * 3_600_000

export interface StoredPool {
  v: 2
  at: number
  entries: readonly ChannelEntry[]
  marvis?: readonly MarvisQuota[] | undefined
}

export let storedPoolCache: StoredPool | null | undefined
/** 读一次就记住：初始化 entries 和 Marvis 用量都要它，不读两遍 localStorage。 */
export function storedPoolOnce(): StoredPool | undefined {
  if (storedPoolCache !== undefined) return storedPoolCache ?? undefined
  storedPoolCache = readStoredPool() ?? null
  return storedPoolCache ?? undefined
}

export function readStoredPool(): StoredPool | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(POOL_STORE_KEY)
    if (raw === null || raw === undefined) return undefined
    const parsed = JSON.parse(raw) as Partial<StoredPool> | null
    if (parsed === null || parsed.v !== 2 || typeof parsed.at !== 'number') return undefined
    if (Date.now() - parsed.at > POOL_STORE_MAX_AGE_MS) return undefined
    if (!Array.isArray(parsed.entries)) return undefined
    const entries: ChannelEntry[] = []
    for (const row of parsed.entries as unknown[]) {
      if (row === null || typeof row !== 'object') continue
      const entry = row as Partial<ChannelEntry>
      if (typeof entry.channel?.id !== 'string') continue
      entries.push({
        channel: entry.channel,
        accounts: Array.isArray(entry.accounts) ? entry.accounts : [],
        models: Array.isArray(entry.models) ? entry.models : [],
        facts: new Map(),
        balances: Array.isArray(entry.balances) ? entry.balances : [],
        statuses: Array.isArray(entry.statuses) ? entry.statuses : [],
        // 存下来的余额就是答案，不再画「…」；后台重读到了会替换
        balancePending: false,
        balanceError: undefined,
        modelError: undefined,
        status: entry.status,
      })
    }
    if (entries.length === 0) return undefined
    return {
      v: 2,
      at: parsed.at,
      entries,
      ...(Array.isArray(parsed.marvis) ? { marvis: parsed.marvis } : {}),
    }
  } catch {
    return undefined
  }
}

/** 写快照。配额满了、隐私模式都静默失败：缓存写不进去不能让卡片坏掉。 */
export function writeStoredPool(entries: readonly ChannelEntry[], marvis: readonly MarvisQuota[] | undefined): void {
  try {
    const slim = entries.map(entry => ({
      channel: entry.channel,
      accounts: entry.accounts.map(account => ({
        id: account.id,
        provider: account.provider,
        ...(account.nickname === undefined ? {} : { nickname: account.nickname }),
        ...(account.enabled === undefined ? {} : { enabled: account.enabled }),
        ...(account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt }),
        ...(account.refreshable === true ? { refreshable: true } : {}),
        ...(account.preferred === true ? { preferred: true } : {}),
      })),
      // 介绍太长的截一下，整份快照控制在几百 KB 以内
      models: entry.models.map(model => (model.description !== undefined && model.description.length > 160
        ? { ...model, description: model.description.slice(0, 160) }
        : model)),
      balances: entry.balances,
      statuses: entry.statuses,
      ...(entry.status === undefined ? {} : { status: entry.status }),
    }))
    const blob: StoredPool = { v: 2, at: Date.now(), entries: slim as unknown as ChannelEntry[], ...(marvis === undefined ? {} : { marvis }) }
    globalThis.localStorage?.setItem(POOL_STORE_KEY, JSON.stringify(blob))
  } catch {
    // 写不进去就算了，下次照常从后端读
  }
}

/** Marvis 的账号与模型。没登录 / 读不到都答 undefined。 */
export async function readMarvisSession(): Promise<
  { accounts: readonly ChannelAccount[]; models: readonly { id: string; name: string }[] } | undefined
> {
  try {
    const response = await fetch(POOL_MARVIS_SESSION_PATH, { credentials: 'same-origin' })
    const body = await response.json().catch(() => undefined) as
      | {
        signedIn?: boolean
        accounts?: readonly { openid?: unknown; nickname?: unknown; loginType?: unknown }[]
        models?: readonly { id?: unknown; name?: unknown }[]
      }
      | undefined
    if (body?.signedIn !== true || !Array.isArray(body.accounts)) return undefined
    const accounts: ChannelAccount[] = []
    for (const row of body.accounts) {
      if (typeof row.openid !== 'string' || row.openid === '') continue
      accounts.push({
        id: row.openid,
        provider: 'marvis',
        ...(typeof row.nickname === 'string' && row.nickname !== '' ? { nickname: row.nickname } : {}),
        enabled: true,
      })
    }
    const models = (Array.isArray(body.models) ? body.models : [])
      .filter((model): model is { id: string; name: string } =>
        typeof model.id === 'string' && model.id !== '' && typeof model.name === 'string')
    return { accounts, models }
  } catch {
    return undefined
  }
}

/** 后端给的英文错误换成中文；认不出来的就说一句通用的，不把英文原样摆出来。 */
export function marvisErrorText(raw: string): string {
  const status = /HTTP\s+(\d{3})/u.exec(raw)?.[1]
  if (status === '401') return '登录已失效，请重新登录这个账号'
  if (status === '403') return '今日额度已用完或账号受限'
  if (status !== undefined) return `用量读取失败（${status}）`
  if (/timeout|aborted|timed out/iu.test(raw)) return '用量读取超时'
  if (/[\u4e00-\u9fff]/u.test(raw)) return raw
  return '用量读取失败'
}

/** 每个账号自己的 token 用量。整个请求失败答空数组，卡片上显示「—」。 */
export async function readMarvisQuotas(): Promise<readonly MarvisQuota[]> {
  try {
    const response = await fetch(POOL_MARVIS_WALLET_PATH, { credentials: 'same-origin' })
    const body = await response.json().catch(() => undefined) as
      | {
        signedIn?: boolean
        accounts?: readonly {
          openid?: unknown
          nickname?: unknown
          used?: unknown
          total?: unknown
          available?: unknown
          resetAt?: unknown
          error?: unknown
        }[]
      }
      | undefined
    if (body?.signedIn !== true || !Array.isArray(body.accounts)) return []
    const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
    const rows: MarvisQuota[] = []
    for (const row of body.accounts) {
      if (typeof row.openid !== 'string' || row.openid === '') continue
      const used = num(row.used)
      const total = num(row.total)
      rows.push({
        openid: row.openid,
        nickname: typeof row.nickname === 'string' && row.nickname !== '' ? row.nickname : undefined,
        used,
        total,
        available: typeof row.available === 'number' ? num(row.available) : Math.max(0, total - used),
        resetAt: typeof row.resetAt === 'number' && Number.isFinite(row.resetAt) ? row.resetAt : undefined,
        error: typeof row.error === 'string' && row.error !== '' ? marvisErrorText(row.error) : undefined,
      })
    }
    return rows
  } catch {
    return []
  }
}

/**
 * 「今天 24:00 重置」「8 小时后重置」「3 天后重置」。
 *
 * 不到一小时说分钟，不到一天说小时；今天之内并且整点落在午夜的，直接说「今天 24:00」。
 */
export function marvisResetText(resetAt: number | undefined, now: number = Date.now()): string {
  if (resetAt === undefined) return '每天重置'
  const left = resetAt - now
  if (left <= 0) return '即将重置'
  const minutes = Math.ceil(left / 60_000)
  if (minutes < 60) return `${String(minutes)} 分钟后重置`
  const hours = Math.round(left / 3_600_000)
  if (hours < 24) return `${String(hours)} 小时后重置`
  const days = Math.round(left / 86_400_000)
  return `${String(days)} 天后重置`
}

/** 鼠标悬停时给出的绝对时间：「今天 24:00 重置」「11月25日 00:00 重置」。 */
export function marvisResetTitle(resetAt: number | undefined, now: number = Date.now()): string | undefined {
  if (resetAt === undefined) return undefined
  const at = new Date(resetAt)
  const today = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const tomorrow = new Date(now + 86_400_000)
  /* 落在明天 0 点的，就是「今天 24:00」 */
  if (sameDay(at, tomorrow) && at.getHours() === 0 && at.getMinutes() === 0) return '今天 24:00 重置'
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  if (sameDay(at, today)) return `今天 ${clock} 重置`
  return `${String(at.getMonth() + 1)}月${String(at.getDate())}日 ${clock} 重置`
}

/** 1234567 → 「1,234,567」。 */
export function groupDigits(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** 2000_0000 → 「2,000」（单位万）。 */
export function wanDigits(value: number): string {
  return (value / 10_000).toLocaleString('en-US', { maximumFractionDigits: 1 })
}

/**
 * The catalogue as cards, with no counts.
 *
 * Built from the same constant the host serves, so the placeholder is never a different list
 * from the real one — only a list without measurements. Every action is absent, which is what
 * makes it safe: a button on a card whose data has not arrived would act on nothing.
 */
export function placeholderEntries(): readonly ChannelEntry[] {
  /**
   * Counts from the last run are fed in as SYNTHETIC rows.
   *
   * A card needs an account row to print a number, and inventing four of them would put four
   * sign-ins on screen that do not exist. Instead each stored count becomes ONE row standing
   * for the group, which the card renders as "4" — and the first real answer replaces the whole
   * entry, so the placeholder never outlives a successful read.
   */
  const stored = readStoredCounts()
  return REGISTERED_CHANNELS
    .filter(channel => !REGION_OWNED_CHANNELS.has(channel.id))
    .map(channel => {
      const known = stored?.channels[channel.id]
      const accountRows = known === undefined || known.accounts <= 0
        ? []
        : Array.from({ length: known.accounts }, (unused, index) => ({
          id: `cached-${channel.id}-${String(index)}`,
          provider: channel.id,
          // A placeholder row is numbered, not named: naming it would claim an identity the
          // cache does not hold.
          nickname: `—`,
          enabled: true,
        })) as ChannelAccount[]
      return {
        // The roster row IS the card's catalogue half: same name, note, accent and icon.
        channel: { ...channel, loginKind: channel.login, ownedByPool: channel.ownedByPool === true } as PoolWebChannel,
        accounts: accountRows,
        models: known === undefined || known.models <= 0
          ? []
          : Array.from({ length: known.models }, (unused, index) => ({
            id: `cached-${channel.id}-m${String(index)}`,
            name: '',
          })) as PoolWebChannelModel[],
        facts: new Map(),
        balances: known?.balance === undefined
          ? []
          : [{ accountId: `cached-${channel.id}-0`, balance: known.balance }] as ChannelBalance[],
        statuses: [],
        status: undefined,
        balancePending: known?.balance === undefined,
      }
    })
}

export function dedupeAccounts(accounts: readonly ChannelAccount[]): readonly ChannelAccount[] {
  const byNickname = new Map<string, ChannelAccount>()
  const order: string[] = []
  for (const account of accounts) {
    const nickname = (account.nickname ?? '').trim()
    const key = nickname === '' ? `id:${account.id}` : `n:${nickname}`
    const kept = byNickname.get(key)
    if (kept === undefined) {
      byNickname.set(key, account)
      order.push(key)
      continue
    }
    byNickname.set(key, account)
  }
  return order.map(key => byNickname.get(key)).filter((account): account is ChannelAccount => account !== undefined)
}

/** A refusal shaped like the pack's own envelope, so one catch covers both. */
export function refused(message: string): ChannelRpcEnvelope {
  return { ok: false, error: { message } }
}

/**
 * "3 days left" / "expired" / "no expiry", from a millisecond stamp.
 *
 * `never` is the honest answer for the channels whose credentials carry no
 * expiry at all (ZCode among them), and printing "expired" or a date for those
 * would be a number the user cannot check.
 */
export function expiryText(
  expiresAt: number | undefined,
  t: Translate | undefined,
): string | undefined {
  if (expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return t?.('channelpool.expiryNever') ?? 'no expiry'
  }
  // Two defects fixed here, both of which made the label actively misleading:
  //
  // 1. An EXPIRED credential used to return the "no expiry" string. `days <= 0`
  //    covered both a negative value (already past) and zero (due today), and it
  //    shared the placeholder meant for channels that carry no expiry at all
  //    (ZCode among them). A CodeArts row whose STS token had lapsed read
  //    "长期有效" while the balance cell beside it said
  //    `APIG.0602: the security token has expired` — one row contradicting
  //    itself, each half pointing at a different, wrong fix (#114).
  //
  // 2. `Math.ceil(days)` collapsed every sub-day remainder into "1d", so the
  //    rows with the MOST urgent clocks (CodeArts STS tokens live about two
  //    hours) were exactly the ones that could never show one.
  //
  // So: a past stamp is its own state, and the unit steps down to hours and then
  // minutes as the deadline approaches. "no expiry" now means only what it says.
  const remainingMs = expiresAt - Date.now()
  if (remainingMs <= 0) return t?.('channelpool.expiryExpired') ?? 'expired'
  const minutes = Math.floor(remainingMs / 60_000)
  if (minutes < 60) return minutes <= 1 ? '不到 1 分钟后过期' : `${String(minutes)} 分钟后过期`
  const hours = Math.floor(remainingMs / 3_600_000)
  if (hours < 24) return `${String(hours)} 小时后过期`
  const days = Math.floor(remainingMs / 86_400_000)
  return `${String(days)} 天后过期`
}

/** The vendor's currency, spelled the way that vendor spells it. */
export function creditUnitLabel(channel: PoolWebChannel, t: Translate | undefined): string {
  const unit = channel.credits?.unit
  if (unit === 'dollars') return t?.('channelpool.creditsDollar') ?? 'USD'
  if (unit === 'tokens') return t?.('channelpool.creditsToken') ?? 'tokens'
  if (channel.credits?.quota === true) return t?.('channelpool.creditsQuota') ?? 'quota'
  return t?.('channelpool.creditsUnit') ?? 'credits'
}

/** Trim a decimal to something a card can print without lying about it. */

/**
 * 账号显示名。
 *
 * `nickname` 声明是字符串，但后端可以给对象/数字/null —— React 直接渲染
 * 对象会抛「Objects are not valid as a React child」，整张账号卡消失。
 * 宁可显示 id 或一个占位，也不让卡片不见。
 */
export function accountLabel(account: { id?: unknown; nickname?: unknown }): string {
  if (typeof account.nickname === 'string' && account.nickname !== '') return account.nickname
  if (typeof account.id === 'string' && account.id !== '') return account.id
  if (typeof account.id === 'number') return String(account.id)
  return '（未命名账号）'
}

/**
 * 名字是不是一串机器 id（openid / uuid / 随机串），而不是人能认的名字。
 *
 * Marvis 的 openid（83F37C07…952B）、pack 登录前占位的随机 id、uuid 都会被当成昵称存下来，
 * 卡片上于是是一长串十六进制。邮箱、手机号（含打码）、带中文或空格的名字都算「人名」。
 */
export function looksLikeMachineId(text: string): boolean {
  const value = text.trim()
  if (value === '') return true
  /*
    pack 的占位名：某个 provider 的凭据文件里有引用、但找不到对应账号记录时，
    它写 `nickname: provider + " account"`（`buddy account`）。
    七个账号全叫这个名字 —— 那不是名字。
  */
  if (/^[a-z0-9][a-z0-9-]* account$/iu.test(value)) return true
  /*
    pack 生成的默认 id：`codearts-f882ad03` / `minimax-e8524f6e`。
    这家上游没有昵称接口（见下方 accountDisplay 的说明），pack 只能发一个唯一 id，
    而它同时把 id 当成了 nickname。
  */
  if (/^[a-z][a-z0-9-]*-[a-f0-9]{8}$/u.test(value)) return true
  if (/[\u4e00-\u9fff\s@]/u.test(value)) return false
  if (/^\+?[\d*]{7,15}$/u.test(value)) return false            // 手机号 / 打码手机号
  if (/^[0-9a-f-]{16,}$/iu.test(value)) return true              // hex / uuid
  if (value.length >= 20 && !/[aeiou]{2}/iu.test(value) && /\d/u.test(value)) return true
  if (/^[A-Za-z0-9_-]{22,}$/u.test(value) && /[A-Z]/u.test(value) && /[a-z]/u.test(value) && /\d/u.test(value)) return true
  return false
}

/**
 * 卡片上显示的账号名。
 *
 *   - 有像样的昵称 / 邮箱 / 手机号 → 原样；
 *   - 只有机器 id → 「腾讯 Marvis 账号 1」，id 的末四位放在副标题里方便区分；
 *   - 鼠标悬停（title）永远给完整的原始 id。
 */
export function accountDisplay(
  account: { id?: unknown; nickname?: unknown },
  channelName: string,
  index: number,
): { name: string; tail?: string; full: string } {
  const raw = accountLabel(account)
  const id = typeof account.id === 'string' ? account.id : raw
  const full = raw === id ? raw : `${raw}（${id}）`
  /*
    昵称只是渠道名（含「CodeArts 代码」「腾讯 Marvis 账号 1」这类变体）时，
    它不区分任何账号 —— 三个 CodeArts 账号会长得一模一样。
    这种情况按「没有昵称」处理，改用 id 末四位区分。

    判据：昵称里去掉渠道名和常见后缀字之后，剩下的不是有意义的词。
  */
  if (sameAsChannel(raw, channelName)) {
    const tail = id.replace(/[^A-Za-z0-9]/gu, '').slice(-4)
    return { name: `${channelName} ${String(index + 1)}`, ...(tail === '' ? {} : { tail }), full }
  }
  if (!looksLikeMachineId(raw)) return { name: raw, full }
  const tail = id.replace(/[^A-Za-z0-9]/gu, '').slice(-4)
  return { name: `${channelName} 账号 ${String(index + 1)}`, ...(tail === '' ? {} : { tail }), full }
}

/**
 * 昵称是不是「就是渠道名」，或者只比渠道名多几个没有信息量的词。
 *
 * pack 的默认昵称是 `CodeArts 代码`、`腾讯 Marvis 账号 1` 这种：
 * 同一家的每个账号都叫这个，等于没有名字。
 */
export function sameAsChannel(nickname: string, channelName: string): boolean {
  const strip = (text: string): string => text
    .toLowerCase()
    .replace(/\s+/gu, '')
    /* 去掉这些没有区分度的中文词：它们只是把渠道名拉长，不指向任何具体账号 */
    .replace(/代码|账号|账户|默认|用户|腾讯|国际版|国内版|国际|国内|的|号/gu, '')
  const a = strip(nickname)
  const b = strip(channelName)
  if (a === '' || b === '') return false
  /* 昵称去掉外壳后落在渠道名里，或渠道名落在昵称里 —— 都不是真名字 */
  return a.includes(b) || b.includes(a)
}

/**
 * 余额 / 配额读取失败的原因，换成中文且一句话说清该怎么办。
 *
 * 上游原文常是「配额查询被拒（HTTP 403）（VALIDATION_REQUIRED）：Verify your account to continue.」
 * 这种中英混排的长串，卡片放不下也看不懂。认得出的给出处理办法，认不出的保留中文部分、去掉英文。
 */
export function balanceErrorText(raw: string): string {
  if (/VALIDATION_REQUIRED|verify your account/iu.test(raw)) return '需要先在浏览器里验证这个 Google 账号，验证后点「重新检测账号」'
  if (/HTTP\s*401|unauthori[sz]ed|token.*(expired|invalid)|expired/iu.test(raw)) return '登录已失效，请重新登录这个账号'
  if (/HTTP\s*429|rate.?limit|too many/iu.test(raw)) return '请求太频繁，稍后再试'
  if (/HTTP\s*403|forbidden/iu.test(raw)) return '查询被拒（403），可能需要重新登录'
  if (/timeout|timed out|aborted/iu.test(raw)) return '查询超时'
  if (/HTTP\s*5\d\d/iu.test(raw)) return '厂商服务暂时不可用'
  const chinese = raw.replace(/[（(][^）)]*[A-Za-z][^）)]*[）)]/gu, '').split(/[：:]/u)[0]?.trim() ?? ''
  return /[\u4e00-\u9fff]/u.test(chinese) ? chinese : '余额读取失败'
}

/** Marvis 每个账号每天的计费 token 额度（设计稿 marvis.html 写明 1,000 万）。后端答了总量就用后端的。 */
export const MARVIS_DAILY_TOKENS = 10_000_000

export function amount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
export async function cachedProviderStatus(providers: readonly string[]): Promise<ChannelRpcEnvelope> {
  // The key is the provider SET, not just a timestamp: a channel list that changed
  // (a new pack row, a removed channel) must not be answered from a cache built for
  // the old one.
  const key = [...providers].sort().join('\u0000')
  const hit = providerStatusCache
  if (hit !== undefined && hit.key === key && Date.now() - hit.at < PROVIDER_STATUS_TTL_MS) {
    return hit.answer
  }
  const answer = await callPack('provider.status', { providers: [...providers] })
  providerStatusCache = { at: Date.now(), key, answer }
  return answer
}


/**
 * 走自己钱包路由的渠道。
 *
 * 这五家的余额不在 pack 的 `credits.balances` 里 —— 那是给二十二家通用厂商用的，
 * 对它们只会答 "unsupported"。每家有自己的 route、自己的返回字段，
 * 所以用一张表列出来，比在读取处写五个 if 更容易核对。
 *
 * 缺了这张表的表现是「卡片上有账号、没有金额」，而且不报错 —— 用户以为它们没余额。
 */
export const OWN_WALLET_ROUTES: Readonly<Record<string, string>> = {
  astudio: POOL_ASTUDIO_WALLET_PATH,
  accio: POOL_ACCIO_QUOTA_PATH,
  'monkeycode': POOL_MONKEYCODE_CN_WALLET_PATH,
  'monkeycode-intl': POOL_MONKEYCODE_INTL_WALLET_PATH,
  baizhi: POOL_BAIZHI_WALLET_PATH,
  'autoclaw-intl': POOL_AUTOCLAW_INTL_WALLET_PATH,
  'autoclaw': POOL_AUTOCLAW_CN_WALLET_PATH,
  /* 超级麦吉两站各自的钱包路由（magicrew-routes.ts 实现） */
  'magicrew': POOL_MAGICREW_CN_WALLET_PATH,
  'magicrew-intl': POOL_MAGICREW_INTL_WALLET_PATH,
}

/** 从一家自己的钱包路由读余额；失败返回 undefined，卡片就不印数字。 */
export async function fetchOwnWallet(channel: string): Promise<number | undefined> {
  const route = OWN_WALLET_ROUTES[channel]
  if (route === undefined) return undefined
  try {
    const response = await fetch(route, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
    if (!response.ok) return undefined
    const body = await response.json() as { ok?: boolean; total?: number; buckets?: readonly { amount?: number }[] }
    if (body.ok === false) return undefined
    if (typeof body.total === 'number') return body.total
    // accio 报的是 buckets，加总才是总数
    if (Array.isArray(body.buckets)) {
      const sum = body.buckets.reduce((n, b) => n + (typeof b.amount === 'number' ? b.amount : 0), 0)
      return sum > 0 ? sum : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}


/**
 * 签到不走 `credits.claimAll` 的渠道。
 *
 * pack 的 claimAll 对它们答 "unsupported provider" —— 那三个路由是插件自己实现的，
 * 于是「全部领取」按下去像是坏的，而不是没这个功能。
 */
export const OWN_CHECKIN_CHANNELS: Readonly<Record<string, string>> = {
  'astudio': POOL_ASTUDIO_CHECKIN_PATH,
  'baizhi': POOL_BAIZHI_CHECKIN_PATH,
  'magicrew': POOL_MAGICREW_CN_CHECKIN_PATH,
  'magicrew-intl': POOL_MAGICREW_INTL_CHECKIN_PATH,
  /* autoclaw 与 magicrew 共用同一套签到实现 */
  'autoclaw': POOL_MAGICREW_CN_CHECKIN_PATH,
  'autoclaw-intl': POOL_MAGICREW_INTL_CHECKIN_PATH,
}

/**
 * 领一个渠道的签到积分。
 *
 * 一个分发器而不是四处复制：文案与随后的余额刷新必须一致，复制四份就会漂。
 * 返回一句给用户看的结果 + 路由回传的各账号领取状态（回喂徽章用），
 * 失败也返回（而不是抛），调用处直接显示。
 */
export async function ownCheckin(channel: string): Promise<{ text: string; claimed: ChannelCreditStatus[] } | undefined> {
  const route = OWN_CHECKIN_CHANNELS[channel]
  if (route === undefined) return undefined
  try {
    const response = await fetch(route, {
      method: 'POST',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    const body = await response.json() as {
      ok?: boolean
      credit?: number
      gained?: number
      reason?: string
      error?: string
      accounts?: readonly { accountId?: unknown; todayCheckedIn?: unknown; todayCredit?: unknown }[]
    }
    if (body.ok === false) return { text: body.reason ?? body.error ?? '签到失败', claimed: [] }
    /* magicrew 系路由回传每个账号的领取结果，直接回喂徽章（只收「已领」的行） */
    const claimed = (body.accounts ?? []).flatMap(row =>
      typeof row.accountId === 'string' && row.accountId !== '' && row.todayCheckedIn === true
        ? [{
            accountId: row.accountId,
            todayCheckedIn: true as const,
            ...typeof row.todayCredit === 'number' && Number.isFinite(row.todayCredit)
              ? { todayCredit: row.todayCredit }
              : {},
          }]
        : [])
    /* magicrew 路由的总额字段叫 gained，astudio / baizhi 叫 credit */
    const credit = typeof body.credit === 'number' ? body.credit : body.gained
    return { text: typeof credit === 'number' ? `已领 ${String(credit)} 积分` : '已签到', claimed }
  } catch {
    return { text: '签到失败', claimed: [] }
  }
}


/**
 * 走自己会话路由的渠道。
 *
 * 这五家的「登进来了没有」不走 pack 的 provider.status —— 那对它们答 unsupported，
 * 卡片于是永远显示「未登录」，即使账号已经存好了。
 *
 * 每家一个路由，字段却是同一套（signedIn / accounts / name / savedAt），
 * 所以一张表就够，不用写五份读取逻辑。
 */
export const OWN_SESSION_ROUTES: Readonly<Record<string, string>> = {
  'astudio': POOL_ASTUDIO_SESSION_PATH,
  'accio': POOL_ACCIO_SESSION_PATH,
  'monkeycode': POOL_MONKEYCODE_CN_SESSION_PATH,
  'baizhi': POOL_BAIZHI_SESSION_PATH,
  'autoclaw': POOL_AUTOCLAW_CN_SESSION_PATH,
  'autoclaw-intl': POOL_AUTOCLAW_INTL_SESSION_PATH,
}

/**
 * 读一家自己渠道的会话。
 *
 * 返回 undefined 表示「这个渠道没有自己的会话路由」或者「读不到」——
 * 两种情况调用处都该退回 pack 的判断，而不是把卡片标成未登录。
 */
export async function fetchOwnSession(channel: string): Promise<
  { signedIn: boolean; accounts?: readonly { id?: string; name?: string; dailyClaimed?: boolean }[] | undefined; name?: string | undefined } | undefined
> {
  const route = OWN_SESSION_ROUTES[channel]
  if (route === undefined) return undefined
  try {
    const response = await fetch(route, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
    if (!response.ok) return undefined
    const body = await response.json() as {
      signedIn?: boolean
      accounts?: readonly { id?: string; name?: string; dailyClaimed?: boolean }[]
      name?: string
      dailyClaimed?: boolean
    }
    return { signedIn: body.signedIn === true, accounts: body.accounts, name: body.name }
  } catch {
    return undefined
  }
}

export function assignProviderStatusCache(next: typeof providerStatusCache): void {
  providerStatusCache = next
}

export function assignPoolSnapshot(next: typeof poolSnapshot): void {
  poolSnapshot = next
}

export function assignMarvisQuotaSnapshot(next: typeof marvisQuotaSnapshot): void {
  marvisQuotaSnapshot = next
}
