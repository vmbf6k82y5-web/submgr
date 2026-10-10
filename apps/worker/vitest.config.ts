import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      // 与 core 一致：业务日期断言必须与进程时区无关
      TZ: 'UTC',
    },
  },
});
