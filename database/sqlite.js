// SQLite 数据层 — 包装 better-sqlite3，提供与 postgres.js 相同的异步接口
// 业务代码统一使用 $1, $2 风格占位符，本模块负责转换为 ?
// 使用 db.js 导出的 Database 对象，避免重复初始化和表结构不一致
const dbModule = require('../db');

function getDb() {
  return dbModule; // db.js 导出的就是 Database 对象
}

/* ---------- 将 $1, $2 占位符转换为 ? ---------- */
function convertPlaceholders(sql) {
  let idx = 0;
  return sql.replace(/\$(\d+)/g, () => '?');
}

/* ---------- 查询返回行数组 ---------- */
async function query(sql, params) {
  const db = getDb();
  const converted = convertPlaceholders(sql);
  return db.prepare(converted).all(...(params || []));
}

/* ---------- 查询返回单行或 null ---------- */
async function one(sql, params) {
  const db = getDb();
  const converted = convertPlaceholders(sql);
  return db.prepare(converted).get(...(params || [])) || null;
}

/* ---------- 执行写操作，返回 { changes, insertId } ---------- */
async function execute(sql, params) {
  const db = getDb();
  const converted = convertPlaceholders(sql);
  const info = db.prepare(converted).run(...(params || []));
  return { changes: info.changes, insertId: info.lastInsertRowid ? Number(info.lastInsertRowid) : null };
}

/* ---------- 事务 ---------- */
// fn 接收一个具有 query/one/execute 方法的对象
// 使用 better-sqlite3 的同步事务，但包装为 Promise
async function transaction(fn) {
  const db = getDb();
  const txClient = {
    async query(sql, params) {
      const converted = convertPlaceholders(sql);
      return db.prepare(converted).all(...(params || []));
    },
    async one(sql, params) {
      const converted = convertPlaceholders(sql);
      return db.prepare(converted).get(...(params || [])) || null;
    },
    async execute(sql, params) {
      const converted = convertPlaceholders(sql);
      const info = db.prepare(converted).run(...(params || []));
      return { changes: info.changes, insertId: info.lastInsertRowid ? Number(info.lastInsertRowid) : null };
    }
  };
  // better-sqlite3 事务是同步的，但 fn 是异步的
  // 使用 BEGIN/COMMIT/ROLLBACK 手动控制以支持异步 fn
  db.exec('BEGIN');
  try {
    const result = await fn(txClient);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

/* ---------- 健康检查 ---------- */
async function health() {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------- 验证连接 ---------- */
async function verifyConnection() {
  const db = getDb();
  const r = db.prepare('SELECT sqlite_version() AS v').get();
  return 'SQLite ' + r.v;
}

/* ---------- 关闭 ---------- */
async function close() {
  try {
    dbModule.close();
  } catch (_) { /* 可能已关闭 */ }
}

/* ---------- 是否可用（SQLite 始终可用） ---------- */
function isConfigured() {
  return true;
}

/* ---------- 暴露原始 db 对象（供迁移模块使用） ---------- */
function raw() {
  return getDb();
}

module.exports = {
  query, one, execute, transaction,
  health, verifyConnection, close, isConfigured,
  raw, getDb
};
