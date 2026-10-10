/**
 * /api/summary 与 /api/trends 的集成测试。
 *
 * 这两个接口本身不含业务算法（算法都在 packages/core），
 * 所以这里重点验证「Worker 装配出来的数据 + 参数校验 + 口径一致性」。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CAT_MEDIA,
  CLOCK,
  SUB_MANUAL_OVERDUE,
  SUB_MONTHLY,
  TODAY,
  call,
  callJson,
  makeEnv,
  restoreClock,
  scenarioDb,
  useFixedClock,
} from './helpers/scenario.js';
import type { FakeD1 } from './helpers/d1.js';

interface SummaryDto {
  baseCurrency: string;
  timezone: string;
  today: string;
  counts: { total: number; active: number; ended: number; anomaly: number };
  byStatus: Record<string, { subscriptionId: string; reasonCode: string }[]>;
  monthlyAverageMinor: number | null;
  yearlyAverageMinor: number | null;
  next30DaysMinor: number | null;
  stale: boolean;
  fxAsOf: string | null;
  fxAgeHours: number | null;
  missingCurrencies: string[];
  anomalies: { subscriptionId: string; reasonCode: string }[];
  window_days: number;
}

interface TrendDto {
  dimension: string;
  baseCurrency: string;
  from: string;
  to: string;
  months: string[];
  groups: { key: string; label: string }[];
  cells: { month: string; group: string; amountBaseMinor: number | null; chargeCount: number }[];
  totalsByMonth: { month: string; amountBaseMinor: number | null }[];
  grandTotalMinor: number | null;
  missingCurrencies: string[];
  excluded: { failed: number; refunded: number; orphan: number };
}

describe('/api/summary', () => {
  let db: FakeD1;

  beforeEach(() => {
    useFixedClock();
    db = scenarioDb();
  });

  afterEach(() => {
    db.close();
    restoreClock();
  });

  it('汇总各类数字与汇率健康度', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ item: SummaryDto }>(env, 'GET', '/api/summary');
    const item = body.item;

    expect(item.baseCurrency).toBe('CNY');
    expect(item.timezone).toBe('Asia/Shanghai');
    expect(item.today).toBe(TODAY);
    expect(item.window_days).toBe(30);

    // active 6 / ended 1 / anomaly 1（已取消的是 ended，手动续费过期的是 anomaly）
    expect(item.counts).toEqual({ total: 8, active: 6, ended: 1, anomaly: 1 });
    expect(item.byStatus['anomaly']?.map((a) => a.subscriptionId)).toEqual([SUB_MANUAL_OVERDUE]);
    expect(item.anomalies[0]?.reasonCode).toBe('manual_renew_overdue');

    // 月均：Netflix 16369 + iCloud 6800 + 两个试用转正价 9900/5000
    //      + 终身摊销 214800/36=5967 + Spotify 3000 + 得到 2500 = 49536
    expect(item.monthlyAverageMinor).toBe(49536);
    // 年均 = 594427（直接用周期算，不经「月均 × 12」二次舍入）
    expect(item.yearlyAverageMinor).toBe(594427);
    // 未来 30 天（今天之后，不含今天）：Netflix 16369 + iCloud 81600 + Figma 5000 + 得到 2500
    expect(item.next30DaysMinor).toBe(105469);

    // 汇率是今天 01:00 抓的，1 小时前 -> 不算过期
    expect(item.fxAsOf).toBe(`${TODAY}T01:00:00.000Z`);
    expect(item.fxAgeHours).toBe(1);
    expect(item.stale).toBe(false);
    expect(item.missingCurrencies).toEqual([]);
  });

  it('可以自定义未来窗口天数', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ item: SummaryDto }>(env, 'GET', '/api/summary?window_days=90');
    expect(body.item.window_days).toBe(90);
    // 窗口拉到 90 天（到 2027-01-08）后，会多算进这些：
    //   Netflix 12/1 + 1/1        = 16369 * 2
    //   Notion 转正 11/10 + 12/10 = 9900 * 2
    //   Figma 11/14 + 12/14       = 5000 * 2
    //   Spotify 11/10 + 12/10     = 3000 * 2
    //   得到 12/1 + 1/1           = 2500 * 2
    expect(body.item.next30DaysMinor).toBe(105469 + 32738 + 19800 + 10000 + 6000 + 5000);
  });

  it('最新汇率的 fetched_at 超过 48 小时 -> stale = true', async () => {
    const env = makeEnv(db);
    // 把今天这批快照的「真实抓取时刻」改成 3 天前（date 不变，所以它仍是被选中的最新快照）
    const staleAt = new Date(CLOCK.getTime() - 72 * 3600 * 1000).toISOString();
    await env.DB.prepare(`UPDATE fx_rates SET fetched_at = ? WHERE date = ?`)
      .bind(staleAt, TODAY)
      .run();

    const body = await callJson<{ item: SummaryDto }>(env, 'GET', '/api/summary');
    expect(body.item.stale).toBe(true);
    expect(body.item.fxAsOf).toBe(staleAt);
    expect(body.item.fxAgeHours).toBe(72);
  });

  it('非法 window_days -> 400', async () => {
    const env = makeEnv(db);
    expect((await call(env, 'GET', '/api/summary?window_days=0')).status).toBe(400);
    expect((await call(env, 'GET', '/api/summary?window_days=abc')).status).toBe(400);
  });
});

describe('/api/trends', () => {
  let db: FakeD1;

  beforeEach(() => {
    useFixedClock();
    db = scenarioDb();
  });

  afterEach(() => {
    db.close();
    restoreClock();
  });

  it('默认按月 + 按分类，最近 12 个月，使用冻结汇率', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ item: TrendDto }>(env, 'GET', '/api/trends');
    const t = body.item;

    expect(t.dimension).toBe('category');
    expect(t.baseCurrency).toBe('CNY');
    expect(t.months).toHaveLength(12);
    expect(t.to).toBe(TODAY.slice(0, 7));
    expect(t.from).toBe('2025-11');

    expect(t.groups).toEqual([{ key: CAT_MEDIA, label: '影音娱乐' }]);
    expect(t.grandTotalMinor).toBe(65338);
    expect(t.totalsByMonth.map((m) => m.amountBaseMinor)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, // 2025-11 ~ 2026-06
      16208, 16323, 16438, 16369, // 2026-07 ~ 2026-10（冻结值各不相同）
    ]);
    expect(t.missingCurrencies).toEqual([]);
    expect(t.excluded).toEqual({ failed: 0, refunded: 0, orphan: 0 });
  });

  it('支持 category / cycle / channel / type 四种分组', async () => {
    const env = makeEnv(db);

    const cycle = await callJson<{ item: TrendDto }>(env, 'GET', '/api/trends?group=cycle');
    expect(cycle.item.groups.map((g) => g.label)).toEqual(['月付']);

    const channel = await callJson<{ item: TrendDto }>(env, 'GET', '/api/trends?group=channel');
    expect(channel.item.groups.map((g) => g.label)).toEqual(['银行卡']);

    const type = await callJson<{ item: TrendDto }>(env, 'GET', '/api/trends?group=type');
    expect(type.item.groups.map((g) => g.label)).toEqual(['影音娱乐']);
  });

  it('缺汇率的月份合计为 null，并列出缺失币种（不静默少算）', async () => {
    const env = makeEnv(db);
    await callJson(
      env,
      'POST',
      '/api/charges',
      { subscription_id: SUB_MONTHLY, charge_date: TODAY, amount_minor: 1000, currency: 'GBP' },
      201,
    );

    const body = await callJson<{ item: TrendDto }>(env, 'GET', '/api/trends');
    expect(body.item.missingCurrencies).toEqual(['GBP']);
    expect(body.item.grandTotalMinor).toBeNull();
    // 2026-10 这一格算不出来
    const october = body.item.totalsByMonth.at(-1);
    expect(october?.month).toBe(TODAY.slice(0, 7));
    expect(october?.amountBaseMinor).toBeNull();
    // 其余月份不受影响
    expect(body.item.totalsByMonth.at(-2)?.amountBaseMinor).toBe(16438);
  });

  it('refunded 计负数、failed 完全排除', async () => {
    const env = makeEnv(db);
    await callJson(
      env,
      'POST',
      '/api/charges',
      { subscription_id: SUB_MONTHLY, charge_date: `${TODAY.slice(0, 7)}-05`, amount_minor: 100000, currency: 'CNY', status: 'refunded' },
      201,
    );
    await callJson(
      env,
      'POST',
      '/api/charges',
      { subscription_id: SUB_MONTHLY, charge_date: `${TODAY.slice(0, 7)}-06`, amount_minor: 500000, currency: 'CNY', status: 'failed' },
      201,
    );

    const body = await callJson<{ item: TrendDto }>(env, 'GET', '/api/trends');
    expect(body.item.excluded.refunded).toBe(1);
    expect(body.item.excluded.failed).toBe(1);
    // 10 月：16369（Netflix 冻结）+ 3000（Spotify? 不，Spotify 没有扣款）
    // 实际只有 Netflix 的 16369 与退款 -100000
    expect(body.item.totalsByMonth.at(-1)?.amountBaseMinor).toBe(16369 - 100000);
  });

  it('可以指定区间，且区间外的扣款不计入', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ item: TrendDto }>(
      env,
      'GET',
      '/api/trends?from=2026-09&to=2026-10&group=channel',
    );
    expect(body.item.months).toEqual(['2026-09', '2026-10']);
    expect(body.item.grandTotalMinor).toBe(16438 + 16369);
  });

  it('参数非法 -> 400', async () => {
    const env = makeEnv(db);
    expect((await call(env, 'GET', '/api/trends?group=bogus')).status).toBe(400);
    expect((await call(env, 'GET', '/api/trends?from=2026-13')).status).toBe(400);
    expect((await call(env, 'GET', '/api/trends?from=2026-10&to=2026-01')).status).toBe(400);
    expect((await call(env, 'GET', '/api/trends?from=1900-01&to=2026-10')).status).toBe(400);
  });

  it('空区间也有完整的月份骨架（值为 0）', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ item: TrendDto }>(env, 'GET', '/api/trends?from=2020-01&to=2020-03');
    expect(body.item.months).toEqual(['2020-01', '2020-02', '2020-03']);
    expect(body.item.groups).toEqual([]);
    expect(body.item.totalsByMonth.map((m) => m.amountBaseMinor)).toEqual([0, 0, 0]);
    expect(body.item.grandTotalMinor).toBe(0);
  });
});
