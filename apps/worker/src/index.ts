/**
 * 订阅管家 Worker 入口（Hono）。
 *
 * 路由一览：
 *   GET    /ics/:token.ics                日历订阅（无 Bearer 鉴权，令牌在路径里）
 *   GET    /api/subscriptions             列表（带状态、当前版本、月均）
 *   POST   /api/subscriptions             新建（可顺带带首个价格版本）
 *   GET    /api/subscriptions/:id         详情（含版本与扣款）
 *   PATCH  /api/subscriptions/:id         修改
 *   DELETE /api/subscriptions/:id         软删除（级联软删版本与规则）
 *   GET    /api/subscriptions/:id/versions
 *   POST   /api/subscriptions/:id/versions  只许新增
 *   PATCH  /api/subscriptions/:id/versions/:versionId  已生效版本只允许改 plan_name
 *   DELETE /api/subscriptions/:id/versions/:versionId  已生效版本不许删除
 *   GET/POST          /api/charges         + PATCH/DELETE /api/charges/:id
 *   GET/POST          /api/categories      + PATCH/DELETE /api/categories/:id
 *   GET    /api/summary
 *   GET    /api/trends
 *   GET/POST          /api/reminders       + PATCH/DELETE /api/reminders/:id
 *   GET    /api/reminders/log
 *   GET/POST          /api/channels        + PATCH/DELETE /api/channels/:id
 *   GET/PUT /api/settings                  + POST /api/settings/reset-ics-token
 *
 * 鉴权：/api/* 全部要求 `Authorization: Bearer $ADMIN_TOKEN`；密钥只从环境变量读。
 */

import { Hono } from 'hono';
import type { Env } from './env.js';
import { requireAdmin } from './auth.js';
import { ApiError } from './lib/errors.js';
import { categoryRoutes } from './routes/categories.js';
import { channelRoutes } from './routes/channels.js';
import { chargeRoutes } from './routes/charges.js';
import { reminderRoutes } from './routes/reminders.js';
import { settingsRoutes } from './routes/settings.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { summaryRoutes } from './routes/summary.js';
import { trendRoutes } from './routes/trends.js';
import { icsRoutes } from './ics.js';
import { defaultCronDeps } from './cron/deps.js';
import { dispatchCron } from './cron/index.js';

export const app = new Hono<{ Bindings: Env }>();

/** 统一的 JSON 错误响应（不经过 c.json，避免 status 的类型体操）。 */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ---------------------------------------------------------------------------
// /api —— 全部需要 Bearer 鉴权
// ---------------------------------------------------------------------------

app.use('/api/*', requireAdmin());

app.route('/api/subscriptions', subscriptionRoutes);
app.route('/api/charges', chargeRoutes);
app.route('/api/categories', categoryRoutes);
app.route('/api/summary', summaryRoutes);
app.route('/api/trends', trendRoutes);
app.route('/api/reminders', reminderRoutes);
app.route('/api/channels', channelRoutes);
app.route('/api/settings', settingsRoutes);

// ---------------------------------------------------------------------------
// /ics —— 无 Bearer 鉴权（日历客户端带不了自定义头），令牌即凭证
// ---------------------------------------------------------------------------

app.route('/ics', icsRoutes);

// ---------------------------------------------------------------------------
// 兜底
// ---------------------------------------------------------------------------

app.notFound((c) => jsonResponse({ error: { code: 'not_found', message: `没有这个接口：${c.req.path}` } }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return jsonResponse(err.toBody(), err.status);
  }
  // 未预期的异常：日志里留全栈，响应里只给不泄露细节的中文说明
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'http.unhandled',
      path: c.req.path,
      method: c.req.method,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  return jsonResponse(
    { error: { code: 'internal_error', message: '服务端内部错误，请查看 Worker 日志' } },
    500,
  );
});

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

async function scheduled(
  event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const deps = defaultCronDeps();
  // waitUntil 保证 cron 事件不会在作业跑完前被回收
  ctx.waitUntil(
    dispatchCron(event.cron, env, deps).then((summary) => {
      deps.log('info', 'cron.done', {
        cron: summary.cron,
        job: summary.job,
        ok: summary.ok,
        error: summary.error,
      });
    }),
  );
}

export default {
  fetch: app.fetch,
  scheduled,
};
