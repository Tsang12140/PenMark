// 数据库选择器 — 桌面版用 SQLite，网页版用 PostgreSQL
// 明确选择，不模糊回退
//
// 选择逻辑：
// 1. PENMARK_DESKTOP=1 → SQLite（桌面版，离线可用）
// 2. DATABASE_URL 存在 → PostgreSQL（网页生产/自托管）
// 3. PENMARK_DB=sqlite → 显式选择 SQLite（本地开发）
// 4. 以上都不满足 → 生产模式报错，开发模式警告并用 SQLite

// 懒加载：桌面版不需要加载 postgres.js，避免引入 pg 依赖
let _postgres = null;
let _sqlite = null;

function getPostgres() {
  if (!_postgres) _postgres = require('./postgres');
  return _postgres;
}

function getSqlite() {
  if (!_sqlite) _sqlite = require('./sqlite');
  return _sqlite;
}

let _backend = null;

function detectBackend() {
  // 桌面版始终使用 SQLite
  if (process.env.PENMARK_DESKTOP === '1') {
    return 'sqlite';
  }
  // 有 DATABASE_URL 则用 PostgreSQL
  if (process.env.DATABASE_URL) {
    return 'postgres';
  }
  // 显式指定 PENMARK_DB=sqlite（本地开发）
  if (process.env.PENMARK_DB === 'sqlite') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('生产模式不允许 PENMARK_DB=sqlite，必须设置 DATABASE_URL 使用 PostgreSQL');
    }
    console.warn('警告：未设置 DATABASE_URL，使用本地 SQLite。此模式仅适合开发，不适合生产部署。');
    return 'sqlite';
  }
  // 无配置
  if (process.env.NODE_ENV === 'production') {
    throw new Error('生产模式缺少 DATABASE_URL 环境变量。请配置 PostgreSQL 连接，或设置 PENMARK_DB=sqlite 显式选择开发模式。');
  }
  console.warn('警告：未设置 DATABASE_URL，使用本地 SQLite。此模式仅适合开发，不适合生产部署。');
  return 'sqlite';
}

function getBackend() {
  if (_backend) return _backend;
  _backend = detectBackend();
  return _backend;
}

function isPostgres() {
  return getBackend() === 'postgres';
}

function isSqlite() {
  return getBackend() === 'sqlite';
}

/* ---------- 统一接口代理 ---------- */
function getDb() {
  return isPostgres() ? getPostgres() : getSqlite();
}

async function query(sql, params) {
  return getDb().query(sql, params);
}

async function one(sql, params) {
  return getDb().one(sql, params);
}

async function execute(sql, params) {
  return getDb().execute(sql, params);
}

async function transaction(fn) {
  return getDb().transaction(fn);
}

async function health() {
  return getDb().health();
}

async function verifyConnection() {
  return getDb().verifyConnection();
}

async function close() {
  return getDb().close();
}

module.exports = {
  query, one, execute, transaction,
  health, verifyConnection, close,
  isPostgres, isSqlite, getBackend,
  // 暴露原始 SQLite 对象（仅供桌面版迁移模块使用）
  rawSqlite: () => getSqlite().raw()
};
