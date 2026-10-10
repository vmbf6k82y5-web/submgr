import { describe, expect, it } from 'vitest';
import {
  MAX_TREND_MONTHS,
  UNCATEGORIZED_KEY,
  UNKNOWN_CYCLE_KEY,
  addMonthsToMonthKey,
  chargeChannelLabel,
  cycleTypeLabel,
  isValidMonthKey,
  monthKeyOf,
  monthlyTrend,
  monthsBetween,
  subTypeLabel,
  type TrendContext,
} from '../src/trend.js';
import { TEST_RATES, makeCategory, makeCharge, makeFxSnapshot, makeSubscription, makeVersion } from './fixtures.js';
import type { ChargeRow, SubscriptionRow, SubscriptionVersionRow } from '../src/types.js';

const rates = makeFxSnapshot(TEST_RATES, '2024-03-20T00:00:00.000Z');

function ctx(overrides: Partial<TrendContext> = {}): TrendContext {
  return {
    baseCurrency: 'CNY',
    rates,
    subscriptions: [],
    versions: [],
    categories: [],
    ...overrides,
  };
}

describe('trend: 月份键工具', () => {
  it('合法 / 非法的月份键', () => {
    expect(isValidMonthKey('2024-01')).toBe(true);
    expect(isValidMonthKey('2024-12')).toBe(true);
    expect(isValidMonthKey('2024-13')).toBe(false);
    expect(isValidMonthKey('2024-00')).toBe(false);
    expect(isValidMonthKey('2024-1')).toBe(false);
    expect(isValidMonthKey('202401')).toBe(false);
    expect(isValidMonthKey('')).toBe(false);
  });

  it('从日期取月份键', () => {
    expect(monthKeyOf('2024-03-20')).toBe('2024-03');
    expect(monthKeyOf('2024-12-31')).toBe('2024-12');
  });

  it('非法日期取月份键会抛错', () => {
    expect(() => monthKeyOf('2024-02-30')).toThrow(RangeError);
    expect(() => monthKeyOf('2024-3-1')).toThrow(RangeError);
  });

  it('月份加减跨年', () => {
    expect(addMonthsToMonthKey('2024-12', 1)).toBe('2025-01');
    expect(addMonthsToMonthKey('2024-01', -1)).toBe('2023-12');
    expect(addMonthsToMonthKey('2024-01', 12)).toBe('2025-01');
    expect(addMonthsToMonthKey('2024-01', 13)).toBe('2025-02');
    expect(addMonthsToMonthKey('2024-03', 0)).toBe('2024-03');
    expect(addMonthsToMonthKey('2024-01', -13)).toBe('2022-12');
  });

  it('月份加减不会出现「1 月 31 日 + 1 月 = 3 月」这类漂移', () => {
    // 连续加 12 次 1 个月必须回到同一个月（从 1 号出发，永远不会被月末截断）
    let cur = '2024-01';
    for (let i = 0; i < 12; i += 1) cur = addMonthsToMonthKey(cur, 1);
    expect(cur).toBe('2025-01');
    // 从月末月份出发也一样
    let cur2 = '2024-01';
    for (let i = 0; i < 11; i += 1) cur2 = addMonthsToMonthKey(cur2, 1);
    expect(cur2).toBe('2024-12');
  });

  it('非法参数抛错', () => {
    expect(() => addMonthsToMonthKey('2024-13', 1)).toThrow(RangeError);
    expect(() => addMonthsToMonthKey('2024-01', 1.5)).toThrow(RangeError);
    expect(() => monthsBetween('2024-13', '2024-01')).toThrow(RangeError);
  });

  it('枚举区间内的月份（含两端）', () => {
    expect(monthsBetween('2024-01', '2024-03')).toEqual(['2024-01', '2024-02', '2024-03']);
    expect(monthsBetween('2024-11', '2025-02')).toEqual([
      '2024-11',
      '2024-12',
      '2025-01',
      '2025-02',
    ]);
    expect(monthsBetween('2024-05', '2024-05')).toEqual(['2024-05']);
  });

  it('from > to 时返回空数组', () => {
    expect(monthsBetween('2024-05', '2024-04')).toEqual([]);
  });
});

