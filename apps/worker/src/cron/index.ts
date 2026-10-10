/**
 * Cron 分发。
 *
 * 三个作业的触发时间（wrangler.toml 里的 cron 表达式是 **UTC**）：
 *   CRON_REMINDERS  每 15 分钟：扫描到期提醒 + 周期汇总
 *   CRON_FX         每天 00:20 Asia/Shanghai：拉汇率
 *   CRON_DAILY      每天 00:30 Asia/Shanghai：试用转正 + 生成当日扣款
 *
 * 为什么把「拉汇率」放在「生成扣款」之前：扣款要冻结当天的汇率，
 * 早 10 分钟跑完就能用上当天的快照（来不及也不会出错，只是当天金额留空待补）。
 *
 * 所有作业都**不抛异常**：失败会写结构化日志并返回 ok=false，
 * 这样一次网络抖动不会让整个 cron 事件标红，也不影响另外两个作业。
 */

import type { Env } from '../env.js';
import { defaultCronDeps, type CronDeps } from './deps.js';
import { runFxRefresh, type FxRefreshResult } from './fx.js';
import { runReminderScan, type ReminderScanResult } from './reminders.js';
import { runDailyJob, type DailyJobResult } from './charges.js';

export const CRON_FX = '20 16 * * *';
export const CRON_REMINDERS = '*/15 * * * *';
export const CRON_DAILY = '30 16 * * *';

export type CronJobName = 'fx' | 'reminders' | 'daily' | 'unknown';

export interface CronRunSummary {
  cron: string;
  job: CronJobName;
  ok: boolean;
  error: string | null;
  result: FxRefreshResult | ReminderScanResult | DailyJobResult | null;
}

/** 根据 cron 表达式判断该跑哪个作业。 */
export function jobForCron(cron: string): CronJobName {
  const normalized = cron.trim();
  if (normalized === CRON_FX) return 'fx';
  if (normalized === CRON_REMINDERS) return 'reminders';
  if (normalized === CRON_DAILY) return 'daily';
  return 'unknown';
}

export async function dispatchCron(
  cron: string,
  env: Env,
  deps: CronDeps = defaultCronDeps(),
): Promise<CronRunSummary> {
  const job = jobForCron(cron);

  if (job === 'unknown') {
    // 未知表达式不静默吞掉：写日志说明「这个 cron 没被处理」，
    // 避免 wrangler.toml 改了表达式却忘了同步常量这种问题被埋起来。
    deps.log('warn', 'cron.unknown', { cron });
    return { cron, job, ok: false, error: `未识别的 cron 表达式：${cron}`, result: null };
  }

  try {
    if (job === 'fx') {
      const result = await runFxRefresh(env, deps);
      return { cron, job, ok: result.ok, error: result.error, result };
    }
    if (job === 'reminders') {
      const result = await runReminderScan(env, deps);
      return { cron, job, ok: true, error: null, result };
    }
    const result = await runDailyJob(env, deps);
    return { cron, job, ok: true, error: null, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log('error', 'cron.crashed', { cron, job, error: message });
    return { cron, job, ok: false, error: message, result: null };
  }
}
