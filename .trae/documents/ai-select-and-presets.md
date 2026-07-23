# 飞书式 Ctrl+A + 手机全选 + AI 预设改造 + 内部知识注入

## Context

用户提出四块需求：
1. 桌面端 Ctrl+A 要像飞书一样"按一次选段落、按两次选全文"，第一次还要弹 toast 提示
2. 手机端全选困难（远程桌面时更甚），需要在手机工具栏加全选按钮
3. AI 预设需要增强：新增"洗排版"预设（清洗格式+加粗重点+列大纲+两端对齐）、支持用户自定义预设（后端账号绑定）、AI 对话面板要能感知选区（用户反映"全选后去 AI 没看到东西"）
4. AI 要识别 PenMark 内部知识（理解"设成 H2"指 PenMark 的 H2 标题等）

根因排查："全选后去 AI 没看到东西"是因为 `refreshAiPanelContext`（app.js:2383）只显示文档名，不感知选区。

---

## 当前进度（续接，本轮已验证）

经 Phase 1 探索确认，以下已完成，无需重做：
- ✅ **Part 4b 数据库层**：`db.js:263-274` 已有 `ai_presets` 表（SQLite CREATE TABLE IF NOT EXISTS）；`database/migrations/008_ai_presets.sql` 已建（PostgreSQL）
- ✅ **Part 4b 后端 API**：`server.js:834-881` 已有 4 个 CRUD 路由；`server.js:887,894` `/api/ai/layout` 已接收并透传 `customPrompt` 给 `ai.layoutHtml`

以下为本轮待完成（按实施顺序）：
1. ⏳ Part 5 提示词共享（ai.js PENMARK_KNOWLEDGE + server.js 注入 chat）
2. ⏳ Part 4a wash 预设（ai.js + app.js AI_PRESETS）
3. ⏳ Part 4b 前端 UI（openAiLayoutModal 改造 + 辅助函数 + styles.css）
4. ⏳ Part 3 选区感知（refreshAiPanelContext + selectionchange）
5. ⏳ Part 1 Ctrl+A（keydown + 状态变量 + 快捷键面板）
6. ⏳ Part 2 手机全选按钮（index.html + handleAction）
7. ⏳ 全部改完后重新打包 asar（解包→替换 public/ + ai.js + server.js + db.js→重打包），用户重启 PenMark.exe

> 注意：`ai.layoutHtml` 后端签名当前仍是 2 参（`ai.js:100`），需在 Part 5 同步改为 3 参 `(html, preset, customPrompt)`，否则 server.js:894 透传 customPrompt 会被丢弃。

---

## Part 1：飞书式 Ctrl+A（桌面端）

**修改文件**：`public/app.js`

1. 在全局 keydown 处理器（app.js:3087）里，`if (k === '/')` 之后、`else if (k === 'a' && e.altKey)` 之前，插入 Ctrl+A 分支：
   - 守卫：`document.activeElement !== editorEl` 时不拦截（保留标题栏/搜索框的原生全选）
   - 第一次：`e.preventDefault()` + `editor._currentBlock()` 取当前块 + `editor.selectBlock(block)` 选中 + 记录时间戳 + `toast('连续按两次 Ctrl+A 选择全文')`
   - 第二次（500ms 内）：不 preventDefault，让浏览器原生全选，复位时间戳
   - 复用 editor.js:2084 `_currentBlock()` 和 editor.js:2140 `selectBlock()`
2. 顶部加状态变量 `let lastCtrlATime = 0;`
3. 在快捷键面板（app.js:3013 shortcutGroups）"段落"分组加 `['Ctrl/⌘ + A', '选中当前段落（再按一次选全文）']`

## Part 2：手机端全选按钮

**修改文件**：`public/index.html`、`public/app.js`

1. index.html:229 "更多"按钮之前插入全选按钮：`<button class="mt-btn" data-action="selectAll" title="全选">` + Lucide 图标（到 https://lucide.dev/icons/text-select 核对 path，viewBox="0 0 24 24" fill="none" stroke="currentColor"）
2. app.js:335 `handleAction` switch 加 `case 'selectAll': selectAllEditorContent(); break;`
3. 新增 `selectAllEditorContent()`：`editorEl.focus()` + Range.selectNodeContents(editorEl) + Selection.addRange，不调 execCommand（移动端可能越界）

## Part 3：AI 对话面板选区感知

**修改文件**：`public/app.js`

1. 改写 `refreshAiPanelContext`（app.js:2382）：检测 `window.getSelection()`，若编辑器内有非折叠选区，显示"已选 N 字：前50字…"；无选区时回退到文档名
2. 在 `selectionchange` 监听器（app.js:368）里，当 AI 面板打开时（`aiPanel && !aiPanel.hidden`）调用 `refreshAiPanelContext()`，保留原有 `savedAiRange` 逻辑

## Part 4a：新增"洗排版"预设

**修改文件**：`public/app.js`、`ai.js`

1. app.js:2296 `AI_PRESETS` 加 `wash: '洗排版'`
2. ai.js:86 `layoutPresetInstructions` 加 `wash` 指令（英文）：
   - 剥离所有内联 style（background/font-family/color/font-size 等）
   - H2 做大标题、H3 做小标题、NEVER use H1
   - 重点短语包 `<strong>`
   - 每个段落设 `style="text-align:justify"`
   - 不改任何文字

