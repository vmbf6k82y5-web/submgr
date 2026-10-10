/**
 * /api/subscriptions 及其版本子资源。
 *
 * 价格版本的三层保护（阶段一定稿，Worker 这里落实第 1 层）：
 *   1) 接口层：本文件只允许「新增」版本；已生效版本除 plan_name 外一律拒绝修改；
 *   2) 数据库触发器 trg_subscription_versions_freeze（真正的兜底）；
 *   3) 唯一索引 ux_versions_subscription_effective（同订阅同日只有一个版本）。
 */

import { Hono } from 'hono';
import {
  boolOf,
  chargeChannelLabel,
  convert,
  currentVersion,
  getStatus,
  nowIso,
  subTypeLabel,
  todayInTimeZone,
  toMonthlyAmount,
  versionsForSubscription,
  type CategoryRow,
  type ChargeRow,
  type SettingsRow,
  type SubscriptionRow,
  type SubscriptionVersionRow,
} from '@submgr/core';
import type { Env } from '../env.js';
import { allRows, firstRow, isConstraintViolation, isUniqueViolation, runStmt } from '../lib/db.js';
import { conflict, invalid, notFound } from '../lib/errors.js';
import { loadFx } from '../lib/world.js';
import {
  SUB_TYPES,
  CHARGE_CHANNELS,
  RENEW_MODES,
  has,
  optionalDateOnly,
  optionalEnum,
  optionalInstant,
  optionalString,
  readJson,
  requiredDateOnly,
  requiredEnum,
  requiredString,
  type JsonObject,
} from '../lib/validate.js';
import { ensureSettings } from '../lib/settings.js';
import {
  isEffective,
  readVersionCreate,
  readVersionPatch,
  touchedFrozenFields,
} from './version-input.js';

export const subscriptionRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// 查询辅助
// ---------------------------------------------------------------------------

