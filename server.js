// 知著 PenMark 服务端（异步版）
// Express + PostgreSQL（网页版）/ SQLite（桌面版）
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const db = require('./database');
const auth = require('./auth');
const invites = require('./invites');
const ai = require('./ai');

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
app.use(express.static(path.join(__dirname, 'public')));

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
  if (maxRedirects < 0) { cb(new Error('too many redirects')); return; }
  let parsed;
  try { parsed = new URL(url); } catch (_) { cb(new Error('invalid url')); return; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { cb(new Error('bad protocol')); return; }
  if (isPrivateHost(parsed.hostname)) { cb(new Error('blocked host')); return; }
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
      fetchImageAsBase64(next, maxRedirects - 1, cb);
      return;
    }
    if (resp.statusCode !== 200) { resp.resume(); cb(new Error('HTTP ' + resp.statusCode)); return; }
    const chunks = [];
    let size = 0;
    const MAX = 15 * 1024 * 1024;
    resp.on('data', (c) => {
      size += c.length;
      if (size > MAX) { req.destroy(); cb(new Error('too large')); return; }
      chunks.push(c);
    });
    resp.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = (resp.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
      cb(null, 'data:' + ct + ';base64,' + buf.toString('base64'), ct, buf.length);
    });
  });
  req.on('error', cb);
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
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
      let buf = '', size = 0, tooBig = false;
      resp.on('data', d => { size += d.length; if (size > 1048576) { tooBig = true; resp.destroy(); return; } buf += d; });
      resp.on('end', () => {
        if (tooBig) { reject(new Error('页面过大')); return; }
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

app.get('/api/og', ogLimiter, wrap(async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: '缺少 url' });
  try {
    const meta = await fetchOG(url);
    res.json(meta);
  } catch (e) {
    res.status(502).json({ error: '抓取失败：' + (e.message || e) });
  }
}));

/* ---------- 文档 CRUD（按 user_id 隔离） ---------- */
// 文档内容大小上限（默认 5MB），与 Nginx client_max_body_size 协同
const DOC_MAX_BYTES = Number(process.env.PENMARK_DOC_MAX_BYTES) || 5 * 1024 * 1024;

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
  const rows = await db.query(
    'SELECT id, title, folder_id, created_at, updated_at FROM documents WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC',
    [req.user.id]
  );
  res.json(rows);
}));

app.get('/api/documents/:id', wrap(async (req, res) => {
  const row = await db.one('SELECT * FROM documents WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
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
  const title = String(req.body.title || '无标题').slice(0, 500);
  const content = String(req.body.content || '').slice(0, DOC_MAX_BYTES);
  const info = await db.execute(
    'INSERT INTO documents (title, content, created_at, updated_at, user_id, folder_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [title, content, now, now, req.user.id, folderId]
  );
  res.json({ id: info.insertId });
}));

app.put('/api/documents/:id', wrap(async (req, res) => {
  const now = Date.now();
  const title = String(req.body.title || '').slice(0, 500);
  const content = String(req.body.content || '').slice(0, DOC_MAX_BYTES);
  const docId = req.params.id;
  const userId = req.user.id;

  // 读取旧内容用于版本快照差异计算（不阻塞主保存路径：失败仅 warn）
  let prevRow = null;
  try {
    prevRow = await db.one('SELECT title, content, version FROM documents WHERE id = $1 AND user_id = $2', [docId, userId]);
  } catch (e) { /* 表不存在或数据库异常时静默忽略 */ }

  const info = await db.execute(
    'UPDATE documents SET title = $1, content = $2, updated_at = $3, version = version + 1 WHERE id = $4 AND user_id = $5',
    [title, content, now, docId, userId]
  );
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  // 回查最新版本号，回传给客户端用于多端同步判断
  const vRow = await db.one('SELECT version, updated_at FROM documents WHERE id = $1', [docId]);
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
      // 版本快照：与上一版可见字符数差异 > 50 才写
      try {
        if (prevRow) {
          const prevText = stripHtml(prevRow.content || '');
          const currText = stripHtml(content || '');
          const charsDiff = Math.abs(currText.length - prevText.length);
          if (charsDiff > 50) {
            await db.execute(
              'INSERT INTO document_versions (doc_id, user_id, title, content, chars_diff, version, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
              [docId, userId, title, content, charsDiff, (vRow && vRow.version) || 1, now]
            );
          }
        }
      } catch (e) {
        console.warn('版本快照写入跳过：', e && e.message);
      }
    })().catch(e => console.warn('保存后处理异常：', e && e.message));
  });
  res.json({ updated: info.changes, version: vRow ? vRow.version : undefined, updated_at: vRow ? vRow.updated_at : now });
}));

