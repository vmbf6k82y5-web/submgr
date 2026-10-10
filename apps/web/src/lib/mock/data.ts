/**
 * 内置示例数据（离线 / 未配置令牌时的兜底）。
 *
 * 设计要点：
 *   * 数据形状与 D1 的行一一对应（复用 core 的 Row 类型），
 *     所以 mock 与真实接口可以用同一套 DTO / 汇总函数，不会两套口径；
 *   * 日期全部相对「今天」生成（今天从 settings.timezone 算），
 *     任何一天打开示例数据都是新鲜的；
 *   * 三个场景（healthy / stale / missing）只为演示汇率提示，
 *     不改变业务口径。
 */

import {
  addDaysDateOnly,
  addMonthsKeepingAnchorDay,
  addMonthsToMonthKey,
  convertWithFrozenRate,
  dayOfMonth,
  frozenRateBetween,
  fxSnapshotFromRows,
  todayInTimeZone,
  type CategoryRow,
  type ChargeRow,
  type FxRateRow,
  type NotificationChannelRow,
  type SettingsRow,
  type SubscriptionRow,
  type SubscriptionVersionRow,
} from '@submgr/core';

export type MockScenario = 'healthy' | 'stale' | 'missing';

export interface MockState {
  scenario: MockScenario;
  settings: SettingsRow;
  categories: CategoryRow[];
  subscriptions: SubscriptionRow[];
  versions: SubscriptionVersionRow[];
  charges: ChargeRow[];
  fxRows: FxRateRow[];
  channels: NotificationChannelRow[];
}

const TZ = 'Asia/Shanghai';
const BASE = 'CNY';

/** 示例里用到的 USD→各币种汇率（rate = 1 USD 等于多少目标币种）。 */
const RATES: Record<string, string> = {
  CNY: '7.1400',
  HKD: '7.8100',
  JPY: '157.20',
  EUR: '0.9180',
  GBP: '0.7870',
  SGD: '1.3420',
};

/** missing 场景里故意缺少的币种（JPY 不是汇率基准，才能真正演示「缺汇率」）。 */
const MISSING_CURRENCY = 'JPY';

/** Netflix 每期冻结的 CNY/USD 汇率（模拟汇率波动，历史金额不跟着最新汇率变）。 */
const NETFLIX_FROZEN_RATES = ['7.1420', '7.0980', '7.2150', '7.1690', '7.1040', '7.1880'];

