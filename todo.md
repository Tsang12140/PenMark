你说的 “P SQL” 应该是 **PostgreSQL**。下面这份提示词可以整段复制给另一个 AI，目标是让它直接实施，不只分析或写计划。

```text
你现在负责完整改造「知著 PenMark」项目的网页版数据库、登录认证和生产部署能力。请直接读取项目、实施修改、运行测试并修复发现的问题，不要只输出方案、伪代码、建议或待办清单。

项目目录：

D:\personal\cc\PenMark

开始后必须先完整阅读：

- AGENTS.md
- package.json
- server.js
- db.js
- auth.js
- invites.js
- env.js
- public/login.html
- public/login.js
- public/app.js
- public/styles.css
- desktop/main.cjs
- desktop/preload.cjs
- desktop/test-security.cjs
- deploy/README.md
- deploy/nginx.conf
- .env.example

然后搜索整个项目中所有数据库调用、认证调用、Cookie 处理、登录跳转、用户隔离、桌面模式判断和部署配置。不要只修改最容易看到的几个文件。

# 一、不可违反的产品原则

PenMark 是本地优先的写作工具。必须严格区分以下两种运行模式。

## 1. 桌面版

桌面版继续使用本地 SQLite：

- 正式版数据库：`%APPDATA%\PenMark\penmark.db`
- 开发版数据库：`%APPDATA%\PenMark-Dev\penmark.db`
- 桌面版完全离线可用
- 桌面版不要求注册或账号登录
- 启动后必须直接进入编辑器
- PostgreSQL、网络、账号系统、分享系统不得成为桌面版新建、输入、粘贴、切换、保存文档的前置条件
- 不得为了网页版 PostgreSQL 改造而破坏桌面版 SQLite、导入、导出、备份和现有测试
- 桌面版认证只用于保护本机回环服务，不能把用户带到网页登录页
- 如果桌面专用会话初始化失败，应安全重试或显示明确的启动错误，不能跳入一个永远无法完成的登录死循环

## 2. 网页版

网页版改为正式使用 PostgreSQL：

- 网页生产模式不得继续使用项目目录下的 SQLite 作为主数据库
- 使用环境变量 `DATABASE_URL` 连接 PostgreSQL
- 使用连接池
- 支持数据库迁移
- 支持可靠的事务
- 支持多用户数据隔离
- 支持注册、登录、退出、登录持久化、封禁、分享、邀请码、管理员等现有能力
- PostgreSQL 不可用时，生产网页版必须启动失败并输出明确错误，不能静默回退到一个新的空 SQLite 数据库
- 本地网页版开发可以通过明确配置选择 PostgreSQL，但不能通过模糊的自动回退掩盖配置错误

# 二、当前已知问题和事实

当前项目是 Node.js + Express + 原生 HTML/CSS/JS，没有前端框架。

当前数据库是 `better-sqlite3`，数据库调用大量分布在：

- db.js
- auth.js
- invites.js
- server.js
- desktop/exporter.cjs
- desktop/importer.cjs
- 各种 desktop/test-*.cjs

当前登录流程大致是：

1. `POST /api/auth/login`
2. 服务端校验用户名和密码
3. 写入 `penmark_token`
4. 前端跳转 `/`
5. 首页调用 `GET /api/auth/me`
6. `/api/auth/me` 失败时又跳转 `/login.html`

当前还存在桌面专用 Cookie：

`penmark_desktop_session`

已观察到的严重故障是：

- 登录页 Logo 被渲染成两张超大图片
- 输入正确账号密码后看似跳转成功，但马上又返回登录页
- 桌面模式一旦缺少 `penmark_desktop_session`，会进入登录页
- 普通登录写入的是 `penmark_token`
- 桌面模式的 `/api/auth/me` 只接受桌面 Cookie
- 因此可能形成“登录成功后马上又回登录页”的死循环
- 桌面版和网页版使用不同 SQLite 文件，账号和文档并不天然共享
- 当前管理员初始化逻辑可能在每次服务启动时根据 `.env` 重新覆盖管理员密码哈希，这不是安全、稳定的生产行为，必须检查并修复

不要预设只有一个原因。请通过实际请求、响应状态、Set-Cookie、Cookie 作用域、数据库查询和前端跳转行为验证完整链路。

# 三、PostgreSQL 改造要求

## 1. 技术选择

优先使用官方、轻量的 PostgreSQL Node.js 驱动：

`pg`

除非项目已有充分理由，不要引入庞大的 ORM。

可以建立清晰的数据库层，例如：

- `database/index.js`
- `database/postgres.js`
- `database/sqlite.js`
- `database/migrations/`
- `repositories/`

具体目录可以根据项目实际结构调整，但必须做到：

- 网页 PostgreSQL 与桌面 SQLite 的选择清晰、显式
- 业务代码不能继续假设所有数据库查询都是 `better-sqlite3` 的同步 API
- PostgreSQL 查询使用参数化占位符 `$1`、`$2`
- 不得通过简单字符串替换把 `?` 改成 `$1`
- 所有异步查询必须被正确 `await`
- Express 异步路由必须有统一错误处理，不能产生未处理的 Promise rejection
- 事务必须使用同一个 PostgreSQL client，并在异常时 rollback
- client 必须在 finally 中释放
- 不得在每次请求时新建连接池

如果保留双数据库适配层，接口应保持明确，例如：

- query
- one
- many
- execute
- transaction

不要强行伪装成 `better-sqlite3.prepare().get().all().run()` 的同步行为。

## 2. 数据库配置

至少支持以下环境变量：

- `DATABASE_URL`
- `PGSSL`
- `PGPOOL_MAX`
- `PG_IDLE_TIMEOUT_MS`
- `PG_CONNECTION_TIMEOUT_MS`
- `PENMARK_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `ADMIN_NICKNAME`
- `NODE_ENV`
- `PORT`
- `PENMARK_HOST`
- `TRUST_PROXY`

