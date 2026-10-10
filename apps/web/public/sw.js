/*
 * 订阅管家 Service Worker（手写，不引入 Workbox / vite-plugin-pwa）。
 *
 * 策略（三条铁律）：
 *   1) /api/* 与 /ics/* 永不缓存：接口带鉴权、金额必须是新鲜的，缓存会掩盖数据问题；
 *   2) 导航请求 network-first：新版本优先上线，断网时回落到缓存里的 index.html；
 *   3) 其余同源静态资源 cache-first + 后台刷新：首屏秒开，下次进页面拿到新资源。
 *
 * 升级：改 VERSION 常量（或让构建注入版本）→ install 时预缓存新壳、activate 时删旧缓存。
 */

const VERSION = 'submgr-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 单个资源失败（例如离线安装）不应该让整个 SW 装不上
      await Promise.allSettled(SHELL_ASSETS.map((path) => cache.add(path)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ics/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('/index.html', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const cached = (await cache.match('/index.html')) ?? (await cache.match('/'));
          return cached ?? new Response('离线且没有缓存页面', { status: 503 });
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      const fromNetwork = fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);
      return cached ?? (await fromNetwork) ?? new Response('离线且没有缓存资源', { status: 503 });
    })(),
  );
});
