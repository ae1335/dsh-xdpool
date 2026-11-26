/**
 * 渠道包自动签到台账的只读快照。
 *
 * 渠道包（dsh-codearts-auth）把最近一次自动签到的结果写进
 * `~/.dsh/channel-pack/auto-checkin.json`。插件自己的 automation earnings
 * 只记 WorkBuddy 桌面账号，看不见渠道包那几十个账号领到的积分 —— 卡片上的
 * 「今日积分」因此长期只显示 WorkBuddy。那不是签到没跑：两套系统各记各的账。
 *
 * 这里只读那份台账，给状态文档补一行摘要。不参与签到、不写文件、不改任何
 * 账号池逻辑；台账不存在或损坏时返回 undefined，卡片就不画这一行。
 *
 * @module dsh-xdpool/channel-pack-checkin
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 一条逐渠道原文，例如 `{ provider: 'codearts', text: '9 个 +900积分，2 个失败' }`。 */
export interface ChannelPackCheckinChannel {
  provider: string
  text: string
}

/** 卡片要显示的那一行数据。 */
export interface ChannelPackCheckin {
  /** 台账的 `lastDate`（YYYY-MM-DD）。卡片总是带着它，避免把旧结果说成「今日」。 */
  date?: string
  /** 台账原文，作为那一行的 title：失败/未开启的细节不能被摘要吞掉。 */
  result?: string
  /** 各渠道文本里 `+N积分` 的和。 */
  credit: number
  /** 台账声明的渠道数；没声明时按有签到动作的行数算。 */
  channelCount: number
  channels: readonly ChannelPackCheckinChannel[]
}

/** `+900积分`、`+1,100 积分` 都算；不带 `积分` 的 `+12` 不算。 */
function creditOf(text: string): number {
  let sum = 0
  for (const match of text.matchAll(/\+\s*([\d,]+)\s*积分/gu)) {
    const value = Number((match[1] ?? '').replace(/,/gu, ''))
    if (Number.isFinite(value)) sum += value
  }
  return sum
}

/**
 * 解析台账原文。宽松解析：版本升级多出字段不该让这一行消失；
 * 但三样都没有（没有日期、没有原文、没有渠道行）就视为非台账。
 */
export function parseChannelPackCheckin(raw: string): ChannelPackCheckin | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (doc === null || typeof doc !== 'object') return undefined
  const row = doc as Record<string, unknown>
  const date = typeof row['lastDate'] === 'string' ? row['lastDate'] : undefined
  const result = typeof row['lastResult'] === 'string' ? row['lastResult'] : undefined
  const channels = Array.isArray(row['channels'])
    ? row['channels'].flatMap((entry): ChannelPackCheckinChannel[] => {
        if (entry === null || typeof entry !== 'object') return []
        const item = entry as Record<string, unknown>
        if (typeof item['provider'] !== 'string' || typeof item['text'] !== 'string') return []
        return [{ provider: item['provider'], text: item['text'] }]
      })
    : []
  if (date === undefined && result === undefined && channels.length === 0) return undefined

  // 逐渠道行有数字就按行加总；没有时退回 lastResult 的总额。两边都有且
  // 一致时结果相同，绝不把总额和分项再加一遍。
  const itemized = channels.reduce((sum, channel) => sum + creditOf(channel.text), 0)
  const credit = itemized > 0 ? itemized : creditOf(result ?? '')
  const declared = result?.match(/(\d+)\s*个渠道/u)
  // 「无签到接口」「未开启」不算跑过的渠道。lastResult 一般会带总数，
  // 这里只是它缺失时的兜底。
  const active = channels.filter(channel => /积分|已领|失败/u.test(channel.text)).length
  return {
    ...date === undefined ? {} : { date },
    ...result === undefined ? {} : { result },
    credit,
    channelCount: declared?.[1] === undefined ? active : Number(declared[1]),
    channels,
  }
}

/**
 * 台账的可能位置，按优先级排列。
 *
 * `DSH_HOME` 与 `ignored.ts` 同规则；渠道包的状态目录可以被环境变量改掉，
 * 那个变量可能指状态目录本身，也可能指它的父目录（备份代码按后者拼），
 * 两种都试。web 版 DSH 还可能有 profile 子目录，给了 `DSH_PROFILE` 才找。
 */
export function channelPackCheckinPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const out: string[] = []
  const add = (path: string): void => {
    if (!out.includes(path)) out.push(path)
  }
  const stateDir = env['DSH_CHANNEL_PACK_STATE_DIR']?.trim()
  if (stateDir !== undefined && stateDir !== '') {
    add(join(stateDir, 'auto-checkin.json'))
    add(join(stateDir, 'channel-pack', 'auto-checkin.json'))
  }
  const dshHome = env['DSH_HOME']?.trim() || join(home, '.dsh')
  add(join(dshHome, 'channel-pack', 'auto-checkin.json'))
  const profile = env['DSH_PROFILE']?.trim()
  if (profile !== undefined && profile !== '') {
    add(join(dshHome, 'profiles', profile, 'channel-pack', 'auto-checkin.json'))
  }
  return out
}

/** 读第一份能解析的台账；读不到就 undefined（卡片安静地不画那一行）。 */
export async function readChannelPackCheckin(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<ChannelPackCheckin | undefined> {
  for (const path of channelPackCheckinPaths(env, home)) {
    try {
      const parsed = parseChannelPackCheckin(await readFile(path, 'utf8'))
      if (parsed !== undefined) return parsed
    } catch {
      // 不存在、无权限、正在被覆盖：都不值得让状态路由失败。下一轮再读。
    }
  }
  return undefined
}
