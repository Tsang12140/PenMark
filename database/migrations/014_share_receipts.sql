-- 014: opened shares appear in the signed-in reader's shared-document home section.
CREATE TABLE IF NOT EXISTS share_receipts (
  id SERIAL PRIMARY KEY,
  share_token TEXT NOT NULL REFERENCES shares(token) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_opened_at BIGINT NOT NULL,
  last_opened_at BIGINT NOT NULL,
  UNIQUE(share_token, user_id)
);

CREATE INDEX IF NOT EXISTS idx_share_receipts_user_opened
  ON share_receipts(user_id, last_opened_at DESC);
