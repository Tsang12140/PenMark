-- 016: 图片去重 + 缩略图
-- content_hash: 上传时算 sha256，相同内容复用同一文件，省存储
-- thumb_storage_name: 超小缩略图文件名，版本历史预览用，省带宽
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS thumb_storage_name TEXT;
CREATE INDEX IF NOT EXISTS idx_media_assets_content_hash ON media_assets(owner_id, content_hash);
