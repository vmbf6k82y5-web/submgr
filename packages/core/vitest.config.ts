import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 强制 UTC，确保任何环境（含 CI）下日期断言都稳定。
    // core 内部本身也全部使用 UTC 锚定的日期运算，不依赖进程时区。
    env: {
      TZ: 'UTC',
    },
  },
});
