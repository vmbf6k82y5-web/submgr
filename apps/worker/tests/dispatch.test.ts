/**
 * Cron 分发 + Hono 兜底行为的测试。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TODAY, call, callJson, makeEnv, queryAll, restoreClock, scenarioDb, useFixedClock } from './helpers/scenario.js';
import { fxPayload, jsonResponse, makeDeps } from './helpers/cron.js';
import type { FakeD1 } from './helpers/d1.js';
import {
  CRON_DAILY,
  CRON_FX,
  CRON_REMINDERS,
  dispatchCron,
  jobForCron,
} from '../src/cron/index.js';
import worker from '../src/index.js';
import type { Env } from '../src/env.js';

describe('jobForCron', () => {
  it('认得三个表达式', () => {
    expect(jobForCron(CRON_FX)).toBe('fx');
    expect(jobForCron(CRON_REMINDERS)).toBe('reminders');
    expect(jobForCron(CRON_DAILY)).toBe('daily');
  });

  it('容忍空白，但不认识的表达式不猜', () => {
    expect(jobForCron(`  ${CRON_DAILY} `)).toBe('daily');
    expect(jobForCron('0 0 * * *')).toBe('unknown');
    expect(jobForCron('')).toBe('unknown');
    // 与 wrangler.toml 对齐：这三个表达式确实是 UTC 下的对应时刻
    expect(CRON_FX).toBe('20 16 * * *'); // 00:20 Asia/Shanghai
    expect(CRON_DAILY).toBe('30 16 * * *'); // 00:30 Asia/Shanghai
    expect(CRON_REMINDERS).toBe('*/15 * * * *');
  });
});

describe('dispatchCron', () => {
  let db: FakeD1;

  beforeEach(() => {
    useFixedClock();
    db = scenarioDb();
  });

  afterEach(() => {
    db.close();
    restoreClock();
  });

  it('fx 作业：抓到的汇率写库', async () => {
    const env = makeEnv(db);
    const { deps } = makeDeps({ fetch: () => jsonResponse(fxPayload({ CNY: '7.0001' })) });

    const summary = await dispatchCron(CRON_FX, env, deps);

    expect(summary.job).toBe('fx');
    expect(summary.ok).toBe(true);
    expect(summary.error).toBeNull();
    expect(queryAll(db, "SELECT date FROM fx_rates WHERE rate = '7.0001'")).toHaveLength(1);
  });

  it('reminders 作业：发出提醒并写 reminder_log', async () => {
    const env = makeEnv(db);
    const { deps } = makeDeps({
      fetch: (url) => (url.includes('open.feishu.cn') ? jsonResponse({ code: 0 }) : jsonResponse({ ok: true })),
    });

    const summary = await dispatchCron(CRON_REMINDERS, env, deps);

    expect(summary.job).toBe('reminders');
    expect(summary.ok).toBe(true);
    const result = summary.result as { sent: number; failed: number };
    expect(result.sent).toBe(4);
    expect(result.failed).toBe(1);
  });

  it('daily 作业：转正 + 生成扣款', async () => {
    const env = makeEnv(db);
    const { deps } = makeDeps();

    const summary = await dispatchCron(CRON_DAILY, env, deps);

    expect(summary.job).toBe('daily');
    expect(summary.ok).toBe(true);
    const result = summary.result as { trial: { converted: number }; charges: { created: number } };
    expect(result.trial.converted).toBe(1);
    expect(result.charges.created).toBe(2);
  });

  it('不认识的表达式：ok=false 并写 warn 日志（不静默）', async () => {
    const env = makeEnv(db);
    const { deps, logs } = makeDeps();

    const summary = await dispatchCron('0 0 * * *', env, deps);

    expect(summary.job).toBe('unknown');
    expect(summary.ok).toBe(false);
    expect(summary.error).toContain('0 0 * * *');
    expect(summary.result).toBeNull();
    expect(logs.some((l) => l.event === 'cron.unknown' && l.level === 'warn')).toBe(true);
  });

  it('作业内部抛异常：ok=false + cron.crashed，绝不冒泡出去', async () => {
    const broken = {
      DB: {
        prepare() {
          throw new Error('D1 挂了');
        },
      },
    } as unknown as Env;
    const { deps, logs } = makeDeps();

    const summary = await dispatchCron(CRON_REMINDERS, broken, deps);

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain('D1 挂了');
    expect(logs.some((l) => l.event === 'cron.crashed')).toBe(true);
  });

  it('数据库整个挂掉：三个作业都只会返回结构化失败，绝不抛异常', async () => {
    const broken = {
      DB: {
        prepare() {
          throw new Error('D1 挂了');
        },
      },
    } as unknown as Env;

    for (const cron of [CRON_FX, CRON_REMINDERS, CRON_DAILY]) {
      const { deps } = makeDeps({ fetch: () => jsonResponse(fxPayload({ CNY: '7' })) });
      const summary = await dispatchCron(cron, broken, deps);
      expect(summary.ok).toBe(false);
      expect(summary.error).toContain('D1 挂了');
    }
    // runFxRefresh 只兜住「网络 + 写库」这一段；连 settings 都读不出来时，
    // 由 dispatchCron 的兜底记 cron.crashed（错误照样有日志，不会被吞）
    const { deps, logs } = makeDeps({ fetch: () => jsonResponse(fxPayload({ CNY: '7' })) });
    await dispatchCron(CRON_FX, broken, deps);
    expect(logs.some((l) => l.event === 'cron.crashed')).toBe(true);
  });
});

