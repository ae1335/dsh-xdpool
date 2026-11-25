/**
 * Types shared by the WorkBuddy account pool: credentials, accounts, and
 * the pool options. Type-only module: no runtime code lives here.
 */

/** Minimal upstream surface the pool needs to refresh a token (no circular import). */
export interface TokenRefresher {
  refreshToken(credential: WorkBuddyCredential): Promise<{
    accessToken: string
    refreshToken?: string
    expiresInSec?: number
    domain?: string
  }>
}

/**
 * Minimal billing surface the pool needs to fill `creditExpiry` itself.
 *
 * Declared here for the same reason as {@link TokenRefresher}: the pool knows
 * about accounts, not about HTTP, and importing `WorkBuddyUpstreamClient` would
 * make the two modules circular. `fetchCredits` is OPTIONAL so every existing
 * `TokenRefresher` — the test stubs, and any host that only wired token refresh
 * — keeps working untouched; a client without it simply warms nothing.
 */
export interface CreditReader {
  fetchCredits(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<{
    total: number
    /** Absent (or undefined) when no one-off pack has a deadline. */
    nearestExpiryMs?: number | undefined
  }>
}

/**
 * What the pool knows about one account's one-off pack deadlines.
 *
 * The three `state`s are the whole point of the B+ fix: "never asked", "asked,
 * nothing has a deadline" and "asked, here is the deadline" need different
 * handling, and collapsing them into one absent-key predicate is what made a
 * pure monthly-pack account be re-read forever (S1 in
 * `EXPIRY-ADVERSARIAL-20261111.md`). `stale` is orthogonal: the reading is real
 * but older than {@link EXPIRY_READING_TTL_MS}, so it describes the past.
 */
export interface ExpiryReading {
  state: 'unread' | 'none' | 'at'
  /** Deadline, epoch ms; present exactly when `state === 'at'`. */
  at?: number
  /** When this reading was written, epoch ms; absent for `unread`. */
  readAtMs?: number
  /** True when the reading is older than {@link EXPIRY_READING_TTL_MS}. */
  stale: boolean
}

/** One parsed WorkBuddy credential. */
/**
 * A credential file the pool could not turn into an account.
 *
 * Reported (not swallowed) because the count is otherwise a lie: a directory
 * holding four files that yields two accounts looks like two accounts were
 * deleted, when in fact two files were unreadable. Naming the file and the
 * reason is what makes the difference visible.
 */
export interface WorkBuddySkippedFile {
  path: string
  /**
   * `key-rotated` is separated from `encrypted` on purpose (#178).
   *
   * Both mean "this file is sealed and we cannot open it", but the FIX differs: an
   * `encrypted` file opens once the desktop app has run and handed over its key, while a
   * file sealed under a keyId no installed build produces will NEVER open that way — the
   * vendor rotated the at-rest key and the old envelope is orphaned. Reporting both as
   * 「启动一次 WorkBuddy」 sent the user to do something that could not work.
   */
  reason: 'encrypted' | 'key-rotated' | 'expired' | 'unreadable' | 'malformed'
}

export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  /**
   * When the upstream says it issued this token (`auth.lastRefreshTime`).
   *
   * This, not `expiresAtMs`, is the reliable freshness signal: the upstream
   * never rewrites a stored expiry when it revokes a token, so a long-dead
   * backup can claim to expire later than the token that actually works.
   * Absent on documents the desktop app did not write (the plugin's own
   * refreshed copy, older builds).
   */
  lastRefreshAtMs?: number
  nickname?: string
  uin?: string
  uid?: string
  enterpriseId?: string
  domain: string
  /** Where this credential came from, for diagnostics. */
  sourcePath: string
}

