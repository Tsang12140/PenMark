// 知著 PenMark 服务端（异步版）
// Express + PostgreSQL（网页版）/ SQLite（桌面版）
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const db = require('./database');
const auth = require('./auth');
const autoTitle = require('./auto-title');
const { registerAutoTitleRoutes } = require('./auto-title-routes');
const invites = require('./invites');
const ai = require('./ai');
const { createAssetStore } = require('./assets');
const assetStore = createAssetStore(db);
const { ZipArchive } = require('archiver');
const { htmlToMarkdown } = require('./html-to-md.js');

const app = express();
const PORT = process.env.PORT || 3001;
// 默认 '::' 让 Node 同时监听 IPv4 与 IPv6（双栈），避免浏览器把 localhost 解析到 ::1 后连不上 IPv4-only 的 0.0.0.0
const HOST = process.env.PENMARK_HOST || '::';

// Trust proxy（Nginx 反向代理时需要）
if (process.env.TRUST_PROXY) {
  const rawTrustProxy = String(process.env.TRUST_PROXY).trim();
  let trustProxy = rawTrustProxy;
  if (/^\d+$/.test(rawTrustProxy)) {
    trustProxy = Number(rawTrustProxy);
  } else if (rawTrustProxy.toLowerCase() === 'true') {
    trustProxy = true;
  } else if (rawTrustProxy.toLowerCase() === 'false') {
    trustProxy = false;
  }
  app.set('trust proxy', trustProxy);
}

// 桌面模式拒绝异常 Host，避免 DNS rebinding
app.use((req, res, next) => {
  if (process.env.PENMARK_DESKTOP === '1') {
    const expectedHost = `127.0.0.1:${req.socket.localPort}`;
    if (req.headers.host !== expectedHost) return res.status(403).send('Forbidden');
  }
  next();
});

app.use(express.json({ limit: '100mb' }));

function safeLoginRedirect(value) {
  const target = String(value || '');
  if (!target || !target.startsWith('/') || target.startsWith('//') || target.includes('\\')) return '/';
  try {
    const parsed = new URL(target, 'http://penmark.local');
    return parsed.origin === 'http://penmark.local' ? target : '/';
  } catch (_) {
    return '/';
  }
}

// Keep a valid session out of the static login form without a visible flash.
// It must precede express.static so /login.html reaches this handler first.
app.get('/login.html', async (req, res, next) => {
  try {
    if (process.env.PENMARK_DESKTOP === '1') return res.redirect(302, '/');
    const token = auth.readCookie(req, auth.COOKIE_NAME);
    if (!token) return next();
    const user = await auth.verifySession(token);
    if (!user) {
      auth.clearCookie(res, req);
      return next();
    }
    return res.redirect(302, safeLoginRedirect(req.query && req.query.redirect));
  } catch (err) {
    next(err);
  }
});

// /login（无扩展名）分享链接入口：与 /login.html 同逻辑，但无静态文件可回落，
// 故未登录时直接 sendFile(login.html)，URL 中的 ?invite=xxx 由 login.js 读取。
// 必须在通配 404 之前注册，否则 /login?invite=... 会落到 404 页。
app.get('/login', async (req, res, next) => {
  try {
    if (process.env.PENMARK_DESKTOP === '1') return res.redirect(302, '/');
    const token = auth.readCookie(req, auth.COOKIE_NAME);
    if (!token) return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    const user = await auth.verifySession(token);
    if (!user) {
      auth.clearCookie(res, req);
      return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    }
    return res.redirect(302, safeLoginRedirect(req.query && req.query.redirect));
  } catch (err) {
    next(err);
  }
});

// sw.js 必须始终拿最新版本：否则浏览器无法感知 Service Worker 更新，
// 导致新部署的前端代码被旧 SW 缓存卡住，用户硬刷新也拿不到新版。
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Document URLs share the editor shell; the browser loads the requested document on demand.
app.get(/^\/d\/[1-9]\d*\/?$/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ---------- async 路由包装器 ---------- */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- 同源校验（CSRF 防护，兼容 Nginx/宝塔反向代理） ---------- */
const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const CONFIGURED_APP_ORIGINS = new Set(
  String(process.env.APP_ORIGIN || '')
    .split(',')
    .map(value => normalizeOrigin(value.trim()))
    .filter(Boolean)
);

function normalizeOrigin(value) {
  if (!value) return null;
  try { return new URL(value).origin; } catch (_) { return null; }
}

function firstForwardedValue(value) {
  return String(value || '').split(',')[0].trim();
}

function getPublicRequestOrigin(req) {
  // 优先使用 APP_ORIGIN 环境变量：这是部署方显式声明的对外公开 URL，
  // 比 X-Forwarded-Host 更可靠（反代可能未配置转发头，导致 origin 退化为 127.0.0.1）。
  // 多个 origin 用逗号分隔时取第一个作为 canonical。
  if (CONFIGURED_APP_ORIGINS.size > 0) {
    return Array.from(CONFIGURED_APP_ORIGINS)[0];
  }
  const trustProxy = app.enabled('trust proxy');
  const forwardedHost = trustProxy ? firstForwardedValue(req.headers['x-forwarded-host']) : '';
  const forwardedProto = trustProxy ? firstForwardedValue(req.headers['x-forwarded-proto']) : '';
  const host = forwardedHost || req.headers.host || '';
  const protocol = forwardedProto || req.protocol || 'http';
  return normalizeOrigin(`${protocol}://${host}`);
}

app.use((req, res, next) => {
  if (!WRITE_METHODS.has(req.method) || !req.path.startsWith('/api/')) return next();

  // 同源 fetch 通常携带 Origin；部分导航或旧浏览器只有 Referer。
  // 无来源头的非浏览器调用仍由会话认证和桌面随机 Cookie 保护。
  const suppliedOrigin = req.headers.origin || req.headers.referer || '';
  if (!suppliedOrigin) return next();

  const requestOrigin = normalizeOrigin(suppliedOrigin);
  if (!requestOrigin) return res.status(403).json({ error: '请求来源无效' });

  const allowedOrigins = new Set(CONFIGURED_APP_ORIGINS);
  const proxyAwareOrigin = getPublicRequestOrigin(req);
  if (proxyAwareOrigin) allowedOrigins.add(proxyAwareOrigin);

  if (!allowedOrigins.has(requestOrigin)) {
    return res.status(403).json({ error: '跨域请求被拒绝' });
  }
  next();
});

/* ---------- 健康检查 ---------- */
app.get('/health/live', (req, res) => res.json({ ok: true }));

app.get('/health/ready', wrap(async (req, res) => {
  const h = await db.health();
  res.status(h.ok ? 200 : 503).json(h);
}));

/* ---------- 通用速率限制器 ---------- */
// 注意：进程内 Map，仅适用于单实例部署；多实例需换 Redis 等共享存储
function createRateLimiter({ windowMs, max, keyFn, message }) {
  const buckets = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) { if (now > v.reset) buckets.delete(k); }
  }, Math.min(windowMs * 2, 120000));
  if (cleanup.unref) cleanup.unref();
  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = keyFn(req);
    let bucket = buckets.get(key);
    if (bucket && bucket.count >= max && now < bucket.reset) {
      return res.status(429).json({ error: message || '请求过于频繁，请稍后再试' });
    }
    if (!bucket || now > bucket.reset) bucket = { count: 0, reset: now + windowMs };
    bucket.count++;
    buckets.set(key, bucket);
    next();
  };
}

// AI 接口限速：每个登录用户每分钟 20 次
const aiLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyFn: req => 'ai:' + (req.user ? req.user.id : req.ip),
  message: 'AI 请求过于频繁，请稍后再试'
});
// 图片代理限速：每个用户每分钟 30 次
const proxyImageLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: req => 'img:' + (req.user ? req.user.id : req.ip),
  message: '图片请求过于频繁，请稍后再试'
});
// OG 元数据限速：每个用户每分钟 20 次
const ogLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyFn: req => 'og:' + (req.user ? req.user.id : req.ip),
  message: '链接抓取过于频繁，请稍后再试'
});
// 访客上报限速：每个 token + IP 每分钟 60 次
const visitLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  keyFn: req => 'visit:' + (req.ip || '') + ':' + req.params.token
});
// 举报限速：每个用户每分钟 10 次
const reportLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  keyFn: req => 'report:' + (req.user ? req.user.id : req.ip)
});

/* ---------- 登录速率限制 ---------- */
const LOGIN_RATE_LIMIT = parseInt(process.env.LOGIN_RATE_LIMIT || '10', 10);
const loginRateLimit = new Map();
const loginRateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginRateLimit) { if (now > v.reset) loginRateLimit.delete(k); }
}, 60000);
if (loginRateCleanupTimer.unref) loginRateCleanupTimer.unref();

function checkLoginRate(ip) {
  const now = Date.now();
  let limit = loginRateLimit.get(ip);
  if (limit && limit.count >= LOGIN_RATE_LIMIT && now < limit.reset) return false;
  if (!limit || now > limit.reset) limit = { count: 0, reset: now + 60000 };
  limit.count++;
  loginRateLimit.set(ip, limit);
  return true;
}

/* ---------- 鉴权路由 ---------- */
app.post('/api/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  if (!checkLoginRate(req.ip)) return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
  const r = await auth.login(String(username).trim(), String(password), req);
  if (!r.ok) return res.status(401).json({ error: r.error });
  auth.setCookie(res, r.token, req);
  res.json({ user: r.user });
}));

app.post('/api/auth/register', wrap(async (req, res) => {
  const { username, nickname, password, invite_code } = req.body || {};
  if (!username || !nickname || !password || !invite_code) {
    return res.status(400).json({ error: '请填写完整信息' });
  }
  if (!checkLoginRate(req.ip)) return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
  const r = await auth.register(String(username), String(nickname), String(password), String(invite_code), req);
  if (!r.ok) return res.status(409).json({ error: r.error });
  auth.setCookie(res, r.token, req);
  res.json({ user: r.user });
}));

app.get('/api/auth/me', wrap(async (req, res) => {
  // 桌面模式：检查桌面 Cookie
  if (process.env.PENMARK_DESKTOP === '1') {
    if (!auth.isDesktopRequestAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    const u = await auth.ensureDesktopUser();
    return res.json({ user: u });
  }
  // 网页模式：检查服务端会话
  const token = auth.readCookie(req, auth.COOKIE_NAME);
  if (!token) return res.status(401).json({ error: 'unauthorized', needLogin: true });
  const user = await auth.verifySession(token);
  if (!user) {
    auth.clearCookie(res, req);
    return res.status(401).json({ error: 'unauthorized', needLogin: true });
  }
  res.json({ user });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  const token = auth.readCookie(req, auth.COOKIE_NAME);
  if (token) await auth.revokeSession(token);
  auth.clearCookie(res, req);
  res.json({ ok: true });
}));

/* ---------- 以下 API 需要登录 ---------- */
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (req.path.startsWith('/public/')) return next();
  wrap(auth.authMiddleware)(req, res, next);
});

/* ---------- 防 SSRF：拦截内网地址 ---------- */
// 完整覆盖：IPv4 私有/保留段、IPv6 私有/loopback/link-local、十进制/八进制/十六进制/短格式 IP
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'host.docker.internal',
  'metadata.azure.com'
]);

function parseIPv4(s) {
  if (typeof s !== 'string' || !s) return null;
  // 纯十进制整数形式：2130706433 → 127.0.0.1
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0 || n > 0xFFFFFFFF) return null;
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  const parts = s.split('.');
  if (parts.length > 4) return null;
  const octets = [];
  for (const part of parts) {
    if (part === '') return null;
    let n;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) n = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part, 8);
    else if (/^\d+$/.test(part)) n = parseInt(part, 10);
    else return null;
    if (!Number.isInteger(n) || n < 0 || n > 0xff) return null;
    octets.push(n);
  }
  // 短格式补齐：127.1 → 127.0.0.1
  while (octets.length < 4) octets.splice(octets.length - 1, 0, 0);
  return octets.length === 4 ? octets : null;
}

function isPrivateIPv4(ip) {
  const [a, b] = ip;
  if (a === 0) return true;                                  // 0.0.0.0/8 当前网络
  if (a === 10) return true;                                 // 10.0.0.0/8 私有 A
  if (a === 127) return true;                                 // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;                    // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16.0.0/12 私有 B
  if (a === 192 && b === 0) return true;                      // 192.0.0.0/24 IETF
  if (a === 192 && b === 168) return true;                    // 192.168.0.0/16 私有 C
  if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true;       // 198.18.0.0/15 基准测试
  if (a === 198 && b === 51 && ip[2] === 100) return true;    // TEST-NET-2
  if (a === 203 && b === 0 && ip[2] === 113) return true;     // TEST-NET-3
  if (a === 192 && b === 0 && ip[2] === 2) return true;       // TEST-NET-1
  if (a >= 224) return true;                                  // 224.0.0.0/3 组播 + 保留
  return false;
}

function isPrivateIPv6(s) {
  const h = String(s).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;                 // loopback / 未指定
  if (h.startsWith('fc') || h.startsWith('fd')) return true;  // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(h) || h === 'fe80::' || /^fe[89ab][0-9a-f]::/.test(h)) return true; // fe80::/10 link-local
  if (h.startsWith('ff')) return true;                          // ff00::/8 组播
  if (h.startsWith('2001:db8')) return true;                    // 2001:db8::/32 文档
  // IPv4-mapped IPv6: ::ffff:a.b.c.d
  const m = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) {
    const ip = parseIPv4(m[1]);
    if (ip) return isPrivateIPv4(ip);
  }
  // IPv4-compatible: ::a.b.c.d
  const m2 = h.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m2) {
    const ip = parseIPv4(m2[1]);
    if (ip) return isPrivateIPv4(ip);
  }
  return false;
}

function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, ''); // 去掉 IPv6 方括号
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  const ipv4 = parseIPv4(h);
  if (ipv4) return isPrivateIPv4(ipv4);
  // 包含冒号视为 IPv6
  if (h.includes(':')) return isPrivateIPv6(h);
  // 末尾带点（DNS 根解析）也接受
  return false;
}

/* ---------- 远程图片代理 ---------- */
function fetchImageAsBase64(url, maxRedirects, cb) {
  // finished 守卫：防止 timeout / error / data 多次回调 cb（destroy 是异步的，
  // 期间可能还有 data/end 事件触发，导致下游 res.json 被调用两次引发 "Cannot set headers"）
  let finished = false;
  function done(err, data, ct, len) {
    if (finished) return;
    finished = true;
    cb(err, data, ct, len);
  }
  if (maxRedirects < 0) { done(new Error('too many redirects')); return; }
  let parsed;
  try { parsed = new URL(url); } catch (_) { done(new Error('invalid url')); return; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { done(new Error('bad protocol')); return; }
  if (isPrivateHost(parsed.hostname)) { done(new Error('blocked host')); return; }
  const lib = parsed.protocol === 'https:' ? https : http;
  const req = lib.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': parsed.origin + '/',
      'Accept': 'image/*,*/*;q=0.8'
    },
    timeout: 12000
  }, (resp) => {
    if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
      resp.resume();
      const next = new URL(resp.headers.location, url).href;
      fetchImageAsBase64(next, maxRedirects - 1, done);
      return;
    }
    if (resp.statusCode !== 200) { resp.resume(); done(new Error('HTTP ' + resp.statusCode)); return; }
    const chunks = [];
    let size = 0;
    const MAX = 15 * 1024 * 1024;
    resp.on('data', (c) => {
      size += c.length;
      if (size > MAX) { try { req.destroy(); } catch (_) {} done(new Error('too large')); return; }
      chunks.push(c);
    });
    resp.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = (resp.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
      done(null, 'data:' + ct + ';base64,' + buf.toString('base64'), ct, buf.length);
    });
  });
  req.on('error', (err) => done(err));
  req.on('timeout', () => { try { req.destroy(); } catch (_) {} done(new Error('timeout')); });
}