interface Audit {
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function audit(instant: string): Audit {
  return { created_at: instant, updated_at: instant, deleted_at: null };
}

/** 取「某个月内某个锚点日」的日期字符串。 */
function dayInMonth(monthKey: string, day: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) throw new Error(`dayInMonth: 非法月份键 ${monthKey}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const safe = Math.min(day, lastDay);
  return `${m[1]}-${m[2]}-${String(safe).padStart(2, '0')}`;
}

/** 今天的月份往前推 n 个月的月份键。 */
function monthsAgo(monthKey: string, n: number): string {
  return addMonthsToMonthKey(monthKey, -n);
}

function categoryAudit(instant: string, id: string, name: string, color: string, sort: number): CategoryRow {
  return { id, name, color, sort, ...audit(instant) };
}

export function buildMockState(scenario: MockScenario = 'healthy', now: Date = new Date()): MockState {
  const today = todayInTimeZone(TZ, now);
  const thisMonth = today.slice(0, 7);
  const createdAt = `${today}T00:00:00.000Z`;

  const settings: SettingsRow = {
    id: 'mock-settings',
    base_currency: BASE,
    timezone: TZ,
    ics_token: 'demo-ics-token-0123456789abcdef',
    amortize_lifetime_months: 36,
    ...audit(createdAt),
  };

  const categories: CategoryRow[] = [
    categoryAudit(createdAt, 'cat-media', '影音娱乐', '#ef4444', 10),
    categoryAudit(createdAt, 'cat-cloud', '云服务', '#3b82f6', 20),
    categoryAudit(createdAt, 'cat-software', '软件工具', '#8b5cf6', 30),
    categoryAudit(createdAt, 'cat-membership', '会员', '#f59e0b', 40),
  ];

  const subscriptions: SubscriptionRow[] = [];
  const versions: SubscriptionVersionRow[] = [];
  const charges: ChargeRow[] = [];

  // -------------------------------------------------------------------------
  // 1) 爱奇艺黄金会员：月付，中途涨过一次价（两个价格版本）
  // -------------------------------------------------------------------------
  const iqiyiStart = dayInMonth(monthsAgo(thisMonth, 8), 12);
  const iqiyiRaise = dayInMonth(monthsAgo(thisMonth, 3), 12);

  subscriptions.push({
    id: 'sub-iqiyi',
    name: '爱奇艺黄金会员',
    category_id: 'cat-media',
    sub_type: 'media',
    charge_channel: 'wechat',
    renew_mode: 'auto',
    start_date: iqiyiStart,
    end_date: null,
    cancelled_at: null,
    note: '连续包月，4 个月前从 ¥25 涨到 ¥30（历史账目按版本冻结）',
    icon: null,
    ...audit(createdAt),
  });
  versions.push(
    {
      id: 'ver-iqiyi-1',
      subscription_id: 'sub-iqiyi',
      effective_from: iqiyiStart,
      plan_name: '黄金会员 · 连续包月',
      amount_minor: 2500,
      currency: BASE,
      cycle_type: 'month',
      cycle_days: null,
      is_trial: 0,
      trial_end_date: null,
      after_trial_amount_minor: null,
      after_trial_currency: null,
      after_trial_cycle_type: null,
      after_trial_cycle_days: null,
      ...audit(createdAt),
    },
    {
      id: 'ver-iqiyi-2',
      subscription_id: 'sub-iqiyi',
      effective_from: iqiyiRaise,
      plan_name: '黄金会员 · 连续包月（涨价后）',
      amount_minor: 3000,
      currency: BASE,
      cycle_type: 'month',
      cycle_days: null,
      is_trial: 0,
      trial_end_date: null,
      after_trial_amount_minor: null,
      after_trial_currency: null,
      after_trial_cycle_type: null,
      after_trial_cycle_days: null,
      ...audit(createdAt),
    },
  );

  // -------------------------------------------------------------------------
  // 2) iCloud+ 2TB：年付
  // -------------------------------------------------------------------------
  const icloudStart = dayInMonth(monthsAgo(thisMonth, 10), 15);
  subscriptions.push({
    id: 'sub-icloud',
    name: 'iCloud+ 2TB',
    category_id: 'cat-cloud',
    sub_type: 'cloud',
    charge_channel: 'apple',
    renew_mode: 'auto',
    start_date: icloudStart,
    end_date: null,
    cancelled_at: null,
    note: null,
    icon: null,
    ...audit(createdAt),
  });
  versions.push({
    id: 'ver-icloud-1',
    subscription_id: 'sub-icloud',
    effective_from: icloudStart,
    plan_name: '2TB 家庭共享',
    amount_minor: 81600,
    currency: BASE,
    cycle_type: 'year',
    cycle_days: null,
    is_trial: 0,
    trial_end_date: null,
    after_trial_amount_minor: null,
    after_trial_currency: null,
    after_trial_cycle_type: null,
    after_trial_cycle_days: null,
    ...audit(createdAt),
  });

  // -------------------------------------------------------------------------
  // 3) Netflix 高级会员：外币月付，每期冻结不同汇率
  // -------------------------------------------------------------------------
  const netflixStart = dayInMonth(monthsAgo(thisMonth, 6), 5);
  subscriptions.push({
    id: 'sub-netflix',
    name: 'Netflix 高级会员',
    category_id: 'cat-media',
    sub_type: 'media',
    charge_channel: 'card',
    renew_mode: 'auto',
    start_date: netflixStart,
    end_date: null,
    cancelled_at: null,
    note: '美元计价，扣款当天冻结汇率',
    icon: null,
    ...audit(createdAt),
  });
  versions.push({
    id: 'ver-netflix-1',
    subscription_id: 'sub-netflix',
    effective_from: netflixStart,
    plan_name: 'Premium',
    amount_minor: 2299,
    currency: 'USD',
    cycle_type: 'month',
    cycle_days: null,
    is_trial: 0,
    trial_end_date: null,
    after_trial_amount_minor: null,
    after_trial_currency: null,
    after_trial_cycle_type: null,
    after_trial_cycle_days: null,
    ...audit(createdAt),
  });

  // -------------------------------------------------------------------------
  // 4) Notion Plus：试用 14 天，到期后没转正 -> 异常（红）
  // -------------------------------------------------------------------------
  const notionStart = addDaysDateOnly(today, -20);
  const notionTrialEnd = addDaysDateOnly(notionStart, 14);
  subscriptions.push({
    id: 'sub-notion',
    name: 'Notion Plus',
    category_id: 'cat-software',
    sub_type: 'software',
    charge_channel: 'card',
    renew_mode: 'auto',
    start_date: notionStart,
    end_date: null,
    cancelled_at: null,
    note: '试用 14 天，转正版本要用户自己确认价格后再建',
    icon: null,
    ...audit(createdAt),
  });
  versions.push({
    id: 'ver-notion-1',
    subscription_id: 'sub-notion',
    effective_from: notionStart,
    plan_name: 'Plus 试用',
    amount_minor: 0,
    currency: BASE,
    cycle_type: 'month',
    cycle_days: null,
    is_trial: 1,
    trial_end_date: notionTrialEnd,
    after_trial_amount_minor: 9900,
    after_trial_currency: BASE,
    after_trial_cycle_type: 'month',
    after_trial_cycle_days: null,
    ...audit(createdAt),
  });

  // -------------------------------------------------------------------------
  // 5) JetBrains 全家桶：终身授权，按 36 个月摊销
  // -------------------------------------------------------------------------
  const jetbrainsStart = dayInMonth(monthsAgo(thisMonth, 5), 8);
  subscriptions.push({
    id: 'sub-jetbrains',
    name: 'JetBrains 全家桶',
    category_id: 'cat-software',
    sub_type: 'software',
    charge_channel: 'alipay',
    renew_mode: 'manual',
    start_date: jetbrainsStart,
    end_date: null,
    cancelled_at: null,
    note: '终身授权，一次性付费',
    icon: null,
    ...audit(createdAt),
  });
  versions.push({
    id: 'ver-jetbrains-1',
    subscription_id: 'sub-jetbrains',
    effective_from: jetbrainsStart,
    plan_name: 'All Products Pack · 终身',
    amount_minor: 214800,
    currency: BASE,
    cycle_type: 'lifetime',
    cycle_days: null,
    is_trial: 0,
    trial_end_date: null,
    after_trial_amount_minor: null,
    after_trial_currency: null,
    after_trial_cycle_type: null,
    after_trial_cycle_days: null,
    ...audit(createdAt),
  });

  // -------------------------------------------------------------------------
  // 6) Spotify 家庭版：已取消 -> 已结束（灰）
  // -------------------------------------------------------------------------
  const spotifyStart = dayInMonth(monthsAgo(thisMonth, 10), 2);
  const spotifyEnd = dayInMonth(monthsAgo(thisMonth, 2), 2);
  subscriptions.push({
    id: 'sub-spotify',
    name: 'Spotify 家庭版',
    category_id: 'cat-membership',
    sub_type: 'membership',
    charge_channel: 'alipay',
    renew_mode: 'auto',
    start_date: spotifyStart,
    end_date: spotifyEnd,
    cancelled_at: `${spotifyEnd}T04:00:00.000Z`,
    note: '已经取消，最后一期退款成功',
    icon: null,
    ...audit(createdAt),
  });
  versions.push({
    id: 'ver-spotify-1',
    subscription_id: 'sub-spotify',
    effective_from: spotifyStart,
    plan_name: '家庭版',
    amount_minor: 1680,
    currency: BASE,
    cycle_type: 'month',
    cycle_days: null,
    is_trial: 0,
    trial_end_date: null,
    after_trial_amount_minor: null,
    after_trial_currency: null,
    after_trial_cycle_type: null,
    after_trial_cycle_days: null,
    ...audit(createdAt),
  });

  // -------------------------------------------------------------------------
  // 7) Nintendo Switch Online：日元年付（用来演示「缺币种汇率」）
  // -------------------------------------------------------------------------
  const nintendoStart = dayInMonth(monthsAgo(thisMonth, 4), 25);
  subscriptions.push({
    id: 'sub-nintendo',
    name: 'Nintendo Switch Online',
    category_id: 'cat-media',
    sub_type: 'membership',
    charge_channel: 'in_app',
    renew_mode: 'auto',
    start_date: nintendoStart,
    end_date: null,
    cancelled_at: null,
    note: '日区年付，日元计价',
    icon: null,
    ...audit(createdAt),
  });
  versions.push({
    id: 'ver-nintendo-1',
    subscription_id: 'sub-nintendo',
    effective_from: nintendoStart,
    plan_name: '个人计划 · 12 个月',
    amount_minor: 4500,
    currency: 'JPY',
    cycle_type: 'year',
    cycle_days: null,
    is_trial: 0,
    trial_end_date: null,
    after_trial_amount_minor: null,
    after_trial_currency: null,
    after_trial_cycle_type: null,
    after_trial_cycle_days: null,
    ...audit(createdAt),
  });

  // -------------------------------------------------------------------------
  // 扣款流水：按版本周期逐期生成，最后一期都不超过今天
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 汇率快照（先建快照，扣款才能像 Worker 一样「按扣款当天冻结汇率」）
  // -------------------------------------------------------------------------
  const fxRows: FxRateRow[] = [];
  const rateDate = scenario === 'stale' ? addDaysDateOnly(today, -3) : today;
  const fetchedAt =
    scenario === 'stale'
      ? new Date(now.getTime() - 72 * 3_600_000).toISOString()
      : new Date(now.getTime() - 40 * 60_000).toISOString();

  for (const [currency, rate] of Object.entries(RATES)) {
    if (scenario === 'missing' && currency === MISSING_CURRENCY) continue;
    // 基准币种自己也要有一条，否则跨币种换算无从下手
    fxRows.push({
      date: rateDate,
      base: 'USD',
      currency,
      rate,
      fetched_at: fetchedAt,
      ...audit(fetchedAt),
    });
  }

  /** 1 单位 currency 等于多少 CNY；缺该币种快照时返回 null（不伪造 1:1）。 */
  const frozenRateFor = (currency: string): string | null => {
    if (currency === BASE) return '1';
    return frozenRateBetween(currency, BASE, fxSnapshotFromRows(fxRows));
  };

  const addCharge = (args: {
    id: string;
    subscriptionId: string;
    version: SubscriptionVersionRow;
    date: string;
    amountMinor: number;
    currency: string;
    frozenRate: string | null;
    status?: ChargeRow['status'];
    source?: ChargeRow['source'];
  }): void => {
    const base = args.frozenRate === null
      ? null
      : convertWithFrozenRate(args.amountMinor, args.currency, BASE, args.frozenRate);
    charges.push({
      id: args.id,
      subscription_id: args.subscriptionId,
      version_id: args.version.id,
      charge_date: args.date,
      amount_minor: args.amountMinor,
      currency: args.currency,
      fx_rate_to_base: args.frozenRate,
      base_currency: args.frozenRate === null ? null : BASE,
      base_amount_minor: base,
      source: args.source ?? 'auto',
      status: args.status ?? 'paid',
      ...audit(`${args.date}T02:00:00.000Z`),
    });
  };

  /** 从首个到期日起逐期生成扣款，直到超过今天。 */
  const generateSeries = (args: {
    subscriptionId: string;
    versions: SubscriptionVersionRow[];
    start: string;
    maxPeriods: number;
    frozenRates?: readonly string[];
    statusAt?: (index: number) => ChargeRow['status'];
  }): void => {
    for (let i = 0; i < args.maxPeriods; i += 1) {
      const date = addMonthsKeepingAnchorDay(args.start, i, dayOfMonth(args.start));
      if (date > today) break;
      const version =
        [...args.versions]
          .filter((v) => v.effective_from <= date)
          .sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1))
          .pop() ?? args.versions[0];
      if (!version) break;
      const rate =
        args.frozenRates?.[i % args.frozenRates.length] ?? frozenRateFor(version.currency);
      addCharge({
        id: `chg-${args.subscriptionId}-${i}`,
        subscriptionId: args.subscriptionId,
        version,
        date,
        amountMinor: version.amount_minor,
        currency: version.currency,
        frozenRate: rate,
        status: args.statusAt ? args.statusAt(i) : 'paid',
      });
    }
  };

  generateSeries({
    subscriptionId: 'sub-iqiyi',
    versions: versions.filter((v) => v.subscription_id === 'sub-iqiyi'),
    start: iqiyiStart,
    maxPeriods: 9,
  });

  generateSeries({
    subscriptionId: 'sub-spotify',
    versions: versions.filter((v) => v.subscription_id === 'sub-spotify'),
    start: spotifyStart,
    maxPeriods: 10,
    statusAt: (index) => (index >= 8 ? 'refunded' : 'paid'),
  });

  generateSeries({
    subscriptionId: 'sub-netflix',
    versions: versions.filter((v) => v.subscription_id === 'sub-netflix'),
    start: netflixStart,
    maxPeriods: 7,
    frozenRates: NETFLIX_FROZEN_RATES,
  });

  generateSeries({
    subscriptionId: 'sub-nintendo',
    versions: versions.filter((v) => v.subscription_id === 'sub-nintendo'),
    start: nintendoStart,
    maxPeriods: 2,
  });

  // 年付 / 终身：只在生效日有一笔（不按周期铺开）
  const icloudVersion = versions.find((v) => v.id === 'ver-icloud-1');
  if (icloudVersion && icloudStart <= today) {
    addCharge({
      id: 'chg-sub-icloud-0',
      subscriptionId: 'sub-icloud',
      version: icloudVersion,
      date: icloudStart,
      amountMinor: icloudVersion.amount_minor,
      currency: icloudVersion.currency,
      frozenRate: frozenRateFor(icloudVersion.currency),
    });
  }
  const jetbrainsVersion = versions.find((v) => v.id === 'ver-jetbrains-1');
  if (jetbrainsVersion && jetbrainsStart <= today) {
    addCharge({
      id: 'chg-sub-jetbrains-0',
      subscriptionId: 'sub-jetbrains',
      version: jetbrainsVersion,
      date: jetbrainsStart,
      amountMinor: jetbrainsVersion.amount_minor,
      currency: jetbrainsVersion.currency,
      frozenRate: frozenRateFor(jetbrainsVersion.currency),
      source: 'manual',
    });
  }


  // -------------------------------------------------------------------------
  // 提醒渠道（密钥只存 secret_ref，示例里没有任何明文密钥）
  // -------------------------------------------------------------------------
  const channels: NotificationChannelRow[] = [
    {
      id: 'chan-feishu',
      type: 'feishu',
      name: '飞书 · 主号',
      config_json: '{}',
      secret_ref: 'FEISHU_MAIN',
      secrets_encrypted: null,
      ...audit(createdAt),
    },
    {
      id: 'chan-telegram',
      type: 'telegram',
      name: 'Telegram · 备用',
      config_json: '{"chat_id":"123456789"}',
      secret_ref: 'TELEGRAM_MAIN',
      secrets_encrypted: null,
      ...audit(createdAt),
    },
  ];

  return { scenario, settings, categories, subscriptions, versions, charges, fxRows, channels };
}

// ---------------------------------------------------------------------------
// 进程内单例（可写）：请求之间共享，模拟真实后端的持久化
// ---------------------------------------------------------------------------

let state: MockState | null = null;

/** 取当前 mock 状态；场景变了就重建（示例数据的写操作不跨场景保留）。 */
export function getMockState(scenario: MockScenario, now: Date = new Date()): MockState {
  if (state === null || state.scenario !== scenario) {
    state = buildMockState(scenario, now);
  }
  return state;
}

/** 测试用：丢弃所有本地改动。 */
export function resetMockState(): void {
  state = null;
}

export { dayInMonth, monthsAgo };
