/**
 * Cron ②（每 15 分钟扫描提醒）的测试。
 *
 * 重点：
 *   * 到期提醒的窗口与去重（reminder_log + 部分唯一索引）；
 *   * 文案里必须带「扣费渠道」的中文名（需求硬性要求，B11 定稿）；
 *   * 周期汇总（weekly / every_n_days）的到点判定；
 *   * 飞书签名、Telegram 载荷，以及发送失败要写 failed 行并在下一轮重试。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatMinorAmount, type ReminderRuleRow } from '@submgr/core';
import {
  CH_FEISHU,
  callJson,
  D,
  R_DISABLED,
  R_DUE_GLOBAL,
  R_DUE_TRIAL,
  R_FUTURE_TIME,
  R_MISSING_SECRET,
  R_SCHED_EVERY15,
  R_SCHED_WEEKLY,
  SUB_DUE_TODAY,
  SUB_TRIAL_FUTURE,
  SUB_TRIAL_TODAY,
  TODAY,
  isoWeekdayOfToday,
  makeEnv,
  queryAll,
  restoreClock,
  scenarioDb,
  useFixedClock,
} from './helpers/scenario.js';
import { jsonResponse, makeDeps, type TestDeps } from './helpers/cron.js';
import type { FakeD1 } from './helpers/d1.js';
import { runReminderScan, scheduleFires, sumInBase } from '../src/cron/reminders.js';
import { buildDueReminderText, buildSummaryReminderText } from '../src/notify/messages.js';
import { feishuSign } from '../src/notify/send.js';

/**
 * 场景里「未来 30 天」的 4 笔到期合计（CNY 分）：
 * Figma 5000 + Netflix 16369 + iCloud 81600 + 得到 2500。
 * 窗口是 (今天, 今天+30]，与 core 的 summarize / /api/summary 完全一致，
 * 今天到期的两笔由「到期提醒（days_before = 0）」负责，不重复计入。
 */
const SUMMARY_TOTAL_MINOR = 105469;

function rule(partial: Partial<ReminderRuleRow>): ReminderRuleRow {
  return {
    id: 'r-1',
    subscription_id: null,
    rule_type: 'schedule',
    days_before: null,
    at_time: '09:00',
    schedule_type: 'weekly',
    interval_days: null,
    weekdays: null,
    channel_id: null,
    enabled: 1,
    created_at: `${TODAY}T00:00:00.000Z`,
    updated_at: `${TODAY}T00:00:00.000Z`,
    deleted_at: null,
    ...partial,
  };
}

/** 假的下游：飞书返回 code=0，Telegram 返回 ok=true。 */
function happyDownstream(): TestDeps {
  return makeDeps({
    fetch: (url) => {
      if (url.includes('open.feishu.cn')) return jsonResponse({ code: 0, msg: 'success' });
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    },
  });
}

