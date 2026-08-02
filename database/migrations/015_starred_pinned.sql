-- 星标 + 置顶：星标=收藏标记（不改排序），置顶=列表排序优先
-- 桌面 SQLite 模式由 db.js 启动时 ALTER TABLE 自动添加，本文件仅供 PostgreSQL 生产环境迁移

ALTER TABLE documents ADD COLUMN IF NOT EXISTS starred BIGINT NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pinned BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_documents_pinned
  ON documents(user_id, pinned, updated_at DESC);
