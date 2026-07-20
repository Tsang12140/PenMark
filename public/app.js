// 知著 PenMark 应用主逻辑：文档管理、自动保存、搜索、暗色模式、工具栏
import { Editor } from './editor.js';

const $ = id => document.getElementById(id);
const editorEl = $('editor');
const docListEl = $('docList');
const docTitleEl = $('docTitle');
const searchInput = $('searchInput');
const charCountEl = $('charCount');
const imgCountEl = $('imgCount');
const saveStateEl = $('saveState');
const importInput = $('importInput');
const dropOverlay = $('dropOverlay');
const toastStack = $('toastStack');
const blockStyleSel = $('blockStyle');
const fontSelectEl = $('fontSelect');
const aiModal = $('aiModal');
const aiModalTitle = $('aiModalTitle');
const aiModalBody = $('aiModalBody');
const aiModalClose = $('aiModalClose');

let currentDoc = null;
let saveTimer = null;

/* ---------- 标签页标题：跟随当前文档名 ---------- */
const PENMARK_SUFFIX = ' - 知著 PenMark';

function updateDocumentTitle(title) {
  const t = (title || '').trim() || '无标题';
  document.title = t + PENMARK_SUFFIX;
}
let switching = false; // 切换文档时屏蔽自动保存

/* ---------- Toast ---------- */
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastStack.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2100);
}

/* ---------- 编辑器 ---------- */
const editor = new Editor({
  editor: editorEl,
  dropOverlay,
  onUpdate: () => { updateStats(); scheduleAutoSave(); updateOutline(); },
  onToast: toast,
  onImageSelect: (container) => updateImageFloatMenu(container)
});

/* ---------- 工具栏 ---------- */
$('toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tb-btn');
  if (!btn) return;
  const cmd = btn.getAttribute('data-cmd');
  const action = btn.getAttribute('data-action');
  if (cmd) {
    editor.exec(cmd);
    refreshToolbar();
  } else if (action) {
    handleAction(action);
  }
});

/* ---------- 导出下拉菜单 ---------- */
const exportMenu = $('exportMenu');
$('exportToggle').addEventListener('click', (e) => {
  e.stopPropagation();
  exportMenu.hidden = !exportMenu.hidden;
});
exportMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.dropdown-item');
  if (!item) return;
  exportMenu.hidden = true;
  handleAction(item.getAttribute('data-action'));
});
document.addEventListener('click', () => { exportMenu.hidden = true; });

blockStyleSel.addEventListener('change', () => {
  editor.exec('formatBlock', '<' + blockStyleSel.value + '>');
});

/* ---------- 字体切换 ---------- */
(function initFontSwitch() {
  const saved = localStorage.getItem('penmark_font') || 'sans';
  document.body.setAttribute('data-editor-font', saved);
  fontSelectEl.value = saved;
})();
fontSelectEl.addEventListener('change', () => {
  const v = fontSelectEl.value;
  document.body.setAttribute('data-editor-font', v);
  localStorage.setItem('penmark_font', v);
});

function handleAction(action) {
  switch (action) {
    case 'hr': editor.insertHR(); break;
    case 'quote': editor.insertQuote(); break;
    case 'todo': editor.insertTodo(); break;
    case 'link': editor.insertLink(); break;
    case 'code': editor.insertCodeInline(); break;
    case 'codeblock': editor.insertCodeBlock(); break;
    case 'table': editor.insertTable(3, 3); break;
    case 'toc': editor.insertTOC(); break;
    case 'undo': editor.undo(); break;
    case 'redo': editor.redo(); break;
    case 'importHtml': importInput.click(); break;
    case 'exportHTML': exportHTML(); break;
    case 'exportMD': exportMarkdown(); break;
    case 'exportDoc': exportWord(); break;
    case 'exportImage': openExportImageModal(); break;
    case 'share': openShareModal(); break;
    
    case 'aiLayout': openAiLayoutModal(); break;
    case 'aiRewrite': openAiRewriteModal(); break;
    case 'reading': toggleReadingMode(); break;
  }
}

function refreshToolbar() {
  const btns = document.querySelectorAll('.tb-btn[data-cmd]');
  editor.refreshToolbarState(btns, blockStyleSel);
}

document.addEventListener('selectionchange', () => {
  if (document.activeElement === editorEl) refreshToolbar();
});

/* ---------- 飞书式浮动菜单：选中显示完整菜单，点击显示精简菜单（标题层级） ---------- */
const floatMenu = $('floatMenu');
const floatMenuImg = $('floatMenuImg');
let pinnedLinkCard = null;
let pinnedLinkCardUntil = 0;
let floatMenuRange = null;

editorEl.addEventListener('mouseup', () => {
  setTimeout(updateTextFloatMenu, 10);
});
editorEl.addEventListener('keyup', () => {
  setTimeout(updateTextFloatMenu, 10);
});
editorEl.addEventListener('click', () => {
  setTimeout(updateTextFloatMenu, 10);
});

function updateTextFloatMenu() {
  // 如果快速 AI 输入框正在输入，保持浮动菜单现状（防止输入时菜单消失）
  const aiQuickEl = $('fmAiQuick');
  if (aiQuickEl && document.activeElement === aiQuickEl) return;
  if (pinnedLinkCard && performance.now() < pinnedLinkCardUntil && editorEl.contains(pinnedLinkCard)) {
    floatMenu.classList.remove('compact');
    floatMenu.classList.add('card-context');
    showFloatMenu(floatMenu, pinnedLinkCard.getBoundingClientRect(), 'top');
    refreshFloatMenuState();
    return;
  }
  floatMenu.classList.remove('card-context');
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { hideFloatMenu(); return; }
  const range = sel.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) { hideFloatMenu(); return; }
  rememberFloatMenuRange(range);
  // 选区在 img-container 内时不显示文字菜单
  if (range.commonAncestorContainer.nodeType === 1 && range.commonAncestorContainer.closest && range.commonAncestorContainer.closest('.img-container')) {
    hideFloatMenu();
    return;
  }

  if (!sel.isCollapsed) {
    // 有选区：显示完整浮动菜单（飞书式）
    floatMenu.classList.remove('compact');
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { hideFloatMenu(); return; }
    showFloatMenu(floatMenu, rect, 'top');
    restoreFmAiQuickIfRecent();
    refreshFloatMenuState();
  } else {
    // 光标定位（无选区）：飞书逻辑是不显示文字浮动菜单
    // 块操作通过行首 ⋮⋮ 悬浮按钮触发
    hideFloatMenu();
  }
}

/* ---------- 快速 AI 输入框：1 分钟内保留内容，超过自动清理 ---------- */
let fmAiQuickLastInput = '';
let fmAiQuickLastTime = 0;
const FMAI_KEEP_MS = 60 * 1000; // 1 分钟

function restoreFmAiQuickIfRecent() {
  const el = $('fmAiQuick');
  if (!el) return;
  // 距离上次输入 1 分钟内：恢复内容；超过：清空
  if (fmAiQuickLastTime && Date.now() - fmAiQuickLastTime < FMAI_KEEP_MS) {
    el.value = fmAiQuickLastInput;
  } else {
    el.value = '';
    fmAiQuickLastInput = '';
    fmAiQuickLastTime = 0;
  }
}

function rememberFloatMenuRange(range) {
  if (!range) return;
  try { floatMenuRange = range.cloneRange(); } catch (_) { floatMenuRange = null; }
}

function restoreFloatMenuRange() {
  if (!floatMenuRange) return false;
  try {
    if (!editorEl.contains(floatMenuRange.commonAncestorContainer)) return false;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(floatMenuRange.cloneRange());
    return true;
  } catch (_) {
    return false;
  }
}
function getCurrentBlockElement() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  let node = sel.anchorNode;
  while (node && node !== editorEl) {
    if (node.nodeType === 1 && /^(P|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE|LI|DIV)$/.test(node.tagName)) return node;
    node = node.parentNode;
  }
  return null;
}

function showFloatMenuAtLeft(menu, rect) {
  menu.hidden = false;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = rect.left - mw - 10;
  let top = rect.top + rect.height / 2 - mh / 2;
  if (left < 8) left = rect.right + 10; // 左侧放不下则放右侧
  if (top < 8) top = 8;
  if (top + mh > window.innerHeight - 8) top = window.innerHeight - mh - 8;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function updateImageFloatMenu(container) {
  if (!container) { floatMenuImg.hidden = true; return; }
  // 隐藏文字菜单
  floatMenu.hidden = true;
  // 等一帧让 selected 样式生效，再取位置
  requestAnimationFrame(() => {
    const rect = container.getBoundingClientRect();
    if (rect.width === 0) { floatMenuImg.hidden = true; return; }
    showFloatMenu(floatMenuImg, rect, 'top');
  });
}

function showFloatMenu(menu, rect, prefer) {
  menu.hidden = false;
  // 先显示才能量宽高
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = rect.left + rect.width / 2 - mw / 2;
  let top;
  if (prefer === 'top' && rect.top - mh - 8 > 8) {
    top = rect.top - mh - 8; // 显示在上方
  } else {
    top = rect.bottom + 8; // 下方
  }
  // 边界处理
  if (left < 8) left = 8;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top < 8) top = 8;
  if (top + mh > window.innerHeight - 8) top = window.innerHeight - mh - 8;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function hideFloatMenu() { floatMenu.hidden = true; }

function refreshFloatMenuState() {
  const cmds = ['bold', 'italic', 'underline', 'strikeThrough'];
  floatMenu.querySelectorAll('.fm-btn').forEach(btn => {
    const c = btn.getAttribute('data-cmd');
    if (c && cmds.indexOf(c) >= 0) {
      try { btn.classList.toggle('active', document.queryCommandState(c)); } catch (_) {}
    }
  });
}

// 浮动菜单点击：保留选区执行命令
floatMenu.addEventListener('mousedown', (e) => {
  const btn = e.target.closest('.fm-btn');
  if (!btn) return;
  e.preventDefault(); // 防止失焦丢选区
});
floatMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('.fm-btn');
  if (!btn) return;
  restoreFloatMenuRange();
  const cmd = btn.getAttribute('data-cmd');
  const block = btn.getAttribute('data-block');
  const action = btn.getAttribute('data-action');
  if (cmd) editor.exec(cmd);
  else if (block) editor.exec('formatBlock', '<' + block + '>');
  else if (action === 'linkMenu') {
    const anchor = getSelectionAnchor();
    if (!anchor) handleAction('link');
    else {
      buildLinkMenu(anchor);
      const rect = floatMenu.getBoundingClientRect();
      positionCtxMenu(rect.left, rect.bottom + 6, rect.top - 6);
    }
  }
  else if (action === 'blockMenu') {
    if (!ctxMenu.hidden) hideCtxMenu();
    else {
      buildCtxMenu(getCurrentBlockElement());
      const rect = floatMenu.getBoundingClientRect();
      positionCtxMenu(rect.left, rect.bottom + 6, rect.top - 6);
      btn.setAttribute('aria-expanded', 'true');
    }
  } else if (action) handleAction(action);
  refreshFloatMenuState();
});

// 图片浮动菜单点击
floatMenuImg.addEventListener('mousedown', (e) => e.preventDefault());
floatMenuImg.addEventListener('click', (e) => {
  const btn = e.target.closest('.fm-btn');
  if (!btn || !editor.selectedImage) return;
  const act = btn.getAttribute('data-img-action');
  const c = editor.selectedImage;
  switch (act) {
    case 'copy': editor.copyImage(c); break;
    case 'cut': editor.cutImage(c); floatMenuImg.hidden = true; break;
    case 'reset': editor.resetImageSize(c); break;
    case 'fit': editor.fitImageWidth(c); break;
    case 'align-left': editor.alignImage(c, 'left'); break;
    case 'align-center': editor.alignImage(c, 'center'); break;
    case 'delete': editor.deleteImage(c); floatMenuImg.hidden = true; break;
  }
});

// 滚动/resize 时隐藏浮动菜单
editorEl.addEventListener('scroll', hideFloatMenu);
window.addEventListener('scroll', hideFloatMenu, true);
window.addEventListener('resize', () => { hideFloatMenu(); floatMenuImg.hidden = true; });
// 点击编辑器外隐藏
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('.float-menu')) return;
  if (e.target.closest('.block-handle')) return;
  if (!editorEl.contains(e.target) && !e.target.closest('.img-container')) {
    hideFloatMenu();
    floatMenuImg.hidden = true;
    hideBlockHandle();
  }
});

/* ---------- 行首块操作按钮 ⋮⋮（飞书式） ---------- */
const blockHandle = $('blockHandle');
const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,blockquote,pre,li,div';
const BLOCK_TAGS_RE = /^(P|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE|LI|DIV)$/;
let hoverBlock = null;          // 当前 hover 的块级元素
let blockHandleRaf = 0;         // rAF 节流

function findHoverBlock(target) {
  if (!target) return null;
  let el = target.nodeType === 1 ? target : target.parentElement;
  if (!el) return null;
  const block = el.closest ? el.closest(BLOCK_SEL) : null;
  if (!block || !editorEl.contains(block) || block === editorEl) return null;
  // 嵌套结构（表格、img-grid）只取最外层
  let parent = block.parentElement;
  while (parent && parent !== editorEl) {
    if (BLOCK_TAGS_RE.test(parent.tagName)) return parent; // 用更外层的块
    parent = parent.parentElement;
  }
  return block;
}

editorEl.addEventListener('mousemove', (e) => {
  const block = findHoverBlock(e.target);
  if (block === hoverBlock) return; // 没变化
  hoverBlock = block;
  if (blockHandleRaf) return;
  blockHandleRaf = requestAnimationFrame(() => {
    blockHandleRaf = 0;
    positionBlockHandle(hoverBlock);
  });
});

editorEl.addEventListener('mouseleave', () => {
  hoverBlock = null;
  hideBlockHandle();
});

function positionBlockHandle(block) {
  if (!block) { hideBlockHandle(); return; }
  const rect = block.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) { hideBlockHandle(); return; }
  // 只在编辑器可视范围内显示
  const editorRect = editorEl.getBoundingClientRect();
  if (rect.bottom < editorRect.top + 10 || rect.top > editorRect.bottom - 10) {
    hideBlockHandle();
    return;
  }
  blockHandle.style.left = (rect.left - 26) + 'px';
  blockHandle.style.top = (rect.top + Math.max(0, (rect.height - 22) / 2)) + 'px';
  blockHandle._block = block;
  blockHandle.hidden = false;
  // 下一帧添加 visible 让 opacity 过渡生效
  requestAnimationFrame(() => blockHandle.classList.add('visible'));
}

function hideBlockHandle() {
  blockHandle.classList.remove('visible');
  // 等过渡完再 hidden，避免突兀消失
  setTimeout(() => {
    if (!blockHandle.classList.contains('visible')) blockHandle.hidden = true;
  }, 130);
}

// 滚动/resize 时跟随
window.addEventListener('scroll', () => {
  if (hoverBlock) positionBlockHandle(hoverBlock);
}, true);
window.addEventListener('resize', () => {
  if (hoverBlock) positionBlockHandle(hoverBlock);
});

// 点击 ⋮⋮：把光标定位到块首，弹出块菜单
// 拖拽 ⋮⋮：移动当前块到目标位置（飞书核心交互）
let dragState = null;
const dragIndicator = document.createElement('div');
dragIndicator.className = 'block-drag-indicator';
dragIndicator.hidden = true;
document.body.appendChild(dragIndicator);

blockHandle.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault(); // 防止失焦
  const block = blockHandle._block;
  if (!block || !editorEl.contains(block)) return;
  dragState = {
    block,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    targetBlock: null,
    targetPos: null  // 'before' | 'after'
  };
});

