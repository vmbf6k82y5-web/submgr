/**
 * 提醒发送：飞书（带签名）与 Telegram。
 *
 * 适配器模式：新增渠道 = 新增一个 `sendXxx(secret, text, deps)`，
 * 在 sendToChannel 里加一个分支即可；渠道差异不会渗进调度逻辑。
 *
 * deps.fetch / deps.now 可注入，因此单测里完全不发真实请求。
 */

import type { NotificationChannelRow } from '@submgr/core';
import type { Env } from '../env.js';
import { resolveChannelSecret, secretString, type ChannelSecret } from './secrets.js';

export interface NotifyDeps {
  /** 默认 globalThis.fetch；测试里注入假实现。 */
  fetch: typeof fetch;
  /** 默认 () => new Date()；测试里固定时间。 */
  now: () => Date;
}

export const defaultNotifyDeps: NotifyDeps = {
  fetch: (...args) => fetch(...args),
  now: () => new Date(),
};

export interface SendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 飞书自定义机器人的签名。
 *
 * 官方算法：string_to_sign = `${timestamp}\n${secret}`，
 * 用它作为 HMAC-SHA256 的 key、空串作为消息，结果 base64。
 */
export async function feishuSign(timestamp: string, signSecret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(`${timestamp}\n${signSecret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(''));
  return bytesToBase64(new Uint8Array(signature));
}

/** 组装飞书的文本消息体（带签名时为 4 个字段）。 */
export async function buildFeishuPayload(
  text: string,
  secret: ChannelSecret,
  now: Date,
): Promise<{ timestamp?: string; sign?: string; msg_type: string; content: { text: string } }> {
  const base = { msg_type: 'text', content: { text } };
  const signSecret = secretString(secret, 'sign_secret');
  if (signSecret === null) return base;

  const timestamp = String(Math.floor(now.getTime() / 1000));
  return { timestamp, sign: await feishuSign(timestamp, signSecret), ...base };
}

async function readJsonSafe(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/** 发送到飞书自定义机器人。 */
export async function sendFeishu(
  secret: ChannelSecret,
  text: string,
  deps: NotifyDeps,
): Promise<SendResult> {
  const webhookUrl = secretString(secret, 'webhook_url');
  if (webhookUrl === null) {
    return { ok: false, status: null, error: '飞书渠道缺少 webhook_url（应放在 secret_ref 指向的 secret 里）' };
  }

  let response: Response;
  try {
    const payload = await buildFeishuPayload(text, secret, deps.now());
    response = await deps.fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, status: null, error: `请求飞书失败：${err instanceof Error ? err.message : String(err)}` };
  }

  const body = (await readJsonSafe(response)) as Record<string, unknown>;
  const code = body['code'] ?? body['StatusCode'];
  const message = body['msg'] ?? body['StatusMessage'] ?? '';

  if (!response.ok) {
    return { ok: false, status: response.status, error: `飞书返回 HTTP ${response.status}：${String(message)}` };
  }
  if (code !== undefined && code !== 0 && code !== '0') {
    return { ok: false, status: response.status, error: `飞书返回业务错误 code=${String(code)} msg=${String(message)}` };
  }
  return { ok: true, status: response.status, error: null };
}

/** 发送到 Telegram。 */
export async function sendTelegram(
  secret: ChannelSecret,
  text: string,
  deps: NotifyDeps,
): Promise<SendResult> {
  const botToken = secretString(secret, 'bot_token');
  const chatId = secretString(secret, 'chat_id');
  if (botToken === null) return { ok: false, status: null, error: 'Telegram 渠道缺少 bot_token' };
  if (chatId === null) return { ok: false, status: null, error: 'Telegram 渠道缺少 chat_id' };

  let response: Response;
  try {
    response = await deps.fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: `请求 Telegram 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const body = (await readJsonSafe(response)) as Record<string, unknown>;
  if (!response.ok || body['ok'] !== true) {
    const description = body['description'] ?? `HTTP ${response.status}`;
    return { ok: false, status: response.status, error: `Telegram 返回失败：${String(description)}` };
  }
  return { ok: true, status: response.status, error: null };
}

/** 按渠道类型分发。 */
export async function sendToChannel(
  env: Env,
  channel: NotificationChannelRow,
  text: string,
  deps: NotifyDeps = defaultNotifyDeps,
): Promise<SendResult> {
  const { secret, error } = await resolveChannelSecret(env, channel);
  if (secret === null) return { ok: false, status: null, error };

  switch (channel.type) {
    case 'feishu':
      return sendFeishu(secret, text, deps);
    case 'telegram':
      return sendTelegram(secret, text, deps);
    default:
      return { ok: false, status: null, error: `不支持的渠道类型：${String(channel.type)}` };
  }
}