app.get('/api/proxy-image', proxyImageLimiter, wrap(async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'invalid url' });
  fetchImageAsBase64(url, 4, (err, dataUrl, ct, size) => {
    if (err) return res.status(502).json({ error: err.message });
    res.json({ dataUrl, contentType: ct, size });
  });
}));

/* ---------- 邀请码管理（仅管理员） ---------- */
app.get('/api/invites', auth.adminOnly, wrap(async (req, res) => {
  res.json(await invites.list());
}));

app.post('/api/invites', auth.adminOnly, wrap(async (req, res) => {
  const count = req.body.count || 1;
  res.json(await invites.generateBatch(count));
}));

app.delete('/api/invites/:code', auth.adminOnly, wrap(async (req, res) => {
  const ok = await invites.remove(req.params.code);
  if (!ok) return res.status(400).json({ error: '无法删除（不存在或已被使用）' });
  res.json({ deleted: true });
}));

/* ---------- 链接卡片元数据抓取 ---------- */
// LRU 上限：超过 500 条时删除最早访问的，防止内存无限增长
const OG_CACHE_MAX = 500;
const ogCache = new Map();
function ogCacheGet(key) {
  if (!ogCache.has(key)) return null;
  const value = ogCache.get(key);
  // Map 的迭代顺序按插入顺序，重新 set 即可把这条挪到最新（LRU）
  ogCache.delete(key);
  ogCache.set(key, value);
  return value;
}
function ogCacheSet(key, value) {
  if (ogCache.has(key)) ogCache.delete(key);
  ogCache.set(key, value);
  if (ogCache.size > OG_CACHE_MAX) {
    // 删除最旧的一条（第一个）
    const oldestKey = ogCache.keys().next().value;
    if (oldestKey !== undefined) ogCache.delete(oldestKey);
  }
}
function fetchOG(url, depth) {
  depth = depth || 0;
  if (depth > 3) return Promise.reject(new Error('重定向过多'));
  const cached = ogCacheGet(url);
  if (cached) {
    if (Date.now() - cached.t < 3600000) return Promise.resolve(cached.data);
    ogCache.delete(url); // 过期清理
  }
  let u;
  try { u = new URL(url); } catch (_) { return Promise.reject(new Error('无效链接')); }
  if (!/^https?:$/.test(u.protocol)) return Promise.reject(new Error('仅支持 http/https'));
  if (isPrivateHost(u.hostname)) return Promise.reject(new Error('不支持内网地址'));
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { headers: { 'User-Agent': 'PenMark/1.0' }, timeout: 6000 }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        const loc = new URL(resp.headers.location, url).href;
        resp.resume();
        fetchOG(loc, depth + 1).then(resolve).catch(reject);
        return;
      }
      if (resp.statusCode !== 200) { resp.resume(); reject(new Error('HTTP ' + resp.statusCode)); return; }
      const ct = resp.headers['content-type'] || '';
      if (!/text\/html|application\/xhtml/i.test(ct)) { resp.resume(); reject(new Error('非 HTML 页面')); return; }
      const chunks = []; let size = 0, tooBig = false;
      resp.on('data', d => { size += d.length; if (size > 1048576) { tooBig = true; resp.destroy(); return; } chunks.push(d); });
      resp.on('end', () => {
        if (tooBig) { reject(new Error('页面过大')); return; }
        const buf = Buffer.concat(chunks).toString('utf8');
        const meta = parseOG(buf, url);
        ogCacheSet(url, { t: Date.now(), data: meta });
        resolve(meta);
      });
      resp.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.on('error', reject);
  });
}

function parseOG(html, url) {
  const attr = (tag, name) => {
    const re = new RegExp(name + "\\s*=\\s*([\"'])(.*?)\\1", 'i');
    const m = String(tag || '').match(re);
    return m ? decodeEntities(m[2]) : '';
  };
  const findMeta = (keys) => {
    for (const key of keys) {
      const tags = html.match(/<meta\b[^>]*>/gi) || [];
      for (const tag of tags) {
        const prop = (attr(tag, 'property') || attr(tag, 'name') || attr(tag, 'itemprop')).toLowerCase();
        if (prop === key.toLowerCase()) {
          const value = attr(tag, 'content');
          if (value) return value;
        }
      }
    }
    return '';
  };
  const findLink = (rels) => {
    const tags = html.match(/<link\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const rel = (attr(tag, 'rel') || '').toLowerCase();
      if (rels.some(r => rel.split(/\s+/).includes(r))) {
        const href = attr(tag, 'href');
        if (href) return href;
      }
    }
    return '';
  };
  const resolveAsset = (asset) => {
    if (!asset) return '';
    try { return new URL(asset, url).href; } catch (_) { return ''; }
  };
  const title = findMeta(['og:title', 'twitter:title'])
    || (() => { const m = html.match(/<title[^>]*>([^<]*)<\/title>/i); return m ? decodeEntities(m[1]) : ''; })();
  const desc = findMeta(['og:description', 'twitter:description', 'description']);
  const image = findMeta(['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image'])
    || findLink(['image_src'])
    || findLink(['apple-touch-icon', 'apple-touch-icon-precomposed', 'icon', 'shortcut']);
  let domain;
  try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { domain = url; }
  const fallbackIcon = resolveAsset('/favicon.ico');
  return {
    url, title: (title || domain).slice(0, 200), description: desc.slice(0, 300),
    image: resolveAsset(image) || fallbackIcon, domain
  };
}
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// 识别产品内链接（/d/{id} 或 /s/{token}）：仅同源才认，避免误抓
function parseInternalLink(url, req) {
  try {
    let path;
    if (/^https?:\/\//i.test(url)) {
      const u = new URL(url);
      const origin = getPublicRequestOrigin(req);
      const shareBase = process.env.SHARE_BASE_URL ? String(process.env.SHARE_BASE_URL).replace(/\/+$/, '') : null;
      // 比对所有已配置 APP_ORIGIN（逗号分隔多域名）+ 当前请求 origin + SHARE_BASE_URL，
      // 避免多域名部署或反代场景下地址栏 URL origin 对不上导致内链识别失败
      const allowed = new Set(CONFIGURED_APP_ORIGINS);
      if (origin) allowed.add(origin);
      if (shareBase) allowed.add(shareBase);
      if (!allowed.has(u.origin)) return null;
      path = u.pathname;
    } else {
      path = url;
    }
    let m = path.match(/^\/d\/(\d+)$/);
    if (m) return { type: 'd', id: Number(m[1]) };
    // 兼容旧 base64url token（可能含 - _）与新消歧字符集 token
    m = path.match(/^\/s\/([a-zA-Z0-9_-]+)$/);
    if (m) return { type: 's', token: m[1] };
    return null;
  } catch (_) { return null; }
}
// 产品内链接直接查库返回文档标题/摘要，不走 fetchOG（外部抓取拿不到登录态下的 /d/ 标题，
// 也无法穿透加密分享）。A 文档引用 B 文档时卡片应显示 B 的标题。
async function fetchInternalLinkMeta(kind, req) {
  const origin = getPublicRequestOrigin(req);
  const domain = (origin ? origin.replace(/^https?:\/\//, '') : '') || 'PenMark';
  if (kind.type === 'd') {
    if (!req.user) return null;
    const row = await db.one('SELECT title, content FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [kind.id, req.user.id]);
    if (!row) return null;
    return {
      url: origin + '/d/' + kind.id,
      title: (row.title || '无标题').slice(0, 200),
      description: extractTextExcerpt(row.content, 300),
      image: extractFirstRemoteImage(row.content),
      domain
    };
  }
  if (kind.type === 's') {
    const row = await db.one('SELECT d.title, d.content, s.password_hash, s.expire_at FROM shares s JOIN documents d ON d.id = s.doc_id WHERE s.token = $1', [kind.token]);
    if (!row) return null;
    if (row.expire_at && row.expire_at < Date.now()) return null;
    // 加密分享不向未认证访客泄露标题
    if (row.password_hash) {
      return { url: origin + '/s/' + kind.token, title: '加密分享', description: '需要访问码才能查看', image: '', domain };
    }
    return {
      url: origin + '/s/' + kind.token,
      title: (row.title || '无标题').slice(0, 200),
      description: extractTextExcerpt(row.content, 300),
      image: extractFirstRemoteImage(row.content),
      domain
    };
  }
  return null;
}

app.get('/api/og', ogLimiter, wrap(async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: '缺少 url' });
  const internal = parseInternalLink(url, req);
  if (internal) {
    try {
      const meta = await fetchInternalLinkMeta(internal, req);
      if (meta) return res.json(meta);
    } catch (e) { /* 内部查询失败则回退到通用抓取 */ }
  }
  try {
    const meta = await fetchOG(url);
    res.json(meta);
  } catch (e) {
    res.status(502).json({ error: '抓取失败：' + (e.message || e) });
  }
}));

