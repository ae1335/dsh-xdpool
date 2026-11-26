/**
 * 把仓库内的设计样式规范源复制到客户端产物。
 *
 * 旧版本从 `D:/dsh-home/xdpool-design` 读 tokens.css / app.css / build-*.mjs
 * 并现场拼装 CSS。那些设计稿文件从未入库，已随原开发机一起丢失；现在
 * `xdpool-design/design-css.ts` 是线上验证过版本的规范源，脚本只做复制，
 * 保证源与产物逐字节一致，也不再依赖任何机器绝对路径。
 */
import { copyFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(repoRoot, 'xdpool-design', 'design-css.ts')
const target = resolve(repoRoot, 'src', 'client', 'design-css.ts')

copyFileSync(source, target)
console.log('生成 design-css.ts:', Math.round(statSync(target).size / 1024), 'KB')
