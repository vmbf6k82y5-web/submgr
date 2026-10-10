/**
 * 唯一的网络出口。
 *
 * 三种数据模式（见 conn.ts）：
 *   live —— 只用真实接口，出错就抛错（用户要看真相时用）；
 *   mock —— 只用内置示例数据；
 *   auto —— 先试真实接口；**读请求**连不上就回落到示例数据（保证页面能渲染），
 *           但已经配置了令牌时的**写请求**绝不静默写进示例数据，而是抛错，
 *           否则用户会以为「保存成功」了。
 *
 * 每次请求都会把数据来源写进 source.ts，顶部横幅据此提示。
 */

import { ApiError } from './apiError';
import { buildUrl, getConn } from './conn';
import { mockRequest } from './mock/handler';
import { setSource } from './source';

export interface ApiResult<T> {
  data: T;
  source: 'live' | 'mock';
  notice: string | null;
}

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  signal?: AbortSignal;
}

export { ApiError };

function isMutation(method: string): boolean {
  return method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD';
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function messageFromBody(body: unknown, fallback: string): string {
  if (body !== null && typeof body === 'object') {
    const error = (body as { error?: { message?: unknown } }).error;
    if (error && typeof error.message === 'string' && error.message.trim() !== '') {
      return error.message;
    }
  }
  if (typeof body === 'string' && body.trim() !== '') return body.slice(0, 200);
  return fallback;
}

export async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const conn = getConn();
  const verb = method.toUpperCase();
  const query = options.query ?? {};

  const useMock = (reason: string): ApiResult<T> => {
    const data = mockRequest<T>(verb, path, {
      body: options.body,
      query,
      scenario: conn.mockScenario,
    });
    setSource({ source: 'mock', notice: reason });
    return { data, source: 'mock', notice: reason };
  };

  if (conn.mode === 'mock') {
    return useMock('已在设置里选择「只用示例数据」');
  }
  if (conn.mode === 'auto' && conn.token.trim() === '') {
    return useMock('还没配置 ADMIN_TOKEN，当前用内置示例数据渲染');
  }

  const url = buildUrl(conn.apiBase, path, query);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (conn.token.trim() !== '') headers['Authorization'] = `Bearer ${conn.token.trim()}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url, {
      method: verb,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    const message = errorMessageOf(error);
    const canFallback = conn.mode === 'auto' && !isMutation(verb);
    if (canFallback) return useMock(`连不上 /api（${message}），先用内置示例数据渲染`);
    throw new ApiError(
      `连不上 /api：${message}。只想看界面的话，可以在设置里把数据模式切成「只用示例数据」。`,
      0,
      'network_error',
    );
  }

  const body = await readBody(response);

  if (!response.ok) {
    const detail = (body !== null && typeof body === 'object'
      ? (body as { error?: { code?: string; details?: unknown } }).error
      : undefined) ?? undefined;
    const message = messageFromBody(body, `接口返回 ${response.status}`);
    const canFallback = conn.mode === 'auto' && !isMutation(verb);
    if (canFallback) return useMock(`调用 /api 失败：${message}（HTTP ${response.status}），先用内置示例数据渲染`);
    throw new ApiError(message, response.status, detail?.code ?? 'http_error', detail?.details);
  }

  if (body === null) {
    throw new ApiError('接口返回了空响应体（预期是 JSON）', response.status, 'empty_body');
  }

  setSource({ source: 'live', notice: null });
  return { data: body as T, source: 'live', notice: null };
}

export function apiGet<T>(path: string, query?: Record<string, unknown>): Promise<ApiResult<T>> {
  return request<T>('GET', path, { query });
}

export function apiPost<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  return request<T>('POST', path, { body: body ?? {} });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  return request<T>('PATCH', path, { body: body ?? {} });
}

export function apiPut<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  return request<T>('PUT', path, { body: body ?? {} });
}

export function apiDelete<T>(path: string): Promise<ApiResult<T>> {
  return request<T>('DELETE', path);
}
