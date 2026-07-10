// 知著 PenMark 服务端
// Express + SQLite，提供鉴权与文档 CRUD/搜索，托管前端单页应用
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const db = require('./db');
const auth = require('./auth');
const invites = require('./invites');
const ai = require('./ai');

const app = express();
const PORT = process.env.PORT || 3001;

// 允许大体积富文本（图片 base64 内嵌会很大）
app.use(express.json({ limit: '100mb' }));

// 托管静态资源（含登录页 login.html）
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- 鉴权路由 ---------- */
// 登录
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const r = auth.login(String(username).trim(), String(password));
  if (!r.ok) return res.status(401).json({ error: r.error });
  auth.setCookie(res, r.token);
  res.json({ user: r.user });
});

// 注册（需邀请码）
app.post('/api/auth/register', (req, res) => {
  const { username, nickname, password, invite_code } = req.body || {};
  if (!username || !nickname || !password || !invite_code) {
    return res.status(400).json({ error: '请填写完整信息' });
  }
  // 先校验输入格式
  const uErr = auth.validateUsername(String(username).trim());
  if (uErr) return res.status(400).json({ error: uErr });
  const nErr = auth.validateNickname(String(nickname).trim());
  if (nErr) return res.status(400).json({ error: nErr });
  const pErr = auth.validatePassword(String(password));
  if (pErr) return res.status(400).json({ error: pErr });
  // 校验邀请码
  const inv = invites.validate(String(invite_code).trim());
  if (!inv.ok) return res.status(400).json({ error: inv.error });
  // 注册用户
  const r = auth.register(String(username).trim(), String(nickname).trim(), String(password), inv.record);
  if (!r.ok) return res.status(409).json({ error: r.error });
  // 标记邀请码已使用
  const marked = invites.markUsed(String(invite_code).trim(), r.user.username, r.user.nickname);
  if (!marked) {
    // 竞态：邀请码已被另一个请求抢先使用，回滚注册
    db.prepare('DELETE FROM users WHERE id = ?').run(r.user.id);
    auth.clearCookie(res);
    return res.status(409).json({ error: '邀请码已被使用' });
  }
  auth.setCookie(res, r.token);
  res.json({ user: r.user });
});

// 当前用户
app.get('/api/auth/me', (req, res) => {
  const token = readCookieRaw(req, auth.COOKIE_NAME);
  const payload = token ? auth.verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: 'unauthorized' });
  const u = auth.getUserById(payload.uid);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: u });
});

// 退出
app.post('/api/auth/logout', (req, res) => {
  auth.clearCookie(res);
  res.json({ ok: true });
});

/* ---------- 以下 API 需要登录 ---------- */
app.use('/api', (req, res, next) => {
  // 鉴权路由与公开路由已处理，放行
  if (req.path.startsWith('/auth/')) return next();
  if (req.path.startsWith('/public/')) return next();
  auth.authMiddleware(req, res, next);
});

/* ---------- 防 SSRF：拦截内网地址 ---------- */
function isPrivateHost(hostname) {
  // 直接匹配内网域名
  const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '169.254.169.254', 'metadata.google.internal'];
  if (blocked.includes(hostname)) return true;
  // 匹配内网 IP 段：10.x, 172.16-31.x, 192.168.x
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (hostname === '0.0.0.0') return true;
  return false;
}

/* ---------- 远程图片代理（粘贴公众号/企微图时转 base64 固化，绕 CORS） ---------- */
function fetchImageAsBase64(url, maxRedirects, cb) {
  if (maxRedirects < 0) { cb(new Error('too many redirects')); return; }
  let parsed;
  try { parsed = new URL(url); } catch (_) { cb(new Error('invalid url')); return; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { cb(new Error('bad protocol')); return; }
  if (isPrivateHost(parsed.hostname)) { cb(new Error('blocked host')); return; }
  const lib = parsed.protocol === 'https:' ? https : http;
  const req = lib.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
    const MAX = 15 * 1024 * 1024; // 15MB
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

app.get('/api/proxy-image', (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'invalid url' });
  }
  fetchImageAsBase64(url, 4, (err, dataUrl, ct, size) => {
    if (err) {
      res.status(502).json({ error: err.message });
      return;
    }
    res.json({ dataUrl, contentType: ct, size });
  });
});

/* ---------- 邀请码管理（仅管理员） ---------- */
app.get('/api/invites', auth.adminOnly, (req, res) => {
  res.json(invites.list());
});

