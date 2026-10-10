/**
 * /api/trends —— 按月的堆叠趋势。
 *
 * 分桶逻辑是 packages/core 的纯函数 monthlyTrend()（阶段一定稿：分桶放 core）。
 * 这里只做三件事：参数解析与校验、按区间取扣款（避免全表加载）、透传。
 */

import { Hono } from 'hono';
import {
  MAX_TREND_MONTHS,
  TREND_DIMENSIONS,
  addMonthsToMonthKey,
  isValidMonthKey,
  monthKeyOf,
  monthlyTrend,
  todayInTimeZone,
  type TrendDimension,
} from '@submgr/core';
import type { Env } from '../env.js';
import {
  loadCategories,
  loadCharges,
  loadFx,
  loadSubscriptions,
  loadVersions,
} from '../lib/world.js';
import { invalid } from '../lib/errors.js';
import { ensureSettings } from '../lib/settings.js';

export const trendRoutes = new Hono<{ Bindings: Env }>();

/** 默认展示最近 12 个月（含本月）。 */
export const DEFAULT_TREND_MONTHS = 12;

trendRoutes.get('/', async (c) => {
  const url = new URL(c.req.url);

  const settings = await ensureSettings(c.env.DB);
  const today = todayInTimeZone(settings.timezone);
  const currentMonth = monthKeyOf(today);

  const rawGroup = c.req.query('group')?.trim() ?? 'category';
  if (!(TREND_DIMENSIONS as readonly string[]).includes(rawGroup)) {
    throw invalid(`查询参数 group 必须是以下之一：${TREND_DIMENSIONS.join(' / ')}`);
  }
  const dimension = rawGroup as TrendDimension;

  const rawTo = c.req.query('to')?.trim() ?? currentMonth;
  if (!isValidMonthKey(rawTo)) throw invalid('查询参数 to 必须是 YYYY-MM');
  const rawFrom =
    c.req.query('from')?.trim() ?? addMonthsToMonthKey(rawTo, -(DEFAULT_TREND_MONTHS - 1));
  if (!isValidMonthKey(rawFrom)) throw invalid('查询参数 from 必须是 YYYY-MM');
  if (rawFrom > rawTo) throw invalid('from 不能晚于 to');

  const span = Number(rawTo.slice(0, 4)) * 12 + Number(rawTo.slice(5, 7))
    - (Number(rawFrom.slice(0, 4)) * 12 + Number(rawFrom.slice(5, 7))) + 1;
  if (span > MAX_TREND_MONTHS) {
    throw invalid(`区间过大：最多 ${MAX_TREND_MONTHS} 个月，当前 ${span} 个月`);
  }

  // 日期是 'YYYY-MM-DD' 定长字符串，按字符串比较区间端点即可；
  // 右端点用 '-31' 覆盖任意月份的最后一天。
  const [subscriptions, versions, categories, fx, charges] = await Promise.all([
    loadSubscriptions(c.env.DB),
    loadVersions(c.env.DB),
    loadCategories(c.env.DB),
    loadFx(c.env.DB),
    loadCharges(c.env.DB, { from: `${rawFrom}-01`, to: `${rawTo}-31` }),
  ]);

  const result = monthlyTrend(charges, dimension, { from: rawFrom, to: rawTo }, {
    baseCurrency: settings.base_currency,
    rates: fx,
    subscriptions,
    versions,
    categories,
  });

  return c.json({ item: result, today });
});
