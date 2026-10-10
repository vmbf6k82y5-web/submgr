/**
 * /ics/:token.ics —— 日历订阅（RFC 5545）。
 *
 * 需求要点：
 *   * 未来 12 个月的到期事件；
 *   * 全天事件（DTSTART/DTEND 用 VALUE=DATE，DTEND 是次日，符合 RFC 的「右开」）；
 *   * 带 VALARM 提醒；
 *   * UID = subscription_id + due_date 拼出来 —— 只跟数据有关，
 *     所以每次重新生成都完全一样，日历客户端不会把同一期到期当成新事件；
 *   * 不走 Bearer 鉴权：日历客户端没法带自定义头，令牌放在 URL 路径里。
 *     令牌错/没配置一律 404，不返回「令牌错误」这类可试探的信息。
 */

import { Hono } from 'hono';
import {
  addDaysDateOnly,
  addMonthsKeepingAnchorDay,
  chargeChannelLabel,
  cycleTypeLabel,
  dayOfMonth,
  formatMinorAmount,
  todayInTimeZone,
  type ChargeRow,
  type SettingsRow,
  type SubscriptionRow,
  type SubscriptionVersionRow,
} from '@submgr/core';
import type { Env } from './env.js';
import { notFound } from './lib/errors.js';
import { upcomingDues } from './lib/upcoming.js';
import { loadCharges, loadSubscriptions, loadVersions } from './lib/world.js';
import { loadSettings, timingSafeEqual } from './lib/settings.js';

export const icsRoutes = new Hono<{ Bindings: Env }>();

/** 日历向前看的月数。 */
export const ICS_WINDOW_MONTHS = 12;

/** 全天事件默认提前多久提醒（RFC 5545 duration，P1D = 提前一天）。 */
export const ICS_ALARM_OFFSET = '-P1D';

export interface IcsEvent {
  uid: string;
  /** YYYY-MM-DD */
  date: string;
  summary: string;
  description: string;
  alarmOffset: string;
}

// ---------------------------------------------------------------------------
// 文本处理
// ---------------------------------------------------------------------------

