/**
 * 汇率读取与「冻结汇率」。
 *
 * 口径（需求原文 + 阶段一定稿）：
 *   * 已经发生的扣款：用**扣款当天**的汇率换算，并把 rate / base_currency /
 *     base_amount_minor 三个字段一起写进 charges 冻结下来；
 *   * 未来预估：用最新汇率（fxSnapshotFromRows 选出的每币种最新一天）。
 *   * 缺汇率时返回 null，绝不静默按 1:1 或 0 处理。
 */

import {
  FX_BASE,
  convertWithFrozenRate,
  frozenRateBetween,
  fxSnapshotFromRows,
  type FxRateRow,
  type FxSnapshot,
} from '@submgr/core';
import { allRows } from './db.js';

/**
 * 取「每个币种最新一天」的汇率快照。
 *
 * 用 GROUP BY 而不是把整张表拉回来：fx_rates 每天写入约 160 行，
 * 一年后全表 5 万行以上，全量下载会拖慢每个接口。
 */
export async function loadFxSnapshot(db: D1Database): Promise<FxSnapshot> {
  const rows = await allRows<FxRateRow>(
    db,
    `SELECT f.* FROM fx_rates f
       JOIN (SELECT currency, MAX(date) AS max_date FROM fx_rates
              WHERE deleted_at IS NULL GROUP BY currency) m
         ON f.currency = m.currency AND f.date = m.max_date
      WHERE f.deleted_at IS NULL`,
  );
  return fxSnapshotFromRows(rows);
}

/**
 * 取「截止 date（含）每个币种最新一天」的汇率快照。
 *
 * 用于冻结扣款汇率：优先扣款当天；当天没有快照时退到之前最近的一天
 * （例如手动补录一笔历史扣款，而那天恰好漏抓了汇率）。
 * 绝不用未来的汇率去换算过去发生的钱。
 */
export async function loadFxSnapshotAsOf(db: D1Database, date: string): Promise<FxSnapshot> {
  const rows = await allRows<FxRateRow>(
    db,
    `SELECT f.* FROM fx_rates f
       JOIN (SELECT currency, MAX(date) AS max_date FROM fx_rates
              WHERE deleted_at IS NULL AND date <= ? GROUP BY currency) m
         ON f.currency = m.currency AND f.date = m.max_date
      WHERE f.deleted_at IS NULL`,
    [date],
  );
  return fxSnapshotFromRows(rows);
}

/** 冻结汇率的结果。缺汇率时三个字段都是 null，并给出 missing 说明。 */
export interface FrozenAmount {
  fx_rate_to_base: string | null;
  base_currency: string | null;
  base_amount_minor: number | null;
  /** 缺汇率的币种；不缺时为 null。 */
  missing: string | null;
  /** 实际使用的汇率日期快照（用于响应里告知调用方）。 */
  asOfDate: string | null;
}

/**
 * 把一笔金额按 date 当天的汇率冻结成基准币种。
 *
 * @param date 扣款日 YYYY-MM-DD
 */
export async function freezeAmount(
  db: D1Database,
  amountMinor: number,
  currency: string,
  baseCurrency: string,
  date: string,
): Promise<FrozenAmount> {
  if (currency === baseCurrency) {
    return {
      fx_rate_to_base: '1',
      base_currency: baseCurrency,
      base_amount_minor: amountMinor,
      missing: null,
      asOfDate: date,
    };
  }

  const snapshot = await loadFxSnapshotAsOf(db, date);
  const rate = frozenRateBetween(currency, baseCurrency, snapshot);
  if (rate === null) {
    return {
      fx_rate_to_base: null,
      base_currency: null,
      base_amount_minor: null,
      missing: currency,
      asOfDate: snapshot.asOf,
    };
  }

  const baseAmount = convertWithFrozenRate(amountMinor, currency, baseCurrency, rate);
  if (baseAmount === null) {
    return {
      fx_rate_to_base: null,
      base_currency: null,
      base_amount_minor: null,
      missing: currency,
      asOfDate: snapshot.asOf,
    };
  }

  return {
    fx_rate_to_base: rate,
    base_currency: baseCurrency,
    base_amount_minor: baseAmount,
    missing: null,
    asOfDate: snapshot.asOf,
  };
}

/** 快照里是否含有该币种（USD 恒为 true）。 */
export function hasFx(snapshot: FxSnapshot, currency: string): boolean {
  return currency === FX_BASE || typeof snapshot.rates[currency] === 'string';
}
