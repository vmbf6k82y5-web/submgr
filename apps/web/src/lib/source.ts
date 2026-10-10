/**
 * 「当前数据来自哪里」的全局状态。
 *
 * api.ts 每次请求都会写入这里，Layout 顶部的横幅据此提示：
 * 「你看到的不是真实数据」这件事必须显眼，不能让示例数据冒充真账本。
 */

export interface SourceState {
  /** null = 还没有任何请求完成 */
  source: 'live' | 'mock' | null;
  /** 回落到示例数据的原因（中文，直接展示）。 */
  notice: string | null;
}

let current: SourceState = { source: null, notice: null };
const listeners = new Set<() => void>();

export function getSource(): SourceState {
  return current;
}

export function setSource(next: SourceState): void {
  if (next.source === current.source && next.notice === current.notice) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeSource(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试用：把状态复位。 */
export function resetSource(): void {
  setSource({ source: null, notice: null });
}
