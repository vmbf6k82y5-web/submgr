/**
 * 订阅管家 —— 总览汇总（纯函数）
 *
 * summarize() 是「总览」页唯一的后端数据源，一次算清：
 *   * 各状态的订阅数量（active / ended / anomaly）
 *   * 月均、年均支出（基准币种，最小单位）
 *   * 未来 30 天将扣的金额
 *   * 汇率是否过期（stale）
 *   * 缺失汇率的币种列表（此时三个合计都是 null，而不是少算一个币种）
 */

import { convert, normalizeCurrency } from './money.js';
import { compareDateOnly, addDaysDateOnly } from './time.js';
import { dueDatesBetween } from './cycles.js';
import { perCycleAmountMinor, toMonthlyAmount, toYearlyAmount } from './amounts.js';
import { isStale, missingCurrencies as collectMissing, rateAgeHours } from './fx.js';
import {
  countByStatus,
  currentVersion,
  dueAnchorFor,
  getStatusForAll,
  projectAfterTrialVersions,
  versionsForSubscription,
  type StatusReasonCode,
} from './status.js';
import type {
  ChargeRow,
  FxSnapshot,
  SettingsRow,
  SubscriptionRow,
  SubscriptionStatus,
  SubscriptionVersionRow,
} from './types.js';

/** 「未来 30 天」的窗口长度。 */
export const UPCOMING_WINDOW_DAYS = 30;

export interface SummarizeOptions {
  /** 用于判定汇率过期；测试里注入固定时刻。默认 new Date()。 */
  now?: Date;
  /** 扣款记录，用于「最近一次扣款失败」这类异常判断。 */
  charges?: readonly ChargeRow[];
  /** 未来窗口天数，默认 30。 */
  windowDays?: number;
}

export interface AnomalyEntry {
  subscriptionId: string;
  name: string;
  reasonCode: StatusReasonCode;
  reason: string;
}

export interface SummaryResult {
  /** 统计口径的基准币种。 */
  baseCurrency: string;
  /** 用户时区。 */
  timezone: string;
  /** 统计时使用的「今天」。 */
  today: string;

  counts: {
    total: number;
    active: number;
    ended: number;
    anomaly: number;
  };
  /** 各状态分别有哪些订阅（前端「三种状态分开统计」直接用这个）。 */
  byStatus: Record<SubscriptionStatus, AnomalyEntry[]>;

  /** 月均支出（基准币种最小单位）；有币种缺汇率时为 null。 */
  monthlyAverageMinor: number | null;
  /** 年均支出（基准币种最小单位）；有币种缺汇率时为 null。 */
  yearlyAverageMinor: number | null;
  /** 未来 30 天将扣的金额（基准币种最小单位）；有币种缺汇率时为 null。 */
  next30DaysMinor: number | null;

  /** 最新汇率是否超过 48 小时未更新（没有汇率的也是 true）。 */
  stale: boolean;
  /** 最新汇率的抓取时刻。 */
  fxAsOf: string | null;
  /** 最新汇率距今多少小时。 */
  fxAgeHours: number | null;
  /** 缺失汇率的币种（已排序、去重、不含 USD）。非空时三个合计均为 null。 */
  missingCurrencies: string[];

  /** 所有异常订阅，供「标红」列表使用。 */
  anomalies: AnomalyEntry[];
}

function toEntry(subscription: SubscriptionRow, reasonCode: StatusReasonCode, reason: string): AnomalyEntry {
  return { subscriptionId: subscription.id, name: subscription.name, reasonCode, reason };
}

/**
 * 汇总。
 *
 * @param subscriptions 订阅主体（未软删除的）
 * @param versions      价格版本（可以是全部订阅的，函数内部按订阅过滤）
 * @param fx            汇率快照（用 fxSnapshotFromRows 从 D1 行构造）
 * @param settings      至少包含 base_currency / timezone / amortize_lifetime_months
 * @param today         用户时区下的今天 YYYY-MM-DD
 */
