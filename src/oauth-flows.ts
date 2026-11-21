/**
 * OAuth 2.0 两条认证流：device flow（GitHub Copilot）与 Authorization Code + PKCE loopback
 * （OpenAI）。
 *
 * 所有网络调用都经注入的 `fetch`（默认 `globalThis.fetch`），测试里传 mock；不发起任何真实
 * 网络请求。loopback 回调在 127.0.0.1 随机端口监听，拿到 `code` 即关闭并换取令牌。
 *
 * @module dsh-xdpool/oauth-flows
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { OAuthProviderConfig } from './oauth-providers.ts'

/** 注入的网络函数类型：与 `globalThis.fetch` 同形。 */
export type FetchLike = typeof fetch

/** 一次成功的令牌交换结果。 */
export interface OAuthTokenSet {
  accessToken: string
  refreshToken?: string
  /** 过期秒数；缺失表示未知。 */
  expiresIn?: number
  /** 收到令牌的本地时间（ms epoch）。 */
  receivedAt: number
}

/** 令牌的本地过期时刻（ms epoch）；无 expires_in 时为 undefined。 */
export function tokenExpiresAt(token: OAuthTokenSet): number | undefined {
  if (typeof token.expiresIn !== 'number' || !Number.isFinite(token.expiresIn)) return undefined
  return token.receivedAt + token.expiresIn * 1000
}

/** base64url（无填充），用于 PKCE verifier/challenge 与 state。 */
function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

function tokenFromJson(json: Record<string, unknown>): OAuthTokenSet {
  const accessToken = typeof json['access_token'] === 'string' ? json['access_token'] : ''
  if (accessToken === '') throw new Error('令牌响应缺少 access_token')
  const token: OAuthTokenSet = { accessToken, receivedAt: Date.now() }
  if (typeof json['refresh_token'] === 'string' && json['refresh_token'] !== '') {
    token.refreshToken = json['refresh_token']
  }
  if (typeof json['expires_in'] === 'number' && Number.isFinite(json['expires_in'])) {
    token.expiresIn = json['expires_in']
  }
  return token
}

// ---------------------------------------------------------------------------
// device flow（RFC 8628）
// ---------------------------------------------------------------------------

export interface DeviceFlowStart {
  ok: true
  deviceCode: string
  userCode: string
  verificationUri: string
  /** 完整验证 URL（含 user_code），可直接展示/打开；无则为 undefined。 */
  verificationUriComplete?: string
  intervalSec: number
  /** 设备码过期的本地时刻（ms epoch）。 */
  expiresAt: number
}

export interface DeviceFlowStartError {
  ok: false
  reason: string
}

/** 向设备授权端点发起请求，返回待用户确认的 device/user code。 */
export async function startDeviceFlow(
  config: OAuthProviderConfig,
  fetchImpl: FetchLike = fetch,
): Promise<DeviceFlowStart | DeviceFlowStartError> {
  const body = new URLSearchParams({ client_id: config.clientId, scope: config.scope })
  const response = await fetchImpl(config.authorizationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  })
  if (!response.ok) {
    return { ok: false, reason: `设备授权端点返回 HTTP ${String(response.status)}` }
  }
  const json = await response.json() as Record<string, unknown>
  const deviceCode = typeof json['device_code'] === 'string' ? json['device_code'] : ''
  const userCode = typeof json['user_code'] === 'string' ? json['user_code'] : ''
  const verificationUri = typeof json['verification_uri'] === 'string' ? json['verification_uri'] : ''
  if (deviceCode === '' || userCode === '' || verificationUri === '') {
    return { ok: false, reason: '设备授权响应缺少 device_code / user_code / verification_uri' }
  }
  const intervalSec = typeof json['interval'] === 'number' && json['interval'] > 0 ? json['interval'] : 5
  const expiresIn = typeof json['expires_in'] === 'number' && json['expires_in'] > 0 ? json['expires_in'] : 900
  const start: DeviceFlowStart = {
    ok: true,
    deviceCode,
    userCode,
    verificationUri,
    intervalSec,
    expiresAt: Date.now() + expiresIn * 1000,
  }
  const complete = typeof json['verification_uri_complete'] === 'string' ? json['verification_uri_complete'] : ''
  if (complete !== '') start.verificationUriComplete = complete
  return start
}

export type DevicePollResult =
  | { kind: 'token'; token: OAuthTokenSet }
  | { kind: 'pending'; reason: 'authorization_pending' | 'slow_down' }
  | { kind: 'expired' }
  | { kind: 'error'; reason: string }

