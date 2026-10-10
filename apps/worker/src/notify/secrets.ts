/**
 * 提醒渠道的密钥解析。
 *
 * 需求：密钥不许明文进 D1，只从环境变量 / secret 读。两种落地方式：
 *   * secret_ref         -> env[secret_ref]，值是一个 JSON 字符串；
 *   * secrets_encrypted  -> 用 env.NOTIFY_SECRET_KEY（AES-256-GCM）解密。
 * config_json 里的非敏感配置（例如 Telegram 的 chat_id）作为默认值合并进来，
 * secret 里的同名字段优先。
 *
 * 所有失败都返回结构化的 error 字符串，由调用方写进 reminder_log（result = 'failed'），
 * 绝不把 webhook / token 本身写进日志。
 */

import type { NotificationChannelRow } from '@submgr/core';
import type { Env } from '../env.js';

export type ChannelSecret = Record<string, unknown>;

export interface SecretResolution {
  secret: ChannelSecret | null;
  error: string | null;
}

function parseConfig(json: string): ChannelSecret {
  try {
    const parsed = JSON.parse(json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ChannelSecret;
    }
    return {};
  } catch {
    return {};
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 解密 secrets_encrypted。
 *
 * 密文格式（部署时按此格式生成）：base64( iv(12 字节) || AES-256-GCM 密文与 tag )。
 * 主密钥 NOTIFY_SECRET_KEY = base64(32 字节原始密钥)。
 */
export async function decryptSecrets(masterBase64: string, payloadBase64: string): Promise<ChannelSecret> {
  const master = base64ToBytes(masterBase64);
  if (master.length !== 32) {
    throw new Error('NOTIFY_SECRET_KEY 必须是 32 字节 AES-256 密钥的 base64 编码');
  }
  const payload = base64ToBytes(payloadBase64);
  if (payload.length <= 12) throw new Error('secrets_encrypted 密文过短（至少要有 12 字节 IV + 密文）');

  const key = await crypto.subtle.importKey('raw', master, 'AES-GCM', false, ['decrypt']);
  const iv = payload.slice(0, 12);
  const ciphertext = payload.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  const text = new TextDecoder().decode(plain);

  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('解密后的密钥不是 JSON 对象');
  }
  return parsed as ChannelSecret;
}

/** 解析某个渠道要用的密钥（config_json 作为默认值合并，secret 优先）。 */
export async function resolveChannelSecret(
  env: Env,
  channel: NotificationChannelRow,
): Promise<SecretResolution> {
  const config = parseConfig(channel.config_json);

  if (channel.secret_ref) {
    const raw = env[channel.secret_ref];
    if (typeof raw !== 'string' || raw.trim() === '') {
      return {
        secret: null,
        error: `渠道引用的 secret「${channel.secret_ref}」在环境变量里不存在或为空（请用 wrangler secret put 配置）`,
      };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { secret: null, error: `secret「${channel.secret_ref}」的内容不是 JSON 对象` };
      }
      return { secret: { ...config, ...(parsed as ChannelSecret) }, error: null };
    } catch {
      return { secret: null, error: `secret「${channel.secret_ref}」不是合法的 JSON` };
    }
  }

  if (channel.secrets_encrypted) {
    const master = env.NOTIFY_SECRET_KEY;
    if (typeof master !== 'string' || master.trim() === '') {
      return {
        secret: null,
        error: '渠道使用 secrets_encrypted，但环境变量 NOTIFY_SECRET_KEY 未配置',
      };
    }
    try {
      const decrypted = await decryptSecrets(master, channel.secrets_encrypted);
      return { secret: { ...config, ...decrypted }, error: null };
    } catch (err) {
      return {
        secret: null,
        error: `解密 secrets_encrypted 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { secret: null, error: '渠道既没有 secret_ref 也没有 secrets_encrypted，无法取得密钥' };
}

/** 取字符串字段（缺失/类型不对时返回 null）。 */
export function secretString(secret: ChannelSecret | null, field: string): string | null {
  if (!secret) return null;
  const value = secret[field];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
