你正在维护「知著 PenMark」项目。请在一次任务内尽可能完整地完成开源发布准备、MIT License、专业 README 和 PenMark 官方展示主页。

工作区：

D:\personal\cc\PenMark

参考项目的展示主页位于：

D:\personal\cc\AI\picmark\index.html

PicMark 主页相关素材位于：

D:\personal\cc\AI\picmark\
├─ index.html
├─ PRIVACY.md
├─ assets/
├─ fonts/
└─ screenshots/

PenMark GitHub 仓库：

https://github.com/Tsang12140/PenMark

本任务要求实际检查、设计、实现、截图、验证，不要只给方案。只要还能安全推进，就继续工作，不要做完一个 LICENSE 或简单 README 就停止。

除非遇到可能删除用户数据、需要付费凭据或必须由用户作出法律身份选择的问题，否则不要频繁询问。尽量根据以下要求一次完成。

# 一、首先理解产品

PenMark 不是企业协作文档，也不是简单模仿飞书。

PenMark 的核心用途包括：

- 读书心得
- 原文摘抄
- 梦境记录
- 随笔
- 网页资料
- 图片资料
- 图文混合笔记
- 个人长期档案

产品主旨：

> 一款本地优先、打开就能写、擅长富文本和图文粘贴、数据始终属于用户、内容永远可以带走的个人长期记录软件。

核心价值：

1. 数据属于用户。
2. 打开就能写。
3. 核心编辑离线可用。
4. 网页、飞书、公众号等富文本粘贴尽量保真。
5. 图片可以方便地拖入、缩放和排列。
6. 不依赖特定云服务。
7. 支持 Word、HTML、Markdown 等迁移方式。
8. 桌面版无需账号和联网即可写作。
9. AI、分享、同步只能是可选增强层。
10. 即使 PenMark 停止维护，用户仍能带走和读取内容。

建议品牌表达：

> 打开就写，内容永远带得走。

可以润色，但不要变成企业软件、AI 笔记或知识管理营销套话。

# 二、保护现有工作区

开始前必须：

1. 阅读 AGENTS.md。
2. 检查 git status。
3. 阅读 package.json、README.md、desktop/、server.js 和当前品牌资源。
4. 检查现有未提交修改。
5. 保留所有用户已有修改。
6. 不执行 git reset --hard、git checkout -- 或清理工作区。
7. 不删除数据库、文档、安装包和用户数据。
8. 不重写当前编辑器。
9. 本任务主要处理开源资料和展示主页，不要擅自扩展编辑器功能。

如果发现当前代码、README 和实际功能有差异，以实际代码和测试结果为准，不要在文档或主页中夸大未实现功能。

# 三、添加 MIT License

在仓库根目录创建标准 MIT License：

LICENSE

版权信息使用：

Copyright (c) 2026 Tsang12140

使用标准 MIT License 全文，不要改写条款，不要创建自定义限制，不要增加“禁止商用”“必须署名展示”等与 MIT 冲突的限制。

同时完成：

- README 中增加 MIT License 说明和链接。
- 展示主页页脚增加 MIT License 链接。
- package.json 增加：

