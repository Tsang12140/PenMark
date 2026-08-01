# PenMark 新一轮优化任务清单

> 上次你做的 8 项改动都在工作区里，还没 commit。下面是要继续做的。

---

## P0 · 重大 Bug

### 1. `readShareCookies` 拼写错误 → 加密分享全部 500
- **文件**：`server.js`
- **行号**：1444
- **现状**：写了 `auth.readShareCookies(req)`（复数），但 `auth.js` 只导出 `readShareCookie`（单数）
- **影响**：所有加密分享的文档加载请求都触发 `TypeError`，返回 500
- **修复**：改为 `auth.readShareCookie(req)`
- **对比**：同文件 1460 行和 1481 行已经正确用了单数形式

### 2. 新建文档阻塞在网络请求上
- **文件**：`app.js`
- **行号**：1938-1962
- **问题**：`newDoc()` 先 `await api('/api/documents', 'POST', ...)` 再 `await loadSidebar()`，两个网络请求串行阻塞，违反 AGENTS.md <100ms 铁律
- **修复**：乐观创建 — 立即显示本地临时文档（`id: 'local-'+Date.now()`），`editor.clear()` + `docTitleEl.focus()` 先执行，后台异步 POST 后替换为真实 ID

### 3. AI 对话面板无停止按钮
- **文件**：`app.js`
- **行号**：2829-2876
- **问题**：`sendAiMessage()` 调用 `api()` 没有传 `signal`，用户发送 AI 消息后无法取消。但 `runAiRewrite`（3477 行）已经用了 `aiAbortController`，两处不一致
- **修复**：给 `sendAiMessage()` 加独立的 `AbortController`，发送按钮变成「停止」按钮

### 4. 粘贴清洗不保留公众号 `<style>`
- **文件**：`editor.js`
- **行号**：1761
- **问题**：`_cleanPastedHTML` 中 `body.querySelectorAll('style, ...').forEach(n => n.remove())` 直接删除所有 `<style>`，导致公众号文章品牌色、自定义字体丢失
- **修复**：对 `<style>` 做安全清洗而非直接删除 — 过滤 `@import` 和 `url()` 危险引用，保留纯内联样式声明

### 5. 编辑器切文档无加载状态
- **文件**：`app.js`
- **行号**：3697-3706
- **问题**：`openDoc()` 在 `editor.setHTML()` 之前编辑器显示旧内容或空白，网络慢时闪烁
- **修复**：`setHTML` 前加编辑器骨架屏或「加载中…」遮罩

### 6. Esc 键不关闭 AI 对话面板
- **文件**：`app.js`
- **行号**：3650
- **问题**：Escape 键处理只关闭 `shortcutHelp` 和 `aiModal`，不处理 `aiPanel`
- **修复**：加入 `if (aiPanel && !aiPanel.hidden) { closeAiPanel(); return; }`

---

## P0 · 图标系统违规（AGENTS.md 铁律）

> **铁律原文**：所有 UI 图标必须走 Lucide 开源图标库路线，viewBox 永远是 `0 0 24 24`。禁止 emoji、字符画（◐ × ✕ ✎）、自制 16×16 SVG。

### HTML 文件中的字符画图标

| 文件 | 行号 | 违规内容 | 替换为 Lucide |
|------|------|---------|--------------|
| `index.html` | 43 | `◐` 主题切换按钮 | `sun-moon` |
| `index.html` | 359 | `×` shareModalClose | `x` |
| `index.html` | 450 | `×` aiModalClose | `x` |
| `index.html` | 460 | `×` settingsModalClose | `x` |
| `index.html` | 477 | `×` trashModalClose | `x` |
| `index.html` | 484 | `✕` readingExit | `x` |
| `index.html` | 497 | `×` exportImageClose | `x` |

### JS 生成 HTML 中的字符画图标

