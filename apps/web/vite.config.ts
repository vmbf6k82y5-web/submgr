import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * 订阅管家前端构建配置。
 *
 * 开发时 /api 与 /ics 走 Vite 代理到本地 Worker（wrangler dev，默认 8787），
 * 这样浏览器里是同源请求，与线上（Worker 的 Static Assets 托管前端）行为一致。
 * Worker 没起来时代理会失败，前端会自动回落到内置示例数据（见 src/lib/api.ts）。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ics': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
