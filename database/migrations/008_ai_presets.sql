-- 008: AI 自定义预设（按用户绑定，桌面端绑桌面用户，网页端绑登录账号）
-- 桌面 SQLite 模式由 db.js 启动时 CREATE TABLE IF NOT EXISTS 维护，本文件仅供 PostgreSQL 生产环境迁移

CREATE TABLE IF NOT EXISTS ai_presets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_presets_user ON ai_presets(user_id, sort_order);
