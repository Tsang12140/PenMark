# PenMark 宝塔面板部署指南

## 环境要求

- Node.js ≥ 18（宝塔 → 软件商店 → 搜索 "Node.js 版本管理器" 安装）
- PM2（随 Node.js 版本管理器一起安装或 `npm i -g pm2`）
- 可选：Nginx（宝塔自带，用于反向代理 + SSL）
- 数据库：无需额外安装，SQLite 文件型数据库

## 部署步骤

### 1. 上传代码到服务器

SSH 连接服务器后：

```bash
# 进入宝塔网站目录
cd /www/wwwroot/你的网站目录

# 克隆项目
git clone https://github.com/Tsang12140/PenMark.git .

# 或者用宝塔面板 → 文件管理 → 上传（适合已经有打包好的代码）
```

### 2. 安装依赖

```bash
cd /www/wwwroot/你的网站目录
npm install
```

### 3. 创建 .env 配置

```bash
cp .env.example .env
nano .env   # 或 vim .env
```

**必须修改**：
```
PENMARK_SECRET=随机生成长字符串（至少 32 位）
ADMIN_USERNAME=你的管理员账号
ADMIN_PASSWORD=你的管理员密码
ADMIN_NICKNAME=管理员昵称
```

生成随机密钥：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. 用 PM2 启动

```bash
# 创建日志目录
mkdir -p logs

# 启动
pm2 start ecosystem.config.js

# 查看状态
pm2 status

# 设置开机自启
pm2 save
pm2 startup
# 执行上面命令输出的那一行 sudo 命令
```

### 5. 配置 Nginx 反向代理

宝塔面板 → 网站 → 你的网站 → 设置 → 配置文件

替换 location 部分为（或参考 `deploy/nginx.conf`）：

```
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 100m;
    proxy_read_timeout 120s;
}
```

### 6. 配置 SSL（强烈建议）

宝塔面板 → 网站 → SSL → 一键申请 Let's Encrypt 免费证书

## 日常维护

```bash
# 查看日志
pm2 logs penmark

# 重启
pm2 restart penmark

# 更新代码
git pull
npm install        # 如果有新依赖
pm2 restart penmark
```

## 目录结构说明

```
/www/wwwroot/你的网站/
├── .env              ← 生产环境配置（不提交到 git）
├── data/             ← SQLite 数据库文件存放
│   └── penmark.db
├── logs/             ← PM2 日志
├── node_modules/     ← 依赖
├── public/           ← 前端静态文件
├── server.js         ← 入口
└── ecosystem.config.js ← PM2 配置
```

## 注意事项

- **备份**：定期备份 `data/penmark.db`，所有文档都存在这个文件里
- **端口**：确保防火墙放行 3001 端口（仅 127.0.0.1 监听即可，外网走 Nginx）
- **内存**：better-sqlite3 是内存敏感型，建议服务器 ≥ 512MB RAM
- **权限**：`data/` 和 `logs/` 目录需要 Node.js 进程可读写
