// 数据库初始化（SQLite，文件型，部署简单）
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.PENMARK_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'penmark.db'));
db.pragma('journal_mode = WAL'); // 并发读写更稳
db.pragma('foreign_keys = ON');   // 启用外键约束（确保删除时正确级联或拒绝）

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

// 用户表（认证、管理员、封禁、分享权限）
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT,
  username TEXT,
  nickname TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

// users 表增量迁移：username/nickname/is_banned/can_share/admin_note
try {
  const userCols = db.prepare("PRAGMA table_info(users)").all();
  if (!userCols.some(c => c.name === 'username')) db.exec("ALTER TABLE users ADD COLUMN username TEXT");
  if (!userCols.some(c => c.name === 'nickname')) db.exec("ALTER TABLE users ADD COLUMN nickname TEXT");
  if (!userCols.some(c => c.name === 'is_banned')) db.exec("ALTER TABLE users ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0");
  if (!userCols.some(c => c.name === 'can_share')) db.exec("ALTER TABLE users ADD COLUMN can_share INTEGER NOT NULL DEFAULT 0");
  if (!userCols.some(c => c.name === 'admin_note')) db.exec("ALTER TABLE users ADD COLUMN admin_note TEXT DEFAULT ''");
  if (!userCols.some(c => c.name === 'avatar')) db.exec("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''");
  // 回填：普通用户用 phone 作为 username/nickname（管理员回填由 auth.js seedAdmin 负责）
  db.prepare("UPDATE users SET username = phone WHERE is_admin = 0 AND (username IS NULL OR username = '')").run();
  db.prepare("UPDATE users SET nickname = phone WHERE nickname IS NULL OR nickname = ''").run();
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)");
} catch (e) { console.warn('users 迁移跳过：', e.message); }

// documents 表增量迁移：user_id 列（数据隔离）
try {
  const docCols = db.prepare("PRAGMA table_info(documents)").all();
  if (!docCols.some(c => c.name === 'user_id')) {
    db.exec("ALTER TABLE documents ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1");
    db.exec("CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, updated_at DESC)");
  }
} catch (e) { console.warn('documents.user_id 迁移跳过：', e.message); }

// sessions 表（服务端持久会话，桌面版可选使用）
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  user_agent TEXT,
  ip TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// documents 表增量迁移：软删除 + 审核标记
try {
  const docCols = db.prepare("PRAGMA table_info(documents)").all();
  if (!docCols.some(c => c.name === 'deleted_at')) {
    db.exec("ALTER TABLE documents ADD COLUMN deleted_at INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents(deleted_at)");
  }
  if (!docCols.some(c => c.name === 'flagged')) {
    db.exec("ALTER TABLE documents ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0");
  }
  if (!docCols.some(c => c.name === 'flag_reason')) {
    db.exec("ALTER TABLE documents ADD COLUMN flag_reason TEXT DEFAULT ''");
  }
  // 版本号字段：多端同步用，每次 PUT 自增 1
  if (!docCols.some(c => c.name === 'version')) {
    db.exec("ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  }
} catch (e) { console.warn('documents 迁移跳过：', e.message); }

// 举报表
db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  reporter_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);
`);

// 敏感词表
db.exec(`
CREATE TABLE IF NOT EXISTS sensitive_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
`);

// 邀请码表
db.exec(`
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  registered_username TEXT,
  registered_nickname TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);
`);

// shares 表增量迁移：加 theme 列
try {
  const shareCols = db.prepare("PRAGMA table_info(shares)").all();
  if (!shareCols.some(c => c.name === 'theme')) {
    db.exec("ALTER TABLE shares ADD COLUMN theme TEXT DEFAULT 'light'");
  }
} catch (e) { console.warn('shares 迁移跳过：', e.message); }

// 分享页访客记录表
db.exec(`
CREATE TABLE IF NOT EXISTS share_visitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_token TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '游客',
  user_id INTEGER,
  first_visit_at INTEGER NOT NULL,
  last_visit_at INTEGER NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(share_token, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_share_visitors_token ON share_visitors(share_token);
CREATE INDEX IF NOT EXISTS idx_share_visitors_last ON share_visitors(last_visit_at);
CREATE INDEX IF NOT EXISTS idx_share_visitors_user ON share_visitors(user_id);
`);

// share_visitors 增量迁移：加 user_id 列（NULL=未识别游客，非 NULL=注册用户回访）
try {
  const svCols = db.prepare("PRAGMA table_info(share_visitors)").all();
  if (!svCols.some(c => c.name === 'user_id')) {
    db.exec("ALTER TABLE share_visitors ADD COLUMN user_id INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_share_visitors_user ON share_visitors(user_id)");
  }
} catch (e) { console.warn('share_visitors 迁移跳过：', e.message); }

// 文档版本快照表（每次保存内容差异 > 50 字符时自动落一条）
db.exec(`
CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  chars_diff INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_doc_versions_doc ON document_versions(doc_id, created_at DESC);
`);

// AI 对话历史表（按文档保留：关闭面板/刷新后再打开仍能看到）
db.exec(`
CREATE TABLE IF NOT EXISTS ai_chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_doc ON ai_chat_history(doc_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_user ON ai_chat_history(user_id);
`);

// 编辑器动作日志表（记录改写/排版/插入等 AI 辅助动作，供 AI 对话感知）
db.exec(`
CREATE TABLE IF NOT EXISTS editor_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  before_text TEXT NOT NULL DEFAULT '',
  after_text TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (doc_id) REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_editor_actions_doc ON editor_actions(doc_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_editor_actions_user ON editor_actions(user_id);
`);

// AI 自定义预设（按用户绑定：桌面端绑桌面用户，网页端绑登录账号）
db.exec(`
CREATE TABLE IF NOT EXISTS ai_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_presets_user ON ai_presets(user_id, sort_order);
`);

module.exports = db;
