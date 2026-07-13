<p align="center">
  <img src="public/PenMark_Brand_Assets/penmark-logo-horizontal-light.svg" alt="知著 PenMark" width="320">
</p>

<p align="center">
  打开就写，内容永远带得走。
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-blue">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-%3E%3D18-green">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-42-orange">
  <img alt="Local First" src="https://img.shields.io/badge/Local_First-✓-success">
</p>

<p align="center">
  <a href="https://github.com/Tsang12140/PenMark/releases">前往 Releases 下载</a>
  ·
  <a href="https://tsang12140.github.io/PenMark/">展示主页</a>
  ·
  <a href="PRIVACY.md">隐私说明</a>
</p>

---

知著 PenMark 是一款本地优先的个人长期记录软件。记录读书心得、原文摘抄、梦境与随笔，富文本和图片留在本地，不被账号、广告和设备数量绑住。

## 为什么做 PenMark

印象笔记、有道云等产品可能存在广告、设备和产品策略限制。Obsidian 本地可靠，但 Markdown 和同步有学习成本。Notion、飞书更偏云端结构化或协作。

PenMark 希望提供一张本地优先、富文本友好的个人纸张——打开就能写，内容永远带得走。

## 核心特点

- **富文本编辑** — contenteditable 编辑器，支持标题、列表、引用、代码块、表格
- **本地桌面版** — Electron 桌面应用，双击即用，无需浏览器
- **核心离线可用** — 新建、输入、粘贴、保存均不依赖网络
- **文档与文件夹** — 朴素的文档 + 文件夹模型，不引入复杂 block schema
- **大纲导航** — 自动从标题生成目录大纲
- **图片拖入与缩放** — 拖入即插入，支持缩放、对齐、复制
- **链接与链接卡片** — 普通链接 + 富文本链接卡片（自动抓取 OG 元数据）
- **富文本粘贴** — 公众号、飞书、网页图文粘贴尽量保真
- **多格式导出** — Word、HTML、Markdown、长图
- **资料库批量导出** — 整个资料库导出为 Markdown + Frontmatter 文件夹
- **原始 HTML 无损副本** — 每篇文档保留原始 HTML，确保复杂内容不丢失
- **旧版 SQLite 数据导入** — 支持旧版 PenMark SQLite 数据库导入
- **本地数据备份** — 一键备份数据库
- **中文界面** — 完整中文 UI 和快捷键

> Markdown 文件暂时还不是唯一正式数据源，当前仍以 SQLite + HTML 为正式存储。文件监听尚未实现。

## 下载

### Windows 桌面版（推荐普通用户）

