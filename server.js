// 知著 PenMark 服务端
// Express + SQLite，提供鉴权与文档 CRUD/搜索，托管前端单页应用
const express = require('express');
const path = require('path');
const db = require('./db');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3001;

// 允许大体积富文本（图片 base64 内嵌会很大）
app.use(express.json({ limit: '100mb' }));

// 托管静态资源（含登录页 login.html）
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- 鉴权路由 ---------- */
// 登录
app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: '请输入手机号和密码' });
  const r = auth.login(String(phone).trim(), String(password));
  if (!r.ok) return res.status(401).json({ error: r.error });
  auth.setCookie(res, r.token);
  res.json({ user: r.user });
});

// 注册
app.post('/api/auth/register', (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: '请输入手机号和密码' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const r = auth.register(String(phone).trim(), String(password));
  if (!r.ok) return res.status(409).json({ error: r.error });
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
  // 鉴权路由已处理，放行
  if (req.path.startsWith('/auth/')) return next();
  auth.authMiddleware(req, res, next);
});

/* ---------- 文档 CRUD（按 user_id 隔离） ---------- */

// 列表（不含正文，避免传输过大）
app.get('/api/documents', (req, res) => {
  const rows = db.prepare(
    'SELECT id, title, created_at, updated_at FROM documents WHERE user_id = ? ORDER BY updated_at DESC'
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
  const info = db.prepare(
    'INSERT INTO documents (title, content, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)'
  ).run(req.body.title || '无标题', req.body.content || '', now, now, req.user.id);
  res.json({ id: info.lastInsertRowid });
});

// 更新
app.put('/api/documents/:id', (req, res) => {
  const now = Date.now();
  const info = db.prepare(
    'UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).run(req.body.title, req.body.content, now, req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ updated: info.changes });
});

// 删除
app.delete('/api/documents/:id', (req, res) => {
  const info = db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: true });
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

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const rows = db.prepare(
    "SELECT id, title, content, updated_at FROM documents WHERE user_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC"
  ).all(req.user.id, '%' + q + '%', '%' + q + '%');
  const result = rows.map(r => ({
    id: r.id,
    title: r.title,
    snippet: makeSnippet(stripHtml(r.content), q),
    updated_at: r.updated_at
  }));
  res.json(result);
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