/* 文档版本历史列表（轻量元数据：不返回 content，前端按需请求单条详情） */
app.get('/api/documents/:id/versions', wrap(async (req, res) => {
  const rows = await db.query(
    'SELECT id, title, chars_diff, version, created_at FROM document_versions WHERE doc_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 200',
    [req.params.id, req.user.id]
  );
  res.json(rows);
}));

/* 文档版本详情：返回完整内容用于 AI 分析或回看 */
app.get('/api/documents/:id/versions/:versionId', wrap(async (req, res) => {
  const row = await db.one(
    'SELECT id, title, content, chars_diff, version, created_at FROM document_versions WHERE doc_id = $1 AND user_id = $2 AND id = $3',
    [req.params.id, req.user.id, req.params.versionId]
  );
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
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
  const info = await db.execute(
    'INSERT INTO folders (name, user_id, sort_order, created_at) VALUES ($1, $2, $3, $4)',
    [name, req.user.id, Date.now(), Date.now()]
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
  out = out.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
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

app.post('/api/ai/layout', aiLimiter, wrap(async (req, res) => {
  try {
    const rawHtml = String(req.body && req.body.html || '');
    const preset = String(req.body && req.body.preset || 'share');
    const docId = req.body && req.body.docId ? Number(req.body.docId) : null;
    if (!rawHtml.trim()) return res.status(400).json({ error: 'empty html' });
    const protectedInput = protectAiAssets(rawHtml);
    if (protectedInput.html.length > Number(process.env.AI_LAYOUT_MAX_INPUT || 120000)) {
      return res.status(413).json({ error: 'document is too large for one AI layout request' });
    }
    const aiHtml = await ai.layoutHtml(protectedInput.html, preset);
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
    res.status(500).json({ error: err.message || String(err) });
  }
}));

app.post('/api/ai/rewrite-selection', aiLimiter, wrap(async (req, res) => {
  try {
    const selectedText = String(req.body && req.body.selectedText || '').slice(0, Number(process.env.AI_SELECTION_MAX_CHARS || 10000));
    const instruction = String(req.body && req.body.instruction || '').slice(0, 500);
    const contextText = String(req.body && req.body.contextText || '').slice(0, Number(process.env.AI_CONTEXT_MAX_CHARS || 24000));
    const docId = req.body && req.body.docId ? Number(req.body.docId) : null;
    if (!selectedText.trim()) return res.status(400).json({ error: 'empty selection' });
    const replacement = await ai.rewriteSelection(selectedText, instruction, contextText);
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
    res.status(500).json({ error: err.message || String(err) });
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
      '如果用户问的不是关于当前文档，礼貌地引导回写作话题。'
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
    } else {
      console.log('[ai/chat] 未命中动作关键词（消息："' + userMessage.slice(0, 40) + '..."）');
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
      timeoutMs: 70000
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
    res.status(500).json({ error: err.message || String(err) });
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
  const pattern = '%' + q + '%';
  const rows = await db.query(
    "SELECT id, title, content, updated_at FROM documents WHERE user_id = $1 AND deleted_at IS NULL AND (LOWER(title) LIKE LOWER($2) OR LOWER(content) LIKE LOWER($3)) ORDER BY updated_at DESC",
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
      const info = await tx.execute('DELETE FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL', [targetId, req.user.id]);
      if (info.changes === 0) throw new Error('NOT_FOUND');
    });
  } catch (e) {
    if (e.message === 'NOT_FOUND') return res.status(404).json({ error: '文档不存在' });
    return res.status(500).json({ error: '删除失败：' + (e.message || e) });
  }
  res.json({ ok: true });
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
function shareAllowed(req, res, next) {
  if (req.user && (req.user.isAdmin || req.user.can_share)) return next();
  return res.status(403).json({ error: 'No share permission' });
}

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
      if (!/^[A-Za-z0-9]{6,}$/.test(pwd)) return res.status(400).json({ error: '密码须为6位或以上字母或数字' });
      passwordSalt = crypto.randomBytes(16).toString('hex');
      passwordHash = auth.hashPassword(pwd, passwordSalt);
    } else {
      passwordHash = null;
      passwordSalt = null;
    }
  }

  let expireAt = existing ? existing.expire_at : null;
  if (req.body.expire_at !== undefined) {
    expireAt = req.body.expire_at ? Number(req.body.expire_at) : null;
    if (expireAt && expireAt < Date.now()) return res.status(400).json({ error: '过期时间必须晚于当前' });
  }

  const theme = req.body.theme !== undefined ? String(req.body.theme) : (existing ? existing.theme : 'light');

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
  const theme = String(req.body.theme || 'light');
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
  const recent = await db.query(
    'SELECT nickname, user_id, last_visit_at, visit_count FROM share_visitors WHERE share_token = $1 ORDER BY last_visit_at DESC LIMIT 20',
    [share.token]
  );
  const totalRow = await db.one(
    'SELECT COUNT(*) AS cnt FROM share_visitors WHERE share_token = $1',
    [share.token]
  );
  const cutoff = Date.now() - 30 * 60 * 1000;
  const onlineRow = await db.one(
    'SELECT COUNT(*) AS cnt FROM share_visitors WHERE share_token = $1 AND last_visit_at >= $2',
    [share.token, cutoff]
  );
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
  const share = await db.one('SELECT permission, password_hash IS NOT NULL AS has_password, expire_at, theme FROM shares WHERE token = $1', [req.params.token]);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });
  res.json({ permission: share.permission, has_password: !!share.has_password, can_edit: share.permission === 'edit', theme: share.theme || 'light' });
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
    auth.setShareCookie(res, ss);
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
  auth.setShareCookie(res, ss);
  res.json({ ok: true });
}));

