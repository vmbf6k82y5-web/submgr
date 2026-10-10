import { describe, expect, it } from 'vitest';
import type { SubscriptionVersionRow } from '@submgr/core';
import {
  changedFrozenFields,
  describeCycle,
  emptyVersionDraft,
  hasVersionOn,
  isFrozen,
  newVersionHint,
  priceDraftOf,
  validateVersionDraft,
  type VersionDraft,
} from './versioning';

const AUDIT = {
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  deleted_at: null,
};

function version(overrides: Partial<SubscriptionVersionRow> = {}): SubscriptionVersionRow {
  return {
    id: 'ver-1',
    subscription_id: 'sub-1',
    effective_from: '2026-07-12',
    plan_name: '连续包月',
    amount_minor: 2500,
    currency: 'CNY',
    cycle_type: 'month',
    cycle_days: null,
    is_trial: 0,
    trial_end_date: null,
    after_trial_amount_minor: null,
    after_trial_currency: null,
    after_trial_cycle_type: null,
    after_trial_cycle_days: null,
    ...AUDIT,
    ...overrides,
  };
}

const TODAY = '2026-10-10';

describe('versioning: 冻结判定', () => {
  it('生效日 <= 今天算已生效（冻结）', () => {
    expect(isFrozen({ effective_from: '2026-10-10' }, TODAY)).toBe(true);
    expect(isFrozen({ effective_from: '2026-10-11' }, TODAY)).toBe(false);
  });

  it('列出被改动的冻结字段', () => {
    const current = priceDraftOf(version());
    expect(changedFrozenFields(current, current)).toEqual([]);
    expect(changedFrozenFields(current, { ...current, amountMinor: 3000 })).toEqual(['金额']);
    expect(changedFrozenFields(current, { ...current, currency: 'USD' })).toEqual(['币种']);
    expect(changedFrozenFields(current, { ...current, cycleType: 'year' })).toEqual(['周期']);
    expect(
      changedFrozenFields(priceDraftOf(version({ cycle_type: 'days', cycle_days: 30 })), {
        amountMinor: 3000,
        currency: 'USD',
        cycleType: 'month',
        cycleDays: null,
      }),
    ).toEqual(['金额', '币种', '周期']);
    expect(
      changedFrozenFields(priceDraftOf(version({ cycle_type: 'days', cycle_days: 30 })), {
        amountMinor: 2500,
        currency: 'CNY',
        cycleType: 'days',
        cycleDays: 60,
      }),
    ).toEqual(['周期天数']);
    expect(changedFrozenFields(null, current)).toEqual([]);
  });
});

describe('versioning: 改价必须新建版本（需求点名）', () => {
  it('已生效版本改了金额 -> 必须新建版本，并说明历史不受影响', () => {
    const hint = newVersionHint(version(), { amountMinor: 3000, currency: 'CNY', cycleType: 'month', cycleDays: null }, TODAY);
    expect(hint.needsNewVersion).toBe(true);
    expect(hint.changed).toEqual(['金额']);
    expect(hint.message).toContain('新增一个价格版本');
    expect(hint.message).toContain('历史不受影响');
  });

  it('没改价格 -> 不需要新建版本', () => {
    const hint = newVersionHint(version(), priceDraftOf(version()), TODAY);
    expect(hint.needsNewVersion).toBe(false);
    expect(hint.message).toContain('不需要新建版本');
  });

  it('还没有生效版本时，直接新建即可', () => {
    const hint = newVersionHint(null, { amountMinor: 100, currency: 'CNY', cycleType: 'month', cycleDays: null }, TODAY);
    expect(hint.needsNewVersion).toBe(false);
    expect(hint.message).toContain('还没有生效中的价格版本');
  });

  it('版本还没生效时可以改它', () => {
    const future = version({ effective_from: '2026-12-01' });
    const hint = newVersionHint(future, { amountMinor: 9999, currency: 'CNY', cycleType: 'month', cycleDays: null }, TODAY);
    expect(hint.needsNewVersion).toBe(false);
    expect(hint.message).toContain('还没生效');
  });

  it('同订阅同一天只能有一个版本', () => {
    const versions = [version()];
    expect(hasVersionOn(versions, '2026-07-12')).toBe(true);
    expect(hasVersionOn(versions, '2026-07-13')).toBe(false);
    expect(hasVersionOn(versions, '2026-07-12', 'ver-1')).toBe(false);
  });

  it('周期描述', () => {
    expect(describeCycle('month', null)).toBe('月付');
    expect(describeCycle('days', 30)).toBe('固定天数（30 天）');
  });
});

