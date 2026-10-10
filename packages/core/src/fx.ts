/**
 * 订阅管家 —— 汇率快照的健康度（纯函数）
 *
 * 需求原文：
 *   * 汇率按天存快照。
 *   * 如果最新汇率超过 48 小时没更新，接口必须返回 stale = true。
 *   * 如果某个币种缺汇率，合计必须返回 null 和缺失的币种列表，
 *     绝不能跳过这个币种当作没有来算。
 */

import { FX_BASE, FX_STALE_HOURS, type FxRateRow, type FxSnapshot } from './types.js';
import { hasRate, normalizeCurrency } from './money.js';

/** 汇率快照距今多少小时；没有汇率或时间戳非法时返回 null。 */
export function rateAgeHours(asOf: string | null, now: Date = new Date()): number | null {
  if (!asOf) return null;
  const parsed = Date.parse(asOf);
  if (Number.isNaN(parsed)) return null;
  return (now.getTime() - parsed) / 3_600_000;
}

/**
 * 是否过期。
 *
 * 判定基于 fx_rates.fetched_at（真实抓取时刻），而不是 date 列——
 * date 只有天粒度，无法判断「超过 48 小时」。
 * 完全没有汇率（asOf = null）也算过期，因为此时任何外币都无法换算。
 */
export function isStale(
  asOf: string | null,
  now: Date = new Date(),
  staleHours: number = FX_STALE_HOURS,
): boolean {
  const age = rateAgeHours(asOf, now);
  if (age === null) return true;
  return age > staleHours;
}

/**
 * 从 fx_rates 行集里挑出「每个币种最新一天」的汇率，组成计算用快照。
 *
 * 规则：先比 date 取最新，date 相同再比 fetched_at。
 * asOf 取最终被选中的那些行的 fetched_at 最大值。
 */
export function fxSnapshotFromRows(rows: readonly FxRateRow[]): FxSnapshot {
  const bestByCurrency = new Map<string, FxRateRow>();

  for (const row of rows) {
    if (row.deleted_at) continue;
    let currency: string;
    try {
      currency = normalizeCurrency(row.currency);
    } catch {
      continue;
    }
    const current = bestByCurrency.get(currency);
    if (
      current === undefined ||
      row.date > current.date ||
      (row.date === current.date && row.fetched_at > current.fetched_at)
    ) {
      bestByCurrency.set(currency, row);
    }
  }

  const rates: Record<string, string> = {};
  let asOf: string | null = null;
  for (const [currency, row] of bestByCurrency) {
    rates[currency] = row.rate;
    if (asOf === null || row.fetched_at > asOf) asOf = row.fetched_at;
  }

  return { base: FX_BASE, asOf, rates };
}

/**
 * 从一组币种里找出「没有可用汇率」的那些（去重、按字母序、USD 除外）。
 *
 * 这个函数专门用来满足「缺汇率必须显式报错，而不是当 0 处理」。
 */
export function missingCurrencies(
  currencies: Iterable<string>,
  rates: Parameters<typeof hasRate>[1],
): string[] {
  const missing = new Set<string>();
  for (const raw of currencies) {
    let code: string;
    try {
      code = normalizeCurrency(raw);
    } catch {
      continue;
    }
    if (code === FX_BASE) continue; // 基准币种隐含汇率 1
    if (!hasRate(code, rates)) missing.add(code);
  }
  return [...missing].sort();
}

/** 空快照：没有汇率数据时使用。 */
export function emptyFxSnapshot(): FxSnapshot {
  return { base: FX_BASE, asOf: null, rates: {} };
}
