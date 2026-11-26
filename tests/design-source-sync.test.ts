import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * xdpool-design 是仓库内的规范源，src/client 下那两份是脚本产物。
 *
 * 旧流程把设计稿放在仓库外、脚本写死 D: 路径，产物漂移了也没人知道：
 * 最明显的是 rail-icons 规范（14 键）与生成脚本（10 键）长期不一致。
 * 这两个断言把「改设计源必须重新生成」变成硬性要求。
 */
describe('xdpool-design canonical sources', () => {
  const root = join(import.meta.dirname, '..')

  const readSource = (name: string): string => readFileSync(join(root, 'xdpool-design', name), 'utf8')
  const readClient = (name: string): string => readFileSync(join(root, 'src', 'client', name), 'utf8')

  it('generated design-css.ts matches the canonical source', () => {
    expect(readClient('design-css.ts')).toBe(readSource('design-css.ts'))
  })

  it('generated rail-icons.ts matches the canonical source', () => {
    expect(readClient('rail-icons.ts')).toBe(readSource('rail-icons.ts'))
  })

  it('generation scripts do not depend on machine-specific absolute paths', () => {
    for (const name of ['extract-design-css.mjs', 'make-rail-icons.mjs']) {
      const script = readFileSync(join(root, 'scripts', name), 'utf8')
      // 注释会解释旧路径是什么，只有真正参与执行的代码才算依赖。
      const code = script
        .split('\n')
        .filter(line => !/^\s*(\*|\/\/|\/\*)/u.test(line))
        .join('\n')
      expect(code, `${name} still hardcodes a drive path`).not.toMatch(/[A-Za-z]:\/|\bD:\\/u)
    }
  })
})
