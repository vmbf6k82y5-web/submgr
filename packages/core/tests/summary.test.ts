import { describe, expect, it } from 'vitest';
import { summarize, UPCOMING_WINDOW_DAYS } from '../src/summary.js';
import { emptyFxSnapshot, fxSnapshotFromRows, isStale, missingCurrencies, rateAgeHours } from '../src/fx.js';
import {
  TEST_RATES,
  makeCharge,
  makeFxRate,
  makeFxSnapshot,
  makeSettings,
  makeSubscription,
  makeVersion,
} from './fixtures.js';
import type { SubscriptionRow, SubscriptionVersionRow } from '../src/types.js';

const settings = makeSettings({ base_currency: 'CNY', amortize_lifetime_months: 36 });

/** 把每条订阅的版本映射成同一个数组，方便直接丢给 summarize。 */
function flatten(...groups: SubscriptionVersionRow[][]): SubscriptionVersionRow[] {
  return groups.flat();
}

describe('fx: 汇率快照健康度', () => {
  const now = new Date('2024-03-20T12:00:00.000Z');

  it('48 小时以内不算过期', () => {
    expect(isStale('2024-03-20T00:00:00.000Z', now)).toBe(false); // 12 小时
    expect(isStale('2024-03-18T13:00:00.000Z', now)).toBe(false); // 47 小时
  });

  it('超过 48 小时算过期', () => {
    expect(isStale('2024-03-18T11:00:00.000Z', now)).toBe(true); // 49 小时
    expect(isStale('2024-03-10T00:00:00.000Z', now)).toBe(true);
  });

  it('完全没有汇率也算过期', () => {
    expect(isStale(null, now)).toBe(true);
    expect(isStale('not-a-timestamp', now)).toBe(true);
  });

  it('恰好 48 小时不算过期（要求是「超过」）', () => {
    expect(isStale('2024-03-18T12:00:00.000Z', now)).toBe(false);
  });

  it('年龄计算', () => {
    expect(rateAgeHours('2024-03-20T00:00:00.000Z', now)).toBe(12);
    expect(rateAgeHours(null, now)).toBeNull();
  });

  it('从 D1 行里挑每个币种最新一天的汇率', () => {
    const rows = [
      makeFxRate({ date: '2024-03-18', currency: 'CNY', rate: '7.1000', fetched_at: '2024-03-18T02:00:00.000Z' }),
      makeFxRate({ date: '2024-03-19', currency: 'CNY', rate: '7.1500', fetched_at: '2024-03-19T02:00:00.000Z' }),
      makeFxRate({ date: '2024-03-19', currency: 'JPY', rate: '150.00', fetched_at: '2024-03-19T02:00:00.000Z' }),
      makeFxRate({ date: '2024-03-20', currency: 'CNY', rate: '7.1400', fetched_at: '2024-03-20T02:00:00.000Z' }),
    ];
    const snap = fxSnapshotFromRows(rows);
    expect(snap.rates.CNY).toBe('7.1400'); // 取最新一天
    expect(snap.rates.JPY).toBe('150.00');
    expect(snap.asOf).toBe('2024-03-20T02:00:00.000Z');
    expect(snap.base).toBe('USD');
  });

  it('同一天多条时以 fetched_at 更晚的为准，软删除的被忽略', () => {
    const rows = [
      makeFxRate({ date: '2024-03-20', currency: 'CNY', rate: '7.0000', fetched_at: '2024-03-20T01:00:00.000Z' }),
      makeFxRate({ date: '2024-03-20', currency: 'CNY', rate: '7.9900', fetched_at: '2024-03-20T05:00:00.000Z' }),
      makeFxRate({ date: '2024-03-21', currency: 'CNY', rate: '1.0000', fetched_at: '2024-03-21T01:00:00.000Z', deleted_at: '2024-03-21T02:00:00.000Z' }),
    ];
    expect(fxSnapshotFromRows(rows).rates.CNY).toBe('7.9900');
  });

  it('缺汇率币种列表：去重、排序、不含 USD', () => {
    const rates = { CNY: '7.14' };
    expect(missingCurrencies(['CNY', 'USD'], rates)).toEqual([]);
    expect(missingCurrencies(['JPY', 'CNY', 'JPY', 'KWD'], rates)).toEqual(['JPY', 'KWD']);
    expect(missingCurrencies([], rates)).toEqual([]);
  });
});

