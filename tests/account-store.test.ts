/**
 * Regression tests for "the pool forgets every account on restart".
 *
 * The reported symptom: switching sign-ins in the desktop app gathered several
 * accounts into the pool during one DSH session, but after a restart only the
 * currently signed-in account remained — and there was no way to get the others
 * back.
 *
 * Root cause: the desktop app keeps only the CURRENT sign-in's credential file
 * on disk (each login overwrites it), and the pool's `scan()` merged purely in
 * memory and never wrote anything down. Restart = whatever the disk holds, and
 * the disk only ever holds one account.
 *
 * The fix is a durable store (`account-store.ts`): `scan()` seeds its merge
 * from it on a cold pool and writes the merged list back. These tests pin the
 * three properties that make that fix real:
 *
 *   1. a fresh pool adopts the stored accounts (the restart case);
 *   2. a credential read from disk wins over a stored copy (disk is the truth);
 *   3. the store is written back on scan, atomically (no `.tmp` leftovers).
 *
 * A second regression is pinned here too: `import` used to write snapshots
 * that NO code path ever read (`lib/bin.js` wrote `<md5>.json` into
 * `~/.dsh/.xdpool/`, `scan()` never looked there). The snapshot directory is
 * now a scan source, and the plugin's own state files in it are excluded.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyAccountPool, workbuddyAccountId, type WorkBuddyAccount } from '../src/accounts.ts'
import { ACCOUNTS_FILE_NAME, accountStorePath, isStateFile, loadDeletedAccountIds, loadStoredAccounts, NON_SNAPSHOT_FILES, saveStoredAccounts, type StoredAccount } from '../src/account-store.ts'

// The write-back read verification is exercised by making the FINAL readFile
// (the one after rename, on the real store path) return tampered bytes.
// `node:fs/promises` is an ESM namespace and cannot be spied on, so the module
// is mocked as a passthrough that diverges only for the tampered path.
const tamper = vi.hoisted(() => {
  let target: string | null = null
  return {
    setTarget: (path: string | null) => { target = path },
    isTarget: (path: unknown) => typeof path === 'string' && path === target,
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (path: unknown, options: unknown) => {
      const text = await actual.readFile(path as never, options as never) as string
      if (tamper.isTarget(path)) return text.replace('"version": 1', '"version": 999')
      return text
    },
  }
})

/** A raw desktop auth document, the shape older desktop builds write. */
function plainCredential(name: string, token = `token-${name}`): string {
  return JSON.stringify({
    auth: {
      accessToken: token,
      refreshToken: `refresh-${name}`,
      expiresAt: Date.now() + 3_600_000,
      refreshExpiresAt: Date.now() + 86_400_000,
      domain: 'www.workbuddy.cn',
    },
    account: { uid: `uid-${name}`, uin: `uin-${name}`, nickname: name },
  })
}

/**
 * The PARSED credential shape `WorkBuddyCredential` uses — what the store
 * persists and what `isStoredAccount` validates against. NOT the raw desktop
 * document: the store round-trips the pool's normalized view, so a store entry
 * must look like the output of `readCredential`, not its input.
 */
function parsedCredential(name: string, token = `token-${name}`) {
  return {
    accessToken: token,
    refreshToken: `refresh-${name}`,
    expiresAtMs: Date.now() + 3_600_000,
    refreshExpiresAtMs: Date.now() + 86_400_000,
    nickname: name,
    uin: `uin-${name}`,
    uid: `uid-${name}`,
    domain: 'www.workbuddy.cn',
    sourcePath: `stored:${name}`,
  }
}

/** Temp home directory standing in for `~/.dsh`, restored after each test. */
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xdpool-store-'))
  process.env['DSH_HOME'] = dir
  return dir
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  delete process.env['DSH_HOME']
  tamper.setTarget(null)
  vi.restoreAllMocks()
})

