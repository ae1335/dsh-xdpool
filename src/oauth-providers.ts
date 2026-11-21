/**
 * OAuth 提供方的协议配置表。
 *
 * 只放「能从 registry 或提供方官方公开文档核实」的常量。registry 里 `github_copilot` 与
 * `openai` 两条目只给了 `auth.url`（文档链接）与 `baseUrl`，没给 OAuth 端点，因此这里的
 * 端点来自各提供方官方 OAuth 文档的标准公开地址，逐条标注来源；`client_id` 与 `scope`
 * 属于部署时配置，不进常量表（见 {@link OAuthProviderConfig} 的可配置字段，由设置页 / env
 * 注入覆盖）。
 *
 * @module dsh-xdpool/oauth-providers
 */

/** 支持的两种授权流：device flow（RFC 8628）与 Authorization Code + PKCE（RFC 7636）。 */
export type OAuthFlowKind = 'device' | 'pkce'

export interface OAuthProviderConfig {
  providerId: string
  flow: OAuthFlowKind
  /**
   * device flow：设备授权端点（RFC 8628 §3.1）。
   * pkce：授权端点（authorization_endpoint，浏览器跳转）。
   */
  authorizationEndpoint: string
  /** 令牌端点（token_endpoint）。 */
  tokenEndpoint: string
  /** device flow 的 user_code 验证页（展示给用户打开）。 */
  verificationUri?: string
  /** 授权申请的 scope（可空；空则由调用方注入）。 */
  scope: string
  /** OAuth client_id，部署时由设置页 / env 注入；空表示尚未配置。 */
  clientId: string
}

export const OAUTH_PROVIDERS: Readonly<Record<string, OAuthProviderConfig>> = Object.freeze({
  github_copilot: Object.freeze({
    providerId: 'github_copilot',
    flow: 'device',
    // 来源：GitHub OAuth device flow 官方文档（registry 的 auth.url 指向
    // https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate）。
    // 标准公开端点（RFC 8628 device grant）：设备授权 https://github.com/login/device/code，
    // 令牌 https://github.com/login/oauth/access_token，验证页 https://github.com/login/device。
    authorizationEndpoint: 'https://github.com/login/device/code',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    verificationUri: 'https://github.com/login/device',
    scope: 'read:user',
    clientId: '',
  }),
  openai: Object.freeze({
    providerId: 'openai',
    flow: 'pkce',
    // 来源：OpenAI ChatGPT 账号 OAuth 官方文档（registry 的 auth.url 指向
    // https://learn.chatgpt.com/docs/auth）。标准公开端点 auth.openai.com：
    // 授权 https://auth.openai.com/authorize，令牌 https://auth.openai.com/oauth/token。
    authorizationEndpoint: 'https://auth.openai.com/authorize',
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
    scope: 'openid profile email offline_access',
    clientId: '',
  }),
})

/** 按 provider id 取配置，未知返回 null。 */
export function oauthProviderConfig(providerId: string): OAuthProviderConfig | null {
  return OAUTH_PROVIDERS[providerId] ?? null
}