document.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (!dragState.moved && Math.hypot(dx, dy) > 5) {
    dragState.moved = true;
    blockHandle.classList.add('dragging');
    editorEl.classList.add('block-dragging');
  }
  if (!dragState.moved) return;
  // 找出当前鼠标位置对应的块级元素
  const el = document.elementFromPoint(e.clientX, e.clientY);
  let target = el ? (el.nodeType === 1 ? el : el.parentElement) : null;
  if (target) target = target.closest ? target.closest(BLOCK_SEL) : null;
  if (!target || !editorEl.contains(target) || target === editorEl || target === dragState.block) {
    dragState.targetBlock = null;
    dragIndicator.hidden = true;
    return;
  }
  const rect = target.getBoundingClientRect();
  const mid = rect.top + rect.height / 2;
  const pos = e.clientY < mid ? 'before' : 'after';
  dragState.targetBlock = target;
  dragState.targetPos = pos;
  // 显示蓝色横线
  dragIndicator.hidden = false;
  dragIndicator.style.left = rect.left + 'px';
  dragIndicator.style.width = rect.width + 'px';
  dragIndicator.style.top = (pos === 'before' ? rect.top - 1 : rect.bottom - 1) + 'px';
});

document.addEventListener('mouseup', () => {
  if (!dragState) return;
  const wasMoved = dragState.moved;
  const targetBlock = dragState.targetBlock;
  const targetPos = dragState.targetPos;
  const srcBlock = dragState.block;
  dragState = null;
  blockHandle.classList.remove('dragging');
  editorEl.classList.remove('block-dragging');
  dragIndicator.hidden = true;
  if (wasMoved) {
    // 拖拽完成：执行移动
    if (targetBlock && targetBlock !== srcBlock) {
      try {
        if (targetPos === 'before') targetBlock.parentNode.insertBefore(srcBlock, targetBlock);
        else targetBlock.parentNode.insertBefore(srcBlock, targetBlock.nextSibling);
        editor._afterChange();
        // 把光标定位到移动后的块
        try {
          const range = document.createRange();
          range.selectNodeContents(srcBlock);
          range.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (_) {}
      } catch (err) { console.warn('move block failed', err); }
    }
  } else {
    // 没拖动 → 视为点击，弹出块菜单
    editorEl.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(srcBlock);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
    floatMenu.classList.remove('card-context');
    buildCtxMenu(srcBlock);
    const rect = blockHandle.getBoundingClientRect();
    positionCtxMenu(rect.left, rect.right + 4, rect.top - 4);
    blockHandle.setAttribute('aria-expanded', 'true');
  }
});

/* ---------- 右键上下文菜单（飞书式，精简版） ---------- */
const ctxMenu = $('ctxMenu');
let ctxAnchor = null;
let activeLinkAnchor = null; // 右键命中的链接（若有）

editorEl.addEventListener('contextmenu', () => hideCtxMenu());

function getSelectionAnchor() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const node = sel.anchorNode;
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  const anchor = el && el.closest ? el.closest('a') : null;
  return anchor && editorEl.contains(anchor) ? anchor : (activeLinkAnchor && editorEl.contains(activeLinkAnchor) ? activeLinkAnchor : null);
}

function buildLinkMenu(anchor) {
  ctxAnchor = anchor;
  let html = '<div class="ctx-menu-label">链接</div>';
  if (anchor.getAttribute('data-link-card') === '1') {
    html += ctxBtn('unwrapCard', '转回链接');
  } else {
    html += ctxBtn('card', '转为链接卡片');
  }
  html += ctxBtn('open', '在新标签页打开');
  if (anchor.getAttribute('data-link-card') !== '1') html += ctxBtn('unwrap', '取消链接');
  ctxMenu.innerHTML = html;
}
function buildCtxMenu(block) {
  if (floatMenu.classList.contains('card-context')) {
    ctxMenu.innerHTML = '<div class="ctx-menu-label">插入到卡片后</div>' +
      ctxBtn('codeblock', '代码块') + ctxBtn('hr', '分隔线');
    return;
  }
  const tag = currentBlockTag(block);
  let html = '<div class="ctx-menu-label">段落类型</div>';
  html += ctxBtn('block', '正文', tag === 'P', 'P');
  html += ctxBtn('block', '一级标题', tag === 'H1', 'H1');
  html += ctxBtn('block', '二级标题', tag === 'H2', 'H2');
  html += ctxBtn('block', '三级标题', tag === 'H3', 'H3');
  html += ctxBtn('block', '四级标题', tag === 'H4', 'H4');
  html += '<div class="ctx-sep"></div>';
  html += ctxBtn('ol', '有序列表');
  html += ctxBtn('ul', '无序列表');
  html += ctxBtn('quote', '引用');
  html += ctxBtn('codeblock', '代码块');
  html += ctxBtn('hr', '分隔线');
  html += '<div class="ctx-sep"></div>';
  html += ctxBtn('duplicate', '重复本块');
  html += ctxBtn('copy', '复制本块');
  html += ctxBtn('cut', '剪切本块');
  html += ctxBtn('delete', '删除本块', false, null, 'danger');
  ctxMenu.innerHTML = html;
}

function menuIcon(action, block) {
  if (action === 'block') {
    return '<span class="ctx-type-icon">' + (block === 'P' ? 'T' : block) + '</span>';
  }
  const paths = {
    ol: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M3 5h2v3M3 11h2l-2 3h2M3 17h2v3H3"/>',
    ul: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    quote: '<path d="M5 7h5v5H6c0 3-1 5-3 6M14 7h5v5h-4c0 3-1 5-3 6"/>',
    codeblock: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
    hr: '<path d="M4 12h16"/>',
    card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10M7 13h7"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/>',
    unwrap: '<path d="m9 15 6-6M7 17l-2 2a3 3 0 0 1-4-4l3-3M17 7l2-2a3 3 0 0 1 4 4l-3 3"/>',
    duplicate: '<rect x="8" y="8" width="13" height="13" rx="1"/><path d="M3 16V4a1 1 0 0 1 1-1h12"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="1"/><path d="M3 16V4a1 1 0 0 1 1-1h12"/>',
    cut: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 8l12 8M8 16l12-8"/>',
    delete: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (paths[action] || '') + '</svg>';
}

function ctxBtn(action, label, active, block, modifier) {
  return '<button class="ctx-btn' + (active ? ' active' : '') + (modifier ? ' ' + modifier : '') + '" data-ctx="' + action + '"' +
    (block ? ' data-block="' + block + '"' : '') + '>' +
    '<span class="ctx-icon">' + menuIcon(action, block) + '</span><span>' + label + '</span>' +
    (active ? '<span class="ctx-check">✓</span>' : '') + '</button>';
}
function currentBlockTag(block) {
  if (!block || block === editorEl) return '';
  return block.tagName.toUpperCase();
}

function positionCtxMenu(x, y, aboveY) {
  ctxMenu.hidden = false;
  const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
  let left = x, top = y;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = (aboveY || y) - mh;
  if (top < 8) top = 8;
  if (left < 8) left = 8;
  ctxMenu.style.left = left + 'px';
  ctxMenu.style.top = top + 'px';
}

function hideCtxMenu() { ctxMenu.hidden = true; ctxAnchor = null; const trigger = floatMenu.querySelector('.fm-type-trigger'); if (trigger) trigger.setAttribute('aria-expanded', 'false'); if (blockHandle) blockHandle.setAttribute('aria-expanded', 'false'); }

ctxMenu.addEventListener('mousedown', (e) => e.preventDefault()); // 不失焦
ctxMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('.ctx-btn');
  if (!btn) return;
  const action = btn.getAttribute('data-ctx');
  const block = btn.getAttribute('data-block');
  const anchor = ctxAnchor;
  restoreFloatMenuRange();
  hideCtxMenu();
  handleCtxAction(action, block, anchor);
});

async function handleCtxAction(action, block, anchor) {
  editorEl.focus();
  switch (action) {
    case 'block': editor.exec('formatBlock', '<' + block + '>'); break;
    case 'ul': editor.exec('insertUnorderedList'); break;
    case 'ol': editor.exec('insertOrderedList'); break;
    case 'codeblock': editor.insertCodeBlock(); break;
    case 'quote': editor.exec('formatBlock', '<BLOCKQUOTE>'); break;
    case 'hr': editor.insertHR(); break;
    case 'cut': editor.cutCurrentBlock(); break;
    case 'copy': editor.copyCurrentBlock(); break;
    case 'duplicate': editor.duplicateCurrentBlock(); break;
    case 'delete': editor.deleteCurrentBlock(); break;
    case 'card':
      if (anchor) await editor.convertLinkToCard(anchor);
      break;
    case 'unwrapCard':
      if (anchor) editor.convertCardToLink(anchor);
      break;
    case 'unwrap':
      if (anchor) editor.unwrapLink(anchor);
      break;
    case 'open':
      if (anchor) window.open(anchor.href, '_blank', 'noopener');
      break;
  }
  updateOutline();
}

// 点击外部 / 滚动 / Esc 关闭右键菜单
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.ctx-menu')) hideCtxMenu(); });
window.addEventListener('scroll', hideCtxMenu, true);
window.addEventListener('resize', hideCtxMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

function openEditorLink(anchor) {
  if (!anchor || !anchor.href) return;
  window.open(anchor.href, '_blank', 'noopener');
}

// Editing keeps plain links safe from accidental navigation; cards expose an explicit open target.
editorEl.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || !editorEl.contains(a)) {
    activeLinkAnchor = null;
    pinnedLinkCard = null;
    pinnedLinkCardUntil = 0;
    return;
  }
  activeLinkAnchor = a;
  const isCard = a.getAttribute('data-link-card') === '1';
  if (isCard) {
    pinnedLinkCard = a;
    pinnedLinkCardUntil = performance.now() + 250;
    const cardRange = document.createRange();
    cardRange.setStartAfter(a);
    cardRange.collapse(true);
    rememberFloatMenuRange(cardRange);
    floatMenu.classList.remove('compact');
    floatMenu.classList.add('card-context');
    showFloatMenu(floatMenu, a.getBoundingClientRect(), 'top');
    refreshFloatMenuState();
  }
  const openTarget = e.target.closest('.lc-open, .lc-thumb');
  if ((isCard && openTarget) || e.ctrlKey || e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    openEditorLink(a);
    return;
  }
  e.preventDefault();
});

editorEl.addEventListener('dblclick', (e) => {
  const card = e.target.closest('a[data-link-card="1"]');
  if (!card || !editorEl.contains(card)) return;
  e.preventDefault();
  e.stopPropagation();
  openEditorLink(card);
});

/* ---------- 统计 ---------- */
function updateStats() {
  const s = editor.getStats();
  charCountEl.textContent = s.chars;
  imgCountEl.textContent = s.imgs;
}

/* ---------- 自动保存 ---------- */
function scheduleAutoSave() {
  if (switching || !currentDoc) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveStateEl.textContent = '编辑中…';
  saveTimer = setTimeout(saveCurrent, 1000);
}

async function saveCurrent(opts) {
  if (!currentDoc) return;
  opts = opts || {};
  const title = docTitleEl.value.trim() || '无标题';
  const content = editor.getHTML();
  try {
    await api('/api/documents/' + currentDoc.id, 'PUT', { title, content });
    currentDoc.title = title;
    currentDoc.content = content;
    const now = Date.now();
    currentDoc.updated_at = now;
    saveStateEl.textContent = '已保存 ' + timeStr();
    updateDocumentTitle(title);
    // 更新列表中该项的标题和时间（不重新拉列表，避免抖动）
    updateListItem(currentDoc, { reorder: opts.reorder !== false });
  } catch (e) {
    saveStateEl.textContent = '保存失败';
    toast('保存失败：' + (e.message || e));
  }
}

function updateListItem(doc, opts) {
  opts = opts || {};
  const item = docListEl.querySelector('.doc-item[data-id="' + doc.id + '"]');
  if (!item) return;
  item.querySelector('.doc-title').textContent = doc.title;
  item.querySelector('.doc-meta').textContent = relativeTime(doc.updated_at);
  if (opts.reorder === false) return;
  // 移到所在文件夹子列表的最前面（保持分组结构）
  const parentList = item.parentNode;
  if (parentList && parentList.classList.contains('folder-docs')) {
    parentList.insertBefore(item, parentList.firstChild);
  }
}

function timeStr() {
  const d = new Date();
  const p = n => n < 10 ? '0' + n : n;
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前';
  const day = Math.floor(hr / 24);
  if (day < 7) return day + ' 天前';
  const d = new Date(ts);
  const p = n => n < 10 ? '0' + n : n;
  return (d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ---------- API ---------- */
// cookie 同源自动携带；遇 401 跳登录页（桌面模式不跳转）
let currentUser = null;
function isDesktopMode() {
  return !!(window.desktop && window.desktop.isDesktop);
}
function handleAuthFailure() {
  // 桌面模式：本地认证不应跳登录页，显示错误即可
  if (isDesktopMode()) {
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;color:#c0392b;font-family:sans-serif;padding:24px;text-align:center">' +
      '<h2 style="margin:0 0 8px">桌面认证失败</h2>' +
      '<p style="margin:0;color:#666">请重启知著 PenMark。如问题持续，请联系技术支持。</p>' +
      '</div>';
    return;
  }
  window.location.href = '/login.html';
}
async function api(url, method, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  if (r.status === 401) {
    handleAuthFailure();
    throw new Error('need login');
  }
  if (!r.ok) {
    let errBody = null;
    try { errBody = await r.json(); } catch (e) {}
    throw new Error((errBody && errBody.error) || ('HTTP ' + r.status));
  }
  return r.json();
}

/* ---------- 文档列表 + 文件夹 ---------- */
let folders = [];
let expandedFolders = new Set(JSON.parse(localStorage.getItem('penmark_expanded_folders') || '[]'));
let draggingDocId = null;
let renamingFolderId = null;
let docClipboard = null;

async function loadSidebar() {
  const [fRes, dRes] = await Promise.all([api('/api/folders'), api('/api/documents')]);
  folders = fRes;
  renderSidebar(dRes);
}

function persistExpanded() {
  localStorage.setItem('penmark_expanded_folders', JSON.stringify([...expandedFolders]));
}

function renderSidebar(docs) {
  docListEl.innerHTML = '';
  if (!docs.length && !folders.length) {
    docListEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-faint);font-size:12px;">暂无文档，点击上方新建</div>';
    return;
  }
  // 按文件夹分组
  const grouped = {};
  const unfiled = [];
  docs.forEach(d => {
    if (d.folder_id) (grouped[d.folder_id] = grouped[d.folder_id] || []).push(d);
    else unfiled.push(d);
  });
  // 渲染各文件夹
  folders.forEach(f => renderFolderItem(f, grouped[f.id] || []));
  // 未分类区（始终显示，作为 drop target）
  renderUnfiledSection(unfiled);
}

function renderFolderItem(folder, docs) {
  const expanded = expandedFolders.has(folder.id);
  const wrap = document.createElement('div');
  wrap.className = 'folder-item' + (expanded ? ' expanded' : '');
  wrap.setAttribute('data-folder-id', folder.id);

  const head = document.createElement('div');
  head.className = 'folder-head';
  head.innerHTML =
    '<span class="folder-arrow"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,4 11,8 6,12"/></svg></span>' +
    '<span class="folder-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .8.4l1 1.1a1 1 0 0 0 .8.4H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5z"/></svg></span>' +
    '<span class="folder-name" title="' + escapeHtml(folder.name) + '">' + escapeHtml(folder.name) + '</span>' +
    '<span class="folder-count">' + (folder.doc_count || 0) + '</span>' +
    '<button class="folder-menu" title="更多操作">⋯</button>';
  head.addEventListener('click', (e) => {
    if (e.target.closest('.folder-menu') || e.target.closest('.folder-name-input')) return;
    wrap.classList.toggle('expanded');
    if (wrap.classList.contains('expanded')) expandedFolders.add(folder.id);
    else expandedFolders.delete(folder.id);
    persistExpanded();
  });
  head.querySelector('.folder-name').addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startFolderRename(folder.id, { selectAll: true });
  });
  head.querySelector('.folder-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    showFolderMenu(folder, head.querySelector('.folder-menu'));
  });
  bindDropTarget(head, folder.id, wrap);

  // 子文档容器（作为拖拽 drop target）
  const list = document.createElement('div');
  list.className = 'folder-docs';
  bindDropTarget(list, folder.id, list);
  docs.forEach(doc => list.appendChild(buildDocItem(doc)));
  if (!docs.length && expanded) {
    const empty = document.createElement('div');
    empty.className = 'folder-empty';
    empty.textContent = '文件夹为空';
    list.appendChild(empty);
  }

  wrap.appendChild(head);
  wrap.appendChild(list);
  docListEl.appendChild(wrap);
}

