/**
 * 接口返回形状（与 apps/worker 的 DTO 一一对应）。
 *
 * 这些类型只描述「响应体长什么样」，不含任何业务计算：
 * 领域规则全部来自 @submgr/core（前端与 Worker 共用同一套口径）。
 */

import type {
  CategoryRow,
  ChargeRow,
  ChargeStatus,
  ChargeSource,
  CycleType,
  NotificationChannelType,
  ReminderRuleRow,
  RenewMode,
  SettingsRow,
  StatusReasonCode,
  SubscriptionStatus,
  SubscriptionVersionRow,
  SubType,
  SummaryResult,
  TrendResult,
} from '@submgr/core';

export type { ChargeRow, CategoryRow, SettingsRow, SubscriptionVersionRow };

/** GET /api/subscriptions 的条目（Worker 里的 toDto 输出）。 */
export interface SubscriptionDto {
  id: string;
  name: string;
  category_id: string | null;
  category_name: string | null;
  category_color: string | null;
  sub_type: SubType;
  sub_type_label: string;
  charge_channel: string;
  charge_channel_label: string;
  renew_mode: RenewMode;
  start_date: string;
  end_date: string | null;
  cancelled_at: string | null;
  note: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
  status: SubscriptionStatus;
  reason_code: StatusReasonCode;
  reason: string;
  next_due_date: string | null;
  current_version_id: string | null;
  current_version: SubscriptionVersionRow | null;
  monthly_amount_minor: number | null;
}

export interface StatusCounts {
  total: number;
  active: number;
  ended: number;
  anomaly: number;
}

export interface SubscriptionListResponse {
  items: SubscriptionDto[];
  counts: StatusCounts;
  today: string;
  base_currency: string;
}

export interface SubscriptionDetailResponse {
  item: SubscriptionDto;
  versions: SubscriptionVersionRow[];
  charges: ChargeDto[];
}

export interface ChargeDto extends ChargeRow {
  subscription_name?: string | null;
}

export interface ChargeListResponse {
  items: ChargeDto[];
  total: number;
  limit: number;
  offset: number;
}

export interface CategoryDto extends CategoryRow {
  subscription_count: number;
}

export interface SummaryDto extends SummaryResult {
  window_days: number;
  generated_at: string;
}

export interface TrendsResponse {
  item: TrendResult;
  today: string;
}

export interface SettingsDto extends SettingsRow {
  ics_path: string;
}

export interface ChannelDto {
  id: string;
  type: NotificationChannelType;
  name: string;
  config_json: string;
  config: unknown;
  secret_ref: string | null;
  has_secrets_encrypted: boolean;
  created_at: string;
  updated_at: string;
}

/** 提醒规则的对外形态：enabled 变布尔、weekdays 变数组，并附上渠道/订阅名。 */
export type ReminderRuleDto = Omit<ReminderRuleRow, 'enabled' | 'weekdays'> & {
  enabled: boolean;
  weekdays: number[] | null;
  channel_name: string | null;
  subscription_name: string | null;
};

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

/** 新建/编辑订阅时的版本输入（对应 Worker 的 VersionInput）。 */
export interface VersionInput {
  effective_from: string;
  plan_name: string | null;
  amount_minor: number;
  currency: string;
  cycle_type: CycleType;
  cycle_days: number | null;
  is_trial: boolean;
  trial_end_date: string | null;
  after_trial_amount_minor: number | null;
  after_trial_currency: string | null;
  after_trial_cycle_type: CycleType | null;
  after_trial_cycle_days: number | null;
}

export interface SubscriptionInput {
  name: string;
  category_id: string | null;
  sub_type: SubType;
  charge_channel: string;
  renew_mode: RenewMode;
  start_date: string;
  end_date: string | null;
  note: string | null;
}

export interface ChargeInput {
  subscription_id: string;
  charge_date: string;
  amount_minor: number;
  currency: string;
  status: ChargeStatus;
  version_id?: string | null;
}

export type { ChargeSource, ChargeStatus, CycleType, RenewMode, SubType };
