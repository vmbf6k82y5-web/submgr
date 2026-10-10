/**
 * React 侧的取数钩子。
 *
 * 没有引入 react-query / SWR：这个应用的取数需求就是「路径 + 查询参数 → 数据」，
 * 一个 60 行的 useEffect 足够，而且连接配置一改（令牌 / 模式）就能自动重取。
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { request } from '../lib/api';
import { getConn, subscribeConn, type ConnConfig } from '../lib/conn';
import { getSource, subscribeSource, type SourceState } from '../lib/source';

export function useConn(): ConnConfig {
  return useSyncExternalStore(subscribeConn, getConn, getConn);
}

export function useSource(): SourceState {
  return useSyncExternalStore(subscribeSource, getSource, getSource);
}

export interface QueryResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  source: 'live' | 'mock' | null;
  notice: string | null;
  reload: () => void;
}

interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  source: 'live' | 'mock' | null;
  notice: string | null;
}

const IDLE: QueryState<never> = {
  data: null,
  loading: false,
  error: null,
  source: null,
  notice: null,
};

/**
 * GET 一个接口。
 *
 * @param path 传 null 表示「还不想请求」（例如表单依赖的参数还没准备好）
 */
export function useApi<T>(
  path: string | null,
  options: { query?: Record<string, unknown> } = {},
): QueryResult<T> {
  const conn = useConn();
  const queryKey = JSON.stringify(options.query ?? {});
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<QueryState<T>>(IDLE as QueryState<T>);

  useEffect(() => {
    if (path === null) {
      setState(IDLE as QueryState<T>);
      return;
    }
    let cancelled = false;
    const query = JSON.parse(queryKey) as Record<string, unknown>;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    request<T>('GET', path, { query })
      .then((result) => {
        if (cancelled) return;
        setState({
          data: result.data,
          loading: false,
          error: null,
          source: result.source,
          notice: result.notice,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          data: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          source: null,
          notice: null,
        });
      });

    return () => {
      cancelled = true;
    };
    // conn 的四个字段都要参与依赖：改令牌/模式/示例场景都应该重新取数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, queryKey, nonce, conn.apiBase, conn.token, conn.mode, conn.mockScenario]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return useMemo(() => ({ ...state, reload }), [state, reload]);
}

export interface ActionResult {
  pending: boolean;
  error: string | null;
  setError: (message: string | null) => void;
}

/**
 * 提交动作（表单保存、删除）。
 * 返回值是回调的返回值；失败时返回 null 并把中文错误留在 error 里。
 */
export function useAction(): ActionResult & {
  run: <T>(fn: () => Promise<T>) => Promise<T | null>;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setPending(false);
    }
  }, []);

  return { run, pending, error, setError };
}
