import { addMonthsKeepingAnchorDay, isValidDateOnly } from './time.js';
import { convert, normalizeCurrency } from './money.js';
import type {
  CategoryRow,
  ChargeChannel,
  ChargeRow,
  CycleType,
  FxSnapshot,
  SubscriptionRow,
  SubscriptionVersionRow,
  SubType,
} from './types.js';

// ---------------------------------------------------------------------------
// 中文标签
//
// 这些映射前端（列表、图表图例）和 Worker（提醒文案）都要用，
// 放在 core 里保证两边说法一致，例如提醒里的「通过微信扣费」。
// ---------------------------------------------------------------------------

export const SUB_TYPE_LABELS: Record<SubType, string> = {
  software: '软件',
  media: '影音娱乐',
  cloud: '云服务',
  membership: '会员',
  telecom: '通讯',
  other: '其他',
};

export const CHARGE_CHANNEL_LABELS: Record<ChargeChannel, string> = {
  apple: 'Apple',
  alipay: '支付宝',
  wechat: '微信',
  google: 'Google Play',
  card: '银行卡',
  paypal: 'PayPal',
  telecom: '运营商代扣',
  in_app: '应用内购买',
  other: '其他',
};

export const CYCLE_TYPE_LABELS: Record<CycleType, string> = {
  month: '月付',
  quarter: '季付',
  half_year: '半年付',
  year: '年付',
  days: '固定天数',
  lifetime: '终身',
};

export function subTypeLabel(v: SubType): string {
  return SUB_TYPE_LABELS[v] ?? v;
}

export function chargeChannelLabel(v: ChargeChannel): string {
  return CHARGE_CHANNEL_LABELS[v] ?? v;
}

export function cycleTypeLabel(v: CycleType): string {
  return CYCLE_TYPE_LABELS[v] ?? v;
}

// ---------------------------------------------------------------------------
// 月份键（'YYYY-MM'）
// ---------------------------------------------------------------------------

/** 趋势图的分组维度，对应 /api/trends?group=... */
export const TREND_DIMENSIONS = ['category', 'cycle', 'channel', 'type'] as const;
export type TrendDimension = (typeof TREND_DIMENSIONS)[number];

export const TREND_DIMENSION_LABELS: Record<TrendDimension, string> = {
  category: '分类',
  cycle: '付费周期',
  channel: '扣费渠道',
  type: '订阅类型',
};

/** 单次请求最多允许多少个月，防止 from/to 写错时把内存跑满。 */
export const MAX_TREND_MONTHS = 600;

/** 'YYYY-MM' 是否合法（会校验月份在 01–12）。 */
export function isValidMonthKey(key: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(key)) return false;
  return isValidDateOnly(`${key}-01`);
}

/** 从 'YYYY-MM-DD' 取出 'YYYY-MM'。 */
export function monthKeyOf(dateOnly: string): string {
  if (!isValidDateOnly(dateOnly)) {
    throw new RangeError(`不是合法的日期：${dateOnly}`);
  }
  return dateOnly.slice(0, 7);
}

/**
 * 月份键加减。
 *
 * 实现上先补成 'YYYY-MM-01' 再交给 `addMonthsKeepingAnchorDay`：
 * 从 1 号出发做月份加减永远不会被月末截断，也就不会出现「1 月 31 日 + 1 月 = 3 月 3 日」
 * 这类手写月份加减的经典错误。
 */
export function addMonthsToMonthKey(monthKey: string, monthsToAdd: number): string {
  if (!isValidMonthKey(monthKey)) {
    throw new RangeError(`不是合法的月份键（应为 YYYY-MM）：${monthKey}`);
  }
  if (!Number.isInteger(monthsToAdd)) {
    throw new RangeError(`月份加减必须是整数：${monthsToAdd}`);
  }
  return addMonthsKeepingAnchorDay(`${monthKey}-01`, monthsToAdd, 1).slice(0, 7);
}

/**
 * 枚举 [fromMonth, toMonth] 闭区间内的所有月份（含两端）。
 * from > to 时返回空数组。
 */
