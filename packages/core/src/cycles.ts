/**
 * 订阅管家 —— 周期与到期日计算（纯函数）
 *
 * 关键规则（需求原文）：
 *   * 按月 / 季度 / 半年的订阅要保持「锚点日」。
 *     1 月 31 日开始的月订阅：2 月到期日是当月最后一天，3 月到期日回到 31 日。
 *   * 按年的订阅如果从 2 月 29 日开始，平年到期日是 2 月 28 日。
 *   * 固定天数的订阅就是纯粹加天数。
 *   * 终身订阅返回 null（只有一次扣款，没有「下一次到期」）。
 *
 * 实现上，所有月份运算都走 time.ts 的 addMonthsKeepingAnchorDay（内部是 date-fns），
 * 不在任何地方手写「月份 +1 / 判断闰年」的逻辑。
 */

import { differenceInCalendarMonths } from 'date-fns';
import {
  addDaysDateOnly,
  addMonthsKeepingAnchorDay,
  compareDateOnly,
  dayOfMonth,
  diffDaysDateOnly,
  isValidDateOnly,
  parseDateOnly,
} from './time.js';
import type { CycleSpec, CycleType } from './types.js';

/** 每种周期的月数；days / lifetime 没有固定月数，返回 null。 */
export function cycleMonths(cycleType: CycleType): number | null {
  switch (cycleType) {
    case 'month':
      return 1;
    case 'quarter':
      return 3;
    case 'half_year':
      return 6;
    case 'year':
      return 12;
    case 'days':
    case 'lifetime':
      return null;
    default: {
      // 枚举收窄：新增周期类型时这里会编译报错
      const never: never = cycleType;
      throw new RangeError(`cycleMonths: 未知周期类型 ${String(never)}`);
    }
  }
}

/** 取 cycle_days，非法时抛错（而不是悄悄当成 0 或 30）。 */
export function requireCycleDays(spec: CycleSpec): number {
  const days = spec.cycle_days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) {
    throw new RangeError(
      `requireCycleDays: cycle_type = 'days' 时必须提供正整数 cycle_days，收到 ${JSON.stringify(days)}`,
    );
  }
  return days;
}

function assertDateOnly(value: string, label: string): void {
  if (!isValidDateOnly(value)) {
    throw new RangeError(`${label}: 不是合法的 YYYY-MM-DD 日期：${JSON.stringify(value)}`);
  }
}

/**
 * 第 index 期（从 0 开始）的到期日。
 *   index = 0 就是 startDate 本身。
 *   lifetime 恒为 null。
 */
export function nthDueDate(
  spec: CycleSpec,
  startDate: string,
  index: number,
): string | null {
  assertDateOnly(startDate, 'nthDueDate(startDate)');
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`nthDueDate: index 必须是非负整数，收到 ${index}`);
  }

  if (spec.cycle_type === 'lifetime') return null;

  if (spec.cycle_type === 'days') {
    const days = requireCycleDays(spec);
    return addDaysDateOnly(startDate, index * days);
  }

  const months = cycleMonths(spec.cycle_type);
  if (months === null) return null;

  const anchorDay = dayOfMonth(startDate);
  return addMonthsKeepingAnchorDay(startDate, index * months, anchorDay);
}

/**
 * 找到「第一个到期日 >= date」的期数下标。
 * 先用 date-fns 的 differenceInCalendarMonths 估算，再线性收敛，最多几步。
 */
export function dueIndexOnOrAfter(spec: CycleSpec, startDate: string, date: string): number {
  assertDateOnly(startDate, 'dueIndexOnOrAfter(startDate)');
  assertDateOnly(date, 'dueIndexOnOrAfter(date)');

  if (compareDateOnly(date, startDate) <= 0) return 0;
  if (spec.cycle_type === 'lifetime') return 0;

  let index: number;
  if (spec.cycle_type === 'days') {
    const days = requireCycleDays(spec);
    index = Math.max(0, Math.ceil(diffDaysDateOnly(date, startDate) / days));
  } else {
    const months = cycleMonths(spec.cycle_type) ?? 1;
    const elapsed = differenceInCalendarMonths(parseDateOnly(date), parseDateOnly(startDate));
    index = Math.max(0, Math.floor(elapsed / months));
  }

  // 收敛：向下最多退几步、向上最多进几步。正常的估算误差不超过 1。
  let guard = 0;
  while (guard++ < 64) {
    const due = nthDueDate(spec, startDate, index);
    if (due === null) break;
    if (due >= date) break;
    index += 1;
  }
  guard = 0;
  while (guard++ < 64 && index > 0) {
    const prev = nthDueDate(spec, startDate, index - 1);
    if (prev === null || prev < date) break;
    index -= 1;
  }
  return index;
}

