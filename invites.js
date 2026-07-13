// 知著 PenMark 邀请码管理（异步版）
const crypto = require('crypto');
const db = require('./database');

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

async function generate() {
  let code;
  do {
    code = generateCode();
  } while (await db.one('SELECT 1 FROM invites WHERE code = $1', [code]));
  await db.execute('INSERT INTO invites (code, created_at) VALUES ($1, $2)', [code, Date.now()]);
  return await db.one('SELECT * FROM invites WHERE code = $1', [code]);
}

async function generateBatch(count) {
  const n = Math.min(Math.max(parseInt(count, 10) || 1, 1), 50);
  const created = [];
  for (let i = 0; i < n; i++) created.push(await generate());
  return created;
}

async function list() {
  return await db.query('SELECT * FROM invites ORDER BY created_at DESC');
}

async function validate(code) {
  if (!code) return { ok: false, error: '邀请码不能为空' };
  const record = await db.one('SELECT * FROM invites WHERE code = $1', [code]);
  if (!record) return { ok: false, error: '邀请码无效' };
  if (record.used) return { ok: false, error: '邀请码已被使用' };
  return { ok: true, record };
}

// 原子标记为已使用（条件 UPDATE）
async function markUsed(code, username, nickname) {
  const info = await db.execute(
    'UPDATE invites SET used = 1, used_at = $1, registered_username = $2, registered_nickname = $3 WHERE code = $4 AND used = 0',
    [Date.now(), username, nickname, code]
  );
  return info.changes > 0;
}

async function remove(code) {
  const info = await db.execute('DELETE FROM invites WHERE code = $1 AND used = 0', [code]);
  return info.changes > 0;
}

module.exports = { generate, generateBatch, list, validate, markUsed, remove };