function renderUnfiledSection(docs) {
  const wrap = document.createElement('div');
  wrap.className = 'folder-item unfiled';
  wrap.innerHTML =
    '<div class="folder-head"><span class="folder-arrow" style="visibility:hidden"><svg width="12" height="12" viewBox="0 0 16 16"></svg></span>' +
    '<span class="folder-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .8.4l1 1.1a1 1 0 0 0 .8.4H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5z"/></svg></span>' +
    '<span class="folder-name">未分类</span>' +
    '<span class="folder-count">' + docs.length + '</span>' +
    '<button class="folder-menu" title="更多操作">⋯</button></div>';
  const head = wrap.querySelector('.folder-head');
  head.querySelector('.folder-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    showFolderMenu({ id: null, name: '未分类', unfiled: true }, head.querySelector('.folder-menu'));
  });
  bindDropTarget(head, null, wrap);
  const list = document.createElement('div');
  list.className = 'folder-docs';
  bindDropTarget(list, null, list); // null = 移到根
  docs.forEach(doc => list.appendChild(buildDocItem(doc)));
  wrap.appendChild(list);
  // 未分类始终展开
  wrap.classList.add('expanded');
  docListEl.appendChild(wrap);
}

function buildDocItem(doc) {
  const item = document.createElement('div');
  item.className = 'doc-item' + (currentDoc && currentDoc.id === doc.id ? ' active' : '');
  item.setAttribute('data-id', doc.id);
  item.setAttribute('draggable', 'true');
  item.innerHTML =
    '<div class="doc-title">' + escapeHtml(doc.title || '无标题') + '</div>' +
    '<div class="doc-meta">' + relativeTime(doc.updated_at) + '</div>' +
    (doc.snippet ? '<div class="doc-snippet">' + escapeHtml(doc.snippet) + '</div>' : '') +
    '<button class="doc-menu" title="更多操作">⋯</button>' +
    '<button class="doc-del" title="删除">×</button>';
  if (docClipboard && docClipboard.mode === 'cut' && String(docClipboard.docId) === String(doc.id)) {
    item.classList.add('cutting');
  }
  item.addEventListener('click', (e) => {
    if (e.target.classList.contains('doc-del')) { e.stopPropagation(); confirmDelete(doc); }
    else if (e.target.closest('.doc-menu')) { e.stopPropagation(); showDocMenu(doc, item.querySelector('.doc-menu')); }
    else openDoc(doc.id);
  });
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showDocMenu(doc, item, { x: e.clientX, y: e.clientY });
  });
  // 拖拽
  item.addEventListener('dragstart', (e) => {
    draggingDocId = doc.id;
    item.classList.add('dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/penmark-doc', String(doc.id)); } catch (_) {}
  });
  item.addEventListener('dragend', () => {
    draggingDocId = null;
    item.classList.remove('dragging');
    docListEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  return item;
}

function getDraggingDocId(e) {
  if (draggingDocId !== null) return draggingDocId;
  try {
    const id = e.dataTransfer && e.dataTransfer.getData('text/penmark-doc');
    return id ? Number(id) : null;
  } catch (_) {
    return null;
  }
}

function bindDropTarget(targetEl, folderId, highlightEl) {
  const hl = highlightEl || targetEl;
  targetEl.addEventListener('dragover', (e) => {
    const hasDoc = draggingDocId !== null || (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('text/penmark-doc') >= 0);
    if (!hasDoc) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    hl.classList.add('drag-over');
  });
  targetEl.addEventListener('dragleave', (e) => {
    if (!targetEl.contains(e.relatedTarget)) hl.classList.remove('drag-over');
  });
  targetEl.addEventListener('drop', (e) => {
    e.preventDefault();
    hl.classList.remove('drag-over');
    const docId = getDraggingDocId(e);
    if (docId !== null) moveDocToFolder(docId, folderId);
  });
}

async function moveDocToFolder(docId, folderId) {
  try {
    await api('/api/documents/' + docId + '/move', 'POST', { folder_id: folderId === null ? 0 : folderId });
    await loadSidebar();
    toast('已移动');
  } catch (e) { toast('移动失败：' + (e.message || e)); }
}

/* ---------- 文件夹右键菜单 ---------- */
const folderContextMenu = document.createElement('div');
folderContextMenu.className = 'folder-context-menu';
folderContextMenu.hidden = true;
document.body.appendChild(folderContextMenu);

const docContextMenu = document.createElement('div');
docContextMenu.className = 'folder-context-menu doc-context-menu';
docContextMenu.hidden = true;
document.body.appendChild(docContextMenu);

function closeContextMenus() {
  folderContextMenu.hidden = true;
  folderContextMenu.style.display = 'none';
  docContextMenu.hidden = true;
  docContextMenu.style.display = 'none';
}

document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.folder-context-menu') || e.target.closest('.doc-menu') || e.target.closest('.folder-menu')) return;
  closeContextMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeContextMenus();
});
folderContextMenu.addEventListener('pointerdown', (e) => e.stopPropagation());
docContextMenu.addEventListener('pointerdown', (e) => e.stopPropagation());

function showFolderMenu(folder, anchor) {
  closeContextMenus();
  const pasteItem = docClipboard ? '<div class="fcm-item" data-act="paste">' + (docClipboard.mode === 'cut' ? '粘贴剪切的文章' : '粘贴复制的文章') + '</div>' : '';
  folderContextMenu.innerHTML = folder.unfiled
    ? (pasteItem || '<div class="fcm-item disabled">没有可粘贴的文章</div>')
    : '<div class="fcm-item" data-act="new">在此新建文档</div>' +
      '<div class="fcm-item" data-act="rename">重命名</div>' +
      pasteItem +
      '<div class="fcm-item danger" data-act="delete">删除文件夹</div>';
  folderContextMenu.style.display = 'block';
  const rect = anchor.getBoundingClientRect();
  folderContextMenu.style.left = rect.right + 'px';
  folderContextMenu.style.top = rect.bottom + 'px';
  folderContextMenu.hidden = false;
  docContextMenu.hidden = true;
  folderContextMenu.onclick = (e) => {
    e.stopPropagation();
    const act = e.target.getAttribute('data-act');
    if (!act) return;
    closeContextMenus();
    if (act === 'new') newDocInFolder(folder.id);
    else if (act === 'rename') renameFolder(folder);
    else if (act === 'paste') pasteDocToFolder(folder.id);
    else if (act === 'delete') deleteFolder(folder);
  };
}

function showDocMenu(doc, anchor, point) {
  closeContextMenus();
  docContextMenu.innerHTML =
    '<div class="fcm-item" data-act="duplicate">创建副本</div>' +
    '<div class="fcm-item" data-act="copy">复制</div>' +
    '<div class="fcm-item" data-act="cut">剪切</div>' +
    '<div class="fcm-item danger" data-act="delete">删除</div>';
  docContextMenu.style.display = 'block';
  if (point) {
    docContextMenu.style.left = point.x + 'px';
    docContextMenu.style.top = point.y + 'px';
  } else {
    const rect = anchor.getBoundingClientRect();
    docContextMenu.style.left = rect.right + 'px';
  docContextMenu.style.top = rect.bottom + 'px';
  }
  docContextMenu.hidden = false;
  folderContextMenu.hidden = true;
  docContextMenu.onclick = (e) => {
    e.stopPropagation();
    const act = e.target.getAttribute('data-act');
    if (!act) return;
    closeContextMenus();
    if (act === 'duplicate') duplicateDoc(doc);
    else if (act === 'copy') copyDoc(doc);
    else if (act === 'cut') cutDoc(doc);
    else if (act === 'delete') confirmDelete(doc);
  };
}

async function newDocInFolder(folderId) {
  if (currentDoc && saveTimer) { clearTimeout(saveTimer); await saveCurrent(); }
  switching = true;
  try {
    const res = await api('/api/documents', 'POST', { title: '无标题', content: '', folder_id: folderId });
    expandedFolders.add(folderId);
    persistExpanded();
    await loadSidebar();
    currentDoc = { id: res.id, title: '无标题', content: '', updated_at: Date.now(), folder_id: folderId };
    docTitleEl.value = '';
    editor.clear();
    saveStateEl.textContent = '新文档';
    docTitleEl.focus();
    updateDocumentTitle('无标题');
    toast('已新建文档');
  } catch (e) { toast('新建失败：' + (e.message || e)); }
  finally { switching = false; }
}

async function createFolder() {
  try {
    const res = await api('/api/folders', 'POST', { name: '新文件夹' });
    await loadSidebar();
    startFolderRename(res.id, { selectAll: true });
    toast('已创建文件夹');
  } catch (e) { toast('创建失败：' + (e.message || e)); }
}

async function renameFolder(folder) {
  startFolderRename(folder.id, { selectAll: true });
}

async function startFolderRename(folderId, opts) {
  if (folderId === null || renamingFolderId === folderId) return;
  const nameEl = docListEl.querySelector('.folder-item[data-folder-id="' + folderId + '"] .folder-name');
  const folder = folders.find(f => String(f.id) === String(folderId));
  if (!nameEl || !folder) return;
  renamingFolderId = folderId;
  const oldName = folder.name || '新文件夹';
  const input = document.createElement('input');
  input.className = 'folder-name-input';
  input.type = 'text';
  input.maxLength = 40;
  input.value = oldName;
  input.setAttribute('aria-label', '文件夹名称');
  nameEl.replaceWith(input);
  input.focus();
  if (opts && opts.selectAll) input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    const restore = (name) => {
      const span = document.createElement('span');
      span.className = 'folder-name';
      span.title = name;
      span.textContent = name;
      span.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startFolderRename(folderId, { selectAll: true });
      });
      input.replaceWith(span);
      renamingFolderId = null;
    };
    if (!commit || !next || next === oldName) {
      restore(oldName);
      if (!next) toast('文件夹名不能为空');
      return;
    }
    try {
      await api('/api/folders/' + folderId, 'PUT', { name: next });
      folder.name = next;
      restore(next);
      toast('已重命名');
    } catch (e) {
      restore(oldName);
      toast('重命名失败：' + (e.message || e));
    }
  };

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

async function duplicateDoc(doc, folderId) {
  try {
    if (currentDoc && saveTimer) { clearTimeout(saveTimer); await saveCurrent(); }
    const detail = await api('/api/documents/' + doc.id);
    const title = (detail.title || doc.title || '无标题') + ' 副本';
    const targetFolderId = folderId !== undefined ? folderId : (detail.folder_id || doc.folder_id || null);
    const res = await api('/api/documents', 'POST', { title, content: detail.content || '', folder_id: targetFolderId });
    if (targetFolderId) expandedFolders.add(targetFolderId);
    persistExpanded();
    await loadSidebar();
    await openDoc(res.id);
    toast('已创建副本');
  } catch (e) { toast('创建副本失败：' + (e.message || e)); }
}

function copyDoc(doc) {
  docClipboard = { mode: 'copy', docId: doc.id, title: doc.title || '无标题' };
  toast('已复制文章，选择文件夹后可粘贴');
}

function cutDoc(doc) {
  docClipboard = { mode: 'cut', docId: doc.id, title: doc.title || '无标题' };
  docListEl.querySelectorAll('.doc-item.cutting').forEach(el => el.classList.remove('cutting'));
  const item = docListEl.querySelector('.doc-item[data-id="' + doc.id + '"]');
  if (item) item.classList.add('cutting');
  toast('已剪切文章，选择文件夹后可粘贴');
}

async function pasteDocToFolder(folderId) {
  if (!docClipboard) return;
  try {
    if (docClipboard.mode === 'copy') {
      const detail = await api('/api/documents/' + docClipboard.docId);
      const title = (detail.title || docClipboard.title || '无标题') + ' 副本';
      const res = await api('/api/documents', 'POST', {
        title,
        content: detail.content || '',
        folder_id: folderId
      });
      if (folderId) expandedFolders.add(folderId);
      persistExpanded();
      await loadSidebar();
      await openDoc(res.id);
      toast('已粘贴副本');
    } else {
      const docId = docClipboard.docId;
      docClipboard = null;
      await moveDocToFolder(docId, folderId);
      if (currentDoc && String(currentDoc.id) === String(docId)) currentDoc.folder_id = folderId || null;
      toast('已粘贴');
    }
  } catch (e) { toast('粘贴失败：' + (e.message || e)); }
}

async function deleteFolder(folder) {
  if (!confirm('删除文件夹「' + folder.name + '」？里面的文档会移到「未分类」。')) return;
  try {
    await api('/api/folders/' + folder.id, 'DELETE');
    expandedFolders.delete(folder.id);
    persistExpanded();
    await loadSidebar();
    toast('已删除文件夹');
  } catch (e) { toast('删除失败：' + (e.message || e)); }
}

async function openDoc(id) {
  if (currentDoc && currentDoc.id === id) return;
  switching = true;
  try {
    if (currentDoc && saveTimer) { clearTimeout(saveTimer); saveTimer = null; await saveCurrent({ reorder: false }); }
    const doc = await api('/api/documents/' + id);
    currentDoc = doc;
    docTitleEl.value = doc.title === '无标题' ? '' : doc.title;
    editor.setHTML(doc.content || '');
    Array.prototype.forEach.call(docListEl.querySelectorAll('.doc-item'), el => {
      el.classList.toggle('active', el.getAttribute('data-id') == id);
    });
    saveStateEl.textContent = '已加载';
    updateStats();
    refreshToolbar();
    updateOutline(true);
    updateDocumentTitle(doc.title);
  } catch (e) { toast('打开失败：' + (e.message || e)); }
  finally { switching = false; }
}

async function newDoc() {
  if (currentDoc && saveTimer) { clearTimeout(saveTimer); await saveCurrent(); }
  switching = true;
  try {
    const res = await api('/api/documents', 'POST', { title: '无标题', content: '' });
    await loadSidebar();
    currentDoc = { id: res.id, title: '无标题', content: '', updated_at: Date.now() };
    docTitleEl.value = '';
    editor.clear();
    Array.prototype.forEach.call(docListEl.querySelectorAll('.doc-item'), el => {
      el.classList.toggle('active', el.getAttribute('data-id') == res.id);
    });
    saveStateEl.textContent = '新文档';
    docTitleEl.focus();
    updateDocumentTitle('无标题');
    toast('已新建文档');
  } catch (e) { toast('新建失败：' + (e.message || e)); }
  finally { switching = false; }
}

