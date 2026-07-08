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

// 文件夹表（单层，parent_id 保留字段但前端只展示一层）
db.exec(`
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  user_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id, sort_order);
`);

// 分享表（仅管理员可创建；token 短码、权限、可选密码、可选过期）
db.exec(`
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  permission TEXT NOT NULL DEFAULT 'view',
  password_hash TEXT,
  password_salt TEXT,
  expire_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
CREATE INDEX IF NOT EXISTS idx_shares_doc ON shares(doc_id);
`);

// documents 表增量迁移：folder_id（NULL=未分类/根）
try {
  const cols = db.prepare("PRAGMA table_info(documents)").all();
  if (!cols.some(c => c.name === 'folder_id')) {
    db.exec("ALTER TABLE documents ADD COLUMN folder_id INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id)");
  }
} catch (e) {
  console.warn('documents.folder_id 迁移跳过：', e.message);
}

// 注意：users 表与 documents.user_id 列由 auth.js 在 require 时迁移创建

module.exports = db;
