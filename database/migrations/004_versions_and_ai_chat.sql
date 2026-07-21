-- 004: 文档版本快照表 + AI 对话历史表
-- SQLite 模式由 db.js 直接 CREATE TABLE IF NOT EXISTS 维护，本文件仅供 PostgreSQL 生产环境迁移

-- 文档版本快照（每次保存时若字符差异 > 50 才落一条）
CREATE TABLE IF NOT EXISTS document_versions (
  id SERIAL PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  chars_diff INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_versions_doc ON document_versions(doc_id, created_at DESC);

-- AI 对话历史（按文档保留：关闭面板/刷新后再打开仍能看到）
CREATE TABLE IF NOT EXISTS ai_chat_history (
  id SERIAL PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_doc ON ai_chat_history(doc_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_user ON ai_chat_history(user_id);
