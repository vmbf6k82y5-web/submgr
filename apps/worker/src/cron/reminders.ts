/**
 * Cron ②：每 15 分钟扫描「到期提醒」与「周期汇总提醒」。
 *
 * 去重（需求硬性要求）：靠 reminder_log。
 *   - 发送成功才写 result = 'sent' 的行，数据库的部分唯一索引
 *     ux_reminder_log_dedupe (rule_id, due_date) WHERE result = 'sent'
 *     保证「同一规则 + 同一到期日」只会成功发一次；
 *   - 发送失败写 result = 'failed' 的行（可以有多次），下一轮自动重试；
 *   - 因为每 15 分钟就会跑一次，重复命中「已经发过」时不写 skipped 行，
 *     只在返回值里体现，避免 reminder_log 被无意义的行撑大。
 *
 * 到点判定：at_time 按 settings.timezone 解释；当前本地时间 >= at_time 才发，
 * 早于 at_time 直接跳过（不写任何日志）。这样即使 cron 在 09:00 那一次抖动没跑成，
 * 09:15 的那次也会补发。
 */

import {
  UPCOMING_WINDOW_DAYS,
  addDaysDateOnly,
  convert,
  diffDaysDateOnly,
  formatMinorAmount,
  nowIso,
  parseDateOnly,
  timeInTimeZoneToHHmm,
  todayInTimeZone,
  type ChargeRow,
  type FxSnapshot,
  type NotificationChannelRow,
  type ReminderRuleRow,
  type SubscriptionRow,
  type SubscriptionVersionRow,
} from '@submgr/core';
import type { Env } from '../env.js';
import { allRows, firstRow, isUniqueViolation, runStmt } from '../lib/db.js';
import { ensureSettings } from '../lib/settings.js';
import { upcomingDues } from '../lib/upcoming.js';
import { loadFx } from '../lib/world.js';
import { sendToChannel } from '../notify/send.js';
import {
  buildDueListReminderText,
  buildDueReminderText,
  buildSummaryReminderText,
  type SummaryLine,
} from '../notify/messages.js';
import { defaultCronDeps, type CronDeps } from './deps.js';

export type ReminderOutcomeResult = 'sent' | 'failed' | 'skipped';

export interface ReminderOutcome {
  rule_id: string;
  rule_type: string;
  subscription_id: string | null;
  due_date: string;
  result: ReminderOutcomeResult;
  reason: string | null;
}

export interface ReminderScanResult {
  today: string;
  local_time: string;
  rules_checked: number;
  sent: number;
  failed: number;
  skipped: number;
  outcomes: ReminderOutcome[];
}

/** 汇总提醒向前看的窗口（与 /api/summary 的「未来 30 天」同一口径）。 */
export const SUMMARY_WINDOW_DAYS = UPCOMING_WINDOW_DAYS;

