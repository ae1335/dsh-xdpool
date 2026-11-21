import { describe, expect, it } from 'vitest'
import { serializeUsageCsv, serializeUsageJson } from '../src/usage-export.ts'
import type { UsageSummary } from '../src/stats.ts'

/** 造一份覆盖各字段形态的最小账本，专供导出断言。 */
function makeSummary(): UsageSummary {
  const base: UsageSummary = {
    samples: 1,
    turns: 1,
    failedTurns: 0,
    recoveredTurns: 0,
    calls: 1,
    usageReported: true,
    entries: [
      {
        channel: 'workbuddy',
        region: 'cn',
        model: 'glm-5.3',
        account: 'cn-1',
        turnId: 't-1',
        at: 1_700_000_000_000,
        ok: true,
        ttftMs: 420,
        decodeMs: 1_234,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 10,
          cachedTokens: 20,
        },
      },
    ],
    rows: [],
    accounts: [],
    days: [],
  }
  return base
}

describe('serializeUsageJson', () => {
  it('序列化完整统计树且字段出现', () => {
    const json = serializeUsageJson(makeSummary())
    const parsed = JSON.parse(json) as UsageSummary
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]?.model).toBe('glm-5.3')
    // 无凭据：统计字段名里的 token 是「用量」，不应命中凭据形态
    expect(json).not.toMatch(/sk-[A-Za-z0-9]|api[_-]?key|secret|password|bearer/i)
  })
})

describe('serializeUsageCsv', () => {
  it('包含表头与一条流水，字段齐全', () => {
    const csv = serializeUsageCsv(makeSummary())
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe(
      'time,channel,region,model,account,ok,ttft_ms,decode_ms,input_tokens,output_tokens,reasoning_tokens,cached_tokens',
    )
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('workbuddy')
    expect(lines[1]).toContain('glm-5.3')
    expect(lines[1]).toContain('cn-1')
    expect(lines[1]).toContain('true')
  })

  it('CSV 字段按 RFC 4180 转义：逗号加引号、引号翻倍', () => {
    const summary = makeSummary()
    summary.entries = [{
      ...summary.entries[0]!,
      channel: 'a,b',
      model: 'say "hi"',
    }]
    const csv = serializeUsageCsv(summary)
    expect(csv).toContain('"a,b"')
    expect(csv).toContain('"say ""hi"""')
  })

  it('空 entries 只输出表头（不抛错）', () => {
    const summary = makeSummary()
    summary.entries = []
    const csv = serializeUsageCsv(summary)
    expect(csv.trim().split('\n')).toEqual([
      'time,channel,region,model,account,ok,ttft_ms,decode_ms,input_tokens,output_tokens,reasoning_tokens,cached_tokens',
    ])
  })

  it('导出不含任何凭据', () => {
    const csv = serializeUsageCsv(makeSummary())
    const json = serializeUsageJson(makeSummary())
    const credentialish = /sk-[A-Za-z0-9]|api[_-]?key|secret|password|bearer|authorization/i
    expect(csv).not.toMatch(credentialish)
    expect(json).not.toMatch(credentialish)
  })
})