/** 轮询令牌端点一次；未授权返回 pending（authorization_pending / slow_down）。 */
export async function pollDeviceTokenOnce(
  config: OAuthProviderConfig,
  deviceCode: string,
  fetchImpl: FetchLike = fetch,
): Promise<DevicePollResult> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
  })
  const response = await fetchImpl(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  })
  if (response.ok) {
    return { kind: 'token', token: tokenFromJson(await response.json() as Record<string, unknown>) }
  }
  if (response.status === 400) {
    const parsed = await response.json().catch(() => ({})) as Record<string, unknown>
    const error = typeof parsed['error'] === 'string' ? parsed['error'] : ''
    if (error === 'authorization_pending') return { kind: 'pending', reason: 'authorization_pending' }
    if (error === 'slow_down') return { kind: 'pending', reason: 'slow_down' }
    if (error === 'expired_token') return { kind: 'expired' }
    if (error === 'access_denied') return { kind: 'error', reason: 'access_denied' }
    return { kind: 'error', reason: error === '' ? 'HTTP 400' : error }
  }
  return { kind: 'error', reason: `HTTP ${String(response.status)}` }
}

// ---------------------------------------------------------------------------
// Authorization Code + PKCE（RFC 7636）+ loopback 回调
// ---------------------------------------------------------------------------

/** PKCE 对：verifier（本地保密）与 challenge（S256 哈希后 base64url，随授权 URL 发送）。 */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier, 'utf8').digest())
  return { verifier, challenge }
}

/** 组装授权 URL（authorization_endpoint + 查询参数）。 */
export function buildAuthorizeUrl(
  config: OAuthProviderConfig,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  if (config.scope !== '') params.set('scope', config.scope)
  return `${config.authorizationEndpoint}?${params.toString()}`
}

/** 用 code + verifier 在令牌端点换取令牌。 */
export async function exchangeCode(
  config: OAuthProviderConfig,
  code: string,
  verifier: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  const response = await fetchImpl(config.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  })
  if (!response.ok) throw new Error(`令牌端点返回 HTTP ${String(response.status)}`)
  return tokenFromJson(await response.json() as Record<string, unknown>)
}

/** 回调成功后展示的页面。 */
const LOOPBACK_SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>登录成功</title></head>' +
  '<body><p>授权成功，可关闭此页。</p></body></html>'

interface LoopbackServer {
  port: number
  close: () => Promise<void>
}

function startLoopbackServer(onCallback: (params: URLSearchParams) => void): Promise<LoopbackServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/callback') {
        onCallback(url.searchParams)
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(LOOPBACK_SUCCESS_HTML)
        return
      }
      response.writeHead(404)
      response.end()
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => server.close(error => (error ? rej(error) : res()))),
      })
    })
  })
}

export interface PkceLoopbackOptions {
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** 授权 URL 组装完成后回调（用于打开浏览器 / 展示给用户）。 */
  onAuthorizeUrl?: (url: string) => void
}

/**
 * 跑完整 PKCE + loopback 流程：起本地回调、组装授权 URL、等回调 code、换令牌。
 *
 * `onAuthorizeUrl` 是唯一把 URL 交给用户侧的出口；URL 里的 state 会被校验，防跨站回调。
 */
export async function runPkceLoopback(
  config: OAuthProviderConfig,
  options: PkceLoopbackOptions = {},
): Promise<OAuthTokenSet> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 300_000
  const { verifier, challenge } = generatePkce()
  const state = base64Url(randomBytes(16))

  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const server = await startLoopbackServer(params => {
    const returnedState = params.get('state')
    const code = params.get('code')
    if (returnedState !== null && returnedState !== state) {
      rejectCode(new Error('OAuth state 校验失败'))
      return
    }
    if (typeof code === 'string' && code !== '') resolveCode(code)
    else rejectCode(new Error('回调缺少 code'))
  })

  try {
    const redirectUri = `http://127.0.0.1:${String(server.port)}/callback`
    const authorizeUrl = buildAuthorizeUrl(config, redirectUri, challenge, state)
    options.onAuthorizeUrl?.(authorizeUrl)

    const timer = setTimeout(() => rejectCode(new Error('等待授权回调超时')), timeoutMs)
    try {
      const code = await codePromise
      return await exchangeCode(config, code, verifier, redirectUri, fetchImpl)
    } finally {
      clearTimeout(timer)
    }
  } finally {
    await server.close()
  }
}