/* ---------- 导出真 .docx（零依赖 OOXML，AI 文档解析器可读） ---------- */
app.post('/api/export/docx', wrap(async (req, res) => {
  const html = String(req.body && req.body.html || '');
  const title = String(req.body && req.body.title || '文档').slice(0, 200);
  if (!html.trim()) return res.status(400).json({ error: '内容为空' });
  try {
    const docxBuffer = require('./desktop/docx.cjs').generateDocx(html, title);
    const safeName = encodeURIComponent(title.replace(/[\\/:*?"<>|]/g, '_'));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeName}.docx`);
    res.setHeader('Content-Length', docxBuffer.length);
    res.send(docxBuffer);
  } catch (e) {
    res.status(500).json({ error: '导出失败：' + (e.message || e) });
  }
}));

/* ---------- 用户头像（base64，前端裁剪弹窗 Canvas 压缩） ---------- */
// 头像字段最大 200KB（前端主动压缩兜底，极端图取最小档）
const AVATAR_MAX_BYTES = 200 * 1024;
app.post('/api/user/avatar', wrap(async (req, res) => {
  const avatar = String(req.body && req.body.avatar || '').trim();
  if (!avatar) return res.status(400).json({ error: '请上传头像' });
  // 接受 data:image/(png|jpeg|webp);base64, 前缀，由前端裁剪弹窗 Canvas.toBlob 生成
  const m = avatar.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return res.status(400).json({ error: '头像格式不正确' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > AVATAR_MAX_BYTES) {
    return res.status(400).json({ error: '头像过大，请换一张图' });
  }
  await db.execute('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, req.user.id]);
  // 桌面用户缓存失效，下次 /api/auth/me 返回最新头像
  if (process.env.PENMARK_DESKTOP === '1') auth.invalidateDesktopUserCache();
  res.json({ ok: true, avatar });
}));

app.delete('/api/user/avatar', wrap(async (req, res) => {
  await db.execute('UPDATE users SET avatar = $1 WHERE id = $2', ['', req.user.id]);
  if (process.env.PENMARK_DESKTOP === '1') auth.invalidateDesktopUserCache();
  res.json({ ok: true });
}));

/* ---------- 文档 CRUD（按 user_id 隔离） ---------- */
// 文档内容大小上限（默认 5MB），与 Nginx client_max_body_size 协同
const DOC_MAX_BYTES = Number(process.env.PENMARK_DOC_MAX_BYTES) || 5 * 1024 * 1024;
// Keep API-created titles within the same limit as the browser editor.
const DOC_TITLE_MAX_LENGTH = 100;

const DEFAULT_UNTITLED_TITLE = String.fromCharCode(0x65e0, 0x6807, 0x9898);
const AUTO_TITLE_SETTING_KEY = 'auto_title_enabled';
const AUTO_TITLE_MIN_CHARS = 40;
const AUTO_TITLE_CONTEXT_MAX = 2400;
let autoTitleInFlight = false;

function isUntitledTitle(value) {
  const title = String(value || '').trim();
  return !title || title === DEFAULT_UNTITLED_TITLE;
}


async function verifyFolderOwnership(folderId, userId) {
  if (folderId === null || folderId === undefined) return null;
  const fid = Number(folderId);
  if (!Number.isInteger(fid) || fid <= 0) {
    const err = new Error('无效的文件夹ID');
    err.code = 'INVALID_FOLDER';
    throw err;
  }
  const folder = await db.one('SELECT id FROM folders WHERE id = $1 AND user_id = $2', [fid, userId]);
  if (!folder) {
    const err = new Error('文件夹不存在或无权访问');
    err.code = 'FOLDER_NOT_FOUND';
    throw err;
  }
  return fid;
}

app.get('/api/documents', wrap(async (req, res) => {
  // The write-side list remains metadata-only. The home dashboard opts into a
  // bounded preview so opening or switching documents never reads every body.
  const withPreview = req.query.preview === '1';
  const previewFields = !withPreview ? '' : (db.isPostgres()
    ? ', SUBSTRING(content FROM 1 FOR 1200) AS content_preview, CHAR_LENGTH(content) AS content_length'
    : ', SUBSTR(content, 1, 1200) AS content_preview, LENGTH(content) AS content_length');
  const rows = await db.query(
    'SELECT id, title, folder_id, created_at, updated_at, starred, pinned' + previewFields + ' FROM documents WHERE user_id = $1 AND deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC',
    [req.user.id]
  );
  if (!withPreview) return res.json(rows);
  res.json(rows.map(({ content_preview, ...doc }) => Object.assign(doc, {
    content_length: Number(doc.content_length) || 0,
    snippet: stripHtml(content_preview || '').replace(/\s+/g, ' ').trim().slice(0, 180)
  })));
}));

app.get('/api/documents/:id', wrap(async (req, res) => {
  const row = await db.one('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
}));

// Private image route: only the document owner can read a random UUID asset.
app.get('/api/assets/:id', wrap(async (req, res) => {
  let asset = await db.one(
    'SELECT a.* FROM media_assets a JOIN documents d ON d.id = a.doc_id WHERE a.id = $1 AND a.owner_id = $2 AND d.user_id = $3 AND d.deleted_at IS NULL',
    [req.params.id, req.user.id, req.user.id]
  );
  if (!asset) return res.status(404).json({ error: 'not found' });
  // S4 启用但资源仍 pending 时，主动等待上传完成，避免 owner 看不到自己刚上传的图
  if (asset.remote_provider === 's4' && asset.remote_status === 'pending') {
    await assetStore.waitRemoteReady(asset.id, 5000);
    const refreshed = await db.one('SELECT * FROM media_assets WHERE id = $1', [asset.id]);
    if (refreshed) asset = refreshed;
  }
  // The stable PenMark URL remains in document HTML. Only an authorized request
  // receives a fresh S4 redirect, so expiry/revocation checks still happen here.
  const remoteUrl = assetStore.signedRemoteUrl(asset);
  if (remoteUrl) {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.redirect(302, remoteUrl);
  }
  const filePath = await assetStore.filePath(asset);
  if (!filePath) return res.status(404).json({ error: '\u8d44\u6e90\u4e0d\u5b58\u5728' });
  res.set({
    'Content-Type': asset.mime_type,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff'
  });
  res.sendFile(filePath);
}));

// 缩略图：版本历史预览用超小图，省带宽。无缩略图则回退原图。
app.get('/api/assets/:id/thumb', wrap(async (req, res) => {
  const asset = await db.one(
    'SELECT a.* FROM media_assets a JOIN documents d ON d.id = a.doc_id WHERE a.id = $1 AND a.owner_id = $2 AND d.user_id = $3 AND d.deleted_at IS NULL',
    [req.params.id, req.user.id, req.user.id]
  );
  if (!asset) return res.status(404).json({ error: 'not found' });
  const thumbPath = await assetStore.thumbFilePath(asset);
  if (thumbPath) {
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    return res.sendFile(thumbPath);
  }
  // 无缩略图（旧图或生成失败）：回退原图
  const original = await assetStore.filePath(asset);
  if (!original) return res.status(404).json({ error: '\u8d44\u6e90\u4e0d\u5b58\u5728' });
  res.set({ 'Content-Type': asset.mime_type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.sendFile(original);
}));

// New pasted/dropped images show locally first, then upload in the background.
app.post('/api/documents/:id/assets', wrap(async (req, res) => {
  const doc = await db.one('SELECT id, user_id FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [req.params.id, req.user.id]);
  if (!doc) return res.status(404).json({ error: 'not found' });
  const dataUrl = String(req.body && req.body.data_url || '');
  let asset;
  try {
    asset = await assetStore.create({ docId: doc.id, ownerId: doc.user_id, isAdmin: !!req.user.isAdmin, dataUrl, mirrorToRemote: true });
  } catch (err) {
    if (err && err.code === 'QUOTA_EXCEEDED') {
      return res.status(413).json({ error: err.message, quota_reason: err.quotaReason });
    }
    return res.status(400).json({ error: err && err.message ? err.message : '\u56fe\u7247\u4e0a\u4f20\u5931\u8d25' });
  }
  res.status(201).json(asset);
}));

// Legacy Base64 images migrate after a document has opened; first paint never waits.
// The version predicate prevents this background job from overwriting a new edit.
app.post('/api/documents/:id/optimize-images', wrap(async (req, res) => {
  const doc = await db.one(
    'SELECT id, user_id, content, version FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [req.params.id, req.user.id]
  );
  if (!doc) return res.status(404).json({ error: 'not found' });
  // 旧版内联 base64 图片迁移：S4 启用时所有用户都镜像
  const optimized = await assetStore.externalize(Object.assign(doc, { ownerIsAdmin: !!req.user.isAdmin, mirrorToRemote: true }));
  if (!optimized.optimized) return res.json({ optimized: 0, skipped: optimized.skipped || 0, version: doc.version });
  const now = Date.now();
  const info = await db.execute(
    'UPDATE documents SET content = $1, updated_at = $2, version = version + 1 WHERE id = $3 AND user_id = $4 AND version = $5',
    [optimized.content, now, doc.id, req.user.id, doc.version]
  );
  if (!info.changes) return res.status(409).json({ error: '\u6587\u6863\u5df2\u66f4\u65b0\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5' });
  const latest = await db.one('SELECT version, updated_at FROM documents WHERE id = $1 AND user_id = $2', [doc.id, req.user.id]);
  res.json({
    optimized: optimized.optimized,
    skipped: optimized.skipped || 0,
    content: optimized.content,
    version: latest && latest.version,
    updated_at: latest && latest.updated_at
  });
}));

app.post('/api/documents', wrap(async (req, res) => {
  const now = Date.now();
  const rawFolderId = req.body.folder_id;
  const folderId = (rawFolderId === 0 || rawFolderId === null || rawFolderId === undefined || rawFolderId === '')
    ? null
    : await verifyFolderOwnership(rawFolderId, req.user.id).catch(err => {
        if (err.code === 'FOLDER_NOT_FOUND') return null; // 容错：找不到则不挂文件夹
        throw err;
      });
  const title = String(req.body.title || '无标题').slice(0, DOC_TITLE_MAX_LENGTH);
  const content = String(req.body.content || '').slice(0, DOC_MAX_BYTES);
  const titleOrigin = isUntitledTitle(title) ? 'untitled' : 'manual';
  const info = await db.execute(
    'INSERT INTO documents (title, title_origin, content, created_at, updated_at, user_id, folder_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [title, titleOrigin, content, now, now, req.user.id, folderId]
  );
  res.json({ id: info.insertId });
}));

app.put('/api/documents/:id', wrap(async (req, res) => {
  const now = Date.now();
  const title = String(req.body.title || '').slice(0, DOC_TITLE_MAX_LENGTH);
  const content = String(req.body.content || '').slice(0, DOC_MAX_BYTES);
  const docId = req.params.id;
  const requestedTitleOrigin = String(req.body && req.body.title_origin || '');
  const titleOrigin = isUntitledTitle(title) ? 'untitled' : (requestedTitleOrigin === 'auto' ? 'auto' : 'manual');
  const userId = req.user.id;

  // 读取旧内容 + UPDATE + 版本号回查放在同一事务内，避免 TOCTOU：
  // 原实现先读 prevRow 再 UPDATE，中间若插入并发保存，prevRow 会指向更早的版本，
  // 导致版本快照差异算错（应与"上一版"比较，却与"上上版"比较）。
  // 事务内读取保证 SQLite 下 read+update 原子（事务互斥锁串行化）。
  let updatedChanges = 0;
  let vRow = null;
  let snapshotPayload = null; // 事务内算好差异，事务外再 setImmediate 落库
  try {
    const txResult = await db.transaction(async (tx) => {
      let prevRow = null;
      try {
        prevRow = await tx.one('SELECT title, content, version FROM documents WHERE id = $1 AND user_id = $2', [docId, userId]);
      } catch (e) {
        // 表不存在或异常时不阻塞主保存，但记录日志便于排查版本历史丢失
        console.warn('[doc/save] 读取旧版本快照失败：', e && e.message);
      }

      const info = await tx.execute(
        'UPDATE documents SET title = $1, title_origin = $2, content = $3, updated_at = $4, version = version + 1 WHERE id = $5 AND user_id = $6',
        [title, titleOrigin, content, now, docId, userId]
      );
      if (info.changes === 0) throw new Error('NOT_FOUND');
      // 回查最新版本号，回传给客户端用于多端同步判断
      const v = await tx.one('SELECT version, updated_at FROM documents WHERE id = $1', [docId]);

      // 事务内计算差异（基于与 UPDATE 同一快照的 prevRow），事务外再异步写入
      if (prevRow && (prevRow.title !== title || prevRow.content !== content)) {
        const prevText = stripHtml(prevRow.content || '');
        const currText = stripHtml(content || '');
        const charsDiff = Math.abs(currText.length - prevText.length);
        snapshotPayload = {
          title: prevRow.title || '',
          content: prevRow.content || '',
          charsDiff,
          version: prevRow.version || Math.max(1, ((v && v.version) || 2) - 1),
          source: 'auto'
        };
      }
      return { changes: info.changes, v };
    });
    updatedChanges = txResult.changes;
    vRow = txResult.v;
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: 'not found' });
    throw e;
  }

  if (req.body.folder_id !== undefined) {
    const raw = req.body.folder_id;
    let fid;
    if (raw === 0 || raw === null || raw === '') {
      fid = null;
    } else {
      try {
        fid = await verifyFolderOwnership(raw, req.user.id);
      } catch (e) {
        if (e.code === 'FOLDER_NOT_FOUND') {
          return res.status(404).json({ error: '目标文件夹不存在或无权访问' });
        }
        return res.status(400).json({ error: e.message });
      }
    }
    await db.execute('UPDATE documents SET folder_id = $1 WHERE id = $2 AND user_id = $3', [fid, docId, userId]);
  }
  // 异步敏感词检查 + 版本快照写入（不阻塞保存；错误必须被捕获避免 unhandled rejection）
  // 快照的差异已在事务内算好（snapshotPayload），此处仅落库，避免 TOCTOU
  setImmediate(() => {
    (async () => {
      try {
        const sensitiveWords = await db.query('SELECT word FROM sensitive_words');
        if (sensitiveWords.length > 0) {
          const contentLower = (String(title || '') + ' ' + String(content || '')).toLowerCase();
          const matched = sensitiveWords.some(w => contentLower.includes(w.word.toLowerCase()));
          if (matched) {
            await db.execute('UPDATE documents SET flagged = 1, flag_reason = $1 WHERE id = $2 AND flagged = 0', ['命中敏感词', docId]);
          }
        }
      } catch (e) {
        console.warn('敏感词检查跳过：', e && e.message);
      }
      // 版本快照：差异已在事务内算好，此处仅 INSERT
      try {
        if (snapshotPayload) {
          const latest = await db.one(
            'SELECT created_at FROM document_versions WHERE doc_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1',
            [docId, userId]
          );
          // 放缓版本频率：10 分钟间隔 + 至少 50 字差异才存快照（改几个标点不存）
          const minInterval = 10 * 60 * 1000;
          const minCharsDiff = 50;
          if ((!latest || now - latest.created_at >= minInterval) && snapshotPayload.charsDiff >= minCharsDiff) {
            await db.execute(
              'INSERT INTO document_versions (doc_id, user_id, title, content, chars_diff, version, source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
              [docId, userId, snapshotPayload.title, compressVersionContent(snapshotPayload.content), snapshotPayload.charsDiff, snapshotPayload.version, snapshotPayload.source, now]
            );
            // 写入新快照后按方案 C 清理过旧版本
            await pruneVersionHistory(docId, userId);
          }
        }
      } catch (e) {
        console.warn('版本快照写入跳过：', e && e.message);
      }
    })().catch(e => console.warn('保存后处理异常：', e && e.message));
  });
  res.json({ updated: updatedChanges, version: vRow ? vRow.version : undefined, updated_at: vRow ? vRow.updated_at : now });
}));

// 从 HTML 中提取所有 /api/assets/<id> 引用的 asset id
function extractAssetIds(html) {
  const ids = [];
  const re = /\/api\/assets\/([0-9a-fA-F-]{36})/gi;
  let m;
  while ((m = re.exec(String(html || '')))) ids.push(m[1].toLowerCase());
  return ids;
}

// 版本 content 压缩：gzip + base64，用 'GZ:' 前缀标记，兼容旧数据（无前缀视为未压缩原文）。
// HTML 文本压缩率通常 80-90%，大幅节省 document_versions 表空间。
function compressVersionContent(text) {
  const s = String(text || '');
  if (s.length < 200) return s; // 太小不压缩（gzip header 开销可能反而变大）
  try {
    const compressed = zlib.gzipSync(s, { level: 9 });
    const b64 = compressed.toString('base64');
    return b64.length < s.length ? 'GZ:' + b64 : s; // 只在压缩后更小才用
  } catch (e) {
    return s;
  }
}
function decompressVersionContent(stored) {
  const s = String(stored || '');
  if (!s.startsWith('GZ:')) return s; // 旧数据无前缀，直接返回原文
  try {
    return zlib.gunzipSync(Buffer.from(s.slice(3), 'base64')).toString('utf8');
  } catch (e) {
    return s; // 解压失败返回原始存储值，避免完全不可用
  }
}

// 版本保留策略（方案 C + 月级保留）：
//   - 最近 15 条滚动保留（密集改动可回退）
//   - 7 天内每天留 1 条最新（保证能回退到昨天/前天）
//   - 更早每月留 1 条最新（保证能回退到上个月/半年前）
//   - 硬上限 30 条，超出按时间倒序删最老的（约半年后开始挤掉最老的月级版本）
const VERSION_ROLLING_KEEP = 15;
const VERSION_DAILY_KEEP_DAYS = 7;
const VERSION_HARD_LIMIT = 30;
async function pruneVersionHistory(docId, userId) {
  try {
    // 先 COUNT 判断，大多数情况（≤15 条）直接 return，避免拉全量
    const countRow = await db.one(
      'SELECT COUNT(*) as n FROM document_versions WHERE doc_id = $1 AND user_id = $2',
      [docId, userId]
    );
    if (Number(countRow && countRow.n) <= VERSION_ROLLING_KEEP) return;

    const rows = await db.query(
      'SELECT id, created_at FROM document_versions WHERE doc_id = $1 AND user_id = $2 ORDER BY created_at DESC',
      [docId, userId]
    );
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const dailyCutoff = now - VERSION_DAILY_KEEP_DAYS * DAY;

    const keep = new Set();
    const keptDay = new Set();
    const keptMonth = new Set();
    rows.forEach((r, idx) => {
      const ts = Number(r.created_at);
      if (idx < VERSION_ROLLING_KEEP) { keep.add(r.id); return; } // 滚动窗口：最近 15 条
      if (ts >= dailyCutoff) {                                     // 7 天内：每天留 1 条
        const dayKey = Math.floor(ts / DAY);
        if (!keptDay.has(dayKey)) { keep.add(r.id); keptDay.add(dayKey); }
        return;
      }
      const d = new Date(ts);                                      // 更早：每月留 1 条
      const monthKey = d.getUTCFullYear() * 12 + d.getUTCMonth();
      if (!keptMonth.has(monthKey)) { keep.add(r.id); keptMonth.add(monthKey); }
    });

    // 硬上限：保留后仍超过 30 条，删最老的
    if (keep.size > VERSION_HARD_LIMIT) {
      const keptRows = rows.filter(r => keep.has(r.id));
      keptRows.slice(VERSION_HARD_LIMIT).forEach(r => keep.delete(r.id));
    }

    const toDelete = rows.filter(r => !keep.has(r.id)).map(r => r.id);
    if (!toDelete.length) return;
    for (let i = 0; i < toDelete.length; i += 500) {
      const batch = toDelete.slice(i, i + 500);
      const placeholders = batch.map((_, k) => '$' + (k + 3)).join(',');
      await db.execute('DELETE FROM document_versions WHERE doc_id = $1 AND user_id = $2 AND id IN (' + placeholders + ')', [docId, userId, ...batch]);
    }
    console.log('[versions] pruned', toDelete.length, 'old versions for doc', docId);
  } catch (e) {
    console.warn('[versions] prune skipped:', e && e.message);
  }
}

// 孤儿图片回收：扫描所有文档与版本内容，未被任何引用且超过30天宽限期的图片删除文件+记录。
// 软删除文档（可恢复）的图片视为被引用，不清理。
async function cleanupOrphanAssets() {
  try {
    const GRACE = 30 * 24 * 60 * 60 * 1000; // 30天宽限期
    const cutoff = Date.now() - GRACE;
    const assets = await db.query(
      'SELECT id, storage_name, thumb_storage_name, created_at FROM media_assets WHERE created_at < $1',
      [cutoff]
    );
    if (!assets.length) return;
    const referenced = new Set();
    // 游标分页扫描，避免一次性把全库文档/版本正文载入内存导致 OOM
    let lastDocId = 0;
    while (true) {
      const docs = await db.query('SELECT id, content FROM documents WHERE id > $1 ORDER BY id LIMIT 200', [lastDocId]);
      if (!docs.length) break;
      for (const d of docs) { lastDocId = d.id; extractAssetIds(d.content).forEach(id => referenced.add(id)); }
    }
    let lastVerId = 0;
    while (true) {
      const versions = await db.query('SELECT id, content FROM document_versions WHERE id > $1 ORDER BY id LIMIT 200', [lastVerId]);
      if (!versions.length) break;
      for (const v of versions) { lastVerId = v.id; extractAssetIds(decompressVersionContent(v.content)).forEach(id => referenced.add(id)); }
    }
    let deleted = 0;
    for (const a of assets) {
      if (referenced.has(a.id.toLowerCase())) continue;
      if (a.storage_name) await fs.promises.unlink(path.join(assetStore.root, a.storage_name)).catch(() => {});
      if (a.thumb_storage_name) await fs.promises.unlink(path.join(assetStore.root, a.thumb_storage_name)).catch(() => {});
      await db.execute('DELETE FROM media_assets WHERE id = $1', [a.id]);
      deleted++;
    }
    if (deleted) console.log('[assets] cleanup orphans:', deleted);
  } catch (e) {
    console.warn('[assets] orphan cleanup skipped:', e && e.message);
  }
}

/* 文档版本历史列表（轻量元数据：不返回 content，前端按需请求单条详情） */
app.get('/api/documents/:id/versions', wrap(async (req, res) => {
  const rows = await db.query(
    'SELECT id, title, chars_diff, version, source, created_at FROM document_versions WHERE doc_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 200',
    [req.params.id, req.user.id]
  );
  res.json(rows);
}));

/* 文档版本详情：返回完整内容用于 AI 分析或回看 */
app.get('/api/documents/:id/versions/:versionId', wrap(async (req, res) => {
  const row = await db.one(
    'SELECT id, title, content, chars_diff, version, source, created_at FROM document_versions WHERE doc_id = $1 AND user_id = $2 AND id = $3',
    [req.params.id, req.user.id, req.params.versionId]
  );
  if (!row) return res.status(404).json({ error: 'not found' });
  row.content = decompressVersionContent(row.content);
  res.json(row);
}));

/* 手动建立一个恢复点。它是显式动作，仅在用户打开版本历史后发生。 */
app.post('/api/documents/:id/versions', wrap(async (req, res) => {
  const now = Date.now();
  const doc = await db.one(
    'SELECT id, title, content, version FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [req.params.id, req.user.id]
  );
  if (!doc) return res.status(404).json({ error: 'not found' });
  const created = await db.execute(
    'INSERT INTO document_versions (doc_id, user_id, title, content, chars_diff, version, source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [doc.id, req.user.id, doc.title || '', compressVersionContent(doc.content || ''), 0, doc.version || 1, 'manual', now]
  );
  res.status(201).json({ id: created.insertId, source: 'manual', created_at: now, version: doc.version || 1 });
}));

async function getOwnedDocumentVersion(docId, userId, versionId) {
  const row = await db.one(
    'SELECT id, doc_id, title, content, chars_diff, version, source, created_at FROM document_versions WHERE doc_id = $1 AND user_id = $2 AND id = $3',
    [docId, userId, versionId]
  );
  if (row) row.content = decompressVersionContent(row.content);
  return row;
}

/* 将历史版本另存为副本：默认恢复路径，不改变用户当前文档。 */
app.post('/api/documents/:id/versions/:versionId/duplicate', wrap(async (req, res) => {
  const snapshot = await getOwnedDocumentVersion(req.params.id, req.user.id, req.params.versionId);
  if (!snapshot) return res.status(404).json({ error: 'not found' });
  const original = await db.one(
    'SELECT folder_id FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [req.params.id, req.user.id]
  );
  if (!original) return res.status(404).json({ error: 'not found' });
  const now = Date.now();
  const suffix = ' 恢复副本';
  const copyTitle = ((snapshot.title || '无标题').slice(0, Math.max(0, DOC_TITLE_MAX_LENGTH - suffix.length)) + suffix).slice(0, DOC_TITLE_MAX_LENGTH);
  const info = await db.execute(
    'INSERT INTO documents (title, title_origin, content, created_at, updated_at, user_id, folder_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [copyTitle, 'manual', snapshot.content || '', now, now, req.user.id, original.folder_id || null]
  );
  res.status(201).json({ id: info.insertId, title: copyTitle, folder_id: original.folder_id || null });
}));

/* 原地恢复始终先落一份恢复前备份，避免“恢复”本身再次造成不可逆丢失。 */
app.post('/api/documents/:id/versions/:versionId/restore', wrap(async (req, res) => {
  const now = Date.now();
  const result = await db.transaction(async (tx) => {
    const doc = await tx.one(
      'SELECT id, title, content, title_origin, version, updated_at FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [req.params.id, req.user.id]
    );
    if (!doc) throw new Error('NOT_FOUND');
    const snapshot = await tx.one(
      'SELECT id, title, content, version FROM document_versions WHERE doc_id = $1 AND user_id = $2 AND id = $3',
      [req.params.id, req.user.id, req.params.versionId]
    );
    if (!snapshot) throw new Error('VERSION_NOT_FOUND');
    snapshot.content = decompressVersionContent(snapshot.content); // 版本表存的是压缩格式，回退前解压
    const currentText = stripHtml(doc.content || '');
    const targetText = stripHtml(snapshot.content || '');
    await tx.execute(
      'INSERT INTO document_versions (doc_id, user_id, title, content, chars_diff, version, source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [doc.id, req.user.id, doc.title || '', compressVersionContent(doc.content || ''), Math.abs(currentText.length - targetText.length), doc.version || 1, 'restore_backup', now]
    );
    await tx.execute(
      'UPDATE documents SET title = $1, title_origin = $2, content = $3, updated_at = $4, version = version + 1 WHERE id = $5 AND user_id = $6',
      [snapshot.title || '无标题', isUntitledTitle(snapshot.title) ? 'untitled' : 'manual', snapshot.content || '', now, doc.id, req.user.id]
    );
    return tx.one('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [doc.id, req.user.id]);
  }).catch(err => {
    if (err.message === 'NOT_FOUND' || err.message === 'VERSION_NOT_FOUND') return null;
    throw err;
  });
  if (!result) return res.status(404).json({ error: 'not found' });
  res.json({ doc: result });
}));
/* 轻量级版本查询：B 端轮询用，避免每次拉取整个 content */
app.get('/api/documents/:id/version', wrap(async (req, res) => {
  const row = await db.one('SELECT version, updated_at, title FROM documents WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ version: row.version, updated_at: row.updated_at, title: row.title });
}));

app.post('/api/documents/:id/move', wrap(async (req, res) => {
  const raw = req.body.folder_id;
  let fid;
  if (raw === 0 || raw === null || raw === undefined || raw === '') {
    fid = null;
  } else {
    try {
      fid = await verifyFolderOwnership(raw, req.user.id);
    } catch (e) {
      if (e.code === 'FOLDER_NOT_FOUND') {
        return res.status(404).json({ error: '目标文件夹不存在或无权访问' });
      }
      return res.status(400).json({ error: e.message });
    }
  }
  const info = await db.execute('UPDATE documents SET folder_id = $1 WHERE id = $2 AND user_id = $3', [fid, req.params.id, req.user.id]);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ updated: info.changes });
}));

// 星标：收藏标记，不改变排序
app.post('/api/documents/:id/star', wrap(async (req, res) => {
  const starred = req.body.starred ? 1 : 0;
  const info = await db.execute('UPDATE documents SET starred = $1 WHERE id = $2 AND user_id = $3', [starred, req.params.id, req.user.id]);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ starred });
}));

// 置顶：列表排序优先（pinned DESC, updated_at DESC）
app.post('/api/documents/:id/pin', wrap(async (req, res) => {
  const pinned = req.body.pinned ? 1 : 0;
  const info = await db.execute('UPDATE documents SET pinned = $1 WHERE id = $2 AND user_id = $3', [pinned, req.params.id, req.user.id]);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ pinned });
}));

/* ---------- 文件夹 ---------- */
app.get('/api/folders', wrap(async (req, res) => {
  const rows = await db.query(
    'SELECT f.id, f.name, f.sort_order, f.created_at, ' +
    '(SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.user_id = f.user_id) AS doc_count ' +
    'FROM folders f WHERE f.user_id = $1 ORDER BY f.sort_order ASC, f.id ASC',
    [req.user.id]
  );
  res.json(rows);
}));

app.post('/api/folders', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '文件夹名不能为空' });
  if (name.length > 40) return res.status(400).json({ error: '文件夹名过长' });
  // sort_order 是 32 位 integer（PG）/ 64 位 INTEGER（SQLite），只能存小整数；
  // 早期误传 Date.now()（毫秒时间戳 ~1.78e12）会触发 PG numeric_value_out_of_range (22003)，
  // 桌面版 SQLite 因 INTEGER 是 64 位而不报错，导致此 bug 仅在线上暴露。
  const info = await db.execute(
    'INSERT INTO folders (name, user_id, sort_order, created_at) VALUES ($1, $2, $3, $4)',
    [name, req.user.id, 0, Date.now()]
  );
  res.json({ id: info.insertId });
}));

