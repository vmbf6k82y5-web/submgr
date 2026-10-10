/**
 * /api/charges —— 扣款记录。
 *
 * 口径：
 *   * 通过接口录入的记录 source 一律为 'manual'（'auto' 只由 Cron 生成，
 *     这样才能保住 ux_charges_auto_daily「每天每订阅最多一条自动扣款」的幂等语义）；
 *   * 任何写入都用「扣款当天」的汇率把金额冻结成基准币种
 *     （fx_rate_to_base / base_currency / base_amount_minor 三个字段一起写）；
 *   * 缺汇率时不伪造数字：三个字段留空，并在响应里给出 fx_warning。
 */

import { Hono } from 'hono';
import {
  CHARGE_STATUSES,
  nowIso,
  type ChargeRow,
  type ChargeStatus,
} from '@submgr/core';
import type { Env } from '../env.js';
import { allRows, firstRow, isConstraintViolation, runStmt } from '../lib/db.js';
import { invalid, notFound } from '../lib/errors.js';
import { freezeAmount } from '../lib/fx.js';
import { ensureSettings } from '../lib/settings.js';
import {
  has,
  optionalDateOnly,
  optionalEnum,
  optionalInt,
  optionalString,
  queryDateOnly,
  queryInt,
  readJson,
  requiredCurrency,
  requiredDateOnly,
  requiredInt,
  requiredString,
  type ChargeStatus as ChargeStatusInput,
  type JsonObject,
} from '../lib/validate.js';

export const chargeRoutes = new Hono<{ Bindings: Env }>();

interface ChargeWithName extends ChargeRow {
  subscription_name: string;
}

/** 取设置里的基准币种（settings 缺失时自动补默认行）。 */
async function baseCurrencyOf(db: D1Database): Promise<string> {
  const settings = await ensureSettings(db);
  return settings.base_currency;
}

async function assertSubscription(db: D1Database, id: string): Promise<void> {
  const row = await firstRow<{ id: string }>(
    db,
    `SELECT id FROM subscriptions WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  if (!row) throw invalid(`subscription_id 指向的订阅不存在或已删除：${id}`);
}

/** version_id 必须属于同一个订阅，否则趋势按周期分组时会张冠李戴。 */
async function assertVersionBelongsTo(
  db: D1Database,
  versionId: string,
  subscriptionId: string,
): Promise<void> {
  const row = await firstRow<{ id: string }>(
    db,
    `SELECT id FROM subscription_versions
      WHERE id = ? AND subscription_id = ? AND deleted_at IS NULL`,
    [versionId, subscriptionId],
  );
  if (!row) {
    throw invalid(`version_id ${versionId} 不属于订阅 ${subscriptionId}（或已删除）`);
  }
}

// ---------------------------------------------------------------------------
// GET /api/charges
// ---------------------------------------------------------------------------

chargeRoutes.get('/', async (c) => {
  const url = new URL(c.req.url);
  const where: string[] = ['ch.deleted_at IS NULL'];
  const params: unknown[] = [];

  const subscriptionId = c.req.query('subscription_id')?.trim();
  if (subscriptionId) {
    where.push('ch.subscription_id = ?');
    params.push(subscriptionId);
  }
  const from = queryDateOnly(url, 'from');
  if (from) {
    where.push('ch.charge_date >= ?');
    params.push(from);
  }
  const to = queryDateOnly(url, 'to');
  if (to) {
    where.push('ch.charge_date <= ?');
    params.push(to);
  }
  const status = c.req.query('status')?.trim();
  if (status) {
    if (!(CHARGE_STATUSES as readonly string[]).includes(status)) {
      throw invalid(`查询参数 status 必须是以下之一：${CHARGE_STATUSES.join(' / ')}`);
    }
    where.push('ch.status = ?');
    params.push(status);
  }
  const source = c.req.query('source')?.trim();
  if (source) {
    if (source !== 'auto' && source !== 'manual') throw invalid('查询参数 source 只能是 auto / manual');
    where.push('ch.source = ?');
    params.push(source);
  }

  const limit = queryInt(url, 'limit', { fallback: 100, min: 1, max: 500 });
  const offset = queryInt(url, 'offset', { fallback: 0, min: 0, max: 1_000_000 });

  const items = await allRows<ChargeWithName>(
    c.env.DB,
    `SELECT ch.*, s.name AS subscription_name
       FROM charges ch LEFT JOIN subscriptions s ON s.id = ch.subscription_id
      WHERE ${where.join(' AND ')}
      ORDER BY ch.charge_date DESC, ch.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const totalRow = await firstRow<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM charges ch WHERE ${where.join(' AND ')}`,
    params,
  );

  return c.json({
    items,
    total: totalRow?.n ?? items.length,
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// POST /api/charges
// ---------------------------------------------------------------------------

chargeRoutes.post('/', async (c) => {
  const body = await readJson(c.req.raw);
  const subscriptionId = requiredString(body, 'subscription_id', { max: 64 });
  await assertSubscription(c.env.DB, subscriptionId);

  const chargeDate = requiredDateOnly(body, 'charge_date');
  const amountMinor = requiredInt(body, 'amount_minor', { min: 0 });
  const currency = requiredCurrency(body, 'currency');
  const status = (optionalEnum(body, 'status', CHARGE_STATUSES) ?? 'paid') as ChargeStatus;

  let versionId: string | null = null;
  if (has(body, 'version_id')) {
    versionId = optionalString(body, 'version_id', { max: 64 }) ?? null;
    if (versionId) await assertVersionBelongsTo(c.env.DB, versionId, subscriptionId);
  }

  const base = await baseCurrencyOf(c.env.DB);
  const frozen = await freezeAmount(c.env.DB, amountMinor, currency, base, chargeDate);

  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    await runStmt(
      c.env.DB,
      `INSERT INTO charges
         (id, subscription_id, version_id, charge_date, amount_minor, currency, fx_rate_to_base,
          base_currency, base_amount_minor, source, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
      [
        id,
        subscriptionId,
        versionId,
        chargeDate,
        amountMinor,
        currency,
        frozen.fx_rate_to_base,
        frozen.base_currency,
        frozen.base_amount_minor,
        status,
        now,
        now,
      ],
    );
  } catch (err) {
    if (isConstraintViolation(err)) throw invalid(`数据不满足约束：${messageOf(err)}`);
    throw err;
  }

  const item = await firstRow<ChargeWithName>(
    c.env.DB,
    `SELECT ch.*, s.name AS subscription_name
       FROM charges ch LEFT JOIN subscriptions s ON s.id = ch.subscription_id WHERE ch.id = ?`,
    [id],
  );
  return c.json({ item, fx_warning: frozen.missing ? missingWarning(frozen.missing, chargeDate) : null }, 201);
});

