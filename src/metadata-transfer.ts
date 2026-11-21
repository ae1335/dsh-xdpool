/**
 * 账号池元数据的脱敏导出 / 导入（仅 host 侧）。
 *
 * 与「密码保护全量凭据备份」(`backup-crypto.ts` + `BackupPanel.tsx`) 不同：
 * 那套导出的是含凭据的完整备份并用 PBKDF2+AES-GCM 加密；本模块导出的是**脱敏
 * 元数据**——只含 id / label / note / group / tags / expiryAtMs / usageCount /
 * health / savedAtMs 等池内簿记字段，**绝不包含** accessToken / refreshToken /
 * credential 等凭据。用途是让用户在两台机器之间迁移「备注、分组、标签、手动过期
 * 时间、使用计数、健康标记」这些纯簿记信息，而不必搬运任何密钥材料。
 *
 * ## 安全策略（凭据如何被挡在写入路径之外）
 *
 * 1. **导出白名单**：`exportPoolMetadata` 只从 `StoredAccount` 复制白名单字段，
 *    `credential` 字段除非 `includeCredentials === true` 显式开启，否则根本不进入
 *    输出对象。默认调用（不传 options）输出里永远找不到 token 子串。
 * 2. **导入剥离**：`importPoolMetadata` 构建落盘对象时同样只取白名单字段，导入文件
 *    里即使带了 `credential` / `accessToken` / `refreshToken` 等字段，也会被丢弃并
 *    计数到 `strippedCredentials`，绝不写入 store。导入路径**没有** `includeCredentials`
 *    开关——元数据导入永远不接受凭据。
 * 3. **复用原子写**：合并后的账号仍通过 `saveStoredAccounts` 落盘（写后读回校验 +
 *    rename + `.bak` 回退），凭据始终来自当前 store 的原有值，导入只会改簿记字段。
 * 4. **无凭据不造号**：导入条目若 id 不在当前账号池，直接跳过——因为没有凭据就无法
 *    创建可用账号，硬造一个无凭据条目既读不回来、也会污染 store。这是「跳过已存在
 *    / 不存在的 id，绝不臆造凭据」的安全优先选择。
 *
 * 向后兼容：旧 `accounts.json`（无 note/group/tags 等可选字段、无 `deleted`）由
 * `loadStore` 照常解析；导入只合并命中的簿记字段，从不删除或覆盖凭据，因此不会破坏
 * 现有账号。
 *
 * @module dsh-xdpool/metadata-transfer
 */

import { loadStore, saveStoredAccounts, type StoredAccount } from './account-store.ts'
import type { WorkBuddyAccount } from './accounts.ts'

/** 导出文档版本号。 */
export const METADATA_EXPORT_VERSION = 1

/**
 * 脱敏导出白名单（供文档与评审对照，实际拷贝逻辑见 {@link toExportEntry}）：
 * `id` / `label` / `savedAtMs` / `note` / `group` / `tags` / `expiryAtMs` /
 * `usageCount` / `health`。不含 `credential` 及任何 token 字段。
 */

/** 导入时会主动剥离的凭据字段名（绝不允许写入 store）。 */
const CREDENTIAL_KEYS = new Set([
  'credential',
  'accessToken',
  'refreshToken',
  'expiresAtMs',
  'refreshExpiresAtMs',
  'lastRefreshAtMs',
  'nickname',
  'uin',
  'uid',
  'enterpriseId',
  'domain',
  'sourcePath',
])

/** 导出选项。 */
export interface ExportOptions {
  /** 显式 true 才附带 credential；调用方默认不传，即默认脱敏。 */
  includeCredentials?: boolean
}

/** 导入结果摘要。 */
export interface ImportResult {
  /** 成功把元数据合并进既有账号的数量。 */
  merged: number
  /** 跳过的条目数：文件内重复 id，或 id 不在当前账号池（无法无凭据创建）。 */
  skipped: number
  /** 被剥离了凭据字段的条目数（安全提示，非错误）。 */
  strippedCredentials: number
}

/** 导入文档非法时抛出；信息不含任何凭据片段。 */
export class MetadataImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataImportError'
  }
}

/**
 * 把当前账号池导出为脱敏 JSON 字符串（默认不含凭据）。
 *
 * @param storePath 账号池 store 文件路径（`accountStorePath()`）。
 * @param options   `includeCredentials` 显式 true 才附带 credential。
 */
export async function exportPoolMetadata(
  storePath: string,
  options: ExportOptions = {},
): Promise<string> {
  const store = await loadStore(storePath)
  const includeCredentials = options.includeCredentials === true
  const accounts = store.accounts.map(entry => toExportEntry(entry, includeCredentials))
  const document = {
    version: METADATA_EXPORT_VERSION,
    exportedAtMs: Date.now(),
    accounts,
  }
  return JSON.stringify(document, null, 2) + '\n'
}

/** 把一个 StoredAccount 收敛成白名单字段的导出对象。 */
function toExportEntry(entry: StoredAccount, includeCredentials: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: entry.id,
    label: entry.label,
    savedAtMs: entry.savedAtMs,
  }
  if (entry.note !== undefined) out['note'] = entry.note
  if (entry.group !== undefined) out['group'] = entry.group
  if (entry.tags !== undefined) out['tags'] = entry.tags
  if (entry.expiryAtMs !== undefined) out['expiryAtMs'] = entry.expiryAtMs
  if (entry.usageCount !== undefined) out['usageCount'] = entry.usageCount
  if (entry.health !== undefined) out['health'] = entry.health
  // 仅显式 includeCredentials 才附带凭据；默认绝不写 credential。
  if (includeCredentials) out['credential'] = entry.credential
  return out
}

