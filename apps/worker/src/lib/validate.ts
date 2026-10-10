/**
 * 请求体 / 查询参数的取值与校验。
 *
 * 设计原则：
 *   - 校验失败一律抛 ApiError(400)，错误信息用中文、带上字段名；
 *   - 「可选字段」与「显式置 null」必须能区分（PATCH 语义），
 *     所以统一用 `hasOwnProperty` 判断字段有没有出现；
 *   - 不在这一层猜业务：枚举值全部来自 @submgr/core 的常量表，
 *     保证接口层接受的值就是数据库 CHECK 接受的值。
 */

import {
  CHARGE_CHANNELS,
  CHARGE_STATUSES,
  CYCLE_TYPES,
  NOTIFICATION_CHANNEL_TYPES,
  REMINDER_RULE_TYPES,
  RENEW_MODES,
  SCHEDULE_TYPES,
  SUB_TYPES,
  isValidDateOnly,
  isValidTimeHHmm,
  isValidTimeZone,
  normalizeCurrency,
  type ChargeChannel,
  type ChargeStatus,
  type CycleType,
  type NotificationChannelType,
  type ReminderRuleType,
  type RenewMode,
  type ScheduleType,
  type SubType,
} from '@submgr/core';
import { invalid } from './errors.js';

export type JsonObject = Record<string, unknown>;

/** UTC ISO-8601 时间点（与 migration 的 GLOB 校验同一口径）。 */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** 解析 JSON 请求体；空 body / 非法 JSON 都算 400。 */
export async function readJson(request: Request): Promise<JsonObject> {
  const text = await request.text();
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('请求体不是合法的 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('请求体必须是一个 JSON 对象');
  }
  return parsed as JsonObject;
}

/** 字段是否显式出现（用于区分「没传」和「传了 null」）。 */
export function has(body: JsonObject, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

// ---------------------------------------------------------------------------
// 标量
// ---------------------------------------------------------------------------

export function requiredString(
  body: JsonObject,
  field: string,
  opts: { max?: number; trim?: boolean } = {},
): string {
  const raw = body[field];
  if (typeof raw !== 'string') throw invalid(`字段 ${field} 必须是字符串`);
  const value = opts.trim === false ? raw : raw.trim();
  if (value === '') throw invalid(`字段 ${field} 不能为空`);
  if (opts.max !== undefined && value.length > opts.max) {
    throw invalid(`字段 ${field} 长度不能超过 ${opts.max}`);
  }
  return value;
}

/** 可选字符串：没传返回 undefined；传 null 返回 null；传空串按「置空」处理。 */
export function optionalString(
  body: JsonObject,
  field: string,
  opts: { max?: number; emptyAsNull?: boolean } = {},
): string | null | undefined {
  if (!has(body, field)) return undefined;
  const raw = body[field];
  if (raw === null) return null;
  if (typeof raw !== 'string') throw invalid(`字段 ${field} 必须是字符串或 null`);
  const value = raw.trim();
  if (value === '') return opts.emptyAsNull === false ? '' : null;
  if (opts.max !== undefined && value.length > opts.max) {
    throw invalid(`字段 ${field} 长度不能超过 ${opts.max}`);
  }
  return value;
}

export function requiredEnum<T extends string>(
  body: JsonObject,
  field: string,
  allowed: readonly T[],
): T {
  const raw = body[field];
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw invalid(`字段 ${field} 必须是以下之一：${allowed.join(' / ')}`, { received: raw });
  }
  return raw as T;
}

export function optionalEnum<T extends string>(
  body: JsonObject,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (!has(body, field)) return undefined;
  return requiredEnum(body, field, allowed);
}

export function requiredInt(
  body: JsonObject,
  field: string,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = body[field];
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw invalid(`字段 ${field} 必须是整数`, { received: raw });
  }
  if (opts.min !== undefined && raw < opts.min) {
    throw invalid(`字段 ${field} 不能小于 ${opts.min}`);
  }
  if (opts.max !== undefined && raw > opts.max) {
    throw invalid(`字段 ${field} 不能大于 ${opts.max}`);
  }
  return raw;
}

export function optionalInt(
  body: JsonObject,
  field: string,
  opts: { min?: number; max?: number } = {},
): number | null | undefined {
  if (!has(body, field)) return undefined;
  if (body[field] === null) return null;
  return requiredInt(body, field, opts);
}

