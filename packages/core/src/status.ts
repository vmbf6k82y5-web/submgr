/**
 * 订阅管家 —— 订阅状态判定（纯函数）
 *
 * 只有三种状态：active / ended / anomaly，并且一定附带原因（reasonCode + 中文 reason）。
 *
 * anomaly 覆盖（需求原文）：
 *   1) 手动续费的订阅已经过了到期日却没有续费记录   -> manual_renew_overdue
 *   2) 最近一次扣款失败                             -> last_charge_failed
 *   3) 试用已经到期却没有转正版本                   -> trial_expired_no_conversion
 *   另外补一条数据完整性检查：
 *   4) 一个版本都没有                               -> no_version
 */

import { compareDateOnly } from './time.js';
import { nextDueDate, previousDueDate } from './cycles.js';
import {
  boolOf,
  type ChargeRow,
  type SubscriptionRow,
  type SubscriptionStatus,
  type SubscriptionVersionRow,
} from './types.js';

export type StatusReasonCode =
  // —— active ——
  | 'ok'
  | 'trial_active'
  | 'lifetime'
  | 'scheduled'
  // —— ended ——
  | 'cancelled'
  | 'end_date_passed'
  // —— anomaly ——
  | 'no_version'
  | 'trial_expired_no_conversion'
  | 'last_charge_failed'
  | 'manual_renew_overdue';

export interface StatusResult {
  status: SubscriptionStatus;
  reasonCode: StatusReasonCode;
  /** 中文说明，直接可以显示在界面上。 */
  reason: string;
  /** 下一次到期日；终身 / 已结束 / 已取消为 null。 */
  nextDueDate: string | null;
  /** 判定时采用的「当前版本」id，方便前端直接高亮。 */
  currentVersionId: string | null;
}

// ---------------------------------------------------------------------------
// 版本选取
// ---------------------------------------------------------------------------

function sortByEffectiveFrom(
  versions: readonly SubscriptionVersionRow[],
): SubscriptionVersionRow[] {
  return [...versions].sort((a, b) => {
    const byDate = a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : 0;
    if (byDate !== 0) return byDate;
    // 同一天理论上被唯一索引挡住；这里用 created_at 兜底保证顺序稳定
    return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
  });
}

/** 取某个订阅的有效版本（未软删除），按 effective_from 升序。 */
export function versionsForSubscription(
  versions: readonly SubscriptionVersionRow[],
  subscriptionId: string,
): SubscriptionVersionRow[] {
  return sortByEffectiveFrom(
    versions.filter((v) => v.subscription_id === subscriptionId && !v.deleted_at),
  );
}

/**
 * 当前版本 = effective_from <= today 的那些版本里 effective_from 最大的一条。
 * 这是需求里明确的定义，全项目只在这里实现一次。
 */
export function currentVersion(
  versions: readonly SubscriptionVersionRow[],
  today: string,
): SubscriptionVersionRow | null {
  let found: SubscriptionVersionRow | null = null;
  for (const v of sortByEffectiveFrom(versions.filter((x) => !x.deleted_at))) {
    if (compareDateOnly(v.effective_from, today) <= 0) found = v;
    else break;
  }
  return found;
}

/** 在指定日期生效的版本（用于「未来 30 天」按到期日挑选正确版本）。 */
export function versionAt(
  versions: readonly SubscriptionVersionRow[],
  date: string,
): SubscriptionVersionRow | null {
  return currentVersion(versions, date);
}

/** 最新版本（不看到期日），用于「下一次要改价时基于哪一版」。 */
export function latestVersion(
  versions: readonly SubscriptionVersionRow[],
): SubscriptionVersionRow | null {
  const sorted = sortByEffectiveFrom(versions.filter((x) => !x.deleted_at));
  return sorted.length > 0 ? (sorted[sorted.length - 1] as SubscriptionVersionRow) : null;
}

