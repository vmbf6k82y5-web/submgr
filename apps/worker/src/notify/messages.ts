/**
 * 提醒文案（纯函数）。
 *
 * 需求原文：提醒文案必须带「扣费渠道」。
 * 枚举 -> 中文的映射统一用 packages/core 的 chargeChannelLabel() / cycleTypeLabel()
 * （阶段一定稿 B11），Worker 里不再另写一份，避免前后端说法不一致。
 */

import {
  chargeChannelLabel,
  cycleTypeLabel,
  diffDaysDateOnly,
  formatMinorAmount,
  type ChargeChannel,
  type CycleType,
  type SubscriptionRow,
} from '@submgr/core';

export const MESSAGE_TITLE = '【订阅管家】';

export interface DueReminderInput {
  subscription: SubscriptionRow;
  dueDate: string;
  today: string;
  amountMinor: number;
  currency: string;
  cycleType: CycleType;
}

/** 到期提醒文案（含扣费渠道）。 */
export function buildDueReminderText(input: DueReminderInput): string {
  const { subscription, dueDate, today, amountMinor, currency, cycleType } = input;
  const days = diffDaysDateOnly(dueDate, today);
  const when =
    days === 0 ? '就是今天到期' : days > 0 ? `将于 ${dueDate} 到期（还有 ${days} 天）` : `已于 ${dueDate} 到期`;

  return [
    `${MESSAGE_TITLE}到期提醒`,
    `${subscription.name} ${when}`,
    `金额：${formatMinorAmount(amountMinor, currency)}（${cycleTypeLabel(cycleType)}）`,
    `扣费渠道：${chargeChannelLabel(subscription.charge_channel)}`,
  ].join('\n');
}

export interface SummaryLine {
  dueDate: string;
  name: string;
  /** 已经格式化好的原币金额文本 */
  amountText: string;
  channel: ChargeChannel;
}

/** 同一天到期的多笔扣款（全局规则会一次命中多个订阅）。 */
export interface DueListLine {
  name: string;
  /** 已经格式化好的原币金额文本 */
  amountText: string;
  channel: ChargeChannel;
}

export interface DueListReminderInput {
  targetDate: string;
  today: string;
  lines: readonly DueListLine[];
}

/**
 * 一天里有多笔到期时的合并提醒。
 *
 * 为什么必须合并：reminder_log 的去重键是 (rule_id, due_date)
 * （migration 里的 ux_reminder_log_dedupe 部分唯一索引，已冻结）。
 * 一条全局到期规则如果为同一天的每个订阅各发一条，第二条就会被去重逻辑挡掉，
 * 所以这里合成一条「清单」消息 —— 一个 (规则, 到期日) 只会有一条日志。
 */
export function buildDueListReminderText(input: DueListReminderInput): string {
  const { targetDate, today, lines } = input;
  const days = diffDaysDateOnly(targetDate, today);
  const when =
    days === 0
      ? '今天到期'
      : days > 0
        ? `将于 ${targetDate} 到期（还有 ${days} 天）`
        : `已于 ${targetDate} 到期`;

  return [
    `${MESSAGE_TITLE}到期提醒`,
    `共 ${lines.length} 笔${when}：`,
    ...lines.map((line) => `· ${line.name} ${line.amountText}（${chargeChannelLabel(line.channel)}）`),
  ].join('\n');
}

export interface SummaryReminderInput {
  today: string;
  windowDays: number;
  baseCurrency: string;
  lines: readonly SummaryLine[];
  /** 合计（基准币种最小单位）；缺汇率时为 null */
  totalMinor: number | null;
  missingCurrencies: readonly string[];
}

/** 周期汇总提醒文案（每条都带扣费渠道；合计缺汇率时明确说明而不是少算）。 */
export function buildSummaryReminderText(input: SummaryReminderInput): string {
  const { today, windowDays, baseCurrency, lines, totalMinor, missingCurrencies } = input;

  const head = `${MESSAGE_TITLE}周期汇总（${today}）`;
  if (lines.length === 0) {
    return [head, `未来 ${windowDays} 天没有任何到期扣款。`].join('\n');
  }

  const totalText =
    totalMinor === null
      ? `合计：算不出来（缺少 ${missingCurrencies.join('、')} 的汇率）`
      : `合计：${formatMinorAmount(totalMinor, baseCurrency)}`;

  const body = lines.map((line) => {
    // '2026-10-15' -> '10-15'
    const shortDate = line.dueDate.slice(5);
    return `· ${shortDate} ${line.name} ${line.amountText}（${chargeChannelLabel(line.channel)}）`;
  });

  const tail: string[] = [];
  if (totalMinor !== null && missingCurrencies.length > 0) {
    tail.push(`注意：缺少 ${missingCurrencies.join('、')} 的汇率，合计未包含这些币种。`);
  }

  return [`${head}`, `未来 ${windowDays} 天共 ${lines.length} 笔扣款，${totalText}`, ...body, ...tail].join('\n');
}
