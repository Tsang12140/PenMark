-- 017: 批量导入批次记录
-- 用于"撤销上一次导入"功能：把本次导入的文档/文件夹 ID 记下来，
-- 撤销时按 ID 把文档移入回收站（deleted_at），并删除本次导入且当前为空的文件夹。
-- doc_ids / folder_ids 用 JSON 文本存储，兼容 PostgreSQL 与 SQLite。
-- undone_at 非 NULL 表示已撤销，避免重复撤销。
CREATE TABLE IF NOT EXISTS import_batches (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_ids TEXT NOT NULL DEFAULT '[]',
  folder_ids TEXT NOT NULL DEFAULT '[]',
  doc_count INTEGER NOT NULL DEFAULT 0,
  folder_count INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  undone_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_import_batches_user ON import_batches(user_id, created_at DESC);
