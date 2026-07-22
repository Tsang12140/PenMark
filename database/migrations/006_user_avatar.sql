-- 006: users 表新增 avatar 字段（base64 头像，最多约 100KB / 人）
-- 桌面 SQLite 模式由 db.js 启动时 ALTER TABLE 自动添加，本文件仅供 PostgreSQL 生产环境迁移
-- 头像经服务端压缩到 256×256 PNG 后入库，避免数据库膨胀

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT '';
