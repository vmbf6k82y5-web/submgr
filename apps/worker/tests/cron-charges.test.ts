/**
 * Cron ③（每天试用转正 + 生成当日扣款）的测试。
 *
 * 这是整个 Worker 里最「有副作用」的一步，所以重点验证：
 *   * 转正版本的 effective_from === trial_end_date（需求原文），且可补跑；
 *   * 当天扣款只生成一次（ux_charges_auto_daily 幂等）；
 *   * 汇率按「扣款日（含）之前最新一天」冻结，绝不用未来汇率；
 *   * 试用期 / 终身 / 手动续费 / 已取消都不生成自动扣款。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SubscriptionRow, SubscriptionVersionRow } from '@submgr/core';
import {
  D,
  CAT_CLOUD,
  SUB_CANCELLED,
  SUB_DUE_TODAY,
  SUB_LIFETIME,
  SUB_MANUAL_OVERDUE,
  SUB_MONTHLY,
  SUB_TRIAL_FUTURE,
  SUB_TRIAL_TODAY,
  TODAY,
  V_DUE_TODAY,
  callJson,
  makeEnv,
  queryAll,
  queryOne,
  restoreClock,
  scenarioDb,
  useFixedClock,
} from './helpers/scenario.js';
import { makeDeps } from './helpers/cron.js';
import type { FakeD1 } from './helpers/d1.js';
import { isDueToday, runChargeGeneration, runDailyJob, runTrialConversions } from '../src/cron/charges.js';

interface ChargeRowLite {
  id: string;
  subscription_id: string;
  version_id: string | null;
  charge_date: string;
  amount_minor: number;
  currency: string;
  fx_rate_to_base: string | null;
  base_currency: string | null;
  base_amount_minor: number | null;
  source: string;
  status: string;
}

/** 新建一个「今天到期」的自动续费订阅，返回 subscription id。 */
async function createDueTodaySubscription(
  env: ReturnType<typeof makeEnv>,
  input: {
    name: string;
    currency: string;
    amountMinor: number;
    renewMode?: 'auto' | 'manual';
    cycleType?: 'month' | 'year' | 'lifetime';
    endDate?: string;
    chargeChannel?: string;
  },
): Promise<string> {
  const body = await callJson<{ item: { id: string } }>(
    env,
    'POST',
    '/api/subscriptions',
    {
      name: input.name,
      sub_type: 'software',
      charge_channel: input.chargeChannel ?? 'card',
      renew_mode: input.renewMode ?? 'auto',
      start_date: TODAY,
      ...(input.endDate ? { end_date: input.endDate } : {}),
      version: {
        effective_from: TODAY,
        amount_minor: input.amountMinor,
        currency: input.currency,
        cycle_type: input.cycleType ?? 'month',
      },
    },
    201,
  );
  return body.item.id;
}

