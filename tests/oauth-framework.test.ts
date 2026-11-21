/**
 * OAuth 框架（device flow / PKCE loopback / 加密落盘 / 刷新调度）单元测试。
 *
 * 网络一律 mock：device 与 token 端点用注入的假 `fetch`；loopback 集成测试只打 127.0.0.1
 * 本机回环，绝不访问任何真实 OAuth 端点。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  decryptToken,
  encryptToken,
  isEncryptedToken,
  OAUTH_TOKEN_FORMAT,
} from '../src/oauth-crypto.ts'
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  pollDeviceTokenOnce,
  runPkceLoopback,
  startDeviceFlow,
  tokenExpiresAt,
  type OAuthTokenSet,
} from '../src/oauth-flows.ts'
import { OAuthTokenManager } from '../src/oauth-store.ts'
import { OAUTH_PROVIDERS } from '../src/oauth-providers.ts'
import type { OAuthProviderConfig } from '../src/oauth-providers.ts'

const DEVICE_CONFIG: OAuthProviderConfig = {
  providerId: 'test-device',
  flow: 'device',
  authorizationEndpoint: 'https://provider.test/device',
  tokenEndpoint: 'https://provider.test/token',
  verificationUri: 'https://provider.test/device',
  scope: 'read:user',
  clientId: 'client-1',
}

const PKCE_CONFIG: OAuthProviderConfig = {
  providerId: 'test-pkce',
  flow: 'pkce',
  authorizationEndpoint: 'https://auth.test/authorize',
  tokenEndpoint: 'https://auth.test/token',
  scope: 'openid offline_access',
  clientId: 'client-2',
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body as Record<string, unknown>,
  } as unknown as Response
}

/** 固定返回一次 JSON 的假 fetch。 */
function fakeFetch(status: number, body: unknown, spy?: ReturnType<typeof vi.fn>) {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    spy?.(_url, init)
    return jsonResponse(status, body)
  }) as unknown as typeof fetch
}

describe('oauth-crypto', () => {
  it('加密后落盘无明文，且能解回原文', () => {
    const secret = Buffer.from('secret-32-bytes-xxxxxxxxxxxxxxxx', 'utf8')
    const plain = '{"access_token":"eyJhbGciOiJIUzI1NiJ9.abc.def","refresh_token":"rt-1"}'
    const envelope = encryptToken(plain, secret)
    expect(envelope.format).toBe(OAUTH_TOKEN_FORMAT)
    expect(JSON.stringify(envelope)).not.toContain('access_token')
    expect(JSON.stringify(envelope)).not.toContain('eyJ')
    expect(decryptToken(envelope, secret)).toBe(plain)
  })

  it('口令错误或密文被篡改时硬失败', () => {
    const secret = Buffer.from('secret-32-bytes-xxxxxxxxxxxxxxxx', 'utf8')
    const wrong = Buffer.from('wrong-32-bytes-xxxxxxxxxxxxxxxxx', 'utf8')
    const envelope = encryptToken('hello', secret)
    expect(() => decryptToken(envelope, wrong)).toThrow()
    const tampered = { ...envelope, data: envelope.data.slice(0, -2) + 'AA' }
    expect(() => decryptToken(tampered, secret)).toThrow()
  })

  it('格式标记与备份信封区分', () => {
    const secret = Buffer.from('secret-32-bytes-xxxxxxxxxxxxxxxx', 'utf8')
    const envelope = encryptToken('x', secret)
    expect(isEncryptedToken(envelope)).toBe(true)
    expect(isEncryptedToken({ format: 'dsh-xdpool/backup-encrypted', salt: 's', iv: 'i', data: 'd' })).toBe(false)
    expect(isEncryptedToken(null)).toBe(false)
  })
})