/** 第一个生效的版本。 */
export function firstVersion(
  versions: readonly SubscriptionVersionRow[],
): SubscriptionVersionRow | null {
  const sorted = sortByEffectiveFrom(versions.filter((x) => !x.deleted_at));
  return sorted.length > 0 ? (sorted[0] as SubscriptionVersionRow) : null;
}

// ---------------------------------------------------------------------------
// 扣款记录
// ---------------------------------------------------------------------------

/** 最近一次扣款（先比 charge_date，再比 created_at）。 */
export function latestCharge(charges: readonly ChargeRow[]): ChargeRow | null {
  let best: ChargeRow | null = null;
  for (const c of charges) {
    if (c.deleted_at) continue;
    if (best === null) {
      best = c;
      continue;
    }
    if (c.charge_date > best.charge_date) best = c;
    else if (c.charge_date === best.charge_date && c.created_at > best.created_at) best = c;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 状态判定
// ---------------------------------------------------------------------------

function result(
  status: SubscriptionStatus,
  reasonCode: StatusReasonCode,
  reason: string,
  next: string | null,
  currentVersionId: string | null,
): StatusResult {
  return { status, reasonCode, reason, nextDueDate: next, currentVersionId };
}

/**
 * 判定一个订阅的状态。
 *
 * @param subscription 订阅主体
 * @param versions     该订阅（或全部）的价格版本，函数内部会自行过滤
 * @param today        用户时区下的今天（YYYY-MM-DD）
 * @param charges      该订阅（或全部）的扣款记录；不传则跳过「最近一次扣款失败」检查
 *
 * 判定优先级：取消 > 结束日 > 无版本 > 试用未转正 > 扣款失败 > 手动未续费 > 正常。
 * 前面的条件一旦命中就直接返回，保证结果稳定、不出现「既是 ended 又是 anomaly」。
 */
export function getStatus(
  subscription: SubscriptionRow,
  versions: readonly SubscriptionVersionRow[],
  today: string,
  charges: readonly ChargeRow[] = [],
): StatusResult {
  const subVersions = versionsForSubscription(versions, subscription.id);

  // 1) 已取消
  if (subscription.cancelled_at) {
    return result('ended', 'cancelled', '已取消', null, null);
  }

  // 2) 已过结束日
  if (subscription.end_date && compareDateOnly(today, subscription.end_date) > 0) {
    return result(
      'ended',
      'end_date_passed',
      `已于 ${subscription.end_date} 结束`,
      null,
      null,
    );
  }

  // 3) 一个版本都没有 —— 数据不完整
  if (subVersions.length === 0) {
    return result('anomaly', 'no_version', '还没有任何价格版本', null, null);
  }

  const current = currentVersion(subVersions, today);

  // 4) 所有版本都还没生效 —— 属于「还没开始」，不是异常
  if (current === null) {
    const upcoming = subVersions.find((v) => compareDateOnly(v.effective_from, today) > 0);
    if (!upcoming) {
      return result('anomaly', 'no_version', '还没有任何价格版本', null, null);
    }
    const next = nextDueDate(upcoming, subscription.start_date, today, {
      endDate: subscription.end_date,
      cancelledAt: subscription.cancelled_at,
    });
    return result(
      'active',
      'scheduled',
      `将于 ${upcoming.effective_from} 开始`,
      next,
      null,
    );
  }

  const dueOpts = { endDate: subscription.end_date, cancelledAt: subscription.cancelled_at };

  // 到期日的锚点：有过试用转正的订阅，从转正日起重新起算（见 dueAnchorFor）。
  // 这里用「投影后」的版本列表，这样试用还在进行、转正版本尚未由 Cron 插入时，
  // 锚点就已经是未来的转正日了 —— 试用期内的「下次到期」会显示成转正日，
  // 而不是试用版本自己那个没有意义的周期日。
  const projectedVersions = projectAfterTrialVersions(subVersions);
  const anchor = dueAnchorFor(subscription, projectedVersions);
  const next = nextDueDate(current, anchor, today, dueOpts);

  const isTrial = boolOf(current.is_trial);

  // 5) 试用已过期却没有转正版本。
  //    严格用 today > trial_end_date：在试用结束日当天，Cron 还没跑完也不该算异常。
  //    如果转正版本已经插入（effective_from = trial_end_date <= today），
  //    那么 current 就会是那个转正版本，自然不会走到这里。
  if (isTrial && current.trial_end_date && compareDateOnly(today, current.trial_end_date) > 0) {
    return result(
      'anomaly',
      'trial_expired_no_conversion',
      `试用已于 ${current.trial_end_date} 到期，但没有转正版本`,
      next,
      current.id,
    );
  }

  // 6) 最近一次扣款失败
  const lastCharge = latestCharge(
    charges.filter((c) => c.subscription_id === subscription.id),
  );
  if (lastCharge && lastCharge.status === 'failed') {
    return result(
      'anomaly',
      'last_charge_failed',
      `最近一次扣款（${lastCharge.charge_date}）失败`,
      next,
      current.id,
    );
  }

  // 7) 手动续费：已经过了到期日却没有续费记录
  if (subscription.renew_mode === 'manual' && current.cycle_type !== 'lifetime') {
    const lastDue = previousDueDate(current, anchor, today, {
      endDate: subscription.end_date,
    });
    if (lastDue && compareDateOnly(today, lastDue) > 0) {
      const subCharges = charges.filter(
        (c) => c.subscription_id === subscription.id && !c.deleted_at,
      );
      const renewedByCharge = subCharges.some(
        (c) =>
          c.status === 'paid' &&
          compareDateOnly(c.charge_date, lastDue) >= 0 &&
          compareDateOnly(c.charge_date, today) <= 0,
      );
      // 续费记录有两种写法：记一笔扣款，或者在续费日新建一个价格版本。
      // 用 >= lastDue：正好落在到期日当天的版本也算续费
      // （否则「在到期日新建版本」这种最自然的写法会被误判成没续费）。
      const renewedByVersion = subVersions.some(
        (v) => compareDateOnly(v.effective_from, lastDue) >= 0,
      );
      if (!renewedByCharge && !renewedByVersion) {
        return result(
          'anomaly',
          'manual_renew_overdue',
          `手动续费：${lastDue} 已到期，但没有续费记录`,
          next,
          current.id,
        );
      }
    }
  }

  // 8) 正常
  if (current.cycle_type === 'lifetime') {
    return result('active', 'lifetime', '终身授权，无需续费', null, current.id);
  }
  if (isTrial) {
    return result(
      'active',
      'trial_active',
      current.trial_end_date ? `试用中，${current.trial_end_date} 结束` : '试用中',
      next,
      current.id,
    );
  }
  return result('active', 'ok', dueText(next), next, current.id);
}

function dueText(next: string | null): string {
  return next ? `正常，下次到期 ${next}` : '正常';
}

// ---------------------------------------------------------------------------
// 试用转正投影
// ---------------------------------------------------------------------------

/**
 * 生成「试用转正后」的版本投影。
 *
 * 现实里这个版本由 Cron 在 trial_end_date 当天真正插入；
 * 但在它被插入之前，前端/汇总也需要知道「转正之后要花多少钱」，
 * 所以这里凭空造一个 effective_from = trial_end_date 的等价版本（只存在于内存）。
 *
 * 已经存在同一天的真实版本时不会重复造。
 * 投影版本的 id 带 '::after-trial' 后缀，一眼能看出不是数据库里的真实行。
 */
export function projectAfterTrialVersions(
  versions: readonly SubscriptionVersionRow[],
): SubscriptionVersionRow[] {
  const alive = sortByEffectiveFrom(versions.filter((v) => !v.deleted_at));
  const projected: SubscriptionVersionRow[] = [...alive];

  for (const v of alive) {
    if (!boolOf(v.is_trial)) continue;
    if (!v.trial_end_date) continue;
    if (v.after_trial_amount_minor === null || v.after_trial_cycle_type === null) continue;
    if (alive.some((x) => x.effective_from === v.trial_end_date)) continue;

    projected.push({
      ...v,
      id: `${v.id}::after-trial`,
      effective_from: v.trial_end_date,
      amount_minor: v.after_trial_amount_minor,
      currency: v.after_trial_currency ?? v.currency,
      cycle_type: v.after_trial_cycle_type,
      cycle_days: v.after_trial_cycle_days ?? null,
      is_trial: 0,
      trial_end_date: null,
      after_trial_amount_minor: null,
      after_trial_currency: null,
      after_trial_cycle_type: null,
      after_trial_cycle_days: null,
    });
  }

  return sortByEffectiveFrom(projected);
}

// ---------------------------------------------------------------------------
// 付费周期锚点（B1 定稿：试用转正后从转正日重新起算）
// ---------------------------------------------------------------------------

/**
 * 找出该订阅的「转正日」。
 *
 * 判定方式：存在一个试用版本 t 和一个非试用版本 c，且
 * `c.effective_from === t.trial_end_date`，那 c 就是转正版本，转正日就是 c.effective_from。
 *
 * 注意这里认的是「数据形态」而不是某个标记位，所以：
 *   - Cron 真实插入的转正版本能认出来；
 *   - `projectAfterTrialVersions` 造出来的投影版本（effective_from = trial_end_date）也能认出来。
 *
 * @returns 转正日（YYYY-MM-DD）；没有试用转正过则为 null
 */
export function trialConversionDate(
  versions: readonly SubscriptionVersionRow[],
): string | null {
  const alive = versions.filter((v) => !v.deleted_at);
  const trials = alive.filter((v) => boolOf(v.is_trial) && v.trial_end_date !== null);
  if (trials.length === 0) return null;

  const conversionDates = alive
    .filter((c) => !boolOf(c.is_trial))
    .filter((c) => trials.some((t) => t.trial_end_date === c.effective_from))
    .map((c) => c.effective_from)
    .sort();

  return conversionDates.length > 0 ? (conversionDates[0] as string) : null;
}

/**
 * 计算到期日的锚点（周期的「起算日」）。
 *
 * - 普通订阅：`subscription.start_date`（保持原行为，`nextDueDate` 签名不变）。
 * - 有过试用转正的订阅：**转正日**，即第一个转正版本的 `effective_from`。
 *   转正后这个「付费周期」是从转正日开始的，所以此后所有到期日都以它为锚点，
 *   后面的调价版本也沿用同一个锚点，不会因为换了版本就漂移。
 *
 * @param versions 建议传 `projectAfterTrialVersions()` 的结果，
 *                 这样试用还在进行、转正版本尚未落库时锚点就已经是转正日
 */
export function dueAnchorFor(
  subscription: SubscriptionRow,
  versions: readonly SubscriptionVersionRow[],
): string {
  return trialConversionDate(versions) ?? subscription.start_date;
}

// ---------------------------------------------------------------------------
// 批量判定
// ---------------------------------------------------------------------------

export interface StatusEntry {
  subscription: SubscriptionRow;
  status: StatusResult;
}

/**
 * 批量判定。这是 summarize / 列表页共用的入口：
 * 一次遍历所有版本和扣款，避免每个订阅各扫一遍。
 */
export function getStatusForAll(
  subscriptions: readonly SubscriptionRow[],
  versions: readonly SubscriptionVersionRow[],
  today: string,
  charges: readonly ChargeRow[] = [],
): StatusEntry[] {
  return subscriptions
    .filter((s) => !s.deleted_at)
    .map((subscription) => ({
      subscription,
      status: getStatus(subscription, versions, today, charges),
    }));
}

/** 按状态分组计数。 */
export function countByStatus(entries: readonly StatusEntry[]): Record<SubscriptionStatus, number> {
  const counts: Record<SubscriptionStatus, number> = { active: 0, ended: 0, anomaly: 0 };
  for (const e of entries) counts[e.status.status] += 1;
  return counts;
}
