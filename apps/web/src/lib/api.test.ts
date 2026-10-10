import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiPost, request } from './api';
import { DEFAULT_CONN, buildUrl, resetConn, setConn } from './conn';
import { resetMockState } from './mock/data';
import { getSource, resetSource } from './source';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  resetConn();
  resetSource();
  resetMockState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api: buildUrl', () => {
  it('同源 + 查询参数编码', () => {
    expect(buildUrl('', '/api/subscriptions')).toBe('/api/subscriptions');
    expect(buildUrl('', '/api/subscriptions', { status: 'active', q: '爱奇艺', skip: undefined, empty: '' })).toBe(
      '/api/subscriptions?status=active&q=%E7%88%B1%E5%A5%87%E8%89%BA',
    );
  });

  it('绝对地址去掉结尾斜杠', () => {
    expect(buildUrl('https://example.com/', '/api/summary')).toBe('https://example.com/api/summary');
  });
});

describe('api: auto 模式回落示例数据（保证页面能渲染）', () => {
  it('没配置令牌时直接用示例数据，并且不发网络请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setConn({ mode: 'auto', token: '' });

    const result = await request<{ items: unknown[] }>('GET', '/api/subscriptions');
    expect(result.source).toBe('mock');
    expect(result.notice).toContain('ADMIN_TOKEN');
    expect(result.data.items.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSource()).toEqual({ source: 'mock', notice: result.notice });
  });

  it('配了令牌但接口连不上：GET 回落示例数据，并说明原因', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    setConn({ mode: 'auto', token: 'tok' });

    const result = await request<{ items: unknown[] }>('GET', '/api/subscriptions');
    expect(result.source).toBe('mock');
    expect(result.notice).toContain('连不上 /api');
    expect(result.notice).toContain('ECONNREFUSED');
  });

  it('配了令牌但接口返回 500：GET 也回落示例数据', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'internal_error', message: '服务端内部错误' } }, 500)),
    );
    setConn({ mode: 'auto', token: 'tok' });

    const result = await request<{ item: unknown }>('GET', '/api/summary');
    expect(result.source).toBe('mock');
    expect(result.notice).toContain('服务端内部错误');
    expect(result.data.item).toBeTruthy();
  });

  it('写请求失败时绝不静默写进示例数据（避免用户以为保存成功）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    setConn({ mode: 'auto', token: 'tok' });

    await expect(apiPost('/api/subscriptions', { name: 'x' })).rejects.toBeInstanceOf(ApiError);
    await expect(apiPost('/api/subscriptions', { name: 'x' })).rejects.toThrowError(/连不上 \/api/);
  });

  it('没配置令牌时的写请求走示例数据（本地点着玩）', async () => {
    setConn({ mode: 'auto', token: '' });
    const result = await apiPost<{ item: { id: string } }>('/api/settings/reset-ics-token');
    expect(result.source).toBe('mock');
    expect(result.data.item.id).toBeTruthy();
  });
});

describe('api: live 模式只看真实接口', () => {
  it('成功时返回 live 数据并复位来源状态', async () => {
    const payload = { items: [{ id: 'a' }], counts: { total: 1, active: 1, ended: 0, anomaly: 0 } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)));
    setConn({ mode: 'live', token: 'tok', apiBase: 'https://example.com' });

    const result = await request<typeof payload>('GET', '/api/subscriptions');
    expect(result.source).toBe('live');
    expect(result.notice).toBeNull();
    expect(result.data.items).toHaveLength(1);
    expect(getSource()).toEqual({ source: 'live', notice: null });
  });

  it('出错时抛 ApiError，带上服务端的中文说明与状态码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { code: 'version_frozen', message: '版本已经生效，不能改金额' } }, 409),
      ),
    );
    setConn({ mode: 'live', token: 'tok' });

    try {
      await apiPost('/api/subscriptions/sub-1/versions', {});
      throw new Error('不应该走到这里');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(409);
      expect((error as ApiError).code).toBe('version_frozen');
      expect((error as ApiError).message).toBe('版本已经生效，不能改金额');
    }
  });

  it('网络错误时抛 ApiError（不会偷偷换成示例数据）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    setConn({ mode: 'live', token: 'tok' });
    await expect(request('GET', '/api/summary')).rejects.toThrowError(/连不上 \/api/);
  });

  it('带上 Bearer 令牌与 JSON 请求头', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ item: {} }));
    vi.stubGlobal('fetch', fetchMock);
    setConn({ mode: 'live', token: 'secret-token' });

    await apiPost('/api/charges', { amount_minor: 100 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/charges');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-token');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ amount_minor: 100 }));
  });

  it('空响应体视为错误（避免把 null 当成数据）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    setConn({ mode: 'live', token: 'tok' });
    await expect(request('GET', '/api/summary')).rejects.toThrowError(/空响应体/);
  });
});

describe('api: mock 模式', () => {
  it('不发请求，直接用示例数据', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setConn({ mode: 'mock', token: 'tok' });

    const result = await request<{ items: unknown[] }>('GET', '/api/subscriptions');
    expect(result.source).toBe('mock');
    expect(result.notice).toContain('只用示例数据');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('示例数据的场景开关会影响汇率健康度', async () => {
    setConn({ mode: 'mock', mockScenario: 'stale' });
    const stale = await request<{ item: { stale: boolean } }>('GET', '/api/summary');
    expect(stale.data.item.stale).toBe(true);

    setConn({ mockScenario: 'missing' });
    const missing = await request<{ item: { missingCurrencies: string[] } }>('GET', '/api/summary');
    expect(missing.data.item.missingCurrencies).toContain('JPY');
  });
});

describe('api: 连接配置', () => {
  it('默认配置是 auto + 同源 + 无令牌', () => {
    expect(DEFAULT_CONN).toEqual({ apiBase: '', token: '', mode: 'auto', mockScenario: 'healthy' });
  });

  it('apiBase 结尾斜杠被归一化，令牌首尾空格在发请求时被忽略', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ item: {} }));
    vi.stubGlobal('fetch', fetchMock);
    setConn({ mode: 'live', apiBase: 'https://example.com///', token: '  ok  ' });

    const { getConn } = await import('./conn');
    expect(getConn().apiBase).toBe('https://example.com');

    await request('GET', '/api/summary');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/api/summary');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer ok');
  });
});
