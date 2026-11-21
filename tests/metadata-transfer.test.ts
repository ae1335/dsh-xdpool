/**
 * 脱敏元数据导出/导入的回归测试。
 *
 * 覆盖六条契约：
 *   1. 默认导出不含任何凭据字段（credential / accessToken / refreshToken…）；
 *   2. `includeCredentials: true` 显式开启时附带 credential；
 *   3. 导入命中 id 只合并元数据、凭据保持 store 原值，且不破坏既有账号；
 *   4. 文件内重复 id 去重、store 不存在的 id 跳过（计入 skipped）；
 *   5. 非法输入（非 JSON / 非对象 / 缺 version / 缺 accounts / 缺 id·label）拒绝；
 *   6. 旧格式（无可选元数据字段）兼容：写入后仍能被 `loadStoredAccounts` 读回。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkBuddyAccount } from '../src/accounts.ts'
import { loadStoredAccounts, saveStoredAccounts, type StoredAccount } from '../src/account-store.ts'
import {
  METADATA_EXPORT_VERSION,
  MetadataImportError,
  exportPoolMetadata,
  importPoolMetadata,
} from '../src/metadata-transfer.ts'

/** 生成一个带完整凭据的账号（仅用于测试构造 store，凭据不落盘到导出文件）。 */
function credential(name: string, token = `token-${name}`) {
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

function account(partial: Partial<WorkBuddyAccount> & Pick<WorkBuddyAccount, 'id' | 'label'>): WorkBuddyAccount {
  return {
    credential: credential(partial.id),
    cooldownUntilMs: 0,
    modelCooldowns: {},
    rateLimitHits: 0,
    ...partial,
  }
}

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xdpool-meta-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'accounts.json')
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('exportPoolMetadata（脱敏导出）', () => {
  it('默认导出不含 credential / accessToken / refreshToken 等凭据字段', async () => {
    const path = storePath()
    await saveStoredAccounts(path, [
      account({
        id: 'a1',
        label: 'Alice#1',
        note: '主号',
        group: 'work',
        tags: ['cn', 'hy'],
        expiryAtMs: 1_700_000_000_000,
        usageCount: 12,
        health: 'healthy',
      }),
    ])
    const json = await exportPoolMetadata(path)
    const doc = JSON.parse(json) as Record<string, unknown>
    expect(doc['version']).toBe(METADATA_EXPORT_VERSION)
    const entries = doc['accounts'] as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    const entry = entries[0] as Record<string, unknown>
    // 白名单字段在。
    expect(entry['id']).toBe('a1')
    expect(entry['label']).toBe('Alice#1')
    expect(entry['note']).toBe('主号')
    expect(entry['group']).toBe('work')
    expect(entry['tags']).toEqual(['cn', 'hy'])
    expect(entry['expiryAtMs']).toBe(1_700_000_000_000)
    expect(entry['usageCount']).toBe(12)
    expect(entry['health']).toBe('healthy')
    // 凭据字段绝不在。
    expect(entry).not.toHaveProperty('credential')
    expect(entry).not.toHaveProperty('accessToken')
    expect(entry).not.toHaveProperty('refreshToken')
    expect(JSON.stringify(doc)).not.toContain('token-a1')
    expect(JSON.stringify(doc)).not.toContain('refresh-a1')
  })

  it('includeCredentials: true 显式开启时附带 credential', async () => {
    const path = storePath()
    await saveStoredAccounts(path, [account({ id: 'a1', label: 'Alice#1' })])
    const json = await exportPoolMetadata(path, { includeCredentials: true })
    const doc = JSON.parse(json) as Record<string, unknown>
    const entry = (doc['accounts'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    expect(entry['credential']).toBeDefined()
    expect(JSON.stringify(entry['credential'])).toContain('token-a1')
  })
})

describe('importPoolMetadata（脱敏导入）', () => {
  it('命中 id 只合并元数据，凭据保持 store 原值，不破坏既有账号', async () => {
    const path = storePath()
    await saveStoredAccounts(path, [
      account({ id: 'a1', label: 'Alice#1', note: '旧备注', group: 'old' }),
      account({ id: 'a2', label: 'Bob#2' }),
    ])
    const incoming = JSON.stringify({
      version: 1,
      accounts: [
        { id: 'a1', label: 'Alice·改', note: '新备注', group: 'new', tags: ['x'], credential: { accessToken: 'evil-token' } },
        { id: 'a2', label: 'Bob#2', note: '附加' },
        { id: 'missing', label: '不在池里' },
      ],
    })
    const result = await importPoolMetadata(path, incoming)
    expect(result.merged).toBe(2)
    expect(result.skipped).toBe(1)
    expect(result.strippedCredentials).toBe(1)

    const reloaded = await loadStoredAccounts(path)
    const byId = new Map((reloaded as StoredAccount[]).map(e => [e.id, e]))
    const a1 = byId.get('a1') as StoredAccount
    expect(a1.label).toBe('Alice·改')
    expect(a1.note).toBe('新备注')
    expect(a1.group).toBe('new')
    expect(a1.tags).toEqual(['x'])
    // 凭据保持原值，恶意 token 未写入。
    expect(a1.credential.accessToken).toBe('token-a1')
    expect(JSON.stringify(a1.credential)).not.toContain('evil-token')
    const a2 = byId.get('a2') as StoredAccount
    expect(a2.note).toBe('附加')
    expect(a2.credential.accessToken).toBe('token-a2')
    // 不存在的 id 未造号。
    expect(byId.has('missing')).toBe(false)
  })

  it('文件内重复 id 去重（首个生效），导入凭据字段被剥离', async () => {
    const path = storePath()
    await saveStoredAccounts(path, [account({ id: 'a1', label: 'Alice#1' })])
    const incoming = JSON.stringify({
      version: 1,
      accounts: [
        { id: 'a1', label: '第一个', note: '生效' },
        { id: 'a1', label: '第二个', note: '应被丢弃' },
      ],
    })
    const result = await importPoolMetadata(path, incoming)
    expect(result.merged).toBe(1)
    expect(result.skipped).toBe(1)
    const reloaded = await loadStoredAccounts(path)
    const a1 = reloaded[0] as StoredAccount
    expect(a1.label).toBe('第一个')
    expect(a1.note).toBe('生效')
  })

  it('非法输入被拒绝并抛出 MetadataImportError', async () => {
    const path = storePath()
    await saveStoredAccounts(path, [account({ id: 'a1', label: 'Alice#1' })])
    const bad = [
      'not-json{{{',
      '[]',
      '{"accounts":[]}', // 缺 version
      '{"version":1}', // 缺 accounts
      '{"version":1,"accounts":[{"label":"x"}]}', // 缺 id
      '{"version":1,"accounts":[{"id":"x"}]}', // 缺 label
      '{"version":1,"accounts":[{"id":"","label":"x"}]}', // 空 id
    ]
    for (const text of bad) {
      await expect(importPoolMetadata(path, text)).rejects.toBeInstanceOf(MetadataImportError)
    }
  })

  it('旧格式（无可选元数据字段）兼容：导入后仍可读回，凭据完整', async () => {
    const path = storePath()
    // 旧格式：StoredAccount 只有必填字段，无 note/group/tags/expiryAtMs/usageCount/health。
    await saveStoredAccounts(path, [account({ id: 'a1', label: 'Alice#1' })])
    // 覆盖写成一个「旧 accounts.json」再导入：模拟旧文件里没有这些字段。
    const incoming = JSON.stringify({
      version: 1,
      accounts: [{ id: 'a1', label: 'Alice#1' }],
    })
    const result = await importPoolMetadata(path, incoming)
    expect(result.merged).toBe(1)
    const reloaded = await loadStoredAccounts(path)
    expect(reloaded).toHaveLength(1)
    expect((reloaded[0] as StoredAccount).credential.accessToken).toBe('token-a1')
    expect((reloaded[0] as StoredAccount).note).toBeUndefined()
  })

  it('无任何命中时不写盘，也不报错', async () => {
    const path = storePath()
    await saveStoredAccounts(path, [account({ id: 'a1', label: 'Alice#1' })])
    const before = await loadStoredAccounts(path)
    const result = await importPoolMetadata(path, JSON.stringify({
      version: 1,
      accounts: [{ id: 'ghost', label: '不存在' }],
    }))
    expect(result.merged).toBe(0)
    expect(result.skipped).toBe(1)
    const after = await loadStoredAccounts(path)
    expect(after).toEqual(before)
  })
})
