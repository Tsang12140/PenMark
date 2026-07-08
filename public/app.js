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

let currentDoc = null;
let saveTimer = null;
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
  else if (action === 'code') editor.insertCodeInline();
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
  if (!editorEl.contains(e.target) && !e.target.closest('.img-container')) {
    hideFloatMenu();
    floatMenuImg.hidden = true;
  }
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

async function saveCurrent() {
  if (!currentDoc) return;
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
    updateListItem(currentDoc);
  } catch (e) {
    saveStateEl.textContent = '保存失败';
    toast('保存失败：' + (e.message || e));
  }
}

function updateListItem(doc) {
  const item = docListEl.querySelector('.doc-item[data-id="' + doc.id + '"]');
  if (!item) return;
  item.querySelector('.doc-title').textContent = doc.title;
  item.querySelector('.doc-meta').textContent = relativeTime(doc.updated_at);
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
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ---------- 文档列表 + 文件夹 ---------- */
let folders = [];
let expandedFolders = new Set(JSON.parse(localStorage.getItem('penmark_expanded_folders') || '[]'));
let draggingDocId = null;

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
    if (e.target.closest('.folder-menu')) return;
    wrap.classList.toggle('expanded');
    if (wrap.classList.contains('expanded')) expandedFolders.add(folder.id);
    else expandedFolders.delete(folder.id);
    persistExpanded();
  });
  head.querySelector('.folder-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    showFolderMenu(folder, head.querySelector('.folder-menu'));
  });

  // 子文档容器（作为拖拽 drop target）
  const list = document.createElement('div');
  list.className = 'folder-docs';
  bindDropTarget(list, folder.id);
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
    '<span class="folder-count">' + docs.length + '</span></div>';
  const list = document.createElement('div');
  list.className = 'folder-docs';
  bindDropTarget(list, null); // null = 移到根
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
    '<button class="doc-del" title="删除">×</button>';
  item.addEventListener('click', (e) => {
    if (e.target.classList.contains('doc-del')) { e.stopPropagation(); confirmDelete(doc); }
    else openDoc(doc.id);
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

function bindDropTarget(listEl, folderId) {
  listEl.addEventListener('dragover', (e) => {
    if (draggingDocId === null) return;
    e.preventDefault();
    listEl.classList.add('drag-over');
  });
  listEl.addEventListener('dragleave', (e) => {
    if (!listEl.contains(e.relatedTarget)) listEl.classList.remove('drag-over');
  });
  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    listEl.classList.remove('drag-over');
    if (draggingDocId !== null) moveDocToFolder(draggingDocId, folderId);
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

function showFolderMenu(folder, anchor) {
  folderContextMenu.innerHTML =
    '<div class="fcm-item" data-act="new">在此新建文档</div>' +
    '<div class="fcm-item" data-act="rename">重命名</div>' +
    '<div class="fcm-item danger" data-act="delete">删除文件夹</div>';
  folderContextMenu.style.display = 'block';
  const rect = anchor.getBoundingClientRect();
  folderContextMenu.style.left = rect.right + 'px';
  folderContextMenu.style.top = rect.bottom + 'px';
  folderContextMenu.hidden = false;
  const close = () => { folderContextMenu.hidden = true; document.removeEventListener('mousedown', close); };
  folderContextMenu.onclick = (e) => {
    const act = e.target.getAttribute('data-act');
    if (!act) return;
    close();
    if (act === 'new') newDocInFolder(folder.id);
    else if (act === 'rename') renameFolder(folder);
    else if (act === 'delete') deleteFolder(folder);
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
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
  const name = prompt('文件夹名称：', '新文件夹');
  if (!name || !name.trim()) return;
  try {
    await api('/api/folders', 'POST', { name: name.trim() });
    await loadSidebar();
    toast('已创建文件夹');
  } catch (e) { toast('创建失败：' + (e.message || e)); }
}

async function renameFolder(folder) {
  const name = prompt('重命名文件夹：', folder.name);
  if (!name || !name.trim() || name.trim() === folder.name) return;
  try {
    await api('/api/folders/' + folder.id, 'PUT', { name: name.trim() });
    await loadSidebar();
    toast('已重命名');
  } catch (e) { toast('重命名失败：' + (e.message || e)); }
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
  if (currentDoc && saveTimer) { clearTimeout(saveTimer); await saveCurrent(); }
  switching = true;
  try {
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

/* ---------- 暗色模式 ---------- */
function initTheme() {
  const saved = localStorage.getItem('penmark_theme');
  const theme = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('penmark_theme', next);
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

/* ---------- 全局快捷键 ---------- */
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); if (saveTimer) clearTimeout(saveTimer); saveCurrent(); }
  else if (k === 'n' && e.altKey) { e.preventDefault(); newDoc(); }
  else if (k === 'f' && e.altKey) { e.preventDefault(); searchInput.focus(); searchInput.select(); }
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
  // 管理员显示邀请码管理入口
  const inviteBtn = $('inviteBtn');
  if (inviteBtn) inviteBtn.style.display = currentUser.isAdmin ? '' : 'none';
}

// 占位：第二批分享功能实现时替换。仅管理员显示分享入口。
function updateShareButton() {
  const btn = $('shareBtn');
  if (!btn) return;
  btn.style.display = (currentUser && currentUser.isAdmin) ? '' : 'none';
}

$('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) {}
  window.location.href = '/login.html';
});

/* ---------- 邀请码管理（管理员） ---------- */
const inviteModal = $('inviteModal');
const inviteModalBody = $('inviteModalBody');
$('inviteBtn').addEventListener('click', () => { if (currentUser && currentUser.isAdmin) openInviteModal(); });
$('inviteModalClose').addEventListener('click', () => inviteModal.hidden = true);
inviteModal.addEventListener('click', (e) => { if (e.target === inviteModal) inviteModal.hidden = true; });

async function openInviteModal() {
  inviteModal.hidden = false;
  inviteModalBody.innerHTML = '<div class="share-loading">加载中…</div>';
  try {
    const list = await api('/api/invites');
    renderInviteList(list);
  } catch (e) {
    inviteModalBody.innerHTML = '<div class="share-error">加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}

function renderInviteList(list) {
  const unused = list.filter(i => !i.used).length;
  const used = list.length - unused;
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
        ? '<span class="invite-user">' + escapeHtml(i.registered_nickname || '') + '<small>' + escapeHtml(i.registered_username || '') + '</small></span>'
        : '<span class="ink-faint">—</span>';
      const del = i.used
        ? ''
        : '<button class="invite-del" data-code="' + code + '" title="删除">删除</button>';
      html += '<tr>' +
        '<td><code class="invite-code">' + code + '</code></td>' +
        '<td>' + status + '</td>' +
        '<td>' + user + '</td>' +
        '<td class="invite-time">' + relativeTime(i.created_at) + '</td>' +
        '<td>' + del + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
  }
  inviteModalBody.innerHTML = html;

  const genOne = $('genOneBtn');
  const genFive = $('genFiveBtn');
  if (genOne) genOne.addEventListener('click', () => generateInvites(1));
  if (genFive) genFive.addEventListener('click', () => generateInvites(5));
  inviteModalBody.querySelectorAll('.invite-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const code = btn.getAttribute('data-code');
      if (!confirm('确定删除邀请码 ' + code + '？')) return;
      try {
        await api('/api/invites/' + encodeURIComponent(code), 'DELETE');
        toast('已删除');
        openInviteModal();
      } catch (e) { toast('删除失败：' + (e.message || e)); }
    });
  });
  // 点击邀请码复制
  inviteModalBody.querySelectorAll('.invite-code').forEach(el => {
    el.style.cursor = 'pointer';
    el.title = '点击复制';
    el.addEventListener('click', () => {
      const text = el.textContent;
      navigator.clipboard.writeText(text).then(() => toast('已复制：' + text)).catch(() => {});
    });
  });
}

async function generateInvites(count) {
  try {
    await api('/api/invites', 'POST', { count });
    toast('已生成 ' + count + ' 个邀请码');
    openInviteModal();
  } catch (e) {
    toast('生成失败：' + (e.message || e));
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
  if (!currentUser || !currentUser.isAdmin) { toast('仅管理员可分享文档'); return; }
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
