// 知著 PenMark schema 一致性校验
//
// 本项目在「两处」人工维护同一批表的 schema：
//   1. SQLite（桌面/开发）：根目录 db.js 用 better-sqlite3 内联 CREATE TABLE + ALTER ADD COLUMN
//   2. PostgreSQL（网页生产）：database/migrations/*.sql 迁移文件
// 两端一旦漂移（例如只在迁移里加了列、忘了改 db.js），桌面版会静默出问题。
//
// 本脚本分别推导两端「预期 schema」，逐表逐列比对，漂移即非零退出（可接 CI）。
// 用法：
//   node scripts/check-schema-sync.js
//   npm run db:check-sync
require('../env');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');

// 有意分叉、不算漂移的表：
//   schema_migrations 只存在于 Postgres（SQLite 无迁移历史机制）
//   s4_assets 是仅管理员的云端加速镜像，桌面版不启用
const PG_ONLY_TABLES = new Set(['schema_migrations', 's4_assets']);

/* ---------- 解析 PostgreSQL 迁移，推导预期 schema ---------- */

function stripComments(sql) {
  // 去掉行注释（迁移里没有字符串内 `--`，安全）
  return sql.replace(/--[^\n]*/g, '');
}

function stripDoBlocks(sql) {
  // 去掉 PL/pgSQL 的 DO $$ ... $$ 数据回填块，避免误解析其中的 ALTER/UPDATE
  return sql.replace(/DO\s*\$\$[\s\S]*?\$\$/g, '');
}

// 按「深度 0 的逗号」切分 CREATE TABLE 的列定义
function splitTopLevel(inner) {
  const parts = [];
  let depth = 0;
  let inStr = null;
  let cur = '';
  for (const ch of inner) {
    if (inStr) {
      cur += ch;
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// 表级约束（UNIQUE(share_token, fingerprint)、PRIMARY KEY (...) 等）首 token 常带括号，
// 用「关键字 + 词边界」判断，避免把约束误当成列
const CONSTRAINT_RE = /^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)\b/i;

function parsePgMigrations() {
  const schema = {}; // table -> Set<column>
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) throw new Error('未找到迁移文件：' + MIGRATIONS_DIR);

  for (const file of files) {
    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    sql = stripComments(sql);
    sql = stripDoBlocks(sql);

    // CREATE TABLE IF NOT EXISTS name ( ... )
    const createRe = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
    let m;
    while ((m = createRe.exec(sql)) !== null) {
      const name = m[1];
      const openIdx = sql.indexOf('(', m.index + m[0].length);
      if (openIdx === -1) continue;
      let depth = 0;
      let inStr = null;
      let j = openIdx;
      for (; j < sql.length; j++) {
        const ch = sql[j];
        if (inStr) { if (ch === inStr) inStr = null; continue; }
        if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) break; }
      }
      const inner = sql.slice(openIdx + 1, j);
      const cols = new Set();
      for (const def of splitTopLevel(inner)) {
        const trimmed = def.trim();
        if (!trimmed) continue;
        if (CONSTRAINT_RE.test(trimmed)) continue; // 表级约束，非列
        cols.add(trimmed.split(/\s+/)[0]);
      }
      if (!schema[name]) schema[name] = new Set();
      cols.forEach(c => schema[name].add(c));
    }

    // ALTER TABLE name ADD COLUMN [IF NOT EXISTS] col ...
    const addRe = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
    while ((m = addRe.exec(sql)) !== null) {
      const name = m[1];
      if (!schema[name]) schema[name] = new Set();
      schema[name].add(m[2]);
    }
  }
  return schema;
}

/* ---------- 读取 SQLite 预期 schema（db.js 全新初始化） ---------- */

function buildSqliteSchema() {
  // 用临时目录全新初始化 db.js，拿到 db.js 声明的完整 schema，避免被本地存量库污染
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'penmark-schema-'));
  process.env.PENMARK_DATA_DIR = tmpDir;
  const dbModule = require('../db');
  const schema = {};
  const tables = dbModule.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  for (const t of tables) {
    if (t.name.startsWith('sqlite_')) continue;
    const cols = dbModule.prepare('PRAGMA table_info(' + JSON.stringify(t.name) + ')').all();
    schema[t.name] = new Set(cols.map(c => c.name));
  }
  try { dbModule.close(); } catch (_) { /* 已关闭 */ }
  return schema;
}

/* ---------- 比对 ---------- */

function reportDrift(pgSchema, sqSchema) {
  const issues = [];
  const allTables = new Set([...Object.keys(pgSchema), ...Object.keys(sqSchema)]);

  for (const table of allTables) {
    const inPg = pgSchema[table];
    const inSq = sqSchema[table];
    if (!inPg) {
      issues.push(`[SQLite-only] 表 "${table}" 只在 db.js 里，迁移文件里没有`);
      continue;
    }
    if (!inSq) {
      if (PG_ONLY_TABLES.has(table)) continue; // 有意分叉，忽略
      issues.push(`[PG-only] 表 "${table}" 只在迁移文件里，db.js 里没有`);
      continue;
    }
    const pgOnly = [...inPg].filter(c => !inSq.has(c)).sort();
    const sqOnly = [...inSq].filter(c => !inPg.has(c)).sort();
    if (pgOnly.length) issues.push(`[列仅PG] 表 "${table}"：${pgOnly.join(', ')}`);
    if (sqOnly.length) issues.push(`[列仅SQLite] 表 "${table}"：${sqOnly.join(', ')}`);
  }
  return issues;
}

function main() {
  const pgSchema = parsePgMigrations();
  const sqSchema = buildSqliteSchema();

  const issues = reportDrift(pgSchema, sqSchema);

  console.log('=== PostgreSQL（迁移文件推导）===');
  for (const [t, cols] of Object.entries(pgSchema).sort()) console.log(`  ${t}: ${[...cols].sort().join(', ')}`);
  console.log('\n=== SQLite（db.js 推导）===');
  for (const [t, cols] of Object.entries(sqSchema).sort()) console.log(`  ${t}: ${[...cols].sort().join(', ')}`);

  console.log('\n=== 漂移报告 ===');
  if (issues.length === 0) {
    console.log('两端 schema 一致，无漂移。');
    console.log('（排除的有意分叉表：' + [...PG_ONLY_TABLES].join(', ') + '）');
    return { ok: true };
  }
  for (const issue of issues) console.log('  ' + issue);
  console.log(`\n发现 ${issues.length} 处差异。若为有意分叉，请加入脚本顶部 PG_ONLY_TABLES，否则请补齐迁移文件或 db.js。`);
  return { ok: false };
}

if (require.main === module) {
  const result = main();
  process.exit(result.ok ? 0 : 1);
}

module.exports = { parsePgMigrations, buildSqliteSchema, main };