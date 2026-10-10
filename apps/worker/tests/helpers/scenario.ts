/**
 * 测试场景：一套覆盖全部业务形态的固定数据。
 *
 * 为什么日期相对「真实今天」生成：migration 里的价格版本冻结触发器用的是
 * SQLite 的 date('now')，如果测试里用假日期，触发器与接口对「已生效」的判断
 * 就会不一致。所以：
 *   * 把系统时间固定在「真实今天 02:00 UTC」（= Asia/Shanghai 当天 10:00），
 *     这样接口算出的 today、SQLite 的 date('now')、真实 UTC 日期三者一致；
 *   * 所有 fixture 日期都用 D(n) / M(n) 相对今天生成。
 */

import { vi } from 'vitest';
import {
  addDaysDateOnly,
  addMonthsKeepingAnchorDay,
  startOfMonthDateOnly,
  todayInTimeZone,
} from '@submgr/core';
import { app } from '../../src/index.js';
import type { Env } from '../../src/env.js';
import { FakeD1, execSql } from './d1.js';

// 方便测试文件只从 scenario 导入
export { execSql, queryAll, queryOne } from './d1.js';

// ---------------------------------------------------------------------------
// 时钟
// ---------------------------------------------------------------------------

/** 固定时钟：真实今天的 02:00:00Z（= 上海当天 10:00）。 */
export const CLOCK: Date = (() => {
  const d = new Date();
  d.setUTCHours(2, 0, 0, 0);
  return d;
})();

export const TODAY = CLOCK.toISOString().slice(0, 10);

/** 相对今天的日期。 */
export function D(offset: number): string {
  return addDaysDateOnly(TODAY, offset);
}

/** 相对「本月 1 号」的月份偏移（保持 1 号锚点，便于算周期）。 */
export function M(offset: number): string {
  return addMonthsKeepingAnchorDay(startOfMonthDateOnly(TODAY), offset, 1);
}

/** 相对今天的「锚点日 = day」的月份偏移。 */
export function MD(offset: number, day: number): string {
  return addMonthsKeepingAnchorDay(TODAY, offset, day);
}

export function useFixedClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(CLOCK);
}

export function restoreClock(): void {
  vi.useRealTimers();
}

