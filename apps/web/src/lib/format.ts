/**
 * 展示层格式化（纯函数，可单测）。
 *
 * 金额永远从「整数最小单位 + 币种」出发（core 的铁律），
 * 这里只负责变成人能读的字符串，绝不在这里做任何业务计算。
 */

import {
  FX_STALE_HOURS,
  cycleTypeLabel,
  formatMinorAmount,
  fromMajorString,
  toMajorString,
  type ChargeSource,
  type ChargeStatus,
  type RenewMode,
  type SubscriptionStatus,
  type SummaryResult,
} from '@submgr/core';

const EMPTY = '—';

/** 整数最小单位 -> 「¥25.00」；null / 非法币种都退化成「—」，不抛异常。 */
export function formatMoney(amountMinor: number | null | undefined, currency: string): string {
  if (amountMinor === null || amountMinor === undefined || !Number.isFinite(amountMinor)) {
    return EMPTY;
  }
  try {
    return formatMinorAmount(amountMinor, currency);
  } catch {
    return `${toMajorString(amountMinor, currency)} ${currency}`;
  }
}

/** 输入框文本 -> 整数最小单位；失败时给出中文原因（不要在 UI 里静默丢钱）。 */
export function inputToMinor(
  text: string,
  currency: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: '金额不能为空' };
  try {
    return { ok: true, value: fromMajorString(trimmed, currency) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `金额格式不对：${message}` };
  }
}

/** 整数最小单位 -> 输入框里的文本。 */
export function minorToInput(amountMinor: number | null | undefined, currency: string): string {
  if (amountMinor === null || amountMinor === undefined) return '';
  try {
    return toMajorString(amountMinor, currency);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------

function parseDateOnly(dateOnly: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** '2026-03-04' -> '2026年3月4日'。 */
export function formatDate(dateOnly: string | null | undefined): string {
  if (!dateOnly) return EMPTY;
  const parts = parseDateOnly(dateOnly);
  if (!parts) return dateOnly;
  return `${parts.year}年${parts.month}月${parts.day}日`;
}

/** '2026-03-04' -> '3月4日'（同年省略年份，列表里更清爽）。 */
export function formatDateShort(dateOnly: string | null | undefined, today?: string): string {
  if (!dateOnly) return EMPTY;
  const parts = parseDateOnly(dateOnly);
  if (!parts) return dateOnly;
  const todayYear = today ? parseDateOnly(today)?.year : new Date().getFullYear();
  if (todayYear === parts.year) return `${parts.month}月${parts.day}日`;
  return `${parts.year}年${parts.month}月${parts.day}日`;
}

/** '2026-03' -> '2026年3月'。 */
export function formatMonth(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return monthKey;
  return `${Number(match[1])}年${Number(match[2])}月`;
}

/** 图表 X 轴用的短标签：同年用「3月」，跨年用「25年3月」。 */
export function formatMonthAxis(monthKey: string, currentYear: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return monthKey;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year === currentYear) return `${month}月`;
  return `${String(year).slice(2)}年${month}月`;
}

/** UTC 时间点 -> 本地「2026-10-10 14:05」。 */
export function formatInstant(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return EMPTY;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  if (timeZone) options.timeZone = timeZone;
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', options).formatToParts(date);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return date.toISOString();
  }
}

/** 距今天数 -> 「今天」「3 天后」「已过期 2 天」。 */
export function relativeDays(dateOnly: string | null | undefined, today: string): string {
  if (!dateOnly) return EMPTY;
  const a = parseDateOnly(dateOnly);
  const b = parseDateOnly(today);
  if (!a || !b) return dateOnly;
  const ms = Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
  const days = Math.round(ms / 86_400_000);
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  if (days === -1) return '昨天';
  if (days > 0) return `${days} 天后`;
  return `已过期 ${Math.abs(days)} 天`;
}

/** 小时数 -> 「3 小时前」「2 天前」。 */
export function formatHoursAgo(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '未知';
  if (hours < 1) return '刚刚';
  if (hours < 24) return `${Math.round(hours)} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

// ---------------------------------------------------------------------------
// 中文标签（枚举 -> 文案；标签表在 core 里，前端不再抄一份）
// ---------------------------------------------------------------------------

export const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: '正常',
  ended: '已结束',
  anomaly: '异常',
};

export function statusLabel(status: SubscriptionStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export type Tone = 'ok' | 'danger' | 'muted' | 'info' | 'warn';

export function statusTone(status: SubscriptionStatus): Tone {
  if (status === 'anomaly') return 'danger';
  if (status === 'ended') return 'muted';
  return 'ok';
}

export const CHARGE_STATUS_LABELS: Record<ChargeStatus, string> = {
  paid: '已支付',
  failed: '扣款失败',
  refunded: '已退款',
};

export function chargeStatusLabel(status: ChargeStatus): string {
  return CHARGE_STATUS_LABELS[status] ?? status;
}

export const CHARGE_SOURCE_LABELS: Record<ChargeSource, string> = {
  auto: '自动扣款',
  manual: '手动记账',
};

export function chargeSourceLabel(source: ChargeSource): string {
  return CHARGE_SOURCE_LABELS[source] ?? source;
}

export const RENEW_MODE_LABELS: Record<RenewMode, string> = {
  auto: '自动续费',
  manual: '手动续费',
};

export function renewModeLabel(mode: RenewMode): string {
  return RENEW_MODE_LABELS[mode] ?? mode;
}

export { cycleTypeLabel };

// ---------------------------------------------------------------------------
// 汇率健康度提示（需求点名：stale / missingCurrencies 必须给明确提示）
// ---------------------------------------------------------------------------

export interface FxNotice {
  level: 'warn' | 'danger';
  title: string;
  detail: string;
}

export type FxHealth = Pick<
  SummaryResult,
  'stale' | 'fxAsOf' | 'fxAgeHours' | 'missingCurrencies' | 'baseCurrency'
>;

/**
 * 把 /api/summary 的汇率健康度翻译成可直接渲染的提示。
 *
 * 两条独立提示（可能同时出现）：
 *   1) 缺币种汇率 → 合计是 null（界面上显示「—」），必须说清「不是 0」；
 *   2) 汇率过期 → 金额可能不准，超过 48 小时就提醒。
 */
export function fxNotices(health: FxHealth): FxNotice[] {
  const notices: FxNotice[] = [];
  const missing = health.missingCurrencies ?? [];

  if (missing.length > 0) {
    notices.push({
      level: 'danger',
      title: `缺少 ${missing.join('、')} 的汇率，合计无法计算`,
      detail: `月均、年均、未来 30 天三个数字都显示为「—」，而不是少算这几个币种。补齐汇率快照（Cron 每天会自动拉一次）后即可恢复。`,
    });
  }

  if (health.stale) {
    const age = health.fxAgeHours === null || health.fxAgeHours === undefined
      ? '从未更新过'
      : `最近一次更新在 ${formatHoursAgo(health.fxAgeHours)}`;
    notices.push({
      level: health.fxAsOf === null ? 'danger' : 'warn',
      title: `汇率数据已过期（${age}，超过 ${FX_STALE_HOURS} 小时）`,
      detail:
        health.fxAsOf === null
          ? '还没有任何汇率快照：非基准币种的金额都算不出来，只会显示「—」。'
          : '外币订阅的月均/年均按最新快照折算，可能已经偏离真实汇率；Cron 正常情况下每天 00:20 会自动刷新。',
    });
  }

  return notices;
}