app.post('/api/invites', auth.adminOnly, (req, res) => {
  const count = req.body.count || 1;
  const created = invites.generateBatch(count);
  res.json(created);
});

app.delete('/api/invites/:code', auth.adminOnly, (req, res) => {
  const ok = invites.remove(req.params.code);
  if (!ok) return res.status(400).json({ error: '无法删除（不存在或已被使用）' });
  res.json({ deleted: true });
});

/* ---------- 链接卡片元数据抓取（编辑时用，需登录） ---------- */
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
    url,
    title: (title || domain).slice(0, 200),
    description: desc.slice(0, 300),
    image: resolveAsset(image) || fallbackIcon,
    domain
  };
}
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

app.get('/api/og', (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: '缺少 url' });
  fetchOG(url).then(meta => res.json(meta)).catch(e => res.status(502).json({ error: '抓取失败：' + (e.message || e) }));
});

/* ---------- 文档 CRUD（按 user_id 隔离） ---------- */

// 列表（不含正文，避免传输过大；排除已软删除）
app.get('/api/documents', (req, res) => {
  const rows = db.prepare(
    'SELECT id, title, folder_id, created_at, updated_at FROM documents WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC'
  ).all(req.user.id);
  res.json(rows);
});

// 详情
app.get('/api/documents/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// 新建
app.post('/api/documents', (req, res) => {
  const now = Date.now();
  const folderId = req.body.folder_id || null;
  const title = String(req.body.title || '无标题').slice(0, 500);
  const content = String(req.body.content || '');
  const info = db.prepare(
    'INSERT INTO documents (title, content, created_at, updated_at, user_id, folder_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, content, now, now, req.user.id, folderId);
  res.json({ id: info.lastInsertRowid });
});

// 更新（content/title 走主路径；folder_id 单独处理，0 表示移到根）
app.put('/api/documents/:id', (req, res) => {
  const now = Date.now();
  const title = String(req.body.title || '').slice(0, 500);
  const content = String(req.body.content || '');
  const info = db.prepare(
    'UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).run(title, content, now, req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  if (req.body.folder_id !== undefined) {
    const fid = req.body.folder_id === 0 || req.body.folder_id === null ? null : req.body.folder_id;
    db.prepare('UPDATE documents SET folder_id = ? WHERE id = ? AND user_id = ?')
      .run(fid, req.params.id, req.user.id);
  }
  // 异步关键词检查（不阻塞保存，响应先返回）
  setImmediate(() => {
    try {
      const sensitiveWords = db.prepare("SELECT word FROM sensitive_words").all().map(w => w.word);
      if (sensitiveWords.length > 0) {
        const contentLower = (String(title || '') + ' ' + String(content || '')).toLowerCase();
        const matched = sensitiveWords.some(w => contentLower.includes(w.toLowerCase()));
        if (matched) {
          db.prepare("UPDATE documents SET flagged = 1, flag_reason = '命中敏感词' WHERE id = ? AND flagged = 0").run(req.params.id);
        }
      }
    } catch (e) { console.warn('敏感词检查跳过：', e.message); }
  });
  res.json({ updated: info.changes });
});

// 仅移动文档到文件夹（不触碰 content，避免前端拖拽时丢失正文）
app.post('/api/documents/:id/move', (req, res) => {
  const raw = req.body.folder_id;
  const fid = (raw === 0 || raw === null || raw === undefined || raw === '')
    ? null : Number(raw);
  if (fid !== null && !Number.isInteger(fid)) return res.status(400).json({ error: '无效的文件夹ID' });
  const info = db.prepare('UPDATE documents SET folder_id = ? WHERE id = ? AND user_id = ?')
    .run(fid, req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ updated: info.changes });
});

/* ---------- 文件夹（单层） ---------- */
app.get('/api/folders', (req, res) => {
  const rows = db.prepare(
    'SELECT f.id, f.name, f.sort_order, f.created_at, ' +
    '(SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id AND d.user_id = f.user_id) AS doc_count ' +
    'FROM folders f WHERE f.user_id = ? ORDER BY f.sort_order ASC, f.id ASC'
  ).all(req.user.id);
  res.json(rows);
});

app.post('/api/folders', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '文件夹名不能为空' });
  if (name.length > 40) return res.status(400).json({ error: '文件夹名过长' });
  const info = db.prepare(
    'INSERT INTO folders (name, user_id, sort_order, created_at) VALUES (?, ?, ?, ?)'
  ).run(name, req.user.id, Date.now(), Date.now());
  res.json({ id: info.lastInsertRowid });
});

