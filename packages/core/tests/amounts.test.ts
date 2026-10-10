import { describe, expect, it } from 'vitest';
import {
  amountBasisOf,
  perCycleAmountMinor,
  toMonthlyAmount,
  toYearlyAmount,
} from '../src/amounts.js';
import { makeVersion } from './fixtures.js';
import type { SubscriptionVersionRow } from '../src/types.js';

const settings = { amortize_lifetime_months: 36 };
const noAmortize = { amortize_lifetime_months: 0 };

describe('amounts: 固定周期', () => {
  it('月付：月均就是原值，年均 ×12', () => {
    const v = makeVersion({ amount_minor: 2500, cycle_type: 'month' });
    expect(toMonthlyAmount(v, settings)).toBe(2500);
    expect(toYearlyAmount(v, settings)).toBe(30000);
  });

  it('季付：月均 ÷3，年均 ×4', () => {
    const v = makeVersion({ amount_minor: 30000, cycle_type: 'quarter' });
    expect(toMonthlyAmount(v, settings)).toBe(10000);
    expect(toYearlyAmount(v, settings)).toBe(120000);
  });

  it('季付除不尽时四舍五入到最小单位', () => {
    const v = makeVersion({ amount_minor: 10000, cycle_type: 'quarter' });
    expect(toMonthlyAmount(v, settings)).toBe(3333); // 3333.33
    expect(toYearlyAmount(v, settings)).toBe(40000);
  });

  it('半年付：月均 ÷6，年均 ×2', () => {
    const v = makeVersion({ amount_minor: 60000, cycle_type: 'half_year' });
    expect(toMonthlyAmount(v, settings)).toBe(10000);
    expect(toYearlyAmount(v, settings)).toBe(120000);
  });

  it('年付：月均 ÷12，年均就是原值', () => {
    const v = makeVersion({ amount_minor: 81600, cycle_type: 'year' });
    expect(toMonthlyAmount(v, settings)).toBe(6800);
    expect(toYearlyAmount(v, settings)).toBe(81600);
  });

  it('年付除不尽时会进位（不是截断）', () => {
    const v = makeVersion({ amount_minor: 1000, cycle_type: 'year' });
    expect(toMonthlyAmount(v, settings)).toBe(83); // 83.33
    expect(toYearlyAmount(v, settings)).toBe(1000);
  });

  it('年均不是月均 ×12（避免二次舍入误差累积）', () => {
    const v = makeVersion({ amount_minor: 10000, cycle_type: 'quarter' });
    const monthly = toMonthlyAmount(v, settings); // 3333
    const yearly = toYearlyAmount(v, settings); // 40000
    expect(monthly * 12).not.toBe(yearly); // 39996 !== 40000
    expect(yearly).toBe(40000);
  });
});

describe('amounts: 固定天数', () => {
  it('月均 = 金额 × 365 ÷ 12 ÷ cycle_days', () => {
    const v = makeVersion({ amount_minor: 3000, cycle_type: 'days', cycle_days: 30 });
    // 3000 * 365 / (12*30) = 1095000/360 = 3041.67 -> 3042
    expect(toMonthlyAmount(v, settings)).toBe(3042);
    // 3000 * 365 / 30 = 36500
    expect(toYearlyAmount(v, settings)).toBe(36500);
  });

  it('7 天周期与 30 天周期折算出同样的年均（同为 ¥365/年）', () => {
    const weekly = makeVersion({ amount_minor: 700, cycle_type: 'days', cycle_days: 7 });
    const monthly = makeVersion({ amount_minor: 3000, cycle_type: 'days', cycle_days: 30 });
    expect(toYearlyAmount(weekly, settings)).toBe(36500);
    expect(toYearlyAmount(monthly, settings)).toBe(36500);
    expect(toMonthlyAmount(weekly, settings)).toBe(3042);
    expect(toMonthlyAmount(monthly, settings)).toBe(3042);
  });

  it('1 天周期', () => {
    const v = makeVersion({ amount_minor: 100, cycle_type: 'days', cycle_days: 1 });
    expect(toYearlyAmount(v, settings)).toBe(36500);
    expect(toMonthlyAmount(v, settings)).toBe(3042); // 36500/12
  });

  it('缺 cycle_days 时抛错', () => {
    const v = makeVersion({ amount_minor: 100, cycle_type: 'days', cycle_days: null });
    expect(() => toMonthlyAmount(v, settings)).toThrow(RangeError);
    expect(() => toYearlyAmount(v, settings)).toThrow(RangeError);
  });
});

