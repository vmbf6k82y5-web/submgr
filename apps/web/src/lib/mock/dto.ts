/**
 * 把示例数据装配成与 Worker 完全一致的响应形状。
 *
 * 关键点：这里调用的 summarize / monthlyTrend / getStatus / convert 都是
 * @submgr/core 的同一批函数（Worker 也是调它们），
 * 所以示例数据不是「另一套假逻辑」，只是换了个数据源。
 */

import {
  addMonthsToMonthKey,
  boolOf,
  chargeChannelLabel,
  convert,
  currentVersion,
  fxSnapshotFromRows,
  getStatus,
  monthKeyOf,
  monthlyTrend,
  subTypeLabel,
  summarize,
  toMonthlyAmount,
  todayInTimeZone,
  versionsForSubscription,
  type ChargeRow,
  type FxSnapshot,
  type SubscriptionRow,
  type SubscriptionVersionRow,
  type TrendDimension,
  type TrendResult,
} from '@submgr/core';
import type {
  ChannelDto,
  ChargeListResponse,
  ChargeDto,
  SettingsDto,
  SubscriptionDetailResponse,
  SubscriptionDto,
  SubscriptionListResponse,
  SummaryDto,
  TrendsResponse,
} from '../types';
import type { MockState } from './data';

export function mockToday(state: MockState): string {
  return todayInTimeZone(state.settings.timezone);
}

export function mockFx(state: MockState): FxSnapshot {
  return fxSnapshotFromRows(state.fxRows);
}

/** 与 apps/worker/src/routes/subscriptions.ts 的 toDto 口径一致。 */
export function subscriptionDto(
  state: MockState,
  sub: SubscriptionRow,
  today: string,
): SubscriptionDto {
  const versions = state.versions.filter((v) => v.subscription_id === sub.id && !v.deleted_at);
  const charges = state.charges.filter((c) => c.subscription_id === sub.id && !c.deleted_at);
  const status = getStatus(sub, versions, today, charges);
  const current = currentVersion(versionsForSubscription(versions, sub.id), today);
  const category = sub.category_id
    ? (state.categories.find((c) => c.id === sub.category_id) ?? null)
    : null;

  let monthly: number | null = null;
  if (current) {
    const inCurrency = toMonthlyAmount(current, state.settings, { useAfterTrial: true });
    monthly = convert(inCurrency, current.currency, state.settings.base_currency, mockFx(state));
  }

  return {
    id: sub.id,
    name: sub.name,
    category_id: sub.category_id,
    category_name: category?.name ?? null,
    category_color: category?.color ?? null,
    sub_type: sub.sub_type,
    sub_type_label: subTypeLabel(sub.sub_type),
    charge_channel: sub.charge_channel,
    charge_channel_label: chargeChannelLabel(sub.charge_channel),
    renew_mode: sub.renew_mode,
    start_date: sub.start_date,
    end_date: sub.end_date,
    cancelled_at: sub.cancelled_at,
    note: sub.note,
    icon: sub.icon,
    created_at: sub.created_at,
    updated_at: sub.updated_at,
    status: status.status,
    reason_code: status.reasonCode,
    reason: status.reason,
    next_due_date: status.nextDueDate,
    current_version_id: status.currentVersionId,
    current_version: current,
    monthly_amount_minor: monthly,
  };
}

export function chargeDto(state: MockState, charge: ChargeRow): ChargeDto {
  const sub = state.subscriptions.find((s) => s.id === charge.subscription_id);
  return { ...charge, subscription_name: sub?.name ?? null };
}

export function listResponse(
  state: MockState,
  filters: { status?: string; q?: string; categoryId?: string },
): SubscriptionListResponse {
  const today = mockToday(state);
  let items = state.subscriptions
    .filter((s) => !s.deleted_at)
    .map((s) => subscriptionDto(state, s, today));

  if (filters.status) items = items.filter((i) => i.status === filters.status);
  if (filters.q) {
    const needle = filters.q.trim().toLowerCase();
    if (needle) items = items.filter((i) => i.name.toLowerCase().includes(needle));
  }
  if (filters.categoryId) items = items.filter((i) => i.category_id === filters.categoryId);

  const counts = { total: 0, active: 0, ended: 0, anomaly: 0 };
  for (const item of items) {
    counts.total += 1;
    if (item.status === 'active') counts.active += 1;
    else if (item.status === 'ended') counts.ended += 1;
    else counts.anomaly += 1;
  }

  return { items, counts, today, base_currency: state.settings.base_currency };
}