describe('the durable account store', () => {
  it('seeds a fresh pool with accounts from a previous process', async () => {
    const home = tempHome()
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    // Simulate what the previous process wrote before exiting.
    const storeDir = join(home, '.xdpool')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, ACCOUNTS_FILE_NAME), JSON.stringify({
      version: 1,
      accounts: [{
        id: 'stored-id-1',
        label: 'Alice#abcd1234',
        credential: parsedCredential('alice'),
        savedAtMs: Date.now() - 1000,
      }],
    }))

    // An auth dir with a DIFFERENT account: the pool must end up with both.
    const authDir = mkdtempSync(join(tmpdir(), 'xdpool-auth-'))
    cleanups.push(() => rmSync(authDir, { recursive: true, force: true }))
    writeFileSync(join(authDir, 'workbuddy-desktop.info'), plainCredential('bob'))

    const accounts = await new WorkBuddyAccountPool({ authDirs: [authDir], persistent: true }).scan()
    const labels = accounts.map(account => account.label)
    expect(labels.some(label => label.includes('Alice'))).toBe(true)
    expect(labels.some(label => label.includes('bob'))).toBe(true)
  })

  it('prefers a credential freshly read from disk over the stored copy', async () => {
    const home = tempHome()
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    mkdirSync(join(home, '.xdpool'), { recursive: true })
    writeFileSync(join(home, '.xdpool', ACCOUNTS_FILE_NAME), JSON.stringify({
      version: 1,
      accounts: [{
        // Same billing identity as the on-disk account below, so the merge
        // actually has to choose — the point of this test. `id: undefined`
        // (as written before) is simply rejected by the store validator.
        id: workbuddyAccountId(parsedCredential('stale')),
        label: 'Stale',
        credential: parsedCredential('stale', 'stale-token'),
        savedAtMs: Date.now() - 1000,
      }],
    }))
    // Same account (same uin/uid → same pool id) with a NEWER token on disk.
    const authDir = mkdtempSync(join(tmpdir(), 'xdpool-auth-'))
    cleanups.push(() => rmSync(authDir, { recursive: true, force: true }))
    writeFileSync(join(authDir, 'workbuddy-desktop.info'), plainCredential('stale', 'fresh-token'))

    const accounts = await new WorkBuddyAccountPool({ authDirs: [authDir], persistent: true }).scan()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.credential.accessToken).toBe('fresh-token')
  })

  it('keeps stored accounts when this scan only finds SOME of them (#117)', async () => {
    // The defect: the store was only read when the in-memory list was EMPTY, so
    // the normal case — the desktop app keeps a single `.info`, the store holds
    // six accounts — skipped the read and then wrote the one-account list back
    // over all six. Reported loss: a 6-account pool silently dropped its
    // highest-balance account, and its credential was unrecoverable without a
    // fresh sign-in.
    const home = tempHome()
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    mkdirSync(join(home, '.xdpool'), { recursive: true })
    const stored = ['keep1', 'keep2', 'keep3'].map(name => ({
      id: workbuddyAccountId(parsedCredential(name)),
      label: name,
      credential: parsedCredential(name),
      savedAtMs: Date.now() - 1000,
    }))
    writeFileSync(join(home, '.xdpool', ACCOUNTS_FILE_NAME), JSON.stringify({ version: 1, accounts: stored }))

    // ONE auth file, so the scan finds one account and the store holds four.
    const authDir = mkdtempSync(join(tmpdir(), 'xdpool-auth-'))
    cleanups.push(() => rmSync(authDir, { recursive: true, force: true }))
    writeFileSync(join(authDir, 'workbuddy-desktop.info'), plainCredential('live'))

    const pool = new WorkBuddyAccountPool({ authDirs: [authDir], persistent: true })
    const first = await pool.scan()
    expect(first).toHaveLength(4)
    expect(first.map(a => a.label)).toEqual(expect.arrayContaining(['keep1', 'keep2', 'keep3']))

    // And the second scan must not drop them either: `this.accounts` is now
    // non-empty, which is exactly the state the old gate treated as "no need to
    // read the store".
    const second = await pool.scan()
    expect(second).toHaveLength(4)
    const storedAfter = JSON.parse(readFileSync(join(home, '.xdpool', ACCOUNTS_FILE_NAME), 'utf8')) as {
      accounts: { label: string }[]
    }
    expect(storedAfter.accounts).toHaveLength(4)
    // The live account's label carries a uid suffix, so match on the prefix.
    const storedLabels = storedAfter.accounts.map(a => a.label)
    for (const name of ['keep1', 'keep2', 'keep3']) {
      expect(storedLabels.some(label => label.startsWith(name))).toBe(true)
    }
    expect(storedLabels.some(label => label.startsWith('live'))).toBe(true)
  })

  it('reports which accounts a rescan dropped instead of deleting them silently', async () => {
    // The store holds complete credentials, so a shrink is unrecoverable. It is
    // still allowed (the user may have deleted an account), but it has to be
    // SAID — a card list that quietly loses an account is the report in #117.
    const home = tempHome()
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    mkdirSync(join(home, '.xdpool'), { recursive: true })
    const gone = {
      id: workbuddyAccountId(parsedCredential('gone')),
      label: 'gone',
      credential: parsedCredential('gone'),
      savedAtMs: Date.now() - 1000,
    }
    writeFileSync(join(home, '.xdpool', ACCOUNTS_FILE_NAME), JSON.stringify({ version: 1, accounts: [gone] }))

    const authDir = mkdtempSync(join(tmpdir(), 'xdpool-auth-'))
    cleanups.push(() => rmSync(authDir, { recursive: true, force: true }))
    writeFileSync(join(authDir, 'workbuddy-desktop.info'), plainCredential('live'))

    const warnings: string[] = []
    const pool = new WorkBuddyAccountPool({
      authDirs: [authDir],
      persistent: true,
      logger: { warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) } },
    })
    await pool.scan()
    // Both are present on the first scan, so nothing has left yet.
    expect(warnings.filter(line => line.includes('no longer in the pool'))).toHaveLength(0)

    // Mark the stored account ignored, which is how an account legitimately
    // leaves the pool, and rescan.
    pool.applyIgnored([gone.id])
    await pool.scan()
    const reported = warnings.filter(line => line.includes('no longer in the pool'))
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain(gone.id)
  })

  it('writes the merged list back atomically after every scan', async () => {
    const home = tempHome()
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const authDir = mkdtempSync(join(tmpdir(), 'xdpool-auth-'))
    cleanups.push(() => rmSync(authDir, { recursive: true, force: true }))
    writeFileSync(join(authDir, 'workbuddy-desktop.info'), plainCredential('carol'))

    const storePath = accountStorePath()
    expect(existsSync(storePath)).toBe(false)
    await new WorkBuddyAccountPool({ authDirs: [authDir], persistent: true }).scan()
    expect(existsSync(storePath)).toBe(true)
    expect(existsSync(`${storePath}.tmp`)).toBe(false)
    const round = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(storePath, 'utf8')))
    expect(round.accounts).toHaveLength(1)
    expect(round.accounts[0].credential.accessToken).toBe('token-carol')
  })

  it('a corrupt store yields an empty seed, not a broken pool', async () => {
    const home = tempHome()
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    mkdirSync(join(home, '.xdpool'), { recursive: true })
    writeFileSync(join(home, '.xdpool', ACCOUNTS_FILE_NAME), '{ truncated')
    const authDir = mkdtempSync(join(tmpdir(), 'xdpool-auth-'))
    cleanups.push(() => rmSync(authDir, { recursive: true, force: true }))
    writeFileSync(join(authDir, 'workbuddy-desktop.info'), plainCredential('dave'))

    const accounts = await new WorkBuddyAccountPool({ authDirs: [authDir], persistent: true }).scan()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.label).toContain('dave')
  })

  it('never re-reads its own state files as credentials', async () => {
    const home = tempHome()
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    // Every state file the plugin keeps next to the snapshots — if any of them
    // were parsed as a credential, the pool would grow phantom accounts.
    const stateDir = join(home, '.xdpool')
    mkdirSync(stateDir, { recursive: true })
    for (const name of NON_SNAPSHOT_FILES) {
      writeFileSync(join(stateDir, name), JSON.stringify({
        auth: { accessToken: `phantom-${name}`, refreshToken: 'x', expiresAt: Date.now() + 3_600_000, domain: 'www.workbuddy.cn' },
        account: { uid: `phantom-${name}`, uin: `phantom-${name}`, nickname: 'phantom' },
      }))
    }
    const accounts = await new WorkBuddyAccountPool({ authDirs: [], persistent: true }).scan()
    expect(accounts).toHaveLength(0)
  })

  it('isStateFile recognises exactly the plugin bookkeeping', () => {
    expect(isStateFile(ACCOUNTS_FILE_NAME)).toBe(true)
    expect(isStateFile('ignored.json')).toBe(true)
    expect(isStateFile('preferred.json')).toBe(true)
    expect(isStateFile('abcd1234.info')).toBe(false)
  })

  it('throws and preserves the old generation when the write-back read disagrees', async () => {
    const home = tempHome()
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const storePath = join(home, '.xdpool', ACCOUNTS_FILE_NAME)
    mkdirSync(join(home, '.xdpool'), { recursive: true })

    // A "previous generation" on disk so its survival (via .bak) is observable.
    const previous = JSON.stringify({ version: 1, accounts: [], deleted: [] }, null, 2) + '\n'
    writeFileSync(storePath, previous)

    const account: WorkBuddyAccount = {
      id: workbuddyAccountId(parsedCredential('alice')),
      label: 'alice',
      credential: parsedCredential('alice'),
      cooldownUntilMs: 0,
      modelCooldowns: {},
      rateLimitHits: 0,
    }

    // Tamper with the FINAL read-back (after rename) so the bytes "landed" on
    // disk disagree with what writeSecretFile proved — the exact failure the
    // verification is there to catch. The tmp-file read inside writeSecretFile
    // still passes, so only the post-rename check trips.
    tamper.setTarget(storePath)

    await expect(saveStoredAccounts(storePath, [account], [])).rejects.toThrow(/write-verification failed/)

    // The caller's in-memory list keeps its value — the write must not look
    // successful, so the pool never drops the account it believes it saved.
    expect(account.label).toBe('alice')
    expect(account.credential.accessToken).toBe('token-alice')

    // The old generation survives in .bak, copied before the rename.
    expect(readFileSync(`${storePath}.bak`, 'utf8')).toBe(previous)
  })

  it('recovers accounts from the .bak backup when the main file is corrupt', async () => {
    const home = tempHome()
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const storePath = join(home, '.xdpool', ACCOUNTS_FILE_NAME)
    mkdirSync(join(home, '.xdpool'), { recursive: true })

    const stored = {
      id: 'stored-id-1',
      label: 'Alice#abcd1234',
      credential: parsedCredential('alice'),
      savedAtMs: Date.now() - 1000,
    }
    writeFileSync(`${storePath}.bak`, JSON.stringify({ version: 1, accounts: [stored] }))
    writeFileSync(storePath, '{ truncated')

    const loaded = await loadStoredAccounts(storePath)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.id).toBe('stored-id-1')
    expect(loaded[0]?.label).toBe('Alice#abcd1234')
    expect(loaded[0]?.credential.accessToken).toBe('token-alice')
  })

  it('reads an old plaintext document lacking the optional bookkeeping fields', async () => {
    const home = tempHome()
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const storePath = join(home, '.xdpool', ACCOUNTS_FILE_NAME)
    mkdirSync(join(home, '.xdpool'), { recursive: true })

    const stored = {
      id: 'legacy-id-1',
      label: 'Legacy#123',
      credential: parsedCredential('legacy'),
      savedAtMs: Date.now() - 1000,
    }
    const doc = JSON.stringify({ version: 1, accounts: [stored] })
    writeFileSync(storePath, doc)

    const loaded = await loadStoredAccounts(storePath)
    expect(loaded).toHaveLength(1)
    const entry = loaded[0] as StoredAccount
    // Every optional field defaults to absent on an older plaintext document.
    expect(entry.note).toBeUndefined()
    expect(entry.group).toBeUndefined()
    expect(entry.tags).toBeUndefined()
    expect(entry.expiryAtMs).toBeUndefined()
    expect(entry.usageCount).toBeUndefined()
    expect(entry.health).toBeUndefined()
    // Identity survives intact, and the top-level document is untouched by the
    // read (loadStoredAccounts is read-only).
    expect(entry.id).toBe('legacy-id-1')
    expect(entry.label).toBe('Legacy#123')
    expect(entry.credential.accessToken).toBe('token-legacy')
    expect(readFileSync(storePath, 'utf8')).toBe(doc)
  })

  it('recovers both accounts and tombstones from .bak when the main file is corrupt', async () => {
    // P1 regression: the `.bak` recovery path used to restore accounts but drop
    // the tombstone list, because the deleted ids were read from the (corrupt)
    // main file alone. A soft-deleted account then resurrected on the recovery
    // scan and was written back with `deleted: []`, losing the tombstone for
    // good. Both must come from the SAME recovered document.
    const home = tempHome()
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const storePath = join(home, '.xdpool', ACCOUNTS_FILE_NAME)
    mkdirSync(join(home, '.xdpool'), { recursive: true })

    const kept = {
      id: workbuddyAccountId(parsedCredential('kept')),
      label: 'kept',
      credential: parsedCredential('kept'),
      savedAtMs: Date.now() - 1000,
    }
    const deleted = {
      id: workbuddyAccountId(parsedCredential('deleted')),
      label: 'deleted',
      credential: parsedCredential('deleted'),
      savedAtMs: Date.now() - 1000,
    }
    // The .bak holds the last good generation: both accounts AND the tombstone.
    writeFileSync(`${storePath}.bak`, JSON.stringify({
      version: 1,
      accounts: [kept, deleted],
      deleted: [deleted.id],
    }))
    // The main file is corrupt.
    writeFileSync(storePath, '{ truncated')

    // The tombstone read must follow the same .bak fallback as the accounts read.
    const deletedIds = await loadDeletedAccountIds(storePath)
    expect(deletedIds).toEqual([deleted.id])

    // And end-to-end: the soft-deleted account must NOT be resurrected by scan.
    const authDir = mkdtempSync(join(tmpdir(), 'xdpool-auth-'))
    cleanups.push(() => rmSync(authDir, { recursive: true, force: true }))
    // The deleted account still has an on-disk credential, so without the
    // recovered tombstone it would be re-seeded.
    writeFileSync(join(authDir, 'workbuddy-desktop.info'), plainCredential('deleted'))

    const pool = new WorkBuddyAccountPool({ authDirs: [authDir], persistent: true })
    const accounts = await pool.scan()
    const labels = accounts.map(a => a.label)
    expect(labels.some(label => label.startsWith('kept'))).toBe(true)
    expect(labels.some(label => label.startsWith('deleted'))).toBe(false)

    // The tombstone must survive the write-back too, not be flattened to [].
    const after = JSON.parse(readFileSync(storePath, 'utf8')) as { deleted: string[] }
    expect(after.deleted).toEqual([deleted.id])
  })
})
