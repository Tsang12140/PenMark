// 知著 PenMark 管理员 CLI 工具
// 用法：
//   npm run admin:create           创建第一个管理员
//   npm run admin:reset-password   重置管理员密码
//
// 安全说明：
// - 密码通过 readline 隐藏输入，不会回显到终端
// - 不会在日志中输出明文密码
// - 创建管理员使用 UPSERT，并发安全
require('../env');
const crypto = require('crypto');
const readline = require('readline');

const db = require('../database');

/* ---------- 隐藏输入读取密码 ---------- */
function readPassword(prompt) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });
    // 隐藏输入：覆盖 output 写入
    const writeOrig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = function (chunk) {
      if (chunk === '\r\n' || chunk === '\n' || chunk === '\r') {
        writeOrig(chunk);
      } else {
        // 不回显密码字符
      }
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function readLine(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function validatePassword(pwd) {
  if (!pwd) return '密码不能为空';
  if (pwd.length < 6 || pwd.length > 16) return '密码须为 6-16 位';
  return null;
}

function validateUsername(name) {
  if (!name) return '用户名不能为空';
  if (!/^[A-Za-z0-9_]{4,20}$/.test(name)) return '用户名须为 4-20 位字母、数字或下划线';
  return null;
}

/* ---------- 创建管理员 ---------- */
async function createAdmin() {
  console.log('=== 创建管理员账号 ===\n');
  const username = await readLine('管理员用户名（4-20 位字母/数字/下划线）: ');
  const uErr = validateUsername(username);
  if (uErr) { console.error('错误：' + uErr); process.exit(1); }

  // 用户名大小写不敏感：Admin / admin 视作同一账号
  const existing = await db.one('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  if (existing) {
    console.error('错误：用户名已存在。如需重置密码请使用 npm run admin:reset-password');
    process.exit(1);
  }

  const password = await readPassword('设置密码（6-16 位，输入不可见）: ');
  const pErr = validatePassword(password);
  if (pErr) { console.error('错误：' + pErr); process.exit(1); }

  const password2 = await readPassword('再次输入密码: ');
  if (password !== password2) {
    console.error('错误：两次输入的密码不一致');
    process.exit(1);
  }

  const nickname = await readLine('昵称（可选，回车使用默认"管理员"）: ') || '管理员';

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);

  await db.execute(
    'INSERT INTO users (phone, username, nickname, password_hash, password_salt, is_admin, created_at) VALUES ($1, $2, $3, $4, $5, 1, $6)',
    [username, username, nickname, hash, salt, Date.now()]
  );

  console.log('\n成功：管理员账号 ' + username + ' 已创建。');
  await db.close();
}

/* ---------- 重置管理员密码 ---------- */
async function resetPassword() {
  console.log('=== 重置管理员密码 ===\n');
  const username = await readLine('管理员用户名: ');

  // 用户名大小写不敏感
  const user = await db.one('SELECT id, username, nickname FROM users WHERE LOWER(username) = LOWER($1) AND is_admin = 1', [username]);
  if (!user) {
    console.error('错误：未找到该管理员账号');
    process.exit(1);
  }

  console.log('找到管理员：' + user.nickname + ' (' + user.username + ')');
  const password = await readPassword('新密码（6-16 位，输入不可见）: ');
  const pErr = validatePassword(password);
  if (pErr) { console.error('错误：' + pErr); process.exit(1); }

  const password2 = await readPassword('再次输入新密码: ');
  if (password !== password2) {
    console.error('错误：两次输入的密码不一致');
    process.exit(1);
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);

  await db.execute(
    'UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3',
    [hash, salt, user.id]
  );

  // 撤销该管理员所有已有会话
  try {
    const auth = require('../auth');
    await auth.revokeAllUserSessions(user.id);
  } catch (_) { /* sessions 表可能不存在 */ }

  console.log('\n成功：管理员 ' + username + ' 的密码已重置，已有会话已全部撤销。');
  await db.close();
}

/* ---------- 入口 ---------- */
async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === 'create') {
      await createAdmin();
    } else if (cmd === 'reset-password') {
      await resetPassword();
    } else {
      console.log('用法：');
      console.log('  node scripts/admin-cli.js create           创建第一个管理员');
      console.log('  node scripts/admin-cli.js reset-password   重置管理员密码');
      process.exit(1);
    }
  } catch (err) {
    console.error('失败：' + (err.message || err));
    process.exit(1);
  }
}

main();
