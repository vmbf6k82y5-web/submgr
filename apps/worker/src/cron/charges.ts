/**
 * Cron ③：每天做两件事（顺序不能反）。
 *
 *   A. 试用转正：为「trial_end_date <= 今天」且填了 after_trial_* 的试用版本，
 *      插入一个新版本，其 effective_from = trial_end_date（需求原文）。
 *      幂等：同订阅同 effective_from 已存在就跳过。
 *      补跑：昨天/前天漏跑也会补上（不限于当天），否则用户会永远停在试用版本上。
 *      注意锚点：转正日同时成为该订阅后续所有到期日的锚点（B1 定稿），
 *      这件事由 core 的 dueAnchorFor 自动完成，这里不需要额外处理。
 *
 *   B. 生成当日扣款并冻结汇率：
 *      只对 renew_mode = 'auto' 的订阅；试用版本不生成（试用期没有实际扣款），
 *      终身版本不生成（一次性付费，不是周期扣款）。
 *      幂等：ux_charges_auto_daily (subscription_id, charge_date) WHERE source='auto'。
 */

import {
  addDaysDateOnly,
  boolOf,
  convertWithFrozenRate,
  currentVersion,
  dueAnchorFor,
  dueDatesBetween,
  frozenRateBetween,
  nowIso,
  projectAfterTrialVersions,
  todayInTimeZone,
  versionsForSubscription,
  type SubscriptionRow,
  type SubscriptionVersionRow,
} from '@submgr/core';
import type { Env } from '../env.js';
import { allRows, firstRow, isUniqueViolation, runStmt } from '../lib/db.js';
import { loadFxSnapshotAsOf } from '../lib/fx.js';
import { ensureSettings } from '../lib/settings.js';
import { defaultCronDeps, type CronDeps } from './deps.js';

// ---------------------------------------------------------------------------
// A. 试用转正
// ---------------------------------------------------------------------------

export interface TrialConversionDetail {
  subscription_id: string;
  trial_version_id: string;
  new_version_id: string;
  effective_from: string;
  amount_minor: number;
  currency: string;
  cycle_type: string;
}

export interface TrialConversionResult {
  today: string;
  converted: number;
  skipped_existing: number;
  details: TrialConversionDetail[];
}

