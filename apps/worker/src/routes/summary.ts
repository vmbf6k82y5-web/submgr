/**
 * /api/summary —— 总览汇总。
 *
 * 这里不做任何业务计算：全部交给 packages/core 的 summarize()，
 * Worker 只负责把 D1 里的行装配成 core 需要的形状 + 传 today。
 * 这样「总览」「趋势」「提醒」三条链路用的是同一套口径，不会各算各的。
 */

import { Hono } from 'hono';
import { UPCOMING_WINDOW_DAYS, nowIso, summarize } from '@submgr/core';
import type { Env } from '../env.js';
import { queryInt } from '../lib/validate.js';
import { loadWorld } from '../lib/world.js';

export const summaryRoutes = new Hono<{ Bindings: Env }>();

summaryRoutes.get('/', async (c) => {
  const url = new URL(c.req.url);
  const windowDays = queryInt(url, 'window_days', {
    fallback: UPCOMING_WINDOW_DAYS,
    min: 1,
    max: 365,
  });

  const world = await loadWorld(c.env.DB);
  const result = summarize(
    world.subscriptions,
    world.versions,
    world.fx,
    world.settings,
    world.today,
    { charges: world.charges, windowDays },
  );

  return c.json({
    item: {
      ...result,
      window_days: windowDays,
      generated_at: nowIso(),
    },
  });
});
