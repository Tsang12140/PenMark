// 知著 PenMark 鉴权模块
// 使用 Node 内置 crypto：scrypt 哈希密码 + HMAC-SHA256 签发 token
// 无需任何外部依赖
require('./env'); // 加载 .env 到 process.env
const crypto = require('crypto');
const db = require('./db');

const SECRET = process.env.PENMARK_SECRET || 'penmark-default-secret-change-me-in-production-2026';
const TOKEN_EXPIRE_DAYS = 90; // 长期免登录
const DESKTOP_COOKIE_NAME = 'penmark_desktop_session';

/* ---------- 用户表 ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT,
  username TEXT,
  nickname TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

/* ---------- 用户表增量迁移：phone → username/nickname ---------- */
try {
  const cols = db.prepare("PRAGMA table_info(users)").all();
  if (!cols.some(c => c.name === 'username')) {
    db.exec("ALTER TABLE users ADD COLUMN username TEXT");
  }
  if (!cols.some(c => c.name === 'nickname')) {
    db.exec("ALTER TABLE users ADD COLUMN nickname TEXT");
  }
  // 回填：管理员用环境变量配置，普通用户用 phone 作为 username/nickname
  const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
  const ADMIN_NICKNAME = process.env.ADMIN_NICKNAME || '管理员';
  db.prepare("UPDATE users SET username = ?, nickname = ? WHERE is_admin = 1 AND (username IS NULL OR username = '')")
    .run(ADMIN_USERNAME, ADMIN_NICKNAME);
  db.prepare("UPDATE users SET username = phone WHERE is_admin = 0 AND (username IS NULL OR username = '')").run();
  db.prepare("UPDATE users SET nickname = phone WHERE nickname IS NULL OR nickname = ''").run();
  // 唯一索引（忽略 NULL，但回填后无 NULL）
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)");
} catch (e) {
  console.warn('users 迁移跳过：', e.message);
}

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

/* ---------- 桌面本地用户（桌面模式专用，不要求登录） ---------- */
let _desktopUser = null;
function ensureDesktopUser() {
  if (_desktopUser) return _desktopUser;
  let u = db.prepare('SELECT id, username, nickname, is_admin FROM users WHERE username = ?').get('desktop');
  if (!u) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(crypto.randomBytes(32).toString('hex'), salt); // 随机密码，无人能登录
    const info = db.prepare(
      'INSERT INTO users (phone, username, nickname, password_hash, password_salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).run('desktop', 'desktop', '本地用户', hash, salt, Date.now());
    u = { id: info.lastInsertRowid, username: 'desktop', nickname: '本地用户', is_admin: 1 };
    console.log('已创建桌面本地用户');
  }
  _desktopUser = { id: u.id, username: u.username, nickname: u.nickname, isAdmin: !!u.is_admin };
  return _desktopUser;
}

/* ---------- 自动初始化/同步管理员账号（从 .env 读取） ---------- */
function seedAdmin() {
  // 桌面模式：创建本地用户，不走 .env 管理员逻辑
  if (process.env.PENMARK_DESKTOP === '1') {
    ensureDesktopUser();
    return;
  }
  const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
  const ADMIN_NICKNAME = process.env.ADMIN_NICKNAME || '管理员';
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD === 'change-me') {
    console.warn('警告：未在 .env 设置 ADMIN_PASSWORD，请尽快配置');
  }
  const existing = db.prepare('SELECT id, password_hash, password_salt FROM users WHERE is_admin = 1').get();
  if (!existing) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(ADMIN_PASSWORD, salt);
    db.prepare(
      'INSERT INTO users (phone, username, nickname, password_hash, password_salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).run(ADMIN_USERNAME, ADMIN_USERNAME, ADMIN_NICKNAME, hash, salt, Date.now());
    console.log('已初始化管理员账号：' + ADMIN_USERNAME);
  } else {
    // 同步用户名/昵称，并在密码变化时更新（用新盐+哈希覆盖）
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(ADMIN_PASSWORD, salt);
    db.prepare('UPDATE users SET username = ?, nickname = ?, password_hash = ?, password_salt = ? WHERE id = ?')
      .run(ADMIN_USERNAME, ADMIN_NICKNAME, hash, salt, existing.id);
    console.log('已同步管理员配置：' + ADMIN_USERNAME);
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

/* ---------- 输入校验 ---------- */
function validateUsername(username) {
  if (!username) return '用户名不能为空';
  if (!/^[A-Za-z0-9_]{4,20}$/.test(username)) return '用户名须为 4-20 位字母、数字或下划线';
  return null;
}
function validateNickname(nickname) {
  if (!nickname) return '昵称不能为空';
  const trimmed = String(nickname).trim();
  if (trimmed.length < 2 || trimmed.length > 20) return '昵称须为 2-20 个字符';
  return null;
}
function validatePassword(password) {
  if (!password) return '密码不能为空';
  if (String(password).length < 6 || String(password).length > 16) return '密码须为 6-16 位';
  return null;
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
function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return { ok: false, error: '账号不存在' };
  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    return { ok: false, error: '密码错误' };
  }
  const token = signToken({ uid: user.id, admin: !!user.is_admin });
  return { ok: true, token, user: publicUser(user) };
}