app.put('/api/folders/sort', wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  try {
    await db.transaction(async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        const num = Number(ids[i]);
        if (!Number.isInteger(num)) throw new Error('invalid id: ' + ids[i]);
        await tx.execute('UPDATE folders SET sort_order = $1 WHERE id = $2 AND user_id = $3', [i, num, req.user.id]);
      }
    });
    res.json({ updated: ids.length });
  } catch (e) {
    res.status(400).json({ error: '排序更新失败: ' + e.message });
  }
}));

app.put('/api/folders/:id', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '文件夹名不能为空' });
  const info = await db.execute('UPDATE folders SET name = $1 WHERE id = $2 AND user_id = $3', [name, req.params.id, req.user.id]);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ updated: info.changes });
}));

app.delete('/api/folders/:id', wrap(async (req, res) => {
  await db.execute('UPDATE documents SET folder_id = NULL WHERE folder_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  const info = await db.execute('DELETE FROM folders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: true });
}));

app.delete('/api/documents/:id', wrap(async (req, res) => {
  const doc = await db.one('SELECT id FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [req.params.id, req.user.id]);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  await db.execute('UPDATE documents SET deleted_at = $1 WHERE id = $2 AND user_id = $3', [Date.now(), req.params.id, req.user.id]);
  res.json({ ok: true });
}));

/* ---------- 搜索 ---------- */
function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}
function makeSnippet(text, q, len = 120) {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, len);
  const start = Math.max(0, idx - 40);
  return (start > 0 ? '…' : '') + text.slice(start, start + len) + (start + len < text.length ? '…' : '');
}

/* ---------- AI helpers ---------- */
function normalizeVisibleText(text) {
  return String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, '').trim();
}
function protectAiAssets(html) {
  const assets = [];
  const protectedHtml = String(html || '').replace(/<img\b[^>]*>/gi, (tag) => {
    const index = assets.push(tag) - 1;
    return '<img data-penmark-ai-asset="' + index + '">';
  });
  return { html: protectedHtml, assets };
}
function restoreAiAssets(html, assets) {
  return String(html || '').replace(/<img\b[^>]*data-penmark-ai-asset=["']?(\d+)["']?[^>]*>/gi, (match, raw) => {
    const index = Number(raw);
    return assets[index] || match;
  });
}
/* 分享内容净化：剥离脚本/事件/危险协议，但保留 <style>（公众号依赖内联样式）。
   与 sanitizeAiHtmlFragment 的区别：不删 <style> 标签，因为分享页内容来自编辑器，
   内联 <style> 已在前端 _sanitizeStyleSheet 清洗过，这里只防可执行脚本。 */
