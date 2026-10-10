/**
 * 汇率数据源适配器。
 *
 * 「适配器模式」的落点：调度逻辑（cron/fx.ts）只认 FxRateSource 接口，
 * 换数据源 = 新增一个实现类，并把它注入 CronDeps.fxSource。
 * 默认实现是需求指定的 https://open.er-api.com/v6/latest/USD。
 *
 * 约定：返回的 rates 一律是「1 USD 等于多少该币种」的十进制字符串，
 * 与 fx_rates 表的语义一致（fx_rates.base 固定 'USD'）。
 */

import { normalizeCurrency } from '@submgr/core';
import { DEFAULT_FX_API_BASE } from '../env.js';

export interface FxRatesPayload {
  rates: Record<string, string>;
  /** 实际抓取时刻（UTC ISO-8601），写进 fx_rates.fetched_at。 */
  fetchedAt: string;
  provider: string;
  /** 数据源自己标注的更新时间（如果有），仅用于排查。 */
  sourceUpdatedAt: string | null;
}

export interface FxRateSource {
  readonly name: string;
  fetchUsdRates(base: string): Promise<FxRatesPayload>;
}

/**
 * open.er-api.com 适配器。
 *
 * 响应形如：
 *   { "result":"success", "base_code":"USD", "time_last_update_utc":"...",
 *     "rates": { "USD":1, "CNY":7.142, ... } }
 * 只接受 result = "success"；任何异常都抛出，交给上层重试 / 记录。
 */
export class OpenErApiSource implements FxRateSource {
  readonly name = 'open.er-api.com';

  constructor(
    private readonly endpoint: string = DEFAULT_FX_API_BASE,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly timeoutMs = 10_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 把 endpoint 末尾的币种换成 base（默认就是 USD）。 */
  private urlFor(base: string): string {
    return this.endpoint.replace(/\/([A-Za-z]{3})$/, `/${base}`);
  }

  async fetchUsdRates(base: string): Promise<FxRatesPayload> {
    const url = this.urlFor(base);
    const response = await this.fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`汇率接口返回 HTTP ${response.status}`);
    }

    const body = (await response.json()) as Record<string, unknown>;
    if (body['result'] !== undefined && body['result'] !== 'success') {
      throw new Error(`汇率接口返回失败：result=${String(body['result'])}`);
    }

    const rawRates = body['rates'];
    if (rawRates === null || typeof rawRates !== 'object' || Array.isArray(rawRates)) {
      throw new Error('汇率接口响应里没有 rates 对象');
    }

    const rates: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawRates as Record<string, unknown>)) {
      let code: string;
      try {
        code = normalizeCurrency(key);
      } catch {
        continue; // 非三字母代码直接忽略
      }
      const text = decimalStringOf(value);
      if (text === null) continue;
      rates[code] = text;
    }

    if (Object.keys(rates).length === 0) {
      throw new Error('汇率接口返回了 0 条可用汇率');
    }

    const provider = typeof body['provider'] === 'string' ? body['provider'] : this.name;
    const sourceUpdatedAt =
      typeof body['time_last_update_utc'] === 'string'
        ? body['time_last_update_utc']
        : typeof body['time_last_update_unix'] === 'number'
          ? new Date(body['time_last_update_unix'] * 1000).toISOString()
          : null;

    return { rates, fetchedAt: this.now().toISOString(), provider, sourceUpdatedAt };
  }
}

/** number / string -> 十进制字符串；非法或非正数返回 null。 */
export function decimalStringOf(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || !/^[0-9]*\.?[0-9]+$/.test(trimmed)) return null;
    if (Number(trimmed) <= 0) return null;
    return trimmed;
  }
  return null;
}
