-- 010: repair share_visitors tables created before registered-visitor support.
--
-- 002_share_visitors.sql already defines user_id for fresh installations, but
-- CREATE TABLE IF NOT EXISTS cannot amend an older table that was created by
-- an early release. Keep this migration additive so existing visitor records
-- and live sharing links remain intact.

ALTER TABLE share_visitors ADD COLUMN IF NOT EXISTS user_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_share_visitors_user ON share_visitors(user_id);
CREATE INDEX IF NOT EXISTS idx_share_visitors_token_last
  ON share_visitors(share_token, last_visit_at DESC);
