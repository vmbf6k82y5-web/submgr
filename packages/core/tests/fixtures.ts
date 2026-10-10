/**
 * 测试夹具：构造与 D1 行结构一致的领域对象。
 *
 * 所有默认值都是「合法且正常」的，测试只覆盖自己关心的字段。
 */

import type {
  CategoryRow,
  ChargeRow,
  FxRateRow,
  FxSnapshot,
  NotificationChannelRow,
  ReminderRuleRow,
  SettingsRow,
  SubscriptionRow,
  SubscriptionVersionRow,
} from '../src/types.js';

const TS = '2024-01-01T00:00:00.000Z';

let seq = 0;
/** 生成稳定的测试 id（保证 DB 唯一性的场景用不到真 UUID）。 */
export function nextId(prefix = 'id'): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

export function makeSettings(overrides: Partial<SettingsRow> = {}): SettingsRow {
  return {
    id: 'settings-0001',
    base_currency: 'CNY',
    timezone: 'Asia/Shanghai',
    ics_token: 'test-ics-token-0123456789',
    amortize_lifetime_months: 36,
    created_at: TS,
    updated_at: TS,
    deleted_at: null,
    ...overrides,
  };
}

export function makeCategory(overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: nextId('cat'),
    name: '影音娱乐',
    color: '#ef4444',
    sort: 10,
    created_at: TS,
    updated_at: TS,
    deleted_at: null,
    ...overrides,
  };
}

export function makeSubscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: nextId('sub'),
    name: '示例订阅',
    category_id: null,
    sub_type: 'software',
    charge_channel: 'alipay',
    renew_mode: 'auto',
    start_date: '2024-01-15',
    end_date: null,
    cancelled_at: null,
    note: null,
    icon: null,
    created_at: TS,
    updated_at: TS,
    deleted_at: null,
    ...overrides,
  };
}

export function makeVersion(
  overrides: Partial<SubscriptionVersionRow> = {},
): SubscriptionVersionRow {
  return {
    id: nextId('ver'),
    subscription_id: 'sub-0001',
    effective_from: '2024-01-15',
    plan_name: null,
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
    created_at: TS,
    updated_at: TS,
    deleted_at: null,
    ...overrides,
  };
}

export function makeCharge(overrides: Partial<ChargeRow> = {}): ChargeRow {
  return {
    id: nextId('chg'),
    subscription_id: 'sub-0001',
    version_id: null,
    charge_date: '2024-02-15',
    amount_minor: 2500,
    currency: 'CNY',
    fx_rate_to_base: '1',
    base_currency: 'CNY',
    base_amount_minor: 2500,
    source: 'auto',
    status: 'paid',
    created_at: TS,
    updated_at: TS,
    deleted_at: null,
    ...overrides,
  };
}

export function makeFxRate(overrides: Partial<FxRateRow> = {}): FxRateRow {
  return {
    date: '2024-03-01',
    base: 'USD',
    currency: 'CNY',
    rate: '7.1400',
    fetched_at: '2024-03-01T00:00:00.000Z',
    created_at: TS,
    updated_at: TS,
    deleted_at: null,
    ...overrides,
  };
}

export function makeChannel(
  overrides: Partial<NotificationChannelRow> = {},
): NotificationChannelRow {
  return {
    id: nextId('chan'),
    type: 'feishu',
    name: '飞书',
    config_json: '{}',
    secret_ref: 'FEISHU_MAIN',
    secrets_encrypted: null,
    created_at: TS,
    updated_at: TS,
    deleted_at: null,
    ...overrides,
  };
}

export function makeRule(overrides: Partial<ReminderRuleRow> = {}): ReminderRuleRow {
  return {
    id: nextId('rule'),
    subscription_id: null,
    rule_type: 'due',
    days_before: 1,
    at_time: '09:00',
    schedule_type: null,
    interval_days: null,
    weekdays: null,
    channel_id: null,
    enabled: 1,
    created_at: TS,
    updated_at: TS,
    deleted_at: null,
    ...overrides,
  };
}

/** 构造汇率快照：rates 是「1 USD 等于多少该币种」。 */
export function makeFxSnapshot(
  rates: Record<string, string>,
  asOf: string | null = '2024-03-01T00:00:00.000Z',
): FxSnapshot {
  return { base: 'USD', asOf, rates };
}

/**
 * 一组常用的测试汇率（语义：1 USD = ?）。
 *   CNY 7.1400 / JPY 157.20 / KWD 0.3065 / EUR 0.9200
 */
export const TEST_RATES: Record<string, string> = {
  CNY: '7.1400',
  JPY: '157.20',
  KWD: '0.3065',
  EUR: '0.9200',
  HKD: '7.8000',
};
