/**
 * Pure helpers for the WorkBuddy account pool: parsing, identity, and
 * the tuning constants. No file system access happens in this module.
 */

import { createHash } from 'node:crypto'

import { basename } from 'node:path'

import { isEncryptedFieldWrapper } from './at-rest.ts'

import type { WorkBuddyCredential } from './accounts-types.ts'

/** Live auth file name the WorkBuddy desktop app writes. */
export const WORKBUDDY_LIVE_FILENAME = 'workbuddy-desktop.info'

/** Snapshot files left behind by previous logins share this prefix. */

/** Env override for the auth file or its directory. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

export function nonEmptyEnv(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
export function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read one string-valued field that may arrive as a plain string (older builds)
 * or as the desktop app's `$wbEncrypted` envelope. The app started encrypting
 * `accessToken` / `refreshToken` / `nickname` in 5.6.0 on BOTH macOS and Windows
 * — the earlier "Windows first" reading was wrong, and it is why a signed-in Mac
 * showed no account at all: the value is an object, `typeof === 'string'` failed,
 * and the parser reported "no credential" for a perfectly good sign-in.
 *
 * `decrypt` is injected rather than called here so this parser stays synchronous
 * and testable; the async key fetch lives in `readCredential`. A field that IS
 * encrypted but could not be opened is reported as `failed` rather than as an
 * empty string — the caller must tell the user the app is missing or unreachable,
 * not send them to sign in again (the one action that cannot help).
 */
/**
 * Marker for "the credential is encrypted and we could not obtain the key".
 *
 * Carried as a `code` rather than left to `instanceof` because the value crosses
 * the packaged-plugin boundary; the same convention the sibling error types use.
 * This is deliberately NOT "not signed in": the user IS signed in, and telling
 * them to sign in again sends them to the one action that cannot help.
 */
export const ENCRYPTED_CREDENTIAL_CODE = 'ENCRYPTED_CREDENTIAL'

export class WorkBuddyEncryptedCredentialError extends Error {
  readonly code = ENCRYPTED_CREDENTIAL_CODE
  constructor(sourcePath: string) {
    super(
      `workbuddy: ${sourcePath} holds encrypted credentials, but no WorkBuddy desktop app could be located to provide the key.`
        + ' If the app IS installed, it is simply outside the paths this plugin probes — set '
        + 'WORKBUDDY_APP_EXECUTABLE to its full .exe path (then restart DSH) and the credential will open.'
        + ' Signing in again will not help: the credential itself is intact. '
        + 'Run `dsh-xdpool doctor` to see which paths were probed — if one of them looks like '
        + 'mojibake (e.g. "??" where a Chinese folder name should be), the registry value could not be '
        + 'decoded on this machine; report that line and use the override above in the meantime.',
    )
    this.name = 'WorkBuddyEncryptedCredentialError'
  }
}

/** True when a thrown value is the encrypted-credential marker (cross-bundle safe). */
export function isEncryptedCredentialError(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && (value as { code?: unknown }).code === ENCRYPTED_CREDENTIAL_CODE
}

function decryptableString(
  value: unknown,
  decrypt: ((field: unknown) => string) | undefined,
): { value: string; encrypted: boolean; failed: boolean } {
  if (typeof value === 'string') return { value, encrypted: false, failed: false }
  if (isEncryptedFieldWrapper(value)) {
    if (decrypt === undefined) return { value: '', encrypted: true, failed: true }
    try {
      return { value: decrypt(value), encrypted: true, failed: false }
    } catch {
      return { value: '', encrypted: true, failed: true }
    }
  }
  return { value: '', encrypted: false, failed: false }
}

/**
 * Parse a WorkBuddy auth document. Accepts the nested desktop shape
 * `{"auth":{...},"account":{...}}` and the flat panel shape; returns undefined
 * when there is no usable access token.
 *
 * `decrypt` opens the desktop app's `$wbEncrypted` field wrapper (5.6.0+, both
 * platforms). Absent means "plain-string builds only", which is what every
 * caller without an at-rest key should pass.
 */