// 排序：接收有序 id 数组（需在 :id 路由之前定义，避免 'sort' 被当成 id）
app.put('/api/folders/sort', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  try {
    const stmt = db.prepare('UPDATE folders SET sort_order = ? WHERE id = ? AND user_id = ?');
    const tx = db.transaction(() => {
      ids.forEach((id, i) => {
        const num = Number(id);
        if (!Number.isInteger(num)) throw new Error('invalid id: ' + id);
        stmt.run(i, num, req.user.id);
      });
    });
    tx();
    res.json({ updated: ids.length });
  } catch (e) {
    res.status(400).json({ error: '排序更新失败: ' + e.message });
  }
});

app.put('/api/folders/:id', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '文件夹名不能为空' });
  const info = db.prepare('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?')
    .run(name, req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ updated: info.changes });
});

app.delete('/api/folders/:id', (req, res) => {
  // 删除前把里面的文档移到根（folder_id=NULL），避免文档丢失
  db.prepare('UPDATE documents SET folder_id = NULL WHERE folder_id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  const info = db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: true });
});

// 软删除（移到回收站）
app.delete('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').run(Date.now(), req.params.id);
  res.json({ ok: true });
});

/* ---------- 搜索（按 user_id 隔离） ---------- */
function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeSnippet(text, q, len = 120) {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, len);
  const start = Math.max(0, idx - 40);
  return (start > 0 ? '…' : '') + text.slice(start, start + len) + (start + len < text.length ? '…' : '');
}


/* ---------- AI helpers (on-demand only) ---------- */
function normalizeVisibleText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, '')
    .trim();
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