function sanitizeShareContent(html) {
  if (!html) return '';
  let out = String(html);
  // 1. 移除危险标签整体（含内容）：script/iframe/object/embed/applet/frame/frameset/noscript/template/math/svg/link/meta/base/form/button/input/textarea/select
  //    注意：保留 <style>（公众号内联样式已在前端清洗）
  out = out.replace(/<(script|iframe|object|embed|applet|frame|frameset|noscript|template|math|svg|link|meta|base|form|button|input|textarea|select)\b[\s\S]*?<\/\1\s*>/gi, '');
  // 自闭合危险标签
  out = out.replace(/<(iframe|object|embed|link|meta|base|svg|math|image)\b[^>]*\/?>/gi, '');
  // script 残留（无闭合标签）
  out = out.replace(/<script\b[^>]*>/gi, '');
  // 2. 移除所有事件处理器（on*）
  out = out.replace(/([\s/"'`=])on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
  // 3. 分享页仍需兼容尚未后台迁移的 Base64 图片。先把严格白名单内的
  //    raster data URL 暂存起来，再清除其余 data:/javascript:/vbscript:。
  //    SVG 不在白名单中，避免 data:image/svg+xml 携带可执行内容。
  const safeDataImages = [];
  const safeDataMarker = '__PENMARK_SAFE_DATA_IMAGE_' + crypto.randomBytes(12).toString('hex') + '_';
  out = out.replace(/<img\b[^>]*>/gi, (tag) => tag.replace(
    /\bsrc\s*=\s*(["'])(data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+)\1/i,
    (match, quote, source) => {
      const index = safeDataImages.push(source) - 1;
      return 'src=' + quote + safeDataMarker + index + '__' + quote;
    }
  ));
  // 移除 javascript:/vbscript:/data: 协议（href/src/xlink:href）
  out = out.replace(/\s(?:href|src|xlink:href)\s*=\s*(?:"\s*(?:javascript|vbscript|data):[^"]*"|'\s*(?:javascript|vbscript|data):[^']*'|\s*(?:javascript|vbscript|data):[^\s>]+)/gi, '');
  if (safeDataImages.length) {
    const escapedMarker = safeDataMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escapedMarker + '(\\d+)__', 'g'), (match, rawIndex) => {
      const source = safeDataImages[Number(rawIndex)];
      return source || '';
    });
  }
  // 4. 移除 CSS expression() 与 -moz-binding（style 属性级）
  out = out.replace(/style\s*=\s*"[^"]*expression\s*\([^"]*"/gi, '');
  out = out.replace(/style\s*=\s*'[^']*expression\s*\([^']*'/gi, '');
  out = out.replace(/style\s*=\s*"[^"]*-moz-binding[^"]*"/gi, '');
  out = out.replace(/style\s*=\s*'[^']*-moz-binding[^']*'/gi, '');
  // 5. 移除 formaction 等绕过属性
  out = out.replace(/\sform(?:action|method|target|enctype)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 6. 移除 srcset 中的危险协议
  out = out.replace(/srcset\s*=\s*"(?:[^"]*javascript:[^"]*)"/gi, '');
  out = out.replace(/srcset\s*=\s*'(?:[^']*javascript:[^']*)'/gi, '');
  // 7. 移除 HTML 注释中隐藏的脚本
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  return out;
}
function sanitizeAiHtmlFragment(html) {
  // 1. 移除危险标签整体（含内容）
  let out = String(html || '')
    // script / style / iframe / object / embed / applet / frame / frameset / noscript
    .replace(/<(script|style|iframe|object|embed|applet|frame|frameset|noscript|template|math|svg|link|meta|base|form|button|input|textarea|select)\b[\s\S]*?<\/\1\s*>/gi, '')
    // 自闭合危险标签：iframe/object/embed/link/meta/base/svg/math
    .replace(/<(iframe|object|embed|link|meta|base|svg|math|image)\b[^>]*\/?>/gi, '')
    // script 残留（无闭合标签）
    .replace(/<script\b[^>]*>/gi, '');
  // 2. 移除所有事件处理器（on*）
  out = out.replace(/([\s/"'`=])on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
  // 3. 移除 javascript: / vbscript: / data: 协议（href/src/xlink:href）
  out = out.replace(/\s(?:href|src|xlink:href)\s*=\s*(?:"\s*(?:javascript|vbscript|data):[^"]*"|'\s*(?:javascript|vbscript|data):[^']*'|\s*(?:javascript|vbscript|data):[^\s>]+)/gi, '');
  // 4. 移除 CSS 表达式与危险属性
  out = out.replace(/style\s*=\s*"[^"]*expression\s*\([^"]*"/gi, '');
  out = out.replace(/style\s*=\s*'[^']*expression\s*\([^']*'/gi, '');
  // 5. 移除 formaction、formmethod 等绕过属性
  out = out.replace(/\sform(?:action|method|target|enctype)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 6. 移除 srcset 中的危险协议
  out = out.replace(/srcset\s*=\s*"(?:[^"]*javascript:[^"]*)"/gi, '');
  out = out.replace(/srcset\s*=\s*'(?:[^']*javascript:[^']*)'/gi, '');
  // 7. 防止注释中隐藏的脚本绕过
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  return out;
}

app.get('/api/ai/status', (req, res) => {
  res.json({ configured: ai.configured(), model: process.env.AI_MODEL || 'deepseek-chat' });
});

registerAutoTitleRoutes({
  app, db, auth, ai, aiLimiter, autoTitle, stripHtml,
  titleMaxLength: DOC_TITLE_MAX_LENGTH
});


/* ---------- AI 自定义预设（按用户绑定） ---------- */
app.get('/api/ai/presets', wrap(async (req, res) => {
  const rows = await db.query(
    'SELECT id, label, prompt, sort_order, created_at FROM ai_presets WHERE user_id = $1 ORDER BY sort_order ASC, created_at ASC',
    [req.user.id]
  );
  res.json(rows);
}));

app.post('/api/ai/presets', wrap(async (req, res) => {
  const label = String(req.body && req.body.label || '').trim().slice(0, 30);
  const prompt = String(req.body && req.body.prompt || '').trim().slice(0, 3000);
  if (!label) return res.status(400).json({ error: '预设名称不能为空' });
  const cnt = await db.query('SELECT COUNT(*) AS n FROM ai_presets WHERE user_id = $1', [req.user.id]);
  if (Number(cnt[0].n) >= 20) return res.status(400).json({ error: '最多 20 个自定义预设' });
  const maxRow = await db.one('SELECT MAX(sort_order) AS m FROM ai_presets WHERE user_id = $1', [req.user.id]);
  const sortOrder = (maxRow && maxRow.m != null ? Number(maxRow.m) : -1) + 1;
  const info = await db.execute(
    'INSERT INTO ai_presets (user_id, label, prompt, sort_order, created_at) VALUES ($1, $2, $3, $4, $5)',
    [req.user.id, label, prompt, sortOrder, Date.now()]
  );
  res.json({ id: info.insertId, label, prompt, sort_order: sortOrder });
}));

app.put('/api/ai/presets/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效 ID' });
  const label = String(req.body && req.body.label || '').trim().slice(0, 30);
  const prompt = String(req.body && req.body.prompt || '').trim().slice(0, 3000);
  if (!label) return res.status(400).json({ error: '预设名称不能为空' });
  const info = await db.execute(
    'UPDATE ai_presets SET label = $1, prompt = $2 WHERE id = $3 AND user_id = $4',
    [label, prompt, id, req.user.id]
  );
  if (info.changes === 0) return res.status(404).json({ error: '未找到该预设' });
  res.json({ ok: true });
}));

app.delete('/api/ai/presets/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效 ID' });
  const info = await db.execute(
    'DELETE FROM ai_presets WHERE id = $1 AND user_id = $2',
    [id, req.user.id]
  );
  if (info.changes === 0) return res.status(404).json({ error: '未找到该预设' });
  res.json({ ok: true });
}));

app.post('/api/ai/layout', aiLimiter, wrap(async (req, res) => {
  // 客户端断开（用户点停止/切走文档）时取消 AI 请求，避免空跑占用配额
  const abortController = new AbortController();
  const onClientClose = () => abortController.abort();
  req.on('close', onClientClose);
  try {
    const rawHtml = String(req.body && req.body.html || '');
    const preset = String(req.body && req.body.preset || 'share');
    const customPrompt = String(req.body && req.body.customPrompt || '').slice(0, 3000);
    const docId = req.body && req.body.docId ? Number(req.body.docId) : null;
    if (!rawHtml.trim()) return res.status(400).json({ error: 'empty html' });
    // 校验 docId 归属：避免攻击者把他人 doc_id 写入 editor_actions 表（外键通过、孤儿记录污染 DB）
    // 与 /api/ai/chat 路由对齐（chat 在 line 1064-1067 已做此校验）
    if (docId) {
      if (!Number.isInteger(docId) || docId <= 0) return res.status(400).json({ error: '无效的文档ID' });
      const owned = await db.one('SELECT id FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [docId, req.user.id]);
      if (!owned) return res.status(404).json({ error: 'document not found' });
    }
    const protectedInput = protectAiAssets(rawHtml);
    if (protectedInput.html.length > Number(process.env.AI_LAYOUT_MAX_INPUT || 120000)) {
      return res.status(413).json({ error: 'document is too large for one AI layout request' });
    }
    const aiHtml = await ai.layoutHtml(protectedInput.html, preset, customPrompt, { signal: abortController.signal });
    const restoredHtml = sanitizeAiHtmlFragment(restoreAiAssets(aiHtml, protectedInput.assets));
    const beforeText = normalizeVisibleText(stripHtml(rawHtml));
    const afterText = normalizeVisibleText(stripHtml(restoredHtml));
    // 异步写一条排版动作日志
    if (docId) {
      setImmediate(() => {
        (async () => {
          try {
            await db.execute(
              'INSERT INTO editor_actions (doc_id, user_id, action_type, before_text, after_text, instruction, meta, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
              [docId, req.user.id, 'layout',
                beforeText.slice(0, 2000),
                afterText.slice(0, 2000),
                preset,
                JSON.stringify({ source: 'ai-layout' }),
                Date.now()]
            );
          } catch (e) {
            console.warn('排版动作日志写入跳过：', e && e.message);
          }
        })().catch(e => console.warn('排版动作日志异常：', e && e.message));
      });
    }
    res.json({ html: restoredHtml, textUnchanged: beforeText === afterText, beforeChars: beforeText.length, afterChars: afterText.length });
  } catch (err) {
    // 客户端取消：返回 499（非标准但常见用于"客户端已断开"），不写入错误日志
    if (err && (err.name === 'AbortError' || err.message === 'AbortError')) {
      return res.status(499).json({ error: '已取消' });
    }
    res.status(500).json({ error: err.message || String(err) });
  } finally {
    req.removeListener('close', onClientClose);
  }
}));

app.post('/api/ai/rewrite-selection', aiLimiter, wrap(async (req, res) => {
  // 客户端断开时取消 AI 请求，避免空跑（用户点了停止/切走文档）
  const abortController = new AbortController();
  const onClientClose = () => abortController.abort();
  req.on('close', onClientClose);
  try {
    const selectedText = String(req.body && req.body.selectedText || '').slice(0, Number(process.env.AI_SELECTION_MAX_CHARS || 10000));
    const instruction = String(req.body && req.body.instruction || '').slice(0, 500);
    const contextText = String(req.body && req.body.contextText || '').slice(0, Number(process.env.AI_CONTEXT_MAX_CHARS || 24000));
    const docId = req.body && req.body.docId ? Number(req.body.docId) : null;
    if (!selectedText.trim()) return res.status(400).json({ error: 'empty selection' });
    // 校验 docId 归属（与 /api/ai/layout 和 /api/ai/chat 对齐）
    if (docId) {
      if (!Number.isInteger(docId) || docId <= 0) return res.status(400).json({ error: '无效的文档ID' });
      const owned = await db.one('SELECT id FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [docId, req.user.id]);
      if (!owned) return res.status(404).json({ error: 'document not found' });
    }
    const replacement = await ai.rewriteSelection(selectedText, instruction, contextText, { signal: abortController.signal });
    // 同步写一条编辑动作日志（供 AI 对话感知"刚才做了什么"），出错时打日志便于诊断
    if (docId) {
      try {
        await db.execute(
          'INSERT INTO editor_actions (doc_id, user_id, action_type, before_text, after_text, instruction, meta, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [docId, req.user.id, 'rewrite',
            selectedText.slice(0, 2000),
            String(replacement || '').slice(0, 2000),
            instruction,
            JSON.stringify({ source: 'float-menu' }),
            Date.now()]
        );
        console.log('[editor_actions] rewrite 写入成功 docId=' + docId + ' user=' + req.user.id + ' before=' + selectedText.length + '字 after=' + String(replacement || '').length + '字');
      } catch (e) {
        console.warn('[editor_actions] rewrite 写入失败：', e && e.message);
      }
    } else {
      console.log('[editor_actions] 跳过写入：req.body.docId 为空，前端可能没传 docId');
    }
    res.json({ replacement });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.message === 'AbortError')) {
      return res.status(499).json({ error: '已取消' });
    }
    res.status(500).json({ error: err.message || String(err) });
  } finally {
    req.removeListener('close', onClientClose);
  }
}));

/* 文档动作日志列表（最近 N 条） */
app.get('/api/documents/:id/actions', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const rows = await db.query(
    'SELECT id, action_type, before_text, after_text, instruction, created_at FROM editor_actions WHERE doc_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3',
    [req.params.id, req.user.id, limit]
  );
  res.json(rows);
}));

/* AI 多轮对话（带文档上下文；用户消息含关键词时分别注入版本演变摘要 / 最近编辑动作） */
const VERSION_KEYWORDS = ['版本', '改动', '修改', '风格', '习惯', '总结', '变化', '演变', '历史'];
const ACTION_KEYWORDS = ['刚才', '做了', '改写', '改了', '动作', '操作', '刚刚', '上次', '上次改'];
const AI_CHAT_MAX_TURNS = Number(process.env.AI_CHAT_MAX_TURNS || 20);

app.post('/api/ai/chat', aiLimiter, wrap(async (req, res) => {
  // 多轮对话耗时较长，客户端断开时取消 AI 请求
  const abortController = new AbortController();
  const onClientClose = () => abortController.abort();
  req.on('close', onClientClose);
  try {
    const docId = req.body && req.body.docId;
    const userMessage = String((req.body && req.body.message) || '').slice(0, 8000);
    const history = Array.isArray(req.body && req.body.history) ? req.body.history.slice(-AI_CHAT_MAX_TURNS) : [];
    if (!userMessage.trim()) return res.status(400).json({ error: 'empty message' });

    // 校验文档归属（避免越权把别人文档塞进上下文）
    let doc = null;
    if (docId) {
      doc = await db.one('SELECT id, title, content FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [docId, req.user.id]);
      if (!doc) return res.status(404).json({ error: 'document not found' });
    }

    // 构造系统提示：当前文档标题 + 全文（仅纯文本）
    const docText = doc ? stripHtml(doc.content || '').slice(0, Number(process.env.AI_CONTEXT_MAX_CHARS || 24000)) : '';
    const systemParts = [
      'You are 知著 PenMark 的 AI 写作助手，专注于中文图文内容创作。',
      '回答简洁、可执行；如果用户问的是写作建议，请直接给出可复制到编辑器的文字片段。',
      '如果用户问的不是关于当前文档，礼貌地引导回写作话题。',
      ai.PENMARK_KNOWLEDGE
    ];
    if (doc) {
      systemParts.push('当前文档标题：' + (doc.title || '无标题'));
      systemParts.push('当前文档正文（参考用，不要在回答里大段重复）：\n' + docText);
    }

    // 关键词触发：把版本演变摘要附在上下文里
    const shouldInjectVersions = VERSION_KEYWORDS.some(k => userMessage.includes(k)) && doc;
    if (shouldInjectVersions) {
      try {
        const versions = await db.query(
          'SELECT id, title, chars_diff, version, created_at FROM document_versions WHERE doc_id = $1 AND user_id = $2 ORDER BY created_at ASC LIMIT 100',
          [docId, req.user.id]
        );
        if (versions.length > 0) {
          const summary = versions.map((v, i) => {
            const time = new Date(v.created_at).toLocaleString('zh-CN', { hour12: false });
            return `第${i + 1}次（v${v.version}, ${time}, 差异${v.chars_diff}字）「${(v.title || '').slice(0, 30)}」`;
          }).join('\n');
          systemParts.push('以下是该文档的历史版本演变记录（用户可能想分析写作风格、改动习惯）：\n' + summary);
        }
      } catch (e) {
        console.warn('版本摘要注入跳过：', e && e.message);
      }
    }

    // 关键词触发：把最近编辑动作日志注入上下文（"刚才做了什么"）
    const shouldInjectActions = ACTION_KEYWORDS.some(k => userMessage.includes(k)) && doc;
    if (shouldInjectActions) {
      try {
        const actions = await db.query(
          'SELECT action_type, before_text, after_text, instruction, created_at FROM editor_actions WHERE doc_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 10',
          [docId, req.user.id]
        );
        console.log('[ai/chat] 命中动作关键词，docId=' + docId + ' 找到 ' + actions.length + ' 条动作记录');
        if (actions.length > 0) {
          const ACTION_LABELS = { rewrite: 'AI 改写', layout: 'AI 排版', insert_image: '插入图片' };
          const list = actions.map(a => {
            const time = new Date(a.created_at).toLocaleString('zh-CN', { hour12: false });
            const label = ACTION_LABELS[a.action_type] || a.action_type;
            const before = (a.before_text || '').slice(0, 80).replace(/\s+/g, ' ');
            const after = (a.after_text || '').slice(0, 80).replace(/\s+/g, ' ');
            const instr = a.instruction ? `（指令：${a.instruction.slice(0, 40)}）` : '';
            return `[${time}] ${label}${instr}\n  原：${before}…\n  新：${after}…`;
          }).join('\n\n');
          systemParts.push('以下是用户最近对该文档做过的 AI 辅助动作（按时间倒序，最近的在前）：\n' + list);
        }
      } catch (e) {
        console.warn('[ai/chat] 动作日志注入跳过：', e && e.message);
      }
    }

    // 拼接消息序列：system + 历史 + 当前用户消息
    const messages = [{ role: 'system', content: systemParts.join('\n\n') }];
    for (const h of history) {
      const role = h.role === 'assistant' ? 'assistant' : 'user';
      const content = String(h.content || '').slice(0, 8000);
      if (content) messages.push({ role, content });
    }
    messages.push({ role: 'user', content: userMessage });

    const reply = await ai.chat(messages, {
      temperature: 0.5,
      maxTokens: Number(process.env.AI_CHAT_MAX_TOKENS || 2048),
      timeoutMs: 70000,
      signal: abortController.signal
    });

    // 持久化对话（按文档保留：关闭面板/刷新后再打开仍能看到）
    if (doc) {
      try {
        await db.execute(
          'INSERT INTO ai_chat_history (doc_id, user_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)',
          [docId, req.user.id, 'user', userMessage, Date.now()]
        );
        await db.execute(
          'INSERT INTO ai_chat_history (doc_id, user_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)',
          [docId, req.user.id, 'assistant', reply, Date.now() + 1]
        );
      } catch (e) {
        console.warn('AI 对话历史持久化跳过：', e && e.message);
      }
    }

    res.json({ reply, docTitle: doc ? doc.title : null, versionsInjected: shouldInjectVersions, actionsInjected: shouldInjectActions });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.message === 'AbortError')) {
      return res.status(499).json({ error: '已取消' });
    }
    res.status(500).json({ error: err.message || String(err) });
  } finally {
    req.removeListener('close', onClientClose);
  }
}));

/* 拉取文档的对话历史（按文档保留） */
app.get('/api/documents/:id/chat-history', wrap(async (req, res) => {
  const rows = await db.query(
    'SELECT id, role, content, created_at FROM ai_chat_history WHERE doc_id = $1 AND user_id = $2 ORDER BY created_at ASC LIMIT 200',
    [req.params.id, req.user.id]
  );
  res.json(rows.map(r => ({ id: r.id, role: r.role, content: r.content, created_at: r.created_at })));
}));

/* 清空文档的对话历史 */
app.delete('/api/documents/:id/chat-history', wrap(async (req, res) => {
  await db.execute('DELETE FROM ai_chat_history WHERE doc_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

app.get('/api/search', wrap(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  // 转义 LIKE 通配符（%/_/\），否则搜 "100%" 会变成 "100+任意字符"，
  // 搜 "user_1" 匹配 "userA1" 等，结果与用户预期不符
  const escaped = q.replace(/[%_\\]/g, c => '\\' + c);
  const pattern = '%' + escaped + '%';
  // LIMIT 50：避免文档量大的用户搜常见词时一次拉上千条全文（content）撑爆内存/带宽。
  // LIKE '%q%' 前导通配符无法走索引，只能扫该用户全部文档；无 LIMIT 时是 P0 性能问题。
  // 长远应上线 SQLite FTS5 虚拟表用 MATCH 替代 LIKE，但当前先加 LIMIT 兜底。
  const rows = await db.query(
    "SELECT id, title, content, updated_at FROM documents WHERE user_id = $1 AND deleted_at IS NULL AND (LOWER(title) LIKE LOWER($2) ESCAPE '\\' OR LOWER(content) LIKE LOWER($3) ESCAPE '\\') ORDER BY updated_at DESC LIMIT 50",
    [req.user.id, pattern, pattern]
  );
  res.json(rows.map(r => ({
    id: r.id, title: r.title, snippet: makeSnippet(stripHtml(r.content), q), updated_at: r.updated_at
  })));
}));

/* ---------- 管理员：用户管理 ---------- */
app.get('/api/admin/users', auth.adminOnly, wrap(async (req, res) => {
  const users = await db.query("SELECT id, username, nickname, is_admin, is_banned, can_share, admin_note, created_at FROM users ORDER BY created_at DESC");
  res.json(users);
}));

app.put('/api/admin/users/:id', auth.adminOnly, wrap(async (req, res) => {
  const { is_banned, can_share, admin_note } = req.body;
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: '无效的用户ID' });
  }
  // 禁止管理员封禁自己或修改自己的分享权限（防止误操作锁死自己）
  if (is_banned !== undefined && is_banned && targetId === req.user.id) {
    return res.status(400).json({ error: '不能封禁自己' });
  }
  if (can_share !== undefined && !can_share && targetId === req.user.id) {
    return res.status(400).json({ error: '不能撤销自己的分享权限' });
  }
  const updates = [];
  const values = [];
  let idx = 1;
  if (is_banned !== undefined) { updates.push(`is_banned = $${idx++}`); values.push(is_banned ? 1 : 0); }
  if (can_share !== undefined) { updates.push(`can_share = $${idx++}`); values.push(can_share ? 1 : 0); }
  if (admin_note !== undefined) {
    updates.push(`admin_note = $${idx++}`);
    values.push(String(admin_note).slice(0, 500));
  }
  if (updates.length === 0) return res.json({ ok: true });
  values.push(targetId);
  const info = await db.execute(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, values);
  if (info.changes === 0) return res.status(404).json({ error: '用户不存在' });
  // 封禁用户时撤销所有会话
  if (is_banned) await auth.revokeAllUserSessions(targetId);
  res.json({ ok: true });
}));

/* ---------- 回收站 ---------- */
app.get('/api/trash', wrap(async (req, res) => {
  const docs = await db.query("SELECT id, title, deleted_at, updated_at FROM documents WHERE user_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC", [req.user.id]);
  res.json(docs);
}));

app.post('/api/trash/:id/restore', wrap(async (req, res) => {
  const info = await db.execute("UPDATE documents SET deleted_at = NULL WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  if (info.changes === 0) return res.status(404).json({ error: '文档不存在' });
  res.json({ ok: true });
}));

app.delete('/api/trash/:id', wrap(async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: '无效的文档ID' });
  }
  try {
    await db.transaction(async (tx) => {
      // 先收集要清理的 share token，再删除访客记录、分享、举报，最后删除文档
      // SQLite 启用 foreign_keys 后必须按外键依赖顺序删除
      const shares = await tx.query('SELECT token FROM shares WHERE doc_id = $1', [targetId]);
      for (const s of shares) {
        await tx.execute('DELETE FROM share_visitors WHERE share_token = $1', [s.token]);
      }
      await tx.execute('DELETE FROM shares WHERE doc_id = $1', [targetId]);
      await tx.execute('DELETE FROM reports WHERE doc_id = $1', [targetId]);
      // 关键修复：document_versions / ai_chat_history / editor_actions 都有指向 documents(id) 的外键，
      // 且未声明 ON DELETE CASCADE；不先清理这些表，DELETE FROM documents 会因外键约束失败
      await tx.execute('DELETE FROM document_versions WHERE doc_id = $1', [targetId]);
      await tx.execute('DELETE FROM ai_chat_history WHERE doc_id = $1', [targetId]);
      await tx.execute('DELETE FROM editor_actions WHERE doc_id = $1', [targetId]);
      const info = await tx.execute('DELETE FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL', [targetId, req.user.id]);
      if (info.changes === 0) throw new Error('NOT_FOUND');
    });
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: '文档不存在' });
    return res.status(500).json({ error: '删除失败：' + (e.message || e) });
  }
  res.json({ ok: true });
}));

