// SQLite 数据层 — 包装 better-sqlite3，提供与 postgres.js 相同的异步接口
// 业务代码统一使用 $1, $2 风格占位符，本模块负责转换为 ?
// 使用 db.js 导出的 Database 对象，避免重复初始化和表结构不一致
const dbModule = require('../db');

function getDb() {
  return dbModule; // db.js 导出的就是 Database 对象
}

/* ---------- 将 $1, $2 占位符转换为 ? 并按数字顺序重排 params ---------- */
// SQLite 的 ? 按出现顺序绑定，而 PostgreSQL 的 $N 按数字绑定。
// 如果 SQL 中 $N 不按数字顺序出现（如 WHERE id=$2 AND user_id=$1），
// 简单替换会导致 SQLite 把第一个参数绑定给 $2（id），造成数据隔离失败。
// 这里收集 $N 出现顺序，然后按数字顺序重排 params，确保两端语义一致。
function convertPlaceholders(sql, params) {
  const order = [];
  const converted = sql.replace(/\$(\d+)/g, (_, n) => {
    order.push(Number(n));
    return '?';
  });
  if (!params || !params.length) return { sql: converted, params: [] };
  const reordered = order.map(n => params[n - 1]);
  return { sql: converted, params: reordered };
}

/* ---------- 查询返回行数组 ---------- */
async function query(sql, params) {
  const db = getDb();
  const { sql: converted, params: finalParams } = convertPlaceholders(sql, params);
  return db.prepare(converted).all(...finalParams);
}

/* ---------- 查询返回单行或 null ---------- */
async function one(sql, params) {
  const db = getDb();
  const { sql: converted, params: finalParams } = convertPlaceholders(sql, params);
  return db.prepare(converted).get(...finalParams) || null;
}

/* ---------- 执行写操作，返回 { changes, insertId } ---------- */
async function execute(sql, params) {
  const db = getDb();
  const { sql: converted, params: finalParams } = convertPlaceholders(sql, params);
  const info = db.prepare(converted).run(...finalParams);
  return { changes: info.changes, insertId: info.lastInsertRowid ? Number(info.lastInsertRowid) : null };
}

/* ---------- 事务 ---------- */
// fn 接收一个具有 query/one/execute 方法的对象
// better-sqlite3 是同步的，但 fn 是异步的；如果直接 BEGIN/await fn/COMMIT
// 期间另一请求也 BEGIN 会触发 "cannot start a transaction within a transaction"。
// 用 mutex 串行化事务，保证同一时刻只有一个事务在运行。
const _txQueue = [];
let _txLocked = false;
function _acquireTxLock() {
  return new Promise(resolve => {
    if (!_txLocked) {
      _txLocked = true;
      resolve();
    } else {
      _txQueue.push(resolve);
    }
  });
}
function _releaseTxLock() {
  const next = _txQueue.shift();
  if (next) {
    next(); // 直接传递锁给下一个等待者
  } else {
    _txLocked = false;
  }
}

async function transaction(fn) {
  const db = getDb();
  const txClient = {
    async query(sql, params) {
      const { sql: converted, params: finalParams } = convertPlaceholders(sql, params);
      return db.prepare(converted).all(...finalParams);
    },
    async one(sql, params) {
      const { sql: converted, params: finalParams } = convertPlaceholders(sql, params);
      return db.prepare(converted).get(...finalParams) || null;
    },
    async execute(sql, params) {
      const { sql: converted, params: finalParams } = convertPlaceholders(sql, params);
      const info = db.prepare(converted).run(...finalParams);
      return { changes: info.changes, insertId: info.lastInsertRowid ? Number(info.lastInsertRowid) : null };
    }
  };
  await _acquireTxLock();
  try {
    db.exec('BEGIN');
    const result = await fn(txClient);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) {
      // ROLLBACK 失败时记录日志，便于排查（不抛出以保留原始错误）
      console.warn('SQLite ROLLBACK 失败:', e && e.message);
    }
    throw err;
  } finally {
    _releaseTxLock();
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