```json
"license": "MIT"
如果 package.json 缺少合理的 author，可以设置为：
"author": "Tsang12140"
MIT 仅适用于 PenMark 自己的源代码和有权授权的品牌素材。不要错误声称所有第三方依赖、Electron、字体和 vendor 文件都由 PenMark 重新以 MIT 授权。
检查第三方字体、图标、依赖和 vendor 资源：
保留第三方原许可证。
不删除 Electron、Chromium、npm 依赖附带的许可证。
如果仓库中存在需要额外说明的第三方素材，创建 THIRD_PARTY_NOTICES.md。
不要凭空给未知来源素材标注 MIT。
如果某项素材授权无法确认，优先不用它，不要编造授权信息。
四、重写专业 README
当前 README 已有桌面构建、数据目录、导出和迁移说明。请基于实际代码进行系统整理，写成适合 GitHub 开源项目首页的高质量 README。
README 以中文为主，结构清晰，避免过度冗长，但必须包含重要信息。
建议结构：
顶部
PenMark 横版品牌 Logo。
产品名称：知著 PenMark。
一句话定位。
简短介绍。
合理的徽章：License MIT
Windows
Node.js
Electron
Local First
Latest Release（只有链接真实有效时使用）

下载按钮。
官方展示主页按钮。
GitHub Releases 按钮。
不要堆十几个无意义徽章。
产品截图
至少展示一张真实 PenMark 桌面版截图。
如果能够真实启动应用：
使用打包版或桌面开发版。
使用隔离测试资料库。
创建一份具有代表性的测试文档。
截图中展示：文件夹和文档列表
文档标题
正文标题与段落
图片
普通链接或链接卡片
大纲
编辑工具栏

不要截图用户真实文档。
不要泄露本机路径、账号、Token 或其他隐私。
截图保存到：
docs/screenshots/
对图片合理压缩，避免 Git 仓库中出现数十 MB 的截图。
不要用假的 UI mockup 冒充实际软件截图。
如果 GUI 环境确实无法截图，先使用已有真实素材；必须在最终报告中说明，不得伪造。
为什么做 PenMark
用简短自然的文字说明：
印象笔记、有道云等产品可能存在广告、设备和产品策略限制。
Obsidian 本地可靠，但 Markdown 和同步有学习成本。
Notion、飞书更偏云端结构化或协作。
PenMark 希望提供一张本地优先、富文本友好的个人纸张。
不要攻击或贬低其他产品，不要写成情绪化竞品控诉。
核心特点
准确描述已经实现的能力：
富文本编辑
本地桌面版
核心离线可用
文档与文件夹
大纲导航
图片拖入和缩放
链接和链接卡片
富文本粘贴
Word、HTML、Markdown、图片导出
资料库批量导出
原始 HTML 无损副本
旧版 SQLite 数据安全导入
网页模式与桌面模式
本地数据备份
中文界面
快捷键
不得把“未来计划”写成“已经实现”。
例如：
Markdown 文件暂时还不是唯一正式数据源。
文件监听尚未实现时不能声称“像 Obsidian 一样自动联动”。
没有云同步时不能声称已经支持多设备同步。
没有数字签名时要说明 Windows 可能提示未知发布者。
未实际验证的兼容系统不能擅自写支持。
快速下载
说明普通用户应该去 GitHub Releases 下载 Windows 安装包。
GitHub 仓库：
https://github.com/Tsang12140/PenMark
Releases：
https://github.com/Tsang12140/PenMark/releases
直接下载链接必须与真实存在的 Release 和资产名称一致。
如果当前 GitHub Release 尚未发布，不要编造一个必然 404 的链接。此时按钮指向 Releases 页面，并在文案中写“前往 Releases 下载”。
不要把 EXE 提交进 Git 历史。EXE 应放 GitHub Releases。
两种运行方式
清晰解释：
Windows 桌面版
适合普通个人用户：
无需 Node.js。
无需浏览器。
核心编辑无需登录。
数据保存在 %APPDATA%\PenMark。
从 Releases 下载 EXE。
Node 网页版
适合开发者、自托管和多用户部署：
npm install
npm start
确认实际端口，目前预计是 3001，不要继续写错成 3000。
开发与构建
根据实际 package.json 写：
npm install
npm test
npm run desktop:dev
npm run desktop:dist
解释：
Electron 版本。
better-sqlite3 的 ABI 切换脚本。
构建产物位置。
Windows 安装包构建方法。
为什么不建议提交 dist-desktop。
数据与隐私
写清楚：
桌面数据目录。
开发数据目录。
网页版数据目录。
数据库备份方式。
旧版数据库导入方式。
整个资料库导出方式。
图片和原始 HTML 的保存方式。
外部链接卡片可能访问目标网页。
AI 功能只有配置相应服务后才会发起请求。
核心本地写作不依赖 AI。
不要笼统承诺“任何情况下绝不联网”，因为链接卡片、更新检查、AI 等功能可能联网。
Markdown 资料库阶段
准确说明：
当前：
SQLite + HTML 是正式数据源。
Markdown 是批量导出和迁移格式。
每篇文档另有原始 HTML 无损副本。
支持旧 SQLite 数据导入。
未来目标：
.md 文件成为正式数据。
SQLite 退化为缓存和索引。
文件夹就是分类。
图片成为普通附件。
支持外部文件监听。
可使用 OneDrive、Syncthing、Git 等同步。
项目状态
明确写：
当前处于早期版本或个人项目阶段。
建议先备份再升级。
欢迎提交 Issue。
不要承诺企业级稳定性。
Roadmap
按真实优先级：
Markdown 资料库导入
文件监听
文件即真相
更完整的数据迁移
搜索与回顾
可选的轻量同步
性能和稳定性
代码签名
不要把协作、CRDT 和复杂云服务放到最高优先级。
贡献
增加简短贡献说明：
Fork
新建分支
测试
PR
不要提交真实数据库、Token、.env 和用户笔记
修改写作热路径时遵守 AGENTS.md
License
MIT，链接到 LICENSE。
五、参考 PicMark 制作 PenMark 展示主页
参考：
D:\personal\cc\AI\picmark\index.html
可以学习 PicMark 的这些方面：
单页静态展示主页。
顶部吸附导航。
Hero 大标题和下载按钮。
真实产品截图。
分段介绍产品能力。
本地、隐私和适配说明。
下载区。
GitHub Star CTA。
页脚包含 GitHub、Releases、隐私和 License。
轻量滚动动画。
响应式布局。
无框架、无追踪器、可直接部署到 GitHub Pages。
不要直接复制 PicMark 的品牌风格。
PicMark 使用的是绿色、深色图片工作台和“见微”视觉；PenMark 应使用自己的品牌资产、纸张感、墨色和蓝色强调色。
PenMark 品牌资源位于：
public/PenMark_Brand_Assets/
请检查并优先复用：
横版 Logo
堆叠 Logo
App Icon
favicon
品牌预览
深浅色版本
不要重新生成低质量 Logo，不要把 PicMark Logo 用到 PenMark。
六、主页目录结构
建议将 GitHub Pages 静态主页放在：
docs/
├─ index.html
├─ privacy.html 或 privacy.md
├─ assets/
│  ├─ brand/
│  └─ 主页需要的少量资源
└─ screenshots/
   ├─ penmark-editor.png
   ├─ penmark-images.png
   └─ 其他真实截图
如果项目已有更合理的 Pages 目录或配置，可以沿用，但最终必须清楚说明。
主页不应依赖 Node 服务，应是完全静态的 HTML、CSS 和少量 JavaScript，可直接通过 GitHub Pages 托管。
不要引入 React、Vue、Next.js 或大型构建工具。
优先：
一个 docs/index.html
本地图片和 SVG
少量原生 JavaScript
无第三方 CDN
无统计追踪
无 Cookie Banner
无网络字体依赖
如果要使用字体：
优先系统字体。
只有授权明确时才提交本地字体。
不要从 PicMark 复制字体，除非授权文件明确允许重新分发且保留相应说明。
七、主页内容设计
主页至少包括以下区域。
7.1 导航
左侧：
PenMark Logo
知著 PenMark
中间或右侧：
特点
界面
数据与隐私
下载
GitHub
CTA：
下载 Windows 版
移动端合理折叠，不要让导航拥挤。
7.2 Hero
建议方向：
小标签：
v1.0.0 · 本地优先 · MIT 开源
实际版本必须从 package.json 获取，不要写死错误版本。
主标题可以参考：
打开就写，
内容永远带得走。
说明：
记录读书心得、摘抄、梦境与随笔。
富文本和图片留在本地，不被账号、广告和设备数量绑住。
文案可以润色，但必须克制、自然，不要像企业 SaaS 广告。
按钮：
下载 Windows 版
查看源代码
如果直接下载资产不存在，第一按钮指向 Releases 页面，不要制造死链。
Hero 下方放一张最有代表性的真实 PenMark 桌面版截图。
7.3 为什么是 PenMark
用简短段落解释：
它不是另一套在线协作文档。
它是一张属于个人的长期纸张。
富文本友好。
本地优先。
内容可迁移。
7.4 核心场景
展示：
读书摘抄与心得
梦境与随笔
网页资料收藏
图片与图文档案
不要使用假统计数字，例如“10 万用户”“提升 300% 效率”。
7.5 功能亮点
建议包括：
打开就写
富文本粘贴
图片拖入与缩放
文件夹与大纲
链接卡片
本地数据
多格式导出
SQLite 旧数据导入
Markdown + 原始 HTML 迁移
快捷键
用简洁的粗线条 SVG 图标，保持与 PenMark Logo 调性一致。不要引入庞大图标库。
7.6 数据属于用户
这是 PenMark 最重要的展示段落。
建议大标题：
软件可以更换，内容不该被锁住。
准确说明：
桌面数据保存在本机。
可以备份数据库。
可以导出整个资料库。
Markdown 用于通用阅读和迁移。
原始 HTML 用于保留复杂图文。
未来目标是文件即真相。
不要声称当前已经完全达到 Obsidian 文件联动。
7.7 桌面版与 Node 版
简洁对比：
桌面版	Node 版
适合个人本地使用	适合开发、自托管
无需安装 Node.js	需要 Node.js
核心编辑无需登录	可保留用户和分享
数据位于 AppData	数据位于服务器目录

不要把表格做得像企业价格页。
7.8 隐私与网络
清楚说明：
核心本地编辑不需要联网。
普通笔记不会因为写作自动上传。
外部链接卡片需要抓取网页信息。
AI 功能需要用户自己配置并主动使用。
GitHub 下载和版本检查会访问网络。
不内置广告和跟踪器。
创建适合 PenMark 的隐私说明：
PRIVACY.md
以及主页可访问的隐私页面或链接。
隐私说明必须与实际代码一致，不能照抄 PicMark 的内容。
7.9 下载区
显示：
当前版本
Windows 64 位
安装包下载
GitHub Releases
从源码运行
说明：
安装包尚未数字签名时，Windows 可能提示未知发布者。
文件校验值可以从 Release 中的 SHA256SUMS 获取。
不要在网页中写死容易过期的 SHA-256，除非实现了可维护方式。
7.10 GitHub Star 与页脚
增加自然的 Star CTA，例如：
如果 PenMark 帮你留下了值得保存的东西，欢迎在 GitHub 留一颗星。
页脚：
PenMark 品牌
GitHub
Releases
README
隐私说明
MIT License
作者 Tsang12140
八、视觉要求
PenMark 主页应与产品本身一致：
温暖纸张背景。
墨色正文。
蓝色作为主要强调色。
可以有极少量绿色或暖金辅助，但不要复制 PicMark 的绿色主视觉。
大留白。
清晰的中文排版。
圆角克制，不要满屏卡片。
阴影轻。
真实产品截图是视觉中心。
图标使用简洁粗线条。
不做廉价渐变堆叠。
不做过度玻璃拟态。
不做企业 SaaS 仪表盘风。
不做 AI 科技紫。
不要自动播放视频。
不要用鼠标跟随特效。
动画必须克制。
支持：
@media (prefers-reduced-motion: reduce)
用户关闭动画时，页面仍完整显示。
九、SEO 与社交分享
主页 <head> 至少包含：
中文 title
description
canonical
favicon
Open Graph title
Open Graph description
Open Graph image
Open Graph URL
Twitter card
theme-color
GitHub Pages 地址需要根据仓库合理设置，例如：
https://tsang12140.github.io/PenMark/
注意 GitHub Pages 路径和仓库大小写。
Open Graph 图片优先复用或基于 PenMark 品牌资源制作静态图：
docs/assets/penmark-social-preview.png
不要放失效绝对路径。
可以增加：
robots.txt
sitemap.xml
但内容必须正确，不要为了凑文件生成错误链接。
十、GitHub Pages
为展示主页准备 GitHub Pages 部署。
优先创建：
.github/workflows/pages.yml
要求：
仅部署 docs/。
使用 GitHub 官方 Pages Actions。
在 main 分支相关文件变化时部署。
支持手动触发。
最小权限。
不在 workflow 中写 Token。
不上传整个仓库作为网页。
不构建 Electron。
不运行不必要的 npm install。
如果仓库当前已经有 Pages 部署方式，检查后兼容，不要重复创建冲突 workflow。
不能直接修改 GitHub 仓库 Pages 设置时，也要把本地 workflow 和说明准备完整，并在最终报告中告诉用户需要在 GitHub Settings → Pages 中做什么。
未经明确授权，不要擅自 force push、删除分支或覆盖线上主页。
十一、GitHub Releases 与下载链接
源码继续放同一个仓库：
https://github.com/Tsang12140/PenMark
Node 版和 Electron 版放同一个开源项目是合理的，因为它们共用编辑器和核心代码。
发布结构：
Git 仓库：源码、README、LICENSE、docs、构建脚本。
GitHub Releases：Windows EXE、可选便携 ZIP、SHA256SUMS。
不把 EXE 放入 Git 历史。
不提交 dist-desktop/。
不提交 node_modules/。
不提交数据库、日志、.env 和用户文档。
检查 electron-builder 的 artifactName。
如果目前生成：
PenMark Setup 1.0.0.exe
建议调整成便于 URL 和自动化的稳定名称：
PenMark-Setup-1.0.0-x64.exe
但修改后必须重新构建和测试，确保 README、主页和 Release 链接一致。
如果当前没有真实 Release：
主页按钮指向 Releases 列表。
README 写“前往 Releases 下载”。
不写不存在的直接下载链接。
最终报告列出发布 Release 后需要替换或确认的链接。
可以准备 GitHub Release workflow，但不要在没有授权、没有 Tag 或没有 GitHub 凭据时伪造“已发布”。
十二、README 与主页的一致性
必须统一：
产品名称
当前版本
GitHub 地址
GitHub Pages 地址
安装包名称
数据目录
默认端口
Electron 版本
Node 版本要求
测试命令
MIT License
旧数据导入能力
Markdown 当前阶段
未数字签名说明
已实现与未来功能
不要出现：
README 写 3000，代码实际 3001。
README 写 Electron 43，实际 package.json 是 Electron 42.6。
主页写完全离线，但链接卡片和 AI 实际需要联网。
主页写 Markdown 是正式数据源，但实际仍是 SQLite。
下载按钮指向不存在的文件。
主页版本与 package.json 不一致。
PicMark 品牌名称残留在 PenMark 页面中。
十三、测试要求
完成后必须运行：
npm test
node --check server.js
node --check public/app.js
node --check public/editor.js
node --check desktop/main.cjs
node --check desktop/preload.cjs
node --check desktop/exporter.cjs
node --check desktop/importer.cjs
node --check desktop/electron-task.cjs
git diff --check
主页测试：
本地打开或启动静态服务器查看 docs/index.html。
桌面宽屏布局。
1366×768。
平板宽度。
手机宽度。
导航跳转。
下载按钮。
GitHub 链接。
Releases 链接。
Privacy 链接。
License 链接。
图片全部加载。
favicon 正常。
控制台无异常。
无横向溢出。
动画关闭时可用。
键盘 Tab 可以操作。
图片有 alt。
外部链接使用 rel="noopener"。
页面不包含追踪脚本。
README 测试：
所有相对图片链接存在。
所有仓库文件链接存在。
Markdown 渲染结构正确。
没有本机绝对路径。
没有 Token、用户名密码和隐私信息。
没有虚假的 Release 下载链接。
License 测试：
LICENSE 是完整标准 MIT。
package.json 为 MIT。
README 和主页链接到 LICENSE。
第三方资源没有被错误重新授权。
如果可用，运行链接检查；如果没有相关工具，可以写一个轻量 Node 脚本检查本地相对链接，不要引入大型依赖。
十四、不要做的事
不只创建 LICENSE 后结束。
不只改 README 前三段后结束。
不只复制 PicMark 首页并替换名称。
不把 PicMark 的 Logo、绿色主色和产品截图用于 PenMark。
不伪造 PenMark 产品截图。
不编造用户数量、评分、下载量和媒体评价。
不编造不存在的 Release。
不把 EXE 提交进 Git。
不上传用户数据库。
不泄露 .env。
不为了主页引入 React、Vue、Next.js。
不依赖外部 CDN。
不添加统计追踪。
不添加自动播放。
不修改核心编辑器行为。
不删除现有用户修改。
不自动提交或推送，除非用户明确授权。
不把未测试内容写成已验证。
十五、完成标准
本次至少完成：
根目录标准 MIT LICENSE。
package.json 标记 MIT。
README 完整重写。
README 使用 PenMark 品牌 Logo。
README 至少一张真实产品截图。
docs/index.html 展示主页。
PenMark 自有品牌视觉。
响应式桌面和手机布局。
真实有效的 GitHub、Releases、Privacy、License 链接。
PRIVACY.md。
GitHub Pages workflow。
SEO/Open Graph。
下载区。
数据属于用户的核心表达。
Node 版与桌面版说明。
未签名提示。
Markdown 当前阶段说明。
所有自动测试通过。
所有语法检查通过。
git diff --check 通过。
没有覆盖用户已有修改。
十六、最终报告
最终报告必须列出：
新增和修改的文件。
LICENSE 内容与版权人。
README 的主要结构。
展示主页的主要结构。
使用了哪些 PenMark 品牌资源。
截图来源和保存位置。
GitHub Pages workflow。
预期 Pages 地址。
下载按钮当前指向哪里。
是否存在真实 Release。
是否还有需要用户在 GitHub 网页操作的设置。
运行了哪些测试。
测试结果。
无法验证的内容。
当前仍存在的发布风险。
是否修改了核心应用代码；如果修改，说明原因。
明确确认没有提交 EXE、数据库、.env 和用户文档。
不要在只完成计划或部分文件后结束。现在开始读取项目状态、PicMark 参考主页、PenMark 品牌资源和当前 README，然后持续实现直到全部可安全完成的事项结束。
```