describe('Cron ② 提醒扫描', () => {
  let db: FakeD1;

  beforeEach(() => {
    useFixedClock();
    db = scenarioDb();
  });

  afterEach(() => {
    db.close();
    restoreClock();
  });

  it('到期提醒 + 周期汇总各发一条，失败的重试，未到点的跳过', async () => {
    const env = makeEnv(db);
    const { deps, calls, logs } = happyDownstream();

    const result = await runReminderScan(env, deps);

    expect(result.today).toBe(TODAY);
    expect(result.local_time).toBe('10:00');
    expect(result.rules_checked).toBe(6); // 7 条里有一条 enabled = 0
    expect(result.sent).toBe(4);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);

    // 到点但没有渠道密钥的那条 -> failed
    const failed = result.outcomes.filter((o) => o.result === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.rule_id).toBe(R_MISSING_SECRET);
    expect(failed[0]?.reason).toContain('MISSING_SECRET');

    // 还没到 at_time 的规则完全不参与
    expect(result.outcomes.some((o) => o.rule_id === R_FUTURE_TIME)).toBe(false);
    // 被禁用的规则根本没被读出来
    expect(result.outcomes.some((o) => o.rule_id === R_DISABLED)).toBe(false);

    // 全局到期规则（days_before = 0）今天命中两笔：Spotify 今天到期 + Notion 试用今天转正。
    // 去重键是 (rule_id, due_date)，所以这两笔必须合并成一条消息（见下面的文案断言）。
    const dueToday = result.outcomes.filter((o) => o.rule_id === R_DUE_GLOBAL);
    expect(dueToday).toHaveLength(1);
    expect(dueToday[0]?.due_date).toBe(TODAY);
    expect(dueToday[0]?.result).toBe('sent');
    expect(dueToday[0]?.subscription_id).toBeNull();

    // 试用结束前提醒：目标日 = trial_end_date
    const trialDue = result.outcomes.find((o) => o.rule_id === R_DUE_TRIAL);
    expect(trialDue?.due_date).toBe(D(4));
    expect(trialDue?.subscription_id).toBe(SUB_TRIAL_FUTURE);

    // 两条周期汇总都发了
    expect(result.outcomes.filter((o) => o.rule_id === R_SCHED_WEEKLY)[0]?.result).toBe('sent');
    expect(result.outcomes.filter((o) => o.rule_id === R_SCHED_EVERY15)[0]?.result).toBe('sent');

    // 4 次真实 HTTP：飞书 2 次（合并的到期提醒 + every_n_days 汇总）
    //                Telegram 2 次（试用结束前提醒 + weekly 汇总）
    expect(calls).toHaveLength(4);
    expect(calls.filter((c) => c.url.includes('open.feishu.cn'))).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes('api.telegram.org'))).toHaveLength(2);
    // 失败的渠道一次都没有被请求（拿不到密钥）
    expect(calls.every((c) => !c.url.includes('MISSING'))).toBe(true);

    // 去重日志：4 条 sent（2 条到期 + 2 条汇总）+ 1 条 failed
    const rows = queryAll<{ result: string }>(db, 'SELECT result FROM reminder_log');
    expect(rows.filter((r) => r.result === 'sent')).toHaveLength(4);
    expect(rows.filter((r) => r.result === 'failed')).toHaveLength(1);
    expect(rows.some((r) => r.result === 'skipped')).toBe(false);

    expect(logs.some((l) => l.event === 'cron.reminder.sent')).toBe(true);
    expect(logs.some((l) => l.event === 'cron.reminder.failed')).toBe(true);
    expect(logs.some((l) => l.event === 'cron.reminders.done')).toBe(true);
  });

  it('文案带头部、扣费渠道中文名、金额与周期', async () => {
    const env = makeEnv(db);
    const { deps, calls } = happyDownstream();
    await runReminderScan(env, deps);

    const feishuTexts = calls
      .filter((c) => c.url.includes('open.feishu.cn'))
      .map((c) => (c.body?.['content'] as { text: string }).text);

    // 同一天两笔 -> 一条清单消息，每笔都带自己的扣费渠道
    const dueToday = feishuTexts.find((t) => t.includes('Spotify')) as string;
    expect(dueToday).toContain('【订阅管家】到期提醒');
    expect(dueToday).toContain('共 2 笔今天到期：');
    expect(dueToday).toContain('· Notion Plus ¥99.00（银行卡）');
    expect(dueToday).toContain('· Spotify 家庭版 ¥30.00（微信）');

    // 只有一笔 -> 保持「单笔」文案
    const figma = calls
      .filter((c) => c.url.includes('api.telegram.org'))
      .map((c) => String(c.body?.['text']))
      .find((t) => t.includes('Figma')) as string;
    expect(figma).toContain('【订阅管家】到期提醒');
    expect(figma).toContain(`Figma 专业版 将于 ${D(4)} 到期（还有 4 天）`);
    expect(figma).toContain('金额：¥50.00（月付）');
    expect(figma).toContain('扣费渠道：银行卡');

    const tgTexts = calls
      .filter((c) => c.url.includes('api.telegram.org'))
      .map((c) => String(c.body?.['text']));
    const summary = tgTexts.find((t) => t.includes('周期汇总')) as string;
    expect(summary).toContain(`【订阅管家】周期汇总（${TODAY}）`);
    expect(summary).toContain('未来 30 天共 4 笔扣款');
    expect(summary).toContain(`合计：${formatMinorAmount(SUMMARY_TOTAL_MINOR, 'CNY')}`);
    expect(summary).toContain('· 10-14 Figma 专业版 ¥50.00（银行卡）');
    expect(summary).toContain('· 11-01 得到年度会员 ¥25.00（支付宝）');

    // 汇总合计必须和 /api/summary 的 next30DaysMinor 完全一致（同一口径）
    const apiSummary = await callJson<{ item: { next30DaysMinor: number } }>(env, 'GET', '/api/summary');
    expect(apiSummary.item.next30DaysMinor).toBe(SUMMARY_TOTAL_MINOR);
    expect(summary).toContain(formatMinorAmount(apiSummary.item.next30DaysMinor, 'CNY'));
  });

  it('飞书带签名、Telegram 的 chat_id 来自 config_json 合并', async () => {
    const env = makeEnv(db);
    const { deps, calls } = happyDownstream();
    await runReminderScan(env, deps);

    const feishu = calls.filter((c) => c.url.includes('open.feishu.cn'))[0];
    expect(feishu?.body?.['msg_type']).toBe('text');
    const timestamp = String(feishu?.body?.['timestamp']);
    expect(timestamp).toBe(String(Math.floor(new Date(`${TODAY}T02:00:00.000Z`).getTime() / 1000)));
    expect(feishu?.body?.['sign']).toBe(await feishuSign(timestamp, 'test-sign-secret'));

    const telegram = calls.filter((c) => c.url.includes('api.telegram.org'))[0];
    expect(telegram?.url).toBe('https://api.telegram.org/bot123456:TESTTOKEN/sendMessage');
    expect(telegram?.body?.['chat_id']).toBe('999');
  });

  it('第二轮：已成功的全部跳过、失败的重试（不重复发）', async () => {
    const env = makeEnv(db);
    const first = happyDownstream();
    await runReminderScan(env, first.deps);

    const second = happyDownstream();
    const result = await runReminderScan(env, second.deps);

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(4);
    expect(result.failed).toBe(1);
    // 第二轮只对失败的那条发起了请求（拿不到密钥，请求都没发生）
    expect(second.calls).toHaveLength(0);

    const rows = queryAll<{ result: string }>(db, 'SELECT result FROM reminder_log');
    expect(rows.filter((r) => r.result === 'sent')).toHaveLength(4);
    // 失败可以反复记（部分唯一索引只约束 result = 'sent'）
    expect(rows.filter((r) => r.result === 'failed')).toHaveLength(2);
  });

  it('下游返回失败 -> 写 failed 行，下一轮会重试', async () => {
    const env = makeEnv(db);
    // 只让飞书成功，Telegram 报错
    const flaky = makeDeps({
      fetch: (url) =>
        url.includes('api.telegram.org')
          ? jsonResponse({ ok: false, description: 'chat not found' })
          : jsonResponse({ code: 0 }),
    });

    const first = await runReminderScan(env, flaky.deps);
    expect(first.sent).toBe(2); // 2 次飞书（合并的到期提醒 + 汇总）
    expect(first.failed).toBe(3); // 2 次 Telegram + 1 次缺密钥
    expect(first.skipped).toBe(0);

    const second = happyDownstream();
    const result = await runReminderScan(env, second.deps);
    // 两条 Telegram 这次补发成功；缺密钥的那条依旧失败
    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(1);
    expect(second.calls).toHaveLength(2);
  });

  it('飞书业务错误码（HTTP 200 但 code != 0）也算失败', async () => {
    const env = makeEnv(db);
    const { deps } = makeDeps({
      fetch: (url) =>
        url.includes('open.feishu.cn')
          ? jsonResponse({ code: 9499, msg: 'sign match fail' })
          : jsonResponse({ ok: false, description: 'chat not found' }),
    });
    const result = await runReminderScan(env, deps);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(5);
    const failedLog = result.outcomes.find((o) => o.rule_id === R_DUE_GLOBAL);
    expect(failedLog?.reason).toContain('sign match fail');
  });

  it('提醒渠道被删掉 -> failed 并说明原因', async () => {
    const env = makeEnv(db);
    await env.DB.prepare('UPDATE reminder_rules SET channel_id = NULL WHERE id = ?').bind(R_DUE_GLOBAL).run();
    const { deps } = happyDownstream();
    const result = await runReminderScan(env, deps);
    const outcome = result.outcomes.find((o) => o.rule_id === R_DUE_GLOBAL);
    expect(outcome?.result).toBe('failed');
    expect(outcome?.reason).toContain('没有绑定任何渠道');
  });

  it('未来 30 天没有到期时，汇总提醒照样发（只是文案说明为空）', async () => {
    const env = makeEnv(db);
    await env.DB.prepare('DELETE FROM charges').run();
    await env.DB.prepare('DELETE FROM subscription_versions').run();
    await env.DB.prepare('DELETE FROM subscriptions').run();
    await env.DB.prepare("DELETE FROM reminder_rules WHERE rule_type = 'due'").run();

    const { deps, calls } = happyDownstream();
    const result = await runReminderScan(env, deps);

    expect(result.sent).toBe(2);
    expect(result.outcomes.every((o) => o.due_date === TODAY)).toBe(true);
    for (const call of calls) {
      const text = call.url.includes('open.feishu.cn')
        ? (call.body?.['content'] as { text: string }).text
        : String(call.body?.['text']);
      expect(text).toContain('未来 30 天没有任何到期扣款。');
    }
  });

  it('订阅的 renew_mode = manual 也照样提醒（提醒不等于自动扣款）', async () => {
    const env = makeEnv(db);
    const { deps, calls } = happyDownstream();
    await runReminderScan(env, deps);

    const summaryText = calls
      .map((c) =>
        c.url.includes('open.feishu.cn')
          ? (c.body?.['content'] as { text: string }).text
          : String(c.body?.['text']),
      )
      .find((t) => t.includes('周期汇总')) as string;

    // 得到年度会员是手动续费，但 11/1 到期照样进汇总
    expect(summaryText).toContain('得到年度会员');
    expect(summaryText).toContain('（支付宝）');
  });
});