$('newDocBtn').addEventListener('click', newDoc);
$('newFolderBtn').addEventListener('click', createFolder);

async function confirmDelete(doc) {
  if (!confirm('删除「' + (doc.title || '无标题') + '」？此操作不可恢复。')) return;
  try {
    await api('/api/documents/' + doc.id, 'DELETE');
    if (currentDoc && currentDoc.id === doc.id) {
      const remaining = await api('/api/documents');
      await loadSidebar();
      if (remaining.length) await openDoc(remaining[0].id);
      else { currentDoc = null; await newDoc(); }
    } else {
      await loadSidebar();
    }
    toast('已删除');
  } catch (e) { toast('删除失败：' + (e.message || e)); }
}

/* ---------- 标题 ---------- */
docTitleEl.addEventListener('input', () => {
  updateDocumentTitle(docTitleEl.value);
  scheduleAutoSave();
});

/* ---------- 搜索 ---------- */
let searchTimer = null;
searchInput.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 250);
});

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) { await loadSidebar(); return; }
  try {
    const results = await api('/api/search?q=' + encodeURIComponent(q));
    renderSearchResults(results);
  } catch (e) { toast('搜索失败'); }
}

function renderSearchResults(results) {
  docListEl.innerHTML = '';
  if (!results.length) {
    docListEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-faint);font-size:12px;">无匹配文档</div>';
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'folder-item expanded';
  wrap.innerHTML = '<div class="folder-head"><span class="folder-arrow" style="visibility:hidden"><svg width="12" height="12" viewBox="0 0 16 16"></svg></span><span class="folder-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.2"/><line x1="10.2" y1="10.2" x2="13.5" y2="13.5"/></svg></span><span class="folder-name">搜索结果</span><span class="folder-count">' + results.length + '</span></div>';
  const list = document.createElement('div');
  list.className = 'folder-docs';
  results.forEach(doc => list.appendChild(buildDocItem(doc)));
  wrap.appendChild(list);
  docListEl.appendChild(wrap);
}

// 清空搜索时恢复
searchInput.addEventListener('search', () => {
  if (!searchInput.value) loadSidebar();
});

/* ---------- 主题切换：纸墨 → 雾纸 → 夜墨 ---------- */
const THEME_LABELS = { light: '纸墨', feishu: '雾纸', dark: '夜墨' };
const THEME_ORDER = ['light', 'feishu', 'dark'];
const THEME_COLORS = { light: '#F4F2ED', feishu: '#F4F6F4', dark: '#171B1C' };
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.light);
}
function initTheme() {
  const saved = localStorage.getItem('penmark_theme');
  const theme = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(theme);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const idx = THEME_ORDER.indexOf(cur);
  const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
  applyTheme(next);
  localStorage.setItem('penmark_theme', next);
  toast('主题：' + THEME_LABELS[next]);
}
$('themeToggle').addEventListener('click', toggleTheme);

/* ---------- 移动端侧边栏抽屉 ---------- */
const sidebarEl = $('sidebar');
const mobileBackdrop = $('mobileBackdrop');
function openSidebar() {
  sidebarEl.classList.add('open');
  mobileBackdrop.classList.add('show');
}
function closeSidebar() {
  sidebarEl.classList.remove('open');
  mobileBackdrop.classList.remove('show');
}
$('mobileMenuBtn').addEventListener('click', openSidebar);
mobileBackdrop.addEventListener('click', closeSidebar);
// 选择文档后自动收起侧边栏（窄屏下）
docListEl.addEventListener('click', (e) => {
  if (window.innerWidth <= 760 && e.target.closest('.doc-item') && !e.target.classList.contains('doc-del')) {
    closeSidebar();
  }
});

/* ---------- 导入 HTML 文件 ---------- */
importInput.addEventListener('change', () => {
  const f = importInput.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    if (currentDoc && saveTimer) { clearTimeout(saveTimer); }
    switching = true;
    editor.loadFromHTMLString(r.result);
    switching = false;
    updateStats();
    // 立即保存到当前文档
    saveCurrent();
    toast('已导入');
  };
  r.readAsText(f, 'UTF-8');
  importInput.value = '';
});

/* ---------- 导出 ---------- */
function suggestedFilename(ext) {
  const title = (docTitleEl.value.trim() || '知著文档').replace(/[\\/:*?"<>|]/g, '_').replace(/\.+$/, '');
  return title + '.' + ext;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

function exportHTML() {
  const html = editor.buildSelfContainedHTML();
  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), suggestedFilename('html'));
  toast('已导出 HTML');
}
function exportMarkdown() {
  const md = editor.toMarkdown();
  downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), suggestedFilename('md'));
  toast('已导出 Markdown');
}
function exportWord() {
  const html = editor.toWordHTML();
  downloadBlob(new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' }), suggestedFilename('doc'));
  toast('已导出 Word');
}

// 导出图片前清理 HTML：
// 1) 所有 SVG 补 width/height
// 2) link-card 强制包裹
// 3) 空壳 link-card（无描述且无缩略图）降级为简洁链接样式
function sanitizeForImageExport(html) {
  const tpl = document.createElement('div');
  tpl.innerHTML = html;
  // 1) 给所有无尺寸 SVG 补 24x24
  tpl.querySelectorAll('svg').forEach(svg => {
    if (!svg.getAttribute('width')) svg.setAttribute('width', '24');
    if (!svg.getAttribute('height')) svg.setAttribute('height', '24');
    if (!svg.getAttribute('viewBox') && svg.getAttribute('width') && svg.getAttribute('height')) {
      svg.setAttribute('viewBox', '0 0 ' + svg.getAttribute('width') + ' ' + svg.getAttribute('height'));
    }
  });
  // 2) link-card 强制 max-width + flex-wrap
  tpl.querySelectorAll('.link-card').forEach(card => {
    card.style.maxWidth = '100%';
    card.style.flexWrap = 'wrap';
    // 3) 空壳卡片降级：加个 class，CSS 把它变简洁
    const hasDesc = !!card.querySelector('.lc-desc');
    const hasThumb = !!card.querySelector('.lc-thumb');
    if (!hasDesc && !hasThumb) {
      card.classList.add('lc-empty');
    }
  });
  return tpl.innerHTML;
}

/* ---------- 导出图片 ---------- */
// 通用 link-card 样式：每个导出主题都会拼接
const EXPORT_LINK_CARD_CSS = '.export-doc .doc .link-card{display:flex;flex-wrap:wrap;align-items:center;width:100%;max-width:100%;margin:.8em 0;padding:12px 14px;background:rgba(127,127,127,.06);border:1px solid rgba(127,127,127,.2);border-radius:8px;text-decoration:none;color:inherit;box-sizing:border-box;}.export-doc .doc .link-card.lc-empty{padding:8px 14px;background:transparent;border:none;border-radius:0;border-bottom:1px solid rgba(127,127,127,.25);font-size:.95em;}.export-doc .doc .link-card.lc-empty .lc-main{flex-direction:row;gap:8px;align-items:baseline;}.export-doc .doc .link-card.lc-empty .lc-title{font-size:1em;font-weight:500;}.export-doc .doc .link-card.lc-empty .lc-domain{font-size:.85em;opacity:.6;margin:0;}.export-doc .doc .link-card .lc-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;}.export-doc .doc .link-card .lc-title{font-size:1em;font-weight:600;line-height:1.4;text-decoration:none;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}.export-doc .doc .link-card .lc-desc{font-size:.85em;line-height:1.5;opacity:.75;text-decoration:none;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}.export-doc .doc .link-card .lc-domain{font-size:.78em;opacity:.55;margin-top:2px;text-decoration:none;}.export-doc .doc .link-card .lc-thumb{flex:0 0 auto;width:64px;height:64px;margin-left:12px;border-radius:6px;overflow:hidden;}.export-doc .doc .link-card .lc-thumb img{width:100%;height:100%;object-fit:cover;}.export-doc .doc .link-card.no-thumb .lc-thumb{display:none;}.export-doc .doc .link-card .lc-open{display:none;}.export-doc .doc .link-card .lc-open svg{width:14px;height:14px;}';

const EXPORT_IMAGE_STYLES = {
  default: {
    name: '默认',
    css: '.export-doc{background:#fdfbf5;}.export-doc .doc{color:#2b2a27;font-family:"Songti SC","Source Han Serif SC","SimSun",Georgia,serif;line-height:1.85;font-size:17px;padding:48px 60px;box-sizing:border-box;}.doc h1{font-size:1.9em;margin:1.2em 0 .6em;}.doc h2{font-size:1.5em;margin:1.1em 0 .5em;}.doc h3{font-size:1.2em;margin:1em 0 .4em;}.doc p{margin:.6em 0;}.doc blockquote{margin:.8em 0;padding:.4em 1.1em;border-left:3px solid #c9bc9a;background:#f5f0e3;color:#6b6660;border-radius:0 4px 4px 0;font-style:italic;}.doc ul,.doc ol{margin:.6em 0;padding-left:1.8em;}.doc hr{border:none;border-top:1px solid #e6e0d4;margin:1.6em 0;}.doc pre{background:#f0ece0;border:1px solid #d9d2bf;border-radius:6px;padding:14px 16px;overflow-x:auto;font-family:Consolas,monospace;font-size:13.5px;}.doc table{border-collapse:collapse;width:100%;margin:.8em 0;}.doc th,.doc td{border:1px solid #e6e0d4;padding:8px 12px;}.doc th{background:#efe9dc;}.doc img{max-width:100%;height:auto;display:block;margin:12px auto;}.doc a{color:#b87333;text-decoration:underline;}' + EXPORT_LINK_CARD_CSS
  },
  wechat: {
    name: '公众号',
    css: '.export-doc{background:#fff;}.export-doc .doc{color:#333;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;line-height:1.8;font-size:15px;padding:32px 40px;box-sizing:border-box;}.doc h1{font-size:1.7em;margin:1em 0 .5em;color:#1a1a1a;}.doc h2{font-size:1.4em;margin:.9em 0 .4em;color:#1a1a1a;}.doc h3{font-size:1.15em;margin:.8em 0 .3em;color:#1a1a1a;}.doc p{margin:.5em 0;letter-spacing:.3px;}.doc blockquote{margin:.6em 0;padding:.3em 1em;border-left:3px solid #576b95;background:#f7f7f7;color:#888;}.doc ul,.doc ol{margin:.5em 0;padding-left:1.6em;}.doc hr{border:none;border-top:1px solid #e5e5e5;margin:1.2em 0;}.doc pre{background:#f5f5f5;border-radius:4px;padding:12px 14px;font-size:13px;}.doc table{border-collapse:collapse;width:100%;}.doc th,.doc td{border:1px solid #e0e0e0;padding:6px 10px;}.doc th{background:#f0f0f0;}.doc img{max-width:100%;height:auto;display:block;margin:10px auto;border-radius:4px;}.doc a{color:#576b95;text-decoration:none;}' + EXPORT_LINK_CARD_CSS
  },
  simple: {
    name: '简约',
    css: '.export-doc{background:#fff;}.export-doc .doc{color:#333;font-family:"Georgia","Times New Roman",serif;line-height:1.7;font-size:16px;padding:40px 56px;box-sizing:border-box;}.doc h1{font-size:1.6em;margin:1em 0 .5em;font-weight:700;}.doc h2{font-size:1.3em;margin:.8em 0 .4em;font-weight:700;}.doc h3{font-size:1.1em;margin:.7em 0 .3em;font-weight:700;}.doc p{margin:.5em 0;}.doc blockquote{margin:.6em 0;padding:.3em 1em;border-left:2px solid #ccc;color:#666;}.doc ul,.doc ol{margin:.5em 0;padding-left:1.6em;}.doc hr{border:none;border-top:1px solid #eee;margin:1.2em 0;}.doc pre{background:#f9f9f9;border:1px solid #eee;border-radius:4px;padding:12px 14px;font-size:13.5px;}.doc table{border-collapse:collapse;width:100%;}.doc th,.doc td{border:1px solid #ddd;padding:6px 10px;}.doc th{background:#f5f5f5;}.doc img{max-width:100%;height:auto;display:block;margin:10px auto;}.doc a{color:#0366d6;text-decoration:underline;}' + EXPORT_LINK_CARD_CSS
  },
  dark: {
    name: '暗色',
    css: '.export-doc{background:#1e1e1e;}.export-doc .doc{color:#d4d4d4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.8;font-size:15px;padding:40px 56px;box-sizing:border-box;}.doc h1{font-size:1.7em;margin:1em 0 .5em;color:#e8e8e8;}.doc h2{font-size:1.4em;margin:.9em 0 .4em;color:#e0e0e0;}.doc h3{font-size:1.15em;margin:.8em 0 .3em;color:#d8d8d8;}.doc p{margin:.5em 0;}.doc blockquote{margin:.6em 0;padding:.3em 1em;border-left:3px solid #444;background:#2a2a2a;color:#aaa;}.doc ul,.doc ol{margin:.5em 0;padding-left:1.6em;}.doc hr{border:none;border-top:1px solid #333;margin:1.2em 0;}.doc pre{background:#2a2a2a;border:1px solid #333;border-radius:4px;padding:12px 14px;font-size:13px;}.doc table{border-collapse:collapse;width:100%;}.doc th,.doc td{border:1px solid #444;padding:6px 10px;}.doc th{background:#2d2d2d;}.doc img{max-width:100%;height:auto;display:block;margin:10px auto;}.doc a{color:#6ea8fe;text-decoration:underline;}' + EXPORT_LINK_CARD_CSS
  }
};

let currentExportStyle = 'default';
let exportRenderTimer = null;

function openExportImageModal() {
  if (!currentDoc) return;
  const modal = $('exportImageModal');
  currentExportStyle = 'default';

  // 样式列表
  const stylesEl = $('expimgStyles');
  stylesEl.querySelectorAll('.expimg-style').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-style') === currentExportStyle);
    btn.onclick = () => {
      currentExportStyle = btn.getAttribute('data-style');
      stylesEl.querySelectorAll('.expimg-style').forEach(b => b.classList.toggle('active', b === btn));
      debounceExportPreview();
    };
  });

  // 列宽滑块
  const slider = $('expimgWidth');
  const valEl = $('expimgWidthVal');
  slider.oninput = () => {
    valEl.textContent = slider.value + 'px';
    debounceExportPreview();
  };
  valEl.textContent = slider.value + 'px';

  // 分辨率
  const scaleSel = $('expimgScale');
  scaleSel.onchange = () => {};  // 分辨率只影响下载，预览始终 1x

  // 下载按钮
  const downloadBtn = $('expimgDownload');
  downloadBtn.onclick = () => downloadExportImage();

  // 关闭
  $('exportImageClose').onclick = () => modal.hidden = true;
  modal.onclick = (e) => { if (e.target === modal) modal.hidden = true; };

  modal.hidden = false;
  debounceExportPreview();
}

function debounceExportPreview() {
  if (exportRenderTimer) clearTimeout(exportRenderTimer);
  exportRenderTimer = setTimeout(updateExportPreview, 150);
}