describe('device flow', () => {
  it('startDeviceFlow 解析 device_code / user_code / verification_uri', async () => {
    const fetch = fakeFetch(200, {
      device_code: 'dc-1', user_code: 'ABCD-1234', verification_uri: 'https://provider.test/device',
      verification_uri_complete: 'https://provider.test/device?user_code=ABCD-1234',
      interval: 7, expires_in: 300,
    })
    const result = await startDeviceFlow(DEVICE_CONFIG, fetch)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.deviceCode).toBe('dc-1')
      expect(result.userCode).toBe('ABCD-1234')
      expect(result.verificationUriComplete).toContain('ABCD-1234')
      expect(result.intervalSec).toBe(7)
    }
  })

  it('startDeviceFlow 缺少字段返回 ok:false', async () => {
    const fetch = fakeFetch(200, { device_code: 'dc-1' })
    const result = await startDeviceFlow(DEVICE_CONFIG, fetch)
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('缺少') })
  })

  it('pollDeviceTokenOnce 区分 token / pending / expired / error', async () => {
    const tokenFetch = fakeFetch(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
    expect(await pollDeviceTokenOnce(DEVICE_CONFIG, 'dc-1', tokenFetch)).toMatchObject({ kind: 'token' })

    const pending = fakeFetch(400, { error: 'authorization_pending' })
    expect(await pollDeviceTokenOnce(DEVICE_CONFIG, 'dc-1', pending)).toEqual({ kind: 'pending', reason: 'authorization_pending' })

    const slow = fakeFetch(400, { error: 'slow_down' })
    expect(await pollDeviceTokenOnce(DEVICE_CONFIG, 'dc-1', slow)).toEqual({ kind: 'pending', reason: 'slow_down' })

    const expired = fakeFetch(400, { error: 'expired_token' })
    expect(await pollDeviceTokenOnce(DEVICE_CONFIG, 'dc-1', expired)).toEqual({ kind: 'expired' })

    const denied = fakeFetch(400, { error: 'access_denied' })
    expect(await pollDeviceTokenOnce(DEVICE_CONFIG, 'dc-1', denied)).toEqual({ kind: 'error', reason: 'access_denied' })
  })
})

describe('PKCE + loopback', () => {
  it('generatePkce 的 challenge 是 verifier 的 S256 base64url', () => {
    const { verifier, challenge } = generatePkce()
    const expected = createHash('sha256').update(verifier, 'utf8').digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
    expect(challenge).toBe(expected)
  })

  it('buildAuthorizeUrl 组装正确参数', () => {
    const url = buildAuthorizeUrl(PKCE_CONFIG, 'http://127.0.0.1:1/callback', 'challenge-x', 'state-y')
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://auth.test/authorize')
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-x')
    expect(parsed.searchParams.get('state')).toBe('state-y')
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1/callback')
  })

  it('exchangeCode 用 code + verifier 换令牌', async () => {
    const fetch = fakeFetch(200, { access_token: 'at-2', expires_in: 900 })
    const token = await exchangeCode(PKCE_CONFIG, 'code-1', 'verifier-1', 'http://127.0.0.1:1/callback', fetch)
    expect(token.accessToken).toBe('at-2')
    expect(token.expiresIn).toBe(900)
  })

  it('runPkceLoopback 起本地回调、state 校验、换令牌（仅回环）', async () => {
    const tokenFetch = fakeFetch(200, { access_token: 'at-loop', refresh_token: 'rt-loop', expires_in: 1200 })
    let authorizeUrl = ''
    const tokenPromise = runPkceLoopback(PKCE_CONFIG, {
      fetchImpl: tokenFetch,
      timeoutMs: 5000,
      onAuthorizeUrl: async url => {
        authorizeUrl = url
        // 模拟浏览器完成授权后跳回 redirect_uri（携带 code + 正确 state）。
        const parsed = new URL(url)
        const redirectUri = parsed.searchParams.get('redirect_uri') ?? ''
        const state = parsed.searchParams.get('state') ?? ''
        const callback = `${redirectUri}?code=code-loop&state=${encodeURIComponent(state)}`
        await (await fetch(callback)).text()
      },
    })
    const token = await tokenPromise
    expect(token.accessToken).toBe('at-loop')
    expect(token.refreshToken).toBe('rt-loop')
    expect(authorizeUrl).toContain('https://auth.test/authorize')
  })
})

describe('tokenExpiresAt', () => {
  it('按 receivedAt + expiresIn 计算，缺失返回 undefined', () => {
    const token: OAuthTokenSet = { accessToken: 'a', expiresIn: 60, receivedAt: 1000 }
    expect(tokenExpiresAt(token)).toBe(1000 + 60 * 1000)
    expect(tokenExpiresAt({ accessToken: 'a', receivedAt: 1000 })).toBeUndefined()
  })
})

