// 渠道池源码文本断言的统一读取入口。
// 3.0.15 起 ChannelPoolSection.tsx 拆为「纯 TS 辅助」+「UI 组件」两个文件，
// 本 helper 返回二者拼接文本，使既有「该字面量存在于客户端实现」类断言保持原意。
import { readFileSync } from 'node:fs'

const read = (file: string): string => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')

/** 每次调用重新读取，语义与原内联 readFileSync 一致。 */
export function poolSectionCombinedSource(): string {
  return `${read('channel-pool-core.ts')}\n${read('ChannelPoolSection.tsx')}`
}