| 文件 | 行号 | 违规内容 | 替换为 Lucide |
|------|------|---------|--------------|
| `app.js` | 1572 | `×` 侧边栏删除按钮 | `trash-2` |
| `app.js` | 3621 | `×` 快捷键面板关闭 | `x` |
| `app.js` | 4568 | `×` 敏感词标签移除 | `x` |
| `share.js` | 421 | `⊘` 分享页错误图标 | `alert-circle` |

### 非标准 viewBox SVG

| 文件 | 行号 | 当前 | 替换为 Lucide |
|------|------|------|--------------|
| `index.html` | 46 | 搜索 `viewBox="0 0 20 20"` | `search` |
| `index.html` | 302 | 浮动菜单箭头 `16x16` | `chevron-down` |
| `index.html` | 344 | 块操作手柄 `16x16` 6点 | `grip-vertical` |
| `login.html` | 52/53/76/77 | 密码显隐 `16x16`（4处） | `eye` / `eye-off` |

### 移动端工具栏自制 16x16 SVG（app.js:4308-4337）

这些全部是自制 `viewBox="0 0 16 16"` SVG，共 12 个。逐一替换为 Lucide 24x24：

| 当前语义 | 替换为 |
|---------|--------|
| 代码块 | `code-xml` |
| 无序列表 | `list` |
| 有序列表 | `list-ordered` |
| 行内代码 | `code` |
| 清除格式 | `remove-formatting` |
| 表格 | `table` |
| 分隔线 | `minus` |
| 目录 | `list-tree` |
| 图片 | `image` |
| 主题 | `sun-moon` |
| 导出 Word | `file-down` |
| 导出 HTML | `file-code` |
| 导出 MD | `file-down` |
| 导出图片 | `image-down` |
| 阅读模式 | `book-open` |

（注意：同一组中引用 4308 和 AI 排版 4325 已经是正确的 24x24，不用动）

### 其他非标准 SVG

| 文件 | 行号 | 问题 | 替换为 |
|------|------|------|--------|
| `app.js` | 1498-1542 | 侧边栏文件夹图标 `16x16`（4处） | `chevron-right` / `folder` |
| `app.js` | 4274/4283 | 用户下拉菜单图标 `16x16`（2处） | `sun-moon` / `log-out` |
| `app.js` | 4603 | 邀请码复制图标 `16x16` | `copy` |
| `share.js` | 563 | 访客列表箭头 `16x16` | `chevron-down` |

---

## P1 · 体验缺陷

### 7. 搜索无「无结果」空状态
- **文件**：`app.js` 2108 行附近
- **问题**：用户搜一个不存在的词，侧边栏完全空白，没有任何提示
- **修复**：在 `renderSidebar()` 或搜索回调中加「未找到匹配文档」提示

### 8. 缺失 PDF 导出
- **文件**：`index.html` 151-159
- **问题**：有 MD/HTML/Word/图片导出，但没有 PDF
- **修复**：加「导出 PDF」菜单项，用 `window.print()` 或轻量 PDF 方案

### 9. AI 对话错误消息无视觉区分
- **文件**：`app.js` 2869 行
- **问题**：错误以「（请求失败：xxx）」形式追加为普通助手气泡，看不出是错误
- **修复**：用红色/警告样式渲染，或加 `.ai-msg-error` CSS 类

### 10. AI 面板消息滚动后无「回到底部」按钮
- **文件**：`app.js` 2780 行
- **问题**：用户向上翻历史消息时，新消息不会自动滚到底
- **修复**：加浮动「回到底部」按钮，`scrollTop + clientHeight < scrollHeight - 100` 时显示

### 11. 分享页登录按钮太低调
- **文件**：`share.html` 31-34，`styles.css` 2742
- **问题**：按钮样式和主题切换完全一样，首次访客几乎注意不到
- **修复**：加微妙的主题色边框或彩色文字，让 CTA 稍微醒目但不突兀