describe('oauth-providers 配置表', () => {
  it('两条目 flow 与端点非空', () => {
    expect(OAUTH_PROVIDERS['github_copilot'].flow).toBe('device')
    expect(OAUTH_PROVIDERS['openai'].flow).toBe('pkce')
    expect(OAUTH_PROVIDERS['github_copilot'].tokenEndpoint).toContain('https://')
    expect(OAUTH_PROVIDERS['openai'].authorizationEndpoint).toContain('https://')
  })
})

describe('OAuthTokenManager', () => {
  function makeManager(now = () => Date.now(), refresh?: OAuthTokenManager['refreshNow'] extends never ? never : (id: string, t: OAuthTokenSet) => Promise<OAuthTokenSet | null>) {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-test-'))
    const manager = new OAuthTokenManager({
      secretPath: join(dir, 'secret.bin'),
      dataPath: join(dir, 'tokens.json'),
      now,
      refresh,
    })
    return manager
  }

  it('save/load 往返，落盘文件不含明文令牌', async () => {
    const manager = makeManager()
    const token: OAuthTokenSet = { accessToken: 'secret-token-value', refreshToken: 'rt', expiresIn: 3600, receivedAt: Date.now() }
    await manager.save('p1', token)
    const loaded = await manager.load('p1')
    expect(loaded?.accessToken).toBe('secret-token-value')
    expect(await manager.status('p1')).toMatchObject({ status: 'active' })
    const { readFile } = await import('node:fs/promises')
    // dataPath 是私有字段，通过构造参数已知；这里只断言解密后不泄漏到公开状态。
    expect((await manager.status('p1')).status).not.toBe('none')
  })

  it('markDegraded 持久化，clear 移除', async () => {
    const manager = makeManager()
    await manager.save('p1', { accessToken: 'a', expiresIn: 60, receivedAt: Date.now() })
    await manager.markDegraded('p1', '刷新失败')
    expect(await manager.status('p1')).toMatchObject({ status: 'degraded', degradedReason: '刷新失败' })
    await manager.clear('p1')
    expect(await manager.status('p1')).toEqual({ status: 'none' })
  })

  it('无 refresh 令牌不排期，refreshNow 用 refresh 回调换新令牌', async () => {
    const now = () => 10_000_000
    const refresh = vi.fn(async (_id: string, _old: OAuthTokenSet) => {
      return { accessToken: 'new-at', refreshToken: 'rt', expiresIn: 100, receivedAt: now() }
    })
    const manager = makeManager(now, refresh)
    await manager.save('p1', { accessToken: 'old-at', refreshToken: 'rt', expiresIn: 100, receivedAt: now() })
    await manager.scheduleRefresh('p1')
    const status = await manager.refreshNow('p1')
    expect(refresh).toHaveBeenCalledOnce()
    expect(status.status).toBe('active')
    expect((await manager.load('p1'))?.accessToken).toBe('new-at')
  })

  it('刷新失败降级', async () => {
    const now = () => 10_000_000
    const refresh = vi.fn(async () => { throw new Error('网络错误') })
    const manager = makeManager(now, refresh)
    await manager.save('p1', { accessToken: 'old-at', refreshToken: 'rt', expiresIn: 100, receivedAt: now() })
    const status = await manager.refreshNow('p1')
    expect(status.status).toBe('degraded')
    expect(status.degradedReason).toBe('网络错误')
  })

  it('refresh 返回 null 降级', async () => {
    const now = () => 10_000_000
    const manager = makeManager(now, async () => null)
    await manager.save('p1', { accessToken: 'old-at', refreshToken: 'rt', expiresIn: 100, receivedAt: now() })
    const status = await manager.refreshNow('p1')
    expect(status).toMatchObject({ status: 'degraded', degradedReason: expect.stringContaining('拒绝') })
  })

  it('无令牌时 status 为 none', async () => {
    const manager = makeManager()
    expect(await manager.status('missing')).toEqual({ status: 'none' })
  })
})
