-- 009: image bytes move out of document HTML; the HTML stores /api/assets/<uuid>.
-- Files live in PENMARK_ASSET_DIR (default: PENMARK_DATA_DIR/assets).
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_name TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_assets_document ON media_assets(doc_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_media_assets_owner ON media_assets(owner_id, created_at DESC);
