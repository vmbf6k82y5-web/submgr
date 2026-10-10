/**
 * GET /ics/:token.ics 的集成测试 + ICS 纯函数的单元测试。
 *
 * 需求要点逐条验证：
 *   * 不走 Bearer 鉴权（令牌即凭证）；
 *   * 未来 12 个月到期事件；
 *   * 全天事件 + VALARM；
 *   * UID = subscription_id + due_date，重新生成不变。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDaysDateOnly, addMonthsToMonthKey } from '@submgr/core';
import {
  CAT_MEDIA,
  SUB_ANNUAL,
  SUB_CANCELLED,
  SUB_DUE_TODAY,
  SUB_LIFETIME,
  SUB_MONTHLY,
  SUB_TRIAL_TODAY,
  TODAY,
  call,
  makeEnv,
  restoreClock,
  scenarioDb,
  useFixedClock,
} from './helpers/scenario.js';
import type { FakeD1 } from './helpers/d1.js';
import {
  ICS_ALARM_OFFSET,
  buildCalendar,
  escapeIcsText,
  foldIcsLine,
  icsDate,
  icsTimestamp,
} from '../src/ics.js';

const ICS_TOKEN = 'ics-token-for-tests-0123456789';

/** 取出所有 VEVENT 块。 */
function eventBlocks(ics: string): string[] {
  return ics.split('BEGIN:VEVENT').slice(1).map((chunk) => `BEGIN:VEVENT${chunk.split('END:VEVENT')[0]}`);
}

/** 反向还原折行（RFC 5545 的续行以空格开头）。 */
function unfold(ics: string): string {
  return ics.replace(/\r\n /g, '');
}

/** 取出所有非空行的原始（未折行的）字节长度，用于校验折行。 */
function maxLineBytes(text: string): number {
  return Math.max(...text.split('\r\n').map((line) => new TextEncoder().encode(line).length));
}