// ---------------------------------------------------------------------------
// PATCH / DELETE /api/charges/:id
// ---------------------------------------------------------------------------

chargeRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const current = await firstRow<ChargeRow>(
    c.env.DB,
    `SELECT * FROM charges WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  if (!current) throw notFound(`扣款记录不存在或已删除：${id}`);

  const body = await readJson(c.req.raw);
  const sets: string[] = [];
  const params: unknown[] = [];
  const values: Record<string, unknown> = {};
  const push = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    params.push(value);
    values[column] = value;
  };

  if (has(body, 'amount_minor')) push('amount_minor', requiredInt(body, 'amount_minor', { min: 0 }));
  if (has(body, 'currency')) push('currency', requiredCurrency(body, 'currency'));
  if (has(body, 'charge_date')) push('charge_date', requiredDateOnly(body, 'charge_date'));
  if (has(body, 'status')) {
    push('status', optionalEnum(body, 'status', CHARGE_STATUSES) as ChargeStatusInput);
  }
  if (has(body, 'version_id')) {
    const versionId = optionalString(body, 'version_id', { max: 64 }) ?? null;
    if (versionId) await assertVersionBelongsTo(c.env.DB, versionId, current.subscription_id);
    push('version_id', versionId);
  }

  if (sets.length === 0) throw invalid('请求体里没有任何可更新的字段');

  // 金额/币种/扣款日任一变化，都按新的扣款日重新冻结汇率。
  const amount = (('amount_minor' in values ? values['amount_minor'] : current.amount_minor) as number);
  const currency = (('currency' in values ? values['currency'] : current.currency) as string);
  const chargeDate = (('charge_date' in values ? values['charge_date'] : current.charge_date) as string);
  const base = await baseCurrencyOf(c.env.DB);
  const frozen = await freezeAmount(c.env.DB, amount, currency, base, chargeDate);
  push('fx_rate_to_base', frozen.fx_rate_to_base);
  push('base_currency', frozen.base_currency);
  push('base_amount_minor', frozen.base_amount_minor);

  sets.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);

  try {
    await runStmt(c.env.DB, `UPDATE charges SET ${sets.join(', ')} WHERE id = ?`, params);
  } catch (err) {
    if (isConstraintViolation(err)) throw invalid(`数据不满足约束：${messageOf(err)}`);
    throw err;
  }

  const item = await firstRow<ChargeWithName>(
    c.env.DB,
    `SELECT ch.*, s.name AS subscription_name
       FROM charges ch LEFT JOIN subscriptions s ON s.id = ch.subscription_id WHERE ch.id = ?`,
    [id],
  );
  return c.json({ item, fx_warning: frozen.missing ? missingWarning(frozen.missing, chargeDate) : null });
});

chargeRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const current = await firstRow<ChargeRow>(
    c.env.DB,
    `SELECT * FROM charges WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  if (!current) throw notFound(`扣款记录不存在或已删除：${id}`);
  await runStmt(
    c.env.DB,
    `UPDATE charges SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    [nowIso(), nowIso(), id],
  );
  return c.json({ deleted: true, id });
});

// ---------------------------------------------------------------------------

function missingWarning(currency: string, date: string): string {
  return `缺少 ${currency} 在 ${date}（或更早）的汇率快照，本笔扣款的基准币种金额留空；补齐汇率后可重试写入以冻结金额。`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