async function loadSubscription(db: D1Database, id: string): Promise<SubscriptionRow> {
  const row = await firstRow<SubscriptionRow>(
    db,
    `SELECT * FROM subscriptions WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  if (!row) throw notFound(`订阅不存在或已删除：${id}`);
  return row;
}

async function loadVersions(db: D1Database, subscriptionId: string): Promise<SubscriptionVersionRow[]> {
  return allRows<SubscriptionVersionRow>(
    db,
    `SELECT * FROM subscription_versions
      WHERE subscription_id = ? AND deleted_at IS NULL
      ORDER BY effective_from ASC, created_at ASC`,
    [subscriptionId],
  );
}

async function loadCharges(db: D1Database, subscriptionId: string): Promise<ChargeRow[]> {
  return allRows<ChargeRow>(
    db,
    `SELECT * FROM charges WHERE subscription_id = ? AND deleted_at IS NULL
      ORDER BY charge_date DESC, created_at DESC LIMIT 200`,
    [subscriptionId],
  );
}

/** 订阅的对外形态：主体 + 状态 + 当前版本 + 中文标签 + 月均（基准币种）。 */
function toDto(
  sub: SubscriptionRow,
  versions: SubscriptionVersionRow[],
  charges: ChargeRow[],
  categories: CategoryRow[],
  settings: SettingsRow,
  today: string,
  fxRates: Record<string, string>,
): Record<string, unknown> {
  const status = getStatus(sub, versions, today, charges);
  const current = currentVersion(versionsForSubscription(versions, sub.id), today);
  const category = sub.category_id
    ? (categories.find((c) => c.id === sub.category_id) ?? null)
    : null;

  let monthly: number | null = null;
  if (current) {
    const inCurrency = toMonthlyAmount(current, settings, { useAfterTrial: true });
    monthly = convert(inCurrency, current.currency, settings.base_currency, fxRates);
  }

  return {
    id: sub.id,
    name: sub.name,
    category_id: sub.category_id,
    category_name: category ? category.name : null,
    category_color: category ? category.color : null,
    sub_type: sub.sub_type,
    sub_type_label: subTypeLabel(sub.sub_type),
    charge_channel: sub.charge_channel,
    charge_channel_label: chargeChannelLabel(sub.charge_channel),
    renew_mode: sub.renew_mode,
    start_date: sub.start_date,
    end_date: sub.end_date,
    cancelled_at: sub.cancelled_at,
    note: sub.note,
    icon: sub.icon,
    created_at: sub.created_at,
    updated_at: sub.updated_at,
    status: status.status,
    reason_code: status.reasonCode,
    reason: status.reason,
    next_due_date: status.nextDueDate,
    current_version_id: status.currentVersionId,
    current_version: current,
    monthly_amount_minor: monthly,
  };
}

async function loadContext(
  db: D1Database,
): Promise<{
  settings: SettingsRow;
  today: string;
  subscriptions: SubscriptionRow[];
  versions: SubscriptionVersionRow[];
  charges: ChargeRow[];
  categories: CategoryRow[];
  fxRates: Record<string, string>;
}> {
  const settings = await ensureSettings(db);
  const today = todayInTimeZone(settings.timezone);
  const [subscriptions, versions, charges, categories, fx] = await Promise.all([
    allRows<SubscriptionRow>(
      db,
      `SELECT * FROM subscriptions WHERE deleted_at IS NULL ORDER BY created_at ASC, name ASC`,
    ),
    allRows<SubscriptionVersionRow>(
      db,
      `SELECT * FROM subscription_versions WHERE deleted_at IS NULL
        ORDER BY subscription_id ASC, effective_from ASC, created_at ASC`,
    ),
    allRows<ChargeRow>(db, `SELECT * FROM charges WHERE deleted_at IS NULL`),
    allRows<CategoryRow>(
      db,
      `SELECT * FROM categories WHERE deleted_at IS NULL ORDER BY sort ASC, name ASC`,
    ),
    loadFx(db),
  ]);
  return { settings, today, subscriptions, versions, charges, categories, fxRates: fx.rates };
}

// ---------------------------------------------------------------------------
// GET /api/subscriptions
// ---------------------------------------------------------------------------

subscriptionRoutes.get('/', async (c) => {
  const ctx = await loadContext(c.env.DB);
  const statusFilter = c.req.query('status');
  const q = c.req.query('q')?.trim().toLowerCase() ?? null;
  const categoryId = c.req.query('category_id') ?? null;

  let items = ctx.subscriptions.map((s) =>
    toDto(s, ctx.versions, ctx.charges, ctx.categories, ctx.settings, ctx.today, ctx.fxRates),
  );

  if (statusFilter) {
    const allowed = ['active', 'ended', 'anomaly'];
    if (!allowed.includes(statusFilter)) {
      throw invalid(`查询参数 status 必须是以下之一：${allowed.join(' / ')}`);
    }
    items = items.filter((i) => i.status === statusFilter);
  }
  if (q) items = items.filter((i) => String(i.name).toLowerCase().includes(q));
  if (categoryId) items = items.filter((i) => i.category_id === categoryId);

  const counts = { total: 0, active: 0, ended: 0, anomaly: 0 };
  for (const i of items) {
    counts.total += 1;
    if (i.status === 'active') counts.active += 1;
    else if (i.status === 'ended') counts.ended += 1;
    else counts.anomaly += 1;
  }

  return c.json({ items, counts, today: ctx.today, base_currency: ctx.settings.base_currency });
});

// ---------------------------------------------------------------------------
// POST /api/subscriptions
// ---------------------------------------------------------------------------

subscriptionRoutes.post('/', async (c) => {
  const body = await readJson(c.req.raw);
  const settings = await ensureSettings(c.env.DB);

  const name = requiredString(body, 'name', { max: 200 });
  const subType = requiredEnum(body, 'sub_type', SUB_TYPES);
  const channel = requiredEnum(body, 'charge_channel', CHARGE_CHANNELS);
  const renewMode = requiredEnum(body, 'renew_mode', RENEW_MODES);
  const startDate = requiredDateOnly(body, 'start_date');
  const endDate = optionalDateOnly(body, 'end_date') ?? null;
  const cancelledAt = optionalInstant(body, 'cancelled_at') ?? null;
  const note = optionalString(body, 'note', { max: 2000 }) ?? null;
  const icon = optionalString(body, 'icon', { max: 200 }) ?? null;

  let categoryId: string | null = null;
  if (has(body, 'category_id')) {
    categoryId = optionalString(body, 'category_id', { max: 64 }) ?? null;
    if (categoryId) await assertCategoryExists(c.env.DB, categoryId);
  }

  if (endDate !== null && endDate < startDate) {
    throw invalid('end_date 不能早于 start_date');
  }

  const id = crypto.randomUUID();
  const now = nowIso();

  const insertSub = c.env.DB.prepare(
    `INSERT INTO subscriptions
       (id, name, category_id, sub_type, charge_channel, renew_mode, start_date, end_date,
        cancelled_at, note, icon, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    name,
    categoryId,
    subType,
    channel,
    renewMode,
    startDate,
    endDate,
    cancelledAt,
    note,
    icon,
    now,
    now,
  );

  const statements: D1PreparedStatement[] = [insertSub];
  let versionId: string | null = null;

  if (has(body, 'version')) {
    const rawVersion = body['version'];
    if (rawVersion === null || typeof rawVersion !== 'object' || Array.isArray(rawVersion)) {
      throw invalid('字段 version 必须是一个对象');
    }
    const input = readVersionCreate(rawVersion as JsonObject, startDate);
    versionId = crypto.randomUUID();
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO subscription_versions
           (id, subscription_id, effective_from, plan_name, amount_minor, currency, cycle_type,
            cycle_days, is_trial, trial_end_date, after_trial_amount_minor, after_trial_currency,
            after_trial_cycle_type, after_trial_cycle_days, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        versionId,
        id,
        input.effective_from,
        input.plan_name,
        input.amount_minor,
        input.currency,
        input.cycle_type,
        input.cycle_days,
        input.is_trial,
        input.trial_end_date,
        input.after_trial_amount_minor,
        input.after_trial_currency,
        input.after_trial_cycle_type,
        input.after_trial_cycle_days,
        now,
        now,
      ),
    );
  }

  try {
    await c.env.DB.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('duplicate_version', '同一个订阅在同一天只能有一个价格版本');
    }
    if (isConstraintViolation(err)) throw invalid(`数据不满足约束：${messageOf(err)}`);
    throw err;
  }

  const sub = await loadSubscription(c.env.DB, id);
  const versions = await loadVersions(c.env.DB, id);
  const charges = await loadCharges(c.env.DB, id);
  const categories = await allRows<CategoryRow>(c.env.DB, `SELECT * FROM categories WHERE deleted_at IS NULL`);
  const fx = await loadFx(c.env.DB);

  return c.json(
    {
      item: toDto(sub, versions, charges, categories, settings, todayInTimeZone(settings.timezone), fx.rates),
      created_version_id: versionId,
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// GET/PATCH/DELETE /api/subscriptions/:id
// ---------------------------------------------------------------------------

subscriptionRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const sub = await loadSubscription(c.env.DB, id);
  const settings = await ensureSettings(c.env.DB);
  const [versions, charges, categories, fx] = await Promise.all([
    loadVersions(c.env.DB, id),
    loadCharges(c.env.DB, id),
    allRows<CategoryRow>(c.env.DB, `SELECT * FROM categories WHERE deleted_at IS NULL`),
    loadFx(c.env.DB),
  ]);
  const today = todayInTimeZone(settings.timezone);

  return c.json({
    item: toDto(sub, versions, charges, categories, settings, today, fx.rates),
    versions,
    charges,
  });
});

subscriptionRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const current = await loadSubscription(c.env.DB, id);
  const body = await readJson(c.req.raw);

  const sets: string[] = [];
  const params: unknown[] = [];
  const touchedValues: Record<string, unknown> = {};
  const push = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    params.push(value);
    touchedValues[column] = value;
  };

  if (has(body, 'name')) push('name', requiredString(body, 'name', { max: 200 }));
  if (has(body, 'sub_type')) push('sub_type', requiredEnum(body, 'sub_type', SUB_TYPES));
  if (has(body, 'charge_channel')) {
    push('charge_channel', requiredEnum(body, 'charge_channel', CHARGE_CHANNELS));
  }
  if (has(body, 'renew_mode')) push('renew_mode', requiredEnum(body, 'renew_mode', RENEW_MODES));
  if (has(body, 'start_date')) push('start_date', requiredDateOnly(body, 'start_date'));
  if (has(body, 'end_date')) push('end_date', optionalDateOnly(body, 'end_date') ?? null);
  if (has(body, 'cancelled_at')) push('cancelled_at', optionalInstant(body, 'cancelled_at') ?? null);
  if (has(body, 'note')) push('note', optionalString(body, 'note', { max: 2000 }) ?? null);
  if (has(body, 'icon')) push('icon', optionalString(body, 'icon', { max: 200 }) ?? null);
  if (has(body, 'category_id')) {
    const categoryId = optionalString(body, 'category_id', { max: 64 }) ?? null;
    if (categoryId) await assertCategoryExists(c.env.DB, categoryId);
    push('category_id', categoryId);
  }

  if (sets.length === 0) throw invalid('请求体里没有任何可更新的字段');

  const startDate = ('start_date' in touchedValues
    ? touchedValues['start_date']
    : current.start_date) as string;
  const endDate = ('end_date' in touchedValues
    ? touchedValues['end_date']
    : current.end_date) as string | null;
  if (endDate !== null && endDate < startDate) throw invalid('end_date 不能早于 start_date');

  sets.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);

  try {
    await runStmt(c.env.DB, `UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`, params);
  } catch (err) {
    if (isConstraintViolation(err)) throw invalid(`数据不满足约束：${messageOf(err)}`);
    throw err;
  }

  const sub = await loadSubscription(c.env.DB, id);
  const settings = await ensureSettings(c.env.DB);
  const [versions, charges, categories, fx] = await Promise.all([
    loadVersions(c.env.DB, id),
    loadCharges(c.env.DB, id),
    allRows<CategoryRow>(c.env.DB, `SELECT * FROM categories WHERE deleted_at IS NULL`),
    loadFx(c.env.DB),
  ]);
  return c.json({
    item: toDto(sub, versions, charges, categories, settings, todayInTimeZone(settings.timezone), fx.rates),
    versions,
    charges,
  });
});

subscriptionRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await loadSubscription(c.env.DB, id);
  await runStmt(
    c.env.DB,
    `UPDATE subscriptions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    [nowIso(), nowIso(), id],
  );

  // 版本与提醒规则跟着软删除：数据库的 ON DELETE CASCADE 只在硬删除时生效，
  // 而本项目一律软删除，所以要显式级联，避免留下指向已删订阅的孤儿版本。
  await runStmt(
    c.env.DB,
    `UPDATE subscription_versions SET deleted_at = ?, updated_at = ? WHERE subscription_id = ? AND deleted_at IS NULL`,
    [nowIso(), nowIso(), id],
  );
  await runStmt(
    c.env.DB,
    `UPDATE reminder_rules SET deleted_at = ?, updated_at = ? WHERE subscription_id = ? AND deleted_at IS NULL`,
    [nowIso(), nowIso(), id],
  );

  return c.json({ deleted: true, id });
});

// ---------------------------------------------------------------------------
// 版本：GET / POST /api/subscriptions/:id/versions
// ---------------------------------------------------------------------------

subscriptionRoutes.get('/:id/versions', async (c) => {
  const id = c.req.param('id');
  await loadSubscription(c.env.DB, id);
  const settings = await ensureSettings(c.env.DB);
  const today = todayInTimeZone(settings.timezone);
  const versions = await loadVersions(c.env.DB, id);

  return c.json({
    items: versions.map((v) => ({
      ...v,
      is_trial: boolOf(v.is_trial),
      frozen: isEffective(v, today),
    })),
    today,
  });
});

subscriptionRoutes.post('/:id/versions', async (c) => {
  const id = c.req.param('id');
  const sub = await loadSubscription(c.env.DB, id);
  const body = await readJson(c.req.raw);

  // 只允许新增：POST 永远不会修改已有版本。
  const input = readVersionCreate(body, sub.start_date);
  const versionId = crypto.randomUUID();
  const now = nowIso();

  try {
    await runStmt(
      c.env.DB,
      `INSERT INTO subscription_versions
         (id, subscription_id, effective_from, plan_name, amount_minor, currency, cycle_type,
          cycle_days, is_trial, trial_end_date, after_trial_amount_minor, after_trial_currency,
          after_trial_cycle_type, after_trial_cycle_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        versionId,
        id,
        input.effective_from,
        input.plan_name,
        input.amount_minor,
        input.currency,
        input.cycle_type,
        input.cycle_days,
        input.is_trial,
        input.trial_end_date,
        input.after_trial_amount_minor,
        input.after_trial_currency,
        input.after_trial_cycle_type,
        input.after_trial_cycle_days,
        now,
        now,
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(
        'duplicate_effective_from',
        `该订阅在 ${input.effective_from} 已经有一个版本；要调价请换一个生效日，不要改历史版本`,
      );
    }
    if (isConstraintViolation(err)) throw invalid(`数据不满足约束：${messageOf(err)}`);
    throw err;
  }

  const created = await firstRow<SubscriptionVersionRow>(
    c.env.DB,
    `SELECT * FROM subscription_versions WHERE id = ?`,
    [versionId],
  );
  return c.json({ item: created, created: true }, 201);
});