describe('summarize: 基本汇总', () => {
  const today = '2024-03-20';

  // 1) 月付 CNY：¥25.00/月
  const iqiyi: SubscriptionRow = makeSubscription({
    id: 's-iqiyi',
    name: '爱奇艺黄金会员',
    start_date: '2024-01-31',
    renew_mode: 'auto',
  });
  const iqiyiV = makeVersion({
    id: 'v-iqiyi',
    subscription_id: 's-iqiyi',
    effective_from: '2024-01-31',
    amount_minor: 2500,
    currency: 'CNY',
    cycle_type: 'month',
  });

  // 2) 月付 USD：$22.99/月
  const netflix: SubscriptionRow = makeSubscription({
    id: 's-netflix',
    name: 'Netflix 高级会员',
    start_date: '2024-01-15',
    renew_mode: 'auto',
  });
  const netflixV = makeVersion({
    id: 'v-netflix',
    subscription_id: 's-netflix',
    effective_from: '2024-01-15',
    amount_minor: 2299,
    currency: 'USD',
    cycle_type: 'month',
  });

  // 3) 年付 CNY：¥816.00/年
  const icloud: SubscriptionRow = makeSubscription({
    id: 's-icloud',
    name: 'iCloud+ 2TB',
    start_date: '2023-04-15',
    renew_mode: 'auto',
  });
  const icloudV = makeVersion({
    id: 'v-icloud',
    subscription_id: 's-icloud',
    effective_from: '2023-04-15',
    amount_minor: 81600,
    currency: 'CNY',
    cycle_type: 'year',
  });

  // 4) 终身 CNY：¥2148.00，按 36 个月摊销
  const jetbrains: SubscriptionRow = makeSubscription({
    id: 's-jetbrains',
    name: 'JetBrains 全家桶',
    start_date: '2022-03-01',
    renew_mode: 'manual',
  });
  const jetbrainsV = makeVersion({
    id: 'v-jetbrains',
    subscription_id: 's-jetbrains',
    effective_from: '2022-03-01',
    amount_minor: 214800,
    currency: 'CNY',
    cycle_type: 'lifetime',
  });

  const subs = [iqiyi, netflix, icloud, jetbrains];
  const versions = flatten([iqiyiV], [netflixV], [icloudV], [jetbrainsV]);
  const fx = makeFxSnapshot(TEST_RATES, '2024-03-20T00:00:00.000Z');
  const now = new Date('2024-03-20T12:00:00.000Z');

  const result = summarize(subs, versions, fx, settings, today, { now });

  it('状态计数', () => {
    expect(result.counts.total).toBe(4);
    expect(result.counts.active).toBe(4);
    expect(result.counts.ended).toBe(0);
    expect(result.counts.anomaly).toBe(0);
    expect(result.anomalies).toEqual([]);
  });

  it('月均支出', () => {
    // 2500 + 16415(=$22.99×7.14) + 6800 + 5967 = 31682
    expect(result.monthlyAverageMinor).toBe(31682);
  });

  it('年均支出', () => {
    // 30000 + 196978 + 81600 + 71600 = 380178
    expect(result.yearlyAverageMinor).toBe(380178);
  });

  it('未来 30 天将扣的金额', () => {
    // 窗口 (2024-03-20, 2024-04-19]
    //   爱奇艺 03-31 = 2500
    //   Netflix 04-15 = 16415
    //   iCloud  04-15 = 81600
    //   JetBrains 终身 -> 无
    expect(result.next30DaysMinor).toBe(100515);
  });

  it('汇率新鲜，stale = false', () => {
    expect(result.stale).toBe(false);
    expect(result.fxAgeHours).toBe(12);
    expect(result.missingCurrencies).toEqual([]);
  });

  it('携带基准币种与今天', () => {
    expect(result.baseCurrency).toBe('CNY');
    expect(result.today).toBe(today);
    expect(result.timezone).toBe('Asia/Shanghai');
  });

  it('byStatus 里能看到每个订阅', () => {
    expect(result.byStatus.active.map((e) => e.subscriptionId).sort()).toEqual([
      's-icloud',
      's-iqiyi',
      's-jetbrains',
      's-netflix',
    ]);
  });

  it('窗口天数可配置', () => {
    const oneDay = summarize(subs, versions, fx, settings, today, { now, windowDays: 1 });
    // (2024-03-20, 2024-03-21] 内没有到期日
    expect(oneDay.next30DaysMinor).toBe(0);
    expect(UPCOMING_WINDOW_DAYS).toBe(30);

    const sixty = summarize(subs, versions, fx, settings, today, { now, windowDays: 60 });
    // 加上 04-30 的 2500 和 05-15 的 16415
    expect(sixty.next30DaysMinor).toBe(100515 + 2500 + 16415);
  });
});

