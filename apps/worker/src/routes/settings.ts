/**
 * /api/settings —— 全局配置（单行）。
 *
 * ics_token 可以显式设置，也可以用 `reset_ics_token: true` 让服务端重新生成；
 * 令牌只影响 /ics/:token.ics，不需要重新部署。
 */

import { Hono } from 'hono';
import {
  DEFAULT_AMORTIZE_LIFETIME_MONTHS,
  nowIso,
  type SettingsRow,
} from '@submgr/core';
import type { Env } from '../env.js';
import { runStmt } from '../lib/db.js';
import { invalid } from '../lib/errors.js';
import { ensureSettings, loadSettings, newIcsToken } from '../lib/settings.js';
import {
  has,
  optionalBool,
  optionalInt,
  optionalTimezone,
  readJson,
  requiredCurrency,
  requiredString,
} from '../lib/validate.js';

export const settingsRoutes = new Hono<{ Bindings: Env }>();

/** ICS 令牌最短长度（与 migration 的 CHECK 一致）。 */
const ICS_TOKEN_MIN_LENGTH = 16;

function toDto(row: SettingsRow): Record<string, unknown> {
  return {
    id: row.id,
    base_currency: row.base_currency,
    timezone: row.timezone,
    ics_token: row.ics_token,
    ics_path: `/ics/${row.ics_token}.ics`,
    amortize_lifetime_months: row.amortize_lifetime_months,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

settingsRoutes.get('/', async (c) => {
  const row = await ensureSettings(c.env.DB);
  return c.json({ item: toDto(row) });
});

settingsRoutes.put('/', async (c) => {
  const body = await readJson(c.req.raw);
  await ensureSettings(c.env.DB);
  const current = await loadSettings(c.env.DB);
  if (!current) throw invalid('settings 初始化失败');

  const sets: string[] = [];
  const params: unknown[] = [];

  if (has(body, 'base_currency')) {
    sets.push('base_currency = ?');
    params.push(requiredCurrency(body, 'base_currency'));
  }
  if (has(body, 'timezone')) {
    sets.push('timezone = ?');
    params.push(optionalTimezone(body, 'timezone'));
  }
  if (has(body, 'amortize_lifetime_months')) {
    sets.push('amortize_lifetime_months = ?');
    params.push(
      optionalInt(body, 'amortize_lifetime_months', { min: 0, max: 1200 }) ??
        DEFAULT_AMORTIZE_LIFETIME_MONTHS,
    );
  }

  const resetToken = optionalBool(body, 'reset_ics_token') ?? false;
  if (resetToken && has(body, 'ics_token')) {
    throw invalid('reset_ics_token 与 ics_token 不能同时出现');
  }
  if (resetToken) {
    sets.push('ics_token = ?');
    params.push(newIcsToken());
  } else if (has(body, 'ics_token')) {
    const token = requiredString(body, 'ics_token', { max: 200, trim: false });
    if (token.length < ICS_TOKEN_MIN_LENGTH) {
      throw invalid(`ics_token 至少需要 ${ICS_TOKEN_MIN_LENGTH} 个字符`);
    }
    if (!/^[A-Za-z0-9._~-]+$/.test(token)) {
      throw invalid('ics_token 只能包含字母、数字以及 . _ ~ -（要放进 URL 路径里）');
    }
    sets.push('ics_token = ?');
    params.push(token);
  }

  if (sets.length === 0) throw invalid('请求体里没有任何可更新的字段');

  sets.push('updated_at = ?');
  params.push(nowIso());
  params.push(current.id);

  try {
    await runStmt(c.env.DB, `UPDATE settings SET ${sets.join(', ')} WHERE id = ?`, params);
  } catch (err) {
    // ux_settings_ics_token 唯一索引：理论上只有一行，走到这里说明数据被手工改乱了
    throw invalid(`settings 更新被数据库拒绝：${err instanceof Error ? err.message : String(err)}`);
  }

  const updated = await ensureSettings(c.env.DB);
  return c.json({ item: toDto(updated) });
});

/** 便捷入口：POST /api/settings/reset-ics-token 等价于 PUT { reset_ics_token: true }。 */
settingsRoutes.post('/reset-ics-token', async (c) => {
  const row = await ensureSettings(c.env.DB);
  await runStmt(
    c.env.DB,
    `UPDATE settings SET ics_token = ?, updated_at = ? WHERE id = ?`,
    [newIcsToken(), nowIso(), row.id],
  );
  const updated = await ensureSettings(c.env.DB);
  return c.json({ item: toDto(updated) });
});
