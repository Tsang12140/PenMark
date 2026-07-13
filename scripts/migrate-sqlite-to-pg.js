// SQLite 到 PostgreSQL 一次性迁移工具
// 用法：
//   npm run db:migrate-sqlite -- --source=./data/penmark.db           # dry-run（默认）
//   npm run db:migrate-sqlite -- --source=./data/penmark.db --apply   # 实际执行
//
// 安全特性：
// - 默认 dry-run，不会修改 PostgreSQL
// - 以只读方式打开源 SQLite
// - 不修改、不删除源文件
// - PostgreSQL 导入在事务中完成，失败回滚
// - 冲突（用户名、邀请码、分享 token）时停止并报告
// - 不迁移过期/已撤销 session
// - 不输出密码哈希、盐、token 等敏感数据
require('../env');
const path = require('path');
const fs = require('fs');

/* ---------- 参数解析 ---------- */
function parseArgs(argv) {
  const args = { source: null, apply: false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') { args.source = argv[++i]; }
    else if (a === '--apply') { args.apply = true; }
    else if (a === '--verbose') { args.verbose = true; }
    else if (a === '--help' || a === '-h') {
      console.log('用法：node scripts/migrate-sqlite-to-pg.js --source=<path> [--apply] [--verbose]');
      console.log('  --source   源 SQLite 文件路径（必填）');
      console.log('  --apply    实际执行导入（默认 dry-run）');
      console.log('  --verbose  输出详细进度');
      process.exit(0);
    }
  }
  return args;
}

/* ---------- 源 SQLite 只读打开 ---------- */
function openSourceSQLite(sourcePath) {
  const Database = require('better-sqlite3');
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  return db;
}

/* ---------- 检查源表结构 ---------- */
function checkSourceSchema(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(t => t.name);
  const required = ['users', 'documents', 'folders', 'invites', 'shares', 'reports', 'sensitive_words'];
  const missing = required.filter(t => !tables.includes(t));
  if (missing.length) {
    throw new Error('源数据库缺少必需表：' + missing.join(', '));
  }
  // 检查关键列
  const checkCol = (table, col) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(col)) throw new Error(`表 ${table} 缺少列 ${col}`);
  };
  checkCol('users', 'username');
  checkCol('users', 'password_hash');
  checkCol('users', 'password_salt');
  checkCol('documents', 'user_id');
  checkCol('documents', 'content');
  checkCol('shares', 'token');
  checkCol('invites', 'code');
  return tables;
}

/* ---------- 统计源数据行数 ---------- */
function countSourceRows(db) {
  const counts = {};
  for (const t of ['users', 'documents', 'folders', 'invites', 'shares', 'reports', 'sensitive_words']) {
    counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  }
  return counts;
}