describe('versioning: 表单校验', () => {
  const draft = (patch: Partial<VersionDraft> = {}): VersionDraft => ({
    ...emptyVersionDraft('CNY', '2026-10-10'),
    amount: '25.00',
    ...patch,
  });

  it('录入合法版本', () => {
    const result = validateVersionDraft(draft({ planName: '  高级会员  ' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      effective_from: '2026-10-10',
      plan_name: '高级会员',
      amount_minor: 2500,
      currency: 'CNY',
      cycle_type: 'month',
      cycle_days: null,
      is_trial: false,
      trial_end_date: null,
      after_trial_amount_minor: null,
      after_trial_currency: null,
      after_trial_cycle_type: null,
      after_trial_cycle_days: null,
    });
  });

  it('空套餐名存 null，而不是空串', () => {
    const result = validateVersionDraft(draft({ planName: '   ' }));
    expect(result.ok && result.value.plan_name).toBe(null);
  });

  it('币种必须 3 位字母', () => {
    const result = validateVersionDraft(draft({ currency: 'CN' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('currency');
  });

  it('固定天数周期必须给天数', () => {
    const result = validateVersionDraft(draft({ cycleType: 'days', cycleDays: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('cycleDays');

    const ok = validateVersionDraft(draft({ cycleType: 'days', cycleDays: '30' }));
    expect(ok.ok && ok.value.cycle_days).toBe(30);
  });

  it('金额精度超限直接报错（不静默截断）', () => {
    const result = validateVersionDraft(draft({ amount: '25.005' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('amount');
  });

  it('终身订阅不需要周期天数', () => {
    const result = validateVersionDraft(draft({ cycleType: 'lifetime', amount: '2148.00' }));
    expect(result.ok && result.value).toEqual(
      expect.objectContaining({ cycle_type: 'lifetime', amount_minor: 214800, cycle_days: null }),
    );
  });

  it('试用必须给结束日且必须晚于生效日', () => {
    const missing = validateVersionDraft(draft({ isTrial: true, trialEndDate: '' }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.field).toBe('trialEndDate');

    const wrongOrder = validateVersionDraft(
      draft({ isTrial: true, trialEndDate: '2026-10-09' }),
    );
    expect(wrongOrder.ok).toBe(false);

    const ok = validateVersionDraft(
      draft({
        isTrial: true,
        trialEndDate: '2026-10-24',
        afterTrialAmount: '99.00',
        afterTrialCycleType: 'month',
      }),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.is_trial).toBe(true);
    expect(ok.value.trial_end_date).toBe('2026-10-24');
    expect(ok.value.after_trial_amount_minor).toBe(9900);
    expect(ok.value.after_trial_cycle_type).toBe('month');
  });

  it('填了转正价却没选周期 -> 报错', () => {
    const result = validateVersionDraft(
      draft({ isTrial: true, trialEndDate: '2026-10-24', afterTrialAmount: '99.00', afterTrialCycleType: '' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('afterTrialCycleType');
  });

  it('试用后不续费：转正价留空即可', () => {
    const result = validateVersionDraft(draft({ isTrial: true, trialEndDate: '2026-10-24' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.after_trial_amount_minor).toBe(null);
    expect(result.value.after_trial_cycle_type).toBe(null);
  });

  it('生效日格式不对直接拦下', () => {
    const result = validateVersionDraft(draft({ effectiveFrom: '2026/10/10' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe('effectiveFrom');
  });
});
