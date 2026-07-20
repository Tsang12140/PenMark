// PostgreSQL 数据层 — 使用 pg 驱动，连接池，异步接口
// 业务代码统一使用 $1, $2 风格占位符
const { Pool } = require('pg');
const crypto = require('crypto');

let pool = null;
let _connected = false;

/* ---------- 连接池初始化 ---------- */
function getPool() {
  if (pool) return pool;
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    throw new Error('缺少 DATABASE_URL 环境变量，网页生产模式必须配置 PostgreSQL 连接');
  }
  const sslConfig = parseSslConfig();
  const poolConfig = {
    connectionString: connStr,
    max: parseInt(process.env.PGPOOL_MAX || '10', 10),
    idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || '5000', 10),
  };
  if (sslConfig) poolConfig.ssl = sslConfig;
  pool = new Pool(poolConfig);

  // 监听池级错误（空闲客户端出错）
  pool.on('error', (err) => {
    console.error('PostgreSQL 连接池错误:', err.message);
  });

  return pool;
}

/* ---------- SSL 配置解析 ---------- */
function parseSslConfig() {
  const raw = process.env.PGSSL;
  if (!raw || raw === 'false' || raw === '0') return undefined;
  if (raw === 'true' || raw === '1') return { rejectUnauthorized: true };
  // 特殊值：disable 表示不验证证书（仅用于开发，不推荐生产）
  if (raw === 'disable') return { rejectUnauthorized: false };
  // 默认启用 SSL 并验证证书
  return { rejectUnauthorized: true };
}

/* ---------- 将 $1, $2 占位符转换为 pg 的 $1, $2（pg 原生支持） ---------- */
// pg 原生使用 $1, $2，所以无需转换

/* ---------- BIGINT → Number 类型解析 ---------- */
// PostgreSQL BIGINT 默认返回字符串，这里转为 Number（时间戳在安全范围内）
// BIGINT OID = 20, NUMERIC OID = 1700
try {
  const { types } = require('pg');
  types.setTypeParser(20, (val) => (val === null ? null : Number(val)));
  types.setTypeParser(1700, (val) => (val === null ? null : Number(val)));
} catch (_) { /* pg 版本差异，忽略 */ }

/* ---------- 核心查询接口 ---------- */

// 查询返回行数组
async function query(sql, params) {
  const p = getPool();
  const result = await p.query(sql, params || []);
  return result.rows;
}

// 查询返回单行或 null
async function one(sql, params) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

// 执行写操作，返回 { changes, insertId }
// 对于 INSERT，自动添加 RETURNING id 以获取新 ID
async function execute(sql, params) {
  const p = getPool();
  const trimmed = sql.trim();
  const isInsert = /^insert/i.test(trimmed);
  let finalSql = sql;
  if (isInsert && !/returning/i.test(trimmed)) {
    finalSql = sql.replace(/;\s*$/, '') + ' RETURNING id';
  }
  const result = await p.query(finalSql, params || []);
  let insertId = null;
  if (isInsert && result.rows.length > 0 && result.rows[0].id != null) {
    insertId = Number(result.rows[0].id);
  }
  return { changes: result.rowCount || 0, insertId };
}

/* ---------- 事务 ---------- */
// fn 接收一个 client 对象，具有 query/one/execute 方法
// 异常时自动 rollback，成功时 commit
async function transaction(fn) {
  const p = getPool();
  const client = await p.connect();
  const txClient = {
    async query(sql, params) {
      const r = await client.query(sql, params || []);
      return r.rows;
    },
    async one(sql, params) {
      const r = await client.query(sql, params || []);
      return r.rows.length > 0 ? r.rows[0] : null;
    },
    async execute(sql, params) {
      const trimmed = sql.trim();
      const isInsert = /^insert/i.test(trimmed);
      let finalSql = sql;
      if (isInsert && !/returning/i.test(trimmed)) {
        finalSql = sql.replace(/;\s*$/, '') + ' RETURNING id';
      }
      const r = await client.query(finalSql, params || []);
      let insertId = null;
      if (isInsert && r.rows.length > 0 && r.rows[0].id != null) {
        insertId = Number(r.rows[0].id);
      }
      return { changes: r.rowCount || 0, insertId };
    }
  };
  try {
    await client.query('BEGIN');
    const result = await fn(txClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {
      console.warn('PostgreSQL ROLLBACK 失败:', e && e.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/* ---------- 健康检查 ---------- */
async function health() {
  try {
    const p = getPool();
    const r = await p.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------- 验证连接（启动时） ---------- */
async function verifyConnection() {
  const p = getPool();
  const r = await p.query('SELECT version()');
  _connected = true;
  return r.rows[0].version;
}

/* ---------- 关闭连接池 ---------- */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
    _connected = false;
  }
}

/* ---------- 判断是否可用 ---------- */
function isConfigured() {
  return !!process.env.DATABASE_URL;
}

module.exports = {
  query, one, execute, transaction,
  health, verifyConnection, close, isConfigured,
  getPool
};
