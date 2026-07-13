-- PenMark PostgreSQL 初始 Schema
-- 可重复执行（IF NOT EXISTS）
-- 使用 SMALLINT (0/1) 表示布尔值，保持与 SQLite 查询兼容
-- 时间字段使用 BIGINT 存储 epoch 毫秒

-- 迁移版本记录表
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at BIGINT NOT NULL
);

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone TEXT,
  username TEXT,
  nickname TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  is_admin SMALLINT NOT NULL DEFAULT 0,
  is_banned SMALLINT NOT NULL DEFAULT 0,
  can_share SMALLINT NOT NULL DEFAULT 0,
  admin_note TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_admin ON users(is_admin);

-- 会话表（服务端持久会话）
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  last_seen_at BIGINT,
  revoked_at BIGINT,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 文档表
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '无标题',
  content TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  folder_id INTEGER,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deleted_at BIGINT,
  flagged SMALLINT NOT NULL DEFAULT 0,
  flag_reason TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents(deleted_at);

-- 文件夹表
CREATE TABLE IF NOT EXISTS folders (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id, sort_order);

-- 分享表
CREATE TABLE IF NOT EXISTS shares (
  id SERIAL PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  permission TEXT NOT NULL DEFAULT 'view',
  password_hash TEXT,
  password_salt TEXT,
  expire_at BIGINT,
  created_at BIGINT NOT NULL,
  theme TEXT DEFAULT 'light'
);
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
CREATE INDEX IF NOT EXISTS idx_shares_doc ON shares(doc_id);
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_id);

-- 举报表
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);

-- 敏感词表
CREATE TABLE IF NOT EXISTS sensitive_words (
  id SERIAL PRIMARY KEY,
  word TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);

-- 邀请码表
CREATE TABLE IF NOT EXISTS invites (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  used SMALLINT NOT NULL DEFAULT 0,
  used_at BIGINT,
  registered_username TEXT,
  registered_nickname TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);
CREATE INDEX IF NOT EXISTS idx_invites_used ON invites(used);
