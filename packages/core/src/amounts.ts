/**
 * 订阅管家 —— 月均 / 年均折算（纯函数）
 *
 * 规则（需求原文）：
 *   季度除以 3，半年除以 6，按年除以 12，
 *   固定天数的乘以 365/12/cycle_days，
 *   终身订阅按 settings.amortize_lifetime_months 摊销。
 *   结果四舍五入到最小单位。
 *
 * 全程使用整数有理数运算（ratioMinor），不做浮点除法后再舍入。
 */

import { ratioMinor } from './money.js';
import { cycleMonths, requireCycleDays } from './cycles.js';
import { boolOf, type SubscriptionVersionRow, type SummarizeSettings } from './types.js';

/** 折算所用的「金额基准」：默认取版本自身，也可取试用转正后的价格。 */
export interface AmountBasis {
  amount_minor: number;
  cycle_type: SubscriptionVersionRow['cycle_type'];
  cycle_days: number | null;
  currency: string;
  /** 这个基准是不是「试用转正后的价格」。 */
  is_after_trial: boolean;
}

export interface AmountOptions {
  /**
   * 试用版本是否改用 after_trial_* 的价格来折算。
   *
   * 默认 false：试用期间实际支出就是 amount_minor（通常是 0）。
   * summarize() 用 true：因为「月均支出」关心的是这个订阅长期占用多少钱，
   * 而且用 after_trial 价格可以让转正前后算出来的月均保持一致。
   */
  useAfterTrial?: boolean;
}

/**
 * 取出版本里参与金额折算的那组字段。
 * 当版本是试用、且调用方要求用转正价格、且 after_trial_* 填全了，就用转正价。
 */
export function amountBasisOf(
  version: SubscriptionVersionRow,
  opts: AmountOptions = {},
): AmountBasis {
  const wantAfterTrial = opts.useAfterTrial === true;
  const hasAfterTrial =
    boolOf(version.is_trial) &&
    version.after_trial_amount_minor !== null &&
    version.after_trial_amount_minor !== undefined &&
    version.after_trial_cycle_type !== null &&
    version.after_trial_cycle_type !== undefined;

  if (wantAfterTrial && hasAfterTrial) {
    return {
      amount_minor: version.after_trial_amount_minor as number,
      cycle_type: version.after_trial_cycle_type as SubscriptionVersionRow['cycle_type'],
      cycle_days: version.after_trial_cycle_days ?? null,
      currency: version.after_trial_currency ?? version.currency,
      is_after_trial: true,
    };
  }

  return {
    amount_minor: version.amount_minor,
    cycle_type: version.cycle_type,
    cycle_days: version.cycle_days ?? null,
    currency: version.currency,
    is_after_trial: false,
  };
}

/**
 * 折算成「每月多少钱」（最小单位）。
 *
 *   month      -> 原值
 *   quarter    -> ÷ 3
 *   half_year  -> ÷ 6
 *   year       -> ÷ 12
 *   days       -> × 365 ÷ 12 ÷ cycle_days
 *   lifetime   -> ÷ amortize_lifetime_months（填 0 表示不摊销，结果记 0）
 */
export function toMonthlyAmount(
  version: SubscriptionVersionRow,
  settings: Pick<SummarizeSettings, 'amortize_lifetime_months'>,
  opts: AmountOptions = {},
): number {
  const basis = amountBasisOf(version, opts);
  const amount = basis.amount_minor;

  if (basis.cycle_type === 'lifetime') {
    const months = settings.amortize_lifetime_months;
    if (!Number.isInteger(months) || months <= 0) return 0; // 不摊销
    return ratioMinor(amount, 1, months);
  }

  if (basis.cycle_type === 'days') {
    const days = requireCycleDays(basis);
    return ratioMinor(amount, 365, 12 * days);
  }

  const months = cycleMonths(basis.cycle_type);
  if (months === null) {
    throw new RangeError(`toMonthlyAmount: 无法折算周期 ${basis.cycle_type}`);
  }
  return ratioMinor(amount, 1, months);
}

/**
 * 折算成「每年多少钱」（最小单位）。
 *
 *   month      -> × 12
 *   quarter    -> × 4
 *   half_year  -> × 2
 *   year       -> 原值
 *   days       -> × 365 ÷ cycle_days
 *   lifetime   -> × 12 ÷ amortize_lifetime_months（填 0 表示不摊销，结果记 0）
 *
 * 注意：年额直接由周期算出，不是「月额 × 12」，避免两次舍入叠加误差。
 */
export function toYearlyAmount(
  version: SubscriptionVersionRow,
  settings: Pick<SummarizeSettings, 'amortize_lifetime_months'>,
  opts: AmountOptions = {},
): number {
  const basis = amountBasisOf(version, opts);
  const amount = basis.amount_minor;

  switch (basis.cycle_type) {
    case 'month':
      return amount * 12;
    case 'quarter':
      return amount * 4;
    case 'half_year':
      return amount * 2;
    case 'year':
      return amount;
    case 'days': {
      const days = requireCycleDays(basis);
      return ratioMinor(amount, 365, days);
    }
    case 'lifetime': {
      const months = settings.amortize_lifetime_months;
      if (!Number.isInteger(months) || months <= 0) return 0; // 不摊销
      return ratioMinor(amount, 12, months);
    }
    default: {
      const never: never = basis.cycle_type;
      throw new RangeError(`toYearlyAmount: 未知周期 ${String(never)}`);
    }
  }
}

/**
 * 一个周期内实际要扣的金额（原币最小单位），用于「未来 30 天将扣多少钱」。
 * 试用版本按其转正后的价格计（如果填了 after_trial_*），否则按版本本身。
 */
export function perCycleAmountMinor(
  version: SubscriptionVersionRow,
  opts: AmountOptions = {},
): { amount_minor: number; currency: string } {
  const basis = amountBasisOf(version, { useAfterTrial: true, ...opts });
  return { amount_minor: basis.amount_minor, currency: basis.currency };
}
