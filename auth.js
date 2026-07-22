// 知著 PenMark 鉴权模块（异步版）
// 使用 Node 内置 crypto：scrypt 哈希密码 + 服务端持久会话
// 网页版：sessions 表存储 token 哈希；桌面版：桌面 Cookie 免登录
require('./env');
const crypto = require('crypto');
const db = require('./database');

const SECRET = process.env.PENMARK_SECRET || 'penmark-default-secret-change-me-in-production-2026';
const SESSION_EXPIRE_DAYS = 90;
const COOKIE_NAME = 'penmark_session';
const DESKTOP_COOKIE_NAME = 'penmark_desktop_session';

/* ---------- 密码哈希（scrypt，同步） ---------- */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, salt, hash) {
  const computed = hashPassword(password, salt);
  if (computed.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
}

/* ---------- 输入校验（同步） ---------- */
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

/* ---------- 服务端持久会话 ---------- */
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex'); // 256 bit
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession(userId, req) {
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const now = Date.now();
  const expiresAt = now + SESSION_EXPIRE_DAYS * 24 * 3600 * 1000;
  const ua = (req && req.headers['user-agent'] || '').slice(0, 500);
  const ip = (req && req.ip || '').slice(0, 100);
  await db.execute(
    'INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen_at, user_agent, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [userId, tokenHash, now, expiresAt, now, ua, ip]
  );
  return token;
}

async function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = hashToken(token);
  const now = Date.now();
  const session = await db.one(
    'SELECT s.id, s.user_id, s.expires_at, s.revoked_at FROM sessions s WHERE s.token_hash = $1',
    [tokenHash]
  );
  if (!session) return null;
  if (session.revoked_at) return null;
  if (session.expires_at < now) return null;
  // 查询用户，检查封禁
  const user = await db.one(
    'SELECT id, username, nickname, is_admin, is_banned, can_share, avatar FROM users WHERE id = $1',
    [session.user_id]
  );
  if (!user) return null;
  if (user.is_banned) {
    // 自动撤销被封禁用户的会话
    await db.execute('UPDATE sessions SET revoked_at = $1 WHERE id = $2', [now, session.id]);
    return null;
  }
  // 更新 last_seen_at（不阻塞，错误记录但不影响业务）
  db.execute('UPDATE sessions SET last_seen_at = $1 WHERE id = $2', [now, session.id])
    .catch(e => console.warn('更新 last_seen_at 失败:', e && e.message));
  return publicUser(user);
}

async function revokeSession(token) {
  if (!token) return;
  const tokenHash = hashToken(token);
  await db.execute('UPDATE sessions SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL', [Date.now(), tokenHash]);
}

async function revokeAllUserSessions(userId) {
  await db.execute('UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL', [Date.now(), userId]);
}

async function cleanExpiredSessions() {
  try {
    await db.execute('DELETE FROM sessions WHERE expires_at < $1 OR revoked_at IS NOT NULL', [Date.now()]);
  } catch (e) {
    console.warn('清理过期会话失败:', e && e.message);
  }
}

/* ---------- 用户公开信息 ---------- */
function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    isAdmin: !!u.is_admin,
    is_banned: !!u.is_banned,
    can_share: !!u.can_share,
    avatar: u.avatar || ''
  };
}

async function getUserById(id) {
  const u = await db.one('SELECT id, username, nickname, is_admin, is_banned, can_share, avatar FROM users WHERE id = $1', [id]);
  if (!u) return null;
  return publicUser(u);
}

/* ---------- 登录 ---------- */
async function login(username, password, req) {
  // 用户名大小写不敏感：admin / Admin / ADMIN 都能登录同一个账号
  const user = await db.one('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [String(username).trim()]);
  if (!user) return { ok: false, error: '账号不存在' };
  if (user.is_banned) return { ok: false, error: '账号已被禁用' };
  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    return { ok: false, error: '密码错误' };
  }
  const token = await createSession(user.id, req);
  return { ok: true, token, user: publicUser(user) };
}

