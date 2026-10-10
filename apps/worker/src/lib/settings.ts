/**
 * settings 单行配置的读写。
 *
 * settings 是 singleton（数据库层有 ux_settings_singleton 唯一索引）。
 * 首次访问时自动插入默认行（ics_token 随机生成），
 * 这样「全新数据库直接打开设置页」不需要额外的初始化脚本。
 */

import {
  DEFAULT_AMORTIZE_LIFETIME_MONTHS,
  DEFAULT_BASE_CURRENCY,
  DEFAULT_TIMEZONE,
  nowIso,
  type SettingsRow,
} from '@submgr/core';
import { ICS_TOKEN_BYTES } from '../env.js';
import { firstRow, runStmt } from './db.js';

/** settings 的唯一一行用固定 UUID，方便「第一次写入」时确定 id。 */
export const SETTINGS_ID = '00000000-0000-4000-8000-000000000001';

/** 生成一个新的 ICS 令牌（hex，URL 安全，长度远超 settings 的 16 位下限）。 */
export function newIcsToken(): string {
  const bytes = new Uint8Array(ICS_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 读取 settings；不存在返回 null。 */
export async function loadSettings(db: D1Database): Promise<SettingsRow | null> {
  return firstRow<SettingsRow>(
    db,
    `SELECT * FROM settings WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
  );
}

/**
 * 读取 settings，不存在就插入默认行。
 *
 * 用 `INSERT ... SELECT ... WHERE NOT EXISTS` 而不是 `INSERT OR IGNORE`：
 * 后者会把「CHECK 约束失败」也一起吞掉，出问题时更难查。
 */
export async function ensureSettings(db: D1Database): Promise<SettingsRow> {
  const existing = await loadSettings(db);
  if (existing) return existing;

  await runStmt(
    db,
    `INSERT INTO settings (id, base_currency, timezone, ics_token, amortize_lifetime_months, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM settings WHERE deleted_at IS NULL)`,
    [
      SETTINGS_ID,
      DEFAULT_BASE_CURRENCY,
      DEFAULT_TIMEZONE,
      newIcsToken(),
      DEFAULT_AMORTIZE_LIFETIME_MONTHS,
      nowIso(),
      nowIso(),
    ],
  );

  const created = await loadSettings(db);
  if (!created) {
    throw new Error('settings 初始化失败：插入后仍然读不到行');
  }
  return created;
}

/** 常量时间字符串比较（用于对比 ICS 令牌，避免计时侧信道）。 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db2] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db2);
  let diff = 0;
  for (let i = 0; i < ua.length; i += 1) diff |= (ua[i] as number) ^ (ub[i] as number);
  return diff === 0;
}