app.post('/api/ai/layout', async (req, res) => {
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
    res.json({
      html: restoredHtml,
      textUnchanged: beforeText === afterText,
      beforeChars: beforeText.length,
      afterChars: afterText.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/ai/rewrite-selection', async (req, res) => {
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
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const rows = db.prepare(
    "SELECT id, title, content, updated_at FROM documents WHERE user_id = ? AND deleted_at IS NULL AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC"
  ).all(req.user.id, '%' + q + '%', '%' + q + '%');
  const result = rows.map(r => ({
    id: r.id,
    title: r.title,
    snippet: makeSnippet(stripHtml(r.content), q),
    updated_at: r.updated_at
  }));
  res.json(result);
});

/* ---------- 管理员：用户管理 ---------- */
// 获取所有用户列表
app.get('/api/admin/users', auth.adminOnly, (req, res) => {
  const users = db.prepare("SELECT id, username, nickname, is_admin, is_banned, can_share, admin_note, created_at FROM users ORDER BY created_at DESC").all();
  res.json(users);
});

// 更新用户（禁用/分享权限/备注）
app.put('/api/admin/users/:id', auth.adminOnly, (req, res) => {
  const { is_banned, can_share, admin_note } = req.body;
  const updates = [];
  const values = [];
  if (is_banned !== undefined) { updates.push('is_banned = ?'); values.push(is_banned ? 1 : 0); }
  if (can_share !== undefined) { updates.push('can_share = ?'); values.push(can_share ? 1 : 0); }
  if (admin_note !== undefined) { updates.push('admin_note = ?'); values.push(admin_note); }
  if (updates.length === 0) return res.json({ ok: true });
  values.push(req.params.id);
  const info = db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  if (info.changes === 0) return res.status(404).json({ error: '用户不存在' });
  res.json({ ok: true });
});

/* ---------- 回收站 ---------- */
// 获取回收站列表
app.get('/api/trash', (req, res) => {
  const docs = db.prepare("SELECT id, title, deleted_at, updated_at FROM documents WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC").all(req.user.id);
  res.json(docs);
});

// 恢复文档
app.post('/api/trash/:id/restore', (req, res) => {
  const doc = db.prepare("SELECT id FROM documents WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  db.prepare("UPDATE documents SET deleted_at = NULL WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// 永久删除
app.delete('/api/trash/:id', (req, res) => {
  const doc = db.prepare("SELECT id FROM documents WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  db.prepare("DELETE FROM documents WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------- 举报 ---------- */
// 创建举报
app.post('/api/reports', (req, res) => {
  const { doc_id, reason } = req.body;
  if (!doc_id) return res.status(400).json({ error: '缺少文档ID' });
  db.prepare("INSERT INTO reports (doc_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)").run(doc_id, req.user.id, reason || '', Date.now());
  res.json({ ok: true });
});

// 获取举报列表（管理员）
app.get('/api/admin/reports', auth.adminOnly, (req, res) => {
  const reports = db.prepare(`
    SELECT r.*, d.title as doc_title, d.content as doc_content, d.flagged as doc_flagged,
           u.nickname as reporter_nickname, u.username as reporter_username,
           owner.nickname as owner_nickname, owner.username as owner_username
    FROM reports r
    JOIN documents d ON r.doc_id = d.id
    JOIN users u ON r.reporter_id = u.id
    JOIN users owner ON d.user_id = owner.id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC
  `).all();
  res.json(reports);
});

// 处理举报
app.put('/api/admin/reports/:id', auth.adminOnly, (req, res) => {
  const { status } = req.body; // 'resolved' or 'dismissed'
  db.prepare("UPDATE reports SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ ok: true });
});

/* ---------- 审核面板 ---------- */
// 获取待审核/已标记文档（管理员）
app.get('/api/admin/flagged', auth.adminOnly, (req, res) => {
  const docs = db.prepare(`
    SELECT d.*, u.nickname as author_nickname, u.username as author_username, u.can_share as author_can_share
    FROM documents d
    JOIN users u ON d.user_id = u.id
    WHERE d.deleted_at IS NULL AND (d.flagged = 1 OR u.can_share = 1)
    ORDER BY d.flagged DESC, d.updated_at DESC
    LIMIT 100
  `).all();
  res.json(docs);
});

// 标记/取消标记文档
app.put('/api/admin/flagged/:id', auth.adminOnly, (req, res) => {
  const { flagged, flag_reason } = req.body;
  db.prepare("UPDATE documents SET flagged = ?, flag_reason = ? WHERE id = ?").run(flagged ? 1 : 0, flag_reason || '', req.params.id);
  res.json({ ok: true });
});

/* ---------- 敏感词管理 ---------- */
// 获取敏感词列表
app.get('/api/admin/sensitive-words', auth.adminOnly, (req, res) => {
  const words = db.prepare("SELECT * FROM sensitive_words ORDER BY created_at DESC").all();
  res.json(words);
});

// 添加敏感词
app.post('/api/admin/sensitive-words', auth.adminOnly, (req, res) => {
  const { word } = req.body;
  if (!word || !word.trim()) return res.status(400).json({ error: '敏感词不能为空' });
  try {
    db.prepare("INSERT INTO sensitive_words (word, created_at) VALUES (?, ?)").run(word.trim(), Date.now());
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: '敏感词已存在' });
  }
});

// 删除敏感词
app.delete('/api/admin/sensitive-words/:id', auth.adminOnly, (req, res) => {
  db.prepare("DELETE FROM sensitive_words WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/* ---------- Share management: admins or authorized users ---------- */
function shareAllowed(req, res, next) {
  if (req.user && (req.user.isAdmin || req.user.can_share)) return next();
  return res.status(403).json({ error: 'No share permission' });
}

// Query share settings for the current user's document
app.get('/api/documents/:id/share', (req, res) => {
  const row = db.prepare(
    'SELECT token, permission, password_hash IS NOT NULL AS has_password, expire_at, created_at, theme FROM shares WHERE doc_id = ? AND owner_id = ?'
  ).get(req.params.id, req.user.id);
  if (!row) return res.json({ share: null });
  res.json({ share: { ...row, url: '/s/' + row.token } });
});

// Create or update share settings for the current user's document
app.post('/api/documents/:id/share', shareAllowed, (req, res) => {
  const docId = Number(req.params.id);
  const doc = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(docId, req.user.id);
  if (!doc) return res.status(404).json({ error: '文档不存在' });

  const existing = db.prepare('SELECT id, token, permission, password_hash, password_salt, expire_at, theme FROM shares WHERE doc_id = ? AND owner_id = ?').get(docId, req.user.id);

  // 部分更新：未传的字段保持原值
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
    db.prepare('UPDATE shares SET permission = ?, password_hash = ?, password_salt = ?, expire_at = ?, theme = ? WHERE id = ?')
      .run(permission, passwordHash, passwordSalt, expireAt, theme, existing.id);
  } else {
    let attempts = 0;
    do {
      token = auth.generateShareToken();
      attempts++;
    } while (db.prepare('SELECT id FROM shares WHERE token = ?').get(token) && attempts < 10);
    if (!token) return res.status(500).json({ error: 'token 生成失败，请重试' });
    db.prepare(
      'INSERT INTO shares (doc_id, owner_id, token, permission, password_hash, password_salt, expire_at, created_at, theme) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(docId, req.user.id, token, permission, passwordHash, passwordSalt, expireAt, Date.now(), theme);
  }
  res.json({ token, permission, has_password: !!passwordHash, expire_at: expireAt, theme, url: '/s/' + token });
});

// Revoke share for the current user's document
app.delete('/api/documents/:id/share', shareAllowed, (req, res) => {
  const info = db.prepare('DELETE FROM shares WHERE doc_id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  res.json({ deleted: info.changes });
});

// 更新分享主题
app.put('/api/documents/:id/share/theme', shareAllowed, (req, res) => {
  const theme = String(req.body.theme || 'light');
  db.prepare('UPDATE shares SET theme = ? WHERE doc_id = ? AND owner_id = ?').run(theme, req.params.id, req.user.id);
  res.json({ ok: true });
});

/* ---------- 公开访问（无需登录） ---------- */
// 分享元信息（前端用于决定是否弹密码框）
app.get('/api/public/share/:token/info', (req, res) => {
  const share = db.prepare(
    'SELECT permission, password_hash IS NOT NULL AS has_password, expire_at, theme FROM shares WHERE token = ?'
  ).get(req.params.token);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });
  res.json({
    permission: share.permission,
    has_password: !!share.has_password,
    can_edit: share.permission === 'edit',
    theme: share.theme || 'light'
  });
});

// 提交密码校验，换取分享 session
/* ---------- 分享密码验证速率限制（防暴力破解） ---------- */
const shareRateLimit = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of shareRateLimit) { if (now > v.reset) shareRateLimit.delete(k); }
}, 60000);

app.post('/api/public/share/:token/auth', (req, res) => {
  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(req.params.token);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });
  if (!share.password_hash) {
    // 无密码直接签发已认证 session
    const ss = auth.signShareSession({ token: share.token, authed: true });
    auth.setShareCookie(res, ss);
    return res.json({ ok: true });
  }
  // 速率限制：每个 IP+token 每分钟最多 5 次尝试
  const limitKey = req.ip + ':' + req.params.token;
  let limit = shareRateLimit.get(limitKey);
  const now = Date.now();
  if (limit && limit.count >= 5 && now < limit.reset) {
    return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
  }
  if (!limit || now > limit.reset) {
    limit = { count: 0, reset: now + 60000 };
  }
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
});

// 读取文档内容（公开，按权限返回）
app.get('/api/public/share/:token/doc', (req, res) => {
  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(req.params.token);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });
  if (share.password_hash) {
    const ss = auth.verifyShareSession(auth.readShareCookie(req));
    if (!ss || !ss.authed || ss.token !== share.token) {
      return res.status(401).json({ error: 'need_password', has_password: true });
    }
  }
  const doc = db.prepare('SELECT id, title, content, updated_at, created_at FROM documents WHERE id = ?').get(share.doc_id);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  res.json({ doc, permission: share.permission, can_edit: share.permission === 'edit' });
});

// 保存修改（公开，仅 edit 权限）
app.put('/api/public/share/:token/doc', (req, res) => {
  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(req.params.token);
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
  const info = db.prepare('UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ?')
    .run(String(req.body.title || '无标题'), String(req.body.content || ''), now, share.doc_id);
  if (info.changes === 0) return res.status(404).json({ error: '文档不存在' });
  res.json({ updated: info.changes });
});

// /s/:token 入口页（返回 share.html，由前端处理密码与展示）
app.get('/s/:token', (req, res) => {
  const share = db.prepare('SELECT expire_at FROM shares WHERE token = ?').get(req.params.token);
  if (!share) return res.status(404).send('<h1>链接不存在或已被撤销</h1>');
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).send('<h1>链接已过期</h1>');
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

/* ---------- 辅助：读取 cookie（仅 /me 用） ---------- */
function readCookieRaw(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const p of header.split(';')) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    if (p.slice(0, idx).trim() === name) return decodeURIComponent(p.slice(idx + 1).trim());
  }
  return null;
}

app.listen(PORT, () => {
  console.log(`知著 PenMark 运行于 http://localhost:${PORT}`);
});
