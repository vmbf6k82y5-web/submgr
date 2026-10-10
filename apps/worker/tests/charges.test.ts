/**
 * /api/charges 的集成测试：手动录入、汇率冻结、缺汇率告警、改状态、软删除。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CAT_MEDIA,
  D,
  SUB_MONTHLY,
  TODAY,
  V_MONTHLY,
  call,
  callJson,
  makeEnv,
  queryOne,
  restoreClock,
  scenarioDb,
  useFixedClock,
} from './helpers/scenario.js';
import type { FakeD1 } from './helpers/d1.js';

interface ChargeDto {
  id: string;
  subscription_id: string;
  charge_date: string;
  amount_minor: number;
  currency: string;
  fx_rate_to_base: string | null;
  base_currency: string | null;
  base_amount_minor: number | null;
  source: string;
  status: string;
}

describe('/api/charges', () => {
  let db: FakeD1;

  beforeEach(() => {
    useFixedClock();
    db = scenarioDb();
  });

  afterEach(() => {
    db.close();
    restoreClock();
  });

  it('列表按日期倒序，并带上订阅名', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ items: (ChargeDto & { subscription_name: string })[]; total: number }>(
      env,
      'GET',
      '/api/charges',
    );
    expect(body.total).toBe(5);
    expect(body.items[0]?.charge_date).toBe('2026-10-01');
    expect(body.items[0]?.subscription_name).toBe('Netflix 高级会员');
  });

  it('列表支持按订阅、日期区间、状态过滤', async () => {
    const env = makeEnv(db);
    const bySub = await callJson<{ items: ChargeDto[] }>(
      env,
      'GET',
      `/api/charges?subscription_id=${SUB_MONTHLY}`,
    );
    expect(bySub.items).toHaveLength(4);

    const byRange = await callJson<{ items: ChargeDto[] }>(
      env,
      'GET',
      `/api/charges?from=2026-10-01&to=2026-10-31`,
    );
    expect(byRange.items).toHaveLength(1);

    const byStatus = await callJson<{ items: ChargeDto[] }>(env, 'GET', '/api/charges?status=failed');
    expect(byStatus.items).toHaveLength(0);

    const bySource = await callJson<{ items: ChargeDto[] }>(env, 'GET', '/api/charges?source=manual');
    expect(bySource.items).toHaveLength(1);
  });

  it('手动录入外币扣款时按扣款当天的汇率冻结（不是最新汇率）', async () => {
    const env = makeEnv(db);
    // D(-1) 的 USD->CNY 是 7.0500；今天的才是 7.1200
    const body = await callJson<{ item: ChargeDto; fx_warning: string | null }>(
      env,
      'POST',
      '/api/charges',
      {
        subscription_id: SUB_MONTHLY,
        version_id: V_MONTHLY,
        charge_date: D(-1),
        amount_minor: 2299,
        currency: 'USD',
      },
      201,
    );

    expect(body.fx_warning).toBeNull();
    expect(body.item.source).toBe('manual');
    expect(body.item.fx_rate_to_base).toBe('7.05');
    expect(body.item.base_currency).toBe('CNY');
    // 2299 * 7.05 = 16207.95 -> 16208
    expect(body.item.base_amount_minor).toBe(16208);
  });

  it('基准币种直接记 1:1，不需要汇率', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ item: ChargeDto; fx_warning: string | null }>(
      env,
      'POST',
      '/api/charges',
      {
        subscription_id: SUB_MONTHLY,
        charge_date: D(-2),
        amount_minor: 8800,
        currency: 'CNY',
      },
      201,
    );
    expect(body.item.fx_rate_to_base).toBe('1');
    expect(body.item.base_amount_minor).toBe(8800);
    expect(body.fx_warning).toBeNull();
  });

  it('缺汇率的币种：写入成功但基准金额留空，并给出 fx_warning（不伪造 0）', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ item: ChargeDto; fx_warning: string | null }>(
      env,
      'POST',
      '/api/charges',
      {
        subscription_id: SUB_MONTHLY,
        charge_date: D(-1),
        amount_minor: 1000,
        currency: 'GBP', // 场景里没有 GBP 汇率
      },
      201,
    );
    expect(body.item.fx_rate_to_base).toBeNull();
    expect(body.item.base_currency).toBeNull();
    expect(body.item.base_amount_minor).toBeNull();
    expect(body.fx_warning).toContain('GBP');
  });

  it('status 可以显式给 failed / refunded', async () => {
    const env = makeEnv(db);
    const failed = await callJson<{ item: ChargeDto }>(
      env,
      'POST',
      '/api/charges',
      {
        subscription_id: SUB_MONTHLY,
        charge_date: D(-3),
        amount_minor: 2299,
        currency: 'USD',
        status: 'failed',
      },
      201,
    );
    expect(failed.item.status).toBe('failed');
  });

  it('非法输入 -> 400（不存在的订阅 / 版本不属于该订阅 / 非法币种 / 负金额）', async () => {
    const env = makeEnv(db);
    const bad = [
      { subscription_id: 'nope', charge_date: TODAY, amount_minor: 1, currency: 'CNY' },
      { subscription_id: SUB_MONTHLY, charge_date: TODAY, amount_minor: 1, currency: 'CNY', version_id: 'nope' },
      { subscription_id: SUB_MONTHLY, charge_date: TODAY, amount_minor: 1, currency: 'RMB!' },
      { subscription_id: SUB_MONTHLY, charge_date: TODAY, amount_minor: -1, currency: 'CNY' },
      { subscription_id: SUB_MONTHLY, charge_date: '2026-02-30', amount_minor: 1, currency: 'CNY' },
      { subscription_id: SUB_MONTHLY, charge_date: TODAY, amount_minor: 1, currency: 'CNY', status: 'paid_ish' },
    ];
    for (const payload of bad) {
      const res = await call(env, 'POST', '/api/charges', payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
  });

  it('PATCH 改金额时会按扣款日重新冻结汇率', async () => {
    const env = makeEnv(db);
    const created = await callJson<{ item: ChargeDto }>(
      env,
      'POST',
      '/api/charges',
      { subscription_id: SUB_MONTHLY, charge_date: D(-1), amount_minor: 1000, currency: 'USD' },
      201,
    );
    expect(created.item.base_amount_minor).toBe(7050);

    const patched = await callJson<{ item: ChargeDto }>(env, 'PATCH', `/api/charges/${created.item.id}`, {
      amount_minor: 2000,
      status: 'refunded',
    });
    expect(patched.item.amount_minor).toBe(2000);
    expect(patched.item.status).toBe('refunded');
    // 2000 * 7.05 = 14100
    expect(patched.item.base_amount_minor).toBe(14100);
  });

  it('PATCH 改扣款日会换成新日期的汇率', async () => {
    const env = makeEnv(db);
    const created = await callJson<{ item: ChargeDto }>(
      env,
      'POST',
      '/api/charges',
      { subscription_id: SUB_MONTHLY, charge_date: D(-1), amount_minor: 1000, currency: 'USD' },
      201,
    );
    expect(created.item.fx_rate_to_base).toBe('7.05');

    const patched = await callJson<{ item: ChargeDto }>(env, 'PATCH', `/api/charges/${created.item.id}`, {
      charge_date: TODAY,
    });
    expect(patched.item.fx_rate_to_base).toBe('7.12');
  });

  it('DELETE 是软删除，列表里不再出现', async () => {
    const env = makeEnv(db);
    const id = '66666666-6666-4666-8666-000000000001';
    await callJson(env, 'DELETE', `/api/charges/${id}`);
    const row = queryOne<{ deleted_at: string | null }>(db, 'SELECT deleted_at FROM charges WHERE id = ?', id);
    expect(row?.deleted_at).not.toBeNull();

    const list = await callJson<{ items: ChargeDto[] }>(env, 'GET', '/api/charges');
    expect(list.items.find((c) => c.id === id)).toBeUndefined();
  });

  it('PATCH version_id 不能指向尚未生效的未来版本（以改完后的扣款日为准）', async () => {
    const env = makeEnv(db);
    const created = await callJson<{ item: ChargeDto }>(
      env,
      'POST',
      '/api/charges',
      { subscription_id: SUB_MONTHLY, charge_date: D(-1), amount_minor: 1000, currency: 'CNY' },
      201,
    );

    // 给同一订阅建一个「明天生效」的未来版本
    const future = await callJson<{ item: { id: string } }>(
      env,
      'POST',
      `/api/subscriptions/${SUB_MONTHLY}/versions`,
      { effective_from: D(1), amount_minor: 4200, currency: 'CNY', cycle_type: 'month' },
      201,
    );

    // 直接挂到未来版本 -> 400（版本生效日晚于扣款日）
    const bad = await call(env, 'PATCH', `/api/charges/${created.item.id}`, {
      version_id: future.item.id,
    });
    expect(bad.status).toBe(400);

    // 同一次 PATCH 把扣款日也改到生效日之后 -> 允许
    const ok = await callJson<{ item: ChargeDto }>(env, 'PATCH', `/api/charges/${created.item.id}`, {
      version_id: future.item.id,
      charge_date: D(2),
    });
    expect(ok.item.charge_date).toBe(D(2));
  });

  it('PATCH / DELETE 不存在的记录 -> 404', async () => {
    const env = makeEnv(db);
    expect((await call(env, 'PATCH', '/api/charges/nope', { status: 'paid' })).status).toBe(404);
    expect((await call(env, 'DELETE', '/api/charges/nope')).status).toBe(404);
  });

  it('接口不允许把 source 写成 auto（自动扣款只由 Cron 生成）', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ item: ChargeDto }>(
      env,
      'POST',
      '/api/charges',
      {
        subscription_id: SUB_MONTHLY,
        charge_date: D(-4),
        amount_minor: 100,
        currency: 'CNY',
        source: 'auto',
      },
      201,
    );
    expect(body.item.source).toBe('manual');
  });

  it('分类被删除后不影响扣款查询（趋势里会归到未分类）', async () => {
    const env = makeEnv(db);
    await callJson(env, 'DELETE', `/api/categories/${CAT_MEDIA}`);
    const list = await callJson<{ items: ChargeDto[] }>(env, 'GET', '/api/charges');
    expect(list.items.length).toBe(5);
  });
});