describe('amounts: 终身订阅摊销', () => {
  it('按 amortize_lifetime_months 摊销', () => {
    const v = makeVersion({ amount_minor: 214800, cycle_type: 'lifetime' });
    // 214800 / 36 = 5966.67 -> 5967
    expect(toMonthlyAmount(v, settings)).toBe(5967);
    // 214800 * 12 / 36 = 71600
    expect(toYearlyAmount(v, settings)).toBe(71600);
  });

  it('填 0 表示不摊销，月均与年均都是 0', () => {
    const v = makeVersion({ amount_minor: 214800, cycle_type: 'lifetime' });
    expect(toMonthlyAmount(v, noAmortize)).toBe(0);
    expect(toYearlyAmount(v, noAmortize)).toBe(0);
  });

  it('其他摊销月数', () => {
    const v = makeVersion({ amount_minor: 120000, cycle_type: 'lifetime' });
    expect(toMonthlyAmount(v, { amortize_lifetime_months: 12 })).toBe(10000);
    expect(toYearlyAmount(v, { amortize_lifetime_months: 12 })).toBe(120000);
    expect(toMonthlyAmount(v, { amortize_lifetime_months: 60 })).toBe(2000);
    expect(toYearlyAmount(v, { amortize_lifetime_months: 60 })).toBe(24000);
  });

  it('负数的摊销月数也视为不摊销', () => {
    const v = makeVersion({ amount_minor: 120000, cycle_type: 'lifetime' });
    expect(toMonthlyAmount(v, { amortize_lifetime_months: -6 })).toBe(0);
    expect(toYearlyAmount(v, { amortize_lifetime_months: -6 })).toBe(0);
  });
});

describe('amounts: 小数位不同的币种', () => {
  it('日元（0 位小数）', () => {
    const v = makeVersion({ amount_minor: 1200, currency: 'JPY', cycle_type: 'month' });
    expect(toMonthlyAmount(v, settings)).toBe(1200);
    expect(toYearlyAmount(v, settings)).toBe(14400);
  });

  it('日元年付折算月均', () => {
    const v = makeVersion({ amount_minor: 12000, currency: 'JPY', cycle_type: 'year' });
    expect(toMonthlyAmount(v, settings)).toBe(1000);
    expect(toYearlyAmount(v, settings)).toBe(12000);
  });

  it('科威特第纳尔（3 位小数）', () => {
    const v = makeVersion({ amount_minor: 1234, currency: 'KWD', cycle_type: 'lifetime' });
    expect(toMonthlyAmount(v, settings)).toBe(34); // 1234/36 = 34.28
    expect(toYearlyAmount(v, settings)).toBe(411); // 1234*12/36 = 411.33
  });
});

