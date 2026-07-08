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
  onUpdate: () => { updateStats(); scheduleAutoSave(); },
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
  }
}

function refreshToolbar() {
  const btns = document.querySelectorAll('.tb-btn[data-cmd]');
  editor.refreshToolbarState(btns, blockStyleSel);
}

document.addEventListener('selectionchange', () => {
  if (document.activeElement === editorEl) refreshToolbar();
});

/* ---------- 飞书式选中浮动菜单 ---------- */
const floatMenu = $('floatMenu');
const floatMenuImg = $('floatMenuImg');

// 文本选中时显示浮动菜单
editorEl.addEventListener('mouseup', () => {
  setTimeout(updateTextFloatMenu, 10); // 等选区稳定
});
editorEl.addEventListener('keyup', () => {
  setTimeout(updateTextFloatMenu, 10);
});

function updateTextFloatMenu() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    hideFloatMenu();
    return;
  }
  const range = sel.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) {
    hideFloatMenu();
    return;
  }
  // 选区在 img-container 内时不显示文字菜单
  if (range.commonAncestorContainer.nodeType === 1 && range.commonAncestorContainer.closest && range.commonAncestorContainer.closest('.img-container')) {
    hideFloatMenu();
    return;
  }
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) { hideFloatMenu(); return; }
  showFloatMenu(floatMenu, rect, 'top');
  refreshFloatMenuState();
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
  // 移到最前
  docListEl.insertBefore(item, docListEl.firstChild);
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

/* ---------- 文档列表 ---------- */
async function loadDocList() {
  const docs = await api('/api/documents');
  renderDocList(docs);
}

function renderDocList(docs) {
  docListEl.innerHTML = '';
  if (!docs.length) {
    docListEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-faint);font-size:12px;">暂无文档</div>';
    return;
  }
  docs.forEach(doc => {
    const item = document.createElement('div');
    item.className = 'doc-item' + (currentDoc && currentDoc.id === doc.id ? ' active' : '');
    item.setAttribute('data-id', doc.id);
    item.innerHTML =
      '<div class="doc-title">' + escapeHtml(doc.title || '无标题') + '</div>' +
      '<div class="doc-meta">' + relativeTime(doc.updated_at) + '</div>' +
      (doc.snippet ? '<div class="doc-snippet">' + escapeHtml(doc.snippet) + '</div>' : '') +
      '<button class="doc-del" title="删除">×</button>';
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('doc-del')) {
        e.stopPropagation();
        confirmDelete(doc);
      } else {
        openDoc(doc.id);
      }
    });
    docListEl.appendChild(item);
  });
}

async function openDoc(id) {
  if (currentDoc && currentDoc.id === id) return;
  // 切换前保存当前
  if (currentDoc && saveTimer) { clearTimeout(saveTimer); await saveCurrent(); }
  switching = true;
  try {
    const doc = await api('/api/documents/' + id);
    currentDoc = doc;
    docTitleEl.value = doc.title === '无标题' ? '' : doc.title;
    editor.setHTML(doc.content || '');
    // 高亮当前
    Array.prototype.forEach.call(docListEl.querySelectorAll('.doc-item'), el => {
      el.classList.toggle('active', el.getAttribute('data-id') == id);
    });
    saveStateEl.textContent = '已加载';
    updateStats();
    refreshToolbar();
  } catch (e) {
    toast('打开失败：' + (e.message || e));
  } finally {
    switching = false;
  }
}

async function newDoc() {
  if (currentDoc && saveTimer) { clearTimeout(saveTimer); await saveCurrent(); }
  switching = true;
  try {
    const res = await api('/api/documents', 'POST', { title: '无标题', content: '' });
    await loadDocList();
    currentDoc = { id: res.id, title: '无标题', content: '', updated_at: Date.now() };
    docTitleEl.value = '';
    editor.clear();
    // 高亮新建项
    Array.prototype.forEach.call(docListEl.querySelectorAll('.doc-item'), el => {
      el.classList.toggle('active', el.getAttribute('data-id') == res.id);
    });
    saveStateEl.textContent = '新文档';
    docTitleEl.focus();
    toast('已新建文档');
  } catch (e) {
    toast('新建失败：' + (e.message || e));
  } finally {
    switching = false;
  }
}

$('newDocBtn').addEventListener('click', newDoc);

async function confirmDelete(doc) {
  if (!confirm('删除「' + (doc.title || '无标题') + '」？此操作不可恢复。')) return;
  try {
    await api('/api/documents/' + doc.id, 'DELETE');
    if (currentDoc && currentDoc.id === doc.id) {
      // 切到列表第一个
      const remaining = await api('/api/documents');
      if (remaining.length) {
        renderDocList(remaining);
        await openDoc(remaining[0].id);
      } else {
        currentDoc = null;
        await newDoc();
      }
    } else {
      await loadDocList();
    }
    toast('已删除');
  } catch (e) {
    toast('删除失败：' + (e.message || e));
  }
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
  if (!q) { await loadDocList(); return; }
  try {
    const results = await api('/api/search?q=' + encodeURIComponent(q));
    renderDocList(results);
  } catch (e) { toast('搜索失败'); }
}

// 清空搜索时恢复
searchInput.addEventListener('search', () => {
  if (!searchInput.value) loadDocList();
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

    const docs = await api('/api/documents');
    if (docs.length) {
      renderDocList(docs);
      await openDoc(docs[0].id);
    } else {
      // 首次使用，创建欢迎文档
      const res = await api('/api/documents', 'POST', {
        title: '欢迎使用 知著 PenMark',
        content: welcomeContent()
      });
      await loadDocList();
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
  badge.querySelector('.user-name').textContent = currentUser.phone;
  badge.style.display = '';
}

$('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) {}
  window.location.href = '/login.html';
});

function welcomeContent() {
  return '<h1>欢迎使用 知著 PenMark</h1>' +
    '<p>这是一个专注微信图文整理与写作的笔记应用。</p>' +
    '<h2>快速上手</h2>' +
    '<ul>' +
    '<li><b>从微信拖入图片</b>：直接把聊天里的图片拖到编辑区</li>' +
    '<li><b>粘贴图文</b>：微信里复制图片或文字，Ctrl+V 粘贴，格式和图片都会保留</li>' +
    '<li><b>Markdown 快捷输入</b>：行首输入 <code>#</code> + 空格变标题，<code>-</code> + 空格变列表，<code>&gt;</code> + 空格变引用，<code>```</code> + 空格变代码块</li>' +
    '<li><b>图片缩放</b>：点击图片选中，拖动四角圆点等比缩放</li>' +
    '<li><b>多文档</b>：左侧新建、切换、搜索文档</li>' +
    '<li><b>导出</b>：右上角导出 HTML / Markdown / Word</li>' +
    '</ul>' +
    '<blockquote>「见微知著」——一图一文，安心写作。</blockquote>';
}

init();
