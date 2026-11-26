/**
 * 把仓库内的 rail 图标规范源复制到客户端产物。
 *
 * 旧脚本把 10 个 SVG path 写死在脚本里、再写向 `D:/dsh-home/_xdpool-src`，
 * 生成结果与线上已验证的 14 键 `rail-icons.ts` 早已分叉。现在规范源在
 * `xdpool-design/rail-icons.ts`，脚本只做仓库相对路径的复制，避免再次漂移。
 */
import { copyFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(repoRoot, 'xdpool-design', 'rail-icons.ts')
const target = resolve(repoRoot, 'src', 'client', 'rail-icons.ts')

copyFileSync(source, target)
const count = readFileSync(target, 'utf8').match(/^  [a-z]+:/gmu)?.length ?? 0
console.log('生成 rail-icons.ts，', count, '个图标')