生产环境要求：

- 缺少 `DATABASE_URL` 时明确启动失败
- 不打印数据库密码或完整连接字符串
- 根据部署环境正确处理 PostgreSQL SSL
- 不要无条件使用 `rejectUnauthorized: false`
- 监听 pool error
- 启动时先验证连接
- 数据库迁移成功后才开始监听 HTTP 端口
- 进程退出时关闭连接池
- 健康检查至少区分“进程活着”和“数据库可用”

可以增加：

- `GET /health/live`
- `GET /health/ready`

健康接口不得泄露数据库连接信息、账号、密钥或堆栈。

## 3. PostgreSQL Schema 和迁移

请根据当前 SQLite 的真实表结构，为 PostgreSQL 建立完整、可重复执行、有版本号的迁移。

至少覆盖：

- users
- sessions
- documents
- folders
- invites
- shares
- reports
- sensitive_words
- schema_migrations

必须保留当前业务真正用到的所有列，不要只根据早期建表语句猜测；需要同时检查增量迁移和所有 SQL 查询。

要求：

- 主键使用适合 PostgreSQL 的自增方式
- 正确建立唯一约束、普通索引和外键
- 明确用户名大小写策略，并保持注册和登录行为一致
- documents 必须可靠关联 user
- folders 必须关联 user
- shares 必须关联 owner 和 document
- reports 必须关联 document 和 reporter
- 邀请码必须有唯一约束
- 分享 token 必须有唯一约束
- 删除、软删除和外键级联策略必须谨慎，不能意外删除用户文档
- 所有迁移可重复检测，不能每次启动重复执行破坏性 SQL
- 不能继续依赖 SQLite 的 `PRAGMA table_info`
- 不能继续查询 `sqlite_master`
- 不得在生产启动时随意执行不可追踪的 `ALTER TABLE`
- 时间字段可以继续保持 epoch 毫秒以减少前端破坏，但要处理 PostgreSQL BIGINT 默认返回字符串的问题；确保 API 返回给前端的时间仍为安全的 JavaScript Number
- 如果改为 `TIMESTAMPTZ`，必须统一转换并确保所有相对时间、过期时间、排序和前端行为不回归

迁移执行应有独立命令，例如：

`npm run db:migrate`

另外提供迁移状态或检查命令，例如：

`npm run db:status`

# 四、正式修复认证系统

## 1. 网页版登录

完整验证：

- 用户名存在且未封禁
- 密码哈希验证正确
- 登录成功后创建持久会话
- 返回用户公开字段
- 设置正确 Cookie
- 刷新页面仍保持登录
- `/api/auth/me` 能根据 Cookie 找到会话和用户
- 退出登录后会话立即失效
- 过期会话不能继续使用
- 被封禁用户不能继续使用已有会话
- 不允许通过修改 user id 获取其他用户的数据

