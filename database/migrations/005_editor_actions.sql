-- 005: 编辑器动作日志表（AI 辅助动作追溯，让 AI 对话能感知用户刚做了什么）
-- SQLite 模式由 db.js 直接 CREATE TABLE IF NOT EXISTS 维护，本文件仅供 PostgreSQL 生产环境迁移

CREATE TABLE IF NOT EXISTS editor_actions (
  id SERIAL PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,          -- 'rewrite' / 'layout' / 'insert_image' 等
  before_text TEXT NOT NULL DEFAULT '',
  after_text TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '',      -- JSON 字符串，存额外信息
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_editor_actions_doc ON editor_actions(doc_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_editor_actions_user ON editor_actions(user_id);
