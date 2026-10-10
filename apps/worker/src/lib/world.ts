/**
 * 「一次把业务需要的数据全读出来」的装配层。
 *
 * summary / trends / ics / cron / 订阅详情都需要同一批数据
 * （settings + 订阅 + 版本 + 扣款 + 分类 + 汇率快照），
 * 集中在这里读，避免每个入口各写一遍 SQL 而口径不一致。
 */

import {
  fxSnapshotFromRows,
  todayInTimeZone,
  type CategoryRow,
  type ChargeRow,
  type FxRateRow,
  type FxSnapshot,
  type SettingsRow,
  type SubscriptionRow,
  type SubscriptionVersionRow,
} from '@submgr/core';
import { allRows } from './db.js';
import { ensureSettings } from './settings.js';

export interface World {
  settings: SettingsRow;
  /** 用户时区下的今天 YYYY-MM-DD（所有业务判断的唯一「今天」）。 */
  today: string;
  subscriptions: SubscriptionRow[];
  versions: SubscriptionVersionRow[];
  charges: ChargeRow[];
  categories: CategoryRow[];
  fx: FxSnapshot;
}

export interface WorldOptions {
  /** 只加载 [chargesFrom, chargesTo] 之间的扣款（趋势图/提醒汇总用得上）。 */
  chargesFrom?: string;
  chargesTo?: string;
  /** 不加载扣款（ICS 等不需要扣款的场景）。 */
  withoutCharges?: boolean;
}

export async function loadSubscriptions(db: D1Database): Promise<SubscriptionRow[]> {
  return allRows<SubscriptionRow>(
    db,
    `SELECT * FROM subscriptions WHERE deleted_at IS NULL ORDER BY created_at ASC, name ASC`,
  );
}

export async function loadVersions(db: D1Database): Promise<SubscriptionVersionRow[]> {
  return allRows<SubscriptionVersionRow>(
    db,
    `SELECT * FROM subscription_versions WHERE deleted_at IS NULL
      ORDER BY subscription_id ASC, effective_from ASC, created_at ASC`,
  );
}

export async function loadCharges(
  db: D1Database,
  range: { from?: string; to?: string } = {},
): Promise<ChargeRow[]> {
  const where: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (range.from) {
    where.push('charge_date >= ?');
    params.push(range.from);
  }
  if (range.to) {
    where.push('charge_date <= ?');
    params.push(range.to);
  }
  return allRows<ChargeRow>(
    db,
    `SELECT * FROM charges WHERE ${where.join(' AND ')}
      ORDER BY charge_date DESC, created_at DESC`,
    params,
  );
}

export async function loadCategories(db: D1Database): Promise<CategoryRow[]> {
  return allRows<CategoryRow>(
    db,
    `SELECT * FROM categories WHERE deleted_at IS NULL ORDER BY sort ASC, name ASC`,
  );
}

/** 每币种最新一天的汇率快照（GROUP BY，不下载整张表）。 */
export async function loadFx(db: D1Database): Promise<FxSnapshot> {
  const rows = await allRows<FxRateRow>(
    db,
    `SELECT f.* FROM fx_rates f
       JOIN (SELECT currency, MAX(date) AS max_date FROM fx_rates
              WHERE deleted_at IS NULL GROUP BY currency) m
         ON f.currency = m.currency AND f.date = m.max_date
      WHERE f.deleted_at IS NULL`,
  );
  return fxSnapshotFromRows(rows);
}

/** 汇总读取（settings 缺失时自动补默认行）。 */
export async function loadWorld(db: D1Database, opts: WorldOptions = {}): Promise<World> {
  const settings = await ensureSettings(db);
  const today = todayInTimeZone(settings.timezone);

  const [subscriptions, versions, categories, fx] = await Promise.all([
    loadSubscriptions(db),
    loadVersions(db),
    loadCategories(db),
    loadFx(db),
  ]);

  const charges = opts.withoutCharges
    ? []
    : await loadCharges(db, { from: opts.chargesFrom, to: opts.chargesTo });

  return { settings, today, subscriptions, versions, charges, categories, fx };
}

/** settings.timezone 下的今天；没有 settings 时用给定回退值。 */
export async function todayFor(db: D1Database): Promise<{ settings: SettingsRow; today: string }> {
  const settings = await ensureSettings(db);
  return { settings, today: todayInTimeZone(settings.timezone) };
}
