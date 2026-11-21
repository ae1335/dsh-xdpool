/**
 * The profile's `package.json` is the host's load manifest. `installVersion` rewrites it
 * to point the dependency at a downloaded tarball, and a truncated write there would make
 * the plugin fail to load on the next start with no automatic repair.
 *
 * `writePackageJsonAtomic` is the extracted guard: it copies the original to `.bak`,
 * writes the new content, and removes the backup on success. On a write failure it writes
 * the original back and rethrows. These tests pin that contract on a real temp directory,
 * injecting the filesystem calls so the failure paths are exercised deterministically.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePackageJsonAtomic, type AtomicWriteFs } from '../src/update-install.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'xdpool-update-'))
}

const realFs: AtomicWriteFs = { readFileSync, writeFileSync, rmSync }

describe('writePackageJsonAtomic', () => {
  it('replaces the file and removes the backup on success', () => {
    const dir = tempDir()
    try {
      const pkgPath = join(dir, 'package.json')
      writeFileSync(pkgPath, '{"dependencies":{"dsh-xdpool":"2.7.4"}}\n', 'utf8')
      writePackageJsonAtomic(pkgPath, '{"dependencies":{"dsh-xdpool":"file:/tmp/x.tgz"}}\n', realFs)
      expect(readFileSync(pkgPath, 'utf8')).toBe('{"dependencies":{"dsh-xdpool":"file:/tmp/x.tgz"}}\n')
      expect(existsSync(`${pkgPath}.bak`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restores the original and rethrows when the write fails', () => {
    const dir = tempDir()
    try {
      const pkgPath = join(dir, 'package.json')
      const original = '{"dependencies":{"dsh-xdpool":"2.7.4"}}\n'
      writeFileSync(pkgPath, original, 'utf8')

      // Fail only the new-content write (the second call); the backup write and the
      // restore write go through, so the guard proves it can recover.
      let calls = 0
      const failingFs: AtomicWriteFs = {
        ...realFs,
        writeFileSync: (path, data, ...rest) => {
          calls += 1
          if (calls === 2) throw new Error('simulated partial write')
          return writeFileSync(path, data, ...rest)
        },
      }

      expect(() => writePackageJsonAtomic(pkgPath, 'NEW\n', failingFs)).toThrow('simulated partial write')
      expect(readFileSync(pkgPath, 'utf8')).toBe(original)
      expect(existsSync(`${pkgPath}.bak`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves the backup when neither write nor restore can land', () => {
    const dir = tempDir()
    try {
      const pkgPath = join(dir, 'package.json')
      const original = '{"dependencies":{"dsh-xdpool":"2.7.4"}}\n'
      writeFileSync(pkgPath, original, 'utf8')

      // The new-content write fails AND the restore write fails, so the only surviving
      // artifact is the `.bak` — the signal for manual recovery.
      let calls = 0
      const alwaysFailsAfterBackup: AtomicWriteFs = {
        ...realFs,
        writeFileSync: (path, data, ...rest) => {
          calls += 1
          if (calls >= 2) throw new Error('simulated write failure')
          return writeFileSync(path, data, ...rest)
        },
      }

      expect(() => writePackageJsonAtomic(pkgPath, 'NEW\n', alwaysFailsAfterBackup)).toThrow(
        'simulated write failure',
      )
      expect(existsSync(`${pkgPath}.bak`)).toBe(true)
      expect(readFileSync(`${pkgPath}.bak`, 'utf8')).toBe(original)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails loudly when the original does not exist', () => {
    const dir = tempDir()
    try {
      const pkgPath = join(dir, 'missing.json')
      expect(() => writePackageJsonAtomic(pkgPath, 'NEW\n', realFs)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
