// 知著 PenMark 服务端
// Express + SQLite，提供鉴权与文档 CRUD/搜索，托管前端单页应用
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
const invites = require('./invites');

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
  invites.markUsed(String(invite_code).trim(), r.user.username, r.user.nickname);
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

/* ---------- 文档 CRUD（按 user_id 隔离） ---------- */

// 列表（不含正文，避免传输过大）
app.get('/api/documents', (req, res) => {
  const rows = db.prepare(
    'SELECT id, title, folder_id, created_at, updated_at FROM documents WHERE user_id = ? ORDER BY updated_at DESC'
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
  const info = db.prepare(
    'INSERT INTO documents (title, content, created_at, updated_at, user_id, folder_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.body.title || '无标题', req.body.content || '', now, now, req.user.id, folderId);
  res.json({ id: info.lastInsertRowid });
});

// 更新（content/title 走主路径；folder_id 单独处理，0 表示移到根）
app.put('/api/documents/:id', (req, res) => {
  const now = Date.now();
  const info = db.prepare(
    'UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ? AND user_id = ?'
  ).run(req.body.title, req.body.content, now, req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  if (req.body.folder_id !== undefined) {
    const fid = req.body.folder_id === 0 || req.body.folder_id === null ? null : req.body.folder_id;
    db.prepare('UPDATE documents SET folder_id = ? WHERE id = ? AND user_id = ?')
      .run(fid, req.params.id, req.user.id);
  }
  res.json({ updated: info.changes });
});

// 仅移动文档到文件夹（不触碰 content，避免前端拖拽时丢失正文）
app.post('/api/documents/:id/move', (req, res) => {
  const fid = req.body.folder_id === 0 || req.body.folder_id === null || req.body.folder_id === undefined
    ? null : req.body.folder_id;
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
  const stmt = db.prepare('UPDATE folders SET sort_order = ? WHERE id = ? AND user_id = ?');
  const tx = db.transaction(() => {
    ids.forEach((id, i) => stmt.run(i, id, req.user.id));
  });
  tx();
  res.json({ updated: ids.length });
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

/* ---------- 分享管理（仅管理员） ---------- */
// 查询某文档的分享设置
app.get('/api/documents/:id/share', (req, res) => {
  const row = db.prepare(
    'SELECT token, permission, password_hash IS NOT NULL AS has_password, expire_at, created_at FROM shares WHERE doc_id = ? AND owner_id = ?'
  ).get(req.params.id, req.user.id);
  if (!row) return res.json({ share: null });
  res.json({ share: { ...row, url: '/s/' + row.token } });
});

// 创建/更新分享（仅管理员，支持部分更新：只传需要改的字段）
app.post('/api/documents/:id/share', auth.adminOnly, (req, res) => {
  const docId = Number(req.params.id);
  const doc = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(docId, req.user.id);
  if (!doc) return res.status(404).json({ error: '文档不存在' });

  const existing = db.prepare('SELECT id, token, permission, password_hash, password_salt, expire_at FROM shares WHERE doc_id = ? AND owner_id = ?').get(docId, req.user.id);

  // 部分更新：未传的字段保持原值
  const permission = req.body.permission !== undefined
    ? (req.body.permission === 'edit' ? 'edit' : 'view')
    : (existing ? existing.permission : 'view');

  let passwordHash = existing ? existing.password_hash : null;
  let passwordSalt = existing ? existing.password_salt : null;
  if (req.body.password !== undefined) {
    const pwd = String(req.body.password);
    if (pwd) {
      if (!/^[A-Za-z0-9]{4}$/.test(pwd)) return res.status(400).json({ error: '密码须为4位字母或数字' });
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

  let token;
  if (existing) {
    token = existing.token;
    db.prepare('UPDATE shares SET permission = ?, password_hash = ?, password_salt = ?, expire_at = ? WHERE id = ?')
      .run(permission, passwordHash, passwordSalt, expireAt, existing.id);
  } else {
    let attempts = 0;
    do {
      token = auth.generateShareToken();
      attempts++;
    } while (db.prepare('SELECT id FROM shares WHERE token = ?').get(token) && attempts < 10);
    if (!token) return res.status(500).json({ error: 'token 生成失败，请重试' });
    db.prepare(
      'INSERT INTO shares (doc_id, owner_id, token, permission, password_hash, password_salt, expire_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(docId, req.user.id, token, permission, passwordHash, passwordSalt, expireAt, Date.now());
  }
  res.json({ token, permission, has_password: !!passwordHash, expire_at: expireAt, url: '/s/' + token });
});

// 撤销分享（仅管理员）
app.delete('/api/documents/:id/share', auth.adminOnly, (req, res) => {
  const info = db.prepare('DELETE FROM shares WHERE doc_id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  res.json({ deleted: info.changes });
});

/* ---------- 公开访问（无需登录） ---------- */
// 分享元信息（前端用于决定是否弹密码框）
app.get('/api/public/share/:token/info', (req, res) => {
  const share = db.prepare(
    'SELECT permission, password_hash IS NOT NULL AS has_password, expire_at FROM shares WHERE token = ?'
  ).get(req.params.token);
  if (!share) return res.status(404).json({ error: '链接无效' });
  if (share.expire_at && share.expire_at < Date.now()) return res.status(410).json({ error: '链接已过期' });
  res.json({
    permission: share.permission,
    has_password: !!share.has_password,
    can_edit: share.permission === 'edit'
  });
});

// 提交密码校验，换取分享 session
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
  const password = String(req.body.password || '');
  if (!auth.verifyPassword(password, share.password_salt, share.password_hash)) {
    return res.status(401).json({ error: '密码错误' });
  }
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