describe('trend: 中文标签', () => {
  it('枚举都有中文名', () => {
    expect(subTypeLabel('software')).toBe('软件');
    expect(subTypeLabel('media')).toBe('影音娱乐');
    expect(chargeChannelLabel('wechat')).toBe('微信');
    expect(cycleTypeLabel('year')).toBe('年付');
    expect(cycleTypeLabel('lifetime')).toBe('终身');
  });

  it('遇到没见过的值原样返回，不崩', () => {
    expect(subTypeLabel('brand_new' as never)).toBe('brand_new');
    expect(chargeChannelLabel('crypto' as never)).toBe('crypto');
  });
});

// ---------------------------------------------------------------------------
// monthlyTrend
// ---------------------------------------------------------------------------

const movieCat = makeCategory({ id: 'cat-movie', name: '影音娱乐', sort: 10 });
const toolCat = makeCategory({ id: 'cat-tool', name: '软件工具', sort: 20 });

const netflix: SubscriptionRow = makeSubscription({
  id: 'sub-netflix',
  name: 'Netflix',
  category_id: 'cat-movie',
  sub_type: 'media',
  charge_channel: 'apple',
  start_date: '2024-01-15',
});
const notion: SubscriptionRow = makeSubscription({
  id: 'sub-notion',
  name: 'Notion',
  category_id: 'cat-tool',
  sub_type: 'software',
  charge_channel: 'card',
  start_date: '2024-01-01',
});
const netflixMonthly: SubscriptionVersionRow = makeVersion({
  id: 'ver-netflix-month',
  subscription_id: 'sub-netflix',
  effective_from: '2024-01-15',
  cycle_type: 'month',
  amount_minor: 2500,
});
const notionYearly: SubscriptionVersionRow = makeVersion({
  id: 'ver-notion-year',
  subscription_id: 'sub-notion',
  effective_from: '2024-01-01',
  cycle_type: 'year',
  amount_minor: 81600,
});

function baseCtx(overrides: Partial<TrendContext> = {}): TrendContext {
  return ctx({
    subscriptions: [netflix, notion],
    versions: [netflixMonthly, notionYearly],
    categories: [movieCat, toolCat],
    ...overrides,
  });
}

