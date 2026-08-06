/* 知著 PenMark Service Worker
 * 目标：iPhone 安装为 PWA 后能拉到最新版本，同时离线可用。
 * 策略：
 *   - HTML 导航请求：network-first，网络失败回退缓存（保证每次打开都能拿到新版）
 *   - 静态资源（JS/CSS/图片/字体）：network-first，先走网络拿最新版本，失败回退缓存
 *   - 不缓存 API 请求（/api/*）与登录态相关请求，避免本地数据被 SW 缓存污染
 * 更新机制：CACHE_VERSION 变更 → install 时预缓存 → activate 清理旧版本缓存 → skipWaiting + clients.claim 立即生效
 */
const CACHE_VERSION = 'penmark-v1-20260806s';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/editor.js',
  '/login.js',
  '/manifest.json',
  '/favicon.svg',
  '/highlight-utils.js',
  '/vendor/highlight.min.js'
];

// ===== install：预缓存核心资源，跳过等待立即生效 =====
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.allSettled(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

// ===== activate：清理旧版本缓存，立即接管客户端 =====
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ===== fetch：分策略响应 =====
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 本地开发（localhost / 127.0.0.1）直接放行，不拦截不缓存，
  // 避免 SW 缓存静态资源导致改代码后硬刷新也拿不到最新版本
  if (self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1') return;

  // 只处理同源 GET 请求；跨域、POST、API 全部走网络
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API 与鉴权相关不缓存
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/login')) return;

  // HTML 导航请求：network-first
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 网络成功，复制一份到缓存（仅 200 才缓存）
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // 静态资源（JS/CSS/图片/字体）：network-first
  // 先走网络拿最新版本，网络失败再回退缓存。
  // 之前用 stale-while-revalidate 会导致用户刷新时立即拿到缓存的旧 JS/CSS，
  // 新功能即使部署了也看不到，故改为 network-first 与 HTML 保持一致。
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
  );
});

// ===== 接收前端"检查更新"消息：强制更新 SW 并通知页面刷新 =====
self.addEventListener('message', (event) => {
  if (event.data === 'penmark:check-update') {
    self.registration.update().then(() => {
      event.source && event.source.postMessage({ type: 'penmark:update-checked' });
    });
  }
});
