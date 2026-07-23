# 工具栏溢出折叠 + Icon 修正：验证与收尾计划

## Summary

用户反馈两类问题：
1. **工具栏按钮挤压到第二行**——要求按飞书做法做溢出折叠（宽度不够时低频按钮收进「⋯ 更多」下拉，一行不换行）。
2. **Icon 错配**——"导入 HTML"按钮原先用了 download 图标，应换成更贴切的 folder-open；"导出文档"按钮的 icon 必须换成 download。

经核查，**这些改动在上一轮会话中已全部落地**（index.html / styles.css / app.js 三处代码均在位，三个已知 bug 也已修复）。本轮不再重复实现，而是做一次完整的**运行时验证**，确认实际效果符合预期；若验证暴露问题，再就地修复。

## Current State Analysis（基于实际文件读取，非假设）

### 已落地改动（均经 Read 确认）

**index.html**
- 导入按钮 icon 已换成 folder-open，并加 `data-overflow-priority="2" data-label="导入 HTML"`（[index.html:149](file:///d:/personal/cc/PenMark/public/index.html#L149)）。
- 导出按钮 icon 已换成 download，caret 换成 chevron-down SVG（[index.html:152](file:///d:/personal/cc/PenMark/public/index.html#L152)）。
- 15 个可折叠按钮全部带 `data-overflow-priority` + `data-label`（underline=4, strikeThrough=1, todo=2, quote=2, justifyCenter=4, justifyRight=1, justifyFull=1, code=2, codeblock=2, table=2, hr=1, toc=1, removeFormat=2, paintFormat=3, importHtml=2）。
- `#overflowDropdown` 骨架已插入，含 `#overflowToggle`（三点 SVG，fill 圆点）+ `#overflowMenu`（[index.html:160-165](file:///d:/personal/cc/PenMark/public/index.html#L160-L165)）。

**styles.css**
- `.toolbar` `flex-wrap:nowrap`（[styles.css:498](file:///d:/personal/cc/PenMark/public/styles.css#L498)）——保证不换行。
- `.tb-dropdown .caret` SVG 尺寸（[styles.css:1215](file:///d:/personal/cc/PenMark/public/styles.css#L1215)）。
- `#overflowDropdown[hidden]{display:none!important}` 覆盖 `.tb-dropdown{display:inline-flex}`（[styles.css:1237](file:///d:/personal/cc/PenMark/public/styles.css#L1237)）。
- `#overflowMenu` 复用 `.dropdown-menu`（absolute, top:100%, right:0），并叠加 `#overflowMenu .tb-btn` 行项样式（图标+`::after{content:attr(data-label)}`文字）+ 三主题 hover（[styles.css:1240-1265](file:///d:/personal/cc/PenMark/public/styles.css#L1240-L1265)）。

**app.js** — IIFE `initToolbarOverflow`（[app.js:324-480](file:///d:/personal/cc/PenMark/public/app.js#L324-L480)）
- Phase 1：`isOverflowing()` 时按优先级升序 fold（Comment 占位记原位）。
- Phase 2：**直接 unfold 实测** `isOverflowing()`，溢出则 refold+break（已删除旧 `hasSpareRoom`/`HYSTERESIS`——旧逻辑因 `scrollWidth` 退化误判"无富裕空间"导致宽屏不回位）。
- Phase 3：`#overflowDropdown` 显隐同步。
- toggle / 外部点击 / Escape / 与导出菜单互斥，全部就绪。
- `attrMo` 过滤 `overflowMenu`/`overflowDropdown` 自身变化，避免"点开菜单→触发 relayout→被关掉"死循环。
- ResizeObserver（toolbar + sidebar）+ body.class MutationObserver + rAF 节流。

### 已知风险点（上一轮未重新验证）

上一轮 browser 验证在 hasSpareRoom 修复**前**发现：宽屏（`toolbar.style.width='2000px'`）下 `overflowMenuCount` 仍为 15、按钮未回位。修复已写入但**尚未重新验证**。这是本轮验证的重点。

### 运行环境
- 后台服务 `job-adbb2c614a8447fbbf82834fbdc3d438`，SQLite 模式，`http://localhost:3001`，管理员 `18818601864 / 789789`。
- server 直接读 `public/`，浏览器硬刷新即生效，无需重启。

## Proposed Changes

本轮**主体是验证**，不预设代码改动。仅当验证暴露真实问题时才按下述预案修复。

### 步骤 1：browser agent 完整验证矩阵

登录 `localhost:3001`（18818601864/789789），打开任意文档，硬刷新后逐项验证：

| # | 场景 | 期望 | 失败时预案 |
|---|---|---|---|
| 1 | 控制台无 JS 错误 | 0 error | 按 stack 定位修复 |
| 2 | 导入按钮 icon | folder-open（打开的文件夹） | 查 index.html:149 |
| 3 | 导出按钮 icon | download（下箭头入托盘） | 查 index.html:152 |
| 4 | 工具栏单行不换行 | toolbar.offsetHeight ≈ 49px | 查 flex-wrap:nowrap 是否被覆盖 |
| 5 | 窄屏（toolbar.width=400px） | overflowDropdown 可见、overflowMenu 内有折叠项、priority 按钮按升序进菜单 | 查 Phase 1 fold 逻辑 |
| 6 | **宽屏（toolbar.width=2000px）** | overflowDropdown hidden、overflowMenu 清空、15 个 priority 按钮全部回原位 | **重点**：查 Phase 2 unfold + isOverflowing |
| 7 | 打开「⋯ 更多」菜单 | aria-expanded=true、菜单可见、含图标+文字行项 | 查 attrMo 死循环是否真的已消除 |
| 8 | 菜单内点击按钮（如"待办事项"） | 功能生效 + 菜单关闭 | 查事件委托 + overflowMenu click handler |
| 9 | 导出菜单与更多菜单互斥 | 开一个关另一个 | 查互斥 click handler |
| 10 | 三主题（light/dark/feishu） | 菜单 hover 色正确、icon 可见 | 查 [data-theme] hover 规则 |
| 11 | 中等宽度（拖拽浏览器窗口） | 实时折叠/回挪、无闪烁 | 查 ResizeObserver + rAF |
| 12 | 切阅读模式再切回 | 工具栏重算正确 | 查 toolbarVisible() + bodyMo |

### 步骤 2：按预案修复（仅必要时）

- 若 #6 仍失败：在 relayout Phase 2 加日志确认 `isOverflowing()` 实测值，检查 unfold 后 `toolbar.scrollWidth` 是否真的回落；极端情况补一个"全 unfold 后再逐个 fold"的兜底分支。
- 若 #7 失败（死循环复发）：确认 attrMo 回调 `m.target` 比较的是 DOM 节点本身而非包装对象；必要时改用 `m.target.closest('#overflowDropdown,#overflowMenu')` 判断。
- 其余按报错栈就地修复。

### 步骤 3：向用户报告

验证全过后，简明汇报：icon 已换、工具栏飞书式折叠已生效、宽窄屏均一行不换行；若有修复，说明修了什么。

## Assumptions & Decisions

- **不重做已落地的实现**：三文件代码经 Read 确认完整且自洽，重写只会引入回归。
- **验证用 browser agent**：需要真实布局计算（scrollWidth/clientWidth）和交互（点击/拖拽），静态读码无法替代。
- **优先级表沿用上一轮分配**：低频（删除线/右对齐/两端对齐/分隔线/目录=1）先折叠，高频（下划线/居中=4）最后折叠；加粗/斜体/列表/链接/撤销重做/AI/导出/阅读/分享永不折叠。
- **不加 `overflow:hidden`**：靠 JS 折叠保证 `scrollWidth ≤ clientWidth`，避免裁掉 absolute 子菜单。
- **事件委托零改动**：`#toolbar` 上的 click 委托用 `closest('.tb-btn')` 匹配，菜单内按钮仍在 `#toolbar` 子树，`handleAction` 无需改。

## Verification

即步骤 1 的 12 项矩阵。全部通过即视为完成；任一失败进入步骤 2 修复后重验该项。
