// PostgreSQL 数据库迁移执行器
// 用法：node database/migrate.js        执行迁移
//       node database/migrate.js status  查看迁移状态
const fs = require('fs');
const path = require('path');
const pg = require('./postgres');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )
  `);
}

async function getAppliedVersions(client) {
  const result = await client.query('SELECT version FROM schema_migrations ORDER BY version ASC');
  return new Set(result.rows.map(r => r.version));
}

function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

async function migrate() {
  const pool = pg.getPool();
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedVersions(client);
    const files = getMigrationFiles();

    if (files.length === 0) {
      console.log('没有找到迁移文件');
      return { applied: 0, total: 0 };
    }

    let count = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`应用迁移: ${version}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [version, Date.now()]);
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`迁移 ${version} 失败: ${err.message}`);
      }
    }

    if (count === 0) {
      console.log('数据库已是最新，无需迁移');
    } else {
      console.log(`成功应用 ${count} 个迁移`);
    }
    return { applied: count, total: files.length };
  } finally {
    client.release();
  }
}

async function status() {
  const pool = pg.getPool();
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedVersions(client);
    const files = getMigrationFiles();

    console.log('迁移状态:');
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      const isApplied = applied.has(version);
      console.log(`  ${isApplied ? '[已应用]' : '[未应用]'} ${version}`);
    }
    return { applied: [...applied].sort(), total: files.length };
  } finally {
    client.release();
  }
}

async function main() {
  const cmd = process.argv[2] || 'run';
  try {
    if (!pg.isConfigured()) {
      console.error('错误：缺少 DATABASE_URL 环境变量');
      process.exit(1);
    }
    const version = await pg.verifyConnection();
    console.log('PostgreSQL 连接成功:', version.split(' ').slice(0, 2).join(' '));

    if (cmd === 'status') {
      await status();
    } else {
      await migrate();
    }
    await pg.close();
    process.exit(0);
  } catch (err) {
    console.error('迁移失败:', err.message);
    await pg.close().catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { migrate, status };