前往 [GitHub Releases](https://github.com/Tsang12140/PenMark/releases) 下载 `PenMark-Setup-1.0.0-x64.exe` 安装包。

- 无需安装 Node.js
- 无需浏览器
- 核心编辑无需登录
- 数据保存在 `%APPDATA%\PenMark\`

> 安装包尚未数字签名，Windows 可能提示"未知发布者"。点击"仍要运行"即可继续。

### Node 网页版（适合开发者和自托管）

```bash
git clone https://github.com/Tsang12140/PenMark.git
cd PenMark
npm install
npm start
```

默认运行在 `http://localhost:3001`。

## 两种运行方式

| | 桌面版 | Node 版 |
|---|---|---|
| 适合 | 个人本地使用 | 开发、自托管 |
| Node.js | 不需要 | 需要 |
| 登录 | 不需要 | 可保留用户和分享 |
| 数据位置 | `%APPDATA%\PenMark\` | 项目 `data/` 目录 |
| 端口 | 动态空闲端口（仅 127.0.0.1） | 3001 |

## 开发与构建

### 环境要求

- Node.js >= 18（推荐 22.x）
- Windows 10/11 x64
- Python 3 和 Visual Studio Build Tools（编译原生模块）

### 常用命令

```bash
npm install                # 安装依赖
npm test                   # 运行全部测试
npm start                  # 启动网页版服务器（端口 3001）
npm run desktop:dev        # 启动桌面开发模式
npm run desktop:dist       # 构建 Windows NSIS 安装包
npm run rebuild            # 为 Electron 重新编译 better-sqlite3
npm run rebuild:node       # 为 Node.js 重新编译 better-sqlite3
```

### 构建产物

```
dist-desktop/
├─ PenMark-Setup-1.0.0-x64.exe    # NSIS 安装包
└─ win-unpacked/                   # 解包版
    └─ PenMark.exe
```

`dist-desktop/` 已加入 `.gitignore`，不提交到 Git。

### better-sqlite3 ABI 切换

better-sqlite3 是原生模块，需要匹配运行时的 ABI：

- **网页模式**：`npm run rebuild:node`（Node.js ABI）
- **桌面模式**：`npm run rebuild`（Electron ABI）

`electron-builder` 打包时会自动处理原生模块，无需手动干预。

## 数据与隐私

### 数据存储位置

| 模式 | 路径 |
|------|------|
| 桌面生产 | `%APPDATA%\PenMark\` |
| 桌面开发 | `%APPDATA%\PenMark-Dev\` |
| 网页版 | 项目目录 `data/` |

```
%APPDATA%\PenMark\
├─ penmark.db              # SQLite 数据库
├─ penmark.db-wal          # WAL 日志
├─ assets\                 # 附件
├─ backups\                # 备份
├─ logs\                   # 日志
└─ window-state.json       # 窗口状态
```

### 备份与导出

- **备份数据库**：桌面版菜单 `文件 → 备份数据库…`
- **导出资料库**：桌面版菜单 `文件 → 导出资料库…`，导出为 Markdown + Frontmatter 文件夹
- **单篇导出**：支持 Word、HTML、Markdown、长图

### 网络行为

- 核心本地编辑**不需要联网**
- 普通笔记不会因为写作自动上传
- **链接卡片**需要访问目标网页抓取元数据（标题、描述、图片）
- **AI 功能**需要用户自行配置 API Key 并主动使用
- GitHub 下载和版本检查会访问网络
- 不内置广告和跟踪器

详见 [PRIVACY.md](PRIVACY.md)。

## Markdown 资料库阶段

**当前状态**：SQLite + HTML 是正式数据源，Markdown 是批量导出和迁移格式。

- 已实现：整个资料库导出为 Markdown 文件夹
- 已实现：图片附件导出
- 已实现：每篇文档保留原始 HTML 无损副本
- 已实现：旧版 SQLite 数据导入
- 尚未实现：Markdown 资料库导入
- 尚未实现：文件监听和"文件即真相"模式

**未来目标**：`.md` 文件成为正式数据，SQLite 退化为缓存和索引，文件夹就是分类，图片成为普通附件，支持 OneDrive、Syncthing、Git 等同步。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+N` | 新建文档 |
| `Ctrl+S` | 保存 |
| `Ctrl+B` | 加粗 |
| `Ctrl+I` | 斜体 |
| `Ctrl+U` | 下划线 |
| `Ctrl+K` | 插入链接 |
| `Ctrl+Shift+M` | 行内代码 |
| `Ctrl+Shift+7` | 有序列表 |
| `Ctrl+Shift+8` | 无序列表 |
| `Ctrl+Alt+Q` | 引用块 |
| `Ctrl+Alt+C` | 代码块 |
| `Ctrl+Alt+T` | 表格 |
| `Ctrl+Alt+R` | 阅读模式 |
| `Ctrl+/` | 快捷键面板 |

## 项目状态

当前处于早期个人项目阶段。建议先备份数据再升级。欢迎在 [GitHub Issues](https://github.com/Tsang12140/PenMark/issues) 提交反馈。不承诺企业级稳定性。

## Roadmap

按真实优先级：

1. Markdown 资料库导入
2. 文件监听
3. 文件即真相
4. 更完整的数据迁移
5. 搜索与回顾
6. 可选的轻量同步
7. 性能和稳定性
8. 代码签名

## 贡献

欢迎 Fork、新建分支、测试后提交 PR。

- 不要提交真实数据库、Token、.env 和用户笔记
- 修改写作热路径时遵守 [AGENTS.md](AGENTS.md) 中的铁律
- 不引入 React、Vue 等大型框架重做界面

## License

[MIT](LICENSE) © 2026 Tsang12140

## 技术栈

- **Node.js + Express** — 本地服务
- **better-sqlite3** — 数据存储
- **Electron 42** — 桌面外壳
- **electron-builder** — Windows 安装包构建
- **原生 HTML/CSS/JavaScript** — 前端（无框架依赖）
- **contenteditable** — 富文本编辑器
