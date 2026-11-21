import { describe, expect, it } from 'vitest'
import { deriveAccountHealth, WorkBuddyAccountPool } from '../src/accounts'

const NOW = 1_700_000_000_000

describe('deriveAccountHealth（健康状态派生）', () => {
  it('信号齐全且无异常记录 → healthy', () => {
    expect(deriveAccountHealth({ credentialDeadUntilMs: 0, cooldownUntilMs: 0, rateLimitHits: 0 }, NOW))
      .toBe('healthy')
  })

  it('登录被上游拒绝（credentialDeadUntilMs 未到期）→ degraded', () => {
    expect(deriveAccountHealth({ credentialDeadUntilMs: NOW + 1, cooldownUntilMs: 0, rateLimitHits: 0 }, NOW))
      .toBe('degraded')
  })

  it('账号级冷却中（cooldownUntilMs 未到期）→ degraded', () => {
    expect(deriveAccountHealth({ credentialDeadUntilMs: 0, cooldownUntilMs: NOW + 1, rateLimitHits: 0 }, NOW))
      .toBe('degraded')
  })

  it('有连续限流记录（rateLimitHits > 0，即使已出冷却窗口）→ degraded', () => {
    expect(deriveAccountHealth({ credentialDeadUntilMs: 0, cooldownUntilMs: 0, rateLimitHits: 2 }, NOW))
      .toBe('degraded')
  })

  it('三个信号字段全部缺失 → unknown（信息不足，不臆造）', () => {
    expect(deriveAccountHealth({}, NOW)).toBe('unknown')
  })

  it('已过期的判死/冷却时间戳不算异常 → healthy', () => {
    expect(deriveAccountHealth({ credentialDeadUntilMs: NOW - 1, cooldownUntilMs: NOW - 1, rateLimitHits: 0 }, NOW))
      .toBe('healthy')
  })
})

describe('WorkBuddyAccountPool.healthOf', () => {
  it('账号不存在 → undefined', () => {
    const pool = new WorkBuddyAccountPool({})
    expect(pool.healthOf('missing')).toBeUndefined()
  })
})
