-- 013: 普通用户图片存储配额与月度流量统计
-- 管理员不限；普通用户总存储 2GB，每月访问流量 500MB
-- 配额常量在 assets.js 中硬编码，本表仅记录月度流量累计
-- 主键 (user_id, month_start) 便于 ON CONFLICT upsert

CREATE TABLE IF NOT EXISTS user_asset_bandwidth (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month_start BIGINT NOT NULL,
  bytes BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month_start)
);
CREATE INDEX IF NOT EXISTS idx_user_asset_bandwidth_month ON user_asset_bandwidth(month_start);
