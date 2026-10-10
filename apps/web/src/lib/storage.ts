/**
 * 存储访问的唯一入口。
 *
 * 浏览器用 localStorage；Node（单元测试）没有 localStorage，
 * 退化成进程内 Map，这样配置模块本身也能被测试。
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memory = new Map<string, string>();

const memoryStore: KeyValueStore = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => {
    memory.set(key, value);
  },
  removeItem: (key) => {
    memory.delete(key);
  },
};

let cached: KeyValueStore | null = null;

/** 探测 localStorage 是否真的可用（隐私模式下 setItem 会抛异常）。 */
export function safeStorage(): KeyValueStore {
  if (cached) return cached;
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__submgr_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      cached = localStorage;
      return cached;
    }
  } catch {
    // 落到内存实现
  }
  cached = memoryStore;
  return cached;
}

export function readJson<T>(key: string): T | null {
  const raw = safeStorage().getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    safeStorage().setItem(key, JSON.stringify(value));
  } catch {
    // 存储写满 / 被禁用时不该让界面崩掉
  }
}