describe('GET /ics/:token.ics', () => {
  let db: FakeD1;

  beforeEach(() => {
    useFixedClock();
    db = scenarioDb();
  });

  afterEach(() => {
    db.close();
    restoreClock();
  });

  it('不需要 Authorization 头', async () => {
    const env = makeEnv(db);
    const res = await call(env, 'GET', `/ics/${ICS_TOKEN}.ics`, undefined, { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
  });

  it('令牌不对 / 缺 .ics 后缀 / 订阅不存在 -> 404', async () => {
    const env = makeEnv(db);
    expect((await call(env, 'GET', '/ics/wrong-token-abcdefgh.ics', undefined, { token: null })).status).toBe(404);
    expect((await call(env, 'GET', `/ics/${ICS_TOKEN}`, undefined, { token: null })).status).toBe(404);
    expect((await call(env, 'GET', '/ics/.ics', undefined, { token: null })).status).toBe(404);
  });

  it('settings 还没有时也不崩（404）', async () => {
    const empty = scenarioDb();
    empty.raw.exec('DELETE FROM settings');
    const env = makeEnv(empty);
    const res = await call(env, 'GET', `/ics/${ICS_TOKEN}.ics`, undefined, { token: null });
    expect(res.status).toBe(404);
    empty.close();
  });

  it('输出合法的 VCALENDAR / VEVENT / VALARM，CRLF 换行，行宽合规', async () => {
    const env = makeEnv(db);
    const res = await call(env, 'GET', `/ics/${ICS_TOKEN}.ics`, undefined, { token: null });
    const ics = await res.text();

    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('PRODID:');
    expect(ics).toContain(`X-WR-TIMEZONE:Asia/Shanghai`);
    expect(ics.split('BEGIN:VEVENT')).toHaveLength(64); // 63 个事件 + 1
    expect(ics.split('END:VEVENT')).toHaveLength(64);
    // 每个事件都有 VALARM
    expect(ics.split('BEGIN:VALARM')).toHaveLength(64);
    expect(ics).toContain('ACTION:DISPLAY');
    expect(ics).toContain(`TRIGGER:${ICS_ALARM_OFFSET}`);

    // 没有任何一行超过 75 个八位组（RFC 5545 §3.1）
    expect(maxLineBytes(ics)).toBeLessThanOrEqual(75);
    // 没有裸 LF
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it('全是全天事件：DTSTART = 到期日，DTEND = 次日', async () => {
    const env = makeEnv(db);
    const res = await call(env, 'GET', `/ics/${ICS_TOKEN}.ics`, undefined, { token: null });
    const ics = await res.text();

    for (const block of eventBlocks(ics)) {
      const dtstart = /DTSTART;VALUE=DATE:(\d{8})/.exec(block)?.[1];
      const dtend = /DTEND;VALUE=DATE:(\d{8})/.exec(block)?.[1];
      expect(dtstart).toBeDefined();
      expect(dtend).toBeDefined();
      expect(dtstart).toHaveLength(8);
      // DTEND 必须是 DTSTART 的次日（全天事件的右开区间）
      const startDate = `${dtstart?.slice(0, 4)}-${dtstart?.slice(4, 6)}-${dtstart?.slice(6, 8)}`;
      expect(dtend).toBe(icsDate(addDaysDateOnly(startDate, 1)));
    }
  });

  it('UID = subscription_id + due_date，且重新生成完全一致', async () => {
    const env = makeEnv(db);
    const first = await (await call(env, 'GET', `/ics/${ICS_TOKEN}.ics`, undefined, { token: null })).text();
    const second = await (await call(env, 'GET', `/ics/${ICS_TOKEN}.ics`, undefined, { token: null })).text();
    expect(second).toBe(first);

    const uids = [...first.matchAll(/UID:([^\r\n]+)/g)].map((m) => m[1] as string);
    expect(uids.length).toBe(63);
    expect(new Set(uids).size).toBe(63);

    for (const uid of uids) {
      expect(uid).toMatch(/^[0-9a-f-]{36}-\d{4}-\d{2}-\d{2}$/);
    }
    // 今天到期的 Spotify
    expect(uids).toContain(`${SUB_DUE_TODAY}-${TODAY}`);
    // Netflix 的到期日是每月 1 号，窗口从今天（10 号）算起 -> 第一条是下个月 1 号
    expect(uids).toContain(`${SUB_MONTHLY}-${addMonthsToMonthKey(TODAY.slice(0, 7), 1)}-01`);
    // iCloud 年付只有一次
    expect(uids.filter((u) => u.startsWith(SUB_ANNUAL))).toHaveLength(1);
    // 12 个月窗口的两端都在里面
    expect(uids).toContain(`${SUB_TRIAL_TODAY}-${TODAY}`);
    expect(uids.some((u) => u.endsWith('2027-10-10'))).toBe(true);
  });

  it('已结束（已取消）与终身订阅都不出现在日历里', async () => {
    const env = makeEnv(db);
    const ics = await (await call(env, 'GET', `/ics/${ICS_TOKEN}.ics`, undefined, { token: null })).text();
    expect(ics).not.toContain(SUB_CANCELLED);
    expect(ics).not.toContain(SUB_LIFETIME);
  });

  it('事件标题带订阅名，描述带扣费渠道（中文）', async () => {
    const env = makeEnv(db);
    const ics = unfold(
      await (await call(env, 'GET', `/ics/${ICS_TOKEN}.ics`, undefined, { token: null })).text(),
    );

    const spotify = eventBlocks(ics).find((b) => b.includes(`${SUB_DUE_TODAY}-${TODAY}`)) as string;
    expect(spotify).toContain('SUMMARY:Spotify 家庭版 到期');
    expect(spotify).toContain('扣费渠道：微信');
    expect(spotify).toContain('金额：¥30.00（月付）');

    const netflix = eventBlocks(ics).find((b) => b.startsWith(`BEGIN:VEVENT\r\nUID:${SUB_MONTHLY}-`)) as string;
    expect(netflix).toContain('扣费渠道：银行卡');
    expect(netflix).toContain('US$22.99');
  });

  it('日历名里带上基准币种', async () => {
    const env = makeEnv(db);
    const ics = await (await call(env, 'GET', `/ics/${ICS_TOKEN}.ics`, undefined, { token: null })).text();
    expect(ics).toContain('X-WR-CALNAME:订阅管家 · 到期提醒（CNY）');
  });

  it('settings 的 ics_token 改了以后旧地址立刻失效', async () => {
    const env = makeEnv(db);
    await call(env, 'POST', '/api/settings/reset-ics-token');
    const res = await call(env, 'GET', `/ics/${ICS_TOKEN}.ics`, undefined, { token: null });
    expect(res.status).toBe(404);
  });

  it('缓存头是私有的（令牌即鉴权，不能让共享缓存命中）', async () => {
    const env = makeEnv(db);
    const res = await call(env, 'GET', `/ics/${ICS_TOKEN}.ics`, undefined, { token: null });
    expect(res.headers.get('cache-control')).toContain('private');
  });
});

describe('ICS 纯函数', () => {
  it('TEXT 转义覆盖反斜杠、分号、逗号、换行', () => {
    expect(escapeIcsText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });

  it('折行按 75 个八位组，续行以空格开头，绝不切断多字节字符', () => {
    const line = `SUMMARY:${'中文测试'.repeat(30)}`;
    const folded = foldIcsLine(line);
    const lines = folded.split('\r\n');

    expect(lines.length).toBeGreaterThan(1);
    for (const [i, l] of lines.entries()) {
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
      if (i > 0) expect(l.startsWith(' ')).toBe(true);
    }
    // 去掉续行空格后能还原原文
    expect(lines.map((l, i) => (i === 0 ? l : l.slice(1))).join('')).toBe(line);
  });

  it('短行不折行', () => {
    expect(foldIcsLine('SUMMARY:短')).toBe('SUMMARY:短');
  });

  it('icsTimestamp / icsDate 格式正确', () => {
    expect(icsTimestamp(new Date('2026-10-10T06:45:39.325Z'))).toBe('20261010T064539Z');
    expect(icsDate('2026-10-01')).toBe('20261001');
  });

  it('buildCalendar 对空事件集也能产出合法日历', () => {
    const ics = buildCalendar([], { now: new Date('2026-10-10T06:45:39.325Z'), calendarName: '空' });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
    expect(ics.endsWith('\r\n')).toBe(true);
  });

  it('分类删除后日历不受影响（只依赖订阅与版本）', async () => {
    const db = scenarioDb();
    useFixedClock();
    const env = makeEnv(db);
    await call(env, 'DELETE', `/api/categories/${CAT_MEDIA}`);
    const res = await call(env, 'GET', `/ics/${ICS_TOKEN}.ics`, undefined, { token: null });
    expect(res.status).toBe(200);
    db.close();
    restoreClock();
  });
});