export interface DueOptions {
  /** 订阅结束日；晚于它的到期日不存在。 */
  endDate?: string | null;
  /** 取消时间（UTC ISO 字符串）；一旦取消就没有下一次到期。 */
  cancelledAt?: string | null;
}

/**
 * 下一次到期日（>= today 的最早一次到期）。
 *
 * 语义选择：到期日「当天」返回当天，而不是跳到下一期。
 * 理由：Cron 就是在到期日当天生成扣款记录的，那天问「下次什么时候扣」
 * 的正确答案就是今天。
 *
 * @returns YYYY-MM-DD；终身订阅、已取消、已超过 end_date 都返回 null。
 */
export function nextDueDate(
  spec: CycleSpec,
  startDate: string,
  today: string,
  opts: DueOptions = {},
): string | null {
  assertDateOnly(today, 'nextDueDate(today)');
  if (opts.cancelledAt) return null;
  if (spec.cycle_type === 'lifetime') return null;

  const endDate = opts.endDate ?? null;
  if (endDate) {
    assertDateOnly(endDate, 'nextDueDate(endDate)');
    if (compareDateOnly(today, endDate) > 0) return null;
  }

  const index = dueIndexOnOrAfter(spec, startDate, today);
  const due = nthDueDate(spec, startDate, index);
  if (due === null) return null;
  if (endDate && compareDateOnly(due, endDate) > 0) return null;
  return due;
}

/**
 * 上一次到期日（<= today 的最晚一次到期）。
 *
 * 手动续费的订阅靠它判断「是不是已经过了到期日还没续费」。
 */
export function previousDueDate(
  spec: CycleSpec,
  startDate: string,
  today: string,
  opts: DueOptions = {},
): string | null {
  assertDateOnly(today, 'previousDueDate(today)');
  if (opts.cancelledAt) return null;
  if (spec.cycle_type === 'lifetime') return null;

  const index = dueIndexOnOrAfter(spec, startDate, today);
  const atIndex = nthDueDate(spec, startDate, index);
  // atIndex 一定 >= today；只有恰好等于 today 时才把它算作「上一次」
  const target = atIndex !== null && compareDateOnly(atIndex, today) <= 0 ? index : index - 1;
  if (target < 0) return null;

  const due = nthDueDate(spec, startDate, target);
  if (due === null) return null;

  const endDate = opts.endDate ?? null;
  if (endDate && compareDateOnly(due, endDate) > 0) return null;
  return due;
}

/**
 * 区间 (from, to] 内的所有到期日。
 *
 * 用于「未来 30 天将扣多少钱」：from = 今天，to = 今天 + 30 天。
 * 左开右闭，避免把今天已经算过的到期日重复计入。
 */
export function dueDatesBetween(
  spec: CycleSpec,
  startDate: string,
  from: string,
  to: string,
  opts: DueOptions = {},
): string[] {
  assertDateOnly(from, 'dueDatesBetween(from)');
  assertDateOnly(to, 'dueDatesBetween(to)');
  if (spec.cycle_type === 'lifetime') return [];
  if (compareDateOnly(to, from) < 0) return [];
  if (opts.cancelledAt) return [];

  const endDate = opts.endDate ?? null;
  const firstQualifying = addDaysDateOnly(from, 1);
  const startIndex = dueIndexOnOrAfter(spec, startDate, firstQualifying);

  const out: string[] = [];
  // 上限只是防御性保护：正常情况下窗口内的期数远小于它。
  for (let i = 0; i < 1000; i += 1) {
    const due = nthDueDate(spec, startDate, startIndex + i);
    if (due === null) break;
    if (compareDateOnly(due, to) > 0) break;
    if (endDate && compareDateOnly(due, endDate) > 0) break;
    out.push(due);
  }
  return out;
}

/** 周期对应的「一年有多少期」，用于把金额折算到年。 */
export function cyclesPerYear(spec: CycleSpec): number | null {
  switch (spec.cycle_type) {
    case 'month':
      return 12;
    case 'quarter':
      return 4;
    case 'half_year':
      return 2;
    case 'year':
      return 1;
    case 'days':
      return 365 / requireCycleDays(spec);
    case 'lifetime':
      return null;
    default:
      return null;
  }
}
