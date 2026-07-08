// 知著 PenMark 鉴权模块
// 使用 Node 内置 crypto：scrypt 哈希密码 + HMAC-SHA256 签发 token
// 无需任何外部依赖
const crypto = require('crypto');
const db = require('./db');

const SECRET = process.env.PENMARK_SECRET || 'penmark-default-secret-change-me-in-production-2026';
const TOKEN_EXPIRE_DAYS = 90; // 长期免登录

/* ---------- 用户表 ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

/* ---------- 文档表增加 user_id 列（数据隔离） ---------- */
try {
  const cols = db.prepare("PRAGMA table_info(documents)").all();
  if (!cols.some(c => c.name === 'user_id')) {
    db.exec("ALTER TABLE documents ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
    db.exec("CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, updated_at DESC)");
  }
} catch (e) {
  console.warn('documents.user_id 迁移跳过：', e.message);
}

/* ---------- 自动初始化管理员账号 ---------- */
function seedAdmin() {
  const ADMIN_PHONE = '18818601864';
  const ADMIN_PASSWORD = '210210';
  const exists = db.prepare('SELECT id FROM users WHERE phone = ?').get(ADMIN_PHONE);
  if (!exists) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(ADMIN_PASSWORD, salt);
    db.prepare(
      'INSERT INTO users (phone, password_hash, password_salt, is_admin, created_at) VALUES (?, ?, ?, 1, ?)'
    ).run(ADMIN_PHONE, hash, salt, Date.now());
    console.log('已初始化管理员账号：' + ADMIN_PHONE);
  }
}
seedAdmin();

/* ---------- 密码哈希（scrypt） ---------- */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, salt, hash) {
  const computed = hashPassword(password, salt);
  // 常时间比较，防侧信道
  if (computed.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
}

/* ---------- Token 签发与校验（HMAC-SHA256 签名的 base64 载荷） ---------- */
function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function signToken(payload) {
  const body = base64UrlEncode(JSON.stringify({
    uid: payload.uid,
    admin: payload.admin ? 1 : 0,
    iat: Date.now(),
    exp: Date.now() + TOKEN_EXPIRE_DAYS * 24 * 3600 * 1000
  }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return body + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(body).toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

/* ---------- 登录 / 注册 ---------- */
function login(phone, password) {
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) return { ok: false, error: '账号不存在' };
  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    return { ok: false, error: '密码错误' };
  }
  const token = signToken({ uid: user.id, admin: !!user.is_admin });
  return { ok: true, token, user: { id: user.id, phone: user.phone, isAdmin: !!user.is_admin } };
}

function register(phone, password) {
  const exists = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (exists) return { ok: false, error: '该手机号已注册' };
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const info = db.prepare(
    'INSERT INTO users (phone, password_hash, password_salt, is_admin, created_at) VALUES (?, ?, ?, 0, ?)'
  ).run(phone, hash, salt, Date.now());
  const token = signToken({ uid: info.lastInsertRowid, admin: false });
  return { ok: true, token, user: { id: info.lastInsertRowid, phone, isAdmin: false } };
}

function getUserById(id) {
  const u = db.prepare('SELECT id, phone, is_admin FROM users WHERE id = ?').get(id);
  if (!u) return null;
  return { id: u.id, phone: u.phone, isAdmin: !!u.is_admin };
}

/* ---------- Express 中间件：从 cookie 解析 token ---------- */
const COOKIE_NAME = 'penmark_token';

function authMiddleware(req, res, next) {
  const token = readCookie(req, COOKIE_NAME);
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: 'unauthorized', needLogin: true });
  }
  req.user = { id: payload.uid, isAdmin: !!payload.admin };
  next();
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

function setCookie(res, token) {
  const maxAge = TOKEN_EXPIRE_DAYS * 24 * 3600;
  // HttpOnly 防 XSS 偷取；SameSite=Lax 防多数 CSRF；Max-Age 长期
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

module.exports = {
  login, register, getUserById, verifyToken,
  authMiddleware, setCookie, clearCookie,
  COOKIE_NAME, TOKEN_EXPIRE_DAYS
};