// 注册：调用方需先用 invites.consume 校验邀请码
function register(username, nickname, password, inviteRecord) {
  const uErr = validateUsername(username);
  if (uErr) return { ok: false, error: uErr };
  const nErr = validateNickname(nickname);
  if (nErr) return { ok: false, error: nErr };
  const pErr = validatePassword(password);
  if (pErr) return { ok: false, error: pErr };
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return { ok: false, error: '该用户名已存在' };
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const info = db.prepare(
    'INSERT INTO users (phone, username, nickname, password_hash, password_salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(username, username, nickname.trim(), hash, salt, Date.now());
  const token = signToken({ uid: info.lastInsertRowid, admin: false });
  return { ok: true, token, user: { id: info.lastInsertRowid, username, nickname: nickname.trim(), isAdmin: false } };
}

function publicUser(u) {
  return { id: u.id, username: u.username, nickname: u.nickname, isAdmin: !!u.is_admin, is_banned: !!u.is_banned, can_share: !!u.can_share };
}

function getUserById(id) {
  const u = db.prepare('SELECT id, username, nickname, is_admin, is_banned, can_share FROM users WHERE id = ?').get(id);
  if (!u) return null;
  return publicUser(u);
}

function isDesktopRequestAuthorized(req) {
  if (process.env.PENMARK_DESKTOP !== '1') return false;
  const expected = process.env.PENMARK_DESKTOP_TOKEN || '';
  const actual = readCookie(req, DESKTOP_COOKIE_NAME) || '';
  if (!expected || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
/* ---------- Express 中间件：从 cookie 解析 token ---------- */
const COOKIE_NAME = 'penmark_token';

function authMiddleware(req, res, next) {
  const token = readCookie(req, COOKIE_NAME);
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    // 桌面模式：自动以本地用户身份通过，不要求登录
    if (isDesktopRequestAuthorized(req)) {
      const u = ensureDesktopUser();
      req.user = u;
      return next();
    }
    return res.status(401).json({ error: 'unauthorized', needLogin: true });
  }
  const user = getUserById(payload.uid);
  if (!user) {
    clearCookie(res);
    return res.status(401).json({ error: 'need login', needLogin: true });
  }
  // 检查是否被禁用
  if (user.is_banned) {
    clearCookie(res);
    return res.status(403).json({ error: '账号已被禁用', banned: true });
  }
  req.user = user;
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

/* ---------- 分享 session（公开访问用，独立 cookie） ---------- */
const SHARE_COOKIE_NAME = 'penmark_share_token';
const SHARE_SESSION_EXPIRE_DAYS = 7;

function generateShareToken() {
  // 8 位 base64url 短码；碰撞由数据库 UNIQUE 约束兜底，调用方重试
  return crypto.randomBytes(6).toString('base64url');
}

function signShareSession(payload) {
  const body = base64UrlEncode(JSON.stringify({
    token: payload.token,
    authed: payload.authed ? 1 : 0,
    iat: Date.now(),
    exp: Date.now() + SHARE_SESSION_EXPIRE_DAYS * 24 * 3600 * 1000
  }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return body + '.' + sig;
}

function verifyShareSession(ss) {
  if (!ss || typeof ss !== 'string') return null;
  const parts = ss.split('.');
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

function setShareCookie(res, ss) {
  const maxAge = SHARE_SESSION_EXPIRE_DAYS * 24 * 3600;
  res.setHeader('Set-Cookie', SHARE_COOKIE_NAME + '=' + encodeURIComponent(ss) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge);
}
function clearShareCookie(res) {
  res.setHeader('Set-Cookie', SHARE_COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function readShareCookie(req) {
  return readCookie(req, SHARE_COOKIE_NAME);
}

/* ---------- 仅管理员中间件 ---------- */
function adminOnly(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: '需要管理员权限' });
  next();
}

module.exports = {
  login, register, getUserById, verifyToken,
  authMiddleware, setCookie, clearCookie,
  COOKIE_NAME, TOKEN_EXPIRE_DAYS,
  validateUsername, validateNickname, validatePassword,
  ensureDesktopUser, isDesktopRequestAuthorized, DESKTOP_COOKIE_NAME,
  // 分享相关
  generateShareToken, signShareSession, verifyShareSession,
  setShareCookie, clearShareCookie, readShareCookie,
  SHARE_COOKIE_NAME, adminOnly, hashPassword, verifyPassword
};
