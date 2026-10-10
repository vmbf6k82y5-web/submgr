/**
 * 订阅管家 —— 领域类型定义
 *
 * 这里的 Row 类型与 D1 里的列一一对应（snake_case），
 * 因此 Worker 可以直接把 D1 查询结果当作这些类型使用，前端也能复用。
 *
 * 三条全局铁律（贯穿整个 core）：
 *   1) 金额一律是 INTEGER，单位是币种最小单位（ISO 4217 exponent）。
 *      人民币 25.00 元 => 2500；日元 1200 円 => 1200；科威特第纳尔 1.234 => 1234。
 *      绝不使用浮点数存储。
 *   2) 所有「时间点」是 UTC ISO-8601 字符串（...Z）。
 *      所有「日期」是 YYYY-MM-DD，表示用户时区下的自然日，本身不带时区。
 *   3) 主键均为 TEXT UUID；软删除靠 deleted_at IS NULL 判断。
 */

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

export const SUB_TYPES = ['software', 'media', 'cloud', 'membership', 'telecom', 'other'] as const;
export type SubType = (typeof SUB_TYPES)[number];

export const CHARGE_CHANNELS = [
  'apple',
  'alipay',
  'wechat',
  'google',
  'card',
  'paypal',
  'telecom',
  'in_app',
  'other',
] as const;
export type ChargeChannel = (typeof CHARGE_CHANNELS)[number];

export const RENEW_MODES = ['auto', 'manual'] as const;
export type RenewMode = (typeof RENEW_MODES)[number];

export const CYCLE_TYPES = ['month', 'quarter', 'half_year', 'year', 'days', 'lifetime'] as const;
export type CycleType = (typeof CYCLE_TYPES)[number];

export const CHARGE_SOURCES = ['auto', 'manual'] as const;
export type ChargeSource = (typeof CHARGE_SOURCES)[number];

export const CHARGE_STATUSES = ['paid', 'failed', 'refunded'] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ['active', 'ended', 'anomaly'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const NOTIFICATION_CHANNEL_TYPES = ['feishu', 'telegram'] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];

export const REMINDER_RULE_TYPES = ['due', 'schedule'] as const;
export type ReminderRuleType = (typeof REMINDER_RULE_TYPES)[number];

export const SCHEDULE_TYPES = ['every_n_days', 'weekly'] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];

export const REMINDER_RESULTS = ['sent', 'failed', 'skipped'] as const;
export type ReminderResult = (typeof REMINDER_RESULTS)[number];

/**
 * SQLite 没有布尔类型，D1 返回 0/1。
 * 为了在「读取 D1 结果」和「构造内存对象」两种场景下都好用，这里放宽为联合类型，
 * 统一用 boolOf() 归一化。
 */
export type SqlBool = 0 | 1 | boolean;

/** 把 SQLite 的 0/1 / null / undefined 归一化成 boolean。 */
export function boolOf(value: SqlBool | null | undefined): boolean {
  return value === 1 || value === true;
}

// ---------------------------------------------------------------------------
// 通用列
// ---------------------------------------------------------------------------