export async function runReminderScan(
  env: Env,
  deps: CronDeps = defaultCronDeps(),
): Promise<ReminderScanResult> {
  const settings = await ensureSettings(env.DB);
  const now = deps.now();
  const today = todayInTimeZone(settings.timezone, now);
  const localTime = timeInTimeZoneToHHmm(now, settings.timezone);

  const [rules, channels, subscriptions, versions, charges, fx] = await Promise.all([
    allRows<ReminderRuleRow>(
      env.DB,
      `SELECT * FROM reminder_rules WHERE deleted_at IS NULL AND enabled = 1
        ORDER BY created_at ASC`,
    ),
    allRows<NotificationChannelRow>(
      env.DB,
      `SELECT * FROM notification_channels WHERE deleted_at IS NULL`,
    ),
    allRows<SubscriptionRow>(env.DB, `SELECT * FROM subscriptions WHERE deleted_at IS NULL`),
    allRows<SubscriptionVersionRow>(
      env.DB,
      `SELECT * FROM subscription_versions WHERE deleted_at IS NULL`,
    ),
    allRows<ChargeRow>(env.DB, `SELECT * FROM charges WHERE deleted_at IS NULL`),
    loadFx(env.DB),
  ]);

  const channelById = new Map(channels.map((c) => [c.id, c]));
  const outcomes: ReminderOutcome[] = [];
  const warnedNoAtTime = new Set<string>();

  for (const rule of rules) {
    if (rule.at_time === null || rule.at_time === undefined) {
      // 防御分支：migration 0005 的 CHECK 与 routes/reminders.ts 都要求 due/schedule 规则
      // 必须有 at_time，所以正常路径到不了这里；只有「规则类型被非法改动 / 未来新增
      // 规则类型忘了同步」之类漏网数据才会命中。命中时不能静默跳过：一轮扫描里按
      // 规则 id 去重后只记一条 warn。
      if (!warnedNoAtTime.has(rule.id)) {
        warnedNoAtTime.add(rule.id);
        deps.log('warn', 'cron.reminder.no_at_time', {
          rule_id: rule.id,
          rule_type: rule.rule_type,
          reason: '规则的 at_time 为空（正常数据不应出现），该规则不会触发提醒',
        });
      }
      continue;
    }
    // 还没到当天的提醒时刻：直接跳过，不写日志
    if (localTime < rule.at_time) continue;

    if (rule.rule_type === 'due') {
      const daysBefore = rule.days_before ?? 0;
      const target = addDaysDateOnly(today, daysBefore);
      const candidates = rule.subscription_id
        ? subscriptions.filter((s) => s.id === rule.subscription_id)
        : subscriptions;

      // 区间 (target-1, target]：正好只取「到期日 == target」的那些
      const dues = upcomingDues({
        today: addDaysDateOnly(target, -1),
        from: addDaysDateOnly(target, -1),
        to: target,
        subscriptions: candidates,
        versions,
        charges,
      });
      if (dues.length === 0) continue;

      const channel = rule.channel_id ? (channelById.get(rule.channel_id) ?? null) : null;

      if (dues.length === 1) {
        const due = dues[0] as (typeof dues)[number];
        const text = buildDueReminderText({
          subscription: due.subscription,
          dueDate: due.dueDate,
          today,
          amountMinor: due.amountMinor,
          currency: due.currency,
          cycleType: due.version.cycle_type,
        });
        outcomes.push(
          await deliver(env, deps, {
            rule,
            channel,
            subscriptionId: due.subscription.id,
            dueDate: due.dueDate,
            text,
          }),
        );
        continue;
      }

      // 全局规则可能一次命中同一天的多个订阅。去重键是 (rule_id, due_date)，
      // 所以必须合并成一条，否则第二条会被去重挡掉（见 buildDueListReminderText 注释）。
      const text = buildDueListReminderText({
        targetDate: target,
        today,
        lines: dues.map((due) => ({
          name: due.subscription.name,
          amountText: formatMinorAmount(due.amountMinor, due.currency),
          channel: due.subscription.charge_channel,
        })),
      });
      outcomes.push(
        await deliver(env, deps, {
          rule,
          channel,
          subscriptionId: null,
          dueDate: target,
          text,
        }),
      );
      continue;
    }

    // ---- 周期汇总 ----
    if (!scheduleFires(rule, today, settings.timezone)) continue;

    const dues = upcomingDues({
      today,
      from: today,
      to: addDaysDateOnly(today, SUMMARY_WINDOW_DAYS),
      subscriptions,
      versions,
      charges,
    });

    const lines: SummaryLine[] = dues.map((due) => ({
      dueDate: due.dueDate,
      name: due.subscription.name,
      amountText: formatMinorAmount(due.amountMinor, due.currency),
      channel: due.subscription.charge_channel,
    }));

    const { totalMinor, missingCurrencies } = sumInBase(dues, settings.base_currency, fx);

    const text = buildSummaryReminderText({
      today,
      windowDays: SUMMARY_WINDOW_DAYS,
      baseCurrency: settings.base_currency,
      lines,
      totalMinor,
      missingCurrencies,
    });

    outcomes.push(
      await deliver(env, deps, {
        rule,
        channel: rule.channel_id ? (channelById.get(rule.channel_id) ?? null) : null,
        subscriptionId: null,
        dueDate: today,
        text,
      }),
    );
  }

  const result: ReminderScanResult = {
    today,
    local_time: localTime,
    rules_checked: rules.length,
    sent: outcomes.filter((o) => o.result === 'sent').length,
    failed: outcomes.filter((o) => o.result === 'failed').length,
    skipped: outcomes.filter((o) => o.result === 'skipped').length,
    outcomes,
  };
  deps.log('info', 'cron.reminders.done', {
    today: result.today,
    local_time: result.local_time,
    rules_checked: result.rules_checked,
    sent: result.sent,
    failed: result.failed,
    skipped: result.skipped,
  });
  return result;
}

/** 周期汇总规则今天该不该发。 */
export function scheduleFires(rule: ReminderRuleRow, today: string, timeZone: string): boolean {
  if (rule.schedule_type === 'weekly') {
    const days = parseWeekdays(rule.weekdays);
    return days.includes(isoWeekday(today));
  }
  if (rule.schedule_type === 'every_n_days') {
    const interval = rule.interval_days;
    if (typeof interval !== 'number' || !Number.isInteger(interval) || interval <= 0) return false;
    // 锚点 = 规则创建日（用户时区）。创建日那天 diff = 0，会被整除，所以当天就会发一次。
    const anchor = todayInTimeZone(timeZone, new Date(rule.created_at));
    const diff = diffDaysDateOnly(today, anchor);
    if (diff < 0) return false;
    return diff % interval === 0;
  }
  return false;
}

