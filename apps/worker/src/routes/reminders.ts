/**
 * /api/reminders —— 提醒规则（+ 发送日志）。
 *
 * 两类规则（migration 0005 用 rule_type 区分，字段要求完全不同）：
 *   due      到期提醒：到期日前 days_before 天的 at_time 发送；subscription_id 为空表示全局；
 *   schedule 周期汇总：每周 weekdays 或每 interval_days 天的 at_time 发送；必须是全局规则。
 * at_time 一律按 settings.timezone 解释。
 *
 * 本文件只做规则的读写；真正的调度与去重在 src/cron/reminders.ts。
 */

import { Hono } from 'hono';
import {
  REMINDER_RULE_TYPES,
  SCHEDULE_TYPES,
  nowIso,
  type ReminderLogRow,
  type ReminderRuleRow,
  type ScheduleType,
} from '@submgr/core';
import type { Env } from '../env.js';
import { allRows, firstRow, isConstraintViolation, runStmt } from '../lib/db.js';
import { invalid, notFound } from '../lib/errors.js';
import {
  has,
  optionalBool,
  optionalInt,
  optionalString,
  optionalTime,
  queryDateOnly,
  queryInt,
  readJson,
  optionalEnum,
  type JsonObject,
} from '../lib/validate.js';
import type { ReminderRuleType } from '@submgr/core';

export const reminderRoutes = new Hono<{ Bindings: Env }>();

interface RuleShape {
  subscription_id: string | null;
  rule_type: ReminderRuleType;
  days_before: number | null;
  at_time: string | null;
  schedule_type: ScheduleType | null;
  interval_days: number | null;
  weekdays: string | null;
  channel_id: string | null;
  enabled: 0 | 1;
}

/** weekdays 接受 [1,3,5] 或 '[1,3,5]'，统一存成 JSON 数组字符串。 */
function readWeekdays(body: JsonObject, fallback: string | null): string | null {
  if (!has(body, 'weekdays')) return fallback;
  const raw = body['weekdays'];
  if (raw === null) return null;

  let parsed: unknown;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalid('weekdays 必须是 JSON 数组，例如 [1,3,5]');
    }
  } else {
    parsed = raw;
  }

  if (!Array.isArray(parsed)) throw invalid('weekdays 必须是数组（1=周一 … 7=周日）');
  const days: number[] = [];
  for (const item of parsed) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 7) {
      throw invalid('weekdays 的元素必须是 1..7 的整数（ISO-8601，1=周一）');
    }
    if (!days.includes(item)) days.push(item);
  }
  if (days.length === 0) throw invalid('weekdays 不能是空数组');
  days.sort((a, b) => a - b);
  return JSON.stringify(days);
}

function readRule(body: JsonObject, current?: ReminderRuleRow): RuleShape {
  let ruleType: ReminderRuleType;
  if (has(body, 'rule_type')) ruleType = requiredRuleType(body, 'rule_type');
  else if (current) ruleType = current.rule_type;
  else throw invalid('字段 rule_type 是必填的：due / schedule');

  const subscriptionId = has(body, 'subscription_id')
    ? (optionalString(body, 'subscription_id', { max: 64 }) ?? null)
    : (current?.subscription_id ?? null);

  const daysBefore = has(body, 'days_before')
    ? (optionalInt(body, 'days_before', { min: 0, max: 3650 }) ?? null)
    : (current?.days_before ?? null);

  const atTime = has(body, 'at_time')
    ? (optionalTime(body, 'at_time') ?? null)
    : (current?.at_time ?? null);

  const scheduleType = has(body, 'schedule_type')
    ? (optionalEnum(body, 'schedule_type', SCHEDULE_TYPES) ?? null)
    : (current?.schedule_type ?? null);

  const intervalDays = has(body, 'interval_days')
    ? (optionalInt(body, 'interval_days', { min: 1, max: 3650 }) ?? null)
    : (current?.interval_days ?? null);

  const weekdays = readWeekdays(body, current?.weekdays ?? null);

  const channelId = has(body, 'channel_id')
    ? (optionalString(body, 'channel_id', { max: 64 }) ?? null)
    : (current?.channel_id ?? null);

  let enabled: 0 | 1;
  if (has(body, 'enabled')) enabled = optionalBool(body, 'enabled') === true ? 1 : 0;
  else if (current) enabled = current.enabled === 1 || current.enabled === true ? 1 : 0;
  else enabled = 1;

  return validateRuleShape({
    subscription_id: subscriptionId,
    rule_type: ruleType,
    days_before: daysBefore,
    at_time: atTime,
    schedule_type: scheduleType,
    interval_days: intervalDays,
    weekdays,
    channel_id: channelId,
    enabled,
  });
}

