/**
 * 积分自动化面板里的「渠道包签到」一行。
 *
 * 台账是渠道包自己写的，插件只读：解析要能容忍字段增减、金额里的千分位，
 * 读不到时必须安静地没有这一行（不能拿 0 冒充「今天没领到」）。
 * 末尾的源码断言锁住这条数据真的接到了面板，而不是只写了个解析函数。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  channelPackCheckinPaths,
  parseChannelPackCheckin,
  readChannelPackCheckin,
} from '../src/channel-pack-checkin.ts'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'pack-checkin-'))
  homes.push(home)
  return home
}

const LEDGER = JSON.stringify({
  schema: 'dsh-codearts-auth/auto-checkin/v1',
  enabled: true,
  lastDate: '2026-11-26',
  lastResult: '6 个渠道：31 个账号领取成功（+8200积分），16 个今天已领，4 个失败，1 个渠道不支持签到',
  channels: [
    { provider: 'buddy', text: '10 个今天已领' },
    { provider: 'codearts', text: '9 个 +900积分，1 个今天已领，2 个失败' },
    { provider: 'loomy', text: '5 个今天已领' },
    { provider: 'minimax', text: '11 个 +6200积分' },
    { provider: 'qodercn', text: '482 个未开启' },
    { provider: 'raccoon', text: '无签到接口' },
    { provider: 'trae', text: '11 个 +1100积分，2 个失败' },
  ],
})

describe('渠道包台账解析', () => {
  it('逐渠道金额相加，渠道数取台账自己的声明', () => {
    const summary = parseChannelPackCheckin(LEDGER)
    expect(summary).toMatchObject({
      date: '2026-11-26',
      credit: 8200,
      channelCount: 6,
    })
    expect(summary?.result).toContain('+8200积分')
    expect(summary?.channels).toHaveLength(7)
  })

  it('逐渠道没有金额时退回 lastResult 的总额，千分位也认', () => {
    const summary = parseChannelPackCheckin(JSON.stringify({
      lastDate: '2026-11-25',
      lastResult: '3 个渠道：+8,200 积分',
      channels: [{ provider: 'buddy', text: '10 个今天已领' }],
    }))
    expect(summary?.credit).toBe(8200)
    expect(summary?.channelCount).toBe(3)
  })

  it('只有「已领/无接口」时不编造积分', () => {
    const summary = parseChannelPackCheckin(JSON.stringify({
      lastDate: '2026-11-26',
      channels: [
        { provider: 'buddy', text: '10 个今天已领' },
        { provider: 'raccoon', text: '无签到接口' },
      ],
    }))
    expect(summary?.credit).toBe(0)
    expect(summary?.channelCount).toBe(1)
  })

  it('坏 JSON 或不相干的文件不产生摘要', () => {
    expect(parseChannelPackCheckin('{')).toBeUndefined()
    expect(parseChannelPackCheckin('{"hello":"world"}')).toBeUndefined()
    expect(parseChannelPackCheckin('null')).toBeUndefined()
  })
})

describe('台账读取', () => {
  it('从 DSH_HOME/channel-pack 读，位置和 ignored.ts 同规则', async () => {
    const home = await tempHome()
    const file = join(home, '.dsh', 'channel-pack', 'auto-checkin.json')
    await mkdir(join(home, '.dsh', 'channel-pack'), { recursive: true })
    await writeFile(file, LEDGER)
    const summary = await readChannelPackCheckin({ DSH_HOME: join(home, '.dsh') }, home)
    expect(summary?.credit).toBe(8200)
  })

  it('渠道包状态目录覆盖变量：目录本身与它的父目录都试', async () => {
    const home = await tempHome()
    const stateDir = join(home, 'state')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'auto-checkin.json'), LEDGER)
    expect(channelPackCheckinPaths({ DSH_CHANNEL_PACK_STATE_DIR: stateDir }, home))
      .toContain(join(stateDir, 'auto-checkin.json'))
    expect((await readChannelPackCheckin({ DSH_CHANNEL_PACK_STATE_DIR: stateDir }, home))?.credit).toBe(8200)
  })

  it('没有台账时返回 undefined，不抛错', async () => {
    const home = await tempHome()
    await expect(readChannelPackCheckin({ DSH_HOME: join(home, '.dsh') }, home))
      .resolves.toBeUndefined()
  })
})

describe('面板接线', () => {
  const section = readFileSync(new URL('../src/client/ChannelPoolSection.tsx', import.meta.url), 'utf8')
  const card = readFileSync(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')
  const web = readFileSync(new URL('../src/web-status.ts', import.meta.url), 'utf8')

  it('状态文档带上渠道包快照', () => {
    expect(web).toContain('readChannelPackCheckin()')
    expect(web).toContain('channelPackCheckin: {')
  })

  it('卡片把快照传给渠道详情，并在积分自动化那一栏画出来', () => {
    expect(card).toContain("channelPackCheckin={statusOf('cn')?.channelPackCheckin}")
    expect(section).toContain('title={channelPackCheckin.result}')
    expect(section).toContain('{packCheckinLineOf(t, channelPackCheckin)}')
  })
})