describe('Worker 兜底', () => {
  let db: FakeD1;

  beforeEach(() => {
    useFixedClock();
    db = scenarioDb();
  });

  afterEach(() => {
    db.close();
    restoreClock();
  });

  it('未知路径 -> 404 JSON', async () => {
    const env = makeEnv(db);
    const api = await call(env, 'GET', '/api/nope');
    expect(api.status).toBe(404);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe('not_found');

    const ics = await call(env, 'GET', '/nope', undefined, { token: null });
    expect(ics.status).toBe(404);
  });

  it('根路径没有页面（静态资源由 Cloudflare Assets 提供）', async () => {
    const env = makeEnv(db);
    const res = await call(env, 'GET', '/', undefined, { token: null });
    expect(res.status).toBe(404);
  });

  it('POST 到只支持 GET 的接口 -> 404（Hono 默认行为）', async () => {
    const env = makeEnv(db);
    const res = await call(env, 'POST', '/api/summary', {});
    expect([404, 405]).toContain(res.status);
  });

  it('未预期的异常 -> 500 且不泄露细节', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { DB: { prepare: () => { throw new Error('内部细节：表结构不对'); } }, ADMIN_TOKEN: 'test-admin-token' } as unknown as Env;

    const res = await call(broken, 'GET', '/api/subscriptions');

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).not.toContain('内部细节');

    // 日志里必须有完整信息
    const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('http.unhandled');
    expect(logged).toContain('内部细节：表结构不对');
    spy.mockRestore();
  });

  it('不做 CORS：跨域预检不会被放行（前端与 API 同源）', async () => {
    const env = makeEnv(db);
    const res = await call(env, 'OPTIONS', '/api/subscriptions', undefined, {
      token: null,
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    // 没有令牌 -> 直接 401，连预检都不放行
    expect(res.status).toBe(401);
  });

  it('默认导出暴露 fetch 与 scheduled（Cloudflare Workers 的入口约定）', async () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.scheduled).toBe('function');

    const env = makeEnv(db);
    // 用一个不认识的表达式调 scheduled：不会走网络，只验证接线没问题
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: '0 0 * * *' } as unknown as ScheduledController,
      env,
      { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext,
    );
    await Promise.all(pending);
    expect(pending).toHaveLength(1);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('settings 未初始化时接口会自愈（按需建单行）', async () => {
    const env = makeEnv(db);
    await env.DB.prepare('DELETE FROM settings').run();
    const body = await callJson<{ item: { base_currency: string; ics_token: string } }>(env, 'GET', '/api/settings');
    expect(body.item.base_currency).toBe('CNY');
    expect(body.item.ics_token.length).toBeGreaterThanOrEqual(16);
    expect(queryAll(db, 'SELECT id FROM settings')).toHaveLength(1);
  });

  it('基准币种改成 USD 后 /api/summary 与趋势都会跟着变', async () => {
    const env = makeEnv(db);
    await callJson(env, 'PUT', '/api/settings', { base_currency: 'USD' });
    const summary = await callJson<{
      item: { baseCurrency: string; monthlyAverageMinor: number | null; missingCurrencies: string[] };
    }>(env, 'GET', '/api/summary');

    expect(summary.item.baseCurrency).toBe('USD');
    // 反向折算：CNY 订阅按快照换回 USD，总额必然远小于按 CNY 计的 49536
    expect(summary.item.monthlyAverageMinor).not.toBeNull();
    expect(summary.item.monthlyAverageMinor as number).toBeGreaterThan(2299);
    expect(summary.item.monthlyAverageMinor as number).toBeLessThan(10000);
  });

  it('汇率表为空：金额算不出来（null），并通过 fxAsOf=null / stale=true 暴露', async () => {
    const env = makeEnv(db);
    await env.DB.prepare('DELETE FROM fx_rates').run();
    const body = await callJson<{
      item: { monthlyAverageMinor: number | null; missingCurrencies: string[]; stale: boolean; fxAsOf: string | null };
    }>(env, 'GET', '/api/summary');

    // 一个汇率都没有 -> 外币（USD）换不回 CNY，金额只能是 null，不能假装是 0
    expect(body.item.monthlyAverageMinor).toBeNull();
    expect(body.item.fxAsOf).toBeNull();
    expect(body.item.stale).toBe(true);
    // core 的口径：missingCurrencies 只列「非基准币种」，基准币种自身不登记
    expect(body.item.missingCurrencies).toEqual([]);
  });

  it('缺某个非基准币种的汇率时会点名该币种', async () => {
    const env = makeEnv(db);
    await callJson(env, 'POST', '/api/charges', {}, 400);
    const id = await callJson<{ item: { id: string } }>(
      env,
      'POST',
      '/api/subscriptions',
      {
        name: '英镑订阅',
        sub_type: 'software',
        charge_channel: 'card',
        renew_mode: 'auto',
        start_date: '2026-10-01',
        version: { effective_from: '2026-10-01', amount_minor: 1000, currency: 'GBP', cycle_type: 'month' },
      },
      201,
    );
    expect(id.item.id).toBeTruthy();

    const body = await callJson<{ item: { missingCurrencies: string[]; monthlyAverageMinor: number | null } }>(
      env,
      'GET',
      '/api/summary',
    );
    expect(body.item.missingCurrencies).toEqual(['GBP']);
    expect(body.item.monthlyAverageMinor).toBeNull();
  });

  it('TODAY 常量与接口返回的 today 一致（测试时钟的前提）', async () => {
    const env = makeEnv(db);
    const body = await callJson<{ item: { today: string } }>(env, 'GET', '/api/summary');
    expect(body.item.today).toBe(TODAY);
  });
});