建议把网页版改成服务端持久会话，而不是仅依靠不可撤销的长效 HMAC token：

- 登录成功生成至少 256 bit 的密码学随机 token
- 浏览器 Cookie 保存原始 token
- PostgreSQL 的 sessions 表只保存 token 的 SHA-256 哈希，不保存原始 token
- sessions 至少包含：
  - id
  - user_id
  - token_hash
  - created_at
  - expires_at
  - last_seen_at
  - revoked_at
  - 可选的 user_agent/ip 摘要
- 查询会话时对 token 做哈希后查询
- 退出时撤销或删除当前会话
- 定期清理过期会话
- 不要在日志中打印 token
- 如果保留旧 HMAC token兼容期，必须明确、有限且有测试；不要永久保留两套互相冲突的认证

Cookie 至少满足：

- `HttpOnly`
- `Path=/`
- `SameSite=Lax`
- 生产 HTTPS 环境设置 `Secure`
- 本地 HTTP 开发不能因为错误设置 `Secure` 而导致 Cookie 完全不落盘
- 正确处理 Nginx 反向代理和 `trust proxy`
- 不要根据未经信任的 Host 或 X-Forwarded-Proto 随便判断安全属性
- 登录、注册、退出请求保持同源 credentials
- 检查 Cookie 的 domain、path、expiration 是否正确
- Cookie 名称不要与桌面 Cookie 混淆

不要把密码、密码哈希、盐、session token 返回给前端。

## 2. 密码和管理员初始化

可以继续使用 Node.js `crypto.scrypt`，但必须：

- 使用随机盐
- 使用常量时间比较
- 检查哈希长度和格式
- 密码策略前后端一致
- 不记录明文密码
- 错误提示不要泄漏过多账户信息；可以根据现有产品体验做合理取舍

修复管理员初始化：

- 第一次数据库为空时，可以通过明确的初始化命令创建管理员
- 不允许每次服务启动都无条件覆盖管理员密码
- `.env` 中密码变化不应静默重置线上管理员密码
- 提供显式管理员创建/重置命令，例如：
  - `npm run admin:create`
  - `npm run admin:reset-password`
- 命令必须避免在终端输出明文密码
- 并发执行时不能创建多个冲突管理员
- 如果为了兼容现有部署保留自动 seed，只能在不存在管理员时执行，并明确记录行为

## 3. 注册和邀请码

注册流程必须放在数据库事务中：

1. 校验用户名、昵称和密码
2. 锁定或原子消费邀请码
3. 检查用户名唯一
4. 创建用户
5. 标记邀请码已使用
6. 创建登录会话
7. 提交事务

任何步骤失败都必须回滚。

重点测试两个请求同时使用同一个邀请码，必须最多只有一个成功。

PostgreSQL 中应使用唯一约束、条件更新、行锁或其他可靠的事务方案，不能仅依赖应用层“先查询再更新”。

## 4. 桌面认证

桌面版不能使用网页版账号登录作为正常入口。

检查并修复：

- 主进程设置 `PENMARK_DESKTOP=1`
- 本地服务只绑定 `127.0.0.1`
- 随机生成桌面会话 token
- 在创建窗口和加载首页前，确保 Cookie 已真正写入 BrowserWindow 使用的同一个 Electron session
- 明确设置 Cookie URL、Path、HttpOnly、SameSite
- 必要时读取 Cookie 验证写入成功
- 写入失败应重试有限次数并记录安全日志
- 重试仍失败时显示明确启动错误
- 不得自动跳转登录页
- 桌面模式访问 `/login.html` 时应安全重定向回首页或显示“桌面版无需登录”
- 如果 `/api/auth/me` 在桌面模式认证失败，前端不能进入普通账号登录死循环
- 保留 Host 检查、防 DNS rebinding 和现有桌面安全边界
- 不得为了方便直接取消桌面本地服务认证
- 不得允许任意本机网页访问 PenMark 本地 API

补充自动化测试覆盖“桌面 Cookie 缺失、错误、正确”三种状态和恢复逻辑。

# 五、SQLite 到 PostgreSQL 数据迁移工具