describe('trend: 按月堆叠', () => {
  // 注意：makeCharge 的 base_amount_minor 默认是 2500，而趋势口径优先用「冻结的 base_amount_minor」。
  // 所以凡是要改 amount_minor 的用例，必须连 base_amount_minor 一起改，否则冻结值会盖掉原值。
  const charges: ChargeRow[] = [
    makeCharge({ subscription_id: 'sub-netflix', version_id: 'ver-netflix-month', charge_date: '2024-01-15', amount_minor: 2500, base_amount_minor: 2500 }),
    makeCharge({ subscription_id: 'sub-notion', version_id: 'ver-notion-year', charge_date: '2024-02-01', amount_minor: 81600, base_amount_minor: 81600 }),
    makeCharge({ subscription_id: 'sub-netflix', version_id: 'ver-netflix-month', charge_date: '2024-02-15', amount_minor: 2500, base_amount_minor: 2500 }),
    makeCharge({ subscription_id: 'sub-netflix', version_id: 'ver-netflix-month', charge_date: '2024-03-15', amount_minor: 2500, base_amount_minor: 2500 }),
  ];

  const result = monthlyTrend(charges, 'category', { from: '2024-01', to: '2024-04' }, baseCtx());

  it('月份是连续的，没有支出的月份也在（值为 0）', () => {
    expect(result.months).toEqual(['2024-01', '2024-02', '2024-03', '2024-04']);
    const april = result.totalsByMonth.find((m) => m.month === '2024-04');
    expect(april?.amountBaseMinor).toBe(0);
  });

  it('每月合计正确', () => {
    expect(result.totalsByMonth).toEqual([
      { month: '2024-01', amountBaseMinor: 2500 },
      { month: '2024-02', amountBaseMinor: 2500 + 81600 },
      { month: '2024-03', amountBaseMinor: 2500 },
      { month: '2024-04', amountBaseMinor: 0 },
    ]);
  });

  it('分组按总额从大到小排序（软件工具 81600 > 影音娱乐 7500）', () => {
    expect(result.groups.map((g) => g.label)).toEqual(['软件工具', '影音娱乐']);
    expect(result.grandTotalMinor).toBe(81600 + 2500 * 3);
  });

  it('cells 是完整的 months × groups 矩阵', () => {
    expect(result.cells).toHaveLength(4 * 2);
    const janMovie = result.cells.find((c) => c.month === '2024-01' && c.group === 'cat-movie');
    expect(janMovie).toEqual({
      month: '2024-01',
      group: 'cat-movie',
      amountBaseMinor: 2500,
      chargeCount: 1,
    });
    const janTool = result.cells.find((c) => c.month === '2024-01' && c.group === 'cat-tool');
    expect(janTool?.amountBaseMinor).toBe(0);
    expect(janTool?.chargeCount).toBe(0);
  });

  it('区间外的扣款不计入', () => {
    const narrow = monthlyTrend(charges, 'category', { from: '2024-02', to: '2024-02' }, baseCtx());
    expect(narrow.months).toEqual(['2024-02']);
    expect(narrow.grandTotalMinor).toBe(2500 + 81600);
  });

  it('没有扣款时是空图，不报错', () => {
    const empty = monthlyTrend([], 'category', { from: '2024-01', to: '2024-03' }, baseCtx());
    expect(empty.groups).toEqual([]);
    expect(empty.cells).toEqual([]);
    expect(empty.grandTotalMinor).toBe(0);
    expect(empty.totalsByMonth.map((m) => m.amountBaseMinor)).toEqual([0, 0, 0]);
  });

  it('from > to 时返回空月份', () => {
    const bad = monthlyTrend(charges, 'category', { from: '2024-05', to: '2024-04' }, baseCtx());
    expect(bad.months).toEqual([]);
    expect(bad.grandTotalMinor).toBe(0);
  });
});

describe('trend: 四个维度', () => {
  const charges: ChargeRow[] = [
    makeCharge({ subscription_id: 'sub-netflix', version_id: 'ver-netflix-month', charge_date: '2024-01-15', amount_minor: 2500, base_amount_minor: 2500 }),
    makeCharge({ subscription_id: 'sub-notion', version_id: 'ver-notion-year', charge_date: '2024-01-01', amount_minor: 81600, base_amount_minor: 81600 }),
  ];
  const run = (dimension: 'category' | 'cycle' | 'channel' | 'type') =>
    monthlyTrend(charges, dimension, { from: '2024-01', to: '2024-01' }, baseCtx());

  it('group=category 按分类名分组', () => {
    expect(run('category').groups.map((g) => g.label).sort()).toEqual(['影音娱乐', '软件工具']);
  });

  it('group=cycle 按版本周期分组', () => {
    expect(run('cycle').groups.map((g) => g.label).sort()).toEqual(['年付', '月付']);
    expect(run('cycle').groups.map((g) => g.key).sort()).toEqual(['month', 'year']);
  });

  it('group=channel 按扣费渠道分组', () => {
    expect(run('channel').groups.map((g) => g.label).sort()).toEqual(['Apple', '银行卡']);
  });

  it('group=type 按订阅类型分组', () => {
    expect(run('type').groups.map((g) => g.label).sort()).toEqual(['影音娱乐', '软件']);
  });
});