/** 每张表都有的审计列（为将来的离线同步预留软删除墓碑）。 */
export interface AuditColumns {
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export interface SettingsRow extends AuditColumns {
  id: string;
  base_currency: string;
  timezone: string;
  ics_token: string;
  /** 终身订阅按多少个月摊销；0 表示不摊销。 */
  amortize_lifetime_months: number;
}

/** summarize / 金额摊销只需要这三个字段。 */
export type SummarizeSettings = Pick<
  SettingsRow,
  'base_currency' | 'timezone' | 'amortize_lifetime_months'
>;

export const DEFAULT_BASE_CURRENCY = 'CNY';
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
export const DEFAULT_AMORTIZE_LIFETIME_MONTHS = 36;

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

export interface CategoryRow extends AuditColumns {
  id: string;
  name: string;
  color: string;
  sort: number;
}

// ---------------------------------------------------------------------------
// subscriptions
// ---------------------------------------------------------------------------

export interface SubscriptionRow extends AuditColumns {
  id: string;
  name: string;
  category_id: string | null;
  sub_type: SubType;
  /** 纯文字字段，只用于展示，绝不做任何「跳转续费/取消」的行为。 */
  charge_channel: ChargeChannel;
  renew_mode: RenewMode;
  /** 首次订阅日，周期计算的锚点。YYYY-MM-DD */
  start_date: string;
  /** 订阅结束日，可为空。YYYY-MM-DD */
  end_date: string | null;
  /** 取消时间，UTC ISO-8601，可为空。 */
  cancelled_at: string | null;
  note: string | null;
  icon: string | null;
}

// ---------------------------------------------------------------------------
// subscription_versions
// ---------------------------------------------------------------------------

export interface SubscriptionVersionRow extends AuditColumns {
  id: string;
  subscription_id: string;
  /** 生效日 YYYY-MM-DD */
  effective_from: string;
  plan_name: string | null;
  /** 整数最小单位 */
  amount_minor: number;
  currency: string;
  cycle_type: CycleType;
  /** 只有 cycle_type === 'days' 时才非空 */
  cycle_days: number | null;
  is_trial: SqlBool;
  trial_end_date: string | null;
  after_trial_amount_minor: number | null;
  after_trial_currency: string | null;
  after_trial_cycle_type: CycleType | null;
  after_trial_cycle_days: number | null;
}

/** 只描述「周期形状」的最小结构，周期计算只需要这些字段。 */
export interface CycleSpec {
  cycle_type: CycleType;
  cycle_days?: number | null;
}

// ---------------------------------------------------------------------------
// charges
// ---------------------------------------------------------------------------

export interface ChargeRow extends AuditColumns {
  id: string;
  subscription_id: string;
  version_id: string | null;
  /** 扣款日 YYYY-MM-DD */
  charge_date: string;
  /** 原币金额，整数最小单位 */
  amount_minor: number;
  currency: string;
  /**
   * 冻结的汇率：1 单位 currency 等于多少单位 base_currency。
   * 用字符串存，避免浮点误差；未换算时为 null。
   */
  fx_rate_to_base: string | null;
  /** 冻结时的基准币种（settings.base_currency 之后可能被改，必须记下来）。 */
  base_currency: string | null;
  /** 冻结的基准币种金额，整数最小单位。 */
  base_amount_minor: number | null;
  source: ChargeSource;
  status: ChargeStatus;
}

// ---------------------------------------------------------------------------
// fx_rates
// ---------------------------------------------------------------------------

export interface FxRateRow extends AuditColumns {
  /** YYYY-MM-DD */
  date: string;
  /** 固定为 'USD' */
  base: string;
  currency: string;
  /** 1 USD 等于多少 currency，字符串存。 */
  rate: string;
  /** 实际抓取时刻 UTC ISO-8601。stale 判定基于它。 */
  fetched_at: string;
}

/**
 * 参与计算的汇率快照。
 * rates 的语义与 fx_rates 表一致：base 固定 USD，rate = 1 USD 等于多少目标币种。
 * 注意：USD 自己可能不在 rates 里，此时按 1 处理（见 FX_BASE）。
 */
export interface FxSnapshot {
  base: string;
  /** 最新一次抓取的时刻（UTC ISO-8601）；没有汇率时为 null。 */
  asOf: string | null;
  /** currency -> 1 USD 等于多少该币种 */
  rates: Readonly<Record<string, string>>;
}

export const FX_BASE = 'USD';

/** 超过这个小时数没有更新汇率，就认为数据过期。 */
export const FX_STALE_HOURS = 48;

// ---------------------------------------------------------------------------
// notification_channels
// ---------------------------------------------------------------------------

export interface NotificationChannelRow extends AuditColumns {
  id: string;
  type: NotificationChannelType;
  name: string;
  /** 只放非敏感配置（例如 telegram 的 chat_id）。绝不存密钥。 */
  config_json: string;
  /** 密钥所在的 Worker secret / 环境绑定名。 */
  secret_ref: string | null;
  /** AES-256-GCM 加密后的密钥密文（base64）。 */
  secrets_encrypted: string | null;
}

// ---------------------------------------------------------------------------
// reminder_rules
// ---------------------------------------------------------------------------

export interface ReminderRuleRow extends AuditColumns {
  id: string;
  /** null 表示全局规则（适用于所有订阅）。 */
  subscription_id: string | null;
  rule_type: ReminderRuleType;
  /** rule_type = 'due' 时：到期日前几天提醒。0 表示当天。 */
  days_before: number | null;
  /** HH:mm，按 settings.timezone 解释。 */
  at_time: string | null;
  schedule_type: ScheduleType | null;
  interval_days: number | null;
  /** JSON 数组字符串，1=周一 … 7=周日（ISO-8601）。 */
  weekdays: string | null;
  channel_id: string | null;
  enabled: SqlBool;
}

// ---------------------------------------------------------------------------
// reminder_log
// ---------------------------------------------------------------------------

export interface ReminderLogRow extends AuditColumns {
  id: string;
  rule_id: string;
  subscription_id: string | null;
  /** 该次提醒对应的到期日 / 本次汇总日期。YYYY-MM-DD，去重键。 */
  due_date: string;
  /** UTC ISO-8601；result = 'sent' 时必填。 */
  sent_at: string | null;
  result: ReminderResult;
}

// ---------------------------------------------------------------------------
// 只读取 id 的最小形态
// ---------------------------------------------------------------------------

export interface HasId {
  id: string;
}

/** D1 的软删除过滤：只保留 deleted_at 为空的行。 */
export function alive<T extends { deleted_at?: string | null }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.deleted_at === null || r.deleted_at === undefined);
}