export function parseWorkBuddyAuth(
  text: string,
  sourcePath: string,
  decrypt?: (field: unknown) => string,
): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>

  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity =
      typeof document['account'] === 'object' && document['account'] !== null
        ? (document['account'] as Record<string, unknown>)
        : {}
  } else {
    auth = document
    identity = document
  }

  const accessField = decryptableString(auth['accessToken'], decrypt)
  // An encrypted-but-unopenable credential must NOT be reported as a readable
  // one with an empty token: the caller has to distinguish "not signed in" from
  // "signed in, but the app holding the key is missing".
  if (accessField.encrypted && accessField.failed) {
    throw new WorkBuddyEncryptedCredentialError(sourcePath)
  }
  const accessToken = accessField.value
  if (accessToken === '') return undefined

  // Skip documents whose refresh window has already closed: they cannot recover.
  const refreshExpiresAtMs =
    typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  if (refreshExpiresAtMs !== undefined && refreshExpiresAtMs > 0 && refreshExpiresAtMs < Date.now()) {
    return undefined
  }

  // The upstream's own issue time, the only signal that stays truthful after a
  // token is revoked: credential selection prefers it over the stored expiry,
  // which a dead backup can claim arbitrarily far into the future.
  const lastRefreshAtMs = typeof auth['lastRefreshTime'] === 'number'
    ? expiryToMs(auth['lastRefreshTime'])
    : undefined
  // Resolved ONCE each, then used twice: the identity fields were written as
  // `optionalString(…) === undefined ? {} : { uin: optionalString(…) }`, which
  // ran the parse twice AND defeated the type narrowing — TypeScript narrows the
  // first call but not the second, so the object literal carried `string | undefined`
  // into a field declared `?: string`. One const fixes both.
  const nickname = optionalString(decryptableString(identity['nickname'], decrypt).value)
  const uin = optionalString(identity['uin'])
  const uid = optionalString(identity['uid'])
  const enterpriseId = optionalString(identity['enterpriseId'])

  return {
    accessToken,
    refreshToken: decryptableString(auth['refreshToken'], decrypt).value,
    expiresAtMs: typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    ...lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs },
    ...nickname === undefined ? {} : { nickname },
    ...uin === undefined ? {} : { uin },
    ...uid === undefined ? {} : { uid },
    ...enterpriseId === undefined ? {} : { enterpriseId },
    domain: typeof auth['domain'] === 'string' ? auth['domain'] : '',
    sourcePath,
  }
}

/**
 * Stable account id. `uin` is the billing identity the upstream keys on and
 * survives re-login; `uid` is the fallback.
 */
/**
 * True when `path` is the desktop app's live sign-in (as opposed to a backup
 * snapshot it left behind). The live file always wins: it is the session the
 * app itself is using.
 */
function isLiveAuthFile(path: string): boolean {
  return basename(path) === WORKBUDDY_LIVE_FILENAME
}

/**
 * True for a credential this plugin minted from the channel-pack sign-in flow.
 *
 * `packCredentialToWorkBuddy` stamps `channel-pack:<provider>:<ref>` here, so the
 * prefix is the only thing distinguishing a scanned credential from a file the
 * desktop app wrote. Nothing about it is a path on disk — there is no file to
 * stat and no mtime to read.
 */
function isChannelPackSource(path: string): boolean {
  return path.startsWith('channel-pack:')
}

/**
 * Which of two credentials for the same account the pool should keep.
 *
 * Ordering, highest first:
 *
 * 1. the live file the desktop app is signed in with;
 * 2. a credential minted by our own channel-pack sign-in;
 * 3. the credential the upstream issued most recently (`lastRefreshAtMs`);
 * 4. the longer stored expiry, as a fallback for documents that carry no issue
 *    time (the plugin's own refreshed copy, older builds).
 *
 * The stored expiry alone is NOT a freshness signal: the upstream does not
 * rewrite it when it revokes a token, so a long-dead backup can claim to expire
 * later than the token that actually works. Selecting on it made every upstream
 * call return 401 while a perfectly good credential sat in the same directory.
 *
 * Rank 2 exists because a scanned credential loses both of the lower tests by
 * construction: it is not the live filename, and the sign-in flow records no
 * `lastRefreshAtMs`. Ranking it below a leftover snapshot meant a user who had
 * just scanned a fresh sign-in still saw "sign-in was rejected", because the
 * abandoned file kept winning the comparison and the dead mark was never
 * cleared. The live file stays on top: that is the session the running desktop
 * app is genuinely using right now, and it is newer than anything we mint.
 */
export function compareFreshness(a: WorkBuddyCredential, b: WorkBuddyCredential): number {
  const rankOf = (credential: WorkBuddyCredential): number => {
    if (isLiveAuthFile(credential.sourcePath)) return 2
    if (isChannelPackSource(credential.sourcePath)) return 1
    return 0
  }
  const aRank = rankOf(a)
  const bRank = rankOf(b)
  if (aRank !== bRank) return bRank - aRank

  const aIssued = a.lastRefreshAtMs ?? 0
  const bIssued = b.lastRefreshAtMs ?? 0
  if (aIssued !== bIssued) return bIssued - aIssued

  return b.expiresAtMs - a.expiresAtMs
}

/** True when `candidate` should replace `incumbent` for the same account. */
export function isFresher(candidate: WorkBuddyCredential, incumbent: WorkBuddyCredential): boolean {
  return compareFreshness(candidate, incumbent) < 0
}

export function workbuddyAccountId(
  credential: Pick<WorkBuddyCredential, 'uin' | 'uid' | 'nickname'>,
): string {
  const stable = credential.uin ?? credential.uid ?? credential.nickname ?? 'unknown'
  return createHash('sha256').update(`workbuddy\0${stable}`).digest('hex').slice(0, 16)
}