/** 与 migration 0005 的 CHECK 一一对应的形状校验。 */
export function validateRuleShape(rule: RuleShape): RuleShape {
  if (rule.rule_type === 'due') {
    if (rule.days_before === null) throw invalid('due 规则必须给出 days_before（0 表示到期当天）');
    if (rule.at_time === null) throw invalid('due 规则必须给出 at_time（HH:mm）');
    if (rule.schedule_type !== null) throw invalid('due 规则不能有 schedule_type');
    if (rule.interval_days !== null) throw invalid('due 规则不能有 interval_days');
    if (rule.weekdays !== null) throw invalid('due 规则不能有 weekdays');
    return rule;
  }

  // schedule
  if (rule.subscription_id !== null) {
    throw invalid('周期汇总规则是全局的：subscription_id 必须为空');
  }
  if (rule.days_before !== null) throw invalid('schedule 规则不能有 days_before');
  if (rule.schedule_type === null) throw invalid('schedule 规则必须给出 schedule_type');
  if (rule.at_time === null) throw invalid('schedule 规则必须给出 at_time（HH:mm）');

  if (rule.schedule_type === 'every_n_days') {
    if (rule.interval_days === null) throw invalid('every_n_days 必须给出 interval_days（正整数）');
    if (rule.weekdays !== null) throw invalid('every_n_days 不能有 weekdays');
  } else if (rule.schedule_type === 'weekly') {
    if (rule.weekdays === null) throw invalid('weekly 必须给出 weekdays（1=周一 … 7=周日）');
    if (rule.interval_days !== null) throw invalid('weekly 不能有 interval_days');
  }

  return rule;
}

