/**
 * Cron 测试的公共工具：可注入的依赖、可记录的 fetch、结构化日志收集。
 */

import type { CronDeps } from '../../src/cron/deps.js';

export interface RecordedLog {
  level: 'info' | 'warn' | 'error';
  event: string;
  data: Record<string, unknown>;
}

export interface RecordedCall {
  url: string;
  method: string | undefined;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

export interface TestDeps {
  deps: CronDeps;
  logs: RecordedLog[];
  sleeps: number[];
  calls: RecordedCall[];
  /** 按顺序取出某个 event 的日志数据。 */
  events(event: string): Record<string, unknown>[];
}

export interface MakeDepsOptions {
  /** 假 fetch：返回 Response，或抛错模拟网络故障。 */
  fetch?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  now?: () => Date;
  /** 默认不真的等待：sleep 只记录毫秒数。 */
  sleep?: (ms: number) => Promise<void>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function makeDeps(options: MakeDepsOptions = {}): TestDeps {
  const logs: RecordedLog[] = [];
  const sleeps: number[] = [];
  const calls: RecordedCall[] = [];

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v);

    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = { raw: init.body };
      }
    }
    calls.push({ url, method: init?.method, body, headers });

    if (!options.fetch) throw new Error(`测试没有配置假 fetch，却请求了 ${url}`);
    return options.fetch(url, init);
  }) as unknown as typeof fetch;

  const deps: CronDeps = {
    fetch: fetchImpl,
    now: options.now ?? (() => new Date()),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      if (options.sleep) await options.sleep(ms);
    },
    log: (level, event, data = {}) => {
      logs.push({ level, event, data });
    },
  };

  return {
    deps,
    logs,
    sleeps,
    calls,
    events: (event: string) => logs.filter((l) => l.event === event).map((l) => l.data),
  };
}

/** open.er-api.com 的成功响应体。 */
export function fxPayload(rates: Record<string, number | string>, extra: Record<string, unknown> = {}) {
  return {
    result: 'success',
    base_code: 'USD',
    time_last_update_utc: 'Sat, 10 Oct 2026 00:00:01 +0000',
    rates,
    ...extra,
  };
}