export function detailResponse(state: MockState, id: string): SubscriptionDetailResponse {
  const sub = state.subscriptions.find((s) => s.id === id && !s.deleted_at);
  if (!sub) throw new Error(`订阅不存在或已删除：${id}`);
  const today = mockToday(state);
  const versions = state.versions
    .filter((v) => v.subscription_id === id && !v.deleted_at)
    .sort((a, b) => (a.effective_from < b.effective_from ? -1 : a.effective_from > b.effective_from ? 1 : 0));
  const charges = state.charges
    .filter((c) => c.subscription_id === id && !c.deleted_at)
    .sort((a, b) => (a.charge_date > b.charge_date ? -1 : a.charge_date < b.charge_date ? 1 : 0))
    .slice(0, 200)
    .map((c) => chargeDto(state, c));

  return { item: subscriptionDto(state, sub, today), versions, charges };
}

export function chargeListResponse(
  state: MockState,
  filters: { subscriptionId?: string; from?: string; to?: string; status?: string; limit: number; offset: number },
): ChargeListResponse {
  let rows = state.charges.filter((c) => !c.deleted_at);
  if (filters.subscriptionId) rows = rows.filter((c) => c.subscription_id === filters.subscriptionId);
  if (filters.from) rows = rows.filter((c) => c.charge_date >= filters.from!);
  if (filters.to) rows = rows.filter((c) => c.charge_date <= filters.to!);
  if (filters.status) rows = rows.filter((c) => c.status === filters.status);
  rows = rows.sort((a, b) => (a.charge_date > b.charge_date ? -1 : a.charge_date < b.charge_date ? 1 : 0));

  const total = rows.length;
  const page = rows.slice(filters.offset, filters.offset + filters.limit);
  return { items: page.map((c) => chargeDto(state, c)), total, limit: filters.limit, offset: filters.offset };
}

export function summaryResponse(state: MockState, windowDays: number): SummaryDto {
  const today = mockToday(state);
  const result = summarize(
    state.subscriptions.filter((s) => !s.deleted_at),
    state.versions,
    mockFx(state),
    state.settings,
    today,
    { charges: state.charges.filter((c) => !c.deleted_at), windowDays },
  );
  return { ...result, window_days: windowDays, generated_at: new Date().toISOString() };
}

export function trendsResponse(
  state: MockState,
  dimension: TrendDimension,
  from?: string,
  to?: string,
): TrendsResponse {
  const today = mockToday(state);
  const currentMonth = monthKeyOf(today);
  const rawTo = to && /^\d{4}-\d{2}$/.test(to) ? to : currentMonth;
  const rawFrom = from && /^\d{4}-\d{2}$/.test(from) ? from : addMonthsToMonthKey(rawTo, -11);

  const item: TrendResult = monthlyTrend(
    state.charges.filter((c) => !c.deleted_at),
    dimension,
    { from: rawFrom, to: rawTo },
    {
      baseCurrency: state.settings.base_currency,
      rates: mockFx(state),
      subscriptions: state.subscriptions.filter((s) => !s.deleted_at),
      versions: state.versions,
      categories: state.categories,
    },
  );

  return { item, today };
}

export function settingsDto(state: MockState): SettingsDto {
  return { ...state.settings, ics_path: `/ics/${state.settings.ics_token}.ics` };
}

export function channelDto(state: MockState, channelId: string): ChannelDto {
  const row = state.channels.find((c) => c.id === channelId && !c.deleted_at);
  if (!row) throw new Error(`提醒渠道不存在或已删除：${channelId}`);
  let config: unknown = {};
  try {
    config = JSON.parse(row.config_json);
  } catch {
    config = {};
  }
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    config_json: row.config_json,
    config,
    secret_ref: row.secret_ref,
    has_secrets_encrypted: row.secrets_encrypted !== null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function versionDto(version: SubscriptionVersionRow, today: string): SubscriptionVersionRow & {
  is_trial: boolean;
  frozen: boolean;
} {
  return {
    ...version,
    is_trial: boolOf(version.is_trial),
    frozen: version.effective_from <= today,
  };
}