/**
 * 读入导出 JSON，把元数据合并进当前账号池。
 *
 * 流程：格式校验（version + accounts 数组 + 每项至少 id/label）→ 按 id 去重 →
 * 剥离凭据字段 → 命中 id 的条目合并簿记字段 → 复用 `saveStoredAccounts` 原子落盘。
 * id 不在当前账号池的条目被跳过（无凭据无法造号）。
 */
export async function importPoolMetadata(storePath: string, text: string): Promise<ImportResult> {
  const incoming = parseImportDocument(text)
  const store = await loadStore(storePath)
  const byId = new Map(store.accounts.map(account => [account.id, account]))

  let merged = 0
  let skipped = 0
  let strippedCredentials = 0
  const seen = new Set<string>()

  for (const entry of incoming) {
    const id = entry['id'] as string
    // 文件内重复 id：去重，首次出现生效。
    if (seen.has(id)) {
      skipped += 1
      continue
    }
    seen.add(id)
    if (hasCredentialKeys(entry)) strippedCredentials += 1
    const existing = byId.get(id)
    if (existing === undefined) {
      // 该 id 不在当前账号池：无法在无凭据的情况下创建可用账号，跳过。
      skipped += 1
      continue
    }
    byId.set(id, mergeMetadata(existing, entry))
    merged += 1
  }

  // 只有真正合并过元数据才落盘；凭据来自 store 原有值，导入文件里的凭据已被剥离。
  if (merged > 0) {
    const accounts: WorkBuddyAccount[] = [...byId.values()].map(toWorkBuddy)
    await saveStoredAccounts(storePath, accounts, store.deleted)
  }

  return { merged, skipped, strippedCredentials }
}

/** 校验并解析导入文档，返回每项都已通过 id/label 校验的条目数组。 */
function parseImportDocument(text: string): Array<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new MetadataImportError(`dsh-xdpool: 导入的元数据不是合法 JSON：${errorSummary(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MetadataImportError('dsh-xdpool: 导入文档必须是 JSON 对象')
  }
  const doc = parsed as Record<string, unknown>
  if (typeof doc['version'] !== 'number') {
    throw new MetadataImportError('dsh-xdpool: 导入文档缺少数值类型的 version 字段')
  }
  const accounts = doc['accounts']
  if (!Array.isArray(accounts)) {
    throw new MetadataImportError('dsh-xdpool: 导入文档缺少 accounts 数组')
  }
  const entries: Array<Record<string, unknown>> = []
  for (let index = 0; index < accounts.length; index++) {
    const item = accounts[index]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new MetadataImportError(`dsh-xdpool: accounts[${index}] 不是对象`)
    }
    const record = item as Record<string, unknown>
    if (typeof record['id'] !== 'string' || record['id'] === '') {
      throw new MetadataImportError(`dsh-xdpool: accounts[${index}] 缺少非空字符串 id`)
    }
    if (typeof record['label'] !== 'string') {
      throw new MetadataImportError(`dsh-xdpool: accounts[${index}] 缺少字符串 label`)
    }
    entries.push(record)
  }
  return entries
}

/** 把导入条目的白名单字段合并进既有账号，凭据与 savedAtMs 保持 store 原值。 */
function mergeMetadata(existing: StoredAccount, incoming: Record<string, unknown>): StoredAccount {
  const merged: StoredAccount = { ...existing }
  if (typeof incoming['label'] === 'string' && incoming['label'] !== '') merged.label = incoming['label']
  if (typeof incoming['note'] === 'string') merged.note = incoming['note']
  if (typeof incoming['group'] === 'string') merged.group = incoming['group']
  if (isStringArray(incoming['tags'])) merged.tags = incoming['tags']
  if (typeof incoming['expiryAtMs'] === 'number') merged.expiryAtMs = incoming['expiryAtMs']
  if (typeof incoming['usageCount'] === 'number') merged.usageCount = incoming['usageCount']
  if (typeof incoming['health'] === 'string') merged.health = incoming['health']
  return merged
}

/** 判断条目是否携带凭据字段（用于安全计数，字段本身在合并时被丢弃）。 */
function hasCredentialKeys(record: Record<string, unknown>): boolean {
  return Object.keys(record).some(key => CREDENTIAL_KEYS.has(key))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** 把 StoredAccount 还原成 saveStoredAccounts 需要的 WorkBuddyAccount 形态。 */
function toWorkBuddy(entry: StoredAccount): WorkBuddyAccount {
  return {
    id: entry.id,
    label: entry.label,
    credential: entry.credential,
    cooldownUntilMs: 0,
    modelCooldowns: {},
    rateLimitHits: 0,
    ...entry.note !== undefined ? { note: entry.note } : {},
    ...entry.group !== undefined ? { group: entry.group } : {},
    ...entry.tags !== undefined ? { tags: entry.tags } : {},
    ...entry.expiryAtMs !== undefined ? { expiryAtMs: entry.expiryAtMs } : {},
    ...entry.usageCount !== undefined ? { usageCount: entry.usageCount } : {},
    ...entry.health !== undefined ? { health: entry.health } : {},
  }
}

/**
 * 短小、不泄漏凭据片段的错误摘要。
 *
 * `JSON.parse` 抛出的 `SyntaxError` 其 V8 消息会内嵌原文片段——导入文件理论上应是
 * 纯元数据，但防御性地沿用 store 的做法：只留错误名与字节位置，丢弃消息正文。
 */
function errorSummary(error: unknown): string {
  if (error instanceof SyntaxError) {
    const position = /position (\d+)/i.exec(error.message)
    return position ? `SyntaxError at position ${position[1]}` : 'SyntaxError'
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 80)
}
