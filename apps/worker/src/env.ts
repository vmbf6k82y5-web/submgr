/**
 * Worker 运行时绑定（与 wrangler.toml 一一对应）。
 *
 * 密钥铁律：任何密钥都只从环境变量 / secret 读取，绝不写进 D1。
 *   - ADMIN_TOKEN        /api 的 Bearer 令牌
 *   - NOTIFY_SECRET_KEY  notification_channels.secrets_encrypted 的解密主密钥
 *   - env[secret_ref]    notification_channels.secret_ref 指向的命名 secret
 */

export interface Env {
  /** D1 数据库绑定。 */
  DB: D1Database;

  /** /api 的 Bearer 鉴权令牌。未配置时所有 /api 请求返回 500（fail closed）。 */
  ADMIN_TOKEN?: string;

  /** 静态资源绑定（wrangler.toml 的 [assets]）。 */
  ASSETS?: Fetcher;

  /** AES-256-GCM 主密钥（base64，32 字节），用于解密 secrets_encrypted。 */
  NOTIFY_SECRET_KEY?: string;

  /** 汇率数据源根地址，默认 https://open.er-api.com/v6/latest/USD。 */
  FX_API_BASE?: string;

  /**
   * 命名 secret：notification_channels.secret_ref 就是这里的键名。
   * 值是一个 JSON 字符串，例如
   *   FEISHU_MAIN   = {"webhook_url":"...","sign_secret":"..."}
   *   TELEGRAM_MAIN = {"bot_token":"...","chat_id":"..."}
   */
  [secretRef: string]: unknown;
}

/** 默认汇率数据源（适配器模式下的默认适配器）。 */
export const DEFAULT_FX_API_BASE = 'https://open.er-api.com/v6/latest/USD';

/** ICS 订阅地址的默认令牌长度（settings.ics_token 至少 16 位）。 */
export const ICS_TOKEN_BYTES = 24;