async function updateExportPreview() {
  const preview = $('expimgPreview');
  const container = $('exportRenderContainer');
  preview.classList.remove('empty');
  preview.innerHTML = '<span style="color:var(--ink-faint)">渲染中…</span>';

  try {
    const style = EXPORT_IMAGE_STYLES[currentExportStyle];
    const width = parseInt($('expimgWidth').value, 10);
    const content = editor.getHTML();

    // 清理导出 HTML：给所有 SVG 补上默认尺寸，给 link-card 强制约束
    const cleanContent = sanitizeForImageExport(content);

    // 渲染到隐藏容器
    // 用唯一 style id 强制覆盖 + 把 <style> 放在容器外层避免 dom-to-image-more 缓存
    const styleId = 'export-style-' + Date.now();
    container.innerHTML =
      '<style id="' + styleId + '">' + style.css + '</style>' +
      '<div id="exportRenderNode" class="export-doc" style="width:' + width + 'px;box-sizing:border-box;">' +
        '<div class="doc">' + cleanContent + '</div>' +
      '</div>';

    // 等待图片 + 字体加载
    const imgs = container.querySelectorAll('img');
    await Promise.all(Array.from(imgs).map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(resolve => { img.onload = resolve; img.onerror = resolve; });
    }));
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (_) {}
    }
    // 强制 reflow 确保样式生效
    void container.offsetHeight;

    // 截图
    const node = container.querySelector('#exportRenderNode');
    if (!node) throw new Error('渲染失败');

    const previewScale = Math.min(1, (preview.clientWidth - 32) / width);
    const dataUrl = await window.domtoimage.toPng(node, {
      width: width,
      height: node.scrollHeight,
      style: { transform: 'scale(1)', transformOrigin: 'top left' },
      quality: 0.95,
      cacheBust: true
    });

    // 预览图 1x 截，按精确宽度显示；预览框横向滚动避免被压缩
    preview.innerHTML = '<img src="' + dataUrl + '" alt="预览" style="width:' + width + 'px;height:auto;display:block">';
  } catch (e) {
    preview.classList.add('empty');
    preview.textContent = '预览失败：' + (e.message || e);
  }
}

function buildExportImageHTML(content, styleCss, width) {
  return '<div class="export-doc" style="width:' + width + 'px;box-sizing:border-box;">' +
    '<style>' + styleCss + '</style>' +
    '<div class="doc">' + content + '</div>' +
    '</div>';
}

async function downloadExportImage() {
  const downloadBtn = $('expimgDownload');
  const container = $('exportRenderContainer');
  downloadBtn.disabled = true;
  downloadBtn.textContent = '生成中…';

  try {
    const width = parseInt($('expimgWidth').value, 10);
    const scale = parseInt($('expimgScale').value, 10);
    const node = container.querySelector('.export-doc');
    if (!node) throw new Error('请先生成预览');

    const dataUrl = await window.domtoimage.toPng(node, {
      width: width * scale,
      height: node.scrollHeight * scale,
      style: { transform: 'scale(' + scale + ')', transformOrigin: 'top left' },
      quality: 0.95
    });

    // 下载
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = suggestedFilename('png');
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); }, 100);

    toast('已导出图片');
  } catch (e) {
    toast('导出失败：' + (e.message || e));
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.textContent = '下载 PNG';
  }
}



/* ---------- Table tools ---------- */
const tableFloatMenu = document.createElement('div');
tableFloatMenu.className = 'table-float-menu';
tableFloatMenu.hidden = true;
tableFloatMenu.innerHTML =
  '<button class="table-tool" data-table-action="row-before" title="在上方插入行">+\u2191</button>' +
  '<button class="table-tool" data-table-action="row-after" title="在下方插入行">+\u2193</button>' +
  '<span class="table-tool-sep"></span>' +
  '<button class="table-tool" data-table-action="col-left" title="在左侧插入列">+\u2190</button>' +
  '<button class="table-tool" data-table-action="col-right" title="在右侧插入列">+\u2192</button>' +
  '<span class="table-tool-sep"></span>' +
  '<button class="table-tool" data-table-action="equalize" title="均分全部列宽">等宽</button>' +
  '<button class="table-tool" data-table-action="merge" title="按住 Shift 点击选择连续单元格后合并">合并</button>' +
  '<button class="table-tool" data-table-action="split" title="拆分当前合并单元格">拆分</button>' +
  '<label class="table-color-tool" title="设置所选单元格背景色"><span>底色</span><input type="color" id="tableCellColor" value="#fff8dc"></label>' +
  '<button class="table-tool" data-table-action="clear-bg" title="清除单元格背景色">清底色</button>' +
  '<span class="table-tool-sep"></span>' +
  '<button class="table-tool" data-table-action="toggle-header" title="切换表头">H</button>' +
  '<button class="table-tool" data-table-action="delete-row" title="删除行">\u2212\u2194</button>' +
  '<button class="table-tool" data-table-action="delete-col" title="删除列">\u2212\u2195</button>' +
  '<button class="table-tool danger" data-table-action="delete-table" title="删除表格">\u00d7</button>';
document.body.appendChild(tableFloatMenu);

function tableColorToHex(value) {
  if (/^#[0-9a-f]{6}$/i.test(value || '')) return value;
  const match = String(value || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) return '#fff8dc';
  return '#' + match.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('');
}

function updateTableFloatMenu() {
  const state = editor.getTableState ? editor.getTableState() : null;
  const table = state && state.table;
  if (!state || !state.active || !table || document.body.classList.contains('reading-mode')) { tableFloatMenu.hidden = true; return; }
  const rect = table.getBoundingClientRect();
  tableFloatMenu.hidden = false;
  const mergeBtn = tableFloatMenu.querySelector('[data-table-action="merge"]');
  const splitBtn = tableFloatMenu.querySelector('[data-table-action="split"]');
  if (mergeBtn) mergeBtn.disabled = !state.canMerge;
  if (splitBtn) splitBtn.disabled = !state.canSplit;
  const colorInput = tableFloatMenu.querySelector('#tableCellColor');
  if (colorInput && document.activeElement !== colorInput) colorInput.value = tableColorToHex(state.backgroundColor);
  const width = tableFloatMenu.offsetWidth || 280;
  let left = rect.left + Math.min(rect.width - width, 0) / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.top - tableFloatMenu.offsetHeight - 8;
  if (top < 8) top = rect.top + 8;
  tableFloatMenu.style.left = left + 'px';
  tableFloatMenu.style.top = top + 'px';
}

['mouseup', 'keyup'].forEach(type => editorEl.addEventListener(type, () => setTimeout(updateTableFloatMenu, 10)));
editorEl.addEventListener('penmark:table-state', () => setTimeout(updateTableFloatMenu, 0));
document.addEventListener('selectionchange', () => setTimeout(updateTableFloatMenu, 20));
window.addEventListener('scroll', () => { if (!tableFloatMenu.hidden) updateTableFloatMenu(); }, true);
window.addEventListener('resize', () => { if (!tableFloatMenu.hidden) updateTableFloatMenu(); });
tableFloatMenu.addEventListener('mousedown', e => { if (!e.target.closest('input')) e.preventDefault(); });
tableFloatMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-table-action]');
  if (!btn || btn.disabled) return;
  editor.tableCommand(btn.getAttribute('data-table-action'));
  setTimeout(updateTableFloatMenu, 10);
});
tableFloatMenu.querySelector('#tableCellColor').addEventListener('change', (e) => {
  editor.setTableCellBackground(e.target.value);
  setTimeout(updateTableFloatMenu, 10);
});

/* ---------- AI tools (on-demand) ---------- */
let savedAiRange = null;
let pendingAiLayoutHtml = '';
let pendingAiRewriteText = '';
let aiStatusPromise = null;
let aiStatusCache = null;


async function getAiStatus(force) {
  if (aiStatusCache && !force) return aiStatusCache;
  if (!aiStatusPromise || force) {
    aiStatusPromise = api('/api/ai/status').then(res => {
      aiStatusCache = res;
      return res;
    }).finally(() => { aiStatusPromise = null; });
  }
  return aiStatusPromise;
}

async function refreshAiStatus(runButtonId) {
  const note = $('aiStatusNote');
  const runBtn = $(runButtonId);
  if (runBtn) runBtn.disabled = true;
  if (note) {
    note.hidden = false;
    note.textContent = '正在检查 AI 配置…';
  }
  try {
    const status = await getAiStatus(false);
    if (!status.configured) {
      if (note) note.textContent = '服务器还没配置 AI 密钥，请在 .env 里设置 AI_API_KEY 或 DEEPSEEK_API_KEY。';
      return false;
    }
    if (note) {
      note.textContent = '已连接 AI：' + (status.model || 'model');
      note.classList.add('ok');
    }
    if (runBtn) runBtn.disabled = false;
    return true;
  } catch (e) {
    if (note) note.textContent = '暂时无法检查 AI 状态：' + (e.message || e);
    return false;
  }
}

const AI_PRESETS = {
  share: '\u5206\u4eab\u524d\u6392\u7248',
  light: '\u8f7b\u5ea6\u6574\u7406',
  formal: '\u6b63\u5f0f\u6587\u6863',
  clean: '\u6e05\u7406\u6742\u6837\u5f0f'
};

const AI_REWRITE_PRESETS = [
  { label: '\u53ea\u505a\u6392\u7248', value: '\u53ea\u5bf9\u9009\u4e2d\u5185\u5bb9\u505a\u6392\u7248\u548c\u5206\u6bb5\u6574\u7406\uff0c\u4e0d\u5220\u5b57\uff0c\u4e0d\u6539\u5199\u8bcd\u53e5\uff0c\u4e0d\u8865\u5145\u65b0\u5185\u5bb9\u3002' },
  { label: '\u6da6\u8272', value: '\u5728\u4e0d\u6539\u53d8\u539f\u610f\u548c\u7ec6\u8282\u7684\u524d\u63d0\u4e0b\uff0c\u8ba9\u9009\u4e2d\u6587\u5b57\u66f4\u987a\u3001\u66f4\u81ea\u7136\u3002' },
  { label: '\u6269\u5199', value: '\u57fa\u4e8e\u9009\u4e2d\u5185\u5bb9\u9002\u5ea6\u6269\u5199\uff0c\u4e0d\u865a\u6784\u4e8b\u5b9e\uff0c\u98ce\u683c\u548c\u5168\u6587\u4fdd\u6301\u4e00\u81f4\u3002' }
];

function openAiModal(title, bodyHtml) {
  if (!aiModal) return;
  aiModalTitle.textContent = title;
  aiModalBody.innerHTML = bodyHtml;
  aiModal.hidden = false;
}

function closeAiModal() {
  if (aiModal) aiModal.hidden = true;
  pendingAiLayoutHtml = '';
  pendingAiRewriteText = '';
}

if (aiModalClose) aiModalClose.addEventListener('click', closeAiModal);
if (aiModal) {
  aiModal.addEventListener('pointerdown', (e) => {
    if (e.target === aiModal) closeAiModal();
  });
}

function getDocumentContextText() {
  return (docTitleEl.value.trim() + '\n\n' + (editorEl.innerText || '')).trim().slice(0, 24000);
}

function saveAiSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
  const range = sel.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) return '';
  savedAiRange = range.cloneRange();
  return sel.toString();
}

function restoreAiSelection() {
  if (!savedAiRange) return false;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedAiRange);
  return true;
}

function textToEditorHtml(text) {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function markEditorChanged() {
  editorEl.dispatchEvent(new Event('input', { bubbles: true }));
  updateStats();
  updateOutline();
  scheduleAutoSave();
}

function openAiLayoutModal() {
  if (!currentDoc) { toast('\u8bf7\u5148\u6253\u5f00\u4e00\u7bc7\u6587\u6863'); return; }
  const presetButtons = Object.keys(AI_PRESETS).map(key =>
    '<button class="ai-preset' + (key === 'share' ? ' active' : '') + '" data-preset="' + key + '">' + AI_PRESETS[key] + '</button>'
  ).join('');
  openAiModal('AI 排版',
    '<div class="ai-panel" id="aiLayoutPanel">' +
      '<div class="ai-note">调整结构、分段、标题、列表和间距；默认不删字、不改写。</div>' +
      '<div class="ai-warning" id="aiStatusNote"></div>' +
      '<div class="ai-preset-row">' + presetButtons + '</div>' +
      '<div class="ai-warning" id="aiLayoutWarning" hidden></div>' +
      '<div class="ai-preview empty" id="aiLayoutPreview">\u70b9\u51fb\u751f\u6210\u540e\u5728\u8fd9\u91cc\u9884\u89c8</div>' +
      '<div class="ai-actions">' +
        '<button class="ai-action" id="aiLayoutRun" disabled>\u751f\u6210\u9884\u89c8</button>' +
        '<button class="ai-action primary" id="aiLayoutApply" disabled>\u5e94\u7528\u5230\u6587\u6863</button>' +
      '</div>' +
    '</div>');
  let currentPreset = 'share';
  aiModalBody.querySelectorAll('.ai-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPreset = btn.getAttribute('data-preset');
      aiModalBody.querySelectorAll('.ai-preset').forEach(b => b.classList.toggle('active', b === btn));
    });
  });
  $('aiLayoutRun').addEventListener('click', () => runAiLayout(currentPreset));
  refreshAiStatus('aiLayoutRun');
  $('aiLayoutApply').addEventListener('click', applyAiLayoutResult);
}

async function runAiLayout(preset) {
  const runBtn = $('aiLayoutRun');
  const applyBtn = $('aiLayoutApply');
  const preview = $('aiLayoutPreview');
  const warning = $('aiLayoutWarning');
  runBtn.disabled = true;
  applyBtn.disabled = true;
  warning.hidden = true;
  preview.classList.add('empty');
  preview.textContent = '正在排版，稍等一下…';
  try {
    const res = await api('/api/ai/layout', 'POST', { html: editor.getHTML(), preset });
    pendingAiLayoutHtml = res.html || '';
    preview.classList.remove('empty');
    preview.innerHTML = pendingAiLayoutHtml || '';
    applyBtn.disabled = !pendingAiLayoutHtml;
    if (!res.textUnchanged) {
      warning.hidden = false;
      warning.textContent = '注意：AI 返回的文字数量和原文不完全一致（原文 ' + res.beforeChars + ' 字 / 结果 ' + res.afterChars + ' 字），请先对比再应用。';
    }
  } catch (e) {
    preview.classList.add('empty');
    preview.textContent = '\u751f\u6210\u5931\u8d25\uff1a' + (e.message || e);
  } finally {
    runBtn.disabled = false;
  }
}

function applyAiLayoutResult() {
  if (!pendingAiLayoutHtml) return;
  editor.setHTML(pendingAiLayoutHtml);
  markEditorChanged();
  closeAiModal();
  toast('AI \u6392\u7248\u5df2\u5e94\u7528');
}