app.get('/api/public/share/:token/doc', wrap(async (req, res) => {
  const share = await db.one('SELECT * FROM shares WHERE token = $1', [req.params.token]);
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
  res.json({ doc, permission: share.permission, can_edit: share.permission === 'edit' });
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
  const title = String(req.body.title || '无标题').slice(0, 500);
  const content = String(req.body.content || '').slice(0, DOC_MAX_BYTES);
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
  console.log('[share/visit] 收到请求 token=' + req.params.token.slice(0, 8) + ' body=' + JSON.stringify(req.body || {}).slice(0, 100));
  const share = await db.one('SELECT token, expire_at FROM shares WHERE token = $1', [req.params.token]);
  if (!share) { console.warn('[share/visit] token 不存在'); return res.status(404).json({ error: '链接无效' }); }
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });

  const fingerprint = String(req.body.fingerprint || '').slice(0, 64);
  if (!/^[a-f0-9]{8,64}$/i.test(fingerprint)) {
    console.warn('[share/visit] fingerprint 不合法：' + fingerprint.slice(0, 20));
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

  // UPSERT：同 (token, fingerprint) 则累加 visit_count、刷新 last_visit_at
  try {
    const existing = await db.one(
      'SELECT id, user_id FROM share_visitors WHERE share_token = $1 AND fingerprint = $2',
      [share.token, fingerprint]
    );
    if (existing) {
      // 如果之前是游客（user_id NULL），现在登录了，把 user_id 补上 + 改用真名
      const updateUserClause = (visitorUserId && !existing.user_id)
        ? ', user_id = $4, nickname = $2 '
        : (visitorUserId && existing.user_id === visitorUserId ? ', nickname = $2 ' : '');
      if (visitorUserId && !existing.user_id) {
        await db.execute(
          'UPDATE share_visitors SET last_visit_at = $1, visit_count = visit_count + 1, nickname = $2, user_id = $4 WHERE id = $3',
          [now, visitorNickname, existing.id, visitorUserId]
        );
      } else {
        await db.execute(
          'UPDATE share_visitors SET last_visit_at = $1, visit_count = visit_count + 1, nickname = $2 WHERE id = $3',
          [now, visitorNickname, existing.id]
        );
      }
    } else {
      await db.execute(
        'INSERT INTO share_visitors (share_token, fingerprint, nickname, user_id, first_visit_at, last_visit_at, visit_count) VALUES ($1, $2, $3, $4, $5, $5, 1)',
        [share.token, fingerprint, visitorNickname, visitorUserId, now]
      );
    }
  } catch (e) {
    console.warn('[share/visit] UPSERT 失败，尝试退化为更新：', e && e.message);
    // 并发插入冲突时退化为更新
    await db.execute(
      'UPDATE share_visitors SET last_visit_at = $1, visit_count = visit_count + 1 WHERE share_token = $2 AND fingerprint = $3',
      [now, share.token, fingerprint]
    ).catch(() => null);
  }

  console.log('[share/visit] token=' + share.token.slice(0, 8) + ' fp=' + fingerprint.slice(0, 8) + ' user_id=' + (visitorUserId || 'null') + ' nickname=' + visitorNickname);

  // 同时返回最新访客列表，避免前端再发一次请求
  const recent = await db.query(
    'SELECT nickname, user_id, last_visit_at, visit_count, CASE WHEN fingerprint = $2 THEN 1 ELSE 0 END AS is_me FROM share_visitors WHERE share_token = $1 ORDER BY last_visit_at DESC LIMIT 50',
    [share.token, fingerprint]
  );
  const totalRow = await db.one(
    'SELECT COUNT(*) AS cnt FROM share_visitors WHERE share_token = $1',
    [share.token]
  );
  const cutoff = now - 30 * 60 * 1000;
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
  const share = await db.one('SELECT token, expire_at FROM shares WHERE token = $1', [req.params.token]);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });

  const recent = await db.query(
    'SELECT nickname, user_id, last_visit_at, visit_count FROM share_visitors WHERE share_token = $1 ORDER BY last_visit_at DESC LIMIT 50',
    [share.token]
  );
  const totalRow = await db.one(
    'SELECT COUNT(*) AS cnt FROM share_visitors WHERE share_token = $1',
    [share.token]
  );
  const cutoff = Date.now() - 30 * 60 * 1000;
  const onlineRow = await db.one(
    'SELECT COUNT(*) AS cnt FROM share_visitors WHERE share_token = $1 AND last_visit_at >= $2',
    [share.token, cutoff]
  );
  res.json({
    visitors: (recent || []).map(v => ({
      nickname: v.nickname,
      user_id: v.user_id,
      is_registered: !!v.user_id,
      last_visit_at: v.last_visit_at,
      visit_count: v.visit_count
    })),
    total: Number(totalRow && totalRow.cnt || 0),
    online_30min: Number(onlineRow && onlineRow.cnt || 0)
  });
}));

app.get('/s/:token', wrap(async (req, res) => {
  const share = await db.one('SELECT expire_at FROM shares WHERE token = $1', [req.params.token]);
  if (!share) return res.status(404).send('<h1>链接不存在或已被撤销</h1>');
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).send('<h1>链接已过期</h1>');
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
}));

/* ---------- 统一错误处理 ---------- */
app.use((err, req, res, next) => {
  console.error('未处理错误:', err.message);
  if (process.env.NODE_ENV !== 'production') {
    res.status(500).json({ error: err.message || '服务器内部错误' });
  } else {
    res.status(500).json({ error: '服务器内部错误' });
  }
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