增加一个安全的一次性迁移工具，把现有网页版 SQLite 数据迁移到 PostgreSQL。

建议命令：

`npm run db:migrate-sqlite -- --source=./data/penmark.db`

必须满足：

- 默认 dry-run 或提供明确 `--dry-run`
- 检查源文件存在
- 以只读方式打开源 SQLite
- 检查所有必需表和列
- 不修改、不删除、不重命名源 SQLite
- PostgreSQL 导入在事务中完成
- 迁移 users、documents、folders、invites、shares、reports、sensitive_words
- 正确保留表之间的 id 关系
- 正确处理旧表缺列、NULL、软删除、旧 phone 字段、username/nickname 回填
- 迁移密码哈希和盐时保持现有用户仍可登录
- 不迁移无效或已过期 session，旧会话可以要求重新登录
- 遇到用户名、邀请码、分享 token 冲突时停止并给出明确报告，不能静默覆盖
- 导入完成后校正 PostgreSQL sequence
- 输出各表迁移前后行数
- 对关键表做校验
- 不输出正文、密码哈希、盐、token 等敏感数据
- 失败时整个 PostgreSQL 导入回滚
- 支持安全重跑，或者明确拒绝向非空目标库重复导入
- 给出迁移前备份命令和迁移后验证命令

# 六、登录页视觉问题

修复当前登录页 Logo：

当前 login.html 同时插入了浅色和深色两张横版 SVG，但 styles.css 缺少对应尺寸和主题显示规则，导致两张 1200×350 Logo 同时以大尺寸参与布局。

必须：

- 给 `.login-logo-img` 设置合理、响应式的宽度和 `height:auto`
- 每次只显示当前主题对应的 Logo
- 浅色/飞书主题显示 light Logo
- 暗色主题显示 dark Logo
- 登录卡片不能被 Logo 撑开或产生横向滚动
- 移动端小屏正常显示
- 分享页的 `.share-brand-logo` 也做同样检查和修复
- 不要重新生成或替换现有品牌资产
- 不要破坏登录字段、密码显示按钮、登录/注册切换和键盘操作

# 七、全面排查项目问题

完成 PostgreSQL 和认证改造后，继续检查整个项目，不要立即结束。

重点检查：

## 数据权限

- 每个文档查询、更新、删除都必须限制 `user_id`
- 每个文件夹操作都必须限制 `user_id`
- 分享管理必须验证 owner
- 管理员接口必须验证 admin
- 普通用户不能修改 is_admin、is_banned、can_share
- 动态 SQL 字段必须使用严格白名单
- 文档恢复和永久删除不能越权
- 公开分享接口只能访问被分享的文档
- edit 分享不能修改其他文档
- 举报接口不能伪造其他用户

## SQL 安全

- 所有用户输入使用参数化查询
- 不允许拼接 username、title、search、token、id
- 排序字段和更新字段必须白名单
- 检查 PostgreSQL 与 SQLite 的语法差异
- 检查 `LIKE`、大小写、NULL、布尔值、RETURNING、受影响行数和 upsert 行为
- 检查 ID 字符串/数字转换
- 检查分页或可能返回无限数据的管理员接口

## Web 安全

- 登录接口增加合理的速率限制
- 不要引入内存无限增长的限流器
- 检查 CSRF 风险；至少对修改请求验证同源 Origin/Referer，或实现可靠的 CSRF 方案
- 保持 SameSite Cookie
- 检查 XSS，尤其是文档 HTML、分享页、昵称、标题和错误信息
- 保持现有富文本功能，不要粗暴转义编辑器正文导致格式丢失
- 检查 SSRF 图片代理和链接抓取
- 检查重定向、Host header、代理头
- 生产环境不要返回堆栈和数据库错误详情
- 不要在日志中记录密码、Cookie、session token、数据库 URL
- 检查 100MB JSON 限制的内存风险并给出合理处理，不要因此破坏富文本图片粘贴
- 检查账号封禁后已有会话是否立即失效
- 检查退出登录是否只清当前会话还是全部会话，并明确行为

## 稳定性