function openAiRewriteModal() {
  const selectedText = saveAiSelection();
  if (!selectedText.trim()) { toast('\u8bf7\u5148\u9009\u4e2d\u8981\u5904\u7406\u7684\u6587\u5b57'); return; }
  const presetHtml = AI_REWRITE_PRESETS.map((p, i) =>
    '<button class="ai-preset" data-rewrite-preset="' + i + '">' + p.label + '</button>'
  ).join('');
  openAiModal('AI \u6539\u9009\u533a',
    '<div class="ai-panel" id="aiRewritePanel">' +
      '<div class="ai-note">AI \u4f1a\u8bfb\u53d6\u5168\u6587\u4f5c\u4e3a\u80cc\u666f\uff0c\u4f46\u53ea\u66ff\u6362\u4f60\u9009\u4e2d\u7684\u8fd9\u6bb5\u3002</div>' +
      '<div class="ai-preset-row">' + presetHtml + '</div>' +
      '<div class="ai-warning" id="aiStatusNote"></div>' +
      '<div class="ai-field"><label>\u6307\u4ee4</label><textarea class="ai-input" id="aiRewriteInstruction" placeholder="\u8f93\u5165\u5bf9\u9009\u4e2d\u6587\u5b57\u7684\u5904\u7406\u8981\u6c42\uff0c\u6216\u70b9\u4e0a\u65b9\u9884\u8bbe\u5957\u7528\u53c2\u8003\u6307\u4ee4"></textarea></div>' +
      '<div class="ai-preview empty" id="aiRewritePreview">\u70b9\u300c\u751f\u6210\u9884\u89c8\u300d\u5148\u770b\u6548\u679c\uff1b\u6216\u76f4\u63a5\u70b9\u300c\u5e94\u7528\u300d\u4e00\u952e\u751f\u6210\u5e76\u66ff\u6362\uff08\u53ef\u64a4\u9500\uff09</div>' +
      '<div class="ai-actions">' +
        '<button class="ai-action" id="aiRewriteRun" disabled>\u751f\u6210\u9884\u89c8</button>' +
        '<button class="ai-action" id="aiRewriteApply">\u5e94\u7528</button>' +
      '</div>' +
    '</div>');
  const input = $('aiRewriteInstruction');
  const runBtn = $('aiRewriteRun');
  const applyBtn = $('aiRewriteApply');
  let aiReady = false;
  input.value = '';
  input.focus();
  // 输入框为空时禁用「生成预览」，引导用户先写指令
  const updateRunBtn = () => { runBtn.disabled = !(aiReady && input.value.trim().length > 0); };
  input.addEventListener('input', updateRunBtn);
  aiModalBody.querySelectorAll('[data-rewrite-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = AI_REWRITE_PRESETS[Number(btn.getAttribute('data-rewrite-preset'))].value;
      input.focus();
      updateRunBtn();
    });
  });
  runBtn.addEventListener('click', () => runAiRewrite(selectedText));
  applyBtn.addEventListener('click', () => applyAiRewriteResult(selectedText));
  runBtn.disabled = true;
  refreshAiStatus('aiRewriteRun').then(ok => { aiReady = ok; updateRunBtn(); });
}

async function runAiRewrite(selectedText) {
  const runBtn = $('aiRewriteRun');
  const applyBtn = $('aiRewriteApply');
  const preview = $('aiRewritePreview');
  const instruction = $('aiRewriteInstruction').value.trim();
  runBtn.disabled = true;
  preview.classList.add('empty');
  preview.textContent = '\u6b63\u5728\u5904\u7406\uff0c\u7a0d\u7b49\u4e00\u4e0b...';
  // 重新生成预览时，应用按钮先回到弱色，生成成功后再变强调色
  applyBtn.classList.remove('primary');
  try {
    const res = await api('/api/ai/rewrite-selection', 'POST', { selectedText, instruction, contextText: getDocumentContextText() });
    pendingAiRewriteText = res.replacement || '';
    preview.classList.remove('empty');
    preview.innerHTML = textToEditorHtml(pendingAiRewriteText);
    if (pendingAiRewriteText) applyBtn.classList.add('primary');
  } catch (e) {
    preview.classList.add('empty');
    preview.textContent = '\u751f\u6210\u5931\u8d25\uff1a' + (e.message || e);
  } finally {
    runBtn.disabled = false;
  }
}

async function applyAiRewriteResult(selectedText) {
  const applyBtn = $('aiRewriteApply');
  // 1) 已生成预览：直接应用预览内容
  if (pendingAiRewriteText) {
    if (!restoreAiSelection()) return;
    document.execCommand('insertHTML', false, textToEditorHtml(pendingAiRewriteText));
    markEditorChanged();
    hideFloatMenu();
    closeAiModal();
    toast('AI \u5df2\u66ff\u6362\u9009\u533a');
    return;
  }
  // 2) 没有预览：直接调用 API 生成并替换，附悬浮撤销气泡
  const instruction = $('aiRewriteInstruction').value.trim();
  if (!instruction) { toast('\u8bf7\u5148\u8f93\u5165\u6307\u4ee4\u6216\u70b9\u300c\u751f\u6210\u9884\u89c8\u300d'); return; }
  if (!restoreAiSelection()) return;
  // 保存当前选区内容用于撤销
  const undoRange = savedAiRange.cloneRange();
  const undoFrag = undoRange.cloneContents();
  const undoHolder = document.createElement('div');
  undoHolder.appendChild(undoFrag);
  const originalHtml = undoHolder.innerHTML;
  // 禁用按钮 + 显示加载态
  applyBtn.disabled = true;
  const prevText = applyBtn.textContent;
  applyBtn.textContent = '\u751f\u6210\u4e2d\u2026';
  try {
    const res = await api('/api/ai/rewrite-selection', 'POST', { selectedText, instruction, contextText: getDocumentContextText() });
    if (!res || !res.replacement) { toast('AI \u672a\u8fd4\u56de\u5185\u5bb9'); return; }
    document.execCommand('insertHTML', false, textToEditorHtml(res.replacement));
    markEditorChanged();
    hideFloatMenu();
    closeAiModal();
    showAiUndoBubble(originalHtml);
  } catch (e) {
    toast('AI \u5931\u8d25\uff1a' + (e.message || e));
  } finally {
    applyBtn.disabled = false;
    applyBtn.textContent = prevText;
  }
}

/* ---------- 快速 AI：浮动菜单内嵌输入框，回车直接改写选区 ---------- */
const fmAiQuick = $('fmAiQuick');
if (fmAiQuick) {
  // 阻止输入框点击事件冒泡到 floatMenu 的隐藏逻辑
  fmAiQuick.addEventListener('mousedown', (e) => e.stopPropagation());
  // 记录输入内容 + 时间戳，用于 1 分钟内恢复
  fmAiQuick.addEventListener('input', () => {
    fmAiQuickLastInput = fmAiQuick.value;
    fmAiQuickLastTime = Date.now();
  });
  fmAiQuick.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runQuickAi();
    } else if (e.key === 'Escape') {
      fmAiQuick.value = '';
      fmAiQuickLastInput = '';
      fmAiQuickLastTime = 0;
      fmAiQuick.blur();
      hideFloatMenu();
    }
  });
}

async function runQuickAi() {
  const instruction = fmAiQuick.value.trim();
  if (!instruction) { toast('请输入指令'); fmAiQuick.focus(); return; }
  const selectedText = saveAiSelection();
  if (!selectedText) { toast('请先选中要改写的文字'); return; }
  // 保存原文用于撤销气泡
  const undoRange = savedAiRange.cloneRange();
  const undoFrag = undoRange.cloneContents();
  const undoHolder = document.createElement('div');
  undoHolder.appendChild(undoFrag);
  const originalHtml = undoHolder.innerHTML;

  // 调用期间不清空输入框（失败可重试，成功后才清空）
  fmAiQuick.placeholder = '✨ AI 思考中…';
  fmAiQuick.disabled = true;
  try {
    const res = await api('/api/ai/rewrite-selection', 'POST', {
      selectedText,
      instruction,
      contextText: getDocumentContextText()
    });
    if (!res || !res.replacement) { toast('AI 未返回内容'); return; }
    // 恢复选区
    restoreAiSelection();
    // 直接替换选区（用 execCommand 留下 undo 记录）
    document.execCommand('insertHTML', false, textToEditorHtml(res.replacement));
    markEditorChanged();
    // 成功：清空输入和保留状态，下次重新开始
    fmAiQuick.value = '';
    fmAiQuickLastInput = '';
    fmAiQuickLastTime = 0;
    hideFloatMenu();
    showAiUndoBubble(originalHtml);
  } catch (e) {
    toast('AI 失败：' + (e.message || e));
  } finally {
    fmAiQuick.disabled = false;
    fmAiQuick.placeholder = '✨ 改写成...';
  }
}

/* 悬浮撤销气泡：替换后显示，点击恢复原文 */
let aiUndoBubble = null;
let aiUndoTimer = null;
function showAiUndoBubble(originalHtml) {
  if (aiUndoBubble) aiUndoBubble.remove();
  if (aiUndoTimer) clearTimeout(aiUndoTimer);
  aiUndoBubble = document.createElement('div');
  aiUndoBubble.className = 'ai-undo-bubble';
  aiUndoBubble.innerHTML =
    '<span class="ai-undo-text">已用 AI 改写</span>' +
    '<button type="button" class="ai-undo-btn" title="恢复原文">撤销</button>';
  document.body.appendChild(aiUndoBubble);
  // 定位在编辑器顶部居中
  const er = editorEl.getBoundingClientRect();
  const bw = aiUndoBubble.offsetWidth;
  aiUndoBubble.style.left = (er.left + er.width / 2 - bw / 2) + 'px';
  aiUndoBubble.style.top = (er.top + 14) + 'px';
  aiUndoBubble.querySelector('.ai-undo-btn').addEventListener('click', () => {
    // 当前光标位置回退为原文
    try {
      const sel = window.getSelection();
      if (sel.rangeCount) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        const tmp = document.createElement('div');
        tmp.innerHTML = originalHtml;
        const frag = document.createDocumentFragment();
        while (tmp.firstChild) frag.appendChild(tmp.firstChild);
        r.insertNode(frag);
        markEditorChanged();
      }
    } catch (_) {}
    hideAiUndoBubble();
  });
  aiUndoTimer = setTimeout(hideAiUndoBubble, 8000);
}
function hideAiUndoBubble() {
  if (aiUndoBubble) { aiUndoBubble.remove(); aiUndoBubble = null; }
  if (aiUndoTimer) { clearTimeout(aiUndoTimer); aiUndoTimer = null; }
}

let shortcutHelpEl = null;
const shortcutGroups = [
  ['AI', [
    ['Ctrl/\u2318 + Alt + A', '\u6574\u7bc7 AI \u6392\u7248'],
    ['Ctrl/\u2318 + Alt + I', '\u9009\u533a AI \u6539\u5199/\u6392\u7248']
  ]],
  ['文档', [
    ['Ctrl/⌘ + N', '新建文章'],
    ['Ctrl/⌘ + S', '保存当前文章'],
    ['Ctrl/⌘ + F', '搜索文章'],
    ['Ctrl/⌘ + /', '打开快捷键面板'],
    ['Ctrl/⌘ + Alt + R', '切换阅读模式']
  ]],
  ['文字', [
    ['Ctrl/⌘ + B', '加粗'],
    ['Ctrl/⌘ + I', '斜体'],
    ['Ctrl/⌘ + U', '下划线'],
    ['Ctrl/⌘ + Shift + X', '删除线'],
    ['Ctrl/⌘ + K', '插入链接'],
    ['Ctrl/⌘ + \\', '清除格式']
  ]],
  ['段落', [
    ['Ctrl/⌘ + Alt + 0', '正文'],
    ['Ctrl/⌘ + Alt + 1-6', '标题 1-6'],
    ['Ctrl/⌘ + Alt + Q', '引用块'],
    ['Ctrl/⌘ + Shift + 7', '有序列表'],
    ['Ctrl/⌘ + Shift + 8', '无序列表'],
    ['Ctrl/⌘ + Shift + L/E/R/J', '左/中/右/两端对齐'],
    ['Tab / Shift + Tab', '缩进 / 反缩进'],
    ['Alt + Shift + ↑/↓', '上移 / 下移当前块']
  ]],
  ['插入与导出', [
    ['Ctrl/⌘ + Shift + M', '行内代码'],
    ['Ctrl/⌘ + Alt + C', '代码块'],
    ['Ctrl/⌘ + Alt + T', '表格'],
    ['Ctrl/⌘ + Alt + H', '分隔线'],
    ['Ctrl/⌘ + Shift + H', '导出 HTML'],
    ['Ctrl/⌘ + Shift + D', '导出 Markdown'],
    ['Ctrl/⌘ + Shift + W', '导出 Word']
  ]]
];

function buildShortcutHelp() {
  const el = document.createElement('div');
  el.className = 'shortcut-overlay';
  el.hidden = true;
  el.innerHTML = '<div class="shortcut-panel" role="dialog" aria-modal="true" aria-label="快捷键">' +
    '<div class="shortcut-head"><strong>快捷键</strong><button class="shortcut-close" type="button" title="关闭">×</button></div>' +
    '<div class="shortcut-body">' + shortcutGroups.map(group =>
      '<section class="shortcut-section"><h3>' + escapeHtml(group[0]) + '</h3>' +
      group[1].map(item => '<div class="shortcut-row"><kbd>' + escapeHtml(item[0]) + '</kbd><span>' + escapeHtml(item[1]) + '</span></div>').join('') +
      '</section>'
    ).join('') + '</div></div>';
  el.addEventListener('pointerdown', (e) => { if (e.target === el) hideShortcutHelp(); });
  el.querySelector('.shortcut-close').addEventListener('click', hideShortcutHelp);
  document.body.appendChild(el);
  return el;
}

function showShortcutHelp() {
  shortcutHelpEl = shortcutHelpEl || buildShortcutHelp();
  shortcutHelpEl.hidden = false;
}

function hideShortcutHelp() {
  if (shortcutHelpEl) shortcutHelpEl.hidden = true;
}

function isNativeField(target) {
  return !!(target && target.closest && target.closest('input, textarea, select'));
}

/* ---------- 全局快捷键 ---------- */
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { hideShortcutHelp(); if (aiModal && !aiModal.hidden) closeAiModal(); }
  if (!ctrl) return;
  if (isNativeField(e.target) && e.target !== docTitleEl && e.target !== searchInput) return;
  const k = e.key.toLowerCase();
  if (k === '/') { e.preventDefault(); showShortcutHelp(); }
  else if (k === 'a' && e.altKey) { e.preventDefault(); openAiLayoutModal(); }
  else if (k === 'i' && e.altKey) { e.preventDefault(); openAiRewriteModal(); }
  else if (k === 's' && !e.altKey) { e.preventDefault(); if (saveTimer) clearTimeout(saveTimer); saveCurrent(); }
  else if (k === 'n' && !e.shiftKey) { e.preventDefault(); newDoc(); }
  else if (k === 'f' && !e.shiftKey) { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  else if (k === 'r' && e.altKey) { e.preventDefault(); toggleReadingMode(); }
  else if (k === 'h' && e.shiftKey && !e.altKey) { e.preventDefault(); exportHTML(); }
  else if (k === 'd' && e.shiftKey && !e.altKey) { e.preventDefault(); exportMarkdown(); }
  else if (k === 'w' && e.shiftKey && !e.altKey) { e.preventDefault(); exportWord(); }
});

// 离开前保存
window.addEventListener('beforeunload', () => {
  if (currentDoc && saveTimer) { clearTimeout(saveTimer); saveCurrent(); }
});

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- 初始化 ---------- */
async function init() {
  initTheme();
  updateDocumentTitle('主页');
  initDesktop();
  try {
    // 先校验登录态
    const meRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!meRes.ok) { handleAuthFailure(); return; }
    const meBody = await meRes.json();
    currentUser = meBody.user;
    updateUserBadge();
    updateShareButton();

    const docs = await api('/api/documents');
    if (docs.length) {
      await loadSidebar();
      await openDoc(docs[0].id);
    } else {
      // 首次使用，创建欢迎文档
      const res = await api('/api/documents', 'POST', {
        title: '欢迎使用 知著 PenMark',
        content: welcomeContent()
      });
      await loadSidebar();
      await openDoc(res.id);
    }
  } catch (e) {
    if (e.message === 'need login') return;
    toast('初始化失败：' + (e.message || e));
    editor.clear();
  }
}

function updateUserBadge() {
  const badge = $('userBadge');
  if (!badge || !currentUser) return;
  badge.querySelector('.user-name').textContent = currentUser.nickname || currentUser.username;
  badge.style.display = '';
}