describe('summarize: 价格版本切换前后', () => {
  const todayBefore = '2024-03-14';
  const todayOn = '2024-03-15';
  const todayAfter = '2024-03-16';

  const sub = makeSubscription({
    id: 's1',
    name: '爱奇艺',
    start_date: '2024-01-15',
    renew_mode: 'auto',
  });
  const v1 = makeVersion({
    id: 'v1',
    subscription_id: 's1',
    effective_from: '2024-01-15',
    amount_minor: 2500,
    cycle_type: 'month',
  });
  const v2 = makeVersion({
    id: 'v2',
    subscription_id: 's1',
    effective_from: '2024-03-15',
    amount_minor: 3000,
    cycle_type: 'month',
  });
  const fx = makeFxSnapshot(TEST_RATES, '2024-03-15T00:00:00.000Z');
  const now = new Date('2024-03-15T06:00:00.000Z');
  const run = (today: string) => summarize([sub], [v1, v2], fx, settings, today, { now });

  it('切换前用旧版本', () => {
    const r = run(todayBefore);
    expect(r.monthlyAverageMinor).toBe(2500);
    expect(r.yearlyAverageMinor).toBe(30000);
  });

  it('切换当天立即用新版本', () => {
    const r = run(todayOn);
    expect(r.monthlyAverageMinor).toBe(3000);
    expect(r.yearlyAverageMinor).toBe(36000);
  });

  it('切换后用新版本', () => {
    const r = run(todayAfter);
    expect(r.monthlyAverageMinor).toBe(3000);
  });

  it('未来 30 天的预估也按新版本算', () => {
    expect(run(todayAfter).next30DaysMinor).toBe(3000); // 04-15 一期
  });
});

describe('summarize: 试用转正', () => {
  const sub = makeSubscription({
    id: 's-trial',
    name: 'Notion Plus',
    start_date: '2024-01-01',
    renew_mode: 'auto',
  });
  const trialV = makeVersion({
    id: 'v-trial',
    subscription_id: 's-trial',
    effective_from: '2024-01-01',
    amount_minor: 0,
    currency: 'CNY',
    cycle_type: 'month',
    is_trial: 1,
    trial_end_date: '2024-01-14',
    after_trial_amount_minor: 9900,
    after_trial_currency: 'CNY',
    after_trial_cycle_type: 'month',
  });
  const fx = makeFxSnapshot(TEST_RATES, '2024-01-10T00:00:00.000Z');

  it('试用期间的月均按转正价格算（不是 0）', () => {
    const r = summarize([sub], [trialV], fx, settings, '2024-01-10', {
      now: new Date('2024-01-10T06:00:00.000Z'),
    });
    expect(r.counts.active).toBe(1);
    expect(r.monthlyAverageMinor).toBe(9900);
    expect(r.yearlyAverageMinor).toBe(118800);
  });

  it('未来 30 天里跨过试用结束日，按转正价格计（且只计一次）', () => {
    const r = summarize([sub], [trialV], fx, settings, '2024-01-10', {
      now: new Date('2024-01-10T06:00:00.000Z'),
    });
    // 窗口 (01-10, 02-09]：02-01 那一期属于转正后的周期，金额 9900
    expect(r.next30DaysMinor).toBe(9900);
  });

  it('试用过期且没有转正版本时计入异常，但金额仍按转正价预估', () => {
    const r = summarize([sub], [trialV], fx, settings, '2024-01-15', {
      now: new Date('2024-01-15T06:00:00.000Z'),
    });
    expect(r.counts.anomaly).toBe(1);
    expect(r.anomalies[0]!.reasonCode).toBe('trial_expired_no_conversion');
    expect(r.anomalies[0]!.subscriptionId).toBe('s-trial');
    expect(r.monthlyAverageMinor).toBe(9900);
    expect(r.next30DaysMinor).toBe(9900);
  });

  it('Cron 插入转正版本后转入正常，金额不变（转正前后数字稳定）', () => {
    const converted = makeVersion({
      id: 'v-converted',
      subscription_id: 's-trial',
      effective_from: '2024-01-14',
      amount_minor: 9900,
      currency: 'CNY',
      cycle_type: 'month',
      is_trial: 0,
    });
    const r = summarize([sub], [trialV, converted], fx, settings, '2024-01-15', {
      now: new Date('2024-01-15T06:00:00.000Z'),
    });
    expect(r.counts.anomaly).toBe(0);
    expect(r.counts.active).toBe(1);
    expect(r.monthlyAverageMinor).toBe(9900);
  });
});

