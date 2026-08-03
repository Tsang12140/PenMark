-- 015: 版本来源。旧记录默认视为自动快照。
ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auto';