/** RFC 5545 的 TEXT 转义：反斜杠、分号、逗号、换行。 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** 一个 code point 的 UTF-8 字节数。 */
function utf8Size(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * 按 RFC 5545 折行：一行不超过 75 个八位组，续行以单个空格开头。
 *
 * 必须按「八位组」而不是「字符」计数，否则中文（3 字节）会超长；
 * 也绝不能把一个多字节字符从中间切开，否则整个日历解析失败。
 */
export function foldIcsLine(line: string): string {
  const chars = [...line];
  const chunks: string[] = [];
  let current = '';
  let size = 0;

  for (const ch of chars) {
    const charSize = utf8Size(ch.codePointAt(0) ?? 0);
    // 第 1 行限制 75 字节；续行的开头空格也算在内，所以同样是 75
    if (size + charSize > 75 && current !== '') {
      chunks.push(current);
      current = ` ${ch}`;
      size = 1 + charSize;
    } else {
      current += ch;
      size += charSize;
    }
  }
  chunks.push(current);
  return chunks.join('\r\n');
}

/** Date -> ICS 的 UTC 时间戳格式 YYYYMMDDTHHMMSSZ。 */
export function icsTimestamp(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** YYYY-MM-DD -> YYYYMMDD。 */
export function icsDate(dateOnly: string): string {
  return dateOnly.replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// 事件生成（纯函数，方便单测）
// ---------------------------------------------------------------------------

export interface IcsBuildInput {
  today: string;
  subscriptions: readonly SubscriptionRow[];
  versions: readonly SubscriptionVersionRow[];
  charges: readonly ChargeRow[];
  settings: SettingsRow;
}

/**
 * 生成未来 12 个月的到期事件。
 *
 * 到期清单来自 lib/upcoming.ts 的 upcomingDues()——与提醒、汇总共用同一份算法，
 * 保证「日历里有的，提醒里也有」。
 */
export function buildDueEvents(input: IcsBuildInput): IcsEvent[] {
  const { today, subscriptions, versions, charges } = input;
  const windowEnd = addMonthsKeepingAnchorDay(today, ICS_WINDOW_MONTHS, dayOfMonth(today));
  // dueDatesBetween 是左开右闭 (from, to]；这里把 from 放到昨天，把「今天」也包含进来。
  const windowStart = addDaysDateOnly(today, -1);

  const dues = upcomingDues({
    today,
    from: windowStart,
    to: windowEnd,
    subscriptions,
    versions,
    charges,
  });

  const events: IcsEvent[] = dues.map(({ subscription: sub, version, dueDate, amountMinor, currency }) => {
    const amountText = formatMinorAmount(amountMinor, currency);
    const channelText = chargeChannelLabel(sub.charge_channel);
    const cycleText = cycleTypeLabel(version.cycle_type);

    return {
      // 需求原文：UID 用 subscription_id + due_date 拼；不含时间戳，重新生成不变
      uid: `${sub.id}-${dueDate}`,
      date: dueDate,
      summary: `${sub.name} 到期`,
      description: [
        `订阅：${sub.name}`,
        `到期日：${dueDate}`,
        `金额：${amountText}（${cycleText}）`,
        `扣费渠道：${channelText}`,
        `续费方式：${sub.renew_mode === 'auto' ? '自动续费' : '手动续费'}`,
      ].join('\n'),
      alarmOffset: ICS_ALARM_OFFSET,
    };
  });

  // 输出顺序稳定：先按日期，再按 UID，保证日历 diff 不产生噪声
  events.sort((a, b) => (a.date === b.date ? (a.uid < b.uid ? -1 : 1) : a.date < b.date ? -1 : 1));
  return events;
}

export interface BuildCalendarOptions {
  now: Date;
  calendarName: string;
  timezone?: string;
}

/** 把事件渲染成完整的 VCALENDAR。 */
export function buildCalendar(events: readonly IcsEvent[], opts: BuildCalendarOptions): string {
  const stamp = icsTimestamp(opts.now);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//submgr//订阅管家//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(opts.calendarName)}`,
  ];
  if (opts.timezone) lines.push(`X-WR-TIMEZONE:${opts.timezone}`);

  for (const event of events) {
    const nextDay = addDaysDateOnly(event.date, 1);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(event.date)}`,
      // 全天事件的 DTEND 是「次日」，表示右开区间（RFC 5545 §3.6.1）
      `DTEND;VALUE=DATE:${icsDate(nextDay)}`,
      `SUMMARY:${escapeIcsText(event.summary)}`,
      `DESCRIPTION:${escapeIcsText(event.description)}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(event.summary)}`,
      `TRIGGER:${event.alarmOffset}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

icsRoutes.get('/:file', async (c) => {
  const file = c.req.param('file');
  // 只接受 xxx.ics；其余路径一律 404（不暴露「令牌格式不对」）
  if (!file.endsWith('.ics')) throw notFound('日历地址必须以 .ics 结尾');
  const token = file.slice(0, -'.ics'.length);

  const settings = await loadSettings(c.env.DB);
  if (!settings) throw notFound('日历订阅不可用');
  if (!(await timingSafeEqual(token, settings.ics_token))) {
    throw notFound('日历订阅不可用');
  }

  const [subscriptions, versions, charges] = await Promise.all([
    loadSubscriptions(c.env.DB),
    loadVersions(c.env.DB),
    loadCharges(c.env.DB),
  ]);

  const today = todayInTimeZone(settings.timezone);
  const events = buildDueEvents({ today, subscriptions, versions, charges, settings });
  const calendar = buildCalendar(events, {
    now: new Date(),
    calendarName: `订阅管家 · 到期提醒（${settings.base_currency}）`,
    timezone: settings.timezone,
  });

  return new Response(calendar, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="submgr.ics"',
      // 令牌即鉴权，所以不允许共享缓存；5 分钟私有缓存足够减少轮询压力
      'Cache-Control': 'private, max-age=300',
    },
  });
});