describe('summarize: 缺汇率', () => {
  const fxOnlyCny = makeFxSnapshot({ CNY: '7.1400' }, '2024-03-20T00:00:00.000Z');
  const now = new Date('2024-03-20T06:00:00.000Z');

  const cnySub = makeSubscription({ id: 's-cny', start_date: '2024-01-15', renew_mode: 'auto' });
  const cnyV = makeVersion({
    id: 'v-cny',
    subscription_id: 's-cny',
    effective_from: '2024-01-15',
    amount_minor: 2500,
    currency: 'CNY',
  });
  const jpySub = makeSubscription({ id: 's-jpy', start_date: '2024-01-15', renew_mode: 'auto' });
  const jpyV = makeVersion({
    id: 'v-jpy',
    subscription_id: 's-jpy',
    effective_from: '2024-01-15',
    amount_minor: 12000,
    currency: 'JPY',
  });

  it('只要有一个币种缺汇率，合计就是 null（绝不跳过它少算）', () => {
    const r = summarize([cnySub, jpySub], [cnyV, jpyV], fxOnlyCny, settings, '2024-03-20', { now });
    expect(r.missingCurrencies).toEqual(['JPY']);
    expect(r.monthlyAverageMinor).toBeNull();
    expect(r.yearlyAverageMinor).toBeNull();
    expect(r.next30DaysMinor).toBeNull();
    // 关键：不能退化成「只算 CNY 那个」的 2500
    expect(r.monthlyAverageMinor).not.toBe(2500);
  });

  it('币种齐全时正常求出合计', () => {
    const fx = makeFxSnapshot({ CNY: '7.1400', JPY: '157.20' }, '2024-03-20T00:00:00.000Z');
    const r = summarize([cnySub, jpySub], [cnyV, jpyV], fx, settings, '2024-03-20', { now });
    expect(r.missingCurrencies).toEqual([]);
    // 12000 日元 / 157.2 = 76.3359 USD，× 7.14 = ¥545.0382 -> 54504 分
    expect(r.monthlyAverageMinor).toBe(2500 + 54504);
  });

  it('缺汇率的币种出现在未来窗口里也要报出来', () => {
    const annualJpy = makeVersion({
      id: 'v-jpy-year',
      subscription_id: 's-jpy',
      effective_from: '2024-03-01',
      amount_minor: 12000,
      currency: 'JPY',
      cycle_type: 'year',
    });
    const r = summarize([jpySub], [annualJpy], fxOnlyCny, settings, '2024-03-20', { now });
    expect(r.missingCurrencies).toEqual(['JPY']);
    expect(r.monthlyAverageMinor).toBeNull();
    expect(r.yearlyAverageMinor).toBeNull();
    expect(r.next30DaysMinor).toBeNull();
  });

  it('汇率表为空时，纯基准币种的账本仍然算得出来（只是 stale）', () => {
    const r = summarize([cnySub], [cnyV], emptyFxSnapshot(), settings, '2024-03-20', { now });
    // 基准币种不需要汇率，convert(CNY -> CNY) 是同币种直通
    expect(r.missingCurrencies).toEqual([]);
    expect(r.monthlyAverageMinor).toBe(2500);
    expect(r.yearlyAverageMinor).toBe(30000);
    expect(r.stale).toBe(true); // 但「没有任何汇率数据」本身仍然是 stale
    expect(r.fxAsOf).toBeNull();
    expect(r.fxAgeHours).toBeNull();
  });

  it('外币订阅 + 没有汇率 -> stale 且合计为 null', () => {
    const r = summarize([jpySub], [jpyV], emptyFxSnapshot(), settings, '2024-03-20', { now });
    expect(r.stale).toBe(true);
    expect(r.missingCurrencies).toEqual(['JPY']);
    expect(r.monthlyAverageMinor).toBeNull();
  });
});