describe('trend: 币种与汇率', () => {
  const usdSub = makeSubscription({ id: 'sub-usd', name: 'Netflix', charge_channel: 'card', start_date: '2024-01-15' });
  const usdV = makeVersion({
    id: 'ver-usd',
    subscription_id: 'sub-usd',
    effective_from: '2024-01-15',
    currency: 'USD',
    amount_minor: 2299,
  });
  const usdCtx = () => ctx({ subscriptions: [usdSub], versions: [usdV], categories: [] });

  it('已发生的扣款优先用冻结的 base_amount_minor', () => {
    // 冻结时汇率 7.1420 -> 16419；当前汇率表里 CNY 是 7.1400，重算只会得到 16415
    const c = makeCharge({
      subscription_id: 'sub-usd',
      version_id: 'ver-usd',
      charge_date: '2024-01-15',
      amount_minor: 2299,
      currency: 'USD',
      base_currency: 'CNY',
      base_amount_minor: 16419,
    });
    const r = monthlyTrend([c], 'channel', { from: '2024-01', to: '2024-01' }, usdCtx());
    expect(r.grandTotalMinor).toBe(16419);
  });

  it('冻结的基准币种和当前基准不一致时，退回用原币种按当前汇率换算', () => {
    const c = makeCharge({
      subscription_id: 'sub-usd',
      version_id: 'ver-usd',
      charge_date: '2024-01-15',
      amount_minor: 2299,
      currency: 'USD',
      base_currency: 'JPY', // 用户当时把基准设成了日元，现在已经改回 CNY
      base_amount_minor: 361000,
    });
    const r = monthlyTrend([c], 'channel', { from: '2024-01', to: '2024-01' }, usdCtx());
    // 2299 USD x 7.1400 = 16414.86 -> 16415
    expect(r.grandTotalMinor).toBe(16415);
  });

  it('没有冻结金额时按当前汇率换算', () => {
    const c = makeCharge({
      subscription_id: 'sub-usd',
      version_id: 'ver-usd',
      charge_date: '2024-01-15',
      amount_minor: 2299,
      currency: 'USD',
      base_currency: null,
      base_amount_minor: null,
    });
    const r = monthlyTrend([c], 'channel', { from: '2024-01', to: '2024-01' }, usdCtx());
    expect(r.grandTotalMinor).toBe(16415);
  });

  it('缺汇率时格子是 null，并把币种列出来（不是 0）', () => {
    const jpyV = makeVersion({
      id: 'ver-jpy',
      subscription_id: 'sub-jpy',
      effective_from: '2024-01-01',
      currency: 'JPY',
      amount_minor: 12000,
    });
    const jpySub = makeSubscription({ id: 'sub-jpy', name: '日本服务', charge_channel: 'card', start_date: '2024-01-01' });
    const charges = [
      makeCharge({ subscription_id: 'sub-jpy', version_id: 'ver-jpy', charge_date: '2024-01-05', amount_minor: 12000, currency: 'JPY', base_currency: null, base_amount_minor: null }),
      makeCharge({ subscription_id: 'sub-jpy', version_id: 'ver-jpy', charge_date: '2024-02-05', amount_minor: 12000, currency: 'JPY', base_currency: null, base_amount_minor: null }),
    ];
    const withoutJpy = makeFxSnapshot({ CNY: '7.1400' }, '2024-01-05T00:00:00.000Z');
    const r = monthlyTrend(
      charges,
      'channel',
      { from: '2024-01', to: '2024-02' },
      ctx({ subscriptions: [jpySub], versions: [jpyV], rates: withoutJpy }),
    );
    expect(r.missingCurrencies).toEqual(['JPY']);
    expect(r.grandTotalMinor).toBeNull();
    expect(r.totalsByMonth.map((m) => m.amountBaseMinor)).toEqual([null, null]);
    expect(r.cells.every((c) => c.amountBaseMinor === null)).toBe(true);
    // 关键：不能把缺汇率的格子当成 0
    expect(r.cells.some((c) => c.amountBaseMinor === 0)).toBe(false);
  });

  it('只有部分月份缺汇率时，其他月份的合计照常给', () => {
    const jpyV = makeVersion({ id: 'ver-jpy2', subscription_id: 'sub-jpy', effective_from: '2024-01-01', currency: 'JPY', amount_minor: 12000 });
    const jpySub = makeSubscription({ id: 'sub-jpy', name: '日本服务', charge_channel: 'card', start_date: '2024-01-01' });
    const charges = [
      makeCharge({ subscription_id: 'sub-jpy', version_id: 'ver-jpy2', charge_date: '2024-01-05', amount_minor: 12000, currency: 'JPY', base_currency: null, base_amount_minor: null }),
      makeCharge({ subscription_id: 'sub-jpy', version_id: 'ver-jpy2', charge_date: '2024-02-05', amount_minor: 12000, currency: 'JPY', base_currency: 'CNY', base_amount_minor: 54504 }),
    ];
    const withoutJpy = makeFxSnapshot({ CNY: '7.1400' }, '2024-01-05T00:00:00.000Z');
    const r = monthlyTrend(
      charges,
      'channel',
      { from: '2024-01', to: '2024-02' },
      ctx({ subscriptions: [jpySub], versions: [jpyV], rates: withoutJpy }),
    );
    expect(r.totalsByMonth).toEqual([
      { month: '2024-01', amountBaseMinor: null },
      { month: '2024-02', amountBaseMinor: 54504 },
    ]);
    expect(r.grandTotalMinor).toBeNull(); // 有一格算不出来，总额就不能给死数
  });

  it('基准币种可以不是 CNY', () => {
    const cnyV = makeVersion({ id: 'ver-cny', subscription_id: 'sub-cny', effective_from: '2024-01-01', amount_minor: 7140 });
    const cnySub = makeSubscription({ id: 'sub-cny', name: '国内服务', charge_channel: 'alipay', start_date: '2024-01-01' });
    const c = makeCharge({ subscription_id: 'sub-cny', version_id: 'ver-cny', charge_date: '2024-01-05', amount_minor: 7140, currency: 'CNY', base_currency: null, base_amount_minor: null });
    const r = monthlyTrend([c], 'channel', { from: '2024-01', to: '2024-01' }, ctx({ baseCurrency: 'USD', subscriptions: [cnySub], versions: [cnyV] }));
    expect(r.baseCurrency).toBe('USD');
    expect(r.grandTotalMinor).toBe(1000); // ¥71.40 = $10.00
  });
});

