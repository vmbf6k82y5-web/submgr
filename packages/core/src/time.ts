/**
 * 订阅管家 —— 时间与日期工具（纯函数）
 *
 * 两套时间概念，绝不混用：
 *
 *   1) 「日期」date-only：'YYYY-MM-DD'。
 *      表示用户时区下的一个自然日（到期日、扣款日、生效日、试用结束日）。
 *      它本身不带时区，因此解析与格式化必须使用同一个时区，否则会整体偏移一天。
 *      本模块统一用「本地时区」解析（new Date(y, m-1, d)）并用「本地时区」格式化
 *      （date-fns 的 format）。这样在任何进程时区下结果都一致，
 *      而且 date-fns 的月份运算与进程时区无关（每个时区月份长度都一样）。
 *
 *   2) 「时间点」instant：UTC ISO-8601 字符串，形如 '2026-10-10T06:10:42.123Z'。
 *      表示绝对时刻（created_at、cancelled_at、sent_at、fetched_at）。
 *
 * 所有月份加减一律交给 date-fns（addMonths / startOfMonth / getDaysInMonth），
 * 绝不手写「月份 +1 后判断天数」这类逻辑。
 */

import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  format,
  getDaysInMonth,
  setDate,
  startOfMonth,
} from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/** 严格匹配 YYYY-MM-DD。 */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 严格匹配 HH:mm（24 小时制）。 */
const TIME_HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 宽松匹配 HH:mm，允许 00-29 的小时位，用于给「格式对不对」的报错提示。 */
const TIME_HHMM_LOOSE_RE = /^\d{2}:\d{2}$/;

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 是否是合法的 date-only。
 * 除了格式，还会检查「真实存在」：2025-02-30、2025-13-01 都要被判为非法。
 */
export function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_ONLY_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  // 用 Date 自己判断该月天数，避免手写闰年规则
  const probe = new Date(year, month - 1, 1);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1) return false;
  return day <= getDaysInMonth(probe);
}

/** 是否是合法的 HH:mm。 */
export function isValidTimeHHmm(value: unknown): value is string {
  return typeof value === 'string' && TIME_HHMM_RE.test(value);
}

/** 是否是合法的 IANA 时区名（交给 Intl 判断，不自己维护列表）。 */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
  try {
    // 无效时区会抛 RangeError
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// date-only 解析 / 格式化
// ---------------------------------------------------------------------------

/**
 * 'YYYY-MM-DD' -> 本地时区当天 00:00 的 Date。
 * 非法输入直接抛错，避免把脏数据静默算成别的一天。
 */
export function parseDateOnly(value: string): Date {
  const m = DATE_ONLY_RE.exec(value);
  if (!m || !isValidDateOnly(value)) {
    throw new RangeError(`parseDateOnly: 不是合法的 YYYY-MM-DD 日期：${JSON.stringify(value)}`);
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Date -> 'YYYY-MM-DD'（按本地时区读取，与 parseDateOnly 对称）。 */
export function formatDateOnly(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('formatDateOnly: 收到 Invalid Date');
  }
  return format(date, 'yyyy-MM-dd');
}

/** 当前时刻的 UTC ISO-8601 字符串（与数据库 created_at/updated_at 格式一致）。 */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

// ---------------------------------------------------------------------------
// 时区相关的「今天」
// ---------------------------------------------------------------------------

/**
 * 用户时区下的「今天」。
 *
 * 这是所有业务判断的入口：到期、试用、提醒都以此为准。
 * 例：Asia/Shanghai 在 UTC 前一天 16:00 就进入新的一天。
 */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): string {
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`todayInTimeZone: 不是合法的 IANA 时区：${JSON.stringify(timeZone)}`);
  }
  return formatInTimeZone(now, timeZone, 'yyyy-MM-dd');
}

/**
 * 把「用户时区的某天某时刻」转换成绝对时刻（UTC Date）。
 *
 * 例：atTimeInTimeZoneToUtc('2025-03-01', '00:00', 'Asia/Shanghai')
 *     => 2025-02-28T16:00:00.000Z
 * 提醒调度用它把 HH:mm 换算成可以比较的 UTC 时刻。
 */