/* ---------- 批量导入：批次记录与撤销 ---------- */
// 撤销窗口：7 天。超过后批次记录仍在，但失去一键撤销入口（文档本身不动）。
const IMPORT_UNDO_WINDOW = 7 * 24 * 60 * 60 * 1000;

// 记录一次导入批次（导入成功后由前端调用，doc_ids/folder_ids 存 JSON 文本）
app.post('/api/import/batch', wrap(async (req, res) => {
  const docIds = Array.isArray(req.body.doc_ids)
    ? req.body.doc_ids.map(x => Number(x)).filter(x => Number.isInteger(x))
    : [];
  const folderIds = Array.isArray(req.body.folder_ids)
    ? req.body.folder_ids.map(x => Number(x)).filter(x => Number.isInteger(x))
    : [];
  if (docIds.length === 0 && folderIds.length === 0) {
    return res.status(400).json({ error: '批次为空' });
  }
  const now = Date.now();
  const info = await db.execute(
    'INSERT INTO import_batches (user_id, doc_ids, folder_ids, doc_count, folder_count, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [req.user.id, JSON.stringify(docIds), JSON.stringify(folderIds), docIds.length, folderIds.length, now]
  );
  res.json({ id: info.insertId, doc_count: docIds.length, folder_count: folderIds.length, created_at: now });
}));

// 查询当前用户最近一条 7 天内、未撤销的批次（前端据此显示"撤销"按钮）
app.get('/api/import/last-batch', wrap(async (req, res) => {
  const cutoff = Date.now() - IMPORT_UNDO_WINDOW;
  const row = await db.one(
    'SELECT id, doc_count, folder_count, created_at FROM import_batches WHERE user_id = $1 AND undone_at IS NULL AND created_at >= $2 ORDER BY created_at DESC LIMIT 1',
    [req.user.id, cutoff]
  );
  res.json(row || null);
}));

// 撤销上一次导入：文档带当前最新内容移入回收站（可恢复），删除本次导入且当前为空的文件夹
app.post('/api/import/undo', wrap(async (req, res) => {
  const cutoff = Date.now() - IMPORT_UNDO_WINDOW;
  const row = await db.one(
    'SELECT id, doc_ids, folder_ids, created_at FROM import_batches WHERE user_id = $1 AND undone_at IS NULL AND created_at >= $2 ORDER BY created_at DESC LIMIT 1',
    [req.user.id, cutoff]
  );
  if (!row) return res.status(404).json({ error: '没有可撤销的导入（超过 7 天或已撤销）' });

  let docIds = [];
  let folderIds = [];
  try { docIds = JSON.parse(row.doc_ids || '[]'); } catch (_) {}
  try { folderIds = JSON.parse(row.folder_ids || '[]'); } catch (_) {}

  const now = Date.now();
  let docsMoved = 0;
  let foldersDeleted = 0;

  await db.transaction(async (tx) => {
    // 1) 文档移入回收站：只置 deleted_at，不改 content，用户从回收站恢复可拿回编辑后版本
    for (const did of docIds) {
      if (!Number.isInteger(Number(did))) continue;
      const info = await tx.execute(
        'UPDATE documents SET deleted_at = $1 WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL',
        [now, Number(did), req.user.id]
      );
      if (info.changes > 0) docsMoved++;
    }
    // 2) 删除本次导入创建、且当前没有未删除文档的文件夹（有用户后续新建文档则保留）
    for (const fid of folderIds) {
      if (!Number.isInteger(Number(fid))) continue;
      const cnt = await tx.one(
        'SELECT COUNT(*) AS c FROM documents WHERE folder_id = $1 AND user_id = $2 AND deleted_at IS NULL',
        [Number(fid), req.user.id]
      );
      if (Number(cnt.c) === 0) {
        const info = await tx.execute('DELETE FROM folders WHERE id = $1 AND user_id = $2', [Number(fid), req.user.id]);
        if (info.changes > 0) foldersDeleted++;
      }
    }
    // 3) 标记批次已撤销，避免重复撤销
    await tx.execute('UPDATE import_batches SET undone_at = $1 WHERE id = $2 AND user_id = $3', [now, row.id, req.user.id]);
  });

  res.json({ docs_moved: docsMoved, folders_deleted: foldersDeleted, created_at: row.created_at });
}));

/* ---------- 导出 Markdown（全量 / 单文件夹）---------- */
// 文件名安全化：去掉非法字符，限长 60
function safeExportName(name, fallback) {
  let s = String(name || '').trim().replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ');
  if (!s) s = fallback;
  return s.slice(0, 60);
}
function extFromMime(mime) {
  const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' };
  return map[String(mime || '').toLowerCase()] || 'png';
}

// 核心导出逻辑：把指定文档集合打包成 zip 流（A/B/C 三层，每文件夹 images/ 子目录）
async function exportToZip(res, userId, docs, folderNameMap, zipName) {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="' + encodeURIComponent(zipName) + '"'
  });
  archive.on('error', err => {
    if (!res.headersSent) res.status(500).json({ error: '导出失败：' + (err.message || err) });
  });
  archive.pipe(res);

  // 收集所有 asset ids，批量查询（分批 100，避免 IN 列表过长）
  const allAssetIds = new Set();
  docs.forEach(d => extractAssetIds(d.content).forEach(id => allAssetIds.add(id.toLowerCase())));
  const assetMap = new Map(); // id -> { storage_name, mime_type }
  if (allAssetIds.size > 0) {
    const ids = [...allAssetIds];
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const placeholders = batch.map((_, j) => '$' + (j + 1)).join(',');
      const rows = await db.query(
        'SELECT id, storage_name, mime_type FROM media_assets WHERE id IN (' + placeholders + ') AND owner_id = $' + (batch.length + 1),
        [...batch, userId]
      );
      rows.forEach(r => assetMap.set(r.id, r));
    }
  }

  const usedNames = new Map(); // folderName -> Set，文件名去重
  const packedImages = new Set(); // 已打包图片路径，避免重复

  for (const doc of docs) {
    const folderName = doc.folder_id && folderNameMap.has(doc.folder_id)
      ? safeExportName(folderNameMap.get(doc.folder_id), '文件夹')
      : '未分类';

    // 替换图片 src 为 images/xxx.png 相对路径，并记录该文档引用的 asset
    const docAssetIds = new Set();
    let content = String(doc.content || '').replace(/\/api\/assets\/([0-9a-fA-F-]{36})/gi, (m, id) => {
      id = id.toLowerCase();
      const asset = assetMap.get(id);
      if (!asset) return m; // 找不到资源，保留原 URL（MD 里会是死链，但不阻断导出）
      docAssetIds.add(id);
      return 'images/' + id.slice(0, 8) + '.' + extFromMime(asset.mime_type);
    });

    // 打包图片到该文件夹的 images/ 子目录
    for (const id of docAssetIds) {
      const asset = assetMap.get(id);
      const imgPath = folderName + '/images/' + id.slice(0, 8) + '.' + extFromMime(asset.mime_type);
      if (packedImages.has(imgPath)) continue;
      packedImages.add(imgPath);
      try {
        const filePath = await assetStore.filePath(asset);
        if (filePath) archive.file(filePath, { name: imgPath });
      } catch (_) { /* 图片文件丢失不阻断整体导出 */ }
    }

    // 文档转 MD 并打包
    const md = htmlToMarkdown(content);
    const baseName = safeExportName(doc.title, '无标题');
    const used = usedNames.get(folderName) || new Set();
    let name = baseName, n = 2;
    while (used.has(name + '.md')) { name = baseName + ' (' + n + ')'; n++; }
    used.add(name + '.md');
    usedNames.set(folderName, used);
    archive.append(md, { name: folderName + '/' + name + '.md' });
  }

  archive.finalize();
}

// 全量导出
app.get('/api/export/all', wrap(async (req, res) => {
  const docs = await db.query(
    'SELECT id, title, content, folder_id FROM documents WHERE user_id = $1 AND deleted_at IS NULL ORDER BY folder_id NULLS LAST, updated_at DESC',
    [req.user.id]
  );
  if (!docs.length) return res.status(400).json({ error: '没有可导出的文档' });
  const folders = await db.query('SELECT id, name FROM folders WHERE user_id = $1', [req.user.id]);
  const folderNameMap = new Map();
  folders.forEach(f => folderNameMap.set(f.id, f.name));
  await exportToZip(res, req.user.id, docs, folderNameMap, 'PenMark-导出.zip');
}));

// 单文件夹导出
app.get('/api/export/folder/:id', wrap(async (req, res) => {
  const folderId = Number(req.params.id);
  if (!Number.isInteger(folderId) || folderId <= 0) return res.status(400).json({ error: '无效的文件夹ID' });
  const folder = await db.one('SELECT id, name FROM folders WHERE id = $1 AND user_id = $2', [folderId, req.user.id]);
  if (!folder) return res.status(404).json({ error: '文件夹不存在' });
  const docs = await db.query(
    'SELECT id, title, content, folder_id FROM documents WHERE user_id = $1 AND deleted_at IS NULL AND folder_id = $2 ORDER BY updated_at DESC',
    [req.user.id, folderId]
  );
  if (!docs.length) return res.status(400).json({ error: '该文件夹没有可导出的文档' });
  const folderNameMap = new Map([[folder.id, folder.name]]);
  await exportToZip(res, req.user.id, docs, folderNameMap, safeExportName(folder.name, '文件夹') + '.zip');
}));

/* ---------- 举报 ---------- */
app.post('/api/reports', reportLimiter, wrap(async (req, res) => {
  const { doc_id, reason } = req.body;
  if (!doc_id) return res.status(400).json({ error: '缺少文档ID' });
  const cleanReason = String(reason || '').slice(0, 500);
  await db.execute("INSERT INTO reports (doc_id, reporter_id, reason, created_at) VALUES ($1, $2, $3, $4)", [doc_id, req.user.id, cleanReason, Date.now()]);
  res.json({ ok: true });
}));

app.get('/api/admin/reports', auth.adminOnly, wrap(async (req, res) => {
  const reports = await db.query(`
    SELECT r.*, d.title as doc_title, d.content as doc_content, d.flagged as doc_flagged,
           u.nickname as reporter_nickname, u.username as reporter_username,
           owner.nickname as owner_nickname, owner.username as owner_username
    FROM reports r
    JOIN documents d ON r.doc_id = d.id
    JOIN users u ON r.reporter_id = u.id
    JOIN users owner ON d.user_id = owner.id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC
  `);
  res.json(reports);
}));

app.put('/api/admin/reports/:id', auth.adminOnly, wrap(async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'resolved', 'dismissed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: '无效的状态' });
  await db.execute("UPDATE reports SET status = $1 WHERE id = $2", [status, req.params.id]);
  res.json({ ok: true });
}));

/* ---------- 审核面板 ---------- */
app.get('/api/admin/flagged', auth.adminOnly, wrap(async (req, res) => {
  const docs = await db.query(`
    SELECT d.*, u.nickname as author_nickname, u.username as author_username, u.can_share as author_can_share
    FROM documents d
    JOIN users u ON d.user_id = u.id
    WHERE d.deleted_at IS NULL AND (d.flagged = 1 OR u.can_share = 1)
    ORDER BY d.flagged DESC, d.updated_at DESC
    LIMIT 100
  `);
  res.json(docs);
}));

app.put('/api/admin/flagged/:id', auth.adminOnly, wrap(async (req, res) => {
  const { flagged, flag_reason } = req.body;
  await db.execute("UPDATE documents SET flagged = $1, flag_reason = $2 WHERE id = $3", [flagged ? 1 : 0, String(flag_reason || '').slice(0, 500), req.params.id]);
  res.json({ ok: true });
}));

/* ---------- 敏感词管理 ---------- */
app.get('/api/admin/sensitive-words', auth.adminOnly, wrap(async (req, res) => {
  const words = await db.query("SELECT * FROM sensitive_words ORDER BY created_at DESC");
  res.json(words);
}));

app.post('/api/admin/sensitive-words', auth.adminOnly, wrap(async (req, res) => {
  const { word } = req.body;
  if (!word || !word.trim()) return res.status(400).json({ error: '敏感词不能为空' });
  try {
    await db.execute("INSERT INTO sensitive_words (word, created_at) VALUES ($1, $2)", [word.trim(), Date.now()]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: '敏感词已存在' });
  }
}));