describe('trend: 扣款状态的取舍', () => {
  const sub = makeSubscription({ id: 'sub-x', name: 'X', charge_channel: 'card', start_date: '2024-01-01' });
  const v = makeVersion({ id: 'ver-x', subscription_id: 'sub-x', effective_from: '2024-01-01' });
  const xCtx = () => ctx({ subscriptions: [sub], versions: [v] });
  const mk = (over: Partial<ChargeRow>) =>
    makeCharge({ subscription_id: 'sub-x', version_id: 'ver-x', charge_date: '2024-01-05', ...over });

  it('paid 记正数', () => {
    const r = monthlyTrend([mk({ amount_minor: 2500, status: 'paid' })], 'channel', { from: '2024-01', to: '2024-01' }, xCtx());
    expect(r.grandTotalMinor).toBe(2500);
    expect(r.excluded).toEqual({ failed: 0, refunded: 0, orphan: 0 });
  });

  it('refunded 记负数（钱退回来了）', () => {
    const r = monthlyTrend(
      [mk({ amount_minor: 2500, status: 'paid' }), mk({ amount_minor: 2500, status: 'refunded' })],
      'channel',
      { from: '2024-01', to: '2024-01' },
      xCtx(),
    );
    expect(r.grandTotalMinor).toBe(0);
    expect(r.excluded.refunded).toBe(1);
    expect(r.cells[0]?.chargeCount).toBe(2);
  });

  it('failed 完全排除（没有实际支出）', () => {
    const r = monthlyTrend(
      [mk({ amount_minor: 2500, status: 'paid' }), mk({ amount_minor: 9900, status: 'failed' })],
      'channel',
      { from: '2024-01', to: '2024-01' },
      xCtx(),
    );
    expect(r.grandTotalMinor).toBe(2500);
    expect(r.excluded.failed).toBe(1);
    expect(r.cells[0]?.chargeCount).toBe(1); // 失败的不计入笔数
  });

  it('软删除的扣款不计入', () => {
    const r = monthlyTrend(
      [mk({ amount_minor: 2500, deleted_at: '2024-02-01T00:00:00.000Z' })],
      'channel',
      { from: '2024-01', to: '2024-01' },
      xCtx(),
    );
    expect(r.grandTotalMinor).toBe(0);
    expect(r.groups).toEqual([]);
  });

  it('订阅已被删除的孤儿扣款不计入，但会记数', () => {
    const orphan = makeCharge({ subscription_id: 'sub-gone', charge_date: '2024-01-05', amount_minor: 2500 });
    const r = monthlyTrend([orphan], 'channel', { from: '2024-01', to: '2024-01' }, xCtx());
    expect(r.grandTotalMinor).toBe(0);
    expect(r.excluded.orphan).toBe(1);
  });

  it('软删除的订阅，其扣款不计入', () => {
    const deadSub = makeSubscription({ id: 'sub-x', start_date: '2024-01-01', deleted_at: '2024-02-01T00:00:00.000Z' });
    const r = monthlyTrend(
      [mk({ amount_minor: 2500 })],
      'channel',
      { from: '2024-01', to: '2024-01' },
      ctx({ subscriptions: [deadSub], versions: [v] }),
    );
    expect(r.grandTotalMinor).toBe(0);
    expect(r.excluded.orphan).toBe(1);
  });
});

