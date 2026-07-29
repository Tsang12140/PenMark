-- 012: administrator-only automatic AI titles.
-- The fields are deliberately metadata-only so applying a generated title never
-- changes documents.updated_at or moves an older article to the top of the list.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS title_origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS auto_title_attempted_at BIGINT;

-- Existing default titles are eligible; a real existing title is treated as manual.
UPDATE documents
SET title_origin = 'untitled'
WHERE title_origin = 'manual'
  AND (COALESCE(title, '') = '' OR title = '无标题');

CREATE INDEX IF NOT EXISTS idx_documents_auto_title
  ON documents(user_id, title_origin, auto_title_attempted_at);

CREATE TABLE IF NOT EXISTS app_settings (
  id SERIAL PRIMARY KEY,
  setting_key TEXT NOT NULL UNIQUE,
  setting_value TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
