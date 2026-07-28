-- 011: optional private S4 mirror for administrator-owned image assets.
-- Local files remain the durable fallback; remote metadata only controls acceleration.

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS remote_provider TEXT NOT NULL DEFAULT 'local';
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS remote_key TEXT;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS remote_status TEXT NOT NULL DEFAULT 'local';
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS remote_synced_at BIGINT;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS remote_attempted_at BIGINT;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS remote_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS remote_error TEXT;

CREATE INDEX IF NOT EXISTS idx_media_assets_remote_queue
  ON media_assets(remote_provider, remote_status, remote_attempted_at);