describe('summarize: stale 标记', () => {
  const sub = makeSubscription({ id: 's1', start_date: '2024-01-15', renew_mode: 'auto' });
  const v = makeVersion({ id: 'v1', subscription_id: 's1', effective_from: '2024-01-15' });

  it('汇率 49 小时没更新 -> stale = true', () => {
    const r = summarize([sub], [v], makeFxSnapshot(TEST_RATES, '2024-03-18T11:00:00.000Z'), settings, '2024-03-20', {
      now: new Date('2024-03-20T12:00:00.000Z'),
    });
    expect(r.stale).toBe(true);
    expect(r.fxAgeHours).toBeCloseTo(49, 6);
  });

  it('汇率 47 小时前更新 -> stale = false', () => {
    const r = summarize([sub], [v], makeFxSnapshot(TEST_RATES, '2024-03-18T13:00:00.000Z'), settings, '2024-03-20', {
      now: new Date('2024-03-20T12:00:00.000Z'),
    });
    expect(r.stale).toBe(false);
    expect(r.fxAgeHours).toBeCloseTo(47, 6);
  });
});

describe('summarize: ended 的订阅不计入金额', () => {
  const live = makeSubscription({ id: 's-live', start_date: '2024-01-15', renew_mode: 'auto' });
  const liveV = makeVersion({ id: 'v-live', subscription_id: 's-live', effective_from: '2024-01-15', amount_minor: 2500 });

  const dead = makeSubscription({
    id: 's-dead',
    start_date: '2024-01-15',
    renew_mode: 'auto',
    cancelled_at: '2024-02-01T00:00:00.000Z',
  });
  const deadV = makeVersion({ id: 'v-dead', subscription_id: 's-dead', effective_from: '2024-01-15', amount_minor: 9900 });

  const fx = makeFxSnapshot(TEST_RATES, '2024-03-20T00:00:00.000Z');

  it('计数分成 active/ended，金额只算 active', () => {
    const r = summarize([live, dead], [liveV, deadV], fx, settings, '2024-03-20', {
      now: new Date('2024-03-20T06:00:00.000Z'),
    });
    expect(r.counts).toEqual({ total: 2, active: 1, ended: 1, anomaly: 0 });
    expect(r.monthlyAverageMinor).toBe(2500); // 不含 9900
    expect(r.yearlyAverageMinor).toBe(30000);
  });
});

describe('summarize: 异常订阅仍然计入支出', () => {
  const sub = makeSubscription({ id: 's1', start_date: '2024-01-15', renew_mode: 'auto' });
  const v = makeVersion({ id: 'v1', subscription_id: 's1', effective_from: '2024-01-15', amount_minor: 2500 });
  const failed = makeCharge({
    subscription_id: 's1',
    charge_date: '2024-03-15',
    amount_minor: 2500,
    status: 'failed',
  });
  const fx = makeFxSnapshot(TEST_RATES, '2024-03-20T00:00:00.000Z');

  it('扣款失败 -> 计入 anomaly，但月均仍然统计', () => {
    const r = summarize([sub], [v], fx, settings, '2024-03-20', {
      now: new Date('2024-03-20T06:00:00.000Z'),
      charges: [failed],
    });
    expect(r.counts.anomaly).toBe(1);
    expect(r.counts.active).toBe(0);
    expect(r.anomalies[0]!.reasonCode).toBe('last_charge_failed');
    expect(r.monthlyAverageMinor).toBe(2500);
  });
});