- PostgreSQL 暂时断开时返回可理解的 503，而不是进程无提示崩溃
- 避免重复提交注册、创建分享、保存文档造成重复数据
- 重要写操作使用事务
- 正确处理连接池耗尽
- 所有路由返回一致的 JSON 错误
- 前端对 401、403、409、429、500、503 做合理处理
- 登录成功后必须先确认会话有效再进入应用，或者进入后保证 `/api/auth/me` 成功
- 避免登录页和首页互相无限跳转
- 防止重复初始化欢迎文档
- 多个并发请求不能为同一新用户创建多篇欢迎文档

## 性能和本地优先

严格遵守 AGENTS.md：

- 不让 PostgreSQL、分享、统计、AI、索引阻塞桌面写作
- 普通输入不能触发网络数据库请求
- 新建、切换、粘贴先完成界面响应，再保存
- 不把当前“可编辑 HTML + 必要元数据”改成复杂 block schema
- 不引入 CRDT
- 不在这个任务中进行无关的大型前端重构
- 不破坏微信公众号/微信富文本粘贴样式
- 桌面版继续离线可用

# 八、自动化测试要求

不能只在代码层面声称已经修好，必须运行实际测试。

优先使用项目现有测试体系；可以补充 Node 内置 test runner、独立集成测试或其他轻量方案。避免为了测试引入庞大框架。

为 PostgreSQL 提供本地测试环境，建议增加：

- `docker-compose.postgres.yml` 或等价开发配置
- 独立测试数据库
- 测试环境迁移命令
- 测试结束清理数据

测试绝不能连接或清空生产数据库。任何 destructive 测试开始前必须检查数据库名称或显式测试标志。

至少测试：

## 数据库

- 空数据库迁移成功
- 重复运行迁移安全
- 所有表、索引、唯一约束和外键存在
- PostgreSQL 连接失败时启动失败且错误清楚
- 时间字段 API 类型正确
- SQLite 到 PostgreSQL dry-run
- SQLite 到 PostgreSQL真实测试库迁移
- 迁移前后各表行数和关系一致

## 登录闭环

- 正确账号密码登录返回 200
- 响应包含 Set-Cookie
- Cookie 属性正确
- 使用 Cookie 调用 `/api/auth/me` 返回 200
- 模拟浏览器跳转 `/` 后不会回登录页
- 刷新页面保持登录
- 错误密码失败
- 不存在用户失败
- 封禁用户失败
- 封禁已有登录用户后，会话不能继续使用
- 过期会话失败
- 篡改 Cookie 失败
- 退出后 `/api/auth/me` 返回 401
- 登录 Cookie 不会被桌面 Cookie 逻辑误判
- HTTPS 反向代理场景 Cookie 带 Secure
- 本地 HTTP 开发场景 Cookie 不错误携带 Secure
- 登录页不会发生无限跳转

## 注册和邀请码

- 合法邀请码注册成功
- 用户名唯一
- 邀请码只能使用一次
- 两个并发请求抢同一邀请码时只有一个成功
- 注册中途失败会回滚用户和邀请码
- SQL 注入输入不能改变查询逻辑

## 用户隔离

创建至少两个普通用户，验证：

- A 看不到 B 的文档
- A 不能读取 B 的文档详情
- A 不能更新、移动、软删除、恢复或永久删除 B 的文档
- A 不能操作 B 的文件夹
- A 不能管理 B 的分享
- 管理员接口对普通用户返回 403
- 公开分享只能访问对应文档

## 文档功能

- 新建文档
- 读取列表
- 打开文档
- 自动保存
- 修改标题和正文
- 文件夹创建、排序、重命名、删除
- 软删除、恢复、永久删除
- 搜索
- 分享创建、更新、撤销
- 分享密码
- 分享过期时间
- 分享阅读和编辑权限
- 举报和敏感词功能
- 富文本 HTML 和 base64 图片不会因为 PostgreSQL 类型或转义被破坏
- 大正文能正常保存和读取

## 桌面回归

运行并保持通过：

- `npm test`
- exporter 测试
- importer 测试
- integration 测试
- security 测试

补充验证：

- 桌面版不需要 DATABASE_URL
- 断网情况下桌面版可启动
- 桌面版直接进入首页
- 桌面版不会出现网页登录页
- 桌面 SQLite 仍然可写
- PostgreSQL 改造没有改变桌面数据目录
- 桌面导入导出仍然工作

## 前端视觉

如果可以启动浏览器或 Electron，请实际检查：

