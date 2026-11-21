/**
 * 账号池元数据 UI（B1 增量，仅 client 侧）：账号行上的备注/分组/过期/使用次数
 * 与健康徽标三态的渲染契约。
 *
 * client 卡片是 CommonJS 包，由 host 对话框消费，本进程无 DOM，因此沿用
 * `card-shell.test.ts` 的做法：对源码契约做断言，而不是渲染 React 树。
 *
 * host 侧序列化（把 note/group/expiryAtMs/usageCount/health 写进 PoolWebAccount）
 * 由并行子智能体负责；这里只锁定 client 侧的展示行为：三态徽标如何映射文案与
 * 样式类、缺失字段是否不渲染、以及文案 key 是否双语齐全、样式类是否有定义。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const card = readFileSync(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
const locales = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')

/** 是否在 en 表（export const en = { ... } as const）中声明了某个 key。 */
function enHas(source: string, key: string): boolean {
  const enStart = source.indexOf('export const en = {')
  const enEnd = source.indexOf('} as const', enStart)
  return source.slice(enStart, enEnd).includes(`'${key}':`)
}

/** 是否在 zh 表中声明了某个 key（zh 表无 `as const` 结尾，直接查全表）。 */
function zhHas(source: string, key: string): boolean {
  return source.slice(source.indexOf('export const zh')).includes(`'${key}':`)
}

describe('健康徽标三态映射', () => {
  it('healthy 映射到健康文案与默认 tag 胶囊', () => {
    expect(card).toMatch(/meta\.health === 'healthy'/)
    expect(card).toContain("'row.healthHealthy'")
    expect(card).toContain('dsm-xdpool-account-tag')
  })

  it('degraded 映射到降级文案与 warning 配色类', () => {
    expect(card).toMatch(/meta\.health === 'degraded'/)
    expect(card).toContain("'row.healthDegraded'")
    expect(card).toContain('dsm-xdpool-account-tag-degraded')
  })

  it('unknown 映射到未知文案与 tertiary 配色类', () => {
    expect(card).toMatch(/meta\.health === 'unknown'/)
    expect(card).toContain("'row.healthUnknown'")
    expect(card).toContain('dsm-xdpool-account-tag-unknown')
  })

  it('host 未下发 health 时回退为 null，不渲染徽标', () => {
    // 三态 else-if 链末端必须落到 null，而不是抛错或落到别的分支。
    expect(card).toMatch(/\? \{ text:[\s\S]*?: null/)
    expect(card).toContain('healthBadge === null')
  })
})

describe('账号元数据字段展示', () => {
  it('备注 note、分组 group 逐项判断，缺失（undefined/空串）不渲染', () => {
    expect(card).toContain("'row.accountNote'")
    expect(card).toContain("'row.accountGroup'")
    expect(card).toMatch(/meta\.note !== undefined && meta\.note !== ''/)
    expect(card).toMatch(/meta\.group !== undefined && meta\.group !== ''/)
  })

  it('过期时间 expiryAtMs 经 formatExpiry 格式化，空值不渲染', () => {
    expect(card).toContain('formatExpiry(meta.expiryAtMs)')
    expect(card).toContain("'row.accountExpiry'")
    expect(card).toMatch(/expiryText !== ''/)
  })

  it('使用次数 usageCount 仅在非 undefined 时渲染', () => {
    expect(card).toContain("'row.accountUsage'")
    expect(card).toMatch(/meta\.usageCount !== undefined/)
  })
})

describe('文案与样式契约', () => {
  it('元数据与健康 key 在 en/zh 双语齐全', () => {
    const keys = [
      'row.accountNote',
      'row.accountGroup',
      'row.accountExpiry',
      'row.accountUsage',
      'row.healthHealthy',
      'row.healthDegraded',
      'row.healthUnknown',
    ]
    for (const key of keys) {
      expect(enHas(locales, key), `${key} missing from en`).toBe(true)
      expect(zhHas(locales, key), `${key} missing from zh`).toBe(true)
    }
  })

  it('健康徽标样式类均有 CSS 定义', () => {
    const used = new Set([...card.matchAll(/dsm-xdpool-[a-z0-9-]+/g)].map(m => m[0]))
    const required = [
      'dsm-xdpool-health',
      'dsm-xdpool-health-dot',
      'dsm-xdpool-account-tag-degraded',
      'dsm-xdpool-account-tag-unknown',
    ]
    const missing = required.filter(name => !styles.includes(`.${name}`))
    expect(missing, '健康徽标样式类缺少 CSS 定义').toEqual([])
    // 三态徽标本身都挂在账号行渲染的类集合里，确认没有离群。
    for (const name of required) {
      expect(used.has(name), `${name} 未在账号行渲染`).toBe(true)
    }
  })
})
