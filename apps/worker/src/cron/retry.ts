/**
 * 通用重试（指数退避）。
 *
 * 只重试「调用方明确希望重试」的失败：这里不做错误分类，
 * 因为汇率接口的失败（网络抖动、5xx、限流）都值得重试，
 * 而重试次数与总时长都很小，不会把 cron 拖死。
 */

export interface RetryOptions {
  attempts: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
  onAttemptFailed?: (err: unknown, attempt: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  if (!Number.isInteger(opts.attempts) || opts.attempts < 1) {
    throw new RangeError(`withRetry: attempts 必须是正整数，收到 ${opts.attempts}`);
  }

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      opts.onAttemptFailed?.(err, attempt);
      if (attempt === opts.attempts) break;
      // 500ms -> 1000ms -> 2000ms ...
      await opts.sleep(opts.delayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
