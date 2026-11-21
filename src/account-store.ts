/**
 * Durable copy of the discovered accounts, inside the plugin's data directory.
 *
 * The pool's account list is otherwise pure memory: the desktop app keeps only
 * the CURRENT sign-in on disk (each login overwrites the one auth file), so
 * accounts gathered by switching sign-ins evaporated on every restart. This
 * store is the fix — `scan()` seeds from it and writes the merged list back, so
 * the pool now survives restarts.
 *
 * JSON only, atomic rename on write: a crash mid-write leaves the previous
 * generation intact, and the pool never reads a half-written account again.
 *
 * ## Persistence robustness (A3)
 *
 * A durable credential store has two failure modes that read very differently
 * to a user: the write can be silently lost, and the read can silently return
 * nothing. Both were possible before:
 *
 *   - `saveStoredAccounts` wrote `${path}.tmp` then renamed it, but never
 *     confirmed the bytes landed, so a filesystem that dropped the write (or a
 *     rename that left the destination stale) read as a successful save;
 *   - `loadStoredAccounts` returned `[]` on ANY malformed file, and `scan()`
 *     then re-pulled from the auth dir and overwrote the store — permanently
 *     losing every account that had no fresh `.info` on disk (the exact #117
 *     damage mode, now with the whole pool at risk instead of one file).
 *
 * The fixes here, in order:
 *
 *   1. **Write-then-read-back** — `writeSecretFile` already verifies the temp
 *      file before it is renamed; the main path now ALSO re-reads the final
 *      file after the rename and refuses to report success unless the bytes
 *      match. On mismatch the error propagates and the caller keeps its
 *      in-memory list (and the previous file generation, untouched below).
 *   2. **`.bak` backup** — before the temp file is renamed over the target, the
 *      current target is copied to `${path}.bak`. A failed or interrupted write
 *      therefore never destroys the last good generation.
 *   3. **Write mutex** — concurrent writes within one process are serialized
 *      through a promise chain, so two scans racing to persist cannot interleave
 *      their temp/rename steps (which would let a stale list win).
 *   4. **`.bak` recovery first** — a corrupt main file now tries the backup
 *      BEFORE giving up. Only when both are unreadable does the store yield
 *      `[]` (with a warning naming the file), instead of silently rediscovering
 *      and erasing credentials.
 *
 * All of this is tolerant rather than throwing to the pool: a store that cannot
 * be read still degrades to "rediscover from the auth dir", but it says so, and
 * it no longer destroys the one durable copy of the other accounts on the way.
 *
 * @module dsh-xdpool/account-store
 */

import { copyFile, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkBuddyAccount, WorkBuddyCredential } from './accounts.ts'
import { ensureSecretDir, writeSecretFile } from './file-perms.ts'
import { PLUGIN_DATA_DIR_NAME, dshHome } from './ignored.ts'

/** File name of the durable account list, inside the plugin data directory. */
export const ACCOUNTS_FILE_NAME = 'accounts.json'

/**
 * State files that live in the same directory but are NOT account snapshots.
 *
 * The snapshot importer (`dsh-xdpool import <key>`) writes `<md5prefix>.json`
 * into this directory, and the pool scans it — so every other `.json` file here
 * is treated as an imported snapshot. These three are the plugin's own
 * bookkeeping and must never be parsed as credentials.
 */
export const NON_SNAPSHOT_FILES = [ACCOUNTS_FILE_NAME, 'ignored.json', 'preferred.json'] as const

/** One durably stored account: identity plus the credential that worked. */
export interface StoredAccount {
  id: string
  label: string
  credential: WorkBuddyCredential
  savedAtMs: number
  /**
   * Optional pool bookkeeping, all absent on older plaintext documents.
   *
   * These are the fields a complete account pool wants (A2): a free-form note,
   * a grouping bucket, tags, a hard expiry override, a usage counter, and a
   * coarse health label. Every one is OPTIONAL and defaults to absent on read,
   * so a document written by an older build — or a hand-edited plaintext
   * `accounts.json` — still parses and still round-trips without any of them.
   */
  note?: string
  group?: string
  tags?: string[]
  expiryAtMs?: number
  usageCount?: number
  health?: string
}

/** Absolute path of the durable account list. */
export function accountStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), PLUGIN_DATA_DIR_NAME, ACCOUNTS_FILE_NAME)
}

/** The directory the pool scans for imported `<md5prefix>.json` snapshots. */
export function snapshotDirPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), PLUGIN_DATA_DIR_NAME)
}

/**
 * True when a file name in the snapshot directory is plugin bookkeeping rather
 * than an imported snapshot.
 */