describe('scheduleFires', () => {
  it('weekly：命中当天的 ISO 星期', () => {
    const today = isoWeekdayOfToday();
    expect(scheduleFires(rule({ weekdays: `[${today}]` }), TODAY, 'Asia/Shanghai')).toBe(true);
    const other = today === 1 ? 2 : 1;
    expect(scheduleFires(rule({ weekdays: `[${other}]` }), TODAY, 'Asia/Shanghai')).toBe(false);
    expect(scheduleFires(rule({ weekdays: '[]' }), TODAY, 'Asia/Shanghai')).toBe(false);
    expect(scheduleFires(rule({ weekdays: null }), TODAY, 'Asia/Shanghai')).toBe(false);
    expect(scheduleFires(rule({ weekdays: '不是 JSON' }), TODAY, 'Asia/Shanghai')).toBe(false);
  });

  it('every_n_days：以规则创建日为锚点', () => {
    expect(
      scheduleFires(
        rule({ schedule_type: 'every_n_days', interval_days: 15, weekdays: null, created_at: `${D(-15)}T00:00:00.000Z` }),
        TODAY,
        'Asia/Shanghai',
      ),
    ).toBe(true);
    expect(
      scheduleFires(
        rule({ schedule_type: 'every_n_days', interval_days: 15, weekdays: null, created_at: `${D(-14)}T00:00:00.000Z` }),
        TODAY,
        'Asia/Shanghai',
      ),
    ).toBe(false);
    // 创建当天也会发一次
    expect(
      scheduleFires(
        rule({ schedule_type: 'every_n_days', interval_days: 7, weekdays: null, created_at: `${TODAY}T00:00:00.000Z` }),
        TODAY,
        'Asia/Shanghai',
      ),
    ).toBe(true);
    // 锚点在「未来」（数据异常）时不发
    expect(
      scheduleFires(
        rule({ schedule_type: 'every_n_days', interval_days: 7, weekdays: null, created_at: `${D(3)}T00:00:00.000Z` }),
        TODAY,
        'Asia/Shanghai',
      ),
    ).toBe(false);
  });

  it('interval 非法 / schedule_type 不认识 -> 不发', () => {
    expect(scheduleFires(rule({ schedule_type: 'every_n_days', interval_days: 0 }), TODAY, 'Asia/Shanghai')).toBe(false);
    expect(scheduleFires(rule({ schedule_type: 'every_n_days', interval_days: -3 }), TODAY, 'Asia/Shanghai')).toBe(false);
    expect(scheduleFires(rule({ schedule_type: 'every_n_days', interval_days: null }), TODAY, 'Asia/Shanghai')).toBe(false);
    expect(scheduleFires(rule({ schedule_type: null }), TODAY, 'Asia/Shanghai')).toBe(false);
    expect(scheduleFires(rule({ schedule_type: 'monthly' as never }), TODAY, 'Asia/Shanghai')).toBe(false);
  });

  it('锚点按用户时区算（跨零点）', () => {
    // UTC 2026-10-09T20:00Z 在上海已经是 10-10（锚点日 == 今天 -> 差 0 天）
    const at = '2026-10-09T20:00:00.000Z';
    expect(
      scheduleFires(rule({ schedule_type: 'every_n_days', interval_days: 7, created_at: at }), TODAY, 'Asia/Shanghai'),
    ).toBe(true);
    // 时区换成 UTC 时锚点日变成 10-09（差 1 天，7 天一次不该发）
    expect(
      scheduleFires(rule({ schedule_type: 'every_n_days', interval_days: 7, created_at: at }), TODAY, 'UTC'),
    ).toBe(false);
  });
});

