/**
 * /api/subscriptions 与 /api/subscriptions/:id/versions 的集成测试。
 *
 * 跑的是真实 Hono app + 真实 SQLite（真 migration），所以能顺带验证
 * 数据库层的 CHECK / 部分唯一索引 / 触发器确实被触发。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  CAT_CLOUD,
  CH_FEISHU,
  D,
  M,
  SUB_ANNUAL,
  SUB_CANCELLED,
  SUB_MANUAL_OVERDUE,
  SUB_MONTHLY,
  SUB_TRIAL_TODAY,
  V_MONTHLY,
  call,
  callJson,
  makeEnv,
  queryAll,
  queryOne,
  restoreClock,
  scenarioDb,
  useFixedClock,
} from './helpers/scenario.js';
import type { FakeD1 } from './helpers/d1.js';

interface SubscriptionDto {
  id: string;
  name: string;
  status: string;
  reason_code: string;
  next_due_date: string | null;
  charge_channel_label: string;
  sub_type_label: string;
  monthly_amount_minor: number | null;
  category_name: string | null;
  current_version_id: string | null;
}

describe('/api/subscriptions', () => {
  let db: FakeD1;

  beforeEach(() => {
    useFixedClock();
    db = scenarioDb();
  });

  afterEach(() => {
    db.close();
    restoreClock();
  });

  // -------------------------------------------------------------------------
  // 鉴权
  // -------------------------------------------------------------------------

  describe('鉴权', () => {
    it('没有 Authorization 头 -> 401', async () => {
      const env = makeEnv(db);
      const res = await call(env, 'GET', '/api/subscriptions', undefined, { token: null });
      expect(res.status).toBe(401);
    });

    it('令牌不对 -> 401（不区分「没带」与「不对」）', async () => {
      const env = makeEnv(db);
      const res = await call(env, 'GET', '/api/subscriptions', undefined, { token: 'wrong-token' });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    });

    it('非 Bearer 形式的头 -> 401', async () => {
      const env = makeEnv(db);
      const res = await call(env, 'GET', '/api/subscriptions', undefined, {
        token: null,
        headers: { Authorization: ADMIN_TOKEN },
      });
      expect(res.status).toBe(401);
    });

    it('ADMIN_TOKEN 未配置 -> 500（fail closed，不是放开）', async () => {
      const env = makeEnv(db, { ADMIN_TOKEN: undefined });
      const res = await call(env, 'GET', '/api/subscriptions', undefined, { token: null });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('server_misconfigured');
    });

    it('令牌正确 -> 200', async () => {
      const env = makeEnv(db);
      const res = await call(env, 'GET', '/api/subscriptions');
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // 列表与状态
  // -------------------------------------------------------------------------

  it('列表返回状态、中文标签、当前版本与月均', async () => {
    const env = makeEnv(db);
    const body = await callJson<{
      items: SubscriptionDto[];
      counts: Record<string, number>;
      today: string;
      base_currency: string;
    }>(env, 'GET', '/api/subscriptions');

    expect(body.base_currency).toBe('CNY');
    expect(body.items).toHaveLength(8);

    const netflix = body.items.find((i) => i.id === SUB_MONTHLY) as SubscriptionDto;
    expect(netflix.status).toBe('active');
    expect(netflix.reason_code).toBe('ok');
    expect(netflix.charge_channel_label).toBe('银行卡');
    expect(netflix.sub_type_label).toBe('影音娱乐');
    expect(netflix.category_name).toBe('影音娱乐');
    // 2299 分 USD -> 月均 = 2299 分 USD -> CNY 7.12 = 16369
    expect(netflix.monthly_amount_minor).toBe(16369);
    // 下次到期日是下个月 1 号
    expect(netflix.next_due_date).toBe(M(1));

    // 状态分类计数：active 6 / ended 1 / anomaly 1
    expect(body.counts).toEqual({ total: 8, active: 6, ended: 1, anomaly: 1 });

    const cancelled = body.items.find((i) => i.id === SUB_CANCELLED) as SubscriptionDto;
    expect(cancelled.status).toBe('ended');
    expect(cancelled.reason_code).toBe('cancelled');

    const overdue = body.items.find((i) => i.id === SUB_MANUAL_OVERDUE) as SubscriptionDto;
    expect(overdue.status).toBe('anomaly');
    expect(overdue.reason_code).toBe('manual_renew_overdue');

    const trial = body.items.find((i) => i.id === SUB_TRIAL_TODAY) as SubscriptionDto;
    expect(trial.status).toBe('active');
    expect(trial.reason_code).toBe('trial_active');
    // B1：试用进行中时「下次到期日」= 转正日
    expect(trial.next_due_date).toBe(D(0));
  });

  it('试用转正后的月均按转正价算（不跳变）', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ items: SubscriptionDto[] }>(env, 'GET', '/api/subscriptions');
    const trial = body.items.find((i) => i.id === SUB_TRIAL_TODAY) as SubscriptionDto;
    // after_trial 9900 分 CNY，月付 -> 月均就是 9900
    expect(trial.monthly_amount_minor).toBe(9900);
  });

  it('status 过滤只返回对应状态', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ items: SubscriptionDto[] }>(env, 'GET', '/api/subscriptions?status=anomaly');
    expect(body.items.map((i) => i.id)).toEqual([SUB_MANUAL_OVERDUE]);
  });

  it('非法 status -> 400', async () => {
    const env = makeEnv(db);
    const res = await call(env, 'GET', '/api/subscriptions?status=bogus');
    expect(res.status).toBe(400);
  });

  it('q 搜索按名称过滤', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ items: SubscriptionDto[] }>(env, 'GET', '/api/subscriptions?q=netflix');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(SUB_MONTHLY);
  });

  it('详情返回版本与扣款', async () => {
    const env = makeEnv(db);
    const body = await callJson<{
      item: SubscriptionDto;
      versions: unknown[];
      charges: unknown[];
    }>(env, 'GET', `/api/subscriptions/${SUB_MONTHLY}`);
    expect(body.versions).toHaveLength(1);
    expect(body.charges).toHaveLength(4);
  });

  it('不存在的订阅 -> 404', async () => {
    const env = makeEnv(db);
    const res = await call(env, 'GET', '/api/subscriptions/does-not-exist');
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // 新建 / 修改 / 删除
  // -------------------------------------------------------------------------

  it('新建订阅可以顺带带首个版本', async () => {
    const env = makeEnv(db);
    const created = await callJson<{ item: SubscriptionDto; created_version_id: string }>(
      env,
      'POST',
      '/api/subscriptions',
      {
        name: '测试订阅',
        sub_type: 'software',
        charge_channel: 'alipay',
        renew_mode: 'auto',
        start_date: D(-30),
        category_id: CAT_CLOUD,
        note: '备注',
        version: {
          effective_from: D(-30),
          amount_minor: 1500,
          currency: 'CNY',
          cycle_type: 'month',
          plan_name: '基础版',
        },
      },
      201,
    );
    expect(created.item.name).toBe('测试订阅');
    expect(created.created_version_id).toBeTruthy();

    const versions = queryAll<{ id: string; amount_minor: number }>(
      db,
      'SELECT id, amount_minor FROM subscription_versions WHERE subscription_id = ?',
      created.item.id,
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.amount_minor).toBe(1500);
  });

  it('新建订阅的枚举/日期非法 -> 400 且不写库', async () => {
    const env = makeEnv(db);
    const before = queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM subscriptions')?.c;

    const cases = [
      { sub_type: 'bogus', charge_channel: 'alipay', renew_mode: 'auto', start_date: D(0) },
      { sub_type: 'software', charge_channel: 'bogus', renew_mode: 'auto', start_date: D(0) },
      { sub_type: 'software', charge_channel: 'alipay', renew_mode: 'bogus', start_date: D(0) },
      { sub_type: 'software', charge_channel: 'alipay', renew_mode: 'auto', start_date: '2026-02-30' },
    ];
    for (const payload of cases) {
      const res = await call(env, 'POST', '/api/subscriptions', { name: 'x', ...payload });
      expect(res.status).toBe(400);
    }

    const after = queryOne<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM subscriptions')?.c;
    expect(after).toBe(before);
  });

  it('end_date 早于 start_date -> 400', async () => {
    const env = makeEnv(db);
    const res = await call(env, 'POST', '/api/subscriptions', {
      name: 'x',
      sub_type: 'software',
      charge_channel: 'alipay',
      renew_mode: 'auto',
      start_date: D(0),
      end_date: D(-1),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH 修改可编辑字段', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ item: SubscriptionDto }>(env, 'PATCH', `/api/subscriptions/${SUB_ANNUAL}`, {
      name: 'iCloud+ 2TB（改过名）',
      category_id: null,
      note: null,
    });
    expect(body.item.name).toBe('iCloud+ 2TB（改过名）');
    expect(body.item.category_name).toBeNull();
  });

  it('PATCH 空 body -> 400', async () => {
    const env = makeEnv(db);
    const res = await call(env, 'PATCH', `/api/subscriptions/${SUB_ANNUAL}`, {});
    expect(res.status).toBe(400);
  });

  it('DELETE 是软删除，并级联软删版本与提醒规则', async () => {
    const env = makeEnv(db);
    const env2 = env;
    // 先给这个订阅挂一条提醒规则，验证级联
    await callJson(
      env2,
      'POST',
      '/api/reminders',
      { rule_type: 'due', days_before: 1, at_time: '09:00', subscription_id: SUB_ANNUAL, channel_id: CH_FEISHU },
      201,
    );
    await callJson(env2, 'DELETE', `/api/subscriptions/${SUB_ANNUAL}`);

    const sub = queryOne<{ deleted_at: string | null }>(
      db,
      'SELECT deleted_at FROM subscriptions WHERE id = ?',
      SUB_ANNUAL,
    );
    expect(sub?.deleted_at).not.toBeNull();

    const versions = queryAll<{ deleted_at: string | null }>(
      db,
      'SELECT deleted_at FROM subscription_versions WHERE subscription_id = ?',
      SUB_ANNUAL,
    );
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(v.deleted_at).not.toBeNull();

    const rules = queryAll<{ deleted_at: string | null }>(
      db,
      'SELECT deleted_at FROM reminder_rules WHERE subscription_id = ?',
      SUB_ANNUAL,
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r.deleted_at).not.toBeNull();

    const list = await callJson<{ items: SubscriptionDto[] }>(env2, 'GET', '/api/subscriptions');
    expect(list.items.find((i) => i.id === SUB_ANNUAL)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 价格版本：只许新增 / 已生效冻结
  // -------------------------------------------------------------------------

  describe('价格版本', () => {
    it('已生效版本 frozen = true', async () => {
      const env = makeEnv(db);
      const body = await callJson<{ items: { id: string; frozen: boolean }[] }>(
        env,
        'GET',
        `/api/subscriptions/${SUB_MONTHLY}/versions`,
      );
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.frozen).toBe(true);
    });

    it('新增未来版本成功', async () => {
      const env = makeEnv(db);
      const body = await callJson<{ item: { id: string; effective_from: string } }>(
        env,
        'POST',
        `/api/subscriptions/${SUB_MONTHLY}/versions`,
        { effective_from: D(30), amount_minor: 2599, currency: 'USD', cycle_type: 'month', plan_name: '涨价后' },
        201,
      );
      expect(body.item.effective_from).toBe(D(30));
      expect(queryAll(db, 'SELECT id FROM subscription_versions WHERE subscription_id = ?', SUB_MONTHLY)).toHaveLength(2);
    });

    it('同订阅同一天只能有一个版本 -> 409', async () => {
      const env = makeEnv(db);
      const res = await call(env, 'POST', `/api/subscriptions/${SUB_MONTHLY}/versions`, {
        effective_from: M(-3), // 与现有版本同一天
        amount_minor: 1,
        currency: 'USD',
        cycle_type: 'month',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('duplicate_effective_from');
    });

    it('已生效版本只允许改 plan_name', async () => {
      const env = makeEnv(db);

      const okRes = await callJson<{ item: { plan_name: string } }>(
        env,
        'PATCH',
        `/api/subscriptions/${SUB_MONTHLY}/versions/${V_MONTHLY}`,
        { plan_name: 'Premium 4K（改名）' },
      );
      expect(okRes.item.plan_name).toBe('Premium 4K（改名）');

      const badRes = await call(env, 'PATCH', `/api/subscriptions/${SUB_MONTHLY}/versions/${V_MONTHLY}`, {
        amount_minor: 9999,
      });
      expect(badRes.status).toBe(409);
      const badBody = (await badRes.json()) as { error: { code: string; message: string } };
      expect(badBody.error.code).toBe('version_frozen');
      expect(badBody.error.message).toContain('生效');

      // 金额没有被改动（触发器 + 接口双层保护）
      const row = queryOne<{ amount_minor: number; plan_name: string }>(
        db,
        'SELECT amount_minor, plan_name FROM subscription_versions WHERE id = ?',
        V_MONTHLY,
      );
      expect(row?.amount_minor).toBe(2299);
      expect(row?.plan_name).toBe('Premium 4K（改名）');
    });

    it('未生效版本可以随便改', async () => {
      const env = makeEnv(db);
      const created = await callJson<{ item: { id: string } }>(
        env,
        'POST',
        `/api/subscriptions/${SUB_MONTHLY}/versions`,
        { effective_from: D(60), amount_minor: 1000, currency: 'USD', cycle_type: 'month' },
        201,
      );
      const patched = await callJson<{ item: { amount_minor: number; cycle_type: string } }>(
        env,
        'PATCH',
        `/api/subscriptions/${SUB_MONTHLY}/versions/${created.item.id}`,
        { amount_minor: 2000, cycle_type: 'quarter' },
      );
      expect(patched.item.amount_minor).toBe(2000);
      expect(patched.item.cycle_type).toBe('quarter');
    });

    it('已生效版本不能删除 -> 409，未生效版本可以删除', async () => {
      const env = makeEnv(db);
      const frozenRes = await call(
        env,
        'DELETE',
        `/api/subscriptions/${SUB_MONTHLY}/versions/${V_MONTHLY}`,
      );
      expect(frozenRes.status).toBe(409);

      const created = await callJson<{ item: { id: string } }>(
        env,
        'POST',
        `/api/subscriptions/${SUB_MONTHLY}/versions`,
        { effective_from: D(90), amount_minor: 100, currency: 'USD', cycle_type: 'month' },
        201,
      );
      await callJson(env, 'DELETE', `/api/subscriptions/${SUB_MONTHLY}/versions/${created.item.id}`);
      const row = queryOne<{ deleted_at: string | null }>(
        db,
        'SELECT deleted_at FROM subscription_versions WHERE id = ?',
        created.item.id,
      );
      expect(row?.deleted_at).not.toBeNull();
    });

    it('版本形状非法 -> 400（days 缺 cycle_days / 试用缺 trial_end_date / 转正价不成对）', async () => {
      const env = makeEnv(db);
      const base = { effective_from: D(120), amount_minor: 100, currency: 'USD' };

      const daysRes = await call(env, 'POST', `/api/subscriptions/${SUB_MONTHLY}/versions`, {
        ...base,
        cycle_type: 'days',
      });
      expect(daysRes.status).toBe(400);

      const trialRes = await call(env, 'POST', `/api/subscriptions/${SUB_MONTHLY}/versions`, {
        ...base,
        cycle_type: 'month',
        is_trial: true,
      });
      expect(trialRes.status).toBe(400);

      const afterTrialRes = await call(env, 'POST', `/api/subscriptions/${SUB_MONTHLY}/versions`, {
        ...base,
        cycle_type: 'month',
        is_trial: true,
        trial_end_date: D(150),
        after_trial_amount_minor: 100,
      });
      expect(afterTrialRes.status).toBe(400);

      const cycleDaysRes = await call(env, 'POST', `/api/subscriptions/${SUB_MONTHLY}/versions`, {
        ...base,
        cycle_type: 'month',
        cycle_days: 30,
      });
      expect(cycleDaysRes.status).toBe(400);
    });

    it('trial_end_date 必须晚于 effective_from -> 400', async () => {
      const env = makeEnv(db);
      const res = await call(env, 'POST', `/api/subscriptions/${SUB_MONTHLY}/versions`, {
        effective_from: D(200),
        amount_minor: 0,
        currency: 'CNY',
        cycle_type: 'month',
        is_trial: true,
        trial_end_date: D(199),
      });
      expect(res.status).toBe(400);
    });

    it('给不存在的订阅加版本 -> 404', async () => {
      const env = makeEnv(db);
      const res = await call(env, 'POST', '/api/subscriptions/nope/versions', {
        effective_from: D(1),
        amount_minor: 1,
        currency: 'CNY',
        cycle_type: 'month',
      });
      expect(res.status).toBe(404);
    });
  });
});