### 12. 导出操作无 loading
- **文件**：`app.js` 2259-2280
- **问题**：导出 docx/HTML 可能需几秒，但没有进度提示，用户可能重复点
- **修复**：加 `exporting = true` 门限或 toast「正在导出…」

### 13. 生产环境残留 console 日志
- `app.js:1054` — `console.warn('move block failed', err)` → 改 toast
- `share.js:511-512` — 两处 `console.warn('[visit] 上报异常...')` → 删掉或静默

### 14. 粘贴不处理公众号图片尺寸数据
- **文件**：`editor.js` 1763-1771
- **问题**：只提了 `data-src` → `src`，不处理 `data-w`（原始宽度）和 `data-ratio`（宽高比）
- **修复**：读取 `data-w` 设为 `width` 属性

### 15. AI 面板移动端无响应式
- **文件**：`styles.css`
- **问题**：面板宽度固定，375px 屏幕可能溢出
- **修复**：加 `@media (max-width:760px)` 下 `.ai-panel { width: 100vw; right: 0; }`

---

## P2 · 完善度

### 16. 缺失自定义 404 页面
- **位置**：`server.js` 1707 行
- **问题**：`/s/:token` 无效时返回裸 `<h1>` 字符串，无品牌无返回链接
- **修复**：在 `public/` 下加 `404.html`，Express 末尾加通配 404 处理器

### 17. AI 对话面板首次打开无引导
- **文件**：`app.js` 2829
- **问题**：首次打开 AI 面板消息区完全空白
- **修复**：加 `<div class="ai-msg-hint">输入消息开始与 AI 对话</div>` 占位

### 18. 分享页 footer logo 视觉不居中
- **文件**：`styles.css` 3539-3560
- **问题**：Logo SVG 左边图标+右边文字不对称，CSS `align-items:center` 几何居中但视觉偏右
- **修复**：给 `.share-footer-brand` 加 `margin-left: -8px` 或使用纯图标版 logo

### 19. Ctrl+Shift+D 与浏览器快捷键冲突
- **文件**：`app.js` 3605-3613
- **问题**：`Ctrl+Shift+D` 导出 Markdown，与 Chrome 添加书签冲突
- **修复**：改用 `Ctrl+Alt+D` 或 `Ctrl+Shift+M`

### 20. 移动端导出菜单无格式标签
- **文件**：`index.html` 154-158
- **问题**：导出格式描述只在 `title` 属性里（hover 可见），移动端看不到
- **修复**：每个菜单项加格式标签文案，如「Word 文档 · .docx」

---

## 上次对话的修正

### 21. 推特卡片的正确需求（之前做岔了，OG meta 保留不动）
- **实际需求**：编辑器里粘贴 URL → 调 `/api/og` 抓 og:title/og:image/og:description → 在前端渲染成 **Twitter/X 风格的预览卡片**（长方形卡片 + 右下角斜插圆角矩形封面图）
- **实现**：前端 paste 事件检测 URL → 调 `/api/og`（已有）→ 拿到数据后 editor 光标处 insert 卡片 HTML
- **卡片 HTML 规格**：圆角矩形卡片，左侧标题/域名/摘要，右侧 og:image 封面图，图片带 `rotate(-4deg)` 斜插效果。卡片可点击打开链接，旁边有「恢复为文本链接」按钮
- **注意**：之前加的 `/s/:token` OG meta 标签和短分享码保留，那个功能本身没错

---

## 汇总

| 优先级 | 数量 | 类别 |
|--------|------|------|
| P0 Bug | 6 | 加密分享崩溃 + 性能 + AI面板 |
| P0 图标 | 约 40 处 | 字符画 + 非标准SVG → Lucide 24x24 |
| P1 | 9 | 搜索/PDF/错误处理/响应式 |
| P2 | 5 | 404/引导/UI对齐/快捷键 |
| 修正 | 1 | 链接转卡片 |

**所有改动目前都在本地工作区，还没 commit。上次的 8 项改动也在。**