export async function runTrialConversions(
  env: Env,
  deps: CronDeps = defaultCronDeps(),
): Promise<TrialConversionResult> {
  const settings = await ensureSettings(env.DB);
  const today = todayInTimeZone(settings.timezone, deps.now());

  const [subscriptions, versions] = await Promise.all([
    allRows<SubscriptionRow>(env.DB, `SELECT * FROM subscriptions WHERE deleted_at IS NULL`),
    allRows<SubscriptionVersionRow>(
      env.DB,
      `SELECT * FROM subscription_versions WHERE deleted_at IS NULL`,
    ),
  ]);
  const aliveSubIds = new Set(subscriptions.map((s) => s.id));

  const details: TrialConversionDetail[] = [];
  let skipped = 0;

  // 一个订阅只应对「最新的那个试用版本」做转正：正常数据一个订阅只有一个试用版，
  // 但补录/历史数据可能出现多个，逐个转正会把更早的转正版本插进版本序列中间，
  // 改变 dueAnchorFor 的锚点口径。按订阅分组后只取 effective_from 最新的一个。
  const latestTrialBySub = new Map<string, SubscriptionVersionRow>();
  for (const v of versions) {
    if (!boolOf(v.is_trial)) continue;
    if (!aliveSubIds.has(v.subscription_id)) continue;
    const current = latestTrialBySub.get(v.subscription_id);
    if (current === undefined || v.effective_from > current.effective_from) {
      latestTrialBySub.set(v.subscription_id, v);
    }
  }

  for (const trial of latestTrialBySub.values()) {
    if (!trial.trial_end_date) continue;
    // 还没到转正日
    if (trial.trial_end_date > today) continue;
    // 没填转正价格 = 「试用后不续费」，不生成转正版本
    if (trial.after_trial_amount_minor === null || trial.after_trial_cycle_type === null) continue;

    // 该订阅已经有「转正日或更晚生效」的正式版本：说明已经转过（或用户手工续了价），
    // 再插一个更早生效的版本会扰乱版本序列，直接跳过。
    const trialEnd = trial.trial_end_date;
    const alreadyFormal = versions.some(
      (v) =>
        v.subscription_id === trial.subscription_id &&
        !boolOf(v.is_trial) &&
        v.effective_from >= trialEnd,
    );
    if (alreadyFormal) {
      skipped += 1;
      continue;
    }

    const existing = await firstRow<{ id: string }>(
      env.DB,
      `SELECT id FROM subscription_versions
        WHERE subscription_id = ? AND effective_from = ? AND deleted_at IS NULL`,
      [trial.subscription_id, trial.trial_end_date],
    );
    if (existing) {
      skipped += 1;
      continue;
    }

    const newId = crypto.randomUUID();
    const currency = trial.after_trial_currency ?? trial.currency;
    const now = nowIso(deps.now());

    try {
      await runStmt(
        env.DB,
        `INSERT INTO subscription_versions
           (id, subscription_id, effective_from, plan_name, amount_minor, currency, cycle_type,
            cycle_days, is_trial, trial_end_date, after_trial_amount_minor, after_trial_currency,
            after_trial_cycle_type, after_trial_cycle_days, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        [
          newId,
          trial.subscription_id,
          trial.trial_end_date,
          trial.plan_name,
          trial.after_trial_amount_minor,
          currency,
          trial.after_trial_cycle_type,
          trial.after_trial_cycle_days,
          now,
          now,
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        skipped += 1;
        continue;
      }
      deps.log('error', 'cron.trial.convert_failed', {
        subscription_id: trial.subscription_id,
        trial_version_id: trial.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    details.push({
      subscription_id: trial.subscription_id,
      trial_version_id: trial.id,
      new_version_id: newId,
      effective_from: trial.trial_end_date,
      amount_minor: trial.after_trial_amount_minor,
      currency,
      cycle_type: trial.after_trial_cycle_type,
    });
    deps.log('info', 'cron.trial.converted', {
      subscription_id: trial.subscription_id,
      effective_from: trial.trial_end_date,
      amount_minor: trial.after_trial_amount_minor,
      currency,
    });
  }

  return { today, converted: details.length, skipped_existing: skipped, details };
}

// ---------------------------------------------------------------------------
// B. 生成当日扣款（并冻结汇率）
// ---------------------------------------------------------------------------

export interface GeneratedCharge {
  charge_id: string;
  subscription_id: string;
  subscription_name: string;
  version_id: string | null;
  amount_minor: number;
  currency: string;
  fx_frozen: boolean;
}

export interface ChargeGenerationResult {
  today: string;
  created: number;
  skipped_existing: number;
  skipped_trial: number;
  skipped_lifetime: number;
  missing_fx: number;
  charges: GeneratedCharge[];
}

export async function runChargeGeneration(
  env: Env,
  deps: CronDeps = defaultCronDeps(),
): Promise<ChargeGenerationResult> {
  const settings = await ensureSettings(env.DB);
  const today = todayInTimeZone(settings.timezone, deps.now());

  const [subscriptions, versions] = await Promise.all([
    allRows<SubscriptionRow>(env.DB, `SELECT * FROM subscriptions WHERE deleted_at IS NULL`),
    allRows<SubscriptionVersionRow>(
      env.DB,
      `SELECT * FROM subscription_versions WHERE deleted_at IS NULL`,
    ),
  ]);

  const result: ChargeGenerationResult = {
    today,
    created: 0,
    skipped_existing: 0,
    skipped_trial: 0,
    skipped_lifetime: 0,
    missing_fx: 0,
    charges: [],
  };

  // 冻结汇率用的快照：截止今天（含）每币种最新一天。
  // 同一批扣款只读一次汇率，保证同一天的所有扣款用同一份快照。
  const snapshot = await loadFxSnapshotAsOf(env.DB, today);

  for (const sub of subscriptions) {
    if (sub.renew_mode !== 'auto') continue;
    if (sub.cancelled_at) continue;
    if (sub.end_date && today > sub.end_date) continue;

    const subVersions = versionsForSubscription(versions, sub.id);
    if (subVersions.length === 0) continue;

    const projected = projectAfterTrialVersions(subVersions);
    const current = currentVersion(projected, today);
    if (!current) continue;

    if (boolOf(current.is_trial)) {
      result.skipped_trial += 1;
      continue;
    }
    if (current.cycle_type === 'lifetime') {
      result.skipped_lifetime += 1;
      continue;
    }

    const anchor = dueAnchorFor(sub, projected);
    const dueOpts = { endDate: sub.end_date, cancelledAt: sub.cancelled_at };
    const dueDates = dueDatesBetween(current, anchor, addDaysDateOnly(today, -1), today, dueOpts);
    if (!dueDates.includes(today)) continue;

    // 当前版本可能是「投影版本」（id 带 ::after-trial）。真实的转正版本
    // 已经在 A 步插入，所以这里按 effective_from 找回真 id；找不到就写 null，
    // 绝不把投影 id 写进 charges.version_id（外键会拒绝）。
    let versionId: string | null = current.id;
    if (versionId.includes('::')) {
      const real = subVersions.find((v) => v.effective_from === current.effective_from);
      versionId = real ? real.id : null;
    }

    const existing = await firstRow<{ id: string }>(
      env.DB,
      `SELECT id FROM charges
        WHERE subscription_id = ? AND charge_date = ? AND source = 'auto' AND deleted_at IS NULL`,
      [sub.id, today],
    );
    if (existing) {
      result.skipped_existing += 1;
      continue;
    }

    const amountMinor = current.amount_minor;
    const currency = current.currency;
    const base = settings.base_currency;

    let rate: string | null = null;
    let baseAmount: number | null = null;
    if (currency === base) {
      rate = '1';
      baseAmount = amountMinor;
    } else {
      rate = frozenRateBetween(currency, base, snapshot);
      if (rate !== null) baseAmount = convertWithFrozenRate(amountMinor, currency, base, rate);
    }

    const chargeId = crypto.randomUUID();
    const now = nowIso(deps.now());

    try {
      await runStmt(
        env.DB,
        `INSERT INTO charges
           (id, subscription_id, version_id, charge_date, amount_minor, currency, fx_rate_to_base,
            base_currency, base_amount_minor, source, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', 'paid', ?, ?)`,
        [
          chargeId,
          sub.id,
          versionId,
          today,
          amountMinor,
          currency,
          rate,
          rate === null ? null : base,
          baseAmount,
          now,
          now,
        ],
      );
    } catch (err) {
      // 并发/重复执行撞上 ux_charges_auto_daily：说明今天这条已经有了
      if (isUniqueViolation(err)) {
        result.skipped_existing += 1;
        continue;
      }
      deps.log('error', 'cron.charges.insert_failed', {
        subscription_id: sub.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (rate === null) {
      result.missing_fx += 1;
      deps.log('warn', 'cron.charges.missing_fx', {
        subscription_id: sub.id,
        currency,
        charge_date: today,
      });
    }

    result.created += 1;
    result.charges.push({
      charge_id: chargeId,
      subscription_id: sub.id,
      subscription_name: sub.name,
      version_id: versionId,
      amount_minor: amountMinor,
      currency,
      fx_frozen: rate !== null,
    });
  }

  deps.log('info', 'cron.charges.done', {
    today: result.today,
    created: result.created,
    skipped_existing: result.skipped_existing,
    missing_fx: result.missing_fx,
  });
  return result;
}

// ---------------------------------------------------------------------------
// 每日作业 = A + B（顺序：先转正，再按转正后的价格扣款）
// ---------------------------------------------------------------------------

export interface DailyJobResult {
  trial: TrialConversionResult;
  charges: ChargeGenerationResult;
}

export async function runDailyJob(
  env: Env,
  deps: CronDeps = defaultCronDeps(),
): Promise<DailyJobResult> {
  const trial = await runTrialConversions(env, deps);
  const charges = await runChargeGeneration(env, deps);
  return { trial, charges };
}

/** 供 /api 或人工排查复用：某订阅今天是否到期（不写库）。 */
export function isDueToday(
  sub: SubscriptionRow,
  versions: readonly SubscriptionVersionRow[],
  today: string,
): boolean {
  const subVersions = versionsForSubscription(versions, sub.id);
  if (subVersions.length === 0) return false;
  const projected = projectAfterTrialVersions(subVersions);
  const current = currentVersion(projected, today);
  if (!current || boolOf(current.is_trial) || current.cycle_type === 'lifetime') return false;
  const anchor = dueAnchorFor(sub, projected);
  const dueDates = dueDatesBetween(current, anchor, addDaysDateOnly(today, -1), today, {
    endDate: sub.end_date,
    cancelledAt: sub.cancelled_at,
  });
  return dueDates.includes(today);
}