/* ---------- 注册（事务化，含邀请码原子消费） ---------- */
async function register(username, nickname, password, inviteCode, req) {
  const uErr = validateUsername(username);
  if (uErr) return { ok: false, error: uErr };
  const nErr = validateNickname(nickname);
  if (nErr) return { ok: false, error: nErr };
  const pErr = validatePassword(password);
  if (pErr) return { ok: false, error: pErr };

  const trimmedUsername = String(username).trim();
  const trimmedNickname = String(nickname).trim();
  const trimmedCode = String(inviteCode).trim();

  try {
    const result = await db.transaction(async (tx) => {
      // 1. 原子消费邀请码（条件 UPDATE，行级锁）
      const inviteInfo = await tx.execute(
        'UPDATE invites SET used = 1, used_at = $1, registered_username = $2, registered_nickname = $3 WHERE code = $4 AND used = 0',
        [Date.now(), trimmedUsername, trimmedNickname, trimmedCode]
      );
      if (inviteInfo.changes === 0) {
        throw new Error('INVITE_INVALID');
      }

      // 2. 检查用户名唯一（大小写不敏感：Admin / admin 视作同一账号）
      const existing = await tx.one('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [trimmedUsername]);
      if (existing) throw new Error('USERNAME_EXISTS');

      // 3. 创建用户
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = hashPassword(password, salt);
      const userInfo = await tx.execute(
        'INSERT INTO users (phone, username, nickname, password_hash, password_salt, is_admin, created_at) VALUES ($1, $2, $3, $4, $5, 0, $6)',
        [trimmedUsername, trimmedUsername, trimmedNickname, hash, salt, Date.now()]
      );

      return { id: userInfo.insertId, username: trimmedUsername, nickname: trimmedNickname };
    });

    // 4. 事务成功后创建会话（会话不回滚注册）
    const token = await createSession(result.id, req);
    return { ok: true, token, user: { id: result.id, username: result.username, nickname: result.nickname, isAdmin: false } };
  } catch (err) {
    if (err.message === 'INVITE_INVALID') return { ok: false, error: '邀请码无效或已被使用' };
    if (err.message === 'USERNAME_EXISTS') return { ok: false, error: '该用户名已存在' };
    throw err; // 其他错误向上抛
  }
}

/* ---------- 桌面本地用户 ---------- */
let _desktopUser = null;
async function ensureDesktopUser() {
  if (_desktopUser) return _desktopUser;
  let u = await db.one('SELECT id, username, nickname, is_admin, avatar FROM users WHERE LOWER(username) = LOWER($1)', ['desktop']);
  if (!u) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(crypto.randomBytes(32).toString('hex'), salt);
    const info = await db.execute(
      'INSERT INTO users (phone, username, nickname, password_hash, password_salt, is_admin, created_at) VALUES ($1, $2, $3, $4, $5, 1, $6)',
      ['desktop', 'desktop', '本地用户', hash, salt, Date.now()]
    );
    u = { id: info.insertId, username: 'desktop', nickname: '本地用户', is_admin: 1, avatar: '' };
    console.log('已创建桌面本地用户');
  }
  _desktopUser = { id: u.id, username: u.username, nickname: u.nickname, isAdmin: !!u.is_admin, avatar: u.avatar || '' };
  return _desktopUser;
}

function isDesktopRequestAuthorized(req) {
  if (process.env.PENMARK_DESKTOP !== '1') return false;
  const expected = process.env.PENMARK_DESKTOP_TOKEN || '';
  const actual = readCookie(req, DESKTOP_COOKIE_NAME) || '';
  if (!expected || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

// 头像/昵称等修改后，让桌面用户缓存失效，下次调用重新查库
function invalidateDesktopUserCache() {
  _desktopUser = null;
}

/* ---------- 生产配置校验：拒绝使用默认密钥启动 ---------- */
const INSECURE_SECRET_DEFAULTS = new Set([
  'penmark-default-secret-change-me-in-production-2026',
  'penmark-please-change-this-secret-to-a-long-random-string',
  'change-me'
]);
const INSECURE_ADMIN_PASSWORD_DEFAULTS = new Set([
  'change-me',
  'change-me-please',
  'admin'
]);

function validateProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.PENMARK_DESKTOP === '1') {
    // 桌面模式不需要外置密钥（运行时随机生成）
    return;
  }
  const secret = process.env.PENMARK_SECRET;
  if (!secret || INSECURE_SECRET_DEFAULTS.has(secret) || secret.length < 32) {
    throw new Error('生产模式必须设置 PENMARK_SECRET 环境变量（长度至少 32 字符，且不能使用默认值）');
  }
  const adminPwd = process.env.ADMIN_PASSWORD;
  if (!adminPwd || INSECURE_ADMIN_PASSWORD_DEFAULTS.has(adminPwd)) {
    throw new Error('生产模式必须设置 ADMIN_PASSWORD 环境变量（不能使用默认值 change-me，可改用 npm run admin:create 创建后再删除该变量）');
  }
}