/** ISO-8601 星期：1=周一 … 7=周日。 */
export function isoWeekday(dateOnly: string): number {
  const day = parseDateOnly(dateOnly).getDay(); // 0=周日
  return day === 0 ? 7 : day;
}

function parseWeekdays(json: string | null | undefined): number[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => typeof v === 'number' && v >= 1 && v <= 7);
  } catch {
    return [];
  }
}

/** 把到期清单折算成基准币种合计（缺汇率时返回 null + 缺的币种）。 */
export function sumInBase(
  dues: readonly { amountMinor: number; currency: string }[],
  baseCurrency: string,
  /** 与 core 的 convert() 一样，既接受完整快照，也接受裸 rates 表 */
  rates: FxSnapshot | Readonly<Record<string, string>>,
): { totalMinor: number | null; missingCurrencies: string[] } {
  const missing = new Set<string>();
  let total = 0;
  let failed = false;
  for (const due of dues) {
    const converted = convert(due.amountMinor, due.currency, baseCurrency, rates);
    if (converted === null) {
      failed = true;
      missing.add(due.currency);
      continue;
    }
    total += converted;
  }
  return {
    totalMinor: failed ? null : total,
    missingCurrencies: [...missing].sort(),
  };
}

interface DeliverInput {
  rule: ReminderRuleRow;
  channel: NotificationChannelRow | null;
  subscriptionId: string | null;
  dueDate: string;
  text: string;
}

/** 单条提醒的发送 + 去重 + 写日志。 */
async function deliver(env: Env, deps: CronDeps, input: DeliverInput): Promise<ReminderOutcome> {
  const { rule, channel, subscriptionId, dueDate, text } = input;

  const alreadySent = await firstRow<{ id: string }>(
    env.DB,
    `SELECT id FROM reminder_log
      WHERE rule_id = ? AND due_date = ? AND result = 'sent' AND deleted_at IS NULL`,
    [rule.id, dueDate],
  );
  if (alreadySent) {
    return {
      rule_id: rule.id,
      rule_type: rule.rule_type,
      subscription_id: subscriptionId,
      due_date: dueDate,
      result: 'skipped',
      reason: 'reminder_log 里已有成功记录（去重）',
    };
  }

  if (!channel) {
    const reason = rule.channel_id
      ? `提醒渠道不存在或已删除：${rule.channel_id}`
      : '提醒规则没有绑定任何渠道';
    await writeLog(env, rule.id, subscriptionId, dueDate, 'failed', null);
    deps.log('error', 'cron.reminder.failed', { rule_id: rule.id, due_date: dueDate, reason });
    return {
      rule_id: rule.id,
      rule_type: rule.rule_type,
      subscription_id: subscriptionId,
      due_date: dueDate,
      result: 'failed',
      reason,
    };
  }

  const sentAt = nowIso(deps.now());
  const sendResult = await sendToChannel(env, channel, text, {
    fetch: deps.fetch,
    now: deps.now,
  });

  if (!sendResult.ok) {
    await writeLog(env, rule.id, subscriptionId, dueDate, 'failed', null);
    deps.log('error', 'cron.reminder.failed', {
      rule_id: rule.id,
      channel: channel.name,
      due_date: dueDate,
      reason: sendResult.error,
    });
    return {
      rule_id: rule.id,
      rule_type: rule.rule_type,
      subscription_id: subscriptionId,
      due_date: dueDate,
      result: 'failed',
      reason: sendResult.error,
    };
  }

  try {
    await writeLog(env, rule.id, subscriptionId, dueDate, 'sent', sentAt);
  } catch (err) {
    // 并发（两个 cron 实例同时跑）撞上 ux_reminder_log_dedupe：说明别人已经发成功了
    if (isUniqueViolation(err)) {
      return {
        rule_id: rule.id,
        rule_type: rule.rule_type,
        subscription_id: subscriptionId,
        due_date: dueDate,
        result: 'skipped',
        reason: '并发发送：已经有成功记录了',
      };
    }
    throw err;
  }

  deps.log('info', 'cron.reminder.sent', {
    rule_id: rule.id,
    channel: channel.name,
    subscription_id: subscriptionId,
    due_date: dueDate,
  });
  return {
    rule_id: rule.id,
    rule_type: rule.rule_type,
    subscription_id: subscriptionId,
    due_date: dueDate,
    result: 'sent',
    reason: null,
  };
}

async function writeLog(
  env: Env,
  ruleId: string,
  subscriptionId: string | null,
  dueDate: string,
  result: 'sent' | 'failed' | 'skipped',
  sentAt: string | null,
): Promise<void> {
  await runStmt(
    env.DB,
    `INSERT INTO reminder_log
       (id, rule_id, subscription_id, due_date, sent_at, result, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), ruleId, subscriptionId, dueDate, sentAt, result, nowIso(), nowIso()],
  );
}
