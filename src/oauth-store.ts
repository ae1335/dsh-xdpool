/**
 * OAuth 令牌的加密持久化与到期前刷新调度。
 *
 * 令牌用 {@link encryptToken} 落盘（PBKDF2+AES-GCM，无明文）。调度器在到期前 `leadMs` 触发
 * 一次刷新（注入的 `refresh` 回调，通常是 device flow 的 refresh_token 或 PKCE 的 refresh），
 * 刷新成功重写令牌并重新排期；失败则把该 provider 标记为 `degraded` 并持久化，直到下次登录
 * 或成功刷新清除。
 *
 * 状态只暴露摘要（active / degraded / none + 过期时刻），绝不把明文令牌交回调用方。
 *
 * @module dsh-xdpool/oauth-store
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { decryptToken, encryptToken, isEncryptedToken, loadMachineSecret, oauthSecretPath } from './oauth-crypto.ts'
import { tokenExpiresAt, type OAuthTokenSet } from './oauth-flows.ts'
import { pluginDataDir } from './ignored.ts'

export type TokenStatus = 'none' | 'active' | 'degraded'

export interface OAuthTokenStatus {
  status: TokenStatus
  expiresAt?: number
  degradedReason?: string
}

/** 落盘明文载荷：令牌 + 降级标记（降级随重启保留）。 */
interface StoredPayload {
  token: OAuthTokenSet
  degraded: boolean
  degradedReason?: string
}

/** 令牌数据文件默认名。 */
const TOKENS_FILE = 'oauth-tokens.json'

export interface OAuthTokenManagerOptions {
  /** 本机机密种子路径；默认 {@link oauthSecretPath}。测试注入临时路径。 */
  secretPath?: string
  /** 令牌数据文件路径；默认 pluginDataDir/oauth-tokens.json。测试注入临时路径。 */
  dataPath?: string
  /** 当前时间（ms）；测试注入固定时钟。 */
  now?: () => number
  /** 刷新函数：用旧令牌换新令牌；返回 null 表示刷新被拒绝。 */
  refresh?: (providerId: string, token: OAuthTokenSet) => Promise<OAuthTokenSet | null>
  /** 到期前提前多少毫秒触发刷新。 */
  refreshLeadMs?: number
}

