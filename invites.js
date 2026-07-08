// 知著 PenMark 邀请码管理（JSON 文件存储，无需数据库）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const INVITE_FILE = path.join(dataDir, 'invites.json');

// 邀请码字符集：去歧义（不含 0/O/1/I/l）
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const CODE_LEN = 8;

function loadAll() {
  try {
    if (!fs.existsSync(INVITE_FILE)) return [];
    const raw = fs.readFileSync(INVITE_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('邀请码文件读取失败：', e.message);
    return [];
  }
}

function saveAll(list) {
  fs.writeFileSync(INVITE_FILE, JSON.stringify(list, null, 2), 'utf8');
}

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
  const list = loadAll();
  // 防极小概率碰撞
  let code;
  do { code = generateCode(); } while (list.some(i => i.code === code));
  const record = {
    code,
    created_at: Date.now(),
    used: false,
    used_at: null,
    registered_username: null,
    registered_nickname: null
  };
  list.push(record);
  saveAll(list);
  return record;
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
  return loadAll().sort((a, b) => b.created_at - a.created_at);
}

// 校验邀请码是否可用
function validate(code) {
  if (!code) return { ok: false, error: '邀请码不能为空' };
  const list = loadAll();
  const record = list.find(i => i.code === code);
  if (!record) return { ok: false, error: '邀请码无效' };
  if (record.used) return { ok: false, error: '邀请码已被使用' };
  return { ok: true, record };
}

// 标记为已使用
function markUsed(code, username, nickname) {
  const list = loadAll();
  const record = list.find(i => i.code === code);
  if (!record) return false;
  if (record.used) return false;
  record.used = true;
  record.used_at = Date.now();
  record.registered_username = username;
  record.registered_nickname = nickname;
  saveAll(list);
  return true;
}

// 删除邀请码（仅未使用的可删）
function remove(code) {
  const list = loadAll();
  const idx = list.findIndex(i => i.code === code);
  if (idx < 0) return false;
  if (list[idx].used) return false;
  list.splice(idx, 1);
  saveAll(list);
  return true;
}

module.exports = { generate, generateBatch, list, validate, markUsed, remove };