export function isStateFile(name: string): boolean {
  return (NON_SNAPSHOT_FILES as readonly string[]).includes(name)
}

/** True when a value has the shape of a stored account. */
function isStoredAccount(value: unknown): value is StoredAccount {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const credential = record['credential']
  // Only the identity fields are required. The optional bookkeeping fields
  // (note/group/tags/…) are accepted as-is when present and defaulted away when
  // absent, so a plaintext document from an older build still validates.
  return typeof record['id'] === 'string'
    && typeof record['label'] === 'string'
    && typeof credential === 'object' && credential !== null
    && typeof (credential as Record<string, unknown>)['accessToken'] === 'string'
    && typeof (credential as Record<string, unknown>)['refreshToken'] === 'string'
}

/**
 * Short, log-safe error summary.
 *
 * `JSON.parse` throws a `SyntaxError` whose V8 message embeds a raw fragment of
 * the offending text — this store carries `accessToken`, so that fragment must
 * never reach a log line. A `SyntaxError` is reduced to its name plus, when
 * present, the byte position; the message is dropped entirely. Other errors keep
 * their own short message.
 */
function errorSummary(error: unknown): string {
  if (error instanceof SyntaxError) {
    const position = /position (\d+)/i.exec(error.message)
    return position ? `SyntaxError at position ${position[1]}` : 'SyntaxError'
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 80)
}

/** The document shape on disk, tolerant of an absent `deleted` field. */
interface StoreDocument {
  version?: unknown
  accounts?: unknown
  deleted?: unknown
}

/**
 * Parse the entries out of one store file's text.
 *
 * Returns `undefined` when the file cannot be read at all (the caller treats
 * that as "try the next source"), and `[]` when it is read but empty/valid.
 * Logs a warning for a file that exists but is malformed, so a corruption is
 * never silent; an absent file (first run) is not an error.
 */
/** One parsed store document: its accounts plus its tombstone ids. */
interface ParsedStore {
  accounts: StoredAccount[]
  deleted: string[]
}

/**
 * Parse one store file's text into accounts and tombstones together.
 *
 * Returns `undefined` when the file cannot be read at all (the caller treats
 * that as "try the next source"). A file that exists but is malformed logs a
 * warning so a corruption is never silent; an absent file (first run) is not an
 * error. The `deleted` field is optional and defaults to `[]` on old plaintext
 * documents.
 */
function parseStoreDocument(text: string, path: string): ParsedStore | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    console.warn(`dsh-xdpool: account store ${path} is not parseable JSON: ${errorSummary(error)}`)
    return undefined
  }
  const doc = parsed as StoreDocument | null
  const entries = doc?.['accounts']
  if (!Array.isArray(entries)) {
    console.warn(`dsh-xdpool: account store ${path} has no "accounts" array`)
    return undefined
  }
  const accounts: StoredAccount[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!isStoredAccount(entry)) continue
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    accounts.push(entry)
  }
  const deletedRaw = doc?.['deleted']
  const deleted = Array.isArray(deletedRaw)
    ? deletedRaw.filter((id): id is string => typeof id === 'string')
    : []
  return { accounts, deleted }
}

/** Read one file into a parsed store; `undefined` when unreadable or malformed. */
async function readStoreFile(path: string): Promise<ParsedStore | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    // Absent (first run) or unreadable — not distinguishable cheaply, and both
    // mean "nothing to seed from here"; the recovery step logs what matters.
    return undefined
  }
  return parseStoreDocument(text, path)
}

/**
 * Read the durable list. Tolerant on purpose: a malformed or half-written file
 * first tries its `.bak` backup, and only when BOTH are unreadable yields `[]`
 * and lets the pool rediscover from disk — with a warning, never silently.
 */
export async function loadStoredAccounts(path: string): Promise<StoredAccount[]> {
  return (await loadStore(path)).accounts
}

/**
 * Read the durable list and its tombstone ids in ONE file read.
 *
 * This is the single-read entry point: accounts and deleted ids come from the
 * SAME parsed document, so they can never be observed from two different file
 * states (the TOCTOU that two separate `readFile`s would allow). The main file
 * is tried first; on parse failure it falls back to `.bak`, which — because it
 * is a write-before-copy of the main file — carries both `accounts` and
 * `deleted` from the same prior generation. Only when both are unreadable does
 * it yield empty (with a warning, never silently).
 */