describe('amounts: 试用版本', () => {
  const trial: SubscriptionVersionRow = makeVersion({
    amount_minor: 0,
    cycle_type: 'month',
    is_trial: 1,
    trial_end_date: '2024-01-14',
    after_trial_amount_minor: 9900,
    after_trial_currency: 'CNY',
    after_trial_cycle_type: 'month',
    after_trial_cycle_days: null,
  });

  it('默认按试用期间的实际支出算（0）', () => {
    expect(toMonthlyAmount(trial, settings)).toBe(0);
    expect(toYearlyAmount(trial, settings)).toBe(0);
  });

  it('useAfterTrial 时按转正价格算', () => {
    expect(toMonthlyAmount(trial, settings, { useAfterTrial: true })).toBe(9900);
    expect(toYearlyAmount(trial, settings, { useAfterTrial: true })).toBe(118800);
  });

  it('转正前后月均保持一致（这是 summarize 用 useAfterTrial 的原因）', () => {
    const converted = makeVersion({
      amount_minor: 9900,
      currency: 'CNY',
      cycle_type: 'month',
      is_trial: 0,
      effective_from: '2024-01-14',
    });
    expect(toMonthlyAmount(trial, settings, { useAfterTrial: true })).toBe(
      toMonthlyAmount(converted, settings),
    );
  });

  it('试用但没填转正价格时不会被误当成 0', () => {
    const trialNoAfter = makeVersion({
      amount_minor: 0,
      cycle_type: 'month',
      is_trial: 1,
      trial_end_date: '2024-01-14',
    });
    // 没有 after_trial_* 可退，只能回到试用本身的 0
    expect(toMonthlyAmount(trialNoAfter, settings, { useAfterTrial: true })).toBe(0);
  });

  it('试用转正是年付时的折算', () => {
    const trialYearly = makeVersion({
      amount_minor: 0,
      cycle_type: 'month',
      is_trial: 1,
      trial_end_date: '2024-01-14',
      after_trial_amount_minor: 81600,
      after_trial_currency: 'CNY',
      after_trial_cycle_type: 'year',
    });
    expect(toMonthlyAmount(trialYearly, settings, { useAfterTrial: true })).toBe(6800);
    expect(toYearlyAmount(trialYearly, settings, { useAfterTrial: true })).toBe(81600);
  });

  it('试用转正是固定天数周期', () => {
    const trialDays = makeVersion({
      amount_minor: 0,
      cycle_type: 'month',
      is_trial: 1,
      trial_end_date: '2024-01-14',
      after_trial_amount_minor: 700,
      after_trial_currency: 'CNY',
      after_trial_cycle_type: 'days',
      after_trial_cycle_days: 7,
    });
    expect(toMonthlyAmount(trialDays, settings, { useAfterTrial: true })).toBe(3042);
    expect(toYearlyAmount(trialDays, settings, { useAfterTrial: true })).toBe(36500);
  });

  it('amountBasisOf 会明确标出用的是哪套价格', () => {
    expect(amountBasisOf(trial, {}).is_after_trial).toBe(false);
    expect(amountBasisOf(trial, {}).amount_minor).toBe(0);
    expect(amountBasisOf(trial, { useAfterTrial: true }).is_after_trial).toBe(true);
    expect(amountBasisOf(trial, { useAfterTrial: true }).amount_minor).toBe(9900);
    // 非试用版本不受 useAfterTrial 影响
    const normal = makeVersion({ amount_minor: 2500, cycle_type: 'month' });
    expect(amountBasisOf(normal, { useAfterTrial: true }).amount_minor).toBe(2500);
    expect(amountBasisOf(normal, { useAfterTrial: true }).is_after_trial).toBe(false);
  });
});

describe('amounts: 单期扣款金额', () => {
  it('试用版本按转正后价格计（未来 30 天预估用）', () => {
    const trial = makeVersion({
      amount_minor: 0,
      cycle_type: 'month',
      is_trial: 1,
      trial_end_date: '2024-01-14',
      after_trial_amount_minor: 9900,
      after_trial_currency: 'CNY',
      after_trial_cycle_type: 'month',
    });
    expect(perCycleAmountMinor(trial)).toEqual({ amount_minor: 9900, currency: 'CNY' });
  });

  it('普通版本就是自身金额', () => {
    const v = makeVersion({ amount_minor: 2299, currency: 'USD', cycle_type: 'month' });
    expect(perCycleAmountMinor(v)).toEqual({ amount_minor: 2299, currency: 'USD' });
  });
});