describe('summarize: 边界', () => {
  it('没有任何订阅时全是 0 / 空', () => {
    const r = summarize([], [], makeFxSnapshot(TEST_RATES, '2024-03-20T00:00:00.000Z'), settings, '2024-03-20', {
      now: new Date('2024-03-20T06:00:00.000Z'),
    });
    expect(r.counts).toEqual({ total: 0, active: 0, ended: 0, anomaly: 0 });
    expect(r.monthlyAverageMinor).toBe(0);
    expect(r.yearlyAverageMinor).toBe(0);
    expect(r.next30DaysMinor).toBe(0);
    expect(r.anomalies).toEqual([]);
  });

  it('软删除的订阅完全不出现在汇总里', () => {
    const sub = makeSubscription({ id: 's1', deleted_at: '2024-03-01T00:00:00.000Z' });
    const v = makeVersion({ id: 'v1', subscription_id: 's1' });
    const r = summarize([sub], [v], makeFxSnapshot(TEST_RATES, '2024-03-20T00:00:00.000Z'), settings, '2024-03-20', {
      now: new Date('2024-03-20T06:00:00.000Z'),
    });
    expect(r.counts.total).toBe(0);
  });

  it('基准币种换成 USD 后，金额以美元最小单位表示', () => {
    const sub = makeSubscription({ id: 's1', start_date: '2024-01-15', renew_mode: 'auto' });
    const v = makeVersion({ id: 'v1', subscription_id: 's1', effective_from: '2024-01-15', amount_minor: 7140, currency: 'CNY' });
    const r = summarize([sub], [v], makeFxSnapshot(TEST_RATES, '2024-03-20T00:00:00.000Z'), makeSettings({ base_currency: 'USD' }), '2024-03-20', {
      now: new Date('2024-03-20T06:00:00.000Z'),
    });
    // ¥71.40 = $10.00 = 1000 美分
    expect(r.baseCurrency).toBe('USD');
    expect(r.monthlyAverageMinor).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// B1 定稿：未来 N 天的到期日同样以「转正日」为锚点
// ---------------------------------------------------------------------------

describe('B1: summarize 的到期窗口按转正日起算', () => {
  const sub = makeSubscription({
    id: 's-trial',
    name: 'Notion Plus',
    start_date: '2024-01-01',
    renew_mode: 'auto',
  });
  const trialV = makeVersion({
    id: 'v-trial',
    subscription_id: 's-trial',
    effective_from: '2024-01-01',
    amount_minor: 0,
    currency: 'CNY',
    cycle_type: 'month',
    is_trial: 1,
    trial_end_date: '2024-01-14',
    after_trial_amount_minor: 9900,
    after_trial_currency: 'CNY',
    after_trial_cycle_type: 'month',
  });
  const converted = makeVersion({
    id: 'v-converted',
    subscription_id: 's-trial',
    effective_from: '2024-01-14',
    amount_minor: 9900,
    currency: 'CNY',
    cycle_type: 'month',
  });
  const fx = makeFxSnapshot(TEST_RATES, '2024-03-13T00:00:00.000Z');
  const now = new Date('2024-03-13T06:00:00.000Z');

  it('1/14 转正 -> 窗口 (03-13, 03-14] 里命中的是 03-14，而不是 04-01', () => {
    const r = summarize([sub], [trialV, converted], fx, settings, '2024-03-13', {
      now,
      windowDays: 1,
    });
    // 旧锚点（start_date = 01-01）下这一期是 04-01，会落到窗口外 -> 0
    expect(r.next30DaysMinor).toBe(9900);
  });

  it('转正版本还没落库时，用投影也能得到同一个窗口结果', () => {
    const withProjection = summarize([sub], [trialV], fx, settings, '2024-03-13', {
      now,
      windowDays: 1,
    });
    const withReal = summarize([sub], [trialV, converted], fx, settings, '2024-03-13', {
      now,
      windowDays: 1,
    });
    expect(withProjection.next30DaysMinor).toBe(withReal.next30DaysMinor);
    expect(withProjection.next30DaysMinor).toBe(9900);
  });

  it('年付转正：窗口命中的是转正日周年 01-14，不是 01-01', () => {
    const yearlyTrial = makeVersion({
      id: 'v-t',
      subscription_id: 's-trial',
      effective_from: '2024-01-01',
      amount_minor: 0,
      currency: 'CNY',
      cycle_type: 'month',
      is_trial: 1,
      trial_end_date: '2024-01-14',
      after_trial_amount_minor: 99000,
      after_trial_currency: 'CNY',
      after_trial_cycle_type: 'year',
    });
    const yearlyConverted = makeVersion({
      id: 'v-c',
      subscription_id: 's-trial',
      effective_from: '2024-01-14',
      amount_minor: 99000,
      currency: 'CNY',
      cycle_type: 'year',
    });
    const r = summarize([sub], [yearlyTrial, yearlyConverted], fx, settings, '2025-01-10', {
      now: new Date('2025-01-10T06:00:00.000Z'),
      windowDays: 10,
    });
    // 窗口 (2025-01-10, 2025-01-20]：命中 2025-01-14（转正周年）
    expect(r.next30DaysMinor).toBe(99000);
  });
});
