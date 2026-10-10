/**
 * 连接配置（API 地址 / ADMIN_TOKEN / 数据模式 / 示例数据场景）。
 *
 * 存在 localStorage 里，而不是构建期注入：Worker 的 Static Assets 托管的前端
 * 是同源页面，令牌不该被编译进 JS 包（JS 包是公开的）。
 * 首次打开（没有令牌）时 auto 模式会自动使用内置示例数据，保证页面能渲染。
 */

import { readJson, writeJson } from './storage';

export type DataMode = 'auto' | 'live' | 'mock';
export type MockScenario = 'healthy' | 'stale' | 'missing';

export interface ConnConfig {
  /** 空字符串 = 同源（线上用 Worker 托管，本地用 Vite 代理）。 */
  apiBase: string;
  /** /api 的 Bearer 令牌，即 Worker 的 ADMIN_TOKEN。 */
  token: string;
  mode: DataMode;
  /** 仅 mock 模式有效：演示「汇率过期 / 缺币种」时的界面提示。 */
  mockScenario: MockScenario;
}

export const CONN_KEY = 'submgr.conn.v1';

export const DEFAULT_CONN: ConnConfig = {
  apiBase: '',
  token: '',
  mode: 'auto',
  mockScenario: 'healthy',
};

export const DATA_MODE_LABELS: Record<DataMode, string> = {
  auto: '自动（连不上就用示例数据）',
  live: '只用真实接口（出错就报错）',
  mock: '只用示例数据',
};

export const MOCK_SCENARIO_LABELS: Record<MockScenario, string> = {
  healthy: '正常（汇率新鲜、币种齐全）',
  stale: '汇率过期 72 小时',
  missing: '缺少 JPY 汇率',
};

const MODES: DataMode[] = ['auto', 'live', 'mock'];
const SCENARIOS: MockScenario[] = ['healthy', 'stale', 'missing'];

function normalize(raw: unknown): ConnConfig {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_CONN };
  const obj = raw as Record<string, unknown>;
  const mode = MODES.includes(obj['mode'] as DataMode) ? (obj['mode'] as DataMode) : 'auto';
  const mockScenario = SCENARIOS.includes(obj['mockScenario'] as MockScenario)
    ? (obj['mockScenario'] as MockScenario)
    : 'healthy';
  return {
    apiBase: typeof obj['apiBase'] === 'string' ? obj['apiBase'].trim().replace(/\/+$/, '') : '',
    token: typeof obj['token'] === 'string' ? obj['token'] : '',
    mode,
    mockScenario,
  };
}

let current: ConnConfig = normalize(readJson<unknown>(CONN_KEY));
const listeners = new Set<() => void>();

export function getConn(): ConnConfig {
  return current;
}

export function setConn(patch: Partial<ConnConfig>): ConnConfig {
  const next = normalize({ ...current, ...patch });
  const changed = (Object.keys(next) as (keyof ConnConfig)[]).some((key) => next[key] !== current[key]);
  current = next;
  writeJson(CONN_KEY, next);
  if (changed) for (const listener of listeners) listener();
  return next;
}

export function resetConn(): ConnConfig {
  current = { ...DEFAULT_CONN };
  writeJson(CONN_KEY, current);
  for (const listener of listeners) listener();
  return current;
}

export function subscribeConn(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 拼接请求 URL：apiBase 为空时用同源相对路径。 */
export function buildUrl(apiBase: string, path: string, query?: Record<string, unknown>): string {
  const base = apiBase.trim().replace(/\/+$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const search = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}