// 设置入口仅管理员可见；分享入口对管理员及被授权用户可见
function updateShareButton() {
  const shareBtn = $('shareBtn');
  if (shareBtn) shareBtn.style.display = (currentUser && (currentUser.isAdmin || currentUser.can_share)) ? '' : 'none';
  const settingsBtn = $('settingsBtn');
  if (settingsBtn) settingsBtn.style.display = (currentUser && currentUser.isAdmin) ? '' : 'none';
}

$('logoutBtn').addEventListener('click', async () => {
  if (window.desktop && window.desktop.isDesktop) return; // 桌面模式无退出登录
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) {}
  window.location.href = '/login.html';
});

/* ---------- 桌面模式适配 ---------- */
function initDesktop() {
  if (!window.desktop || !window.desktop.isDesktop) return;
  // 桌面模式：隐藏退出登录按钮
  const logoutBtn = $('logoutBtn');
  if (logoutBtn) logoutBtn.style.display = 'none';
  // 桌面模式：隐藏设置中不适用的标签页（用户管理、邀请码）
  document.querySelectorAll('.settings-tab[data-stab="users"], .settings-tab[data-stab="invites"]').forEach(tab => {
    tab.style.display = 'none';
  });
  // 菜单事件
  if (window.desktop.onMenuNewDoc) {
    window.desktop.onMenuNewDoc(() => newDoc());
  }
  if (window.desktop.onMenuShortcuts) {
    window.desktop.onMenuShortcuts(() => showShortcutHelp());
  }
  if (window.desktop.onLibraryImported) {
    window.desktop.onLibraryImported(async () => {
      await loadSidebar();
      toast('旧版资料库已导入');
    });
  }
}

/* ---------- 设置面板（管理员） ---------- */
const settingsModal = $('settingsModal');
const settingsModalBody = $('settingsModalBody');
let settingsTab = 'users';

$('settingsBtn').addEventListener('click', () => { if (currentUser && currentUser.isAdmin) openSettings(); });
$('settingsModalClose').addEventListener('click', () => settingsModal.hidden = true);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.hidden = true; });

$('settingsTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.settings-tab');
  if (!tab) return;
  settingsTab = tab.getAttribute('data-stab');
  $('settingsTabs').querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t === tab));
  loadSettingsTab(settingsTab);
});

function openSettings() {
  settingsModal.hidden = false;
  loadSettingsTab(settingsTab);
}

async function loadSettingsTab(tab) {
  settingsModalBody.innerHTML = '<div class="share-loading">加载中…</div>';
  try {
    if (tab === 'users') await renderUserManagement();
    else if (tab === 'invites') renderInviteList(await api('/api/invites'));
    else if (tab === 'review') await renderReviewPanel();
    else if (tab === 'sensitive') await renderSensitiveWords();
  } catch (e) {
    settingsModalBody.innerHTML = '<div class="share-error">加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}

/* ---------- 用户管理 ---------- */
async function renderUserManagement() {
  const users = await api('/api/admin/users');
  let html = '<table class="user-table"><thead><tr><th>用户名</th><th>昵称</th><th>状态</th><th>分享权限</th><th>备注</th><th>操作</th></tr></thead><tbody>';
  users.forEach(u => {
    const status = u.is_banned ? '<span class="tag-banned">已禁用</span>' : '<span style="color:var(--ink-faint);font-size:12px">正常</span>';
    const shareBtn = u.is_admin ? '<span class="tag-share">管理员</span>' : '<button class="user-share-btn' + (u.can_share ? ' active' : '') + '" data-uid="' + u.id + '" data-field="can_share">' + (u.can_share ? '已授权' : '授权') + '</button>';
    html += '<tr>' +
      '<td>' + escapeHtml(u.username) + '</td>' +
      '<td>' + escapeHtml(u.nickname) + '</td>' +
      '<td>' + status + '</td>' +
      '<td>' + shareBtn + '</td>' +
      '<td><input type="text" class="user-note-input" data-uid="' + u.id + '" value="' + escapeHtml(u.admin_note || '') + '" placeholder="—"></td>' +
      '<td>' + (u.is_admin ? '' : '<button class="user-ban-btn" data-uid="' + u.id + '" data-banned="' + (u.is_banned ? 1 : 0) + '">' + (u.is_banned ? '解禁' : '禁用') + '</button>') + '</td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  settingsModalBody.innerHTML = html;

  settingsModalBody.querySelectorAll('.user-ban-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.getAttribute('data-uid');
      const banned = btn.getAttribute('data-banned') === '1';
      try {
        await api('/api/admin/users/' + uid, 'PUT', { is_banned: !banned });
        toast(banned ? '已解禁' : '已禁用');
        renderUserManagement();
      } catch (e) { toast('操作失败'); }
    });
  });
  settingsModalBody.querySelectorAll('.user-share-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.getAttribute('data-uid');
      const active = btn.classList.contains('active');
      try {
        await api('/api/admin/users/' + uid, 'PUT', { can_share: !active });
        toast(active ? '已取消分享权限' : '已授权分享');
        renderUserManagement();
      } catch (e) { toast('操作失败'); }
    });
  });
  settingsModalBody.querySelectorAll('.user-note-input').forEach(inp => {
    inp.addEventListener('blur', async () => {
      const uid = inp.getAttribute('data-uid');
      const val = inp.value.trim();
      try {
        await api('/api/admin/users/' + uid, 'PUT', { admin_note: val });
        toast('备注已保存');
      } catch (e) { toast('保存失败'); }
    });
  });
}

/* ---------- 内容审核面板 ---------- */
async function renderReviewPanel() {
  const docs = await api('/api/admin/flagged');
  if (!docs.length) {
    settingsModalBody.innerHTML = '<div class="trash-empty">暂无待审核内容</div>';
    return;
  }
  let html = '';
  docs.forEach(d => {
    const flagged = d.flagged === 1;
    const content = (d.content || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 200);
    html += '<div class="review-item' + (flagged ? ' flagged' : '') + '">' +
      '<div class="review-item-head">' +
        '<span class="review-item-title">' + escapeHtml(d.title || '无标题') + '</span>' +
        (flagged ? '<span class="flag-badge">已标记</span>' : '') +
      '</div>' +
      '<div class="review-item-author">' + escapeHtml(d.author_nickname || '') + ' · ' + relativeTime(d.updated_at) + '</div>' +
      '<div class="review-item-content">' + escapeHtml(content) + (content.length >= 200 ? '…' : '') + '</div>' +
      '<div class="review-item-actions">' +
        '<button class="review-btn flag" data-did="' + d.id + '" data-flagged="' + (flagged ? 1 : 0) + '">' + (flagged ? '取消标记' : '标记违规') + '</button>' +
        '<button class="review-btn pass" data-did="' + d.id + '">通过</button>' +
      '</div>' +
    '</div>';
  });
  settingsModalBody.innerHTML = html;

  settingsModalBody.querySelectorAll('.review-btn.flag').forEach(btn => {
    btn.addEventListener('click', async () => {
      const did = btn.getAttribute('data-did');
      const flagged = btn.getAttribute('data-flagged') === '1';
      try {
        await api('/api/admin/flagged/' + did, 'PUT', { flagged: !flagged });
        toast(flagged ? '已取消标记' : '已标记违规');
        renderReviewPanel();
      } catch (e) { toast('操作失败'); }
    });
  });
  settingsModalBody.querySelectorAll('.review-btn.pass').forEach(btn => {
    btn.addEventListener('click', async () => {
      const did = btn.getAttribute('data-did');
      try {
        await api('/api/admin/flagged/' + did, 'PUT', { flagged: false });
        toast('已通过');
        renderReviewPanel();
      } catch (e) { toast('操作失败'); }
    });
  });
}

/* ---------- 敏感词管理 ---------- */
async function renderSensitiveWords() {
  const words = await api('/api/admin/sensitive-words');
  let html = '<div class="sensitive-input-row"><input type="text" class="sensitive-input" id="sensitiveInput" placeholder="输入敏感词" maxlength="30"><button class="sensitive-add-btn" id="sensitiveAdd">添加</button></div>';
  html += '<div class="sensitive-list" id="sensitiveList">';
  if (!words.length) {
    html += '<span style="color:var(--ink-faint);font-size:13px">暂无敏感词</span>';
  } else {
    words.forEach(w => {
      html += '<span class="sensitive-tag">' + escapeHtml(w.word) + '<button class="sensitive-tag-remove" data-id="' + w.id + '">×</button></span>';
    });
  }
  html += '</div>';
  settingsModalBody.innerHTML = html;

  $('sensitiveAdd').addEventListener('click', async () => {
    const inp = $('sensitiveInput');
    const word = inp.value.trim();
    if (!word) return;
    try {
      await api('/api/admin/sensitive-words', 'POST', { word });
      toast('已添加');
      renderSensitiveWords();
    } catch (e) { toast(e.message || '添加失败'); }
  });
  $('sensitiveInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('sensitiveAdd').click();
  });
  settingsModalBody.querySelectorAll('.sensitive-tag-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      try {
        await api('/api/admin/sensitive-words/' + id, 'DELETE');
        toast('已删除');
        renderSensitiveWords();
      } catch (e) { toast('删除失败'); }
    });
  });
}

/* ---------- 邀请码管理（设置面板 tab） ---------- */
function renderInviteList(list) {
  const unused = list.filter(i => !i.used).length;
  const used = list.length - unused;
  const copyIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>';
  let html = '<div class="invite-toolbar">' +
    '<div class="invite-stat">共 ' + list.length + ' 个 · 未用 ' + unused + ' · 已用 ' + used + '</div>' +
    '<div class="invite-actions">' +
    '<button class="seg-btn" id="genOneBtn">生成 1 个</button>' +
    '<button class="seg-btn" id="genFiveBtn">生成 5 个</button>' +
    '</div></div>';
  if (!list.length) {
    html += '<div class="invite-empty">暂无邀请码，点击上方生成</div>';
  } else {
    html += '<div class="invite-table-wrap"><table class="invite-table">' +
      '<thead><tr><th>邀请码</th><th>状态</th><th>注册用户</th><th>创建时间</th><th></th></tr></thead><tbody>';
    list.forEach(i => {
      const code = escapeHtml(i.code);
      const status = i.used
        ? '<span class="invite-tag used">已使用</span>'
        : '<span class="invite-tag unused">未使用</span>';
      const user = i.used
        ? '<span class="invite-user">' + escapeHtml(i.registered_nickname || '') + (i.registered_username ? '<small>' + escapeHtml(i.registered_username) + '</small>' : '') + '</span>'
        : '';
      const del = i.used
        ? ''
        : '<button class="invite-del" data-code="' + code + '" title="删除">删除</button>';
      const codeCell = i.used
        ? '<div class="invite-code-cell used"><code class="invite-code">' + code + '</code></div>'
        : '<div class="invite-code-cell"><code class="invite-code" title="点击复制">' + code + '</code><button class="invite-copy-btn" data-code="' + code + '" title="复制">' + copyIcon + '</button></div>';
      html += '<tr>' +
        '<td>' + codeCell + '</td>' +
        '<td>' + status + '</td>' +
        '<td>' + user + '</td>' +
        '<td class="invite-time">' + relativeTime(i.created_at) + '</td>' +
        '<td>' + del + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
  }
  settingsModalBody.innerHTML = html;

  const genOne = $('genOneBtn');
  const genFive = $('genFiveBtn');
  if (genOne) genOne.addEventListener('click', () => generateInvites(1));
  if (genFive) genFive.addEventListener('click', () => generateInvites(5));
  settingsModalBody.querySelectorAll('.invite-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const code = btn.getAttribute('data-code');
      if (!confirm('确定删除邀请码 ' + code + '？')) return;
      try {
        await api('/api/invites/' + encodeURIComponent(code), 'DELETE');
        toast('已删除');
        loadSettingsTab('invites');
      } catch (e) { toast('删除失败：' + (e.message || e)); }
    });
  });
  // 点击邀请码或复制按钮复制（仅未使用）
  const copyCode = (text) => {
    navigator.clipboard.writeText(text).then(() => toast('已复制：' + text)).catch(() => {});
  };
  settingsModalBody.querySelectorAll('.invite-code-cell:not(.used) .invite-code').forEach(el => {
    el.addEventListener('click', () => copyCode(el.textContent));
  });
  settingsModalBody.querySelectorAll('.invite-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyCode(btn.getAttribute('data-code'));
    });
  });
}

async function generateInvites(count) {
  try {
    await api('/api/invites', 'POST', { count });
    toast('已生成 ' + count + ' 个邀请码');
    loadSettingsTab('invites');
  } catch (e) {
    toast('生成失败：' + (e.message || e));
  }
}

/* ---------- 回收站 ---------- */
const trashModal = $('trashModal');
const trashModalBody = $('trashModalBody');
$('trashBtn').addEventListener('click', openTrash);
$('trashModalClose').addEventListener('click', () => trashModal.hidden = true);
trashModal.addEventListener('click', (e) => { if (e.target === trashModal) trashModal.hidden = true; });

async function openTrash() {
  trashModal.hidden = false;
  trashModalBody.innerHTML = '<div class="share-loading">加载中…</div>';
  try {
    const list = await api('/api/trash');
    if (!list.length) {
      trashModalBody.innerHTML = '<div class="trash-empty">回收站为空</div>';
      return;
    }
    let html = '';
    list.forEach(d => {
      html += '<div class="trash-item">' +
        '<div>' +
          '<div class="trash-item-title">' + escapeHtml(d.title || '无标题') + '</div>' +
          '<div class="trash-item-meta">删除于 ' + relativeTime(d.deleted_at) + '</div>' +
        '</div>' +
        '<div class="trash-item-actions">' +
          '<button class="trash-restore" data-id="' + d.id + '">恢复</button>' +
          '<button class="trash-delete" data-id="' + d.id + '">永久删除</button>' +
        '</div>' +
      '</div>';
    });
    trashModalBody.innerHTML = html;
    trashModalBody.querySelectorAll('.trash-restore').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        try {
          await api('/api/trash/' + id + '/restore', 'POST');
          toast('已恢复');
          openTrash();
          loadSidebar();
        } catch (e) { toast('恢复失败'); }
      });
    });
    trashModalBody.querySelectorAll('.trash-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!confirm('永久删除不可恢复，确定？')) return;
        try {
          await api('/api/trash/' + id, 'DELETE');
          toast('已永久删除');
          openTrash();
        } catch (e) { toast('删除失败'); }
      });
    });
  } catch (e) {
    trashModalBody.innerHTML = '<div class="share-error">加载失败</div>';
  }
}

function welcomeContent() {
  return '<h1>欢迎使用 知著 PenMark</h1>' +
    '<p>一个安静的写作空间，专注图文整理与排版。</p>' +
    '<h2>快速上手</h2>' +
    '<ul>' +
    '<li><b>拖入图片</b>：直接把图片拖到编辑区即可插入</li>' +
    '<li><b>粘贴图文</b>：复制图片或文字，Ctrl+V 粘贴，格式和图片都会保留</li>' +
    '<li><b>Markdown 快捷输入</b>：行首输入 <code>#</code> + 空格变标题，<code>-</code> + 空格变列表，<code>&gt;</code> + 空格变引用，<code>```</code> + 空格变代码块</li>' +
    '<li><b>图片缩放</b>：点击图片选中，拖动四角圆点等比缩放</li>' +
    '<li><b>多文档</b>：左侧新建、切换、搜索文档，可分文件夹存放</li>' +
    '<li><b>导出</b>：右上角导出 HTML / Markdown / Word</li>' +
    '</ul>' +
    '<blockquote>「见微知著」——一图一文，安心写作。</blockquote>';
}

