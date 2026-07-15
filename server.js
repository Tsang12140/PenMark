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
const HOST = process.env.PENMARK_HOST || '0.0.0.0';

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
function isPrivateHost(hostname) {
  const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '169.254.169.254', 'metadata.google.internal'];
  if (blocked.includes(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (hostname === '0.0.0.0') return true;
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

app.get('/api/proxy-image', wrap(async (req, res) => {
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
const ogCache = new Map();
function fetchOG(url, depth) {
  depth = depth || 0;
  if (depth > 3) return Promise.reject(new Error('重定向过多'));
  if (ogCache.has(url)) {
    const c = ogCache.get(url);
    if (Date.now() - c.t < 3600000) return Promise.resolve(c.data);
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
        ogCache.set(url, { t: Date.now(), data: meta });
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

app.get('/api/og', wrap(async (req, res) => {
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
  const folderId = req.body.folder_id || null;
  const title = String(req.body.title || '无标题').slice(0, 500);
  const content = String(req.body.content || '');
  const info = await db.execute(
    'INSERT INTO documents (title, content, created_at, updated_at, user_id, folder_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [title, content, now, now, req.user.id, folderId]
  );
  res.json({ id: info.insertId });
}));

app.put('/api/documents/:id', wrap(async (req, res) => {
  const now = Date.now();
  const title = String(req.body.title || '').slice(0, 500);
  const content = String(req.body.content || '');
  const info = await db.execute(
    'UPDATE documents SET title = $1, content = $2, updated_at = $3 WHERE id = $4 AND user_id = $5',
    [title, content, now, req.params.id, req.user.id]
  );
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  if (req.body.folder_id !== undefined) {
    const fid = req.body.folder_id === 0 || req.body.folder_id === null ? null : req.body.folder_id;
    await db.execute('UPDATE documents SET folder_id = $1 WHERE id = $2 AND user_id = $3', [fid, req.params.id, req.user.id]);
  }
  // 异步敏感词检查（不阻塞保存）
  setImmediate(async () => {
    try {
      const sensitiveWords = await db.query('SELECT word FROM sensitive_words');
      if (sensitiveWords.length > 0) {
        const contentLower = (String(title || '') + ' ' + String(content || '')).toLowerCase();
        const matched = sensitiveWords.some(w => contentLower.includes(w.word.toLowerCase()));
        if (matched) {
          await db.execute('UPDATE documents SET flagged = 1, flag_reason = $1 WHERE id = $2 AND flagged = 0', ['命中敏感词', req.params.id]);
        }
      }
    } catch (e) { console.warn('敏感词检查跳过：', e.message); }
  });
  res.json({ updated: info.changes });
}));

app.post('/api/documents/:id/move', wrap(async (req, res) => {
  const raw = req.body.folder_id;
  const fid = (raw === 0 || raw === null || raw === undefined || raw === '') ? null : Number(raw);
  if (fid !== null && !Number.isInteger(fid)) return res.status(400).json({ error: '无效的文件夹ID' });
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
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|src)=(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]+)/gi, '');
}

app.get('/api/ai/status', (req, res) => {
  res.json({ configured: ai.configured(), model: process.env.AI_MODEL || 'deepseek-chat' });
});

app.post('/api/ai/layout', wrap(async (req, res) => {
  try {
    const rawHtml = String(req.body && req.body.html || '');
    const preset = String(req.body && req.body.preset || 'share');
    if (!rawHtml.trim()) return res.status(400).json({ error: 'empty html' });
    const protectedInput = protectAiAssets(rawHtml);
    if (protectedInput.html.length > Number(process.env.AI_LAYOUT_MAX_INPUT || 120000)) {
      return res.status(413).json({ error: 'document is too large for one AI layout request' });
    }
    const aiHtml = await ai.layoutHtml(protectedInput.html, preset);
    const restoredHtml = sanitizeAiHtmlFragment(restoreAiAssets(aiHtml, protectedInput.assets));
    const beforeText = normalizeVisibleText(stripHtml(rawHtml));
    const afterText = normalizeVisibleText(stripHtml(restoredHtml));
    res.json({ html: restoredHtml, textUnchanged: beforeText === afterText, beforeChars: beforeText.length, afterChars: afterText.length });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}));

app.post('/api/ai/rewrite-selection', wrap(async (req, res) => {
  try {
    const selectedText = String(req.body && req.body.selectedText || '');
    const instruction = String(req.body && req.body.instruction || '');
    const contextText = String(req.body && req.body.contextText || '').slice(0, Number(process.env.AI_CONTEXT_MAX_CHARS || 24000));
    if (!selectedText.trim()) return res.status(400).json({ error: 'empty selection' });
    const replacement = await ai.rewriteSelection(selectedText, instruction, contextText);
    res.json({ replacement });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
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
  const updates = [];
  const values = [];
  let idx = 1;
  if (is_banned !== undefined) { updates.push(`is_banned = $${idx++}`); values.push(is_banned ? 1 : 0); }
  if (can_share !== undefined) { updates.push(`can_share = $${idx++}`); values.push(can_share ? 1 : 0); }
  if (admin_note !== undefined) { updates.push(`admin_note = $${idx++}`); values.push(admin_note); }
  if (updates.length === 0) return res.json({ ok: true });
  values.push(req.params.id);
  const info = await db.execute(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, values);
  if (info.changes === 0) return res.status(404).json({ error: '用户不存在' });
  // 封禁用户时撤销所有会话
  if (is_banned) await auth.revokeAllUserSessions(Number(req.params.id));
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
  const info = await db.execute("DELETE FROM documents WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  if (info.changes === 0) return res.status(404).json({ error: '文档不存在' });
  res.json({ ok: true });
}));

/* ---------- 举报 ---------- */
app.post('/api/reports', wrap(async (req, res) => {
  const { doc_id, reason } = req.body;
  if (!doc_id) return res.status(400).json({ error: '缺少文档ID' });
  await db.execute("INSERT INTO reports (doc_id, reporter_id, reason, created_at) VALUES ($1, $2, $3, $4)", [doc_id, req.user.id, reason || '', Date.now()]);
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
  const doc = await db.one('SELECT id, title, content, updated_at, created_at FROM documents WHERE id = $1 AND deleted_at IS NULL', [share.doc_id]);
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
  const info = await db.execute('UPDATE documents SET title = $1, content = $2, updated_at = $3 WHERE id = $4 AND deleted_at IS NULL',
    [String(req.body.title || '无标题'), String(req.body.content || ''), now, share.doc_id]);
  if (info.changes === 0) return res.status(404).json({ error: '文档不存在' });
  res.json({ updated: info.changes });
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
      console.log(`知著 PenMark 运行于 http://${display}:${actualPort}`);
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