/** 今天在用户时区下的 ISO 星期（1=周一 … 7=周日）。 */
export function isoWeekdayOfToday(): number {
  const day = new Date(`${TODAY}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export const TIMEZONE = 'Asia/Shanghai';

// ---------------------------------------------------------------------------
// 固定 id
// ---------------------------------------------------------------------------

export const ADMIN_TOKEN = 'test-admin-token';

export const CAT_MEDIA = '11111111-1111-4111-8111-000000000001';
export const CAT_CLOUD = '11111111-1111-4111-8111-000000000002';

export const CH_FEISHU = '22222222-2222-4222-8222-000000000001';
export const CH_TELEGRAM = '22222222-2222-4222-8222-000000000002';
export const CH_MISSING_SECRET = '22222222-2222-4222-8222-000000000003';

export const SUB_MONTHLY = '33333333-3333-4333-8333-000000000001';
export const SUB_ANNUAL = '33333333-3333-4333-8333-000000000002';
export const SUB_TRIAL_TODAY = '33333333-3333-4333-8333-000000000003';
export const SUB_TRIAL_FUTURE = '33333333-3333-4333-8333-000000000004';
export const SUB_LIFETIME = '33333333-3333-4333-8333-000000000005';
export const SUB_DUE_TODAY = '33333333-3333-4333-8333-000000000006';
export const SUB_MANUAL_OVERDUE = '33333333-3333-4333-8333-000000000007';
export const SUB_CANCELLED = '33333333-3333-4333-8333-000000000008';

export const V_MONTHLY = '44444444-4444-4444-8444-000000000001';
export const V_ANNUAL = '44444444-4444-4444-8444-000000000002';
export const V_TRIAL_TODAY = '44444444-4444-4444-8444-000000000003';
export const V_TRIAL_FUTURE = '44444444-4444-4444-8444-000000000004';
export const V_LIFETIME = '44444444-4444-4444-8444-000000000005';
export const V_DUE_TODAY = '44444444-4444-4444-8444-000000000006';
export const V_MANUAL_OVERDUE = '44444444-4444-4444-8444-000000000007';
export const V_CANCELLED = '44444444-4444-4444-8444-000000000008';

export const R_DUE_GLOBAL = '55555555-5555-4555-8555-000000000001';
export const R_DUE_TRIAL = '55555555-5555-4555-8555-000000000002';
export const R_SCHED_WEEKLY = '55555555-5555-4555-8555-000000000003';
export const R_SCHED_EVERY15 = '55555555-5555-4555-8555-000000000004';
export const R_DISABLED = '55555555-5555-4555-8555-000000000005';
export const R_FUTURE_TIME = '55555555-5555-4555-8555-000000000006';
export const R_MISSING_SECRET = '55555555-5555-4555-8555-000000000007';

/** 测试环境：ADMIN_TOKEN 固定，渠道密钥都放在 env 里（不入库）。 */
export function makeEnv(db: FakeD1, overrides: Record<string, unknown> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    ADMIN_TOKEN,
    FEISHU_TEST: JSON.stringify({
      webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-hook',
      sign_secret: 'test-sign-secret',
    }),
    TELEGRAM_TEST: JSON.stringify({ bot_token: '123456:TESTTOKEN', chat_id: '999' }),
    ...overrides,
  } as unknown as Env;
}

/** 发一个请求到 Hono app（默认带正确令牌）。 */
export async function call(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  opts: { token?: string | null; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const token = opts.token === undefined ? ADMIN_TOKEN : opts.token;
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return app.request(path, { method, headers, ...(payload === undefined ? {} : { body: payload }) }, env);
}

export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** 常用断言辅助：调用接口并断言状态码，顺便把 body 读出来。 */
export async function callJson<T = Record<string, unknown>>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  expectedStatus = 200,
): Promise<T> {
  const response = await call(env, method, path, body);
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`期望 HTTP ${expectedStatus}，实际 ${response.status}：${text}`);
  }
  return (text === '' ? {} : JSON.parse(text)) as T;
}

// ---------------------------------------------------------------------------
// 场景数据
// ---------------------------------------------------------------------------

export function seedScenario(db: FakeD1): void {
  const now = `${TODAY}T00:00:00.000Z`;
  const month3ago = M(-3);
  const monthlyStart = MD(-1, 10); // 上月 10 号 -> 今天（本月 10 号）正好到期
  const trialStartToday = D(-14);
  const trialStartFuture = D(-10);
  const lifetimeStart = M(-24);
  const cancelledStart = M(-6);

  execSql(
    db,
    `
INSERT INTO settings (id, base_currency, timezone, ics_token, amortize_lifetime_months, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'CNY', '${TIMEZONE}', 'ics-token-for-tests-0123456789', 36, '${now}', '${now}');

INSERT INTO categories (id, name, color, sort, created_at, updated_at) VALUES
  ('${CAT_MEDIA}', '影音娱乐', '#ef4444', 10, '${now}', '${now}'),
  ('${CAT_CLOUD}', '云服务',   '#0ea5e9', 20, '${now}', '${now}');

INSERT INTO notification_channels (id, type, name, config_json, secret_ref, created_at, updated_at) VALUES
  ('${CH_FEISHU}', 'feishu', '飞书 · 测试', '{}', 'FEISHU_TEST', '${now}', '${now}'),
  ('${CH_TELEGRAM}', 'telegram', 'Telegram · 测试', '{"chat_id":"999"}', 'TELEGRAM_TEST', '${now}', '${now}'),
  ('${CH_MISSING_SECRET}', 'feishu', '飞书 · 密钥缺失', '{}', 'MISSING_SECRET', '${now}', '${now}');

INSERT INTO subscriptions
  (id, name, category_id, sub_type, charge_channel, renew_mode, start_date, end_date, cancelled_at, note, created_at, updated_at)
VALUES
  ('${SUB_MONTHLY}', 'Netflix 高级会员', '${CAT_MEDIA}', 'media', 'card', 'auto', '${month3ago}', NULL, NULL, '外币月付', '${now}', '${now}'),
  ('${SUB_ANNUAL}', 'iCloud+ 2TB', '${CAT_CLOUD}', 'cloud', 'apple', 'auto', '${M(-11)}', NULL, NULL, '年付', '${now}', '${now}'),
  ('${SUB_TRIAL_TODAY}', 'Notion Plus', NULL, 'software', 'card', 'auto', '${trialStartToday}', NULL, NULL, '今天转正', '${now}', '${now}'),
  ('${SUB_TRIAL_FUTURE}', 'Figma 专业版', NULL, 'software', 'card', 'auto', '${trialStartFuture}', NULL, NULL, '试用中', '${now}', '${now}'),
  ('${SUB_LIFETIME}', 'JetBrains 全家桶', NULL, 'software', 'alipay', 'manual', '${lifetimeStart}', NULL, NULL, '终身', '${now}', '${now}'),
  ('${SUB_DUE_TODAY}', 'Spotify 家庭版', '${CAT_MEDIA}', 'media', 'wechat', 'auto', '${monthlyStart}', NULL, NULL, '今天到期', '${now}', '${now}'),
  ('${SUB_MANUAL_OVERDUE}', '得到年度会员', NULL, 'membership', 'alipay', 'manual', '${month3ago}', NULL, NULL, '手动续费忘了', '${now}', '${now}'),
  ('${SUB_CANCELLED}', '已取消的订阅', '${CAT_MEDIA}', 'media', 'apple', 'auto', '${cancelledStart}', NULL, '${D(-1)}T00:00:00.000Z', '已取消', '${now}', '${now}');

INSERT INTO subscription_versions
  (id, subscription_id, effective_from, plan_name, amount_minor, currency, cycle_type, cycle_days,
   is_trial, trial_end_date, after_trial_amount_minor, after_trial_currency, after_trial_cycle_type,
   after_trial_cycle_days, created_at, updated_at)
VALUES
  ('${V_MONTHLY}', '${SUB_MONTHLY}', '${month3ago}', 'Premium 4K', 2299, 'USD', 'month', NULL,
   0, NULL, NULL, NULL, NULL, NULL, '${now}', '${now}'),
  ('${V_ANNUAL}', '${SUB_ANNUAL}', '${M(-11)}', 'iCloud+ 2TB 年付', 81600, 'CNY', 'year', NULL,
   0, NULL, NULL, NULL, NULL, NULL, '${now}', '${now}'),
  ('${V_TRIAL_TODAY}', '${SUB_TRIAL_TODAY}', '${trialStartToday}', 'Plus 试用', 0, 'CNY', 'month', NULL,
   1, '${D(0)}', 9900, 'CNY', 'month', NULL, '${now}', '${now}'),
  ('${V_TRIAL_FUTURE}', '${SUB_TRIAL_FUTURE}', '${trialStartFuture}', 'Figma 试用', 0, 'CNY', 'month', NULL,
   1, '${D(4)}', 5000, 'CNY', 'month', NULL, '${now}', '${now}'),
  ('${V_LIFETIME}', '${SUB_LIFETIME}', '${lifetimeStart}', 'All Products Pack', 214800, 'CNY', 'lifetime', NULL,
   0, NULL, NULL, NULL, NULL, NULL, '${now}', '${now}'),
  ('${V_DUE_TODAY}', '${SUB_DUE_TODAY}', '${monthlyStart}', '家庭版', 3000, 'CNY', 'month', NULL,
   0, NULL, NULL, NULL, NULL, NULL, '${now}', '${now}'),
  ('${V_MANUAL_OVERDUE}', '${SUB_MANUAL_OVERDUE}', '${month3ago}', '年度会员', 2500, 'CNY', 'month', NULL,
   0, NULL, NULL, NULL, NULL, NULL, '${now}', '${now}'),
  ('${V_CANCELLED}', '${SUB_CANCELLED}', '${cancelledStart}', '已取消', 1200, 'CNY', 'month', NULL,
   0, NULL, NULL, NULL, NULL, NULL, '${now}', '${now}');

-- Netflix 四期扣款，每期冻结了各自的汇率（7.1200 是今天的价）
INSERT INTO charges
  (id, subscription_id, version_id, charge_date, amount_minor, currency, fx_rate_to_base,
   base_currency, base_amount_minor, source, status, created_at, updated_at)
VALUES
  ('66666666-6666-4666-8666-000000000001', '${SUB_MONTHLY}', '${V_MONTHLY}', '${M(-3)}', 2299, 'USD', '7.0500', 'CNY', 16208, 'auto', 'paid', '${now}', '${now}'),
  ('66666666-6666-4666-8666-000000000002', '${SUB_MONTHLY}', '${V_MONTHLY}', '${M(-2)}', 2299, 'USD', '7.1000', 'CNY', 16323, 'auto', 'paid', '${now}', '${now}'),
  ('66666666-6666-4666-8666-000000000003', '${SUB_MONTHLY}', '${V_MONTHLY}', '${M(-1)}', 2299, 'USD', '7.1500', 'CNY', 16438, 'auto', 'paid', '${now}', '${now}'),
  ('66666666-6666-4666-8666-000000000004', '${SUB_MONTHLY}', '${V_MONTHLY}', '${M(0)}', 2299, 'USD', '7.1200', 'CNY', 16369, 'auto', 'paid', '${now}', '${now}'),
  ('66666666-6666-4666-8666-000000000005', '${SUB_LIFETIME}', '${V_LIFETIME}', '${lifetimeStart}', 214800, 'CNY', '1', 'CNY', 214800, 'manual', 'paid', '${now}', '${now}');

INSERT INTO fx_rates (date, base, currency, rate, fetched_at, created_at, updated_at) VALUES
  ('${D(-1)}', 'USD', 'CNY', '7.0500', '${D(-1)}T01:00:00.000Z', '${now}', '${now}'),
  ('${D(-1)}', 'USD', 'EUR', '0.9100', '${D(-1)}T01:00:00.000Z', '${now}', '${now}'),
  ('${D(-1)}', 'USD', 'JPY', '148.0000', '${D(-1)}T01:00:00.000Z', '${now}', '${now}'),
  ('${TODAY}', 'USD', 'CNY', '7.1200', '${TODAY}T01:00:00.000Z', '${now}', '${now}'),
  ('${TODAY}', 'USD', 'EUR', '0.9200', '${TODAY}T01:00:00.000Z', '${now}', '${now}'),
  ('${TODAY}', 'USD', 'JPY', '149.5000', '${TODAY}T01:00:00.000Z', '${now}', '${now}');

INSERT INTO reminder_rules
  (id, subscription_id, rule_type, days_before, at_time, schedule_type, interval_days, weekdays, channel_id, enabled, created_at, updated_at)
VALUES
  ('${R_DUE_GLOBAL}', NULL, 'due', 0, '09:00', NULL, NULL, NULL, '${CH_FEISHU}', 1, '${now}', '${now}'),
  ('${R_DUE_TRIAL}', '${SUB_TRIAL_FUTURE}', 'due', 4, '09:00', NULL, NULL, NULL, '${CH_TELEGRAM}', 1, '${now}', '${now}'),
  ('${R_SCHED_WEEKLY}', NULL, 'schedule', NULL, '09:00', 'weekly', NULL, '[${isoWeekdayOfToday()}]', '${CH_TELEGRAM}', 1, '${now}', '${now}'),
  ('${R_SCHED_EVERY15}', NULL, 'schedule', NULL, '09:00', 'every_n_days', 15, NULL, '${CH_FEISHU}', 1, '${D(-15)}T00:00:00.000Z', '${now}'),
  ('${R_DISABLED}', NULL, 'due', 0, '09:00', NULL, NULL, NULL, '${CH_FEISHU}', 0, '${now}', '${now}'),
  ('${R_FUTURE_TIME}', NULL, 'due', 0, '23:59', NULL, NULL, NULL, '${CH_FEISHU}', 1, '${now}', '${now}'),
  ('${R_MISSING_SECRET}', '${SUB_DUE_TODAY}', 'due', 0, '09:00', NULL, NULL, NULL, '${CH_MISSING_SECRET}', 1, '${now}', '${now}');
`,
  );
}

/** 新建一个干净的场景数据库。 */
export function scenarioDb(): FakeD1 {
  const db = new FakeD1();
  seedScenario(db);
  return db;
}

/** 场景里「今天到期」的订阅（用于断言）。 */
export const DUE_TODAY_SUBSCRIPTIONS = [SUB_DUE_TODAY, SUB_TRIAL_TODAY];

/** 场景里今天的真实日期（断言里用）。 */
export const TODAY_IN_TZ = todayInTimeZone(TIMEZONE, CLOCK);