app.delete('/api/admin/sensitive-words/:id', auth.adminOnly, wrap(async (req, res) => {
  await db.execute("DELETE FROM sensitive_words WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- 分享管理 ---------- */
const SHARE_THEMES = new Set(['light', 'feishu', 'dark']);
const VISITOR_ONLINE_WINDOW_MS = 30 * 60 * 1000;

function normalizeShareTheme(value, fallback = 'light') {
  return SHARE_THEMES.has(value) ? value : fallback;
}

function normalizeVisitorFingerprint(value) {
  // A browser-local deduplication key, not an authentication credential.
  const fingerprint = String(value || '').trim().slice(0, 64);
  return /^[A-Za-z0-9._:-]{8,64}$/.test(fingerprint) ? fingerprint : '';
}

function shareAllowed(req, res, next) {
  if (req.user && (req.user.isAdmin || req.user.can_share)) return next();
  return res.status(403).json({ error: 'No share permission' });
}
async function recordReceivedShare(shareToken, userId, now) {
  const updated = await db.execute(
    'UPDATE share_receipts SET last_opened_at = $1 WHERE share_token = $2 AND user_id = $3',
    [now, shareToken, userId]
  );
  if (updated.changes) return;
  try {
    await db.execute(
      'INSERT INTO share_receipts (share_token, user_id, first_opened_at, last_opened_at) VALUES ($1, $2, $3, $4)',
      [shareToken, userId, now, now]
    );
  } catch (err) {
    // A parallel tab may have inserted the same (share, user) row first.
    await db.execute(
      'UPDATE share_receipts SET last_opened_at = $1 WHERE share_token = $2 AND user_id = $3',
      [now, shareToken, userId]
    );
  }
}

app.get('/api/shared-with-me', wrap(async (req, res) => {
  const requestedLimit = Number(req.query.limit) || 12;
  const limit = Math.min(Math.max(requestedLimit, 1), 24);
  const rows = await db.query(
    'SELECT sr.share_token AS token, sr.first_opened_at, sr.last_opened_at, ' +
    's.permission, d.id AS doc_id, d.title, d.updated_at, u.nickname AS owner_nickname ' +
    'FROM share_receipts sr ' +
    'JOIN shares s ON s.token = sr.share_token ' +
    'JOIN documents d ON d.id = s.doc_id ' +
    'LEFT JOIN users u ON u.id = s.owner_id ' +
    'WHERE sr.user_id = $1 AND s.owner_id <> $2 AND d.deleted_at IS NULL ' +
    'AND (s.expire_at IS NULL OR s.expire_at > $3) ' +
    'ORDER BY sr.last_opened_at DESC LIMIT $4',
    [req.user.id, req.user.id, Date.now(), limit]
  );
  res.json(rows.map(row => ({ ...row, url: '/s/' + row.token })));
}));

app.get('/api/documents/:id/share', wrap(async (req, res) => {
  const row = await db.one(
    'SELECT token, permission, password_hash IS NOT NULL AS has_password, expire_at, created_at, theme FROM shares WHERE doc_id = $1 AND owner_id = $2',
    [req.params.id, req.user.id]
  );
  if (!row) return res.json({ share: null });
  res.json({ share: { ...row, url: '/s/' + row.token } });
}));

app.post('/api/documents/:id/share', shareAllowed, wrap(async (req, res) => {
  const docId = Number(req.params.id);
  const doc = await db.one('SELECT id FROM documents WHERE id = $1 AND user_id = $2', [docId, req.user.id]);
  if (!doc) return res.status(404).json({ error: '文档不存在' });

  const existing = await db.one('SELECT id, token, permission, password_hash, password_salt, expire_at, theme FROM shares WHERE doc_id = $1 AND owner_id = $2', [docId, req.user.id]);

  const permission = req.body.permission !== undefined
    ? (req.body.permission === 'edit' ? 'edit' : 'view')
    : (existing ? existing.permission : 'view');

  let passwordHash = existing ? existing.password_hash : null;
  let passwordSalt = existing ? existing.password_salt : null;
  if (req.body.password !== undefined) {
    const pwd = String(req.body.password);
    if (pwd) {
      if (!/^\d{4}$/.test(pwd)) return res.status(400).json({ error: '访问码须为4位数字' });
      passwordSalt = crypto.randomBytes(16).toString('hex');
      passwordHash = auth.hashPassword(pwd, passwordSalt);
    } else {
      passwordHash = null;
      passwordSalt = null;
    }
  }

  let expireAt = existing ? existing.expire_at : null;
  if (req.body.expire_at !== undefined) {
    // Number.isFinite 防护：非数字字符串/Infinity/NaN 一律视为"无过期"
    // 否则 NaN 会绕过 < Date.now() 校验（NaN < x 恒为 false）并落库
    const parsed = req.body.expire_at ? Number(req.body.expire_at) : null;
    expireAt = (parsed !== null && Number.isFinite(parsed)) ? parsed : null;
    if (expireAt && expireAt < Date.now()) return res.status(400).json({ error: '过期时间必须晚于当前' });
  }

  const theme = req.body.theme !== undefined
    ? normalizeShareTheme(String(req.body.theme))
    : normalizeShareTheme(existing && existing.theme);

  let token;
  if (existing) {
    token = existing.token;
    await db.execute('UPDATE shares SET permission = $1, password_hash = $2, password_salt = $3, expire_at = $4, theme = $5 WHERE id = $6',
      [permission, passwordHash, passwordSalt, expireAt, theme, existing.id]);
  } else {
    let attempts = 0;
    do {
      token = auth.generateShareToken();
      attempts++;
    } while (await db.one('SELECT id FROM shares WHERE token = $1', [token]) && attempts < 10);
    if (!token) return res.status(500).json({ error: 'token 生成失败，请重试' });
    await db.execute(
      'INSERT INTO shares (doc_id, owner_id, token, permission, password_hash, password_salt, expire_at, created_at, theme) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [docId, req.user.id, token, permission, passwordHash, passwordSalt, expireAt, Date.now(), theme]
    );
  }
  res.json({ token, permission, has_password: !!passwordHash, expire_at: expireAt, theme, url: '/s/' + token });
}));

app.delete('/api/documents/:id/share', shareAllowed, wrap(async (req, res) => {
  const info = await db.execute('DELETE FROM shares WHERE doc_id = $1 AND owner_id = $2', [req.params.id, req.user.id]);
  res.json({ deleted: info.changes });
}));

app.put('/api/documents/:id/share/theme', shareAllowed, wrap(async (req, res) => {
  const theme = normalizeShareTheme(String(req.body.theme || 'light'));
  await db.execute('UPDATE shares SET theme = $1 WHERE doc_id = $2 AND owner_id = $3', [theme, req.params.id, req.user.id]);
  res.json({ ok: true });
}));

/* 文档作者视角的访客统计：用于编辑器内显示"X 人访问 · Y 人在线" */
app.get('/api/documents/:id/share-stats', wrap(async (req, res) => {
  const docId = Number(req.params.id);
  const share = await db.one(
    'SELECT token, permission, expire_at, theme FROM shares WHERE doc_id = $1 AND owner_id = $2',
    [docId, req.user.id]
  );
  if (!share) return res.json({ shared: false });
  if (share.expire_at && share.expire_at < Date.now()) {
    return res.json({ shared: true, expired: true, token: share.token, total: 0, online_30min: 0, visitors: [] });
  }
  // 三个 visitor 查询相互独立，串行 await 是 3 倍 RTT；并行 Promise.all 提速
  // （SQLite WAL 模式下读不互斥，PostgreSQL 也安全）
  // cutoff 在 Promise.all 之前计算，确保 5 分钟窗口在整批查询开始时就固定
  // The API field is online_30min: honor that full activity window.
  const cutoff = Date.now() - VISITOR_ONLINE_WINDOW_MS;
  const [recent, totalRow, onlineRow] = await Promise.all([
    db.query(
      'SELECT nickname, user_id, last_visit_at, visit_count FROM share_visitors WHERE share_token = $1 ORDER BY last_visit_at DESC LIMIT 20',
      [share.token]
    ),
    db.one(
      'SELECT COUNT(*) AS cnt FROM share_visitors WHERE share_token = $1',
      [share.token]
    ),
    db.one(
      'SELECT COUNT(*) AS cnt FROM share_visitors WHERE share_token = $1 AND last_visit_at >= $2',
      [share.token, cutoff]
    )
  ]);
  res.json({
    shared: true,
    expired: false,
    token: share.token,
    permission: share.permission,
    theme: share.theme,
    total: Number(totalRow && totalRow.cnt || 0),
    online_30min: Number(onlineRow && onlineRow.cnt || 0),
    visitors: (recent || []).map(v => ({
      nickname: v.nickname,
      user_id: v.user_id,
      is_registered: !!v.user_id,
      last_visit_at: v.last_visit_at,
      visit_count: v.visit_count
    }))
  });
}));

/* ---------- 公开访问 ---------- */
app.get('/api/public/share/:token/info', wrap(async (req, res) => {
  const share = await db.one('SELECT s.permission, s.password_hash IS NOT NULL AS has_password, s.expire_at, s.theme, u.nickname AS owner_nickname FROM shares s LEFT JOIN users u ON u.id = s.owner_id WHERE s.token = $1', [req.params.token]);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });
  res.json({ permission: share.permission, has_password: !!share.has_password, can_edit: share.permission === 'edit', theme: normalizeShareTheme(share.theme), owner_nickname: share.owner_nickname || '' });
}));

const shareRateLimit = new Map();
const shareRateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of shareRateLimit) { if (now > v.reset) shareRateLimit.delete(k); }
}, 60000);
if (shareRateCleanupTimer.unref) shareRateCleanupTimer.unref();

app.post('/api/public/share/:token/auth', wrap(async (req, res) => {
  const share = await db.one('SELECT * FROM shares WHERE token = $1', [req.params.token]);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });
  if (!share.password_hash) {
    const ss = auth.signShareSession({ token: share.token, authed: true });
    auth.setShareCookie(res, ss, req);
    return res.json({ ok: true });
  }
  const limitKey = req.ip + ':' + req.params.token;
  let limit = shareRateLimit.get(limitKey);
  const now = Date.now();
  if (limit && limit.count >= 5 && now < limit.reset) return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
  if (!limit || now > limit.reset) limit = { count: 0, reset: now + 60000 };
  const password = String(req.body.password || '');
  if (!auth.verifyPassword(password, share.password_salt, share.password_hash)) {
    limit.count++;
    shareRateLimit.set(limitKey, limit);
    return res.status(401).json({ error: '密码错误' });
  }
  shareRateLimit.delete(limitKey);
  const ss = auth.signShareSession({ token: share.token, authed: true });
    auth.setShareCookie(res, ss, req);
    res.json({ ok: true });
}));

// Public-share image route. It has its own authorization because the normal asset route
// requires a signed-in owner session; password-protected shares reuse the share cookie.
function rewriteShareAssetUrls(html, token) {
  const base = '/api/public/share/' + encodeURIComponent(token) + '/assets/';
  return String(html || '').replace(/(["'])\/api\/assets\/([0-9a-f-]{36})\1/gi, (match, quote, id) => quote + base + id + quote);
}

function rewriteShareAssetUrlsAbsolute(html, token, req, publicUrls) {
  const origin = getPublicRequestOrigin(req);
  const fallbackBase = origin ? origin + '/api/public/share/' + encodeURIComponent(token) + '/assets/' : null;
  const urlMap = publicUrls instanceof Map ? publicUrls : new Map();
  return String(html || '').replace(/(["'])\/api\/assets\/([0-9a-f-]{36})\1/gi, (match, quote, id) => {
    // S4 ready 的资源直接写公开 URL（访客浏览器直连 S4，不经 PenMark）；
    // pending/local 的走 PenMark 兜底路由（访客访问时 waitReady 后再 302）。
    const publicUrl = urlMap.get(id);
    if (publicUrl) return quote + publicUrl + quote;
    return fallbackBase ? quote + fallbackBase + id + quote : match;
  });
}

// 预查文档中所有 asset 的 S4 公开 URL，供 rewriteShareAssetUrlsAbsolute 同步使用。
// 必须在 rewriteShareAssetUrlsAbsolute 之前调用。
async function preloadShareAssetPublicUrls(docId) {
  const map = new Map();
  if (!assetStore.s4Enabled) return map;
  try {
    const rows = await db.query(
      "SELECT id, remote_provider, remote_status, remote_key FROM media_assets WHERE doc_id = $1 AND remote_provider = 's4' AND remote_status = 'ready'",
      [docId]
    );
    for (const row of rows) {
      const url = assetStore.publicRemoteUrl(row);
      if (url) map.set(row.id, url);
    }
  } catch (err) {
    console.warn('[share] preload asset public URLs failed:', err && err.message);
  }
  return map;
}

function restorePrivateAssetUrls(html, token) {
  const escapedToken = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('(["\'])/api/public/share/' + escapedToken + '/assets/([0-9a-f-]{36})\\1', 'gi');
  return String(html || '').replace(pattern, (match, quote, id) => quote + '/api/assets/' + id + quote);
}

app.get('/api/public/share/:token/assets/:assetId', wrap(async (req, res) => {
  const share = await db.one('SELECT doc_id, token, expire_at, password_hash FROM shares WHERE token = $1', [req.params.token]);
  if (!share) return res.status(404).json({ error: 'invalid share' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: 'share expired' });
  if (share.password_hash) {
    const session = auth.verifyShareSession(auth.readShareCookie(req));
    if (!session || !session.authed || session.token !== share.token) return res.status(401).json({ error: 'need_password' });
  }
  let asset = await db.one(
    'SELECT * FROM media_assets WHERE id = $1 AND doc_id = $2',
    [req.params.assetId, share.doc_id]
  );
  if (!asset) return res.status(404).json({ error: 'not found' });
  // 核心修复：管理员/用户上传后立即分享，访客打开时 S4 可能仍 pending。
  // 此时主动等待 S4 上传完成（最多 5 秒），完成后再走 302 signedUrl。
  // 这样保证"分享出去的图，哪怕访客是游客也能看到"，前提是 S4 已配置且上传最终会成功。
  // S4 未启用 / 上传失败 / 超时 → 回退本地文件兜底。
  if (asset.remote_provider === 's4' && asset.remote_status === 'pending') {
    await assetStore.waitRemoteReady(asset.id, 5000);
    const refreshed = await db.one('SELECT * FROM media_assets WHERE id = $1', [asset.id]);
    if (refreshed) asset = refreshed;
  }
  const remoteUrl = assetStore.signedRemoteUrl(asset);
  if (remoteUrl) {
    // 302 到 S4 后流量由 S4 直出，无法在 PenMark 侧精确计量；按 asset 字节估算并累计到 owner
    assetStore.recordBandwidth(asset.owner_id, asset.byte_size).catch(() => {});
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.redirect(302, remoteUrl);
  }
  const filePath = await assetStore.filePath(asset);
  if (!filePath) return res.status(404).json({ error: '\u8d44\u6e90\u4e0d\u5b58\u5728' });
  res.set({
    'Content-Type': asset.mime_type,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff'
  });
  // 本地直出按真实字节累计流量
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      assetStore.recordBandwidth(asset.owner_id, asset.byte_size).catch(() => {});
    }
  });
  res.sendFile(filePath);
}));

app.get('/api/public/share/:token/doc', wrap(async (req, res) => {
  const share = await db.one('SELECT s.*, u.nickname AS owner_nickname FROM shares s LEFT JOIN users u ON u.id = s.owner_id WHERE s.token = $1', [req.params.token]);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });
  if (share.password_hash) {
    const ss = auth.verifyShareSession(auth.readShareCookie(req));
    if (!ss || !ss.authed || ss.token !== share.token) {
      return res.status(401).json({ error: 'need_password', has_password: true });
    }
  }
  const doc = await db.one('SELECT id, title, content, updated_at, created_at, version FROM documents WHERE id = $1 AND deleted_at IS NULL', [share.doc_id]);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  // 预查本文档中已 ready 的 S4 资源公开 URL，分享 HTML 直接写公开 URL，访客直连 S4 不经 PenMark
  const publicUrls = await preloadShareAssetPublicUrls(share.doc_id);
  // 读取侧也净化一次：防御历史存量数据中可能存在的恶意脚本（写入侧净化是新增的）
  doc.content = rewriteShareAssetUrlsAbsolute(sanitizeShareContent(doc.content || ''), share.token, req, publicUrls);
  res.json({ doc, permission: share.permission, can_edit: share.permission === 'edit', owner_nickname: share.owner_nickname || '' });
}));

