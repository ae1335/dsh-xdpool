import type { UsageCall, UsageSummary } from './stats.ts'

/**
 * 账本导出序列化（同构、Node-free 纯函数）。
 *
 * 只导出用量与统计值，不含任何凭据：channel/region/model/account 都是
 * 展示标签或分组键，`account` 是池子打印的账户显示名（如 `cn-1`），
 * 不是 API Key / Secret / 密码。真正的密钥只存在于 host 侧的凭据库里，
 * 从未进入账本，也不会出现在导出文件里。
 */

/**
 * 把一个字段按 CSV 规则转义。
 *
 * 仅当字段含逗号、双引号或换行时才需要加引号；引号本身翻倍（`"` → `""`），
 * 与 RFC 4180 一致。数字与布尔值无需转义，但统一走这里也无副作用。
 */
function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** 明细流水（entries）导出的固定表头，顺序即导出顺序。 */
const CALL_CSV_HEADER = [
  'time',
  'channel',
  'region',
  'model',
  'account',
  'ok',
  'ttft_ms',
  'decode_ms',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cached_tokens',
] as const

/** 把一条账本流水拍平成一行 CSV 单元格。 */
function callToCsvRow(call: UsageCall): string {
  const usage = call.usage
  return [
    new Date(call.at).toISOString(),
    call.channel,
    call.region,
    call.model,
    call.account ?? '',
    call.ok,
    call.ttftMs ?? '',
    call.decodeMs ?? '',
    usage?.inputTokens ?? '',
    usage?.outputTokens ?? '',
    usage?.reasoningTokens ?? '',
    usage?.cachedTokens ?? '',
  ].map(csvCell).join(',')
}

/**
 * 生成完整账本的 JSON 导出字符串。
 *
 * 直接序列化 `UsageSummary` 的整棵统计树（samples/turns/entries/rows/
 * accounts/days），全部是聚合与流水统计值，零凭据。
 */
export function serializeUsageJson(summary: UsageSummary): string {
  return JSON.stringify(summary, null, 2)
}

/**
 * 生成账本明细流水的 CSV 导出字符串。
 *
 * 导出 `entries`（原始调用流水，新在前），一行一次上游往返；不含聚合行，
 * 因为聚合可以随时从流水重算，写两份只会给「同一事实两处数字」留机会。
 * 返回带表头的多行文本，行尾为 `\n`。
 */
export function serializeUsageCsv(summary: UsageSummary): string {
  const header = CALL_CSV_HEADER.join(',')
  const rows = summary.entries.map(callToCsvRow)
  return [header, ...rows].join('\n') + '\n'
}