/** Human label; distinguishes same-nickname accounts by uid prefix. */
export function accountLabel(credential: WorkBuddyCredential): string {
  const name = credential.nickname ?? 'WorkBuddy'
  const discriminator = (credential.uid ?? credential.uin ?? '').slice(0, 8)
  return discriminator === '' ? name : `${name}#${discriminator}`
}

/**
 * The pool id a document would receive, WITHOUT decrypting anything.
 *
 * Used to honour the ignore list before the at-rest key lookup runs: `uin` and
 * `uid` are read as plain strings by {@link parseWorkBuddyAuth}, while
 * `nickname` is commonly encrypted — so this returns undefined for an account
 * whose identity lives only in the encrypted nickname, and the caller falls
 * back to the full parse for those.
 */
export function cheapIdentityId(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  const identity =
    typeof document['account'] === 'object' && document['account'] !== null
      ? (document['account'] as Record<string, unknown>)
      : document
  const uin = typeof identity['uin'] === 'string' && identity['uin'] !== '' ? identity['uin'] : undefined
  const uid = typeof identity['uid'] === 'string' && identity['uid'] !== '' ? identity['uid'] : undefined
  if (uin === undefined && uid === undefined) return undefined
  // `workbuddyAccountId` reads `uin` first, exactly as the full parse does, so
  // this cheap id agrees with the id the account would really be filed under.
  return workbuddyAccountId({ ...uin === undefined ? {} : { uin }, ...uid === undefined ? {} : { uid } })
}

/**
 * How many conversation→account bindings `sticky` mode remembers.
 *
 * Only a memory bound: evicting the oldest binding costs one re-pick on that
 * conversation's next turn, it never loses an account or a request.
 */
export const STICKY_AFFINITY_LIMIT = 200

/**
 * Read-only pool of every discovered WorkBuddy account, with rate-limit
 * cooldown and round-robin failover.
 */
/** Idle bonus per hour an account has been unused (reference-panel default). */
const IDLE_WEIGHT_PER_HOUR = 0.5

/** Ceiling for the idle bonus, so an idle account cannot dominate forever. */
const IDLE_WEIGHT_MAX = 5

/**
 * Weight one account by how long it has been idle.
 *
 * The base of 1 keeps every eligible account in play: an account that served a
 * moment ago still has a small chance, so a single unhealthy account cannot pin
 * the pool to itself, and the weights never sum to zero.
 *
 * `lastUsedAt === undefined` means "never used in this process", which earns the
 * full bonus: on a fresh start every account ties, and the weighted draw spreads
 * the first requests instead of always picking the first entry.
 */
export function idleWeight(lastUsedAt: number | undefined, now: number): number {
  if (lastUsedAt === undefined) return 1 + IDLE_WEIGHT_MAX
  const hours = (now - lastUsedAt) / 3_600_000
  // A clock jump backwards would produce a negative idle term; clamp to 0.
  const idle = Math.min(Math.max(hours, 0) * IDLE_WEIGHT_PER_HOUR, IDLE_WEIGHT_MAX)
  return 1 + idle
}

/** Default rest for an account whose credits ran out (packs reset on their own schedule). */
export const EXHAUST_COOLDOWN_MS = 30 * 60 * 1000

/**
 * Default rest for an account the upstream rejected the sign-in of (401/403).
 *
 * Unlike a rate limit there is no reset time to read: only signing in again in
 * the desktop app revives the account. The rest is therefore long enough that a
 * single request never burns its whole retry budget on the same dead credential,
 * but short enough that a user who just signed in is not locked out of their own
 * account for long — and a newer credential file clears the mark outright.
 */
export const CREDENTIAL_DEAD_COOLDOWN_MS = 30 * 60 * 1000

/**
 * How long a credit-pack deadline reading stays trusted, in ms.
 *
 * The deadline is not a constant of the account: packs get spent, and the
 * "nearest expiry" moves to the next pack when the soonest one dies. A reading
 * is therefore a snapshot of the past, and `expiry` mode sorting on a stale one
 * spends the wrong account. An hour is short enough to track a normal day of
 * spending and long enough that the request path — which refreshes a balance at
 * most every ten minutes, and only for the accounts that actually serve — can
 * keep it current without a timer of its own.
 */
export const EXPIRY_READING_TTL_MS = 3_600_000

/**
 * Shortest gap between two attempts at the same account's deadline reading.
 *
 * Only failed attempts are actually throttled by this: a successful read stamps
 * the reading itself, so {@link EXPIRY_READING_TTL_MS} takes over from there.
 */
export const EXPIRY_WARM_RETRY_MS = 60_000

/**
 * Does this refresh failure prove the credential itself is dead?
 *
 * The upstream answers a revoked refresh token with `invalid_grant: Offline user
 * session not found` (HTTP 400/401). Network failures, DNS errors and 5xx do NOT
 * prove anything about the credential and must not mark it dead — that would
 * take a working account out of rotation for half an hour over a hiccup.
 */
export function isCredentialDeadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('invalid_grant')
    || message.includes('Offline user session not found')
    || message.includes('session_dead')
}