/** An account is a credential plus pool bookkeeping. */
export interface WorkBuddyAccount {
  /** Stable pool key: sha256 of the billing identity. */
  id: string
  /** Short human label, e.g. `青楫渡` or `青楫渡#29890334`. */
  label: string
  credential: WorkBuddyCredential
  /**
   * Epoch ms until which this account is skipped for EVERY model. Only set by
   * account-wide cooldowns (callers that penalize without a model id). The
   * upstream rate limit is actually per-model ("可切换其他模型继续使用"), so
   * routine 429s are tracked in {@link modelCooldowns} instead and never ban a
   * whole account.
   */
  cooldownUntilMs: number
  /**
   * Per-model cooldowns, keyed by upstream model id → epoch ms until that model
   * on THIS account is skipped. A 429 on `hy4-preview` cools only that model
   * here; `hy3`/`glm-*` on the same account keep serving.
   */
  modelCooldowns: Record<string, number>
  /** Consecutive rate-limit hits, for diagnostics. */
  rateLimitHits: number
  /**
   * Epoch ms until which this account is skipped because the upstream REJECTED
   * its sign-in (401/403), not because of a rate limit.
   *
   * A revoked session is invisible from the credential file: the upstream does
   * not rewrite `expiresAtMs` when it kills a refresh token, so a dead account
   * looks perfectly fresh and, without this field, gets picked again on the very
   * next attempt. With `maxAttempts` retries that meant one dead account could
   * absorb an entire request while healthy accounts were never tried.
   *
   * Only a fresh sign-in in the desktop app clears it, so the cooldown is long;
   * `0`/undefined means "not known to be dead".
   */
  credentialDeadUntilMs?: number
}

/** How the pool chooses which account serves the next request. */
export type AccountDistribution = 'priority' | 'round-robin' | 'balanced' | 'sticky' | 'expiry'

export interface AccountPoolOptions {
  /**
   * File the `sticky` bindings are remembered in, or undefined for memory only.
   *
   * The card promises one account per conversation, and that promise used to end
   * at the process boundary: every restart re-picked, so one session could be
   * served by three different accounts in a day and pay full prompt cost each
   * time. The caller passes the plugin's own state path; tests pass a temp file.
   */
  affinityPath?: string
  /** Logger for discovery and rotation events. */
  logger?: { info?(...args: unknown[]): void; warn(...args: unknown[]): void; error?(...args: unknown[]): void }
  /** Override the directories scanned (tests). */
  authDirs?: readonly string[]
  /** How long a rate-limited account stays out of rotation. */
  cooldownMs?: number
  /** How long an account rests after its credits run out (default 30 minutes). */
  exhaustCooldownMs?: number
  /**
   * How long an account rests after the upstream rejects its sign-in
   * (default 30 minutes). Only a fresh sign-in in the desktop app clears it.
   */
  credentialDeadCooldownMs?: number
  /** Upstream client used to refresh near-expiry tokens. */
  client?: TokenRefresher & Partial<CreditReader>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
  /**
   * How long a credit-pack deadline reading is trusted, in ms.
   *
   * Defaults to {@link EXPIRY_READING_TTL_MS}; overridable so a test can age a
   * reading without sleeping for an hour.
   */
  expiryReadingTtlMs?: number
  /**
   * How requests are spread across the pool.
   *
   * - `priority` (default): one account serves every request until it is
   *   rate-limited, then the next in order takes over. Credits drain one
   *   account at a time, and a cooled account resumes at the head of the
   *   queue the moment its window resets.
   * - `round-robin`: consecutive requests rotate through the pool so the
   *   spend spreads evenly.
   * - `sticky`: one account per conversation, and a new conversation moves to
   *   the next account in order. Keeps the upstream prompt cache warm inside a
   *   conversation while still spreading spend across conversations.
   * - `expiry`: the account whose one-off credit packs expire soonest serves
   *   first, so use-it-or-lose-it credits are spent before they die. Accounts
   *   with no known expiry sort last, so a pool that has never been probed
   *   behaves like `priority`.
   */
  distribution?: AccountDistribution
  /**
   * Enable the durable account store.
   *
   * When on, `scan()` seeds its merge from `~/.dsh/.xdpool/accounts.json` and
   * writes the merged list back, so accounts gathered by switching desktop
   * sign-ins survive a restart, and the plugin's snapshot directory becomes a
   * scan source.
   *
   * DEFAULT OFF, on purpose: the 70+ existing pool tests build fixtures over
   * temp auth dirs, and a store that wrote by default would flush those
   * fixtures into the user's real `~/.dsh/.xdpool/accounts.json`. Production
   * assembles the pool through `createCore()`, which passes `persistent: true`;
   * tests opt in explicitly.
   */
  persistent?: boolean
}