/* ---------- 管理员初始化（不再每次启动覆盖密码） ---------- */
async function seedAdmin() {
  // 桌面模式：创建本地用户，不走 .env 管理员逻辑
  if (process.env.PENMARK_DESKTOP === '1') {
    await ensureDesktopUser();
    return;
  }
  // 网页模式：只在不存在管理员时创建，不覆盖已有管理员
  const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
  const ADMIN_NICKNAME = process.env.ADMIN_NICKNAME || '管理员';
  const existing = await db.one('SELECT id FROM users WHERE is_admin = 1');
  if (!existing) {
    if (!ADMIN_PASSWORD || ADMIN_PASSWORD === 'change-me') {
      console.warn('警告：未在 .env 设置 ADMIN_PASSWORD，请尽快配置或使用 npm run admin:create');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(ADMIN_PASSWORD, salt);
    await db.execute(
      'INSERT INTO users (phone, username, nickname, password_hash, password_salt, is_admin, created_at) VALUES ($1, $2, $3, $4, $5, 1, $6)',
      [ADMIN_USERNAME, ADMIN_USERNAME, ADMIN_NICKNAME, hash, salt, Date.now()]
    );
    console.log('已初始化管理员账号：' + ADMIN_USERNAME);
  } else {
    // 管理员已存在，不覆盖密码
    console.log('管理员账号已存在，跳过初始化。如需重置密码请使用 npm run admin:reset-password');
  }
}

// 启动时执行配置校验 + 初始化（返回 Promise 供 server.js await）
validateProductionConfig();
const ready = seedAdmin().catch(err => {
  console.error('管理员初始化失败:', err.message);
  // 不阻止启动，允许后续手动创建
});

// 定期清理过期会话
const sessionCleanupTimer = setInterval(() => {
  cleanExpiredSessions().catch(e => console.warn('清理过期会话失败:', e && e.message));
}, 3600 * 1000);
if (sessionCleanupTimer.unref) sessionCleanupTimer.unref();

/* ---------- Cookie 处理 ---------- */
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

function isSecure(req) {
  // 生产 HTTPS 环境设置 Secure
  if (process.env.NODE_ENV !== 'production') return false;
  // 检查 X-Forwarded-Proto（Nginx 反向代理）
  const xfp = req.headers['x-forwarded-proto'];
  return xfp === 'https' || (req.socket && req.socket.encrypted);
}

function setCookie(res, token, req) {
  const maxAge = SESSION_EXPIRE_DAYS * 24 * 3600;
  const secure = isSecure(req);
  let cookie = COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
  if (secure) cookie += '; Secure';
  res.setHeader('Set-Cookie', cookie);
}

function clearCookie(res, req) {
  const secure = req ? isSecure(req) : false;
  let cookie = COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  if (secure) cookie += '; Secure';
  res.setHeader('Set-Cookie', cookie);
}

/* ---------- Express 中间件 ---------- */
async function authMiddleware(req, res, next) {
  // 桌面模式：检查桌面 Cookie
  if (process.env.PENMARK_DESKTOP === '1') {
    if (isDesktopRequestAuthorized(req)) {
      try {
        req.user = await ensureDesktopUser();
      } catch (e) {
        return res.status(500).json({ error: '桌面用户初始化失败' });
      }
      return next();
    }
    return res.status(401).json({ error: 'unauthorized', needLogin: false, desktop: true });
  }
  // 网页模式：检查服务端会话
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return res.status(401).json({ error: 'unauthorized', needLogin: true });
  const user = await verifySession(token);
  if (!user) {
    clearCookie(res, req);
    return res.status(401).json({ error: 'unauthorized', needLogin: true });
  }
  req.user = user;
  req.sessionToken = token;
  next();
}

function adminOnly(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: '需要管理员权限' });
  next();
}

/* ---------- 分享 session（公开访问用，独立 cookie） ---------- */
const SHARE_COOKIE_NAME = 'penmark_share_token';
const SHARE_SESSION_EXPIRE_DAYS = 7;

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function generateShareToken() {
  // 96 位熵（12 字节）：避免短 token 被穷举
  return crypto.randomBytes(12).toString('base64url');
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

module.exports = {
  login, register, getUserById,
  verifySession, revokeSession, revokeAllUserSessions, cleanExpiredSessions,
  authMiddleware, setCookie, clearCookie,
  COOKIE_NAME, SESSION_EXPIRE_DAYS, DESKTOP_COOKIE_NAME,
  validateUsername, validateNickname, validatePassword,
  ensureDesktopUser, isDesktopRequestAuthorized, invalidateDesktopUserCache,
  ready, seedAdmin,
  adminOnly, hashPassword, verifyPassword, publicUser,
  // 分享相关
  generateShareToken, signShareSession, verifyShareSession,
  setShareCookie, clearShareCookie, readShareCookie,
  SHARE_COOKIE_NAME, readCookie
};
