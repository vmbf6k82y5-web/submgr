/**
 * Cron ①（每天拉汇率）的测试。
 *
 * 重点：
 *   * 适配器解析（只认 result=success、忽略脏数据）；
 *   * 失败重试 + 结构化日志（migration 冻结，没有作业日志表）；
 *   * 按 (date, currency) upsert，重复跑不会长行；
 *   * date 用「用户时区下的今天」。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TODAY, makeEnv, queryAll, queryOne, restoreClock, scenarioDb, useFixedClock } from './helpers/scenario.js';
import { fxPayload, jsonResponse, makeDeps } from './helpers/cron.js';
import type { FakeD1 } from './helpers/d1.js';
import { OpenErApiSource, decimalStringOf } from '../src/cron/adapters.js';
import { FX_RETRY, persistRates, runFxRefresh } from '../src/cron/fx.js';
import { withRetry } from '../src/cron/retry.js';

describe('Cron ① 拉汇率', () => {
  let db: FakeD1;

  beforeEach(() => {
    useFixedClock();
    db = scenarioDb();
  });

  afterEach(() => {
    db.close();
    restoreClock();
  });

  it('成功：按用户时区的今天 upsert，并把 rate / fetched_at 写对', async () => {
    const env = makeEnv(db);
    const { deps, logs } = makeDeps({
      fetch: () => jsonResponse(fxPayload({ USD: 1, CNY: 7.1234, EUR: 0.92, JPY: 149.5 })),
    });

    const result = await runFxRefresh(env, deps);

    expect(result.ok).toBe(true);
    expect(result.date).toBe(TODAY);
    expect(result.currencies).toBe(4);
    expect(result.attempts).toBe(1);
    expect(result.error).toBeNull();
    expect(result.source).toBe('open.er-api.com');

    const rows = queryAll<{ date: string; base: string; currency: string; rate: string }>(
      db,
      `SELECT date, base, currency, rate FROM fx_rates WHERE date = ? ORDER BY currency`,
      TODAY,
    );
    expect(rows.map((r) => r.currency)).toEqual(['CNY', 'EUR', 'JPY', 'USD']);
    expect(rows.every((r) => r.base === 'USD')).toBe(true);
    expect(rows.find((r) => r.currency === 'CNY')?.rate).toBe('7.1234');
    expect(logs.some((l) => l.event === 'cron.fx.ok')).toBe(true);
  });

  it('重复跑是 upsert：行数不变，汇率换成新值', async () => {
    const env = makeEnv(db);
    const before = queryAll(db, 'SELECT currency FROM fx_rates').length;

    const first = makeDeps({ fetch: () => jsonResponse(fxPayload({ CNY: 7.0 })) });
    await runFxRefresh(env, first.deps);
    const second = makeDeps({ fetch: () => jsonResponse(fxPayload({ CNY: 7.5 })) });
    await runFxRefresh(env, second.deps);

    const rows = queryAll<{ currency: string; rate: string }>(
      db,
      'SELECT currency, rate FROM fx_rates WHERE date = ?',
      TODAY,
    );
    // date 那天只有一条 CNY（原本场景里就有一条今天的 CNY）
    expect(rows.filter((r) => r.currency === 'CNY')).toHaveLength(1);
    expect(rows.find((r) => r.currency === 'CNY')?.rate).toBe('7.5');
    expect(queryAll(db, 'SELECT currency FROM fx_rates').length).toBe(before);
  });

  it('前两次失败、第三次成功：退避 500ms / 1000ms，attempts = 3', async () => {
    const env = makeEnv(db);
    let attempt = 0;
    const { deps, sleeps, logs } = makeDeps({
      fetch: () => {
        attempt += 1;
        if (attempt < 3) throw new Error(`网络抖动 #${attempt}`);
        return jsonResponse(fxPayload({ CNY: 7.1 }));
      },
    });

    const result = await runFxRefresh(env, deps);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(sleeps).toEqual([FX_RETRY.delayMs, FX_RETRY.delayMs * 2]);
    expect(logs.filter((l) => l.event === 'cron.fx.attempt_failed')).toHaveLength(2);
  });

  it('全部失败：ok=false、写错误日志、不动数据库', async () => {
    const env = makeEnv(db);
    const before = queryAll(db, 'SELECT currency FROM fx_rates').length;

    const { deps, sleeps, logs } = makeDeps({
      fetch: () => {
        throw new Error('连接被重置');
      },
    });

    const result = await runFxRefresh(env, deps);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('连接被重置');
    expect(result.attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(queryAll(db, 'SELECT currency FROM fx_rates').length).toBe(before);

    const failedLogs = logs.filter((l) => l.event === 'cron.fx.failed');
    expect(failedLogs).toHaveLength(1);
    expect(failedLogs[0]?.level).toBe('error');
    expect(failedLogs[0]?.data['error']).toContain('连接被重置');
  });

  it('HTTP 非 2xx / result != success -> 失败', async () => {
    const env = makeEnv(db);
    const http500 = makeDeps({ fetch: () => jsonResponse({}, 500) });
    expect((await runFxRefresh(env, http500.deps)).ok).toBe(false);

    const notSuccess = makeDeps({ fetch: () => jsonResponse(fxPayload({ CNY: 7 }, { result: 'error' })) });
    const result = await runFxRefresh(env, notSuccess.deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('result=error');
  });

  it('脏数据被忽略；一条可用汇率都没有则算失败', async () => {
    const env = makeEnv(db);

    const dirty = makeDeps({
      fetch: () =>
        jsonResponse(
          fxPayload({
            CNY: 7.1,
            USDT: 1, // 四字母 -> 忽略
            BAD: 0, // 非正数 -> 忽略
            XYZ: 'abc', // 不是数字 -> 忽略
            EUR: '0.9',
          }),
        ),
    });
    const ok = await runFxRefresh(env, dirty.deps);
    expect(ok.ok).toBe(true);
    expect(ok.currencies).toBe(2);
    // 场景里今天本来就有 CNY/EUR/JPY 三行，脏数据只额外写进了合法的 EUR 覆盖 + CNY
    const rows = queryAll<{ currency: string }>(db, 'SELECT currency FROM fx_rates WHERE date = ?', TODAY);
    expect(rows.map((r) => r.currency).sort()).toEqual(['CNY', 'EUR', 'JPY']);

    const allDirty = makeDeps({ fetch: () => jsonResponse(fxPayload({ BAD: -1, XYZ: 'x' })) });
    const bad = await runFxRefresh(env, allDirty.deps);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('0 条可用汇率');
  });

  it('endpoint 末尾的币种会被替换成 base，并带上 Accept 头', async () => {
    const env = makeEnv(db, { FX_API_BASE: 'https://open.er-api.com/v6/latest/EUR' });
    const { deps, calls } = makeDeps({ fetch: () => jsonResponse(fxPayload({ CNY: 7 })) });
    await runFxRefresh(env, deps);
    expect(calls[0]?.url).toBe('https://open.er-api.com/v6/latest/USD');
    expect(calls[0]?.headers['accept']).toBe('application/json');
  });

  it('可以注入自定义数据源（适配器模式）', async () => {
    const env = makeEnv(db);
    const { deps } = makeDeps();
    deps.fxSource = {
      name: 'fake-source',
      fetchUsdRates: async () => ({
        rates: { CNY: '6.9999' },
        fetchedAt: `${TODAY}T00:00:00.000Z`,
        provider: 'fake-source',
        sourceUpdatedAt: null,
      }),
    };

    const result = await runFxRefresh(env, deps);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('fake-source');
    expect(
      queryOne<{ rate: string }>(db, 'SELECT rate FROM fx_rates WHERE date = ? AND currency = ?', TODAY, 'CNY')?.rate,
    ).toBe('6.9999');
  });

  it('persistRates 可以直接写库（供排查/补数）', async () => {
    const env = makeEnv(db);
    const count = await persistRates(env, '2020-01-01', { CNY: '7', EUR: '0.9' }, '2020-01-01T00:00:00.000Z');
    expect(count).toBe(2);
    expect(queryAll(db, 'SELECT currency FROM fx_rates WHERE date = ?', '2020-01-01')).toHaveLength(2);
  });
});

describe('withRetry', () => {
  it('第一次就成功 -> 不 sleep', async () => {
    const sleeps: number[] = [];
    const value = await withRetry(async () => 42, {
      attempts: 3,
      delayMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(value).toBe(42);
    expect(sleeps).toEqual([]);
  });

  it('全部失败 -> 抛出最后一次的错误，退避翻倍', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error(`第 ${attempts} 次`);
        },
        {
          attempts: 4,
          delayMs: 10,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toThrow('第 4 次');
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([10, 20, 40]);
  });

  it('onAttemptFailed 能拿到失败次数', async () => {
    const seen: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        n += 1;
        if (n < 2) throw new Error('x');
        return 'ok';
      },
      { attempts: 2, delayMs: 1, sleep: async () => {}, onAttemptFailed: (_e, attempt) => seen.push(attempt) },
    );
    expect(seen).toEqual([1]);
  });

  it('attempts 不是正整数 -> 直接报参数错误（不静默按 1 次跑）', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        return 'ok';
      }, { attempts: 0, delayMs: 1, sleep: async () => {} }),
    ).rejects.toThrow(/attempts/);
    expect(calls).toBe(0);
  });
});

describe('OpenErApiSource / decimalStringOf', () => {
  it('decimalStringOf 只接受正数', () => {
    expect(decimalStringOf(1)).toBe('1');
    expect(decimalStringOf(7.1234)).toBe('7.1234');
    expect(decimalStringOf('0.92')).toBe('0.92');
    expect(decimalStringOf(0)).toBeNull();
    expect(decimalStringOf(-1)).toBeNull();
    expect(decimalStringOf(Number.NaN)).toBeNull();
    expect(decimalStringOf(Infinity)).toBeNull();
    expect(decimalStringOf('abc')).toBeNull();
    expect(decimalStringOf('')).toBeNull();
    expect(decimalStringOf(null)).toBeNull();
    expect(decimalStringOf({})).toBeNull();
  });

  it('name 与 URL 重写', async () => {
    const seen: string[] = [];
    const source = new OpenErApiSource(
      'https://open.er-api.com/v6/latest/USD',
      (async (input: unknown) => {
        seen.push(String(input));
        return jsonResponse(fxPayload({ CNY: 7 }));
      }) as unknown as typeof fetch,
    );
    expect(source.name).toBe('open.er-api.com');
    await source.fetchUsdRates('USD');
    expect(seen[0]).toBe('https://open.er-api.com/v6/latest/USD');
  });
});