- 登录页桌面尺寸
- 登录页窄屏尺寸
- 浅色主题
- 暗色主题
- Logo 只显示一张
- 表单处于卡片合理位置
- 登录后刷新不回登录页
- 分享页品牌 Logo 正常

如果环境无法截图，至少通过 DOM/CSS 检查和 HTTP 集成测试验证，不要假装进行了视觉测试。

# 九、部署和文档

更新：

- `.env.example`
- `README.md`
- `deploy/README.md`
- `deploy/nginx.conf`
- `ecosystem.config.js`
- package.json scripts
- 必要的 PostgreSQL 初始化、迁移和备份文档

文档必须包含：

1. 安装 PostgreSQL 或使用现有 PostgreSQL
2. 创建数据库和专用数据库用户
3. 设置最小必要权限
4. 配置 `DATABASE_URL`
5. 配置 SSL
6. 执行迁移
7. 创建第一个管理员
8. 从旧 SQLite 导入
9. 验证登录
10. PM2 启动
11. Nginx HTTPS 反向代理
12. `trust proxy` 配置
13. `pg_dump` 备份
14. 恢复演练
15. PostgreSQL 升级前备份
16. 常见登录 Cookie 问题排查
17. 如何判断当前运行的是桌面 SQLite 还是网页版 PostgreSQL

不得在示例文件中提交真实密码、真实数据库地址、真实 token 或当前 `.env` 内容。

# 十、执行方式

请按以下方式工作：

1. 先检查 git status，保护用户已有的未提交改动。
2. 完整读取 AGENTS.md。
3. 搜索所有数据库和认证调用。
4. 复现当前登录问题，记录请求状态和 Cookie 行为。
5. 确认桌面版与网页版的数据库路径和认证分支。
6. 设计最小但完整的 PostgreSQL 数据层。
7. 建立迁移。
8. 将网页版路由全部改为异步 PostgreSQL 查询。
9. 保留桌面 SQLite 路径。
10. 修复网页版认证。
11. 修复桌面登录死循环。
12. 修复登录页和分享页 Logo。
13. 编写 SQLite 到 PostgreSQL 迁移工具。
14. 编写和运行测试。
15. 根据测试结果继续修复。
16. 更新部署文档。
17. 最后检查 git diff，确认没有秘密、数据库文件、日志或测试数据被提交。

不要在只完成计划、Schema、数据库连接或登录接口后停止。只要环境允许，就持续实施直到所有可安全完成的内容都完成。

如果 PostgreSQL 或 Docker 当前不可用：

- 仍然完成代码、迁移、测试脚本和文档
- 明确说明哪些测试因为外部服务不可用未能运行
- 不得谎称测试通过
- 不得把“无法启动 PostgreSQL”当成停止其他工作的理由
- 不得静默改回 SQLite

不要擅自删除或覆盖现有 SQLite 数据库。

不要执行 `git reset --hard`、强制 checkout 或其他破坏用户改动的命令。

不要自动提交或推送，除非我明确要求。

# 十一、最终验收标准

只有同时满足以下条件才算完成：

- 网页生产模式使用 PostgreSQL
- 桌面版继续使用本地 SQLite
- 桌面版完全免登录
- 正确密码能稳定登录网页版
- 登录后刷新不会返回登录页
- Cookie、安全代理和 session 行为正确
- 管理员密码不会在每次启动时被静默覆盖
- 注册和邀请码具备事务一致性
- 多用户文档严格隔离
- 现有 CRUD、分享、管理和举报接口完成 PostgreSQL 改造
- 有可执行的数据库迁移
- 有安全的 SQLite 导入 PostgreSQL 工具
- 有 PostgreSQL 测试配置
- 自动化测试覆盖认证闭环和权限隔离
- 现有桌面测试通过
- 登录页 Logo 恢复正常
- 部署文档可以让新服务器从零部署
- 没有提交真实密钥或数据库文件
- 最终报告诚实区分“已运行通过”“只做静态检查”“因环境未运行”

完成后请给出一份精确报告，包括：

- 根因
- 架构选择
- 修改文件
- PostgreSQL Schema 和迁移
- 认证修复
- 桌面版保护措施
- SQLite 数据迁移方式
- 实际运行的测试和结果
- 未运行的测试及原因
- 部署命令
- 回滚方式
- 仍然存在的风险

现在开始读取项目并实际执行，不要先停下来向我重复需求，也不要只返回实施计划。
```