describe('trend: 分组缺失时的兜底', () => {
  it('没分类的订阅归到「未分类」', () => {
    const noCat = makeSubscription({ id: 'sub-n', name: 'N', category_id: null, charge_channel: 'card', start_date: '2024-01-01' });
    const c = makeCharge({ subscription_id: 'sub-n', charge_date: '2024-01-05', amount_minor: 2500 });
    const r = monthlyTrend([c], 'category', { from: '2024-01', to: '2024-01' }, ctx({ subscriptions: [noCat] }));
    expect(r.groups).toEqual([{ key: UNCATEGORIZED_KEY, label: '未分类' }]);
  });

  it('分类已被软删除时也算「未分类」', () => {
    const deadCat = makeCategory({ id: 'cat-dead', name: '旧分类', deleted_at: '2024-02-01T00:00:00.000Z' });
    const sub = makeSubscription({ id: 'sub-n', name: 'N', category_id: 'cat-dead', charge_channel: 'card', start_date: '2024-01-01' });
    const c = makeCharge({ subscription_id: 'sub-n', charge_date: '2024-01-05', amount_minor: 2500 });
    const r = monthlyTrend([c], 'category', { from: '2024-01', to: '2024-01' }, ctx({ subscriptions: [sub], categories: [deadCat] }));
    expect(r.groups[0]?.key).toBe(UNCATEGORIZED_KEY);
  });

  it('扣款没关联版本时归到「未知周期」', () => {
    const sub = makeSubscription({ id: 'sub-n', name: 'N', charge_channel: 'card', start_date: '2024-01-01' });
    const c = makeCharge({ subscription_id: 'sub-n', version_id: null, charge_date: '2024-01-05', amount_minor: 2500 });
    const r = monthlyTrend([c], 'cycle', { from: '2024-01', to: '2024-01' }, ctx({ subscriptions: [sub] }));
    expect(r.groups).toEqual([{ key: UNKNOWN_CYCLE_KEY, label: '未知周期' }]);
  });
});

describe('trend: 规模上限', () => {
  it('MAX_TREND_MONTHS 起到护栏作用，超长区间不会无限扩张', () => {
    expect(MAX_TREND_MONTHS).toBe(600);
    const long = monthsBetween('2000-01', '2059-12'); // 720 个月 > 600
    expect(long).toHaveLength(MAX_TREND_MONTHS);
  });

  it('正常区间不受影响', () => {
    expect(monthsBetween('2024-01', '2024-12')).toHaveLength(12);
    expect(monthsBetween('2020-01', '2024-12')).toHaveLength(60);
  });
});
