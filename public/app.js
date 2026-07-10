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
let switching = false; // 切换文档时屏蔽自动保存

/* ---------- Toast ---------- */
function toast(msg) {
  if (!toastStack) return;
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
    case 'share': openShareModal(); break;
    
    case 'aiLayout': openAiLayoutModal(); break;
    case 'aiRewrite': openAiRewriteModal(); break;
    case 'reading': toggleReadingMode(); break;
  }
}

function refreshToolbar() {
  const toolbar = $('toolbar');
  const btns = toolbar ? toolbar.querySelectorAll('.tb-btn[data-cmd]') : [];
  editor.refreshToolbarState(btns, blockStyleSel);
}

document.addEventListener('selectionchange', () => {
  if (document.activeElement === editorEl) refreshToolbar();
});

/* ---------- 飞书式浮动菜单：选中显示完整菜单，点击显示精简菜单（标题层级） ---------- */
const floatMenu = $('floatMenu');
const floatMenuImg = $('floatMenuImg');

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
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) { hideFloatMenu(); return; }
  const range = sel.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) { hideFloatMenu(); return; }
  // 选区在 img-container 内时不显示文字菜单
  if (range.commonAncestorContainer.nodeType === 1 && range.commonAncestorContainer.closest && range.commonAncestorContainer.closest('.img-container')) {
    hideFloatMenu();
    return;
  }

  if (!sel.isCollapsed) {
    // 有选区：显示完整菜单
    floatMenu.classList.remove('compact');
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { hideFloatMenu(); return; }
    showFloatMenu(floatMenu, rect, 'top');
    refreshFloatMenuState();
  } else {
    // 无选区（光标定位）：显示精简菜单（标题层级），定位在当前行左侧
    const block = getCurrentBlockElement();
    if (!block) { hideFloatMenu(); return; }
    const rect = block.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { hideFloatMenu(); return; }
    floatMenu.classList.add('compact');
    showFloatMenuAtLeft(floatMenu, rect);
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

function hideAllFloatMenus() {
  hideFloatMenu();
  floatMenuImg.hidden = true;
  tableFloatMenu.hidden = true;
}

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
  const cmd = btn.getAttribute('data-cmd');
  const block = btn.getAttribute('data-block');
  const action = btn.getAttribute('data-action');
  if (cmd) editor.exec(cmd);
  else if (block) editor.exec('formatBlock', '<' + block + '>');
  else if (action) handleAction(action);
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
// 点击编辑器外隐藏所有浮动菜单
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('.float-menu') || e.target.closest('.table-float-menu')) return;
  if (!editorEl.contains(e.target) && !e.target.closest('.img-container')) {
    hideFloatMenu();
    floatMenuImg.hidden = true;
    tableFloatMenu.hidden = true;
  }
});

/* ---------- 右键上下文菜单（飞书式，精简版） ---------- */
const ctxMenu = $('ctxMenu');
let ctxAnchor = null; // 右键命中的链接（若有）

editorEl.addEventListener('contextmenu', (e) => {
  if (readingMode) return; // 阅读模式禁用右键编辑菜单
  // 仅在编辑区内有效
  const block = getCurrentBlockElement();
  // 命中链接？
  const a = e.target.closest('a');
  ctxAnchor = (a && editorEl.contains(a)) ? a : null;
  e.preventDefault();
  hideFloatMenu();
  floatMenuImg.hidden = true;
  buildCtxMenu(ctxAnchor, block);
  positionCtxMenu(e.clientX, e.clientY);
});

