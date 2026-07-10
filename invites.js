// 知著 PenMark 邀请码管理（SQLite，保证原子性和一致性）
const crypto = require('crypto');
const db = require('./db');

// 邀请码字符集：去歧义（不含 0/O/1/I/l）
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const CODE_LEN = 8;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let code = '';
  for (let i = 0; i < CODE_LEN; i++) {
    code += CHARSET[bytes[i] % CHARSET.length];
  }
  return code;
}

// 生成一个新邀请码
function generate() {
  let code;
  do { code = generateCode(); } while (db.prepare('SELECT 1 FROM invites WHERE code = ?').get(code));
  db.prepare('INSERT INTO invites (code, created_at) VALUES (?, ?)').run(code, Date.now());
  return db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
}

// 批量生成
function generateBatch(count) {
  const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 50);
  const created = [];
  for (let i = 0; i < n; i++) created.push(generate());
  return created;
}

// 列出全部（最新的在前）
function list() {
  return db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all();
}

// 校验邀请码是否可用
function validate(code) {
  if (!code) return { ok: false, error: '邀请码不能为空' };
  const record = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
  if (!record) return { ok: false, error: '邀请码无效' };
  if (record.used) return { ok: false, error: '邀请码已被使用' };
  return { ok: true, record };
}

// 原子标记为已使用（使用 SQLite 行级锁 + 条件 UPDATE）
// 返回 true 表示成功标记，false 表示已被使用或不存在
function markUsed(code, username, nickname) {
  const info = db.prepare(
    'UPDATE invites SET used = 1, used_at = ?, registered_username = ?, registered_nickname = ? WHERE code = ? AND used = 0'
  ).run(Date.now(), username, nickname, code);
  return info.changes > 0;
}

// 删除邀请码（仅未使用的可删）
function remove(code) {
  const info = db.prepare('DELETE FROM invites WHERE code = ? AND used = 0').run(code);
  return info.changes > 0;
}

module.exports = { generate, generateBatch, list, validate, markUsed, remove };