/* ---------- 分享弹窗 ---------- */
const shareModal = $('shareModal');
const shareModalBody = $('shareModalBody');
$('shareModalClose').addEventListener('click', () => shareModal.hidden = true);
shareModal.addEventListener('click', (e) => { if (e.target === shareModal) shareModal.hidden = true; });

async function openShareModal() {
  if (!currentDoc) { toast('请先选择文档'); return; }
  if (!currentUser || (!currentUser.isAdmin && !currentUser.can_share)) { toast('无分享权限'); return; }
  shareModal.hidden = false;
  shareModalBody.innerHTML = '<div class="share-loading">加载中…</div>';
  try {
    const res = await api('/api/documents/' + currentDoc.id + '/share');
    renderShareForm(res.share);
  } catch (e) {
    shareModalBody.innerHTML = '<div class="share-error">加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}

function renderShareForm(share) {
  if (!share) {
    shareModalBody.innerHTML =
      '<div class="share-empty">' +
        '<div class="share-empty-icon">🔗</div>' +
        '<div class="share-empty-text">尚未分享此文档</div>' +
        '<button class="share-create-btn" id="shareCreate">开启分享</button>' +
      '</div>';
    $('shareCreate').addEventListener('click', async () => {
      try {
        const res = await api('/api/documents/' + currentDoc.id + '/share', 'POST', { permission: 'view' });
        toast('已开启分享');
        renderShareForm({ permission: res.permission, has_password: res.has_password, expire_at: res.expire_at, url: res.url });
      } catch (e) { toast('开启失败：' + (e.message || e)); }
    });
    return;
  }

  const permission = share.permission;
  const hasPassword = share.has_password;
  const expireAt = share.expire_at;
  const url = location.origin + share.url;
  let expVal = '';
  if (expireAt) {
    const d = new Date(expireAt);
    const p = n => n < 10 ? '0' + n : n;
    expVal = d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  shareModalBody.innerHTML =
    '<div class="share-section">' +
      '<div class="share-label">访问权限</div>' +
      '<div class="share-seg" id="sharePermSeg">' +
        '<button class="seg-btn' + (permission==='view'?' active':'') + '" data-perm="view">仅查看</button>' +
        '<button class="seg-btn' + (permission==='edit'?' active':'') + '" data-perm="edit">可编辑</button>' +
      '</div>' +
    '</div>' +
    '<div class="share-section">' +
      '<div class="share-row">' +
        '<span class="share-label">密码保护</span>' +
        '<label class="switch"><input type="checkbox" id="sharePwdToggle"' + (hasPassword?' checked':'') + '><span class="switch-slider"></span></label>' +
      '</div>' +
      '<div class="share-pin-row" id="sharePinRow"' + (hasPassword?'':' style="display:none"') + '>' +
        '<div class="share-pin" id="sharePin">' +
          '<input type="text" maxlength="1" class="pin-input" inputmode="text" autocomplete="off">' +
          '<input type="text" maxlength="1" class="pin-input" inputmode="text" autocomplete="off">' +
          '<input type="text" maxlength="1" class="pin-input" inputmode="text" autocomplete="off">' +
          '<input type="text" maxlength="1" class="pin-input" inputmode="text" autocomplete="off">' +
        '</div>' +
        '<span class="share-pin-hint">4位字母或数字，输完自动保存</span>' +
      '</div>' +
    '</div>' +
    '<div class="share-section">' +
      '<div class="share-row">' +
        '<span class="share-label">过期时间</span>' +
        '<label class="switch"><input type="checkbox" id="shareExpToggle"' + (expireAt?' checked':'') + '><span class="switch-slider"></span></label>' +
      '</div>' +
      '<div class="share-exp-row" id="shareExpRow"' + (expireAt?'':' style="display:none"') + '>' +
        '<input type="datetime-local" id="shareExp" class="share-input" value="' + expVal + '">' +
        '<button class="share-confirm-btn" id="shareExpConfirm">确定</button>' +
      '</div>' +
    '</div>' +
    '<div class="share-section">' +
      '<div class="share-label">默认主题</div>' +
      '<div class="share-theme-row" id="shareThemeRow">' +
        '<button class="share-theme-btn' + (share.theme === 'light' ? ' active' : '') + '" data-theme="light">纸墨</button>' +
        '<button class="share-theme-btn' + (share.theme === 'feishu' ? ' active' : '') + '" data-theme="feishu">雾纸</button>' +
        '<button class="share-theme-btn' + (share.theme === 'dark' ? ' active' : '') + '" data-theme="dark">夜墨</button>' +
      '</div>' +
    '</div>' +
    '<div class="share-link-section">' +
      '<div class="share-link-label">分享链接</div>' +
      '<div class="share-link-row">' +
        '<input type="text" class="share-link-url" id="shareLinkUrl" value="' + escapeHtml(url) + '" readonly>' +
        '<button class="share-copy" id="shareCopy">复制</button>' +
      '</div>' +
      '<div class="share-hint" id="shareHint">' + buildShareHint(share) + '</div>' +
    '</div>' +
    '<div class="share-actions">' +
      '<button class="share-revoke" id="shareRevoke">撤销分享</button>' +
    '</div>';

  // 权限切换：实时保存
  $('sharePermSeg').addEventListener('click', async (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    const perm = btn.getAttribute('data-perm');
    try { await updateShare({ permission: perm }); toast('已更新权限'); } catch (_) {}
  });

  // 密码开关
  const pwdToggle = $('sharePwdToggle');
  const pinRow = $('sharePinRow');
  pwdToggle.addEventListener('change', async () => {
    if (!pwdToggle.checked) {
      try { await updateShare({ password: '' }); toast('已关闭密码保护'); } catch (_) {}
      pinRow.style.display = 'none';
    } else {
      pinRow.style.display = '';
      setupPinInputs();
      const first = pinRow.querySelector('.pin-input');
      if (first) first.focus();
    }
  });
  if (hasPassword) setupPinInputs();

  // 过期开关
  const expToggle = $('shareExpToggle');
  const expRow = $('shareExpRow');
  expToggle.addEventListener('change', async () => {
    if (!expToggle.checked) {
      try { await updateShare({ expire_at: 0 }); toast('已取消过期限制'); } catch (_) {}
      expRow.style.display = 'none';
    } else {
      expRow.style.display = '';
    }
  });

  // 过期确定按钮
  $('shareExpConfirm').addEventListener('click', async () => {
    const val = $('shareExp').value;
    if (!val) { toast('请选择日期'); return; }
    const ts = new Date(val).getTime();
    if (ts < Date.now()) { toast('过期时间必须晚于当前'); return; }
    try { await updateShare({ expire_at: ts }); toast('已设置过期时间'); } catch (_) {}
  });

  // 复制链接
  $('shareCopy').addEventListener('click', () => {
    const urlInput = $('shareLinkUrl');
    urlInput.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(urlInput.value).then(() => toast('链接已复制')).catch(() => { document.execCommand('copy'); toast('链接已复制'); });
    } else { document.execCommand('copy'); toast('链接已复制'); }
  });

  // 撤销分享
  $('shareRevoke').addEventListener('click', revokeShare);

  // 主题切换
  shareModalBody.querySelectorAll('.share-theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const theme = btn.getAttribute('data-theme');
      try {
        await api('/api/documents/' + currentDoc.id + '/share/theme', 'PUT', { theme });
        shareModalBody.querySelectorAll('.share-theme-btn').forEach(b => b.classList.toggle('active', b === btn));
        toast('主题已更新');
      } catch (e) { toast('更新失败'); }
    });
  });
}

function buildShareHint(share) {
  let text = '';
  if (share.has_password) text += '· 需密码 ';
  text += (share.permission==='edit' ? '· 可编辑' : '· 仅查看');
  if (share.expire_at) text += ' · 过期 ' + new Date(share.expire_at).toLocaleString();
  else text += ' · 永久有效';
  return text;
}

function setupPinInputs() {
  const pinRow = $('sharePinRow');
  if (!pinRow) return;
  const inputs = pinRow.querySelectorAll('.pin-input');
  inputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (input.value && i < inputs.length - 1) inputs[i + 1].focus();
      if (Array.prototype.every.call(inputs, inp => inp.value)) {
        const pwd = Array.prototype.map.call(inputs, inp => inp.value).join('');
        updateShare({ password: pwd }).then(() => toast('密码已保存')).catch(() => {});
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && i > 0) inputs[i - 1].focus();
    });
  });
}

async function updateShare(patch) {
  if (!currentDoc) return;
  try {
    const res = await api('/api/documents/' + currentDoc.id + '/share', 'POST', patch);
    // 局部更新 UI
    document.querySelectorAll('#sharePermSeg .seg-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-perm') === res.permission);
    });
    const hint = $('shareHint');
    if (hint) hint.textContent = buildShareHint(res);
    return res;
  } catch (e) { toast('保存失败：' + (e.message || e)); throw e; }
}

async function revokeShare() {
  if (!currentDoc) return;
  if (!confirm('撤销分享？持有链接的人将无法再访问。')) return;
  try {
    await api('/api/documents/' + currentDoc.id + '/share', 'DELETE');
    toast('已撤销分享');
    renderShareForm(null);
  } catch (e) { toast('撤销失败：' + (e.message || e)); }
}

/* ---------- 编辑模式目录大纲（飞书式） ---------- */
const docOutline = document.createElement('aside');
docOutline.className = 'doc-outline';
docOutline.id = 'docOutline';
docOutline.hidden = true;
document.body.appendChild(docOutline);

let outlineTimer = null;
let outlineObserver = null;
let outlineScrollRoot = null;
let outlineScrollHandler = null;
let outlineScrollFrame = null;
let outlinePinnedIdx = null;
let outlineProgrammaticScroll = false;
let outlineProgrammaticTimer = null;

function updateOutline(immediate) {
  if (outlineTimer) clearTimeout(outlineTimer);
  const build = () => {
    if (readingMode) { docOutline.hidden = true; return; }
    // 过滤 .toc 内的标题，和编辑器 _buildTOCHTML 保持一致
    const headings = Array.from(editorEl.querySelectorAll('h1, h2, h3')).filter(h => !h.closest('.toc'));
    if (headings.length < 2) { docOutline.hidden = true; return; }
    // 强制按文档顺序分配唯一 ID（消除导入文档中可能的重复 ID）
    const prefix = 'outline-' + (currentDoc ? currentDoc.id : 'draft') + '-';
    headings.forEach((h, i) => { h.id = prefix + i; });
    let html = '<div class="outline-title">大纲</div><ol class="outline-list">';
    headings.forEach((h, i) => {
      const level = h.tagName.toLowerCase();
      const indent = level === 'h2' ? 'padding-left:1.2em;' : (level === 'h3' ? 'padding-left:2.4em;' : '');
      const text = h.textContent.trim() || '空标题';
      html += '<li style="' + indent + '"><a href="#' + h.id + '" data-outline-idx="' + i + '">' + escapeHtml(text) + '</a></li>';
    });
    html += '</ol>';
    docOutline.innerHTML = html;
    docOutline.hidden = false;
    positionOutline();
    setupOutlineObserver(headings);
  };
  if (immediate) {
    build();
  } else {
    outlineTimer = setTimeout(build, 300);
  }
}

function setupOutlineObserver(headings) {
  if (outlineObserver) outlineObserver.disconnect();
  if (outlineScrollRoot && outlineScrollHandler) {
    outlineScrollRoot.removeEventListener('scroll', outlineScrollHandler);
  }
  if (outlineScrollFrame) cancelAnimationFrame(outlineScrollFrame);
  outlineScrollRoot = null;
  outlineScrollHandler = null;
  outlineScrollFrame = null;
  outlinePinnedIdx = null;
  outlineProgrammaticScroll = false;
  if (outlineProgrammaticTimer) clearTimeout(outlineProgrammaticTimer);
  outlineProgrammaticTimer = null;
  const links = docOutline.querySelectorAll('a');
  const wrap = document.querySelector('.editor-wrap');
  const toolbar = document.querySelector('.toolbar');
  // 点击跳转 — 用数组下标代替 getElementById，不依赖 ID 唯一性
  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const idx = parseInt(link.getAttribute('data-outline-idx'), 10);
      const target = headings[idx];
      if (!target) return;
      outlinePinnedIdx = idx;
      outlineProgrammaticScroll = true;
      if (outlineProgrammaticTimer) clearTimeout(outlineProgrammaticTimer);
      outlineProgrammaticTimer = setTimeout(() => {
        outlineProgrammaticScroll = false;
        outlineProgrammaticTimer = null;
      }, 1000);
      links.forEach((item, i) => item.classList.toggle('active', i === idx));
      // 正文实际滚动容器是 .editor-wrap，不是 window。
      const wrapRect = wrap.getBoundingClientRect();
      const top = target.getBoundingClientRect().top - wrapRect.top + wrap.scrollTop - 24;
      wrap.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    });
  });
  // 滚动高亮当前章节
  const updateActiveHeading = () => {
    if (!headings.length) return;
    if (outlinePinnedIdx !== null) {
      links.forEach((l, i) => l.classList.toggle('active', i === outlinePinnedIdx));
      return;
    }
    const marker = wrap.getBoundingClientRect().top + 32;
    let activeIdx = 0;
    headings.forEach((h, i) => {
      if (h.getBoundingClientRect().top <= marker) activeIdx = i;
    });
    links.forEach((l, i) => l.classList.toggle('active', i === activeIdx));
  };
  outlineObserver = new IntersectionObserver(updateActiveHeading, {
    root: wrap,
    rootMargin: '-80px 0px -70% 0px'
  });
  headings.forEach(h => outlineObserver.observe(h));
  outlineScrollRoot = wrap;
  outlineScrollHandler = () => {
    if (!outlineProgrammaticScroll) outlinePinnedIdx = null;
    if (outlineScrollFrame) return;
    outlineScrollFrame = requestAnimationFrame(() => {
      outlineScrollFrame = null;
      updateActiveHeading();
    });
  };
  wrap.addEventListener('scroll', outlineScrollHandler, { passive: true });
  updateActiveHeading();
}

function positionOutline() {
  if (docOutline.hidden) return;
  const shell = document.querySelector('.document-shell');
  const sidebar = document.querySelector('.sidebar');
  const toolbar = document.querySelector('.toolbar');
  if (!shell || !sidebar) return;
  const shellRect = shell.getBoundingClientRect();
  const sidebarRect = sidebar.getBoundingClientRect();
  const available = shellRect.left - sidebarRect.right;
  if (available < 190) {
    docOutline.hidden = true;
    return;
  }
  const width = Math.min(200, available - 40);
  docOutline.style.width = width + 'px';
  docOutline.style.left = Math.max(sidebarRect.right + 16, shellRect.left - width - 24) + 'px';
  docOutline.style.top = Math.max((toolbar ? toolbar.getBoundingClientRect().bottom : 0) + 24, shellRect.top + 48) + 'px';
}

window.addEventListener('resize', () => {
  if (!docOutline.hidden) positionOutline();
  else updateOutline();
});
/* ---------- 阅读模式 ---------- */
const readingExitBtn = $('readingExit');
let readingMode = false;

function toggleReadingMode() {
  readingMode = !readingMode;
  document.body.classList.toggle('reading-mode', readingMode);
  readingExitBtn.hidden = !readingMode;
  if (readingMode) {
    hideFloatMenu();
    floatMenuImg.hidden = true;
    editorEl.contentEditable = 'false';
  } else {
    editorEl.contentEditable = 'true';
  }
}

readingExitBtn.addEventListener('click', toggleReadingMode);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && readingMode) {
    e.preventDefault();
    toggleReadingMode();
  }
});

init();