describe('sumInBase', () => {
  it('同币种直接相加', () => {
    const result = sumInBase(
      [
        { amountMinor: 1000, currency: 'CNY' },
        { amountMinor: 250, currency: 'CNY' },
      ],
      'CNY',
      {},
    );
    expect(result).toEqual({ totalMinor: 1250, missingCurrencies: [] });
  });

  it('外币按快照换算', () => {
    const result = sumInBase(
      [
        { amountMinor: 1000, currency: 'CNY' },
        { amountMinor: 100, currency: 'USD' },
      ],
      'CNY',
      { CNY: '7.0', USD: '1' },
    );
    expect(result.totalMinor).toBe(1700);
  });

  it('缺汇率 -> 合计为 null 并列出币种', () => {
    const result = sumInBase(
      [
        { amountMinor: 1000, currency: 'CNY' },
        { amountMinor: 100, currency: 'GBP' },
      ],
      'CNY',
      { CNY: '7.0' },
    );
    expect(result.totalMinor).toBeNull();
    expect(result.missingCurrencies).toEqual(['GBP']);
  });

  it('空清单 -> 0', () => {
    expect(sumInBase([], 'CNY', {})).toEqual({ totalMinor: 0, missingCurrencies: [] });
  });
});

describe('提醒文案纯函数', () => {
  const subscription = {
    id: 's-1',
    name: '示例订阅',
    category_id: null,
    sub_type: 'software' as const,
    charge_channel: 'apple' as const,
    renew_mode: 'auto' as const,
    start_date: TODAY,
    end_date: null,
    cancelled_at: null,
    note: null,
    icon: null,
    created_at: `${TODAY}T00:00:00.000Z`,
    updated_at: `${TODAY}T00:00:00.000Z`,
    deleted_at: null,
  };

  it('到期提醒带渠道中文名与周期中文名', () => {
    const text = buildDueReminderText({
      subscription,
      dueDate: TODAY,
      today: TODAY,
      amountMinor: 2500,
      currency: 'CNY',
      cycleType: 'year',
    });
    expect(text).toBe(
      ['【订阅管家】到期提醒', '示例订阅 就是今天到期', '金额：¥25.00（年付）', '扣费渠道：Apple'].join('\n'),
    );
  });

  it('汇总提醒缺汇率时说清楚，不少算', () => {
    const text = buildSummaryReminderText({
      today: TODAY,
      windowDays: 30,
      baseCurrency: 'CNY',
      lines: [{ dueDate: TODAY, name: '示例订阅', amountText: '£1.00', channel: 'alipay' }],
      totalMinor: null,
      missingCurrencies: ['GBP'],
    });
    expect(text).toContain('合计：算不出来（缺少 GBP 的汇率）');
    expect(text).toContain('· 10-10 示例订阅 £1.00（支付宝）');
  });

  it('汇总提醒：合计里没算的币种要显式提示', () => {
    const text = buildSummaryReminderText({
      today: TODAY,
      windowDays: 30,
      baseCurrency: 'CNY',
      lines: [{ dueDate: TODAY, name: 'A', amountText: '£1.00', channel: 'card' }],
      totalMinor: 1000,
      missingCurrencies: ['GBP'],
    });
    expect(text).toContain('注意：缺少 GBP 的汇率，合计未包含这些币种。');
  });
});
