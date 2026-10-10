/**
 * Bearer 鉴权中间件。
 *
 * 规则（需求原文）：/api 全部接口用 ADMIN_TOKEN 做 Bearer 鉴权，
 * 密钥只从环境变量 / secret 读。因此：
 *   - ADMIN_TOKEN 没配置时不是「放开」，而是 fail closed（500）；
 *   - 比较用常量时间，避免令牌长度/内容通过响应时间外泄；
 *   - 401 一律不区分「没带令牌」与「令牌不对」，不给试探者任何提示。
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from './env.js';
import { ApiError, unauthorized } from './lib/errors.js';
import { timingSafeEqual } from './lib/settings.js';

/** 从 Authorization 头里取出 Bearer 令牌。 */
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = (match[1] as string).trim();
  return token === '' ? null : token;
}

/** /api/* 的鉴权中间件。 */
export function requireAdmin(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const expected = typeof c.env.ADMIN_TOKEN === 'string' ? c.env.ADMIN_TOKEN : '';
    if (expected === '') {
      throw new ApiError(
        500,
        'server_misconfigured',
        '服务端未配置 ADMIN_TOKEN，拒绝所有 /api 请求（fail closed）。请用 wrangler secret put ADMIN_TOKEN 配置。',
      );
    }
    const provided = bearerToken(c.req.header('Authorization'));
    if (provided === null) throw unauthorized();
    if (!(await timingSafeEqual(provided, expected))) throw unauthorized();
    await next();
  };
}