export function monthsBetween(fromMonth: string, toMonth: string): string[] {
  if (!isValidMonthKey(fromMonth)) {
    throw new RangeError(`不是合法的月份键（应为 YYYY-MM）：${fromMonth}`);
  }
  if (!isValidMonthKey(toMonth)) {
    throw new RangeError(`不是合法的月份键（应为 YYYY-MM）：${toMonth}`);
  }
  if (fromMonth > toMonth) return [];

  const out: string[] = [];
  let cur = fromMonth;
  for (let i = 0; i < MAX_TREND_MONTHS; i += 1) {
    out.push(cur);
    if (cur === toMonth) break;
    const next = addMonthsToMonthKey(cur, 1);
    if (next > toMonth) break;
    cur = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 月度趋势
// ---------------------------------------------------------------------------

/** 「未分类」分组的 key。 */
export const UNCATEGORIZED_KEY = '__uncategorized__';
/** 「未知周期」分组的 key（扣款没关联版本时）。 */
export const UNKNOWN_CYCLE_KEY = '__unknown_cycle__';

export interface TrendRange {
  /** 'YYYY-MM'，含 */
  from: string;
  /** 'YYYY-MM'，含 */
  to: string;
}

export interface TrendContext {
  /** 展示与合计用的基准币种，一般是 settings.base_currency */
  baseCurrency: string;
  /** 最新汇率快照；缺汇率的币种会让对应格子变成 null */
  rates: FxSnapshot;
  subscriptions: readonly SubscriptionRow[];
  versions: readonly SubscriptionVersionRow[];
  categories?: readonly CategoryRow[];
}

export interface TrendGroup {
  /** 分组键：分类 id / cycle_type / charge_channel / sub_type */
  key: string;
  /** 中文展示名 */
  label: string;
}

export interface TrendCell {
  /** 'YYYY-MM' */
  month: string;
  /** 对应 TrendGroup.key */
  group: string;
  /** 该月该组的金额（基准币种最小单位）；缺汇率时为 null */
  amountBaseMinor: number | null;
  /** 参与计算的扣款笔数（不含被排除的失败扣款） */
  chargeCount: number;
}

export interface TrendMonthTotal {
  month: string;
  /** 该月合计；只要该月有任何一个格子缺汇率就是 null */
  amountBaseMinor: number | null;
}

export interface TrendResult {
  dimension: TrendDimension;
  baseCurrency: string;
  from: string;
  to: string;
  /** from..to 的连续月份（无数据的月份也在，值为 0） */
  months: string[];
  /** 按总额从大到小排序，方便堆叠图图例 */
  groups: TrendGroup[];
  /** 完整的 months × groups 矩阵，前端可以直接画堆叠柱状图 */
  cells: TrendCell[];
  totalsByMonth: TrendMonthTotal[];
  grandTotalMinor: number | null;
  missingCurrencies: string[];
  /** 被排除或未能归类的扣款笔数，用于排查问题 */
  excluded: {
    /** status = 'failed'，没有实际支出 */
    failed: number;
    /** status = 'refunded'，按负数计入，这里记笔数 */
    refunded: number;
    /** 订阅已被删除 / 查不到的孤儿扣款 */
    orphan: number;
  };
}

/**
 * 按月的堆叠趋势（对应 `/api/trends?group=...&from=...&to=...`）。
 *
 * 口径：
 * - **只统计实际发生的钱**：`paid` 记正数，`refunded` 记负数，`failed` 完全排除。
 * - **币种**：优先用扣款当天冻结的 `base_amount_minor`（`base_currency` 与当前基准一致时）；
 *   否则按最新汇率把原币种金额换成基准币种。
 *   如果某个币种缺汇率，**对应的格子是 null 而不是 0**，同时把币种列进 `missingCurrencies`，
 *   绝不静默跳过（跟 summarize 的口径一致）。
 * - **月份补齐**：from..to 之间的每个月份都会出现在结果里，没有支出的月份值为 0，
 *   这样前端不用自己补空月份。
 * - **分组排序**：按区间总额从大到小，金额相同时按 key 升序，保证结果稳定可复现。
 *
 * @param charges 扣款记录（可以传全部，函数内部按 range 过滤）
 * @param dimension 分组维度
 * @param range 月份区间（含两端）
 * @param ctx 订阅 / 版本 / 分类 / 汇率
 */
export function monthlyTrend(
  charges: readonly ChargeRow[],
  dimension: TrendDimension,
  range: TrendRange,
  ctx: TrendContext,
): TrendResult {
  const base = normalizeCurrency(ctx.baseCurrency);
  const months = monthsBetween(range.from, range.to);
  const monthSet = new Set(months);

  const subById = new Map(ctx.subscriptions.map((s) => [s.id, s]));
  const versionById = new Map(ctx.versions.map((v) => [v.id, v]));
  const categoryById = new Map((ctx.categories ?? []).map((c) => [c.id, c]));

  const missing = new Set<string>();
  const amounts = new Map<string, number>();
  const failedCells = new Set<string>();
  const cellCounts = new Map<string, number>();
  const labels = new Map<string, string>();
  const groupTotals = new Map<string, number>();

  let failedCount = 0;
  let refundedCount = 0;
  let orphanCount = 0;

  for (const charge of charges) {
    if (charge.deleted_at) continue;

    if (charge.status === 'failed') {
      failedCount += 1;
      continue;
    }

    const month = monthKeyOf(charge.charge_date);
    if (!monthSet.has(month)) continue;

    const sub = subById.get(charge.subscription_id);
    if (!sub || sub.deleted_at) {
      orphanCount += 1;
      continue;
    }

    const { key, label } = trendGroupOf(charge, dimension, sub, versionById, categoryById);
    labels.set(key, label);

    const cellKey = cellKeyOf(month, key);
    cellCounts.set(cellKey, (cellCounts.get(cellKey) ?? 0) + 1);

    const inBase = chargeAmountInBase(charge, base, ctx.rates, missing);
    if (inBase === null) {
      failedCells.add(cellKey);
      continue;
    }

    const signed = charge.status === 'refunded' ? -inBase : inBase;
    if (charge.status === 'refunded') refundedCount += 1;

    amounts.set(cellKey, (amounts.get(cellKey) ?? 0) + signed);
    groupTotals.set(key, (groupTotals.get(key) ?? 0) + signed);
  }

  const groups: TrendGroup[] = [...labels.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) => {
      const ta = groupTotals.get(a.key) ?? 0;
      const tb = groupTotals.get(b.key) ?? 0;
      if (ta !== tb) return tb - ta;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

  const cells: TrendCell[] = [];
  for (const month of months) {
    for (const g of groups) {
      const cellKey = cellKeyOf(month, g.key);
      cells.push({
        month,
        group: g.key,
        // 缺汇率的格子是 null：让调用方看见「这里算不出来」，而不是看到一个假的 0
        amountBaseMinor: failedCells.has(cellKey) ? null : (amounts.get(cellKey) ?? 0),
        chargeCount: cellCounts.get(cellKey) ?? 0,
      });
    }
  }

  const totalsByMonth: TrendMonthTotal[] = months.map((month) => {
    let hitMissing = false;
    let sum = 0;
    for (const g of groups) {
      const cellKey = cellKeyOf(month, g.key);
      if (failedCells.has(cellKey)) {
        hitMissing = true;
        break;
      }
      sum += amounts.get(cellKey) ?? 0;
    }
    return { month, amountBaseMinor: hitMissing ? null : sum };
  });

  const grandTotalMinor =
    failedCells.size > 0
      ? null
      : totalsByMonth.reduce((acc, m) => acc + (m.amountBaseMinor ?? 0), 0);

  return {
    dimension,
    baseCurrency: base,
    from: range.from,
    to: range.to,
    months,
    groups,
    cells,
    totalsByMonth,
    grandTotalMinor,
    missingCurrencies: [...missing].sort(),
    excluded: { failed: failedCount, refunded: refundedCount, orphan: orphanCount },
  };
}

/** 单元格的复合键。用 NUL 连接，避免月份或分组键里出现分隔符导致撞键。 */
function cellKeyOf(month: string, group: string): string {
  return `${month}\u0000${group}`;
}

/**
 * 把一笔扣款折算成基准币种最小单位。
 * 返回 null 表示缺汇率（币种会被记进 missing）。
 */
function chargeAmountInBase(
  charge: ChargeRow,
  base: string,
  rates: FxSnapshot,
  missing: Set<string>,
): number | null {
  // 1) 已发生的扣款优先用「扣款当天冻结」的基准金额（spec：历史金额必须冻结）
  if (charge.base_amount_minor !== null && charge.base_currency !== null) {
    const frozenBase = safeCurrency(charge.base_currency);
    if (frozenBase === base) return charge.base_amount_minor;
    // 冻结时用的基准币种和现在的基准不一致（用户改过 settings.base_currency）：
    // 冻结值已经没法直接比较，退回到用原币种 + 当前汇率换算。
  }

  // 2) 同币种直通
  const currency = safeCurrency(charge.currency);
  if (currency === null) return null;
  if (currency === base) return charge.amount_minor;

  // 3) 用当前汇率换算
  const converted = convert(charge.amount_minor, currency, base, rates);
  if (converted === null) {
    missing.add(currency);
    return null;
  }
  return converted;
}

/** 币种代码不合法时返回 null，不抛错——趋势图不该因为一行脏数据整个挂掉。 */
function safeCurrency(raw: string): string | null {
  try {
    return normalizeCurrency(raw);
  } catch {
    return null;
  }
}

/** 决定一笔扣款属于哪个分组。 */
function trendGroupOf(
  charge: ChargeRow,
  dimension: TrendDimension,
  sub: SubscriptionRow,
  versionById: Map<string, SubscriptionVersionRow>,
  categoryById: Map<string, CategoryRow>,
): { key: string; label: string } {
  switch (dimension) {
    case 'category': {
      const category = sub.category_id ? categoryById.get(sub.category_id) : undefined;
      if (!category || category.deleted_at) {
        return { key: UNCATEGORIZED_KEY, label: '未分类' };
      }
      return { key: category.id, label: category.name };
    }
    case 'cycle': {
      const version = charge.version_id ? versionById.get(charge.version_id) : undefined;
      if (!version || version.deleted_at) {
        return { key: UNKNOWN_CYCLE_KEY, label: '未知周期' };
      }
      return { key: version.cycle_type, label: cycleTypeLabel(version.cycle_type) };
    }
    case 'channel':
      return {
        key: sub.charge_channel,
        label: chargeChannelLabel(sub.charge_channel),
      };
    case 'type':
      return { key: sub.sub_type, label: subTypeLabel(sub.sub_type) };
  }
}