function buildCtxMenu(anchor, block) {
  let html = '';
  // 链接上下文：优先显示链接相关操作
  if (anchor) {
    const isCard = anchor.getAttribute('data-link-card') === '1';
    if (isCard) {
      html += ctxBtn('open', '↗', '在新标签打开');
      html += ctxBtn('delete', '✕', '删除卡片', true);
    } else {
      html += ctxBtn('card', '▦', '转为链接卡片');
      html += ctxBtn('unwrap', '🔗', '取消链接');
      html += ctxBtn('open', '↗', '在新标签打开');
    }
    html += '<div class="ctx-sep"></div>';
  }
  // 格式：正文/H1/H2/H3
  html += '<div class="ctx-grid">';
  html += ctxGridBtn('P', '正文', currentBlockTag(block) === 'P');
  html += ctxGridBtn('H1', 'H1', currentBlockTag(block) === 'H1');
  html += ctxGridBtn('H2', 'H2', currentBlockTag(block) === 'H2');
  html += ctxGridBtn('H3', 'H3', currentBlockTag(block) === 'H3');
  html += '</div>';
  html += '<div class="ctx-sep"></div>';
  // 列表
  html += ctxBtn('ul', '•', '无序列表');
  html += ctxBtn('ol', '1.', '有序列表');
  html += '<div class="ctx-sep"></div>';
  // 插入
  html += ctxBtn('codeblock', '{ }', '代码块');
  html += ctxBtn('quote', '❝', '引用');
  html += ctxBtn('hr', '—', '分割线');
  html += '<div class="ctx-sep"></div>';
  // 编辑
  html += ctxBtn('cut', '✂', '剪切');
  html += ctxBtn('copy', '⎘', '复制');
  html += ctxBtn('duplicate', '⧉', '复制此段');
  html += ctxBtn('delete', '✕', '删除', true);
  ctxMenu.innerHTML = html;
}

function ctxBtn(action, icon, label, danger) {
  return '<button class="ctx-btn' + (danger ? ' danger' : '') + '" data-ctx="' + action + '">' +
    '<span class="ctx-icon">' + icon + '</span><span>' + label + '</span></button>';
}
function ctxGridBtn(block, label, active) {
  return '<button class="ctx-btn' + (active ? ' active' : '') + '" data-ctx="block" data-block="' + block + '">' + label + '</button>';
}
function currentBlockTag(block) {
  if (!block || block === editorEl) return '';
  return block.tagName.toUpperCase();
}

function positionCtxMenu(x, y) {
  ctxMenu.hidden = false;
  const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
  let left = x, top = y;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = y - mh;
  if (top < 8) top = 8;
  if (left < 8) left = 8;
  ctxMenu.style.left = left + 'px';
  ctxMenu.style.top = top + 'px';
}

function hideCtxMenu() { ctxMenu.hidden = true; ctxAnchor = null; }

