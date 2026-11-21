/**
 * OAuth 令牌落盘加密：复用项目既有的 PBKDF2 + AES-GCM 方案。
 *
 * WHY A NODE TWIN
 *
 * `src/client/backup-crypto.ts` 用 WebCrypto 实现了 PBKDF2-SHA256(310k) + AES-256-GCM，
 * 但 WebCrypto 只在浏览器里存在。OAuth 的 device flow 轮询、PKCE loopback 回调、刷新
 * 调度都跑在宿主（Node）侧，所以这里用 `node:crypto` 复刻同一套原语与信封结构，而不是
 * 发明第二种加密格式。
 *
 * 与 backup-crypto.ts 的差异只有两点：
 *   - `format` 用 `dsh-xdpool/oauth-token-encrypted`，避免 OAuth 令牌被误当作备份信封；
 *   - 密钥来源是本机机密（见 {@link loadMachineSecret}），而非用户输入的口令——OAuth 令牌
 *     没有用户口令，用随机生成的属主可读种子文件派生 PBKDF2 口令。
 *
 * 安全边界（与 backup-crypto.ts 一致）：salt 与 iv 每次随机、随信封携带（非秘密）；AES-GCM
 * 自带认证，口令错误或文件被篡改都会硬失败，而不是吐出看似合理的明文。
 *
 * @module dsh-xdpool/oauth-crypto
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pluginDataDir } from './ignored.ts'

/** 令牌信封格式标记：与备份信封（`dsh-xdpool/backup-encrypted`）区分。 */
export const OAUTH_TOKEN_FORMAT = 'dsh-xdpool/oauth-token-encrypted'

/** PBKDF2 迭代次数，与 backup-crypto.ts 一致（OWASP 对 PBKDF2-SHA256 的下限）。 */
export const PBKDF2_ITERATIONS = 310_000

const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
/** AES-GCM 认证标签长度，与 WebCrypto 默认一致。 */
const AUTH_TAG_BYTES = 16

export interface EncryptedToken {
  format: typeof OAUTH_TOKEN_FORMAT
  version: 1
  /** Base64 盐。公开：只需唯一。 */
  salt: string
  /** Base64 AES-GCM IV。公开，且每条消息不复用。 */
  iv: string
  iterations: number
  /** Base64 密文，GCM 标签 16 字节追加在末尾。 */
  data: string
}

function deriveKey(passphrase: Uint8Array, salt: Uint8Array, iterations: number): Buffer {
  return pbkdf2Sync(passphrase, salt, iterations, KEY_BYTES, 'sha256')
}

/** 用 PBKDF2 派生密钥后 AES-256-GCM 加密明文，返回信封。 */
export function encryptToken(plaintext: string, passphrase: Uint8Array): EncryptedToken {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(passphrase, salt, PBKDF2_ITERATIONS)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_BYTES })
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const data = Buffer.concat([body, cipher.getAuthTag()])
  return {
    format: OAUTH_TOKEN_FORMAT,
    version: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    iterations: PBKDF2_ITERATIONS,
    data: data.toString('base64'),
  }
}

/** 解密信封；口令错误或数据被篡改时抛出（AES-GCM 标签校验失败）。 */
export function decryptToken(envelope: EncryptedToken, passphrase: Uint8Array): string {
  const salt = Buffer.from(envelope.salt, 'base64')
  const iv = Buffer.from(envelope.iv, 'base64')
  const iterations = Number.isFinite(envelope.iterations) && envelope.iterations > 0
    ? envelope.iterations
    : PBKDF2_ITERATIONS
  const key = deriveKey(passphrase, salt, iterations)
  const ciphertext = Buffer.from(envelope.data, 'base64')
  const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_BYTES)
  const body = ciphertext.subarray(0, ciphertext.length - AUTH_TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_BYTES })
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/** 是否为本模块的信封（结构判定，不做解密）。 */
export function isEncryptedToken(value: unknown): value is EncryptedToken {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record['format'] === OAUTH_TOKEN_FORMAT
    && typeof record['salt'] === 'string'
    && typeof record['iv'] === 'string'
    && typeof record['data'] === 'string'
}

/** 本机机密种子文件名。 */
const SECRET_FILE = 'oauth-secret.bin'

/** 本机机密种子的绝对路径（供 {@link loadMachineSecret} 默认使用）。 */
export function oauthSecretPath(): string {
  return join(pluginDataDir(), SECRET_FILE)
}

/**
 * 读取或生成本机机密，作为 PBKDF2 的口令。
 *
 * 文件只对属主可读（0o600），内容为 32 字节随机数。生成后原样复用：令牌跨重启仍可解密。
 * 文件存在但长度不足时视为损坏并重建（这会令旧令牌无法解密，属可接受的显式失败而非静默）。
 */
export async function loadMachineSecret(path: string = oauthSecretPath()): Promise<Buffer> {
  try {
    const data = await readFile(path)
    if (data.length >= 32) return data
  } catch {
    // 不存在或不可读，走重建。
  }
  const secret = randomBytes(32)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, secret, { mode: 0o600 })
  await rename(temporary, path)
  return secret
}