async function assertSubscriptionExists(db: D1Database, id: string): Promise<void> {
  const row = await firstRow<{ id: string }>(
    db,
    `SELECT id FROM subscriptions WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  if (!row) throw invalid(`subscription_id 指向的订阅不存在或已删除：${id}`);
}

async function assertChannelExists(db: D1Database, id: string): Promise<void> {
  const row = await firstRow<{ id: string }>(
    db,
    `SELECT id FROM notification_channels WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  if (!row) throw invalid(`channel_id 指向的提醒渠道不存在：${id}`);
}

type RuleRowWithNames = ReminderRuleRow & {
  channel_name: string | null;
  subscription_name: string | null;
};

/** 规则的对外形态：enabled 变布尔、weekdays 变数组、附上渠道与订阅名。 */
function toRuleDto(row: RuleRowWithNames): Record<string, unknown> {
  return {
    ...row,
    enabled: row.enabled === 1 || row.enabled === true,
    weekdays: parseWeekdays(row.weekdays),
  };
}

/** 读一条规则并转成对外形态（POST/PATCH 的响应与 GET 保持一致）。 */
async function loadRuleDto(db: D1Database, id: string): Promise<Record<string, unknown>> {
  const row = await firstRow<RuleRowWithNames>(
    db,
    `SELECT r.*, ch.name AS channel_name, s.name AS subscription_name
       FROM reminder_rules r
       LEFT JOIN notification_channels ch ON ch.id = r.channel_id
       LEFT JOIN subscriptions s ON s.id = r.subscription_id
      WHERE r.id = ? AND r.deleted_at IS NULL`,
    [id],
  );
  if (!row) throw notFound(`提醒规则不存在或已删除：${id}`);
  return toRuleDto(row);
}

async function loadRule(db: D1Database, id: string): Promise<ReminderRuleRow> {
  const row = await firstRow<ReminderRuleRow>(
    db,
    `SELECT * FROM reminder_rules WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  if (!row) throw notFound(`提醒规则不存在或已删除：${id}`);
  return row;
}

// ---------------------------------------------------------------------------
// GET /api/reminders
// ---------------------------------------------------------------------------

reminderRoutes.get('/', async (c) => {
  const rows = await allRows<RuleRowWithNames>(
    c.env.DB,
    `SELECT r.*, ch.name AS channel_name, s.name AS subscription_name
       FROM reminder_rules r
       LEFT JOIN notification_channels ch ON ch.id = r.channel_id
       LEFT JOIN subscriptions s ON s.id = r.subscription_id
      WHERE r.deleted_at IS NULL
      ORDER BY r.rule_type ASC, r.created_at ASC`,
  );

  return c.json({ items: rows.map(toRuleDto) });
});

// ---------------------------------------------------------------------------
// GET /api/reminders/log（必须注册在 /:id 之前）
// ---------------------------------------------------------------------------

reminderRoutes.get('/log', async (c) => {
  const url = new URL(c.req.url);
  const where: string[] = ['l.deleted_at IS NULL'];
  const params: unknown[] = [];

  const ruleId = c.req.query('rule_id')?.trim();
  if (ruleId) {
    where.push('l.rule_id = ?');
    params.push(ruleId);
  }
  const subscriptionId = c.req.query('subscription_id')?.trim();
  if (subscriptionId) {
    where.push('l.subscription_id = ?');
    params.push(subscriptionId);
  }
  const from = queryDateOnly(url, 'from');
  if (from) {
    where.push('l.due_date >= ?');
    params.push(from);
  }
  const to = queryDateOnly(url, 'to');
  if (to) {
    where.push('l.due_date <= ?');
    params.push(to);
  }
  const limit = queryInt(url, 'limit', { fallback: 100, min: 1, max: 500 });

  const items = await allRows<ReminderLogRow & { rule_type: string | null }>(
    c.env.DB,
    `SELECT l.*, r.rule_type AS rule_type
       FROM reminder_log l LEFT JOIN reminder_rules r ON r.id = l.rule_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.due_date DESC, l.created_at DESC
      LIMIT ?`,
    [...params, limit],
  );

  return c.json({ items, limit });
});

// ---------------------------------------------------------------------------
// POST /api/reminders
// ---------------------------------------------------------------------------

reminderRoutes.post('/', async (c) => {
  const body = await readJson(c.req.raw);
  const rule = readRule(body);

  if (rule.subscription_id !== null) await assertSubscriptionExists(c.env.DB, rule.subscription_id);
  if (rule.channel_id !== null) await assertChannelExists(c.env.DB, rule.channel_id);

  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    await runStmt(
      c.env.DB,
      `INSERT INTO reminder_rules
         (id, subscription_id, rule_type, days_before, at_time, schedule_type, interval_days,
          weekdays, channel_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        rule.subscription_id,
        rule.rule_type,
        rule.days_before,
        rule.at_time,
        rule.schedule_type,
        rule.interval_days,
        rule.weekdays,
        rule.channel_id,
        rule.enabled,
        now,
        now,
      ],
    );
  } catch (err) {
    if (isConstraintViolation(err)) {
      throw invalid(`规则不满足数据库约束：${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  }

  return c.json({ item: await loadRuleDto(c.env.DB, id) }, 201);
});

// ---------------------------------------------------------------------------
// PATCH / DELETE /api/reminders/:id
// ---------------------------------------------------------------------------

reminderRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const current = await loadRule(c.env.DB, id);
  const body = await readJson(c.req.raw);
  const rule = readRule(body, current);

  if (rule.subscription_id !== null) await assertSubscriptionExists(c.env.DB, rule.subscription_id);
  if (rule.channel_id !== null) await assertChannelExists(c.env.DB, rule.channel_id);

  try {
    await runStmt(
      c.env.DB,
      `UPDATE reminder_rules SET
         subscription_id = ?, rule_type = ?, days_before = ?, at_time = ?, schedule_type = ?,
         interval_days = ?, weekdays = ?, channel_id = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
      [
        rule.subscription_id,
        rule.rule_type,
        rule.days_before,
        rule.at_time,
        rule.schedule_type,
        rule.interval_days,
        rule.weekdays,
        rule.channel_id,
        rule.enabled,
        nowIso(),
        id,
      ],
    );
  } catch (err) {
    if (isConstraintViolation(err)) {
      throw invalid(`规则不满足数据库约束：${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  }

  return c.json({ item: await loadRuleDto(c.env.DB, id) });
});

reminderRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await loadRule(c.env.DB, id);
  await runStmt(
    c.env.DB,
    `UPDATE reminder_rules SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    [nowIso(), nowIso(), id],
  );
  return c.json({ deleted: true, id });
});

// ---------------------------------------------------------------------------

function parseWeekdays(json: string | null): number[] | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as number[]) : null;
  } catch {
    return null;
  }
}

function requiredRuleType(body: JsonObject, field: string): ReminderRuleType {
  const raw = body[field];
  if (typeof raw !== 'string' || !(REMINDER_RULE_TYPES as readonly string[]).includes(raw)) {
    throw invalid(`字段 ${field} 必须是以下之一：${REMINDER_RULE_TYPES.join(' / ')}`);
  }
  return raw as ReminderRuleType;
}

