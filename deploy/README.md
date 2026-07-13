# 知著 PenMark 部署指南

## 架构说明

PenMark 支持两种运行模式：

| 模式 | 数据库 | 认证 | 适用场景 |
|------|--------|------|----------|
| 桌面版 | SQLite（本地文件） | 免登录，桌面 Cookie | 个人离线使用 |
| 网页版 | PostgreSQL | 服务端持久会话 | 多用户在线协作 |

**网页生产模式必须使用 PostgreSQL**，不会自动回退到 SQLite。

---

## 环境要求

- Node.js ≥ 18
- PostgreSQL ≥ 12（推荐 14+）
- PM2（`npm i -g pm2`）
- Nginx（反向代理 + SSL）

---

## 部署步骤

### 1. 安装 PostgreSQL

```bash
# Ubuntu/Debian
sudo apt install postgresql postgresql-contrib

# CentOS/RHEL
sudo yum install postgresql-server postgresql-contrib

# 或使用 Docker
docker compose -f docker-compose.postgres.yml up -d
```

### 2. 创建数据库和用户

```bash
sudo -u postgres psql << 'EOF'
CREATE USER penmark WITH PASSWORD '你的强密码';
CREATE DATABASE penmark OWNER penmark;
GRANT ALL PRIVILEGES ON DATABASE penmark TO penmark;
\c penmark
GRANT ALL ON SCHEMA public TO penmark;
EOF
```

### 3. 上传代码

```bash
cd /www/wwwroot/你的网站目录
git clone https://github.com/Tsang12140/PenMark.git .
npm install
```

### 4. 配置 .env

```bash
cp .env.example .env
nano .env
```

**必须修改**：

```ini
# PostgreSQL 连接
DATABASE_URL=postgresql://penmark:你的密码@127.0.0.1:5432/penmark

# SSL（如果 PostgreSQL 和应用在同一服务器，可设为 false）
PGSSL=false

# 安全密钥
PENMARK_SECRET=（用下面的命令生成）

# 管理员（仅首次启动创建，之后不会覆盖）
ADMIN_USERNAME=你的管理员用户名
ADMIN_PASSWORD=你的管理员密码
ADMIN_NICKNAME=管理员

# 运行模式
NODE_ENV=production

# Nginx 反向代理
TRUST_PROXY=1
```

生成随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 5. 执行数据库迁移

```bash
npm run db:migrate
```

查看迁移状态：

```bash
npm run db:status
```

### 6. 创建管理员（如果未通过 .env 自动创建）

```bash
npm run admin:create
```

重置管理员密码：

```bash
npm run admin:reset-password
```

### 7. 用 PM2 启动

```bash
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup
# 执行上面命令输出的 sudo 命令
```

### 8. 配置 Nginx 反向代理

宝塔面板 → 网站 → 设置 → 配置文件，参考 `deploy/nginx.conf`：

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 100m;
    proxy_read_timeout 120s;
}
```

### 9. 配置 SSL

宝塔面板 → 网站 → SSL → 一键申请 Let's Encrypt 免费证书。

**重要**：SSL 配置后，Cookie 会自动带 `Secure` 标志（基于 `X-Forwarded-Proto` 判断）。

---

## 从旧 SQLite 迁移

如果之前使用 SQLite，可以迁移到 PostgreSQL：

```bash
# 1. 先备份旧数据库
cp data/penmark.db data/penmark-backup-$(date +%Y%m%d).db

# 2. 确保已配置 DATABASE_URL 并执行迁移
npm run db:migrate

# 3. Dry-run 预览
npm run db:migrate-sqlite -- --source=./data/penmark.db

# 4. 实际执行迁移
npm run db:migrate-sqlite -- --source=./data/penmark.db --apply

# 5. 验证迁移结果（检查用户和文档数量）
```

**注意**：迁移工具不会迁移旧会话，用户需要重新登录。源 SQLite 文件不会被修改。

---

## 日常维护

### 日志

```bash
pm2 logs penmark
pm2 logs penmark --lines 100
```

### 重启

```bash
pm2 restart penmark
```

### 更新代码

```bash
git pull
npm install          # 如果有新依赖
npm run db:migrate   # 如果有新迁移
pm2 restart penmark
```

### 备份

```bash
# PostgreSQL 备份
pg_dump -U penmark -h 127.0.0.1 penmark > backup-$(date +%Y%m%d).sql

# 恢复
psql -U penmark -h 127.0.0.1 penmark < backup-20260101.sql
```

### 健康检查

```bash
# 进程存活
curl http://127.0.0.1:3001/health/live

# 数据库可用
curl http://127.0.0.1:3001/health/ready
```

---

## 判断当前运行模式

```bash
# 查看启动日志
pm2 logs penmark --lines 5

# 输出 "使用 SQLite" = 桌面/开发模式
# 输出 "PostgreSQL 连接成功" = 网页生产模式
```

---

## 常见问题

### 登录后刷新又回到登录页

1. 检查 `TRUST_PROXY=1` 是否设置（Nginx 反向代理必需）
2. 检查 Nginx 是否转发 `X-Forwarded-Proto` 头
3. 检查 `.env` 中 `NODE_ENV=production`
4. 检查浏览器 Cookie 是否被拦截（HttpOnly + SameSite=Lax）

### 管理员密码忘记

```bash
npm run admin:reset-password
```

### PostgreSQL 连接失败

1. 检查 `DATABASE_URL` 格式是否正确
2. 检查 PostgreSQL 是否允许密码认证（`pg_hba.conf`）
3. 检查防火墙是否放行 5432 端口
4. 检查 `PGSSL` 配置是否与服务器匹配

### Cookie 不落盘

- HTTP 开发环境不能设 `Secure`
- HTTPS 生产环境必须设 `TRUST_PROXY=1` 并正确转发 `X-Forwarded-Proto`

---

## 目录结构

```
/www/wwwroot/你的网站/
├── .env                    ← 生产环境配置（不提交到 git）
├── database/               ← 数据库层
│   ├── index.js            ← 后端选择器
│   ├── postgres.js         ← PostgreSQL 适配
│   ├── sqlite.js           ← SQLite 适配
│   ├── migrate.js          ← 迁移执行器
│   └── migrations/         ← SQL 迁移文件
├── scripts/                ← CLI 工具
│   ├── admin-cli.js        ← 管理员管理
│   └── migrate-sqlite-to-pg.js
├── deploy/                 ← 部署配置
│   ├── README.md
│   └── nginx.conf
├── logs/                   ← PM2 日志
├── public/                 ← 前端静态文件
├── server.js               ← 入口
├── auth.js                 ← 认证模块
├── invites.js              ← 邀请码模块
├── ecosystem.config.js     ← PM2 配置
└── docker-compose.postgres.yml  ← 开发用 PostgreSQL
```