ctxMenu.addEventListener('mousedown', (e) => e.preventDefault()); // 不失焦
ctxMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('.ctx-btn');
  if (!btn) return;
  const action = btn.getAttribute('data-ctx');
  const block = btn.getAttribute('data-block');
  const anchor = ctxAnchor; // 先捕获，hideCtxMenu 会清空
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
  if (!a || !editorEl.contains(a)) return;
  const isCard = a.getAttribute('data-link-card') === '1';
  const openTarget = e.target.closest('.lc-open');
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
// cookie 同源自动携带；遇 401 跳登录页
let currentUser = null;
async function api(url, method, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  if (r.status === 401) {
    // 未登录或登录失效，跳转到登录页
    window.location.href = '/login.html';
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
    '<span class="folder-arrow">▸</span>' +
    '<span class="folder-icon">▤</span>' +
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
    '<div class="folder-head"><span class="folder-arrow" style="visibility:hidden">▸</span>' +
    '<span class="folder-icon">▸</span>' +
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
    updateOutline();
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
docTitleEl.addEventListener('input', () => scheduleAutoSave());

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
  wrap.innerHTML = '<div class="folder-head"><span class="folder-arrow" style="visibility:hidden">▸</span><span class="folder-icon">⌕</span><span class="folder-name">搜索结果</span><span class="folder-count">' + results.length + '</span></div>';
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

/* ---------- 主题切换：纸张 → 飞书 → 暗色 ---------- */
const THEME_LABELS = { light: '纸张', feishu: '飞书', dark: '暗色' };
const THEME_ORDER = ['light', 'feishu', 'dark'];
function initTheme() {
  const saved = localStorage.getItem('penmark_theme');
  const theme = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const idx = THEME_ORDER.indexOf(cur);
  const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
  document.documentElement.setAttribute('data-theme', next);
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
  const title = (docTitleEl.value.trim() || '知著文档').replace(/[\\/:*?"<>|]/g, '_');
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



/* ---------- Table tools ---------- */
const tableFloatMenu = document.createElement('div');
tableFloatMenu.className = 'table-float-menu';
tableFloatMenu.hidden = true;
tableFloatMenu.innerHTML =
  '<button class="table-tool" data-table-action="row-before" title="Add row above">+\u2191</button>' +
  '<button class="table-tool" data-table-action="row-after" title="Add row below">+\u2193</button>' +
  '<span class="table-tool-sep"></span>' +
  '<button class="table-tool" data-table-action="col-left" title="Add column left">+\u2190</button>' +
  '<button class="table-tool" data-table-action="col-right" title="Add column right">+\u2192</button>' +
  '<span class="table-tool-sep"></span>' +
  '<button class="table-tool" data-table-action="toggle-header" title="Toggle header">H</button>' +
  '<button class="table-tool" data-table-action="delete-row" title="Delete row">\u2212\u2194</button>' +
  '<button class="table-tool" data-table-action="delete-col" title="Delete column">\u2212\u2195</button>' +
  '<button class="table-tool danger" data-table-action="delete-table" title="Delete table">\u00d7</button>';
document.body.appendChild(tableFloatMenu);

function updateTableFloatMenu() {
  const cell = editor.currentTableCell && editor.currentTableCell();
  const table = cell && cell.closest('table');
  if (!table || document.body.classList.contains('reading-mode')) { tableFloatMenu.hidden = true; return; }
  const rect = table.getBoundingClientRect();
  tableFloatMenu.hidden = false;
  const width = tableFloatMenu.offsetWidth || 280;
  let left = rect.left + Math.min(rect.width - width, 0) / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.top - tableFloatMenu.offsetHeight - 8;
  if (top < 8) top = rect.top + 8;
  tableFloatMenu.style.left = left + 'px';
  tableFloatMenu.style.top = top + 'px';
}

['mouseup', 'keyup'].forEach(type => editorEl.addEventListener(type, () => setTimeout(updateTableFloatMenu, 10)));
document.addEventListener('selectionchange', () => {
  if (document.activeElement === editorEl) setTimeout(updateTableFloatMenu, 20);
});
window.addEventListener('scroll', () => { if (!tableFloatMenu.hidden) updateTableFloatMenu(); }, true);
window.addEventListener('resize', () => { if (!tableFloatMenu.hidden) updateTableFloatMenu(); });
tableFloatMenu.addEventListener('mousedown', e => e.preventDefault());
tableFloatMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-table-action]');
  if (!btn) return;
  editor.tableCommand(btn.getAttribute('data-table-action'));
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
    note.textContent = '\u6b63\u5728\u68c0\u67e5 AI \u914d\u7f6e...';
  }
  try {
    const status = await getAiStatus(false);
    if (!status.configured) {
      if (note) note.textContent = '\u670d\u52a1\u5668\u8fd8\u6ca1\u914d AI key\uff0c\u8bf7\u5728 .env \u91cc\u8bbe\u7f6e AI_API_KEY \u6216 DEEPSEEK_API_KEY\u3002';
      return false;
    }
    if (note) {
      note.textContent = '\u5df2\u8fde\u63a5 AI\uff1a' + (status.model || 'model');
      note.classList.add('ok');
    }
    if (runBtn) runBtn.disabled = false;
    return true;
  } catch (e) {
    if (note) note.textContent = '\u6682\u65f6\u65e0\u6cd5\u68c0\u67e5 AI \u72b6\u6001\uff1a' + (e.message || e);
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
  hideAllFloatMenus();
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
  openAiModal('AI \u6392\u7248',
    '<div class="ai-panel" id="aiLayoutPanel">' +
      '<div class="ai-note">\u53ea\u8c03\u6574\u7ed3\u6784\u3001\u5206\u6bb5\u3001\u6807\u9898\u3001\u5217\u8868\u548c\u95f4\u8ddd\uff1b\u9ed8\u8ba4\u4e0d\u5220\u5b57\u3001\u4e0d\u6539\u5199\u3002</div>' +
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
  preview.textContent = '\u6b63\u5728\u6392\u7248\uff0c\u7a0d\u7b49\u4e00\u4e0b...';
  try {
    const res = await api('/api/ai/layout', 'POST', { html: editor.getHTML(), preset });
    pendingAiLayoutHtml = res.html || '';
    preview.classList.remove('empty');
    preview.innerHTML = pendingAiLayoutHtml || '';
    applyBtn.disabled = !pendingAiLayoutHtml;
    if (!res.textUnchanged) {
      warning.hidden = false;
      warning.textContent = '\u6ce8\u610f\uff1aAI \u8fd4\u56de\u7684\u53ef\u89c1\u6587\u5b57\u6570\u548c\u539f\u6587\u4e0d\u5b8c\u5168\u4e00\u81f4\uff08\u539f\u6587 ' + res.beforeChars + ' / \u7ed3\u679c ' + res.afterChars + '\uff09\uff0c\u8bf7\u5148\u5bf9\u6bd4\u518d\u5e94\u7528\u3002';
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
      '<div class="ai-field"><label>\u6307\u4ee4</label><textarea class="ai-input" id="aiRewriteInstruction" placeholder="\u4f8b\u5982\uff1a\u53ea\u505a\u6392\u7248\uff0c\u4e0d\u6539\u5b57"></textarea></div>' +
      '<div class="ai-preview empty" id="aiRewritePreview">\u70b9\u51fb\u751f\u6210\u540e\u5728\u8fd9\u91cc\u9884\u89c8</div>' +
      '<div class="ai-actions">' +
        '<button class="ai-action" id="aiRewriteRun" disabled>\u751f\u6210\u9884\u89c8</button>' +
        '<button class="ai-action primary" id="aiRewriteApply" disabled>\u66ff\u6362\u9009\u533a</button>' +
      '</div>' +
    '</div>');
  const input = $('aiRewriteInstruction');
  input.value = AI_REWRITE_PRESETS[0].value;
  input.focus();
  aiModalBody.querySelectorAll('[data-rewrite-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = AI_REWRITE_PRESETS[Number(btn.getAttribute('data-rewrite-preset'))].value;
      input.focus();
    });
  });
  $('aiRewriteRun').addEventListener('click', () => runAiRewrite(selectedText));
  refreshAiStatus('aiRewriteRun');
  $('aiRewriteApply').addEventListener('click', applyAiRewriteResult);
}

async function runAiRewrite(selectedText) {
  const runBtn = $('aiRewriteRun');
  const applyBtn = $('aiRewriteApply');
  const preview = $('aiRewritePreview');
  const instruction = $('aiRewriteInstruction').value.trim();
  runBtn.disabled = true;
  applyBtn.disabled = true;
  preview.classList.add('empty');
  preview.textContent = '\u6b63\u5728\u5904\u7406\uff0c\u7a0d\u7b49\u4e00\u4e0b...';
  try {
    const res = await api('/api/ai/rewrite-selection', 'POST', { selectedText, instruction, contextText: getDocumentContextText() });
    pendingAiRewriteText = res.replacement || '';
    preview.classList.remove('empty');
    preview.innerHTML = textToEditorHtml(pendingAiRewriteText);
    applyBtn.disabled = !pendingAiRewriteText;
  } catch (e) {
    preview.classList.add('empty');
    preview.textContent = '\u751f\u6210\u5931\u8d25\uff1a' + (e.message || e);
  } finally {
    runBtn.disabled = false;
  }
}

function applyAiRewriteResult() {
  if (!pendingAiRewriteText || !restoreAiSelection()) return;
  document.execCommand('insertHTML', false, textToEditorHtml(pendingAiRewriteText));
  markEditorChanged();
  hideFloatMenu();
  closeAiModal();
  toast('AI \u5df2\u66ff\u6362\u9009\u533a');
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

// 离开前保存（使用 sendBeacon 确保请求不被中断）
window.addEventListener('beforeunload', () => {
  if (currentDoc && saveTimer) {
    clearTimeout(saveTimer);
    const title = docTitleEl.value.trim() || '无标题';
    const content = editor.getHTML();
    const body = JSON.stringify({ title, content });
    navigator.sendBeacon('/api/documents/' + currentDoc.id, new Blob([body], { type: 'application/json' }));
  }
});

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- 初始化 ---------- */
async function init() {
  initTheme();
  try {
    // 先校验登录态
    const meRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!meRes.ok) { window.location.href = '/login.html'; return; }
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
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) {}
  window.location.href = '/login.html';
});

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
  hideAllFloatMenus();
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
  hideAllFloatMenus();
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
  hideAllFloatMenus();
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
        '<button class="share-theme-btn' + (share.theme === 'light' ? ' active' : '') + '" data-theme="light">纸张</button>' +
        '<button class="share-theme-btn' + (share.theme === 'feishu' ? ' active' : '') + '" data-theme="feishu">飞书</button>' +
        '<button class="share-theme-btn' + (share.theme === 'dark' ? ' active' : '') + '" data-theme="dark">暗色</button>' +
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
    if (input.dataset.pinBound) return; // 避免重复绑定
    input.dataset.pinBound = '1';
    const onInput = () => {
      input.value = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (input.value && i < inputs.length - 1) inputs[i + 1].focus();
      if (Array.prototype.every.call(inputs, inp => inp.value)) {
        const pwd = Array.prototype.map.call(inputs, inp => inp.value).join('');
        updateShare({ password: pwd }).then(() => toast('密码已保存')).catch(() => {});
      }
    };
    const onKeydown = (e) => {
      if (e.key === 'Backspace' && !input.value && i > 0) inputs[i - 1].focus();
    };
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeydown);
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

