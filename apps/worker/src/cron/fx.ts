/**
 * Cron ①：每天拉一次汇率快照。
 *
 * 流程：settings 取用户时区 -> 适配器抓 USD 汇率 -> 失败重试（指数退避）
 *      -> 按 (date, currency) upsert 进 fx_rates。
 *
 * 为什么 date 用「用户时区下的今天」而不是 UTC 今天：
 * charges.charge_date 也是用户时区下的自然日，两者必须同一口径，
 * 否则跨零点时「扣款当天」会查不到当天的汇率。
 */

import { nowIso, todayInTimeZone } from '@submgr/core';
import type { Env } from '../env.js';
import { ensureSettings } from '../lib/settings.js';
import { OpenErApiSource, type FxRateSource } from './adapters.js';
import { defaultCronDeps, type CronDeps } from './deps.js';
import { withRetry } from './retry.js';

export interface FxRefreshResult {
  ok: boolean;
  date: string;
  fetched_at: string | null;
  source: string;
  currencies: number;
  attempts: number;
  error: string | null;
}

/** 默认重试策略：3 次尝试、500ms 起指数退避。 */
export const FX_RETRY = { attempts: 3, delayMs: 500 };

export async function runFxRefresh(
  env: Env,
  deps: CronDeps = defaultCronDeps(),
  source?: FxRateSource,
): Promise<FxRefreshResult> {
  const settings = await ensureSettings(env.DB);
  const now = deps.now();
  const date = todayInTimeZone(settings.timezone, now);
  const adapter =
    source ?? deps.fxSource ?? new OpenErApiSource(env.FX_API_BASE, deps.fetch, 10_000, deps.now);

  let attempts = 0;
  try {
    const payload = await withRetry(
      () => {
        attempts += 1;
        return adapter.fetchUsdRates('USD');
      },
      {
        attempts: FX_RETRY.attempts,
        delayMs: FX_RETRY.delayMs,
        sleep: deps.sleep,
        onAttemptFailed: (err, attempt) => {
          deps.log('warn', 'cron.fx.attempt_failed', {
            source: adapter.name,
            attempt,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      },
    );

    const currencies = Object.keys(payload.rates).sort();
    const statements = currencies.map((currency) =>
      env.DB.prepare(
        `INSERT INTO fx_rates (date, base, currency, rate, fetched_at)
         VALUES (?, 'USD', ?, ?, ?)
         ON CONFLICT(date, currency) DO UPDATE SET
           rate = excluded.rate,
           fetched_at = excluded.fetched_at`,
      ).bind(date, currency, payload.rates[currency], payload.fetchedAt),
    );

    // D1 的 batch 是原子批量执行；分批只是为了避免单次请求过大。
    const CHUNK = 100;
    for (let i = 0; i < statements.length; i += CHUNK) {
      await env.DB.batch(statements.slice(i, i + CHUNK));
    }

    const result: FxRefreshResult = {
      ok: true,
      date,
      fetched_at: payload.fetchedAt,
      source: payload.provider,
      currencies: currencies.length,
      attempts,
      error: null,
    };
    deps.log('info', 'cron.fx.ok', { ...result });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result: FxRefreshResult = {
      ok: false,
      date,
      fetched_at: null,
      source: adapter.name,
      currencies: 0,
      attempts,
      error: message,
    };
    // 失败记录：没有作业日志表（migration 冻结），写结构化日志 + 保留昨天/前天的快照
    deps.log('error', 'cron.fx.failed', { ...result });
    return result;
  }
}

/** 供测试或手工排查使用：直接把一份 rates 写库（不经过网络）。 */
export async function persistRates(
  env: Env,
  date: string,
  rates: Record<string, string>,
  fetchedAt: string = nowIso(),
): Promise<number> {
  const currencies = Object.keys(rates).sort();
  const statements = currencies.map((currency) =>
    env.DB.prepare(
      `INSERT INTO fx_rates (date, base, currency, rate, fetched_at)
       VALUES (?, 'USD', ?, ?, ?)
       ON CONFLICT(date, currency) DO UPDATE SET
         rate = excluded.rate,
         fetched_at = excluded.fetched_at`,
    ).bind(date, currency, rates[currency], fetchedAt),
  );
  const CHUNK = 100;
  for (let i = 0; i < statements.length; i += CHUNK) {
    await env.DB.batch(statements.slice(i, i + CHUNK));
  }
  return currencies.length;
}
