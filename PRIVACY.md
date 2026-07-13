# 知著 PenMark 隐私说明

## 核心原则

知著 PenMark 是一款本地优先的个人记录软件。你的内容保存在你自己的电脑上，不会因为写作而自动上传到任何服务器。

## 数据存储

### 桌面版

- 数据保存在本机 `%APPDATA%\PenMark\` 目录
- 数据库为本地 SQLite 文件（`penmark.db`）
- 图片以 base64 形式存储在数据库中，或保存在本地 `assets\` 目录
- 不会自动上传任何文档内容、图片或元数据

### 网页版（自托管）

- 数据保存在服务器项目目录 `data/` 下
- 数据由部署者控制，PenMark 不提供任何云存储服务

## 网络访问

PenMark 的核心写作功能**完全离线可用**。以下功能会发起网络请求，且均为可选功能：

### 链接卡片（OG 元数据抓取）

- 当你插入链接并转为链接卡片时，PenMark 会访问目标网页抓取标题、描述和预览图
- 请求通过本地服务器的 `/api/og` 端点发起
- 有 1 小时内存缓存和 6 秒超时限制
- 不会将你的文档内容发送给目标网站

### AI 功能

- AI 功能需要用户自行在 `.env` 中配置 API Key
- 只有用户主动点击 AI 按钮时才会发起请求
- 请求直接发送到你配置的 AI 服务（默认 DeepSeek）
- PenMark 不经过任何中间服务器转发
- 核心写作不依赖 AI，未配置 Key 时不影响任何编辑功能

### GitHub 下载和版本检查

- 从 GitHub Releases 下载安装包时访问 GitHub
- 应用本身不内置自动更新检查

## 不做的事

- **不内置广告**
- **不内置跟踪器或分析工具**
- **不收集用户信息**
- **不上传文档内容**
- **不发送推送通知**
- **不访问通讯录或文件系统**（除用户主动选择文件导入导出）

## 分享功能

网页版支持文档分享功能：

- 分享通过生成短码链接实现
- 分享内容存储在你部署的服务器上
- 可设置访问密码和过期时间
- 分享密码使用 scrypt 哈希存储，不以明文保存
- 桌面版不使用分享功能

## Cookie

- 网页版使用 cookie 保存登录会话（`penmark_token`）
- 桌面版不需要 cookie，使用本地桌面用户身份
- 不放置任何广告或跟踪 cookie

## 第三方依赖

PenMark 使用以下开源项目：

- [Electron](https://www.electronjs.org/) — 桌面应用框架（Chromium + Node.js）
- [Express](https://expressjs.com/) — Web 服务器
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — SQLite 数据库
- [dom-to-image-more](https://github.com/1904labs/domToImageMore) — HTML 转图片

这些项目各自有自己的许可证和隐私政策。PenMark 不捆绑任何第三方跟踪 SDK。

## 数据安全

- 用户密码使用 scrypt 哈希 + 随机盐存储
- 登录 token 使用 HMAC-SHA256 签名
- 桌面版本地用户使用随机密码，无人能通过网络登录
- 桌面版本地服务仅监听 `127.0.0.1`，不暴露到局域网

## 你的权利

- **导出**：随时通过菜单导出整个资料库为 Markdown 文件夹
- **备份**：随时通过菜单备份数据库
- **删除**：直接删除数据目录或卸载应用即可完全删除所有数据
- **迁移**：Markdown 导出格式可被 Obsidian、Typora 等工具打开

## 联系

如发现隐私问题，请在 [GitHub Issues](https://github.com/Tsang12140/PenMark/issues) 提交。
