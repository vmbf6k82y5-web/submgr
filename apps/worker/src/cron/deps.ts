/**
 * Cron 的公共依赖与结构化日志。
 *
 * 所有外部副作用（fetch / 时钟 / sleep）都通过 CronDeps 注入，
 * 因此三个 Cron 都能在单元测试里完整跑通，不需要网络也不需要等真实时间。
 *
 * 「记录失败」的落点：migration 已冻结，没有作业日志表，
 * 所以失败的作业用结构化 JSON 写 Worker 日志（wrangler tail / Dashboard 可见），
 * 并且**不抛异常**——一次抓汇率失败不应该让整个 cron 事件标红。
 */

import type { FxRateSource } from './adapters.js';

export interface CronDeps {
  fetch: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** 覆盖默认汇率适配器（测试用）。 */
  fxSource?: FxRateSource;
  log: (level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) => void;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 结构化日志：一行一个 JSON，方便在 Worker 日志里按 event 过滤。 */
export function jsonLog(
  level: 'info' | 'warn' | 'error',
  event: string,
  data: Record<string, unknown> = {},
): void {
  const payload = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data });
  if (level === 'error') console.error(payload);
  else if (level === 'warn') console.warn(payload);
  else console.log(payload);
}

export function defaultCronDeps(): CronDeps {
  return {
    fetch: (...args) => fetch(...args),
    now: () => new Date(),
    sleep: realSleep,
    log: jsonLog,
  };
}