app.put('/api/public/share/:token/doc', wrap(async (req, res) => {
  const share = await db.one('SELECT * FROM shares WHERE token = $1', [req.params.token]);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });
  if (share.permission !== 'edit') return res.status(403).json({ error: '此链接无编辑权限' });
  if (share.password_hash) {
    const ss = auth.verifyShareSession(auth.readShareCookie(req));
    if (!ss || !ss.authed || ss.token !== share.token) {
      return res.status(401).json({ error: 'need_password' });
    }
  }
  const now = Date.now();
  const title = String(req.body.title || '无标题').slice(0, DOC_TITLE_MAX_LENGTH);
  // 服务端净化：分享编辑权限可能开放给半信任用户，必须剥离 script/事件/危险协议，
  // 防 stored XSS（恶意协作者写入脚本，作者或其他读者查看时执行）
  const content = sanitizeShareContent(restorePrivateAssetUrls(String(req.body.content || '').slice(0, DOC_MAX_BYTES), share.token));
  const info = await db.execute('UPDATE documents SET title = $1, content = $2, updated_at = $3, version = version + 1 WHERE id = $4 AND deleted_at IS NULL',
    [title, content, now, share.doc_id]);
  if (info.changes === 0) return res.status(404).json({ error: '文档不存在' });
  const vRow = await db.one('SELECT version, updated_at FROM documents WHERE id = $1', [share.doc_id]);
  res.json({ updated: info.changes, version: vRow ? vRow.version : undefined, updated_at: vRow ? vRow.updated_at : now });
}));

/* 轻量级版本查询（公开分享用） */
app.get('/api/public/share/:token/version', wrap(async (req, res) => {
  const share = await db.one('SELECT doc_id, token, expire_at, permission, password_hash FROM shares WHERE token = $1', [req.params.token]);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });
  if (share.password_hash) {
    const ss = auth.verifyShareSession(auth.readShareCookie(req));
    if (!ss || !ss.authed || ss.token !== share.token) {
      return res.status(401).json({ error: 'need_password' });
    }
  }
  const row = await db.one('SELECT version, updated_at, title FROM documents WHERE id = $1 AND deleted_at IS NULL', [share.doc_id]);
  if (!row) return res.status(404).json({ error: '文档不存在' });
  res.json({ version: row.version, updated_at: row.updated_at, title: row.title });
}));

// 访客上报：前端生成 fingerprint（Canvas+UA hash），后端 UPSERT 记录最近访问
app.post('/api/public/share/:token/visit', visitLimiter, wrap(async (req, res) => {
  const share = await db.one('SELECT token, owner_id, password_hash, expire_at FROM shares WHERE token = $1', [req.params.token]);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });

  if (share.password_hash) {
    const session = auth.verifyShareSession(auth.readShareCookie(req));
    if (!session || !session.authed || session.token !== share.token) {
      return res.status(401).json({ error: 'need_password' });
    }
  }
  const fingerprint = normalizeVisitorFingerprint(req.body.fingerprint);
  if (!fingerprint) {
    return res.status(400).json({ error: 'fingerprint 不合法' });
  }
  const nickname = String(req.body.nickname || '游客').slice(0, 20).replace(/[<>]/g, '');
  const now = Date.now();

  // 识别登录用户：分享页也可能被登录用户访问（owner 自己、被邀请的协作者等）
  // 如果访客已登录，把 user_id 和真实 nickname 写入，前端就能用亮色显示
  let visitorUserId = null;
  let visitorNickname = nickname;
  try {
    const token = auth.readCookie(req, auth.COOKIE_NAME);
    if (token) {
      const sessUser = await auth.verifySession(token);
      if (sessUser) {
        visitorUserId = sessUser.id;
        // 优先用 nickname，其次 username，最后才用 phone
        visitorNickname = (sessUser.nickname && sessUser.nickname.trim()) ||
                          (sessUser.username && sessUser.username.trim()) ||
                          nickname;
      }
    }
  } catch (e) { /* 未登录访客，正常路径 */ }

  if (visitorUserId && Number(visitorUserId) !== Number(share.owner_id)) {
    try {
      await recordReceivedShare(share.token, visitorUserId, now);
    } catch (err) {
      console.warn('[share/receipt] record failed:', err && err.message);
    }
  }
  // UPSERT：同 (token, fingerprint) 则累加 visit_count、刷新 last_visit_at
  try {
    const existing = await db.one(
      'SELECT id, user_id FROM share_visitors WHERE share_token = $1 AND fingerprint = $2',
      [share.token, fingerprint]
    );
    if (existing) {
      // 如果之前是游客（user_id NULL），现在登录了，把 user_id 补上 + 改用真名
      // 注意：SQLite 适配器把 $N 按出现顺序转成 ?，必须让 $N 数字顺序 = 出现顺序
      if (visitorUserId && !existing.user_id) {
        await db.execute(
          'UPDATE share_visitors SET last_visit_at = $1, visit_count = visit_count + 1, nickname = $2, user_id = $3 WHERE id = $4',
          [now, visitorNickname, visitorUserId, existing.id]
        );
      } else {
        await db.execute(
          'UPDATE share_visitors SET last_visit_at = $1, visit_count = visit_count + 1, nickname = $2 WHERE id = $3',
          [now, visitorNickname, existing.id]
        );
      }
    } else {
      await db.execute(
        'INSERT INTO share_visitors (share_token, fingerprint, nickname, user_id, first_visit_at, last_visit_at, visit_count) VALUES ($1, $2, $3, $4, $5, $6, 1)',
        [share.token, fingerprint, visitorNickname, visitorUserId, now, now]
      );
    }
  } catch (e) {
    // 并发插入冲突时退化为更新；记录真实错误避免静默吞没 DB 异常
    console.warn('[share/visit] UPSERT 失败，退化更新：', e && e.message);
    await db.execute(
      'UPDATE share_visitors SET last_visit_at = $1, visit_count = visit_count + 1 WHERE share_token = $2 AND fingerprint = $3',
      [now, share.token, fingerprint]
    ).catch(e2 => console.warn('[share/visit] 退化更新也失败：', e2 && e2.message));
  }

  // 同时返回最新访客列表，避免前端再发一次请求
  // 注意：$N 必须按出现顺序编号，SQLite 适配器按出现顺序转 ?
  const recent = await db.query(
    'SELECT nickname, user_id, last_visit_at, visit_count, CASE WHEN fingerprint = $1 THEN 1 ELSE 0 END AS is_me FROM share_visitors WHERE share_token = $2 ORDER BY last_visit_at DESC LIMIT 50',
    [fingerprint, share.token]
  );
  const totalRow = await db.one(
    'SELECT COUNT(*) AS cnt FROM share_visitors WHERE share_token = $1',
    [share.token]
  );
  const cutoff = now - VISITOR_ONLINE_WINDOW_MS;
  const onlineRow = await db.one(
    'SELECT COUNT(*) AS cnt FROM share_visitors WHERE share_token = $1 AND last_visit_at >= $2',
    [share.token, cutoff]
  );
  res.json({
    visitors: recent.map(v => ({
      nickname: v.nickname,
      user_id: v.user_id,
      is_registered: !!v.user_id,
      last_visit_at: v.last_visit_at,
      visit_count: v.visit_count,
      is_me: !!v.is_me
    })),
    total: Number(totalRow && totalRow.cnt || 0),
    online_30min: Number(onlineRow && onlineRow.cnt || 0)
  });
}));

// 访客列表查询：用于刷新（不写入）
app.get('/api/public/share/:token/visitors', wrap(async (req, res) => {
  const share = await db.one('SELECT token, expire_at, password_hash FROM shares WHERE token = $1', [req.params.token]);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });
  if (share.password_hash) {
    const ss = auth.verifyShareSession(auth.readShareCookie(req));
    if (!ss || !ss.authed || ss.token !== share.token) {
      return res.status(401).json({ error: 'need_password' });
    }
  }

  const recent = await db.query(
    'SELECT nickname, user_id, last_visit_at, visit_count FROM share_visitors WHERE share_token = $1 ORDER BY last_visit_at DESC LIMIT 50',
    [share.token]
  );
  const totalRow = await db.one(
    'SELECT COUNT(*) AS cnt FROM share_visitors WHERE share_token = $1',
    [share.token]
  );
  const cutoff = Date.now() - VISITOR_ONLINE_WINDOW_MS;
  const onlineRow = await db.one(
    'SELECT COUNT(*) AS cnt FROM share_visitors WHERE share_token = $1 AND last_visit_at >= $2',
    [share.token, cutoff]
  );
  res.json({
    visitors: (recent || []).map(v => ({
      nickname: v.nickname,
      is_registered: !!v.user_id,
      last_visit_at: v.last_visit_at,
      visit_count: v.visit_count
    })),
    total: Number(totalRow && totalRow.cnt || 0),
    online_30min: Number(onlineRow && onlineRow.cnt || 0)
  });
}));

/* ---------- 分享页 OG / Twitter 卡片 ---------- */
// 可配置短域名：设置 SHARE_BASE_URL=https://p.dnbox.cn 后，og:url 与卡片链接走短域名
function shareAbsoluteUrl(req, token) {
  const base = process.env.SHARE_BASE_URL
    ? String(process.env.SHARE_BASE_URL).replace(/\/+$/, '')
    : getPublicRequestOrigin(req);
  return base + '/s/' + token;
}
// 从文档 HTML 中提取第一张远程图片（http/https），base64 不适合做 OG 图
function extractFirstRemoteImage(html) {
  if (!html) return '';
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/^https?:\/\//i.test(m[1])) return m[1];
  }
  return '';
}
// 从文档 HTML 提取纯文本摘要
function extractTextExcerpt(html, max) {
  if (!html) return '';
  const text = String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}
function escapeMeta(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, ' ');
}
let shareHtmlTemplate = null;
function getShareHtmlTemplate() {
  if (!shareHtmlTemplate) {
    shareHtmlTemplate = fs.readFileSync(path.join(__dirname, 'public', 'share.html'), 'utf8');
  }
  return shareHtmlTemplate;
}
function renderShareHTML(card) {
  const title = escapeMeta(card.title);
  const desc = escapeMeta(card.desc);
  const url = escapeMeta(card.url);
  const image = escapeMeta(card.ogImage);
  const siteName = escapeMeta(card.siteName);
  const fullTitle = title + ' ' + siteName;
  const metas = [
    '<title>' + fullTitle + '</title>',
    '<meta name="description" content="' + desc + '">',
    '<link rel="canonical" href="' + url + '">',
    '<meta property="og:type" content="article">',
    '<meta property="og:title" content="' + title + '">',
    '<meta property="og:description" content="' + desc + '">',
    '<meta property="og:image" content="' + image + '">',
    '<meta property="og:url" content="' + url + '">',
    '<meta property="og:site_name" content="' + siteName + '">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="' + title + '">',
    '<meta name="twitter:description" content="' + desc + '">',
    '<meta name="twitter:image" content="' + image + '">'
  ].join('\n');
  // 替换原 <title> 占位行，注入卡片 meta
  return getShareHtmlTemplate().replace(
    /<title>分享文档 知著 PenMark<\/title>/,
    metas
  );
}

app.get('/s/:token', wrap(async (req, res) => {
  const token = req.params.token;
  const row = await db.one(
    'SELECT s.permission, s.password_hash IS NOT NULL AS has_password, s.expire_at, ' +
    'd.title, d.content, d.deleted_at, u.nickname AS owner_nickname ' +
    'FROM shares s ' +
    'LEFT JOIN documents d ON d.id = s.doc_id ' +
    'LEFT JOIN users u ON u.id = s.owner_id ' +
    'WHERE s.token = $1',
    [token]
  );
  if (!row || row.deleted_at) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  if (row.expire_at && row.expire_at < Date.now()) return res.status(410).send('<h1>链接已过期</h1>');

  // 加密分享不泄露标题/正文，仅给通用卡片
  const protectedDoc = !!row.has_password;
  const origin = getPublicRequestOrigin(req);
  const card = {
    title: protectedDoc ? '知著 PenMark 分享文档' : ((row.title || '无标题').trim() || '无标题'),
    desc: protectedDoc
      ? '这是一份加密分享的文档，请输入密码查看。'
      : (extractTextExcerpt(row.content, 140) || '在知著 PenMark 分享的文档。'),
    ogImage: protectedDoc
      ? (origin + '/PenMark_Brand_Assets/penmark-app-icon-1024.png')
      : (extractFirstRemoteImage(row.content) || (origin + '/PenMark_Brand_Assets/penmark-app-icon-1024.png')),
    url: shareAbsoluteUrl(req, token),
    siteName: '知著 PenMark'
  };
  res.type('html').send(renderShareHTML(card));
}));

/* ---------- 统一错误处理 ---------- */
app.use((err, req, res, next) => {
  const requestId = 'err_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  console.error('Unhandled request error:', {
    requestId,
    method: req.method,
    path: req.originalUrl || req.url,
    code: err && err.code,
    message: err && err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err && err.stack
  });
  if (process.env.NODE_ENV !== 'production') {
    res.status(500).json({ error: err.message || '服务器内部错误', requestId });
  } else {
    res.status(500).json({ error: '服务器内部错误', requestId });
  }
});

/* ---------- 通配 404：未匹配的 GET 请求返回品牌 404 页 ---------- */
app.use((req, res) => {
  // 只对浏览器导航的 GET 请求返回 HTML 404 页；API 仍走 JSON
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/s/')) {
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }
  res.status(404).json({ error: 'not found' });
});

/* ---------- 可编程启动 ---------- */
async function startServer(opts) {
  opts = opts || {};
  const host = opts.host || HOST;
  const port = opts.port != null ? opts.port : PORT;

  // 等待管理员初始化完成
  await auth.ready;

  // PostgreSQL 模式：验证连接并执行迁移
  if (db.isPostgres()) {
    try {
      const version = await db.verifyConnection();
      console.log('PostgreSQL 连接成功');
      // 自动执行迁移
      const { migrate } = require('./database/migrate');
      await migrate();
      if (assetStore.startRemoteMirrorWorker()) {
        console.log('[assets] administrator S4 mirror enabled; local fallback retained');
      }
    } catch (err) {
      console.error('PostgreSQL 连接失败:', err.message);
      throw err;
    }
  } else {
    console.log('使用 SQLite（本地模式）');
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const actualPort = server.address().port;
      const display = host === '127.0.0.1' ? '127.0.0.1' : 'localhost';
      console.log(`知著 PenMark 运行于 http://${display}:${actualPort}（同时监听 IPv4/IPv6）`);
      // 孤儿图片回收：启动后5分钟跑一次，之后每24小时一次（30天宽限期，软删除文档的图不清理）
      setTimeout(cleanupOrphanAssets, 5 * 60 * 1000);
      setInterval(cleanupOrphanAssets, 24 * 60 * 60 * 1000);
      resolve({ server, port: actualPort, host });
    });
    server.on('error', reject);
  });
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('启动失败：', err.message);
    process.exit(1);
  });
}

module.exports = { app, startServer };
