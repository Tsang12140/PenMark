-- 分享页访客记录表
-- 一个 (share_token, fingerprint) 对应一位访客，重复访问更新 last_visit_at 与 visit_count
CREATE TABLE IF NOT EXISTS share_visitors (
  id SERIAL PRIMARY KEY,
  share_token TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '游客',
  user_id INTEGER,
  first_visit_at BIGINT NOT NULL,
  last_visit_at BIGINT NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(share_token, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_share_visitors_token ON share_visitors(share_token);
CREATE INDEX IF NOT EXISTS idx_share_visitors_last ON share_visitors(last_visit_at);
CREATE INDEX IF NOT EXISTS idx_share_visitors_user ON share_visitors(user_id);
