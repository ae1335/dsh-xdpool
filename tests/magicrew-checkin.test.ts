/**
 * magicrew 签到路由的逐账号回喂。
 *
 * 渠道池的徽章只吃 `statuses`，而 magicrew / autoclaw 不在 pack 的
 * `credits.status` 派发里，名册也不会给它们开状态接口 —— 领取之后徽章
 * 只能靠这条路由把每个账号的结果带回去。这里锁住响应形状：
 *
 *   - `accounts[]` 只装 todayCheckedIn 为真的账号，带今日积分；
 *   - 已领过的账号同样算已领（幂等），只是没有新增积分；
 *   - 失败的账号不出现在数组里（徽章不得被误点亮）；
 *   - 顶层 `ok` / `gained` / `message` 保持原样（旧调用方不受影响）。
 *
 * 账号存到临时 DSH_HOME，上游 login-gift 用 stub 的 fetch 扮演。
 */
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

const DSH_HOME = await mkdtemp(join(tmpdir(), 'magicrew-checkin-'))
vi.stubEnv('DSH_HOME', DSH_HOME)

const { registerMagicrewRoutes } = await import('../src/magicrew-routes.ts')
const { magicrewAccountsPath, magicrewAccountId } = await import('../src/magicrew-store.ts')
const { POOL_MAGICREW_CN_CHECKIN_PATH } = await import('../src/status-paths.ts')

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** 和 checkin.test.ts 一样的假 ctx：只收集 handler，不起真服务器。 */
function fakeContext(): { ctx: never; handler: () => Handler } {
  let handler: Handler | undefined
  const ctx = {
    effect: (fn: () => void) => fn(),
    webServer: {
      register: (route: { path: string; handler: Handler }) => {
        if (route.path === POOL_MAGICREW_CN_CHECKIN_PATH) handler = route.handler
        return () => {}
      },
    },
  }
  return { ctx: ctx as never, handler: () => {
    if (handler === undefined) throw new Error('checkin route not registered')
    return handler
  } }
}

async function seedAccounts(jwts: readonly string[]): Promise<void> {
  const file = magicrewAccountsPath('cn')
  await mkdir(dirname(file), { recursive: true })
  const accounts = jwts.map((jwt) => ({
    id: magicrewAccountId('cn', jwt),
    credential: { site: 'cn', jwt },
    createdAt: 1,
    enabled: true,
  }))
  await writeFile(file, JSON.stringify({ version: 1, accounts }))
}

/** 内存版 ServerResponse：只实现路由用到的 writeHead/end。 */
function fakeResponse(): { res: ServerResponse; done: Promise<{ status: number; body: Record<string, unknown> }> } {
  let status = 0
  let resolve!: (value: { status: number; body: Record<string, unknown> }) => void
  const done = new Promise<{ status: number; body: Record<string, unknown> }>((r) => { resolve = r })
  const res = {
    writeHead(code: number) { status = code; return this },
    end(chunk?: string) { resolve({ status, body: chunk === undefined ? {} : JSON.parse(chunk) as Record<string, unknown> }) },
  }
  return { res: res as unknown as ServerResponse, done }
}

function post(handler: Handler, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = Buffer.from(JSON.stringify(body ?? {}))
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'localhost:3080' },
    async *[Symbol.asyncIterator]() { yield payload },
  }
  const { res, done } = fakeResponse()
  void handler(req as unknown as IncomingMessage, res)
  return done
}

/** 按 JWT 给每个账号排一个上游结果。 */
function stubUpstream(results: Record<string, Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
    const jwt = init?.headers?.['authorization']?.replace('Bearer ', '') ?? ''
    const payload = results[jwt] ?? { code: 500, message: 'unexpected jwt' }
    return new Response(JSON.stringify(payload), { status: 200 })
  }))
}

interface ClaimedRow { accountId: string; todayCheckedIn: boolean; todayCredit?: number }

describe('magicrew 签到路由回喂徽章', () => {
  beforeEach(() => { vi.stubEnv('DSH_HOME', DSH_HOME) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('领取成功：accounts 带回 accountId 与今日积分，顶层字段不变', async () => {
    await seedAccounts(['jwt-a'])
    stubUpstream({ 'jwt-a': { code: 0, data: { points: 50 } } })
    const { ctx, handler } = fakeContext()
    registerMagicrewRoutes(ctx, { adopted: () => {} })

    const { status, body } = await post(handler())
    expect(status).toBe(200)
    expect(body['ok']).toBe(true)
    expect(body['gained']).toBe(50)
    expect(typeof body['message']).toBe('string')
    expect(body['accounts']).toEqual([
      { accountId: magicrewAccountId('cn', 'jwt-a'), todayCheckedIn: true, todayCredit: 50 },
    ])
  })

  it('今天已领过：仍回喂 todayCheckedIn，不带积分字段', async () => {
    await seedAccounts(['jwt-a'])
    stubUpstream({ 'jwt-a': { code: 0, data: { alreadyCheckedIn: true } } })
    const { ctx, handler } = fakeContext()
    registerMagicrewRoutes(ctx, { adopted: () => {} })

    const { body } = await post(handler())
    expect(body['ok']).toBe(true)
    expect(body['gained']).toBe(0)
    expect(body['accounts']).toEqual([
      { accountId: magicrewAccountId('cn', 'jwt-a'), todayCheckedIn: true },
    ])
  })

  it('失败账号不进 accounts，成功账号不受影响', async () => {
    await seedAccounts(['jwt-a', 'jwt-b'])
    stubUpstream({
      'jwt-a': { code: 401, message: '登录态失效' },
      'jwt-b': { code: 0, data: { amount: 30 } },
    })
    const { ctx, handler } = fakeContext()
    registerMagicrewRoutes(ctx, { adopted: () => {} })

    const { body } = await post(handler())
    const rows = body['accounts'] as ClaimedRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ accountId: magicrewAccountId('cn', 'jwt-b'), todayCheckedIn: true, todayCredit: 30 })
    /* 顶层 ok 仍是 true：整批没有全军覆没，提示语里带失败原因。 */
    expect(body['ok']).toBe(true)
  })

  it('指定 accountId 时只回喂该账号', async () => {
    await seedAccounts(['jwt-a', 'jwt-b'])
    stubUpstream({
      'jwt-a': { code: 0, data: { points: 10 } },
      'jwt-b': { code: 0, data: { points: 20 } },
    })
    const { ctx, handler } = fakeContext()
    registerMagicrewRoutes(ctx, { adopted: () => {} })

    const { body } = await post(handler(), { accountId: magicrewAccountId('cn', 'jwt-b') })
    expect(body['accounts']).toEqual([
      { accountId: magicrewAccountId('cn', 'jwt-b'), todayCheckedIn: true, todayCredit: 20 },
    ])
    expect(body['gained']).toBe(20)
  })
})