function updateOutline() {
  if (outlineTimer) clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => {
    if (readingMode) { docOutline.hidden = true; return; }
    const headings = editorEl.querySelectorAll('h1, h2, h3');
    if (headings.length < 2) { docOutline.hidden = true; return; }
    let html = '<div class="outline-title">大纲</div><ol class="outline-list">';
    headings.forEach((h, i) => {
      if (!h.id) h.id = 'outline-' + i;
      const level = h.tagName.toLowerCase();
      const indent = level === 'h2' ? 'padding-left:1.2em;' : (level === 'h3' ? 'padding-left:2.4em;' : '');
      const text = h.textContent.trim() || '空标题';
      html += '<li style="' + indent + '"><a href="#' + h.id + '" data-target="' + h.id + '">' + escapeHtml(text) + '</a></li>';
    });
    html += '</ol>';
    docOutline.innerHTML = html;
    docOutline.hidden = false;
    setupOutlineObserver();
  }, 300);
}

function setupOutlineObserver() {
  if (outlineObserver) outlineObserver.disconnect();
  const links = docOutline.querySelectorAll('a');
  const headings = editorEl.querySelectorAll('h1, h2, h3');
  // 点击跳转
  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(link.getAttribute('data-target'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  // 滚动高亮当前章节
  const wrap = document.querySelector('.editor-wrap');
  outlineObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        links.forEach(l => l.classList.toggle('active', l.getAttribute('data-target') === entry.target.id));
      }
    });
  }, { rootMargin: '-80px 0px -70% 0px' });
  headings.forEach(h => outlineObserver.observe(h));
}

/* ---------- 阅读模式 ---------- */
const readingExitBtn = $('readingExit');
let readingMode = false;

function toggleReadingMode() {
  readingMode = !readingMode;
  document.body.classList.toggle('reading-mode', readingMode);
  if (readingExitBtn) readingExitBtn.hidden = !readingMode;
  hideAllFloatMenus();
  if (readingMode) {
    editorEl.contentEditable = 'false';
  } else {
    editorEl.contentEditable = 'true';
  }
}

if (readingExitBtn) readingExitBtn.addEventListener('click', toggleReadingMode);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && readingMode) {
    e.preventDefault();
    toggleReadingMode();
  }
});

init();