describe('Cron ③ 试用转正 + 生成当日扣款', () => {
  let db: FakeD1;

  beforeEach(() => {
    useFixedClock();
    db = scenarioDb();
  });

  afterEach(() => {
    db.close();
    restoreClock();
  });

  it('转正 + 当天的自动扣款（含转正后的第一笔）', async () => {
    const env = makeEnv(db);
    const { deps, logs } = makeDeps();

    const result = await runDailyJob(env, deps);

    // --- A. 试用转正 ---
    expect(result.trial.today).toBe(TODAY);
    expect(result.trial.converted).toBe(1);
    expect(result.trial.skipped_existing).toBe(0);
    const detail = result.trial.details[0];
    expect(detail?.subscription_id).toBe(SUB_TRIAL_TODAY);
    expect(detail?.effective_from).toBe(TODAY);
    expect(detail?.amount_minor).toBe(9900);
    expect(detail?.currency).toBe('CNY');
    expect(detail?.cycle_type).toBe('month');

    const newVersion = queryOne<{
      id: string;
      effective_from: string;
      amount_minor: number;
      currency: string;
      cycle_type: string;
      is_trial: number;
      trial_end_date: string | null;
      plan_name: string;
    }>(db, 'SELECT * FROM subscription_versions WHERE id = ?', detail?.new_version_id);
    expect(newVersion?.effective_from).toBe(TODAY);
    expect(newVersion?.amount_minor).toBe(9900);
    expect(newVersion?.is_trial).toBe(0);
    expect(newVersion?.trial_end_date).toBeNull();
    // 转正版本沿用试用版本的 plan_name
    expect(newVersion?.plan_name).toBe('Plus 试用');

    // 试用还没结束的那个不动
    expect(
      queryAll(db, 'SELECT id FROM subscription_versions WHERE subscription_id = ?', SUB_TRIAL_FUTURE),
    ).toHaveLength(1);

    // --- B. 当日扣款 ---
    expect(result.charges.created).toBe(2);
    expect(result.charges.skipped_existing).toBe(0);
    expect(result.charges.skipped_trial).toBe(1); // Figma 还在试用
    expect(result.charges.missing_fx).toBe(0);

    const rows = queryAll<ChargeRowLite>(
      db,
      `SELECT * FROM charges WHERE charge_date = ? AND source = 'auto' ORDER BY amount_minor`,
      TODAY,
    );
    expect(rows).toHaveLength(2);

    const spotify = rows.find((r) => r.subscription_id === SUB_DUE_TODAY) as ChargeRowLite;
    expect(spotify.amount_minor).toBe(3000);
    expect(spotify.currency).toBe('CNY');
    expect(spotify.fx_rate_to_base).toBe('1');
    expect(spotify.base_currency).toBe('CNY');
    expect(spotify.base_amount_minor).toBe(3000);
    expect(spotify.version_id).toBe(V_DUE_TODAY);
    expect(spotify.status).toBe('paid');

    const notion = rows.find((r) => r.subscription_id === SUB_TRIAL_TODAY) as ChargeRowLite;
    expect(notion.amount_minor).toBe(9900);
    expect(notion.base_amount_minor).toBe(9900);
    // version_id 必须是真实的转正版本，不能是投影 id（带 ::）
    expect(notion.version_id).toBe(detail?.new_version_id);
    expect(notion.version_id).not.toContain('::');

    // 不该生成的：月付未到期 / 年付未到期 / 终身 / 手动续费 / 已取消
    const ids = rows.map((r) => r.subscription_id);
    expect(ids).not.toContain(SUB_MONTHLY);
    expect(ids).not.toContain(SUB_LIFETIME);
    expect(ids).not.toContain(SUB_MANUAL_OVERDUE);
    expect(ids).not.toContain(SUB_CANCELLED);

    expect(logs.some((l) => l.event === 'cron.trial.converted')).toBe(true);
    expect(logs.some((l) => l.event === 'cron.charges.done')).toBe(true);
    expect(logs.some((l) => l.event === 'cron.charges.missing_fx')).toBe(false);
  });

  it('重复跑完全幂等：不重复转正、不重复扣款', async () => {
    const env = makeEnv(db);
    const first = makeDeps();
    await runDailyJob(env, first.deps);
    const before = queryAll(db, 'SELECT id FROM charges').length;

    const second = makeDeps();
    const result = await runDailyJob(env, second.deps);

    expect(result.trial.converted).toBe(0);
    expect(result.trial.skipped_existing).toBe(1);
    expect(result.charges.created).toBe(0);
    expect(result.charges.skipped_existing).toBe(2);
    expect(queryAll(db, 'SELECT id FROM charges').length).toBe(before);
    expect(
      queryAll(db, 'SELECT id FROM subscription_versions WHERE subscription_id = ?', SUB_TRIAL_TODAY),
    ).toHaveLength(2); // 试用版 + 转正版，没有多出来的
  });

  it('试用补跑：昨天漏跑也能补，转正日仍是 trial_end_date', async () => {
    const env = makeEnv(db);
    await env.DB.prepare('UPDATE subscription_versions SET trial_end_date = ? WHERE id = ?')
      .bind(D(-3), queryOne<{ id: string }>(db, 'SELECT id FROM subscription_versions WHERE subscription_id = ?', SUB_TRIAL_TODAY)?.id)
      .run();

    const { deps } = makeDeps();
    const result = await runTrialConversions(env, deps);

    expect(result.converted).toBe(1);
    expect(result.details[0]?.effective_from).toBe(D(-3));
    // 转正日不是今天 -> 今天不该有自动扣款
    const charges = await runChargeGeneration(env, deps);
    expect(charges.charges.some((c) => c.subscription_id === SUB_TRIAL_TODAY)).toBe(false);
  });

  it('同一天已经有版本时跳过转正，但仍按已有版本扣款', async () => {
    const env = makeEnv(db);
    // 手工插入一个「今天生效」的正式版本（等价于转正版本已经存在）
    await env.DB.prepare(
      `INSERT INTO subscription_versions
         (id, subscription_id, effective_from, plan_name, amount_minor, currency, cycle_type, is_trial,
          created_at, updated_at)
       VALUES ('99999999-9999-4999-8999-000000000001', ?, ?, '提前建好的版本', 1234, 'CNY', 'month', 0, ?, ?)`,
    )
      .bind(SUB_TRIAL_TODAY, TODAY, `${TODAY}T00:00:00.000Z`, `${TODAY}T00:00:00.000Z`)
      .run();

    const { deps } = makeDeps();
    const trial = await runTrialConversions(env, deps);
    expect(trial.converted).toBe(0);
    expect(trial.skipped_existing).toBe(1);

    const charges = await runChargeGeneration(env, deps);
    const notion = charges.charges.find((c) => c.subscription_id === SUB_TRIAL_TODAY);
    expect(notion?.amount_minor).toBe(1234);
    expect(notion?.version_id).toBe('99999999-9999-4999-8999-000000000001');
  });

  it('试用版没填转正价 = 试用后不续费：不转正也不扣款', async () => {
    const env = makeEnv(db);
    // 「试用后不续费」在 schema 里就是 after_trial_* 全为空
    await env.DB.prepare(
      `UPDATE subscription_versions
          SET after_trial_amount_minor = NULL, after_trial_currency = NULL,
              after_trial_cycle_type = NULL, after_trial_cycle_days = NULL
        WHERE subscription_id = ?`,
    )
      .bind(SUB_TRIAL_TODAY)
      .run();

    const { deps } = makeDeps();
    const trial = await runTrialConversions(env, deps);
    expect(trial.converted).toBe(0);
    expect(trial.skipped_existing).toBe(0);

    const charges = await runChargeGeneration(env, deps);
    expect(charges.skipped_trial).toBe(2); // Notion + Figma 都还在试用
    expect(charges.charges.some((c) => c.subscription_id === SUB_TRIAL_TODAY)).toBe(false);
  });

  it('终身订阅与手动续费都不生成自动扣款', async () => {
    const env = makeEnv(db);
    const { deps } = makeDeps();
    const charges = await runChargeGeneration(env, deps);
    const ids = charges.charges.map((c) => c.subscription_id);
    expect(ids).not.toContain(SUB_LIFETIME);
    expect(ids).not.toContain(SUB_MANUAL_OVERDUE);
    // 终身是手动续费，所以在「renew_mode 过滤」那一步就被跳过了
    expect(charges.skipped_lifetime).toBe(0);
  });

  it('过了 end_date 的订阅不再生成扣款', async () => {
    const env = makeEnv(db);
    const id = await createDueTodaySubscription(env, { name: '昨天就结束了', currency: 'CNY', amountMinor: 500 });
    // 接口层不允许 end_date < start_date，所以直接把整个区间挪到过去来模拟「已经过期」
    await env.DB.prepare('UPDATE subscriptions SET start_date = ?, end_date = ? WHERE id = ?')
      .bind(D(-10), D(-1), id)
      .run();

    const { deps } = makeDeps();
    const charges = await runChargeGeneration(env, deps);
    expect(charges.charges.some((c) => c.subscription_id === id)).toBe(false);
  });

  it('缺汇率的币种：扣款照记，基准金额留空并告警（绝不用未来汇率凑）', async () => {
    const env = makeEnv(db);
    const id = await createDueTodaySubscription(env, { name: '英镑订阅', currency: 'GBP', amountMinor: 1000 });

    // 故意只给「明天」的 GBP 汇率 —— 今天不该用它
    await env.DB.prepare(
      `INSERT INTO fx_rates (date, base, currency, rate, fetched_at) VALUES (?, 'USD', 'GBP', '0.8000', ?)`,
    )
      .bind(D(1), `${TODAY}T01:00:00.000Z`)
      .run();

    const { deps, logs } = makeDeps();
    // 走完整日作业：先转正（Notion 今天转正要扣 9900），再生成扣款
    const daily = await runDailyJob(env, deps);
    const result = daily.charges;

    expect(result.created).toBe(3);
    expect(result.missing_fx).toBe(1);

    const row = queryOne<ChargeRowLite>(db, 'SELECT * FROM charges WHERE subscription_id = ?', id);
    expect(row?.amount_minor).toBe(1000);
    expect(row?.currency).toBe('GBP');
    expect(row?.fx_rate_to_base).toBeNull();
    expect(row?.base_currency).toBeNull();
    expect(row?.base_amount_minor).toBeNull();
    expect(logs.some((l) => l.event === 'cron.charges.missing_fx')).toBe(true);
  });

  it('外币扣款用「扣款日（含）之前最新一天」的汇率，今天没有就回退到昨天', async () => {
    const env = makeEnv(db);
    const id = await createDueTodaySubscription(env, { name: '美元订阅', currency: 'USD', amountMinor: 2299 });

    const withToday = makeDeps();
    await runChargeGeneration(env, withToday.deps);
    const frozenToday = queryOne<ChargeRowLite>(db, 'SELECT * FROM charges WHERE subscription_id = ?', id);
    expect(frozenToday?.fx_rate_to_base).toBe('7.12');
    expect(frozenToday?.base_amount_minor).toBe(16369);

    // 删掉今天的 CNY 快照，只剩昨天的 7.05
    await env.DB.prepare('DELETE FROM charges WHERE subscription_id = ?').bind(id).run();
    await env.DB.prepare("DELETE FROM fx_rates WHERE currency = 'CNY' AND date = ?").bind(TODAY).run();

    const fallback = makeDeps();
    await runChargeGeneration(env, fallback.deps);
    const frozenYesterday = queryOne<ChargeRowLite>(db, 'SELECT * FROM charges WHERE subscription_id = ?', id);
    expect(frozenYesterday?.fx_rate_to_base).toBe('7.05');
    expect(frozenYesterday?.base_amount_minor).toBe(16208);
  });

  it('同一天的多笔扣款共用同一份汇率快照', async () => {
    const env = makeEnv(db);
    const first = await createDueTodaySubscription(env, { name: '美元 A', currency: 'USD', amountMinor: 100 });
    const second = await createDueTodaySubscription(env, { name: '美元 B', currency: 'USD', amountMinor: 200 });

    const { deps } = makeDeps();
    await runChargeGeneration(env, deps);

    const rows = queryAll<ChargeRowLite>(db, 'SELECT * FROM charges WHERE subscription_id IN (?, ?)', first, second);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.fx_rate_to_base === '7.12')).toBe(true);
  });

  it('已取消的订阅不生成扣款，即使 renew_mode = auto', async () => {
    const env = makeEnv(db);
    const id = await createDueTodaySubscription(env, { name: '刚取消', currency: 'CNY', amountMinor: 700 });
    await env.DB.prepare('UPDATE subscriptions SET cancelled_at = ? WHERE id = ?')
      .bind(`${TODAY}T00:00:00.000Z`, id)
      .run();

    const { deps } = makeDeps();
    const charges = await runChargeGeneration(env, deps);
    expect(charges.charges.some((c) => c.subscription_id === id)).toBe(false);
  });

  it('分类字段不影响扣款生成', async () => {
    const env = makeEnv(db);
    const id = await callJson<{ item: { id: string } }>(
      env,
      'POST',
      '/api/subscriptions',
      {
        name: '带分类的订阅',
        category_id: CAT_CLOUD,
        sub_type: 'cloud',
        charge_channel: 'alipay',
        renew_mode: 'auto',
        start_date: TODAY,
        version: { effective_from: TODAY, amount_minor: 800, currency: 'CNY', cycle_type: 'month' },
      },
      201,
    );
    const { deps } = makeDeps();
    const charges = await runChargeGeneration(env, deps);
    expect(charges.charges.some((c) => c.subscription_id === id.item.id)).toBe(true);
  });

  it('isDueToday 与真实生成的口径一致（含试用投影）', async () => {
    const env = makeEnv(db);
    const subscriptions = queryAll<SubscriptionRow>(
      db,
      'SELECT * FROM subscriptions WHERE deleted_at IS NULL',
    );
    const versions = queryAll<SubscriptionVersionRow>(
      db,
      'SELECT * FROM subscription_versions WHERE deleted_at IS NULL',
    );
    const find = (id: string) => subscriptions.find((s) => s.id === id) as SubscriptionRow;

    // 月付的 Netflix 是每月 1 号到期，今天（10 号）不到期
    expect(isDueToday(find(SUB_MONTHLY), versions, TODAY)).toBe(false);
    // 今天到期的 Spotify
    expect(isDueToday(find(SUB_DUE_TODAY), versions, TODAY)).toBe(true);
    // Notion 今天试用转正：投影后的转正版本从今天起算，所以也算「今天到期」，
    // 与 runDailyJob「先转正再扣款」的结果一致。
    expect(isDueToday(find(SUB_TRIAL_TODAY), versions, TODAY)).toBe(true);
    // 终身 / 手动续费都不算「要自动扣款」
    expect(isDueToday(find(SUB_LIFETIME), versions, TODAY)).toBe(false);
    expect(isDueToday(find(SUB_MANUAL_OVERDUE), versions, TODAY)).toBe(false);
  });
});