## Part 4b：自定义预设（后端账号绑定）

**新建文件**：`database/migrations/008_ai_presets.sql`（PostgreSQL）
**修改文件**：`db.js`、`server.js`、`ai.js`、`public/app.js`、`public/styles.css`

1. **数据库**：`ai_presets` 表（id, user_id, label, prompt, sort_order, created_at）
   - db.js 在 editor_actions 表（第 247 行）之后加 SQLite CREATE TABLE IF NOT EXISTS
   - 008_ai_presets.sql 给 PostgreSQL 用（SERIAL PRIMARY KEY）
   - 桌面端通过 `auth.ensureDesktopUser()` 有真实 user_id，天然支持
2. **API**（server.js，在 /api/ai/layout 之前）：
   - `GET /api/ai/presets` — 列出当前用户预设
   - `POST /api/ai/presets` — 新建（label ≤30字, prompt ≤1000字, 每用户限 20 个）
   - `PUT /api/ai/presets/:id` — 修改
   - `DELETE /api/ai/presets/:id` — 删除
   - 所有 SQL 用 `$1` 参数化占位符（SQLite 自动转 `?`）
3. **ai.js**：`layoutHtml(html, preset, customPrompt)` 加第三参数，preset='custom' 时用 customPrompt
4. **server.js /api/ai/layout**：接收 `customPrompt` 字段，透传给 `ai.layoutHtml`
5. **前端 app.js openAiLayoutModal**（app.js:2644）：
   - 打开时 `GET /api/ai/presets` 拉取自定义预设（失败静默，仍用内置）
   - 内置预设行下方加"我的预设"区，每个按钮含 Lucide 编辑(pencil)/删除(trash-2)小图标 + "新建"按钮(plus)
   - 新建/编辑用 `showPrompt`（app.js:247）两步收集名称和提示词
   - 删除用 `showConfirm`（app.js:242）
   - `runAiLayout(preset, customPrompt)` 透传 customPrompt
6. **styles.css**：追加 `.ai-preset-section`、`.ai-preset-custom`、`.ai-preset-icon`、`.ai-preset-add`、`.ai-preset-empty` 样式

## Part 5：AI 识别内部知识

**修改文件**：`ai.js`、`server.js`

1. ai.js 顶部定义 `PENMARK_KNOWLEDGE` 常量（数组 join '\n'）：
   - 编辑器内容模型（H1-H6/P/blockquote/pre/列表/table/hr + strong/em/code/a）
   - 标题层级语义：H1 顶级（通常不用）、H2 大标题、H3 小标题、H4-H6 更深
   - 段落默认两端对齐
   - 自定义块元素（.link-card/.img-container/.img-grid）必须保留原样
   - "设成 H2"→包 `<h2>`、"加粗"→包 `<strong>`、"设成引用"→formatBlock BLOCKQUOTE
2. `layoutHtml` 系统提示词（ai.js:102）追加 PENMARK_KNOWLEDGE
3. `module.exports` 暴露 `PENMARK_KNOWLEDGE`
4. server.js `/api/ai/chat` 的 `systemParts`（当前在 server.js:988 附近的 `const systemParts = [...]`）追加 `ai.PENMARK_KNOWLEDGE`
5. 不注入到 `rewriteSelection`（选区改写无需编辑器知识）

---

## 实施顺序

1. Part 4b 数据库层（db.js + 008_ai_presets.sql）
2. Part 4b 后端 API（server.js CRUD + /api/ai/layout 加 customPrompt）
3. Part 5 提示词共享（ai.js PENMARK_KNOWLEDGE + server.js 注入）
4. Part 4a wash 预设（ai.js + app.js AI_PRESETS，依赖 Part 5）
5. Part 4b 前端 UI（openAiLayoutModal 改造 + 辅助函数 + CSS）
6. Part 3 选区感知（refreshAiPanelContext + selectionchange）
7. Part 1 Ctrl+A（keydown + 状态变量 + 快捷键面板）
8. Part 2 手机全选按钮（index.html + handleAction）

Part 1/2/3 纯前端无依赖可并行；Part 4a 依赖 Part 5；Part 4b 前后端有依赖。

## 验证

- **Ctrl+A**：编辑器内按一次→选当前段落+toast；500ms 内再按→选全文；标题栏按 Ctrl+A→原生选标题文本
- **手机全选**：手机端/窄窗口触摸设备工具栏出现全选按钮，点击选编辑器全文
- **AI 面板选区**：编辑器选中文字→打开 AI 对话面板→上下文显示"已选 N 字…"
- **洗排版**：AI 排版模态框选"洗排版"→生成预览→检查无内联样式/H2-H3层级/两端对齐/重点加粗
- **自定义预设**：新建→编辑→删除→选中自定义预设→生成预览→应用
- **内部知识**：AI 对话里说"把第一段设成 H2"→AI 返回包含 `<h2>` 的指导
- **桌面端**：改完后重新打包 asar（解包→替换 public/ + ai.js + server.js + db.js→重打包），用户重启 PenMark.exe