export async function loadStore(
  path: string,
): Promise<{ accounts: StoredAccount[]; deleted: readonly string[] }> {
  const main = await readStoreFile(path)
  if (main !== undefined) return { accounts: main.accounts, deleted: main.deleted }
  const backup = await readStoreFile(`${path}.bak`)
  if (backup !== undefined) {
    console.warn(
      `dsh-xdpool: account store ${path} is unreadable; recovered ${backup.accounts.length} account(s) and ${backup.deleted.length} deleted id(s) from ${path}.bak`,
    )
    return { accounts: backup.accounts, deleted: backup.deleted }
  }
  console.warn(`dsh-xdpool: account store ${path} is unreadable and no .bak exists; starting empty (pool will rediscover)`)
  return { accounts: [], deleted: [] }
}

/**
 * Account ids the user explicitly deleted, persisted alongside the accounts.
 *
 * A soft-deleted account must STAY deleted across restarts — otherwise the next
 * `scan()` re-discovers its auth file or pack credential and resurrects it. The
 * tombstone list lives in the same document as `accounts` so the two cannot
 * drift apart, and is optional so old plaintext documents (no `deleted` field)
 * read as "nothing deleted".
 */
export async function loadDeletedAccountIds(path: string): Promise<readonly string[]> {
  const store = await loadStore(path)
  return store.deleted
}

/**
 * Serialize concurrent writes within one process.
 *
 * Two scans firing close together (a login and a card refresh) each call
 * `saveStoredAccounts`; without this, their `writeSecretFile(tmp)` + `rename`
 * steps could interleave and a stale list could win the rename. The chain is
 * simple on purpose — a queue of one — because the writers are rare and the
 * cost of a lost write is an account, not just a log line.
 */
let writeChain: Promise<void> = Promise.resolve()

/** Map a pool account onto its durable form, carrying optional bookkeeping. */
function toStored(account: WorkBuddyAccount): StoredAccount {
  const stored: StoredAccount = {
    id: account.id,
    label: account.label,
    credential: account.credential,
    savedAtMs: Date.now(),
  }
  if (account.note !== undefined) stored.note = account.note
  if (account.group !== undefined) stored.group = account.group
  if (account.tags !== undefined) stored.tags = account.tags
  if (account.expiryAtMs !== undefined) stored.expiryAtMs = account.expiryAtMs
  if (account.usageCount !== undefined) stored.usageCount = account.usageCount
  if (account.health !== undefined) stored.health = account.health
  return stored
}

/**
 * Atomically write the durable list: `${path}.tmp` first (with write-then-
 * read-back verification inside `writeSecretFile`), then rename. A crash
 * mid-write leaves the previous generation intact, and that previous generation
 * is also copied to `${path}.bak` before the rename so the last good state
 * survives a bad write.
 */
export async function saveStoredAccounts(
  path: string,
  accounts: readonly WorkBuddyAccount[],
  deletedIds: readonly string[] = [],
): Promise<void> {
  const run = writeChain.then(() => writeStore(path, accounts, deletedIds))
  // Keep the chain alive even after a failure so the next writer is not stuck
  // behind a rejected promise.
  writeChain = run.catch(() => undefined)
  return run
}

/** The serialized write body: backups, writes, renames, verifies. */
async function writeStore(
  path: string,
  accounts: readonly WorkBuddyAccount[],
  deletedIds: readonly string[],
): Promise<void> {
  const stored: StoredAccount[] = accounts.map(toStored)
  const document = JSON.stringify(
    { version: 1, accounts: stored, deleted: [...new Set(deletedIds)] },
    null,
    2,
  ) + '\n'
  // Owner-only: this file carries `accessToken` / `refreshToken` verbatim, and a
  // plain writeFile leaves it at the process umask (typically 0644, readable by
  // every other user on the host). The mode is applied when the TEMP file is
  // created, so the rename carries it to the destination — no window where the
  // real path exists with the old permissions.
  await ensureSecretDir(join(path, '..'))
  const tmp = `${path}.tmp`
  // Back up the current generation before replacing it. `copyFile` preserves the
  // source mode (owner-only, established on every prior write), so the backup is
  // as private as the file it mirrors. On a first-ever write there is nothing to
  // back up, and a missing source is not an error.
  try {
    await copyFile(path, `${path}.bak`)
  } catch {
    // No previous generation (first run) or an unreadable target — nothing to
    // preserve, and a failed backup must not block the write itself.
  }
  await writeSecretFile(tmp, document)
  await rename(tmp, path)
  // Verify the FINAL file, not just the temp: this is the write-then-read-back
  // on the main path. `writeSecretFile` proved the temp bytes; this proves the
  // rename landed them. On mismatch the caller keeps its in-memory list and the
  // previous generation (still on disk, and in `.bak`) is untouched.
  const onDisk = await readFile(path, 'utf8')
  if (onDisk !== document) {
    throw new Error(`dsh-xdpool: write-verification failed for ${path}: final file differs after rename`)
  }
}