export function atTimeInTimeZoneToUtc(
  dateOnly: string,
  hhmm: string,
  timeZone: string,
): Date {
  if (!isValidDateOnly(dateOnly)) {
    throw new RangeError(`atTimeInTimeZoneToUtc: 不是合法的日期：${JSON.stringify(dateOnly)}`);
  }
  if (!isValidTimeHHmm(hhmm)) {
    throw new RangeError(
      `atTimeInTimeZoneToUtc: 不是合法的 HH:mm（24 小时制）：${JSON.stringify(hhmm)}`,
    );
  }
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`atTimeInTimeZoneToUtc: 不是合法的 IANA 时区：${JSON.stringify(timeZone)}`);
  }
  const result = fromZonedTime(`${dateOnly}T${hhmm}:00`, timeZone);
  if (Number.isNaN(result.getTime())) {
    throw new RangeError(
      `atTimeInTimeZoneToUtc: 无法换算 ${dateOnly} ${hhmm} @ ${timeZone}`,
    );
  }
  return result;
}

/** 把绝对时刻按用户时区格式化成 HH:mm。 */
export function timeInTimeZoneToHHmm(instant: Date, timeZone: string): string {
  return formatInTimeZone(instant, timeZone, 'HH:mm');
}

// ---------------------------------------------------------------------------
// date-only 加减
// ---------------------------------------------------------------------------

/** date-only 加 n 天。 */
export function addDaysDateOnly(dateOnly: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new TypeError(`addDaysDateOnly: 天数必须是整数，收到 ${days}`);
  }
  return formatDateOnly(addDays(parseDateOnly(dateOnly), days));
}

/** date-only 差值：a - b，单位天。 */
export function diffDaysDateOnly(a: string, b: string): number {
  return differenceInCalendarDays(parseDateOnly(a), parseDateOnly(b));
}

/** 比较两个 date-only：a < b / a === b / a > b。 */
export function compareDateOnly(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 取两个 date-only 里较晚的一个。 */
export function maxDateOnly(a: string, b: string): string {
  return a >= b ? a : b;
}

/** 取两个 date-only 里较早的一个。 */
export function minDateOnly(a: string, b: string): string {
  return a <= b ? a : b;
}

/** 该日期所在月份的第一天。 */
export function startOfMonthDateOnly(dateOnly: string): string {
  return formatDateOnly(startOfMonth(parseDateOnly(dateOnly)));
}

/**
 * 从某月 1 号偏移 n 个月，并把「锚点日」按目标月份天数截断。
 *
 * 这是周期计算的唯一核心：1 月 31 日的月订阅，2 月落到 28/29，3 月回到 31。
 * 之所以先 startOfMonth 再 addMonths，是因为 date-fns 的 addMonths 本身会截断
 * （1/31 + 1 月 = 2/28），一旦截断就丢失了锚点日。从 1 号出发做月份加法永远不会
 * 被截断，最后再按 getDaysInMonth 放回锚点日即可。
 *
 * 注意：这里没有手写任何「月份加减」，月份运算是 date-fns 的 addMonths，
 * 天数上限是 date-fns 的 getDaysInMonth。
 */
export function addMonthsKeepingAnchorDay(
  dateOnly: string,
  monthsToAdd: number,
  anchorDay: number,
): string {
  if (!Number.isInteger(monthsToAdd)) {
    throw new TypeError(`addMonthsKeepingAnchorDay: 月数必须是整数，收到 ${monthsToAdd}`);
  }
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new RangeError(`addMonthsKeepingAnchorDay: 锚点日必须是 1..31，收到 ${anchorDay}`);
  }
  const monthStart = addMonths(startOfMonth(parseDateOnly(dateOnly)), monthsToAdd);
  const day = Math.min(anchorDay, getDaysInMonth(monthStart));
  return formatDateOnly(setDate(monthStart, day));
}

/** 取某日的「日」，作为周期锚点。 */
export function dayOfMonth(dateOnly: string): number {
  return parseDateOnly(dateOnly).getDate();
}
