/**
 * Installing a newer build of this plugin.
 *
 * HOW THE HOST UPDATES A PLUGIN
 *
 * There is no install API to call. A profile's `package.json` names each plugin by a spec, and
 * the host resolves that spec when it starts — so "update" means "change the spec, then restart".
 * That is the whole mechanism, and it is what every plugin that self-updates is really doing.
 *
 * WHAT THIS DOES
 *
 * A newer version is downloaded from the npm registry to a local file, and the profile's
 * dependency is pointed at it with a `file:` spec. On the next start the host installs from that
 * file. Nothing is written outside the profile's own directory, and nothing is changed if the
 * download fails — a half-applied update is worse than an unapplied one.
 *
 * WHY `file:` AND NOT THE PUBLISHED VERSION
 *
 * Naming the version (`"dsh-xdpool": "2.7.5"`) makes the host fetch from the registry on every
 * start, which fails on a machine whose registry is proxied or slow — and the failure mode is a
 * plugin that does not load. Pinning the tarball that was just verified to download keeps the
 * update as local as the install it replaces.
 *
 * A RESTART IS REQUIRED, AND SAYS SO
 *
 * Modules already loaded cannot be swapped in place. The panel reports `restartRequired` and the
 * user restarts when convenient — claiming the update took effect immediately would be a lie the
 * user discovers on the next crash.
 *
 * @module dsh-xdpool/update-install
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkForUpdate } from './update-check.ts'

/** The package this plugin publishes under. */
const PACKAGE = 'dsh-xdpool'

/** The profile directory whose `package.json` names this plugin. */
function profileDir(): string | undefined {
  // The host sets this for plugins it loaded from a profile; the environment is the only way a
  // plugin can learn where its own spec lives.
  const candidates = [
    process.env['DSH_PROFILE_DIR'],
    process.env['DSH_HOME'] === undefined ? undefined : join(process.env['DSH_HOME'], 'profiles', 'desktop'),
    join(homedir(), '.dsh', 'profiles', 'desktop'),
  ]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** What an install attempt produced. */
export interface InstallResult {
  ok: boolean
  /** The version written into the profile, when it landed. */
  version?: string
  /** Where the tarball was saved. */
  path?: string
  /** Whether a restart is needed for it to take effect. */
  restartRequired: boolean
  /** Why it did not land. */
  error?: string
}

/**
 * Write `package.json` with a backup so a half-written file can be rolled back.
 *
 * The profile's `package.json` is the host's one source of truth for what to load on
 * startup. A crash between `writeFileSync` and the OS flushing the page would leave a
 * truncated JSON file and, on the next start, a plugin that does not load — with no
 * automatic repair. So the original is copied to `<path>.bak` first, and on any write
 * error the original is written back. The backup is removed when the write lands (or
 * when the restore lands), so a leftover `.bak` is itself a signal that neither
 * succeeded and manual recovery is possible.
 *
 * This is extracted from `installVersion` so the recovery path is testable without
 * touching the registry or the real profile.
 */
/** The filesystem calls `writePackageJsonAtomic` needs, injectable for testing. */
export interface AtomicWriteFs {
  readFileSync: typeof readFileSync
  writeFileSync: typeof writeFileSync
  rmSync: typeof rmSync
}

const defaultFs: AtomicWriteFs = { readFileSync, writeFileSync, rmSync }

export function writePackageJsonAtomic(pkgPath: string, content: string, fs: AtomicWriteFs = defaultFs): void {
  const backupPath = `${pkgPath}.bak`
  // The caller has already read this file, so it exists; if it does not, there is
  // nothing to back up and nothing to safely overwrite — fail loudly instead of
  // fabricating a backup.
  const original = fs.readFileSync(pkgPath, 'utf8')
  fs.writeFileSync(backupPath, original, 'utf8')
  try {
    fs.writeFileSync(pkgPath, content, 'utf8')
  } catch (error) {
    // Put the working file back. If even that fails, leave the `.bak` in place so
    // the user still has the last known-good content rather than a truncated file.
    try {
      fs.writeFileSync(pkgPath, original, 'utf8')
      fs.rmSync(backupPath, { force: true })
    } catch {
      // Restore failed: the backup stays for manual recovery.
    }
    throw error
  }
  fs.rmSync(backupPath, { force: true })
}

/**
 * Download a version and point the profile at it.
 *
 * The order matters: download first, verify it is a gzip tarball, and only then touch
 * `package.json`. A failed download must leave a working install alone.
 */
export async function installVersion(version: string): Promise<InstallResult> {
  const profile = profileDir()
  if (profile === undefined) {
    return {
      ok: false,
      restartRequired: false,
      error: '找不到插件所在的 profile 目录，无法自动更新；请在 DSH 的插件设置里更新',
    }
  }
  const target = join(tmpdir(), `${PACKAGE}-${version}.tgz`)
  try {
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE}-${version}.tgz`, {
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok || response.body === null) {
      return { ok: false, restartRequired: false, error: `下载失败：HTTP ${String(response.status)}` }
    }
    mkdirSync(dirname(target), { recursive: true })
    const partial = `${target}.part`
    const sink = createWriteStream(partial)
    // Streamed rather than buffered: the package is a few megabytes and there is no reason to
    // hold all of it to write it back out.
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      sink.write(chunk)
    }
    await new Promise<void>((resolve, reject) => {
      sink.end(() => { resolve() })
      sink.on('error', reject)
    })
    // A gzip member starts with 1f 8b. Checking here is what keeps a proxy's HTML error page
    // from being installed as a plugin.
    const head = readFileSync(partial).subarray(0, 2)
    if (head[0] !== 0x1f || head[1] !== 0x8b) {
      rmSync(partial, { force: true })
      return { ok: false, restartRequired: false, error: '下载到的不是压缩包（可能被代理拦截）' }
    }
    renameSync(partial, target)
  } catch (error: unknown) {
    return {
      ok: false,
      restartRequired: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  try {
    const pkgPath = join(profile, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    let changed = false
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const block = pkg[key]
      if (block === null || typeof block !== 'object') continue
      const record = block as Record<string, unknown>
      if (!Object.hasOwn(record, PACKAGE)) continue
      record[PACKAGE] = `file:${target.replaceAll('\\', '/')}`
      changed = true
    }
    if (!changed) {
      return {
        ok: false,
        restartRequired: false,
        path: target,
        error: `profile 的 package.json 里没有 ${PACKAGE}，无法自动更新`,
      }
    }
    writePackageJsonAtomic(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    return { ok: true, version, path: target, restartRequired: true }
  } catch (error: unknown) {
    return {
      ok: false,
      restartRequired: false,
      path: target,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Check, then install if there is something newer.
 *
 * Kept together so the route cannot install a version the check never saw — the alternative is a
 * caller passing an arbitrary version string to an endpoint that writes `package.json`.
 */
export async function updateToLatest(): Promise<InstallResult> {
  const status = await checkForUpdate({ force: true })
  if (status.error !== undefined) return { ok: false, restartRequired: false, error: status.error }
  if (status.latest === undefined) return { ok: false, restartRequired: false, error: '没有读到最新版本号' }
  if (!status.newer) {
    return { ok: true, version: status.current, restartRequired: false }
  }
  return await installVersion(status.latest)
}