// ---------------------------------------------------------------------------
// 版本：PATCH / DELETE /api/subscriptions/:id/versions/:versionId
// ---------------------------------------------------------------------------

subscriptionRoutes.patch('/:id/versions/:versionId', async (c) => {
  const subscriptionId = c.req.param('id');
  const versionId = c.req.param('versionId');
  await loadSubscription(c.env.DB, subscriptionId);

  const current = await firstRow<SubscriptionVersionRow>(
    c.env.DB,
    `SELECT * FROM subscription_versions WHERE id = ? AND subscription_id = ? AND deleted_at IS NULL`,
    [versionId, subscriptionId],
  );
  if (!current) throw notFound(`版本不存在或已删除：${versionId}`);

  const body = await readJson(c.req.raw);
  const settings = await ensureSettings(c.env.DB);
  const today = todayInTimeZone(settings.timezone);

  const frozen = isEffective(current, today);
  const touched = touchedFrozenFields(body);
  if (frozen && touched.length > 0) {
    throw conflict(
      'version_frozen',
      `版本 ${current.effective_from} 已经生效，金额/币种/周期/生效日被冻结（涉及的字段：${touched.join(', ')}）。` +
        '要调价请新建一个版本；只有 plan_name 还可以改。',
      { frozen_fields: touched },
    );
  }
  if (!frozen && touched.length === 0 && !has(body, 'plan_name')) {
    throw invalid('请求体里没有任何可更新的字段');
  }

  const input = readVersionPatch(body, current);
  const now = nowIso();

  try {
    await runStmt(
      c.env.DB,
      `UPDATE subscription_versions SET
         effective_from = ?, plan_name = ?, amount_minor = ?, currency = ?, cycle_type = ?,
         cycle_days = ?, is_trial = ?, trial_end_date = ?, after_trial_amount_minor = ?,
         after_trial_currency = ?, after_trial_cycle_type = ?, after_trial_cycle_days = ?,
         updated_at = ?
       WHERE id = ? AND subscription_id = ?`,
      [
        input.effective_from,
        input.plan_name,
        input.amount_minor,
        input.currency,
        input.cycle_type,
        input.cycle_days,
        input.is_trial,
        input.trial_end_date,
        input.after_trial_amount_minor,
        input.after_trial_currency,
        input.after_trial_cycle_type,
        input.after_trial_cycle_days,
        now,
        versionId,
        subscriptionId,
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('duplicate_effective_from', '同一个订阅在同一天只能有一个价格版本');
    }
    if (isConstraintViolation(err)) {
      // 触发器 trg_subscription_versions_freeze 的中文说明就是最好的错误信息
      throw conflict('version_frozen', messageOf(err));
    }
    throw err;
  }

  const updated = await firstRow<SubscriptionVersionRow>(
    c.env.DB,
    `SELECT * FROM subscription_versions WHERE id = ?`,
    [versionId],
  );
  return c.json({ item: updated });
});

subscriptionRoutes.delete('/:id/versions/:versionId', async (c) => {
  const subscriptionId = c.req.param('id');
  const versionId = c.req.param('versionId');
  await loadSubscription(c.env.DB, subscriptionId);

  const current = await firstRow<SubscriptionVersionRow>(
    c.env.DB,
    `SELECT * FROM subscription_versions WHERE id = ? AND subscription_id = ? AND deleted_at IS NULL`,
    [versionId, subscriptionId],
  );
  if (!current) throw notFound(`版本不存在或已删除：${versionId}`);

  const settings = await ensureSettings(c.env.DB);
  const today = todayInTimeZone(settings.timezone);
  if (isEffective(current, today)) {
    throw conflict(
      'version_frozen',
      `版本 ${current.effective_from} 已经生效，不能删除（删除同样会改变历史）。要改价请新建版本。`,
    );
  }

  await runStmt(
    c.env.DB,
    `UPDATE subscription_versions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    [nowIso(), nowIso(), versionId],
  );
  return c.json({ deleted: true, id: versionId });
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

async function assertCategoryExists(db: D1Database, categoryId: string): Promise<void> {
  const row = await firstRow<{ id: string }>(
    db,
    `SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL`,
    [categoryId],
  );
  if (!row) throw invalid(`category_id 指向的分类不存在：${categoryId}`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
