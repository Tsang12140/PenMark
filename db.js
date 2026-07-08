// 数据库初始化（SQLite，文件型，部署简单）
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'penmark.db'));
db.pragma('journal_mode = WAL'); // 并发读写更稳

// 文档表
db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '无标题',
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);
`);

// 注意：users 表与 documents.user_id 列由 auth.js 在 require 时迁移创建

module.exports = db;