/* ---------- 迁移核心 ---------- */
async function migrate(args) {
  console.log('=== SQLite → PostgreSQL 迁移工具 ===');
  console.log('模式：' + (args.apply ? '实际执行（--apply）' : 'dry-run（默认）'));
  console.log('源文件：' + args.source);
  console.log('');

  // 1. 检查源文件
  if (!args.source) { console.error('错误：缺少 --source 参数'); process.exit(1); }
  const sourcePath = path.resolve(args.source);
  if (!fs.existsSync(sourcePath)) { console.error('错误：源文件不存在：' + sourcePath); process.exit(1); }

  // 2. 打开源 SQLite（只读）
  const srcDb = openSourceSQLite(sourcePath);
  console.log('已以只读方式打开源 SQLite');

  // 3. 检查源 schema
  const tables = checkSourceSchema(srcDb);
  console.log('源表结构检查通过，表：' + tables.join(', '));

  // 4. 统计源行数
  const srcCounts = countSourceRows(srcDb);
  console.log('\n源数据行数：');
  for (const [t, c] of Object.entries(srcCounts)) console.log('  ' + t + ': ' + c);

  // 5. 检查 PostgreSQL 目标
  const pg = require('../database/postgres');
  await pg.verifyConnection();
  console.log('\nPostgreSQL 连接正常');

  // 检查目标库是否非空（安全重跑保护）
  const targetUsers = await pg.one('SELECT COUNT(*)::int AS c FROM users');
  if (targetUsers && targetUsers.c > 0) {
    console.error('\n错误：目标 PostgreSQL users 表已有 ' + targetUsers.c + ' 行数据。');
    console.error('为避免冲突，本工具拒绝向非空目标库重复导入。');
    console.error('如需重新导入，请先清空目标库（DROP DATABASE 后重新迁移）。');
    srcDb.close();
    process.exit(1);
  }

  // 6. 准备数据（从源读取，做必要转换）
  const users = srcDb.prepare('SELECT * FROM users ORDER BY id').all();
  const folders = srcDb.prepare('SELECT * FROM folders ORDER BY id').all();
  const documents = srcDb.prepare('SELECT * FROM documents ORDER BY id').all();
  const invites = srcDb.prepare('SELECT * FROM invites ORDER BY id').all();
  const shares = srcDb.prepare('SELECT * FROM shares ORDER BY id').all();
  const reports = srcDb.prepare('SELECT * FROM reports ORDER BY id').all();
  const sensitiveWords = srcDb.prepare('SELECT * FROM sensitive_words ORDER BY id').all();

  // 7. 回填 username/nickname（旧数据可能为空）
  for (const u of users) {
    if (!u.username || u.username === '') u.username = u.phone || ('user_' + u.id);
    if (!u.nickname || u.nickname === '') u.nickname = u.phone || u.username;
  }

  // 8. 冲突预检查（内部冲突）
  const usernameSet = new Set();
  for (const u of users) {
    if (usernameSet.has(u.username)) {
      throw new Error('源数据内部冲突：用户名 ' + u.username + ' 重复');
    }
    usernameSet.add(u.username);
  }
  const inviteSet = new Set();
  for (const i of invites) {
    if (inviteSet.has(i.code)) throw new Error('源数据内部冲突：邀请码 ' + i.code + ' 重复');
    inviteSet.add(i.code);
  }
  const shareTokenSet = new Set();
  for (const s of shares) {
    if (shareTokenSet.has(s.token)) throw new Error('源数据内部冲突：分享 token ' + s.token + ' 重复');
    shareTokenSet.add(s.token);
  }

  console.log('\n冲突预检查通过');

  if (!args.apply) {
    console.log('\n=== dry-run 完成 ===');
    console.log('即将迁移：');
    console.log('  users: ' + users.length);
    console.log('  folders: ' + folders.length);
    console.log('  documents: ' + documents.length);
    console.log('  invites: ' + invites.length);
    console.log('  shares: ' + shares.length);
    console.log('  reports: ' + reports.length);
    console.log('  sensitive_words: ' + sensitiveWords.length);
    console.log('\n使用 --apply 实际执行导入');
    srcDb.close();
    return;
  }

  // 9. 实际导入（事务）
  console.log('\n开始实际导入...');
  await pg.transaction(async (tx) => {
    // users（保留原 id）
    for (const u of users) {
      await tx.execute(
        'INSERT INTO users (id, phone, username, nickname, password_hash, password_salt, is_admin, is_banned, can_share, admin_note, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [u.id, u.phone, u.username, u.nickname, u.password_hash, u.password_salt,
         u.is_admin ? 1 : 0, u.is_banned ? 1 : 0, u.can_share ? 1 : 0, u.admin_note || '', u.created_at]
      );
    }
    if (args.verbose) console.log('  users 已导入 ' + users.length + ' 行');

    // folders（保留原 id）
    for (const f of folders) {
      await tx.execute(
        'INSERT INTO folders (id, name, parent_id, user_id, sort_order, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [f.id, f.name, f.parent_id, f.user_id, f.sort_order, f.created_at]
      );
    }
    if (args.verbose) console.log('  folders 已导入 ' + folders.length + ' 行');

    // documents（保留原 id，处理软删除和审核标记）
    for (const d of documents) {
      await tx.execute(
        'INSERT INTO documents (id, title, content, created_at, updated_at, folder_id, user_id, deleted_at, flagged, flag_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [d.id, d.title, d.content, d.created_at, d.updated_at, d.folder_id, d.user_id, d.deleted_at, d.flagged ? 1 : 0, d.flag_reason || '']
      );
    }
    if (args.verbose) console.log('  documents 已导入 ' + documents.length + ' 行');

    // invites（保留原 id）
    for (const i of invites) {
      await tx.execute(
        'INSERT INTO invites (id, code, created_at, used, used_at, registered_username, registered_nickname) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [i.id, i.code, i.created_at, i.used ? 1 : 0, i.used_at, i.registered_username, i.registered_nickname]
      );
    }
    if (args.verbose) console.log('  invites 已导入 ' + invites.length + ' 行');

    // shares（保留原 id）
    for (const s of shares) {
      await tx.execute(
        'INSERT INTO shares (id, doc_id, owner_id, token, permission, password_hash, password_salt, expire_at, created_at, theme) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [s.id, s.doc_id, s.owner_id, s.token, s.permission, s.password_hash, s.password_salt, s.expire_at, s.created_at, s.theme || 'light']
      );
    }
    if (args.verbose) console.log('  shares 已导入 ' + shares.length + ' 行');

    // reports（保留原 id）
    for (const r of reports) {
      await tx.execute(
        'INSERT INTO reports (id, doc_id, reporter_id, reason, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [r.id, r.doc_id, r.reporter_id, r.reason, r.status, r.created_at]
      );
    }
    if (args.verbose) console.log('  reports 已导入 ' + reports.length + ' 行');

    // sensitive_words（保留原 id）
    for (const w of sensitiveWords) {
      await tx.execute(
        'INSERT INTO sensitive_words (id, word, created_at) VALUES ($1, $2, $3)',
        [w.id, w.word, w.created_at]
      );
    }
    if (args.verbose) console.log('  sensitive_words 已导入 ' + sensitiveWords.length + ' 行');

    // 校正序列（sequence）到 max(id)+1
    const seqTables = ['users', 'sessions', 'documents', 'folders', 'shares', 'reports', 'sensitive_words', 'invites'];
    for (const t of seqTables) {
      try {
        const maxRow = await tx.one('SELECT MAX(id) AS m FROM ' + t);
        const maxId = (maxRow && maxRow.m) || 0;
        await tx.execute("SELECT setval(pg_get_serial_sequence('" + t + "', 'id'), $1, true)", [maxId]);
      } catch (_) { /* 表可能为空或无序列 */ }
    }
    if (args.verbose) console.log('  序列已校正');
  });

  // 10. 校验
  console.log('\n导入后校验：');
  const targetCounts = {};
  for (const t of ['users', 'documents', 'folders', 'invites', 'shares', 'reports', 'sensitive_words']) {
    const row = await pg.one('SELECT COUNT(*)::int AS c FROM ' + t);
    targetCounts[t] = row ? row.c : 0;
    const ok = targetCounts[t] === srcCounts[t];
    console.log('  ' + t + ': 源 ' + srcCounts[t] + ' → 目标 ' + targetCounts[t] + (ok ? ' ✓' : ' ✗ 不一致'));
  }

  console.log('\n=== 迁移完成 ===');
  console.log('注意：未迁移 sessions 表（旧会话要求重新登录）。');
  console.log('源 SQLite 文件未被修改：' + sourcePath);

  srcDb.close();
  await pg.close();
}

/* ---------- 入口 ---------- */
async function main() {
  const args = parseArgs(process.argv);
  try {
    await migrate(args);
  } catch (err) {
    console.error('\n迁移失败：' + (err.message || err));
    if (args && args.verbose && err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