/** 日期：'YYYY-MM-DD'，且必须是真实存在的日期。 */
export function requiredDateOnly(body: JsonObject, field: string): string {
  const raw = body[field];
  if (typeof raw !== 'string' || !isValidDateOnly(raw)) {
    throw invalid(`字段 ${field} 必须是合法的 YYYY-MM-DD 日期`, { received: raw });
  }
  return raw;
}

export function optionalDateOnly(body: JsonObject, field: string): string | null | undefined {
  if (!has(body, field)) return undefined;
  if (body[field] === null) return null;
  return requiredDateOnly(body, field);
}

/** 时间点：UTC ISO-8601，必须以 Z 结尾（数据库 CHECK 同口径）。 */
export function optionalInstant(body: JsonObject, field: string): string | null | undefined {
  if (!has(body, field)) return undefined;
  const raw = body[field];
  if (raw === null) return null;
  if (typeof raw !== 'string' || !INSTANT_RE.test(raw)) {
    throw invalid(`字段 ${field} 必须是 UTC ISO-8601 时间点（以 Z 结尾）`, { received: raw });
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw invalid(`字段 ${field} 不是合法时间`);
  return raw;
}

/** HH:mm。 */
export function optionalTime(body: JsonObject, field: string): string | null | undefined {
  if (!has(body, field)) return undefined;
  const raw = body[field];
  if (raw === null) return null;
  if (typeof raw !== 'string' || !isValidTimeHHmm(raw)) {
    throw invalid(`字段 ${field} 必须是 HH:mm（24 小时制）`, { received: raw });
  }
  return raw;
}

export function optionalTimezone(body: JsonObject, field: string): string | undefined {
  const value = optionalString(body, field, { max: 100 });
  if (value === undefined) return undefined;
  if (value === null || !isValidTimeZone(value)) {
    throw invalid(`字段 ${field} 必须是合法的 IANA 时区名`);
  }
  return value;
}

/** ISO 4217 风格币种代码（3 位大写字母）。 */
export function requiredCurrency(body: JsonObject, field: string): string {
  const raw = body[field];
  if (typeof raw !== 'string') throw invalid(`字段 ${field} 必须是币种代码字符串`);
  try {
    return normalizeCurrency(raw);
  } catch {
    throw invalid(`字段 ${field} 必须是 3 位字母的 ISO 4217 币种代码`, { received: raw });
  }
}

export function optionalCurrency(body: JsonObject, field: string): string | undefined {
  if (!has(body, field)) return undefined;
  return requiredCurrency(body, field);
}

/** 0/1 布尔（对外统一用 JSON true/false，也接受 0/1）。 */
export function optionalBool(body: JsonObject, field: string): boolean | undefined {
  if (!has(body, field)) return undefined;
  const raw = body[field];
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;
  throw invalid(`字段 ${field} 必须是 true / false`);
}

export function requiredBool(body: JsonObject, field: string): boolean {
  const value = optionalBool(body, field);
  if (value === undefined) throw invalid(`字段 ${field} 是必填的`);
  return value;
}

export { CHARGE_CHANNELS, CHARGE_STATUSES, CYCLE_TYPES, NOTIFICATION_CHANNEL_TYPES, REMINDER_RULE_TYPES, RENEW_MODES, SCHEDULE_TYPES, SUB_TYPES };
export type { ChargeChannel, ChargeStatus, CycleType, NotificationChannelType, ReminderRuleType, RenewMode, ScheduleType, SubType };

// ---------------------------------------------------------------------------
// 查询参数
// ---------------------------------------------------------------------------

export function queryString(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function queryDateOnly(url: URL, name: string): string | null {
  const value = queryString(url, name);
  if (value === null) return null;
  if (!isValidDateOnly(value)) throw invalid(`查询参数 ${name} 必须是合法的 YYYY-MM-DD 日期`);
  return value;
}

export function queryInt(
  url: URL,
  name: string,
  opts: { min?: number; max?: number; fallback: number },
): number {
  const value = queryString(url, name);
  if (value === null) return opts.fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw invalid(`查询参数 ${name} 必须是整数`);
  if (opts.min !== undefined && parsed < opts.min) {
    throw invalid(`查询参数 ${name} 不能小于 ${opts.min}`);
  }
  if (opts.max !== undefined && parsed > opts.max) {
    throw invalid(`查询参数 ${name} 不能大于 ${opts.max}`);
  }
  return parsed;
}
