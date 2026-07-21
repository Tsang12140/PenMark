-- 003: 文档版本号字段（用于多端同步：B 端轮询发现版本号变化即提示刷新）
ALTER TABLE documents ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