export function summarize(
  subscriptions: readonly SubscriptionRow[],
  versions: readonly SubscriptionVersionRow[],
  fx: FxSnapshot,
  settings: SettingsRow,
  today: string,
  opts: SummarizeOptions = {},
): SummaryResult {
  const base = normalizeCurrency(settings.base_currency);
  const windowDays = opts.windowDays ?? UPCOMING_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const charges = opts.charges ?? [];

  const entries = getStatusForAll(subscriptions, versions, today, charges);
  const counts = countByStatus(entries);

  const byStatus: Record<SubscriptionStatus, AnomalyEntry[]> = {
    active: [],
    ended: [],
    anomaly: [],
  };
  for (const e of entries) {
    byStatus[e.status.status].push(toEntry(e.subscription, e.status.reasonCode, e.status.reason));
  }

  // 参与金额统计的：active + anomaly。
  // ended 的订阅不应再计入「我每月要花多少钱」。
  const included = entries.filter((e) => e.status.status !== 'ended');

  // 先把需要的币种全部登记下来，再统一判断缺不缺汇率，
  // 这样「缺汇率 -> 合计为 null」是一步到位的，不会中途悄悄跳过某个币种。
  //
  // 注意：基准币种自己不登记。它在 convert() 里是同币种直通（1:1），
  // 本来就不需要汇率；如果把它也算成「缺汇率」，那么只要汇率表是空的，
  // 连纯 CNY 的账本都会算不出来，这显然不合理。
  const requiredCurrencies = new Set<string>();
  const requireCurrency = (currency: string): void => {
    if (currency !== base) requiredCurrencies.add(currency);
  };
  let monthlySum = 0;
  let yearlySum = 0;
  let upcomingSum = 0;
  let monthlyFailed = false;
  let yearlyFailed = false;
  let upcomingFailed = false;

  const windowEnd = addDaysDateOnly(today, windowDays);

  for (const e of included) {
    const sub = e.subscription;
    const subVersions = versionsForSubscription(versions, sub.id);
    if (subVersions.length === 0) continue;

    // ---- 月均 / 年均：用当前版本，试用按转正价折算（保证转正前后数字稳定） ----
    const current = currentVersion(subVersions, today);
    if (current) {
      const currency = normalizeCurrency(current.currency);
      requireCurrency(currency);

      const monthly = toMonthlyAmount(current, settings, { useAfterTrial: true });
      const yearly = toYearlyAmount(current, settings, { useAfterTrial: true });

      const monthlyBase = convert(monthly, currency, base, fx);
      const yearlyBase = convert(yearly, currency, base, fx);
      if (monthlyBase === null) monthlyFailed = true;
      else monthlySum += monthlyBase;
      if (yearlyBase === null) yearlyFailed = true;
      else yearlySum += yearlyBase;
    }

    // ---- 未来 N 天：按到期日挑「当天生效的版本」，试用跨过 trial_end_date 时用转正价 ----
    const projected = projectAfterTrialVersions(subVersions);
    const dueOpts = { endDate: sub.end_date, cancelledAt: sub.cancelled_at };
    // 锚点：普通订阅用 start_date；试用转正过的订阅用转正日（B1 定稿）。
    // 每个订阅只算一次，段与段之间共用同一个锚点，保证周期不会在转正处错位。
    const anchor = dueAnchorFor(sub, projected);

    for (let i = 0; i < projected.length; i += 1) {
      const v = projected[i] as SubscriptionVersionRow;
      const segmentEnd = projected[i + 1]?.effective_from ?? null;

      // 该版本区间内、窗口内的所有到期日
      const dueDates = dueDatesBetween(v, anchor, today, windowEnd, dueOpts);
      for (const due of dueDates) {
        if (compareDateOnly(due, v.effective_from) < 0) continue;
        if (segmentEnd && compareDateOnly(due, segmentEnd) >= 0) continue;

        const perCycle = perCycleAmountMinor(v);
        const currency = normalizeCurrency(perCycle.currency);
        requireCurrency(currency);

        const inBase = convert(perCycle.amount_minor, currency, base, fx);
        if (inBase === null) upcomingFailed = true;
        else upcomingSum += inBase;
      }
    }
  }

  const missing = collectMissing(requiredCurrencies, fx);
  const hasMissing = missing.length > 0;

  return {
    baseCurrency: base,
    timezone: settings.timezone,
    today,
    counts: {
      total: counts.active + counts.ended + counts.anomaly,
      active: counts.active,
      ended: counts.ended,
      anomaly: counts.anomaly,
    },
    byStatus,
    monthlyAverageMinor: hasMissing || monthlyFailed ? null : monthlySum,
    yearlyAverageMinor: hasMissing || yearlyFailed ? null : yearlySum,
    next30DaysMinor: hasMissing || upcomingFailed ? null : upcomingSum,
    stale: isStale(fx.asOf, now),
    fxAsOf: fx.asOf,
    fxAgeHours: rateAgeHours(fx.asOf, now),
    missingCurrencies: missing,
    anomalies: byStatus.anomaly,
  };
}