export class OAuthTokenManager {
  private readonly secretPath: string
  private readonly dataPath: string
  private readonly now: () => number
  private readonly refresh: ((providerId: string, token: OAuthTokenSet) => Promise<OAuthTokenSet | null>) | null
  private readonly refreshLeadMs: number
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: OAuthTokenManagerOptions = {}) {
    this.secretPath = options.secretPath ?? oauthSecretPath()
    this.dataPath = options.dataPath ?? join(pluginDataDir(), TOKENS_FILE)
    this.now = options.now ?? (() => Date.now())
    this.refresh = options.refresh ?? null
    this.refreshLeadMs = options.refreshLeadMs ?? 30_000
  }

  private async secret(): Promise<Buffer> {
    return loadMachineSecret(this.secretPath)
  }

  private async readAll(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await readFile(this.dataPath, 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  private async writeAll(all: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.dataPath), { recursive: true })
    const temporary = `${this.dataPath}.tmp`
    await writeFile(temporary, JSON.stringify(all, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.dataPath)
  }

  private async readPayload(providerId: string): Promise<StoredPayload | undefined> {
    const all = await this.readAll()
    const entry = all[providerId]
    if (!isEncryptedToken(entry)) return undefined
    try {
      const parsed = JSON.parse(decryptToken(entry, await this.secret())) as Partial<StoredPayload>
      if (parsed.token === undefined || typeof parsed.token !== 'object') return undefined
      const token = parsed.token as OAuthTokenSet
      if (typeof token.accessToken !== 'string' || token.accessToken === '') return undefined
      const payload: StoredPayload = { token, degraded: parsed.degraded === true }
      if (typeof parsed.degradedReason === 'string') payload.degradedReason = parsed.degradedReason
      return payload
    } catch {
      // 口令错误 / 文件损坏：视为无令牌，而不是假装可用。
      return undefined
    }
  }

  private async writePayload(providerId: string, token: OAuthTokenSet, degraded: boolean, reason?: string): Promise<void> {
    const payload: StoredPayload = { token, degraded }
    if (typeof reason === 'string' && reason !== '') payload.degradedReason = reason
    const all = await this.readAll()
    all[providerId] = encryptToken(JSON.stringify(payload), await this.secret())
    await this.writeAll(all)
  }

  /** 读取并解密令牌（内存态）；无或不可解密返回 undefined。 */
  async load(providerId: string): Promise<OAuthTokenSet | undefined> {
    const payload = await this.readPayload(providerId)
    return payload?.token
  }

  /** 保存令牌，清除降级标记。 */
  async save(providerId: string, token: OAuthTokenSet): Promise<void> {
    await this.writePayload(providerId, token, false, undefined)
  }

  /** 标记降级并持久化（刷新失败后调用）。 */
  async markDegraded(providerId: string, reason: string): Promise<void> {
    const payload = await this.readPayload(providerId)
    if (payload === undefined) return
    await this.writePayload(providerId, payload.token, true, reason)
  }

  /** 删除令牌。 */
  async clear(providerId: string): Promise<void> {
    const all = await this.readAll()
    if (!(providerId in all)) return
    delete all[providerId]
    await this.writeAll(all)
  }

  /** 读取摘要状态（不含明文令牌）。 */
  async status(providerId: string): Promise<OAuthTokenStatus> {
    const payload = await this.readPayload(providerId)
    if (payload === undefined) return { status: 'none' }
    const expiresAt = tokenExpiresAt(payload.token)
    if (payload.degraded) {
      const out: OAuthTokenStatus = { status: 'degraded' }
      if (expiresAt !== undefined) out.expiresAt = expiresAt
      if (payload.degradedReason !== undefined && payload.degradedReason !== '') {
        out.degradedReason = payload.degradedReason
      }
      return out
    }
    const out: OAuthTokenStatus = { status: 'active' }
    if (expiresAt !== undefined) out.expiresAt = expiresAt
    return out
  }

  /**
   * 排期一次到期前刷新。有 refresh 令牌才会排期；无 refresh 令牌则跳过。
   * 重复调用会先取消旧定时器。
   */
  async scheduleRefresh(providerId: string): Promise<void> {
    if (this.refresh === null) return
    const payload = await this.readPayload(providerId)
    if (payload === undefined) return
    const token = payload.token
    if (typeof token.refreshToken !== 'string' || token.refreshToken === '') return
    const expiresAt = tokenExpiresAt(token)
    if (expiresAt === undefined) return
    const delay = Math.max(0, expiresAt - this.now() - this.refreshLeadMs)
    const existing = this.timers.get(providerId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      void this.refreshNow(providerId)
    }, delay)
    this.timers.set(providerId, timer)
  }

  /** 立即执行一次刷新（也由定时器触发）。返回刷新后的摘要状态。 */
  async refreshNow(providerId: string): Promise<OAuthTokenStatus> {
    this.timers.delete(providerId)
    if (this.refresh === null) return this.status(providerId)
    const current = await this.load(providerId)
    if (current === undefined) return { status: 'none' }
    try {
      const next = await this.refresh(providerId, current)
      if (next === null) {
        await this.markDegraded(providerId, '刷新被拒绝（refresh 返回 null）')
        return this.status(providerId)
      }
      await this.save(providerId, next)
      await this.scheduleRefresh(providerId)
      return this.status(providerId)
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.markDegraded(providerId, reason)
      return this.status(providerId)
    }
  }

  /** 清理所有排期定时器（不删令牌）。 */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
