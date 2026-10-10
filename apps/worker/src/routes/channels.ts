/**
 * /api/channels —— 提醒渠道（飞书 / Telegram）。
 *
 * 密钥绝不进 D1（需求硬性要求，migration 里也有 CHECK 兜底）：
 *   - config_json      只放非敏感配置（例如 Telegram 的 chat_id），
 *                      出现 webhook / bot_token / sign_secret / secret_key / password
 *                      这类键名会被拒绝；
 *   - secret_ref       指向 Worker secret 的名字（值在环境变量里）；
 *   - secrets_encrypted AES-256-GCM 密文（主密钥在 env.NOTIFY_SECRET_KEY）。
 * 响应里永远不回显 secrets_encrypted，只告诉调用方「有没有」。
 */

import { Hono } from 'hono';
import {
  nowIso,
  type NotificationChannelRow,
} from '@submgr/core';
import type { Env } from '../env.js';
import { allRows, firstRow, isUniqueViolation, runStmt } from '../lib/db.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import {
  NOTIFICATION_CHANNEL_TYPES,
  has,
  optionalString,
  readJson,
  requiredEnum,
  requiredString,
  type JsonObject,
} from '../lib/validate.js';

export const channelRoutes = new Hono<{ Bindings: Env }>();

/** 与 migration 0004 的 CHECK 完全一致的敏感键名黑名单。 */
const FORBIDDEN_KEYS = ['"webhook', 'bot_token', 'sign_secret', 'secret_key', 'password'];

const SECRET_REF_RE = /^[A-Z][A-Z0-9_]*$/;

function rejectSensitive(configJson: string): void {
  const lower = configJson.toLowerCase();
  for (const needle of FORBIDDEN_KEYS) {
    if (lower.includes(needle)) {
      throw invalid(
        `config_json 里不允许出现「${needle.replace(/"/g, '')}」这类敏感键名：密钥必须放在 secret_ref 指向的 Worker secret 里，或加密后放 secrets_encrypted。`,
      );
    }
  }
}

/** 归一化成 `{"...":...}` 形式的 JSON 对象字符串，并做敏感键名检查。 */
function readConfigJson(body: JsonObject, fallback: string): string {
  if (!has(body, 'config_json')) return fallback;
  const raw = body['config_json'];

  let value: unknown;
  if (raw === null) {
    value = {};
  } else if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw invalid('config_json 不是合法的 JSON');
    }
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    value = raw;
  } else {
    throw invalid('config_json 必须是 JSON 对象（或它的字符串形式）');
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('config_json 必须是 JSON 对象');
  }

  const json = JSON.stringify(value);
  rejectSensitive(json);
  return json;
}

function readSecretRef(body: JsonObject, fallback: string | null): string | null {
  if (!has(body, 'secret_ref')) return fallback;
  const value = optionalString(body, 'secret_ref', { max: 100 }) ?? null;
  if (value !== null && !SECRET_REF_RE.test(value)) {
    throw invalid('secret_ref 只能是环境变量名风格（大写字母、数字、下划线，且以字母开头）');
  }
  return value;
}

function readEncrypted(body: JsonObject, fallback: string | null): string | null {
  if (!has(body, 'secrets_encrypted')) return fallback;
  const value = optionalString(body, 'secrets_encrypted', { max: 10000 }) ?? null;
  return value;
}

function toDto(row: NotificationChannelRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    config_json: row.config_json,
    config: safeParse(row.config_json),
    secret_ref: row.secret_ref,
    has_secrets_encrypted: row.secrets_encrypted !== null && row.secrets_encrypted !== undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

async function loadChannel(db: D1Database, id: string): Promise<NotificationChannelRow> {
  const row = await firstRow<NotificationChannelRow>(
    db,
    `SELECT * FROM notification_channels WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  if (!row) throw notFound(`提醒渠道不存在或已删除：${id}`);
  return row;
}

channelRoutes.get('/', async (c) => {
  const rows = await allRows<NotificationChannelRow>(
    c.env.DB,
    `SELECT * FROM notification_channels WHERE deleted_at IS NULL ORDER BY created_at ASC`,
  );
  return c.json({ items: rows.map(toDto) });
});

channelRoutes.post('/', async (c) => {
  const body = await readJson(c.req.raw);
  const type = requiredEnum(body, 'type', NOTIFICATION_CHANNEL_TYPES);
  const name = requiredString(body, 'name', { max: 100 });
  const configJson = readConfigJson(body, '{}');
  const secretRef = readSecretRef(body, null);
  const encrypted = readEncrypted(body, null);

  if (secretRef === null && encrypted === null) {
    throw invalid('必须至少给出 secret_ref 或 secrets_encrypted（密钥不能明文入库，也不能为空）');
  }

  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    await runStmt(
      c.env.DB,
      `INSERT INTO notification_channels
         (id, type, name, config_json, secret_ref, secrets_encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, type, name, configJson, secretRef, encrypted, now, now],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('duplicate_channel', '渠道名或 secret_ref 已被占用');
    }
    throw invalid(`渠道不满足数据库约束：${err instanceof Error ? err.message : String(err)}`);
  }

  return c.json({ item: toDto(await loadChannel(c.env.DB, id)) }, 201);
});

channelRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const current = await loadChannel(c.env.DB, id);
  const body = await readJson(c.req.raw);

  const sets: string[] = [];
  const params: unknown[] = [];
  const values: Record<string, unknown> = {};
  const push = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    params.push(value);
    values[column] = value;
  };

  if (has(body, 'type')) push('type', requiredEnum(body, 'type', NOTIFICATION_CHANNEL_TYPES));
  if (has(body, 'name')) push('name', requiredString(body, 'name', { max: 100 }));
  if (has(body, 'config_json')) push('config_json', readConfigJson(body, current.config_json));
  if (has(body, 'secret_ref')) push('secret_ref', readSecretRef(body, current.secret_ref));
  if (has(body, 'secrets_encrypted')) {
    push('secrets_encrypted', readEncrypted(body, current.secrets_encrypted));
  }

  if (sets.length === 0) throw invalid('请求体里没有任何可更新的字段');

  const secretRef = ('secret_ref' in values
    ? values['secret_ref']
    : current.secret_ref) as string | null;
  const encrypted = ('secrets_encrypted' in values
    ? values['secrets_encrypted']
    : current.secrets_encrypted) as string | null;
  if (secretRef === null && encrypted === null) {
    throw invalid('secret_ref 与 secrets_encrypted 不能同时清空（密钥来源必须存在）');
  }

  sets.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);

  try {
    await runStmt(c.env.DB, `UPDATE notification_channels SET ${sets.join(', ')} WHERE id = ?`, params);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('duplicate_channel', '渠道名或 secret_ref 已被占用');
    throw invalid(`渠道不满足数据库约束：${err instanceof Error ? err.message : String(err)}`);
  }

  return c.json({ item: toDto(await loadChannel(c.env.DB, id)) });
});

channelRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await loadChannel(c.env.DB, id);
  await runStmt(
    c.env.DB,
    `UPDATE notification_channels SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    [nowIso(), nowIso(), id],
  );
  return c.json({ deleted: true, id });
});
