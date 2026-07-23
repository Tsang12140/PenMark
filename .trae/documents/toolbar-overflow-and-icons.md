# 工具栏溢出折叠（飞书式「⋯ 更多」）+ Icon 替换

## Context（为什么改）

用户反馈工具栏按钮挤压到第二行。根因：`.toolbar` 用 `flex-wrap:wrap`（[styles.css:498](file:///d:/personal/cc/PenMark/public/styles.css#L498)），一行塞了约 30 个控件，挤不下就换行。

同时发现导入/导出按钮 icon 装反了：
- 「打开文件」（导入 HTML，[index.html:149](file:///d:/personal/cc/PenMark/public/index.html#L149)）用的是 **download**（向下箭头）❌
- 「导出文档」（[index.html:152](file:///d:/personal/cc/PenMark/public/index.html#L152)）用的是 **upload**（向上箭头）❌

目标：飞书式溢出折叠——宽度不够时按优先级把低频按钮收进右侧「⋯ 更多」下拉，保证一行不换行；宽度恢复按原位移回。同时修正导入/导出 icon 语义。

## 可行性关键（已确认）

- 事件委托根是 `#toolbar`（[app.js:293-304](file:///d:/personal/cc/PenMark/public/app.js#L293)），用 `e.target.closest('.tb-btn')` 匹配 `data-cmd`/`data-action`。**把 `.tb-btn` DOM 移到 `#toolbar` 内的 `#overflowMenu`，事件天然 work，`handleAction` 零改动。**
- 导出下拉模式（[app.js:307-318](file:///d:/personal/cc/PenMark/public/app.js#L307)）：toggle `stopPropagation` + 菜单项点击关闭 + `document` click 关闭 → 可复用。
- 下拉样式（[styles.css:1214-1234](file:///d:/personal/cc/PenMark/public/styles.css#L1214)）：`.tb-dropdown`/`.dropdown-menu[hidden]`/`.dropdown-item` → 可复用。

## 改动一：Icon 替换（index.html）

**导入按钮（line 149）** → Lucide `folder-open`（打开的文件夹，"打开文件"语义）：
```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 1.515L22.84 14"/><path d="M6 14h12a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2a2 2 0 0 1 1-1.732z"/></svg>
```

**导出按钮（line 152）** → Lucide `download`（向下箭头，"下载到本地"语义）；同时把违反 AGENTS.md「禁止字符画」的 `▾` 换成 Lucide `chevron-down` SVG：
```html
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
```

> 分享按钮 `#shareBtn`（line 163）保持纯文字「分享」不变，不参与本次改动。

## 改动二：可折叠按钮加属性（index.html）

只给「可折叠」按钮加 `data-overflow-priority`（数字越小越先折叠）和 `data-label`（菜单内文字）。**不加属性 = 永不折叠。**

优先级分配：

| 按钮 | data-cmd/action | priority | data-label |
|---|---|---|---|
| 删除线 | strikeThrough | 1 | 删除线 |
| 右对齐 | justifyRight | 1 | 右对齐 |
| 两端对齐 | justifyFull | 1 | 两端对齐 |
| 分隔线 | hr | 1 | 分隔线 |
| 目录 | toc | 1 | 目录 |
| 待办事项 | todo | 2 | 待办事项 |
| 引用块 | quote | 2 | 引用块 |
| 行内代码 | code | 2 | 行内代码 |
| 代码块 | codeblock | 2 | 代码块 |
| 表格 | table | 2 | 表格 |
| 清除格式 | removeFormat | 2 | 清除格式 |
| 导入 HTML | importHtml | 2 | 导入 HTML |
| 格式刷 | paintFormat | 3 | 格式刷 |
| 下划线 | underline | 4 | 下划线 |
| 居中对齐 | justifyCenter | 4 | 居中对齐 |

**永不折叠**：字体/段落 select、加粗、斜体、无序列表、有序列表、左对齐、链接、撤销、重做、AI 排版、AI 对话、导出下拉、阅读模式、分享、访客统计（非 `.tb-btn`，独立 handler）。

## 改动三：新增「⋯ 更多」下拉（index.html）

插入位置：`#exportDropdown`（line 159 闭合）之后、最后一组（reading/shareBtn，line 161）之前。仍在 `#toolbar` 内。
```html
<div class="tb-dropdown" id="overflowDropdown" hidden>
  <button class="tb-btn" id="overflowToggle" type="button" title="更多" aria-haspopup="true" aria-expanded="false">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>
  </button>
  <div class="dropdown-menu" id="overflowMenu" hidden></div>
</div>
```
> 用 Lucide `ellipsis`（三个实心圆点），圆点 `fill="currentColor" stroke="none"`（与 [index.html:125](file:///d:/personal/cc/PenMark/public/index.html#L125) 的 `hr` 按钮惯例一致），17px 下描边小圆会糊，必须填充式。

## 改动四：CSS（styles.css）

1. **`.toolbar`（line 498）`flex-wrap:wrap` → `nowrap`**。不加 `overflow:hidden`（会裁掉 `#exportMenu`/`#overflowMenu` 这些 absolute 子菜单），靠 JS 折叠保证 `scrollWidth ≤ clientWidth`。
2. **追加** `#overflowDropdown[hidden]{display:none!important;}`（覆盖 `.tb-dropdown{display:inline-flex}` 同特异性问题）+ `#overflowToggle svg{width:17px;height:17px;}`。
3. **`#overflowMenu` 内 `.tb-btn` 样式**：从图标方块改成「图标 + 文字」行项，用 `::after{content:attr(data-label);}` 显示文字（无需 JS 加 DOM），与 `.dropdown-item` 视觉一致；`.active` 状态覆盖。
4. **`.tb-dropdown .caret`（line 1215）** 从 `font-size:10px` 改成 `width:12px;height:12px;`（配合 SVG 化的 caret）。
5. 三套主题（light/feishu/dark）通过现有 CSS 变量天然兼容，hover 状态加 `[data-theme="dark"]`/`[data-theme="feishu"]` 覆盖。

## 改动五：JS（app.js，line 319 后插入 IIFE）

核心逻辑：
- `ResizeObserver` 监听 `.toolbar`（+ `.sidebar`）尺寸；`MutationObserver` 监听 `body.class`（reading/dashboard 切换）和 `#toolbar` 子树的 `hidden`/`style`（覆盖 `#shareBtn.display`/`#shareStatsBtn.hidden` 动态变化）。全部走 `requestAnimationFrame` 节流。
- **折叠算法**：`scrollWidth > clientWidth + 1` 时，从 `foldableCandidates()`（priority 升序、当前可见、未折叠）取首个，用 `Comment` 占位节点记录原位后 `appendChild` 到 `#overflowMenu`；循环直到不溢出。
- **恢复算法**：`scrollWidth + 16 < clientWidth`（16px hysteresis 防抖）时，从 `foldedCandidates()`（priority 降序）取首个，按占位节点插回原位并移除占位；回挪后若再次溢出则撤回并 break。
- **`#overflowDropdown` 显隐**：`#overflowMenu` 有 `.tb-btn[data-overflow-priority]` 子元素时显示，否则 `hidden`。
- **toggle**：复用导出下拉模式——`#overflowToggle` click `stopPropagation` + 切换 `#overflowMenu.hidden` + 互斥关闭 `#exportMenu`；`#overflowMenu` click 任一 `.tb-btn` 后关闭；`document` click 关闭；Escape 关闭。
- **不可见时 early-return**：`.toolbar` 在 reading-mode/dashboard-active/移动端 `display:none`，`relayout` 检测 `offsetParent` 为空则跳过，恢复可见时由 observer 触发重算。
- IIFE 末尾同步调用一次 `relayout()`，在首帧 paint 前完成折叠，避免溢出闪现。

**事件顺序验证**：点击菜单内 `.tb-btn` → `#overflowMenu` listener 关菜单 → 冒泡到 `#toolbar` listener 分发 `data-cmd`/`data-action`（button 引用仍有效，action 不丢失）→ `document` listener 幂等关闭。`handleAction` 零改动。

## 边界情况

- **761–900px 极窄窗口**：所有可折叠按钮都收起后仍可能溢出（剩余高频按钮 + 两个 select + 导出下拉 + reading/share）。接受此限制——再窄即进入移动端布局（≤760px `.toolbar` 整体隐藏）。
- **`#overflowDropdown[hidden]` 特异性**：必须 `!important` 覆盖 `.tb-dropdown{display:inline-flex}`。
- **`relayout` 开头强制 `overflowMenu.hidden=true`**：避免折叠/恢复过程中按钮在可见菜单里瞬移。
- **抖动**：折叠阈值 `+1px`、恢复阈值 `+16px` 滞后区不重叠 + guard=50 三重防护。
- **移动端 `#mobileToolbar`**：用 `.mt-btn` 类，选择器无交集，不受影响。

## 验证方法

本地已部署 http://localhost:3001（node server.js，SQLite 模式）。网页版改 `public/` 后**硬刷新 Ctrl+F5 即可见**，无需 asar 打包（asar 仅影响桌面 Electron 版；若需桌面版同步，再跑 asar 重新打包）。

1. **拖拽窗口宽度**：1920→761px，观察「⋯ 更多」逐渐出现、菜单按钮增多；反向拖宽，按钮按 4→3→2→1 顺序回挪原位；临界点反复拖动无抖动。
2. **三主题**：light/雾纸/夜墨下菜单按钮 hover、active 颜色正确，图标清晰。
3. **菜单内功能**：折叠后逐个点击 priority 1-4 按钮，验证 `data-cmd`（删除线等）`exec` 生效 + `refreshToolbar` 高亮，`data-action`（quote/codeblock/importHtml 等）`handleAction` 正常。
4. **icon**：导入显示 folder-open，导出显示 download + chevron-down（非 `▾`）。
5. **互斥下拉**：打开 overflowMenu → 点 exportToggle → overflowMenu 关、exportMenu 开；反之亦然；点外部/Escape 关闭。
6. **状态切换重算**：折叠若干 → 阅读模式 → 退出 → 折叠状态恢复；折叠若干 → 仪表盘 → 打开文档 → 恢复。
7. **动态显隐**：管理员登录后 `#shareBtn`/`#shareStatsBtn` 显示 → 低优先级按钮被挤进菜单；取消分享 → 回挪。
8. **热路径不阻塞**（AGENTS.md 铁律）：新建文档 < 100ms 可写；折叠状态下连续输入/粘贴图文无卡顿（relayout 只在 observer 触发，不在输入路径）。
9. **移动端回归**：≤760px 触屏下桌面 `.toolbar` 隐藏，`#mobileToolbar` 独立工作。

## 实施顺序

1. index.html：icon 替换 + 可折叠按钮加属性 + 插入 `#overflowDropdown` 骨架
2. styles.css：`.toolbar` nowrap + `#overflowDropdown[hidden]` + `#overflowMenu .tb-btn` + `.caret` SVG
3. app.js：插入 IIFE
4. Ctrl+F5 按 §验证逐项测

## 关键文件

- [public/index.html](file:///d:/personal/cc/PenMark/public/index.html)（工具栏 line 83-165）
- [public/styles.css](file:///d:/personal/cc/PenMark/public/styles.css)（line 494-504、1214-1234）
- [public/app.js](file:///d:/personal/cc/PenMark/public/app.js)（line 293-318）
