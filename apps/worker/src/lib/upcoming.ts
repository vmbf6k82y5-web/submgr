/**
 * 「未来会有哪些到期」的统一算法。
 *
 * ICS 日历、到期提醒、周期汇总提醒都必须是同一份到期清单 ——
 * 否则会出现「日历里有、提醒里没有」这种自查不出来的错。
 * 所以这里做成唯一实现，三处共用。
 *
 * 口径与 summarize() 完全一致：
 *   * 跳过已结束（取消 / 过了 end_date）的订阅；
 *   * 试用转正后周期锚点 = 转正日（B1 定稿），用 projectAfterTrialVersions 投影；
 *   * 某个到期日属于「覆盖它的那个版本区间」，
 *     区间是 [v.effective_from, 下一个版本的 effective_from)；
 *   * 试用版本按转正价计（perCycleAmountMinor 内部已处理）。
 */

import {
  dueAnchorFor,
  dueDatesBetween,
  getStatus,
  perCycleAmountMinor,
  projectAfterTrialVersions,
  versionsForSubscription,
  type ChargeRow,
  type SubscriptionRow,
  type SubscriptionVersionRow,
} from '@submgr/core';

export interface UpcomingDue {
  subscription: SubscriptionRow;
  version: SubscriptionVersionRow;
  /** 到期日 YYYY-MM-DD */
  dueDate: string;
  amountMinor: number;
  currency: string;
}

export interface UpcomingDuesInput {
  /** 用户时区下的今天 */
  today: string;
  /** 区间左端点（**不含**）；默认 = today */
  from?: string;
  /** 区间右端点（**含**） */
  to: string;
  subscriptions: readonly SubscriptionRow[];
  versions: readonly SubscriptionVersionRow[];
  charges: readonly ChargeRow[];
}

/** 区间 (from, to] 内的所有到期，按到期日、订阅名排序。 */
export function upcomingDues(input: UpcomingDuesInput): UpcomingDue[] {
  const { today, subscriptions, versions, charges } = input;
  const from = input.from ?? today;
  const { to } = input;

  const out: UpcomingDue[] = [];

  for (const sub of subscriptions) {
    if (sub.deleted_at) continue;

    const subVersions = versionsForSubscription(versions, sub.id);
    if (subVersions.length === 0) continue;

    // 已结束的不再提醒，也不进日历
    const status = getStatus(sub, versions, today, charges);
    if (status.status === 'ended') continue;

    const projected = projectAfterTrialVersions(subVersions);
    const anchor = dueAnchorFor(sub, projected);
    const dueOpts = { endDate: sub.end_date, cancelledAt: sub.cancelled_at };

    for (let i = 0; i < projected.length; i += 1) {
      const version = projected[i] as SubscriptionVersionRow;
      const segmentEnd = projected[i + 1]?.effective_from ?? null;
      const perCycle = perCycleAmountMinor(version);

      for (const due of dueDatesBetween(version, anchor, from, to, dueOpts)) {
        if (due < version.effective_from) continue;
        if (segmentEnd !== null && due >= segmentEnd) continue;
        out.push({
          subscription: sub,
          version,
          dueDate: due,
          amountMinor: perCycle.amount_minor,
          currency: perCycle.currency,
        });
      }
    }
  }

  out.sort((a, b) => {
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    if (a.subscription.name !== b.subscription.name) {
      return a.subscription.name < b.subscription.name ? -1 : 1;
    }
    return a.subscription.id < b.subscription.id ? -1 : 1;
  });

  return out;
}
