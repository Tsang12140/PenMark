// 知著 PenMark 应用主逻辑：文档管理、自动保存、搜索、暗色模式、工具栏
import { Editor, markdownToHtml } from './editor.js?v=20260806s';
import { setupImagePreview } from './image-preview.js';
import { highlightCodeBlocks, restoreHighlightedCode, stripBlockBackgrounds } from './highlight-utils.js';

const $ = id => document.getElementById(id);
const editorEl = $('editor');
const editorWrap = $('editorWrap');
const docListEl = $('docList');
const docTitleEl = $('docTitle');
const docTitleAiWrap = $('docTitleAiWrap');
const docTitleAiBtn = $('docTitleAi');
const docTitleSuggestion = $('docTitleSuggestion');
const docTitleSuggestionText = $('docTitleSuggestionText');
const docTitleSuggestionUse = $('docTitleSuggestionUse');
const docTitleSuggestionRetry = $('docTitleSuggestionRetry');
const TITLE_MAX = 100; // 标题最大字数（与 input maxlength、粘贴截断一致，防止超长内容撑爆标题栏）
const SHARE_TEXT_TITLE_MAX = 20; // 复制分享文案里，标题最多带多少字，超出加省略号（微信里指路用，不必带全）
const DEFAULT_UNTITLED_TITLE = String.fromCharCode(0x65e0, 0x6807, 0x9898);
const searchInput = $('searchInput');
docTitleEl.placeholder = '\u8f93\u5165\u6807\u9898';
docTitleEl.setAttribute('aria-label', '\u6587\u6863\u6807\u9898');
const charCountEl = $('charCount');
const imgCountEl = $('imgCount');
const saveStateEl = $('saveState');
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
let editorHydrating = false;
const AUTO_TITLE_IDLE_MS = 2 * 60 * 1000;
const AUTO_TITLE_PAGE_IDLE_MS = 1500;
let autoTitleEnabled = false;
let autoTitleTimer = null;
let autoTitleAbortController = null;
let autoTitleApplyAbortController = null;
let autoTitleLastActivityAt = Date.now();
let autoTitleRun = 0;
let manualTitleAbortController = null;
let manualTitleRun = 0;
let manualTitleSuggestion = '';


// A small in-memory LRU makes repeatedly opened documents switch instantly.
const docCache = new Map();
const DOC_CACHE_LIMIT = 8;

function cacheDoc(doc) {
  if (!doc || doc.id === undefined || doc.id === null) return;
  const key = String(doc.id);
  docCache.delete(key);
  docCache.set(key, {
    id: doc.id,
    title: doc.title || '',
    content: doc.content || '',
    folder_id: doc.folder_id || null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    version: doc.version || 1,
    title_origin: doc.title_origin || null,
    auto_title_attempted_at: doc.auto_title_attempted_at || null,
  });
  while (docCache.size > DOC_CACHE_LIMIT) docCache.delete(docCache.keys().next().value);
}

function readCachedDoc(id) {
  const key = String(id);
  const cached = docCache.get(key);
  if (!cached) return null;
  docCache.delete(key);
  docCache.set(key, cached);
  return { ...cached, _fromCache: true, _dirty: false };
}

function setEditorHTML(html) {
  editorHydrating = true;
  try { editor.setHTML(html || ''); }
  finally { editorHydrating = false; }
}

function replaceUploadedSources(html, replacements) {
  let output = String(html || '');
  if (!replacements) return output;
  replacements.forEach((url, source) => { output = output.split(source).join(url); });
  return output;
}

function waitForDocumentId(doc) {
  if (doc && !doc._pending && doc.id) return Promise.resolve(doc.id);
  return new Promise((resolve) => {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (doc && !doc._pending && doc.id) { clearInterval(timer); resolve(doc.id); }
      else if (!doc || doc._pendingFailed || attempts >= 200) { clearInterval(timer); resolve(null); }
    }, 50);
  });
}

function queueDataImageUpload({ image, src }) {
  const doc = currentDoc;
  if (!doc || !image || !src) return;
  doc._assetUploads = (doc._assetUploads || 0) + 1;
  if (!doc._assetReplacements) doc._assetReplacements = new Map();
  (async () => {
    const docId = await waitForDocumentId(doc);
    if (!docId) throw new Error('document unavailable');
    const result = await api('/api/documents/' + docId + '/assets', 'POST', { data_url: src });
    doc._assetReplacements.set(src, result.url);
    if (currentDoc === doc && editorEl.contains(image) && image.getAttribute('src') === src) {
      image.setAttribute('src', result.url);
      editorEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })().catch((err) => {
    console.warn('[assets] background image upload failed:', err && err.message);
    // 配额超限 / 上传失败时提示用户：图片仍以 data: URL 显示，但未入库，刷新后会丢失
    if (err && err.message) toast(err.message);
  }).finally(() => {
    doc._assetUploads = Math.max(0, (doc._assetUploads || 1) - 1);
    if (doc._assetUploads) return;
    if (doc._pendingAssetSave) {
      const pending = doc._pendingAssetSave;
      delete doc._pendingAssetSave;
      saveDocInBackground(doc, pending.title, replaceUploadedSources(pending.html, doc._assetReplacements));
    } else if (currentDoc === doc && doc._pendingSave) {
      delete doc._pendingSave;
      saveCurrent();
    }
  });
}

async function optimizeLegacyImages(doc) {
  if (!doc || !/data:image\//i.test(String(doc.content || ''))) return;
  const openedVersion = doc.version || 1;
  try {
    const result = await api('/api/documents/' + doc.id + '/optimize-images', 'POST', {});
    if (!result || !result.optimized) return;
    const upgraded = { ...doc, content: result.content, version: result.version || openedVersion, updated_at: result.updated_at || doc.updated_at, _dirty: false };
    cacheDoc(upgraded);
    if (currentDoc && currentDoc.id === doc.id && !currentDoc._dirty && (currentDoc.version || 1) === openedVersion) {
      currentDoc = upgraded;
      setEditorHTML(upgraded.content);
      updateDocumentTitle(upgraded.title);
      scheduleAfterSwitch(() => { if (currentDoc === upgraded) updateStats(); });
      toast('Images optimized in the background');
    }
  } catch (err) {
    console.warn('[assets] legacy image optimization skipped:', err && err.message);
  }
}

/* ---------- 多端同步：版本号轮询（轻量级，B 端发现他人改动时弹横幅） ---------- */
let versionCheckTimer = null;
let lastEditedAt = 0;             // 最近一次用户输入时间戳；编辑中不打扰
let dismissedVersion = 0;         // 用户已"稍后"过的版本号；同版本不重复弹
const VERSION_POLL_INTERVAL = 8000; // 8 秒一次轮询
const EDITING_QUIET_WINDOW = 3000;  // 距离上次输入 3 秒内不弹横幅

async function revalidateCachedDoc(cachedDoc) {
  try {
    const version = await api('/api/documents/' + cachedDoc.id + '/version');
    if (!version || version.version === cachedDoc.version) return;
    const fresh = await api('/api/documents/' + cachedDoc.id);
    cacheDoc(fresh);
    if (!currentDoc || currentDoc.id !== cachedDoc.id) return;
    if (currentDoc._dirty) {
      // 用户已编辑：不静默覆盖，提示有更新版本，让用户决定是否刷新
      // 避免把基于旧缓存的编辑保存上去覆盖服务器最新版本
      showVersionBanner(version);
      return;
    }
    const active = { ...fresh, _dirty: false };
    currentDoc = active;
    setDocTitle(active.title === '\u65e0\u6807\u9898' ? '' : active.title);
    setEditorHTML(active.content);
    refreshToolbar();
    updateDocumentTitle(active.title);
    scheduleAfterSwitch(() => {
      if (currentDoc === active) {
        updateStats();
        updateOutline(true);
      }
    });
    optimizeLegacyImages(active);
  } catch (err) {
    console.warn('[cache] document revalidation skipped:', err && err.message);
  }
}

function startVersionPolling() {
  stopVersionPolling();
  stopShareStatsPolling();
  versionCheckTimer = setInterval(checkDocVersion, VERSION_POLL_INTERVAL);
  document.addEventListener('visibilitychange', onVisibilityChangeForVersion);
}

function stopVersionPolling() {
  if (versionCheckTimer) { clearInterval(versionCheckTimer); versionCheckTimer = null; }
  document.removeEventListener('visibilitychange', onVisibilityChangeForVersion);
}

function onVisibilityChangeForVersion() {
  if (!document.hidden && currentDoc) checkDocVersion();
}

async function checkDocVersion() {
  if (!currentDoc) return;
  // 编辑活跃期不弹横幅，避免打断输入
  if (Date.now() - lastEditedAt < EDITING_QUIET_WINDOW) return;
  const docId = currentDoc.id; // 快照，防止 await 期间文档切换导致跨文档误报
  try {
    const r = await fetch('/api/documents/' + docId + '/version', { credentials: 'same-origin' });
    if (!r.ok) return;
    const v = await r.json();
    if (!v || typeof v.version !== 'number') return;
    // await 期间文档可能已切换，丢弃过期响应
    if (!currentDoc || currentDoc.id !== docId) return;
    if (v.version > (currentDoc.version || 1) && v.version > dismissedVersion) {
      showVersionBanner(v);
    }
  } catch (e) { /* 静默：网络抖动等不影响编辑 */ }
}

/* ---------- 分享访客统计轮询（飞书式：编辑器内显示被访问情况） ---------- */
let shareStatsTimer = null;
const SHARE_STATS_INTERVAL = 15000; // 15 秒一次，更及时反映访客状态

function startShareStatsPolling() {
  stopShareStatsPolling();
  refreshShareStats();
  shareStatsTimer = setInterval(refreshShareStats, SHARE_STATS_INTERVAL);
}

function stopShareStatsPolling() {
  if (shareStatsTimer) { clearInterval(shareStatsTimer); shareStatsTimer = null; }
  const btn = document.getElementById('shareStatsBtn');
  if (btn) btn.hidden = true;
}

async function refreshShareStats() {
  if (!currentDoc) return;
  const btn = document.getElementById('shareStatsBtn');
  if (!btn) return;
  // 仅管理员或被授权用户拉取统计
  if (!currentUser || (!currentUser.isAdmin && !currentUser.can_share)) { btn.hidden = true; return; }
  const docId = currentDoc.id; // 快照，防止 await 期间文档切换导致数据错位
  try {
    const r = await fetch('/api/documents/' + docId + '/share-stats', { credentials: 'same-origin' });
    if (!r.ok) { btn.hidden = true; return; }
    const data = await r.json();
    // await 期间文档可能已切换，丢弃过期响应避免新文档按钮被旧数据覆盖
    if (!currentDoc || currentDoc.id !== docId) return;
    if (!data.shared || data.expired) { btn.hidden = true; return; }
    btn.hidden = false;
    const total = data.total || 0;
    const online = data.online_30min || 0;
    btn.classList.toggle('online', online > 0);
    const text = btn.querySelector('.ss-text');
    if (text) {
      text.textContent = online > 0 ? (online + ' 在线 ' + total + ' 访问') : (total + ' 访问');
    }
    btn.title = online > 0 ? (online + ' 人在线，共 ' + total + ' 人访问过') : ('共 ' + total + ' 人访问过');
  } catch (e) { /* 静默 */ }
}

function showVersionBanner(v) {
  let banner = document.getElementById('versionBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'versionBanner';
    banner.className = 'version-banner';
    banner.innerHTML = '';
    document.body.appendChild(banner);
  } else {
    banner.innerHTML = '';
  }
  const text = document.createElement('span');
  text.className = 'vb-text';
  text.textContent = '其他端已修改此文档';
  banner.appendChild(text);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'vb-btn vb-refresh';
  refreshBtn.textContent = '刷新查看';
  refreshBtn.onclick = async () => {
    // 本地有未保存编辑时先确认：刷新=丢弃本地修改，加载服务器最新版。
    // 绝不先 saveCurrent：本地可能是过时的旧版，先保存会用旧版覆盖服务器最新版，
    // 造成多端数据回退（旧版把新版覆盖掉）。
    if (currentDoc && currentDoc._dirty) {
      const ok = await showConfirm({
        title: '加载最新版本',
        desc: '本地有未保存的修改。加载最新版本将丢弃这些修改，是否继续？',
        confirmText: '丢弃并加载最新',
        danger: true
      });
      if (!ok) return;
    }
    banner.classList.remove('show');
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveStateEl.textContent = '同步中…';
    try {
      const doc = await api('/api/documents/' + currentDoc.id);
      currentDoc = Object.assign({}, doc, { _dirty: false });
      setDocTitle(doc.title === '无标题' ? '' : doc.title);
      editor.setHTML(doc.content || '');
      saveStateEl.textContent = '已加载最新';
      toast('已加载最新版本');
      dismissedVersion = 0;
      refreshToolbar();
      updateOutline(true);
      updateDocumentTitle(doc.title);
      optimizeLegacyImages(currentDoc);
      cacheDoc(doc);
    } catch (e) {
      toast('刷新失败：' + (e.message || e));
      saveStateEl.textContent = '刷新失败';
    }
  };
  banner.appendChild(refreshBtn);

  const laterBtn = document.createElement('button');
  laterBtn.className = 'vb-btn vb-later';
  laterBtn.textContent = '稍后';
  laterBtn.onclick = () => {
    banner.classList.remove('show');
    dismissedVersion = v.version;
  };
  banner.appendChild(laterBtn);

  banner.classList.add('show');
}

function hideVersionBanner() {
  const banner = document.getElementById('versionBanner');
  if (banner) banner.classList.remove('show');
}

// 调试辅助：在 Console 输入 window.__pmDebug() 可查看同步状态
window.__pmDebug = function() {
  return {
    currentDoc: currentDoc ? { id: currentDoc.id, title: currentDoc.title, version: currentDoc.version } : null,
    dismissedVersion,
    lastEditedAt,
    msSinceLastEdit: Date.now() - lastEditedAt,
    pollingActive: !!versionCheckTimer,
    bannerVisible: !!(document.getElementById('versionBanner') && document.getElementById('versionBanner').classList.contains('show'))
  };
};
window.__pmCheckNow = checkDocVersion;

/* ---------- 标签页标题：跟随当前文档名 ---------- */
const PENMARK_SUFFIX = ' - 知著 PenMark';

/* 正文标题自适应高度：textarea 按内容自动撑高，完整显示标题 */
function autoGrowTitle(){
  if (!docTitleEl) return;
  docTitleEl.style.height = 'auto';
  const h = docTitleEl.scrollHeight;
  if (h > 0) docTitleEl.style.height = h + 'px';
}
function setDocTitle(text){
  const v = (text == null ? '' : String(text)).slice(0, TITLE_MAX);
  docTitleEl.value = v;
  autoGrowTitle();
  // 容器刚显示时 scrollHeight 可能为 0，下一帧再校准一次
  requestAnimationFrame(autoGrowTitle);
}

function updateDocumentTitle(title) {
  const t = (title || '').trim() || '无标题';
  document.title = t + PENMARK_SUFFIX;
}
let switching = false; // 切换文档时屏蔽自动保存
let pendingSwitchId = null; // 切换中又点了别的文档时，记录最新意图，前序完成后切过去
let pendingSwitchOptions = null;

const DOCUMENT_ROUTE_RE = /^\/d\/([1-9]\d*)\/?$/;
function getRoutedDocumentId() {
  if (isDesktopMode()) return null;
  const match = window.location.pathname.match(DOCUMENT_ROUTE_RE);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function setDocumentRoute(id, options = {}) {
  if (isDesktopMode()) return;
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId < 1) return;
  const target = '/d/' + numericId;
  if (window.location.pathname === target && !window.location.search && !window.location.hash) return;
  window.history[options.replace ? 'replaceState' : 'pushState']({ documentId: numericId }, '', target);
}
function clearDocumentRoute(options = {}) {
  if (isDesktopMode()) return;
  if (window.location.pathname === '/' && !window.location.search && !window.location.hash) return;
  window.history[options.replace ? 'replaceState' : 'pushState']({}, '', '/');
}

/* ---------- Toast ---------- */
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastStack.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2100);
}

/* ---------- 统一确认/输入弹窗（替代原生 confirm/prompt） ---------- */
const dialogModal = $('dialogModal');
const dialogTitle = $('dialogTitle');
const dialogDesc = $('dialogDesc');
const dialogInput = $('dialogInput');
const dialogTextarea = $('dialogTextarea');
const dialogConfirm = $('dialogConfirm');
const dialogCancel = $('dialogCancel');
const dialogClose = $('dialogClose');
let _dialogResolver = null;

// textarea 自适应高度：内容增多时长高，上限 260px（与 CSS max-height 一致）
function autoGrowTextarea(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 260) + 'px';
}

function _openDialog({ title, desc, confirmText, cancelText, danger, input, value, placeholder, multiline, maxlength }) {
  if (!dialogModal) return Promise.resolve(input ? null : false);
  dialogTitle.textContent = title || (input ? '请输入' : '请确认');
  dialogDesc.textContent = desc || '';
  dialogConfirm.textContent = confirmText || '确认';
  dialogCancel.textContent = cancelText || '取消';
  dialogConfirm.classList.toggle('btn-danger', !!danger);
  dialogConfirm.classList.toggle('btn-primary', !danger);
  if (input) {
    if (multiline && dialogTextarea) {
      // 多行输入（提示词等长文本）：Enter 换行、Ctrl/Cmd+Enter 确认
      dialogInput.hidden = true;
      dialogTextarea.hidden = false;
      dialogTextarea.value = value || '';
      dialogTextarea.placeholder = placeholder || '';
      if (maxlength) dialogTextarea.maxLength = maxlength;
    } else {
      if (dialogTextarea) dialogTextarea.hidden = true;
      dialogInput.hidden = false;
      dialogInput.value = value || '';
      dialogInput.placeholder = placeholder || '';
    }
  } else {
    dialogInput.hidden = true;
    if (dialogTextarea) dialogTextarea.hidden = true;
  }
  dialogModal.hidden = false;
  return new Promise(resolve => {
    _dialogResolver = resolve;
    // 输入框模式下，弹窗打开后自动聚焦并选中
    setTimeout(() => {
      if (input) {
        const el = (multiline && dialogTextarea) ? dialogTextarea : dialogInput;
        el.focus();
        el.select();
        if (multiline && dialogTextarea) autoGrowTextarea(dialogTextarea);
      } else {
        dialogConfirm.focus();
      }
    }, 30);
  });
}

function showConfirm(options) {
  if (typeof options === 'string') options = { desc: options };
  return _openDialog(Object.assign({}, options, { input: false }));
}

function showPrompt(options) {
  if (typeof options === 'string') options = { desc: options };
  return _openDialog(Object.assign({}, options, { input: true }));
}

/* ---------- 版本历史：查看、建立恢复点与安全恢复 ---------- */
const versionHistoryModal = $('versionHistoryModal');
const versionHistoryList = $('versionHistoryList');
const versionHistoryPreview = $('versionHistoryPreview');
const versionHistoryDocTitle = $('versionHistoryDocTitle');
const versionHistoryCreate = $('versionHistoryCreate');
let versionHistoryTarget = null;
let versionHistoryEntries = [];
let versionHistorySelected = null;
let versionHistoryLoadToken = 0;
let versionHistoryRestoreFocus = null;

const VERSION_HISTORY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg>';

function versionHistorySourceLabel(source) {
  if (source === 'manual') return '手动创建';
  if (source === 'restore_backup') return '恢复前备份';
  return '自动保存';
}

function formatVersionHistoryTime(value) {
  const date = new Date(Number(value) || Date.now());
  const pad = n => String(n).padStart(2, '0');
  return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function getVersionPreviewText(html) {
  const container = document.createElement('div');
  container.innerHTML = String(html || '');
  return (container.innerText || container.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function clearVersionHistoryPreview(message) {
  if (!versionHistoryPreview) return;
  versionHistoryPreview.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'version-preview-empty';
  empty.textContent = message;
  versionHistoryPreview.appendChild(empty);
}

function renderVersionHistoryList() {
  if (!versionHistoryList) return;
  versionHistoryList.replaceChildren();
  if (!versionHistoryEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'version-history-empty';
    const title = document.createElement('strong');
    title.textContent = '暂无可恢复版本';
    const desc = document.createElement('span');
    desc.textContent = '从现在开始，重要改动会自动保留。也可以立即创建一个版本。';
    empty.append(title, desc);
    versionHistoryList.appendChild(empty);
    return;
  }
  versionHistoryEntries.forEach(entry => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'version-history-item' + (versionHistorySelected && Number(versionHistorySelected.id) === Number(entry.id) ? ' active' : '');
    const top = document.createElement('span');
    top.className = 'version-history-item-top';
    const label = document.createElement('strong');
    label.textContent = 'v' + (entry.version || 1) + ' ' + versionHistorySourceLabel(entry.source);
    const time = document.createElement('time');
    time.textContent = formatVersionHistoryTime(entry.created_at);
    top.append(label, time);
    const meta = document.createElement('span');
    meta.className = 'version-history-item-meta';
    meta.textContent = entry.source === 'manual'
      ? '由你手动创建'
      : (Number(entry.chars_diff) > 0 ? '与当时内容相差约 ' + Number(entry.chars_diff) + ' 字' : '内容或标题已更新');
    button.append(top, meta);
    button.addEventListener('click', () => selectVersionHistoryEntry(entry));
    versionHistoryList.appendChild(button);
  });
}

function renderVersionHistoryPreview(entry) {
  if (!versionHistoryPreview) return;
  versionHistoryPreview.replaceChildren();
  const header = document.createElement('div');
  header.className = 'version-preview-head';
  const heading = document.createElement('strong');
  heading.textContent = entry.title || '无标题';
  const meta = document.createElement('span');
  meta.textContent = 'v' + (entry.version || 1) + ' ' + versionHistorySourceLabel(entry.source) + ' ' + formatVersionHistoryTime(entry.created_at);
  header.append(heading, meta);

  const note = document.createElement('p');
  note.className = 'version-preview-note';
  note.textContent = '只读预览，图片为缩略图。恢复为副本不改当前文档；原地恢复前会先备份当前内容。要看原图请恢复。';

  // 直接渲染版本快照 HTML：保留标题/段落/列表/图片排版，图片指向缩略图省带宽。
  const render = document.createElement('div');
  render.className = 'version-preview-render';
  let html = String(entry.content || '');
  // 安全清理：移除脚本/iframe/事件属性（版本快照来自文档内容，本身受编辑器约束，此为兜底）
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 图片指向缩略图：/api/assets/<id> → /api/assets/<id>/thumb（已是 thumb 的不重复加）
  html = html.replace(/(\/api\/assets\/[0-9a-fA-F-]{36})(?!\/thumb)/g, '$1/thumb');
  render.innerHTML = html || '<p>（空文档）</p>';
  stripBlockBackgrounds(render); // 版本预览随主题，去掉段落级内联底色
  // 清理编辑器特有的图片容器结构：版本快照保留了 img-container（含分辨率标注
  // .img-size-label、缩放手柄 .rs-handle、固定宽高 style），预览时只保留干净的
  // <img>，让图片用 max-width:100% 自适应，避免排版错乱和多余空隙。
  render.querySelectorAll('.img-size-label, .rs-handle').forEach(el => el.remove());
  render.querySelectorAll('.img-container').forEach(container => {
    const img = container.querySelector('img');
    if (img) container.replaceWith(img);
    else container.remove();
  });
  highlightCodeBlocks(render); // 版本预览代码块语法高亮

  const actions = document.createElement('div');
  actions.className = 'version-preview-actions';
  const duplicate = document.createElement('button');
  duplicate.type = 'button';
  duplicate.className = 'btn btn-primary';
  duplicate.textContent = '恢复为副本';
  duplicate.addEventListener('click', () => duplicateVersionHistoryEntry(entry));
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'btn btn-secondary';
  restore.textContent = '恢复此版本';
  restore.addEventListener('click', () => restoreVersionHistoryEntry(entry));
  actions.append(duplicate, restore);
  versionHistoryPreview.append(header, note, render, actions);
}

async function refreshVersionHistory() {
  if (!versionHistoryTarget) return;
  const targetId = Number(versionHistoryTarget.id);
  const token = ++versionHistoryLoadToken;
  versionHistoryEntries = [];
  versionHistorySelected = null;
  renderVersionHistoryList();
  clearVersionHistoryPreview('正在读取历史版本…');
  try {
    const rows = await api('/api/documents/' + targetId + '/versions');
    if (token !== versionHistoryLoadToken || !versionHistoryTarget || Number(versionHistoryTarget.id) !== targetId) return;
    versionHistoryEntries = Array.isArray(rows) ? rows : [];
    renderVersionHistoryList();
    clearVersionHistoryPreview(versionHistoryEntries.length ? '选择一个版本，先查看内容，再决定如何恢复。' : '还没有历史版本。你可以先创建一个恢复点。');
  } catch (e) {
    if (token !== versionHistoryLoadToken) return;
    clearVersionHistoryPreview('历史版本加载失败：' + (e.message || e));
  }
}

async function openVersionHistory(doc) {
  if (!doc || !doc.id || !versionHistoryModal) {
    toast('请先打开一篇文档');
    return;
  }
  if (currentDoc && Number(currentDoc.id) === Number(doc.id) && (currentDoc._dirty || saveTimer)) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    await saveCurrent();
  }
  versionHistoryTarget = { id: Number(doc.id), title: doc.title || '无标题' };
  versionHistoryRestoreFocus = document.activeElement;
  if (versionHistoryDocTitle) versionHistoryDocTitle.textContent = versionHistoryTarget.title;
  versionHistoryModal.hidden = false;
  await refreshVersionHistory();
  const close = $('versionHistoryClose');
  if (close) close.focus();
}

function closeVersionHistory() {
  if (!versionHistoryModal) return;
  versionHistoryLoadToken += 1;
  versionHistoryModal.hidden = true;
  const focusTarget = versionHistoryRestoreFocus;
  versionHistoryRestoreFocus = null;
  if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
}

async function selectVersionHistoryEntry(entry) {
  if (!versionHistoryTarget || !entry) return;
  const targetId = Number(versionHistoryTarget.id);
  versionHistorySelected = entry;
  renderVersionHistoryList();
  clearVersionHistoryPreview('正在加载这个版本…');
  try {
    const detail = await api('/api/documents/' + targetId + '/versions/' + encodeURIComponent(entry.id));
    if (!versionHistoryTarget || Number(versionHistoryTarget.id) !== targetId || !versionHistorySelected || Number(versionHistorySelected.id) !== Number(entry.id)) return;
    versionHistorySelected = detail;
    renderVersionHistoryList();
    renderVersionHistoryPreview(detail);
  } catch (e) {
    clearVersionHistoryPreview('版本内容加载失败：' + (e.message || e));
  }
}

async function createVersionHistoryEntry() {
  if (!versionHistoryTarget || !versionHistoryCreate) return;
  const targetId = Number(versionHistoryTarget.id);
  versionHistoryCreate.disabled = true;
  const originalLabel = versionHistoryCreate.textContent;
  versionHistoryCreate.textContent = '正在创建…';
  try {
    await api('/api/documents/' + targetId + '/versions', 'POST', {});
    toast('已创建恢复点');
    await refreshVersionHistory();
  } catch (e) {
    toast('创建版本失败：' + (e.message || e));
  } finally {
    versionHistoryCreate.disabled = false;
    versionHistoryCreate.textContent = originalLabel;
  }
}

async function duplicateVersionHistoryEntry(entry) {
  if (!versionHistoryTarget || !entry) return;
  try {
    const result = await api('/api/documents/' + versionHistoryTarget.id + '/versions/' + encodeURIComponent(entry.id) + '/duplicate', 'POST', {});
    closeVersionHistory();
    await loadSidebar();
    await openDoc(result.id);
    toast('已创建恢复副本');
  } catch (e) {
    toast('创建恢复副本失败：' + (e.message || e));
  }
}

async function restoreVersionHistoryEntry(entry) {
  if (!versionHistoryTarget || !entry) return;
  const confirmed = await showConfirm({
    title: '恢复此版本',
    desc: '当前内容会先自动保存为“恢复前备份”，然后再恢复为这个版本。',
    confirmText: '确认恢复'
  });
  if (!confirmed) return;
  const targetId = Number(versionHistoryTarget.id);
  try {
    const result = await api('/api/documents/' + targetId + '/versions/' + encodeURIComponent(entry.id) + '/restore', 'POST', {});
    const restored = result && result.doc;
    if (!restored) throw new Error('恢复结果无效');
    cacheDoc({ ...restored, _dirty: false });
    if (currentDoc && Number(currentDoc.id) === targetId) {
      currentDoc = { ...restored, _dirty: false };
      setDocTitle(restored.title === DEFAULT_UNTITLED_TITLE ? '' : restored.title);
      setEditorHTML(restored.content || '');
      updateDocumentTitle(restored.title);
      refreshToolbar();
      scheduleAfterSwitch(() => {
        if (currentDoc && Number(currentDoc.id) === targetId) {
          updateStats();
          updateOutline(true);
        }
      });
    }
    await loadSidebar();
    closeVersionHistory();
    toast('已恢复该版本；恢复前内容已备份');
  } catch (e) {
    toast('恢复失败：' + (e.message || e));
  }
}

if (versionHistoryModal) {
  const close = $('versionHistoryClose');
  if (close) close.addEventListener('click', closeVersionHistory);
  versionHistoryModal.addEventListener('pointerdown', (e) => {
    if (e.target === versionHistoryModal) closeVersionHistory();
  });
}
if (versionHistoryCreate) versionHistoryCreate.addEventListener('click', createVersionHistoryEntry);
const versionHistoryBtn = $('versionHistoryBtn');
if (versionHistoryBtn) versionHistoryBtn.addEventListener('click', () => openVersionHistory(currentDoc));

function _closeDialog(result) {
  if (!dialogModal) return;
  dialogModal.hidden = true;
  // 重置 textarea 高度，避免下次打开残留内联高度
  if (dialogTextarea) dialogTextarea.style.height = '';
  const r = _dialogResolver;
  _dialogResolver = null;
  if (r) r(result);
}
// 是否处于输入模式（单行或多行）
const dialogIsInput = () => !dialogInput.hidden || (dialogTextarea && !dialogTextarea.hidden);

if (dialogConfirm) dialogConfirm.addEventListener('click', () => {
  if (!dialogInput.hidden) {
    _closeDialog(dialogInput.value);
  } else if (dialogTextarea && !dialogTextarea.hidden) {
    _closeDialog(dialogTextarea.value);
  } else {
    _closeDialog(true);
  }
});
if (dialogCancel) dialogCancel.addEventListener('click', () => _closeDialog(dialogIsInput() ? null : false));
if (dialogClose) dialogClose.addEventListener('click', () => _closeDialog(dialogIsInput() ? null : false));
if (dialogModal) dialogModal.addEventListener('pointerdown', (e) => {
  if (e.target === dialogModal) _closeDialog(dialogIsInput() ? null : false);
});
if (dialogInput) dialogInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); _closeDialog(dialogInput.value); }
  if (e.key === 'Escape') { e.preventDefault(); _closeDialog(null); }
});
if (dialogTextarea) {
  dialogTextarea.addEventListener('keydown', (e) => {
    // 多行：Enter 换行，Ctrl/Cmd+Enter 确认，Escape 取消
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); _closeDialog(dialogTextarea.value); }
    if (e.key === 'Escape') { e.preventDefault(); _closeDialog(null); }
  });
  dialogTextarea.addEventListener('input', () => autoGrowTextarea(dialogTextarea));
}
document.addEventListener('keydown', (e) => {
  if (!dialogModal || dialogModal.hidden) return;
  if (e.key === 'Escape') _closeDialog(dialogIsInput() ? null : false);
  if (e.key === 'Enter' && !dialogIsInput()) { e.preventDefault(); _closeDialog(true); }
});

/* ---------- 编辑器 ---------- */
// AI 请求返回时用它判断用户是否已继续写作；不参与输入、保存或渲染热路径。
let editorContentVersion = 0;

const editor = new Editor({
  editor: editorEl,
  dropOverlay,
  onUpdate: (change) => {
    if (editorHydrating) return;
    editorContentVersion += 1;
    // 气泡只代表刚刚那次 AI 替换；后来再编辑时不能让它撤销错对象。
    if (aiUndoBubble) hideAiUndoBubble();
    lastEditedAt = Date.now();
    if (currentDoc) currentDoc._dirty = true;
    noteAutoTitleContentChange();
    if (change && change.largePlainTextPaste) {
      // Let the browser paint the pasted text before nonessential full-document
      // scans and serialization. Subsequent typing still resets normal saves.
      updateStats(1200); scheduleAutoSave(1600); updateOutline(false, 1500);
      return;
    }
    updateStats(); scheduleAutoSave(); updateOutline();
  },
  onToast: toast,
  onPrompt: showPrompt,
  onDataImageInserted: queueDataImageUpload,
  onImageSelect: (container) => updateImageFloatMenu(container)
});
setupImagePreview(editorEl, '.img-container img');

if (docTitleAiBtn) docTitleAiBtn.addEventListener('click', requestManualTitleSuggestion);
if (docTitleSuggestionUse) docTitleSuggestionUse.addEventListener('click', applyManualTitleSuggestion);
if (docTitleSuggestionRetry) docTitleSuggestionRetry.addEventListener('click', requestManualTitleSuggestion);

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

/* ---------- 工具栏溢出折叠（飞书式"⋯ 更多"菜单） ----------
   宽度不够时按 data-overflow-priority 升序把低频 .tb-btn 移入 #overflowMenu；
   宽度恢复按优先级降序原位回插（Comment 占位记原位）。
   事件委托在 #toolbar 上，菜单内按钮仍在子树内，data-cmd/data-action 天然分发，handleAction 零改动。
*/
(function initToolbarOverflow() {
  const toolbar = $('toolbar');
  const overflowDropdown = $('overflowDropdown');
  const overflowToggle = $('overflowToggle');
  const overflowMenu = $('overflowMenu');
  if (!toolbar || !overflowDropdown || !overflowToggle || !overflowMenu) return;

  const placeholders = new Map();         // button -> Comment 占位节点
  let scheduled = false;

  function isVisible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    if (el.style.display === 'none') return false;
    return el.offsetParent !== null;      // display:none / 父级 display:none 都返回 null
  }
  function toolbarVisible() {
    // reading-mode / dashboard-active / 移动端媒体查询都会让 .toolbar display:none
    return toolbar.offsetParent !== null && toolbar.clientWidth > 0;
  }
  function isOverflowing() { return toolbar.scrollWidth > toolbar.clientWidth + 1; }

  // 候选：当前在原位（未折叠）、可见、有 data-overflow-priority 的按钮，按优先级升序（小先折叠）
  function foldableCandidates() {
    return Array.from(toolbar.querySelectorAll('.tb-btn[data-overflow-priority]:not(.in-overflow)'))
      .filter(isVisible)
      .sort((a, b) => (+a.dataset.overflowPriority) - (+b.dataset.overflowPriority));
  }
  // 已折叠按钮，按优先级降序（大先回挪）
  function foldedCandidates() {
    return Array.from(overflowMenu.querySelectorAll('.tb-btn[data-overflow-priority]'))
      .sort((a, b) => (+b.dataset.overflowPriority) - (+a.dataset.overflowPriority));
  }

  function fold(btn) {
    const key = btn.id || btn.getAttribute('data-action') || btn.getAttribute('data-cmd') || '';
    const ph = document.createComment('overflow:' + key);
    btn.parentNode.insertBefore(ph, btn);
    overflowMenu.appendChild(btn);
    btn.classList.add('in-overflow');
    placeholders.set(btn, ph);
  }
  function unfold(btn) {
    const ph = placeholders.get(btn);
    if (ph && ph.parentNode) { ph.parentNode.insertBefore(btn, ph); ph.remove(); }
    else { toolbar.insertBefore(btn, overflowDropdown); } // 兜底
    btn.classList.remove('in-overflow');
    placeholders.delete(btn);
  }

  function relayout() {
    if (!toolbarVisible()) return;
    overflowMenu.hidden = true; // 折叠期间关闭菜单，避免按钮在可见菜单中"瞬移"

    // Phase 1：折叠直到不溢出
    let guard = 50;
    while (guard-- > 0 && isOverflowing()) {
      const next = foldableCandidates()[0];
      if (!next) break;
      fold(next);
    }

    // Phase 2：按优先级高→低尝试回挪。直接 unfold 实测是否溢出，溢出则撤回停止。
    // 不能用 scrollWidth 预判"有富裕"——内容不溢出时 scrollWidth 退化为 clientWidth，会误判无空间。
    guard = 50;
    while (guard-- > 0 && overflowMenu.querySelector('.tb-btn[data-overflow-priority]')) {
      const next = foldedCandidates()[0];
      if (!next) break;
      unfold(next);
      if (isOverflowing()) { fold(next); break; } // 回挪后又溢出 → 撤回停止
    }

    // Phase 3：同步 #overflowDropdown 显隐
    const hasFolded = overflowMenu.querySelector('.tb-btn[data-overflow-priority]');
    overflowDropdown.hidden = !hasFolded;
    if (!hasFolded) overflowToggle.setAttribute('aria-expanded', 'false');
  }

  function scheduleRelayout() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; relayout(); });
  }

  /* ---- 下拉 toggle（复用导出下拉模式） ---- */
  overflowToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const em = $('exportMenu'); if (em) em.hidden = true; // 互斥：关掉导出菜单
    const willOpen = overflowMenu.hidden;
    overflowMenu.hidden = !willOpen;
    overflowToggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });

  // 菜单内点击任意 .tb-btn 后关闭（事件委托：工具栏统一 handler 仍会先分发 data-cmd/data-action）
  overflowMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('.tb-btn');
    if (!btn) return;
    overflowMenu.hidden = true;
    overflowToggle.setAttribute('aria-expanded', 'false');
  });

  // 点击外部关闭
  document.addEventListener('click', () => {
    if (!overflowMenu.hidden) {
      overflowMenu.hidden = true;
      overflowToggle.setAttribute('aria-expanded', 'false');
    }
  });

  // 互斥：点击 #exportToggle 时关闭 overflowMenu
  const exportToggle = $('exportToggle');
  if (exportToggle) {
    exportToggle.addEventListener('click', () => {
      if (!overflowMenu.hidden) {
        overflowMenu.hidden = true;
        overflowToggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Escape 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overflowMenu.hidden) {
      overflowMenu.hidden = true;
      overflowToggle.setAttribute('aria-expanded', 'false');
    }
  });

  /* ---- 监听 ---- */
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => scheduleRelayout());
    ro.observe(toolbar);
    const sidebar = document.querySelector('.sidebar'); // 侧边栏宽度变化也影响工具栏
    if (sidebar) ro.observe(sidebar);
  } else {
    window.addEventListener('resize', scheduleRelayout);
  }

  // body.class 变化（reading-mode / dashboard-active 切换）
  const bodyMo = new MutationObserver(() => scheduleRelayout());
  bodyMo.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // #toolbar 子树 hidden/style 变化（shareBtn.style.display、shareStatsBtn.hidden）
  // 忽略 overflowMenu/overflowDropdown 自身变化：它们由 relayout/toggle 控制，
  // 若监听会形成"用户点开菜单 → hidden 变 false → 触发 relayout → 强制 hidden=true 关掉"的死循环
  const attrMo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.target === overflowMenu || m.target === overflowDropdown) continue;
      scheduleRelayout();
      return;
    }
  });
  attrMo.observe(toolbar, { attributes: true, subtree: true, attributeFilter: ['hidden', 'style'] });

  // 初次计算（同步，首帧 paint 前完成折叠，避免溢出闪现）
  relayout();
})();

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
    case 'alignMenu': {
      if (!ctxMenu.hidden) { hideCtxMenu(); break; }
      // 工具栏触发：清空 float menu 选区缓存，避免点击对齐选项时 restoreFloatMenuRange()
      // 恢复过期选区，导致对齐应用到错误段落。改由 editorEl.focus() 恢复当前选区。
      floatMenuRange = null;
      buildAlignMenu();
      const btn = document.getElementById('alignMenuBtn');
      if (btn) {
        const rect = btn.getBoundingClientRect();
        positionCtxMenu(rect.left, rect.bottom + 6, rect.top - 6);
        btn.setAttribute('aria-expanded', 'true');
      }
      break;
    }
    case 'hr': editor.insertHR(); break;
    case 'quote': editor.insertQuote(); break;
    case 'todo': editor.insertTodo(); break;
    case 'link': editor.insertLink(); break;
    case 'image': openMobileImagePicker(); break;
    case 'code': editor.insertCodeInline(); break;
    case 'codeblock': editor.insertCodeBlock(); break;
    case 'table': editor.insertTable(3, 3); break;
    case 'toc': editor.insertTOC(); break;
    case 'undo': editor.undo(); break;
    case 'redo': editor.redo(); break;
    case 'paintFormat': activatePaintFormat(); break;
    case 'exportHTML': exportHTML(); break;
    case 'exportMD': exportMarkdown(); break;
    case 'exportTXT': exportTXT(); break;
    case 'exportDoc': exportWord(); break;
    case 'exportPDF': exportPDF(); break;
    case 'exportImage': openExportImageModal(); break;
    case 'share': openShareModal(); break;
    
    case 'aiLayout': openAiLayoutModal(); break;
    case 'aiChat': toggleAiPanel(); break;
    case 'aiRewrite': openAiRewriteModal(); break;
    case 'reading': toggleReadingMode(); break;
    case 'selectAll': selectAllEditorContent(); break;
  }
}

// 全选编辑器全文（手机工具栏用；不依赖 execCommand，移动端更稳）
function selectAllEditorContent() {
  editorEl.focus();
  const range = document.createRange();
  range.selectNodeContents(editorEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// 移动端工具栏按钮按下时缓存的光标 Range（mousedown 阶段保存，click 阶段使用）
let _mobileSavedRange = null;

// 移动端图片选择：用缓存光标 → 调起系统选图 → 读为 data URL → 恢复光标 → 插入
// 桌面端靠拖拽/粘贴即可，移动端没有这两个入口，所以工具栏给一个独立按钮
function openMobileImagePicker() {
  // 优先用 mousedown 阶段缓存的光标；没有就再尝试读一次当前选区
  let savedRange = _mobileSavedRange;
  if (!savedRange) {
    try {
      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (editorEl.contains(r.commonAncestorContainer)) savedRange = r.cloneRange();
      }
    } catch (_) {}
  }
  _mobileSavedRange = null;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
    if (file.size > 12 * 1024 * 1024) { toast('图片过大，请小于 12MB'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result;
      if (savedRange) {
        try {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(savedRange);
        } catch (_) {}
      }
      editor.insertImage(src, savedRange);
      toast('图片已插入');
    };
    reader.onerror = () => toast('图片读取失败');
    reader.readAsDataURL(file);
  };
  input.click();
}

function refreshToolbar() {
  const btns = document.querySelectorAll('.tb-btn[data-cmd]');
  editor.refreshToolbarState(btns, blockStyleSel);
  updateAlignButton();
}

document.addEventListener('selectionchange', () => {
  if (document.activeElement === editorEl) {
    refreshToolbar();
    // 编辑器重新被聚焦：浏览器会重新显示原生选区高亮，
    // 清除 AI 自定义高亮避免视觉重复
    clearAiSelectionHighlight();
  }
  // 持续保存编辑器内的非折叠选区到 savedAiRange。
  // 这样无论用户接下来点击哪里（包括 AI 输入框），
  // savedAiRange 都保留最后一次有效的编辑器选区，
  // 彻底解决 mousedown 时机错过导致选区丢失的问题。
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    const range = sel.getRangeAt(0);
    if (editorEl.contains(range.commonAncestorContainer)) {
      savedAiRange = range.cloneRange();
    }
  }
  // AI 对话面板打开时，实时刷新选区上下文（显示"已选 N 字"）
  if (aiPanel && !aiPanel.hidden) refreshAiPanelContext();
});

/* ---------- 飞书式浮动菜单：选中显示完整菜单，点击显示精简菜单（标题层级） ---------- */
const floatMenu = $('floatMenu');
const floatMenuImg = $('floatMenuImg');
let floatMenuRange = null;

editorEl.addEventListener('mouseup', () => {
  // 格式刷：mouseup 时应用保存的格式到新选区
  if (paintFormatState && !window.getSelection().isCollapsed) {
    setTimeout(applyPaintFormat, 10);
    return;
  }
  setTimeout(updateTextFloatMenu, 10);
});
editorEl.addEventListener('keyup', () => {
  setTimeout(updateTextFloatMenu, 10);
});
editorEl.addEventListener('click', () => {
  setTimeout(updateTextFloatMenu, 10);
});

/* ---------- 格式刷：复制选区格式 → 应用到目标选区 ---------- */
let paintFormatState = null; // { bold, italic, underline, strikeThrough, color, fontSize, fontFamily }
function activatePaintFormat() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    toast('请先选中要复制格式的文字');
    return;
  }
  const f = {};
  try {
    f.bold = document.queryCommandState('bold');
    f.italic = document.queryCommandState('italic');
    f.underline = document.queryCommandState('underline');
    f.strikeThrough = document.queryCommandState('strikeThrough');
  } catch (_) {}
  let node = sel.anchorNode;
  if (node && node.nodeType === 3) node = node.parentNode;
  if (node) {
    const cs = window.getComputedStyle(node);
    f.color = cs.color;
    f.fontSize = cs.fontSize;
    f.fontFamily = cs.fontFamily;
  }
  paintFormatState = f;
  document.body.classList.add('paint-format-mode');
  const fmBtn = $('paintFormatBtn');
  if (fmBtn) fmBtn.classList.add('active');
  const tbBtn = $('paintFormatToolbarBtn');
  if (tbBtn) tbBtn.classList.add('active');
  hideFloatMenu();
  toast('格式刷已激活 选中文字应用 Esc 取消');
}
function applyPaintFormat() {
  if (!paintFormatState) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const f = paintFormatState;
  editorEl.focus();
  try {
    if (f.bold !== document.queryCommandState('bold')) document.execCommand('bold');
    if (f.italic !== document.queryCommandState('italic')) document.execCommand('italic');
    if (f.underline !== document.queryCommandState('underline')) document.execCommand('underline');
    if (f.strikeThrough !== document.queryCommandState('strikeThrough')) document.execCommand('strikeThrough');
  } catch (_) {}
  if (f.color) document.execCommand('foreColor', false, f.color);
  if (f.fontSize) document.execCommand('fontSize', false, f.fontSize);
  if (f.fontFamily) document.execCommand('fontName', false, f.fontFamily);
  markEditorChanged();
  exitPaintFormat();
  toast('已应用格式');
}
function exitPaintFormat() {
  paintFormatState = null;
  document.body.classList.remove('paint-format-mode');
  const fmBtn = $('paintFormatBtn');
  if (fmBtn) fmBtn.classList.remove('active');
  const tbBtn = $('paintFormatToolbarBtn');
  if (tbBtn) tbBtn.classList.remove('active');
}

function updateTextFloatMenu() {
  // 如果快速 AI 输入框正在输入，保持浮动菜单现状（防止输入时菜单消失）
  const aiQuickEl = $('fmAiQuick');
  if (aiQuickEl && document.activeElement === aiQuickEl) return;
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
  } else if (action === 'paintFormat') {
    activatePaintFormat();
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
    case 'crop': openImageCropper(c); floatMenuImg.hidden = true; break;
    case 'small': editor.smallImageSize(c); updateImageFloatMenu(c); break;
    case 'original': editor.resetImageSize(c); updateImageFloatMenu(c); break;
    case 'align-left': editor.alignImage(c, 'left'); break;
    case 'align-center': editor.alignImage(c, 'center'); break;
    case 'delete': editor.deleteImage(c); floatMenuImg.hidden = true; break;
  }
});

// 滚动/resize 时隐藏浮动菜单
editorEl.addEventListener('scroll', hideFloatMenu);
// 注意：capture 模式会捕获浮动菜单内部的滚动（如 AI 输入框文字超出框宽时的内部滚动），
// 必须过滤掉这些来源，否则输入超出框宽就会触发 hideFloatMenu 导致菜单秒消失
window.addEventListener('scroll', (e) => {
  const t = e.target;
  if (t && t.closest && t.closest('.float-menu')) return;
  hideFloatMenu();
}, true);
window.addEventListener('resize', () => { hideFloatMenu(); floatMenuImg.hidden = true; });
// 点击编辑器外隐藏
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('.float-menu')) return;
  if (!editorEl.contains(e.target) && !e.target.closest('.img-container')) {
    hideFloatMenu();
    floatMenuImg.hidden = true;
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
  if (action === 'align') {
    const alignPaths = {
      justifyLeft: '<line x1="21" y1="6" x2="3" y2="6"/><line x1="15" y1="12" x2="3" y2="12"/><line x1="17" y1="18" x2="3" y2="18"/>',
      justifyCenter: '<line x1="21" y1="6" x2="3" y2="6"/><line x1="18" y1="12" x2="6" y2="12"/><line x1="15" y1="18" x2="9" y2="18"/>',
      justifyRight: '<line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="9" y2="12"/><line x1="21" y1="18" x2="7" y2="18"/>',
      justifyFull: '<line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="3" y2="12"/><line x1="21" y1="18" x2="3" y2="18"/>'
    };
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (alignPaths[block] || '') + '</svg>';
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
function currentAlign() {
  try {
    if (document.queryCommandState('justifyFull')) return 'full';
    if (document.queryCommandState('justifyCenter')) return 'center';
    if (document.queryCommandState('justifyRight')) return 'right';
  } catch (_) {}
  return 'left';
}
const ALIGN_ICON_PATHS = {
  left: '<line x1="21" y1="6" x2="3" y2="6"/><line x1="15" y1="12" x2="3" y2="12"/><line x1="17" y1="18" x2="3" y2="18"/>',
  center: '<line x1="21" y1="6" x2="3" y2="6"/><line x1="18" y1="12" x2="6" y2="12"/><line x1="15" y1="18" x2="9" y2="18"/>',
  right: '<line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="9" y2="12"/><line x1="21" y1="18" x2="7" y2="18"/>',
  full: '<line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="12" x2="3" y2="12"/><line x1="21" y1="18" x2="3" y2="18"/>'
};
function buildAlignMenu() {
  const cur = currentAlign();
  let html = '<div class="ctx-menu-label">段落对齐</div>';
  html += ctxBtn('align', '左对齐', cur === 'left', 'justifyLeft');
  html += ctxBtn('align', '居中对齐', cur === 'center', 'justifyCenter');
  html += ctxBtn('align', '右对齐', cur === 'right', 'justifyRight');
  html += ctxBtn('align', '两端对齐', cur === 'full', 'justifyFull');
  ctxMenu.innerHTML = html;
}
function updateAlignButton() {
  const btn = document.getElementById('alignMenuBtn');
  if (!btn) return;
  const icon = btn.querySelector('.align-icon');
  if (icon) icon.innerHTML = ALIGN_ICON_PATHS[currentAlign()] || ALIGN_ICON_PATHS.left;
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

function hideCtxMenu() { ctxMenu.hidden = true; ctxAnchor = null; const trigger = floatMenu.querySelector('.fm-type-trigger'); if (trigger) trigger.setAttribute('aria-expanded', 'false'); const alignBtn = document.getElementById('alignMenuBtn'); if (alignBtn) alignBtn.setAttribute('aria-expanded', 'false'); }

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
    case 'align': editor.exec(block); updateAlignButton(); break;
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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideCtxMenu();
    if (paintFormatState) { exitPaintFormat(); toast('已取消格式刷'); }
  }
});

function openEditorLink(anchor) {
  if (!anchor || !anchor.href) return;
  window.open(anchor.href, '_blank', 'noopener');
}

// Editing keeps plain links safe from accidental navigation; cards expose an explicit open target.
editorEl.addEventListener('click', (e) => {
  // 转回链接按钮：直接将卡片退化为普通链接，不弹二级菜单
  const revertBtn = e.target.closest('.lc-revert');
  if (revertBtn) {
    const card = revertBtn.closest('a[data-link-card="1"]');
    if (card && editorEl.contains(card)) {
      e.preventDefault();
      e.stopPropagation();
      editor.convertCardToLink(card);
    }
    return;
  }
  const a = e.target.closest('a');
  if (!a || !editorEl.contains(a)) {
    activeLinkAnchor = null;
    return;
  }
  activeLinkAnchor = a;
  const isCard = a.getAttribute('data-link-card') === '1';
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
// 热路径：每次按键的 input 事件会触发 updateStats。
// editor.getStats() 内部读 innerText（强制 reflow）+ querySelectorAll('.img-container img')（全树扫描），
// 不加 debounce 会让长文档输入肉眼可见地卡顿（违反铁律：普通输入不得被重排阻塞）。
// 250ms debounce 与 updateOutline 对齐；停止输入后立即刷新一次。
let _statsTimer = null;
let _statsDelay = 0;
function updateStats(delay) {
  const wait = Number.isFinite(delay) ? Math.max(0, delay) : 250;
  if (_statsTimer) {
    // A large paste must be allowed to paint before the pending normal scan.
    if (wait <= _statsDelay) return;
    clearTimeout(_statsTimer);
  }
  _statsDelay = wait;
  _statsTimer = setTimeout(() => {
    _statsTimer = null;
    _statsDelay = 0;
    const s = editor.getStats();
    charCountEl.textContent = s.chars;
    imgCountEl.textContent = s.imgs;
  }, wait);
}
function autoTitleIsEligible(doc) {
  return !!(currentUser && currentUser.isAdmin && autoTitleEnabled && doc &&
    !doc._pending && doc.title_origin === 'untitled' && !doc.auto_title_attempted_at);
}

function cancelAutoTitleWork() {
  if (autoTitleTimer) { clearTimeout(autoTitleTimer); autoTitleTimer = null; }
  if (autoTitleAbortController) { try { autoTitleAbortController.abort(); } catch (_) {} autoTitleAbortController = null; }
  if (autoTitleApplyAbortController) { try { autoTitleApplyAbortController.abort(); } catch (_) {} autoTitleApplyAbortController = null; }
  autoTitleRun += 1;
}

function deferAutoTitleRun(docId, run, delay) {
  if (autoTitleTimer) clearTimeout(autoTitleTimer);
  autoTitleTimer = setTimeout(() => runAutoTitleWhenIdle(docId, run), delay);
}

function noteAutoTitlePageActivity() {
  autoTitleLastActivityAt = Date.now();
}
function scheduleAutoTitleForCurrentDoc() {
  const doc = currentDoc;
  if (!autoTitleIsEligible(doc)) return;
  if (autoTitleTimer) clearTimeout(autoTitleTimer);
  const run = ++autoTitleRun;
  autoTitleTimer = setTimeout(() => runAutoTitleWhenIdle(doc.id, run), AUTO_TITLE_IDLE_MS);
}

function noteAutoTitleContentChange() {
  noteAutoTitlePageActivity();
  cancelAutoTitleWork();
  scheduleAutoTitleForCurrentDoc();
}

function syncManualTitleButton() {
  if (!docTitleAiWrap || !docTitleAiBtn) return;
  const isAdmin = !!(currentUser && currentUser.isAdmin);
  docTitleAiWrap.hidden = !isAdmin;
  docTitleAiBtn.disabled = !isAdmin || !currentDoc || !!currentDoc._pending || !!manualTitleAbortController;
}

function hideManualTitleSuggestion() {
  manualTitleSuggestion = '';
  if (docTitleSuggestion) docTitleSuggestion.hidden = true;
}

function cancelManualTitleSuggestion() {
  manualTitleRun += 1;
  if (manualTitleAbortController) {
    try { manualTitleAbortController.abort(); } catch (_) {}
    manualTitleAbortController = null;
  }
  if (docTitleAiBtn) docTitleAiBtn.classList.remove('loading');
  hideManualTitleSuggestion();
  syncManualTitleButton();
}

function showManualTitleSuggestion(title) {
  manualTitleSuggestion = String(title || '').trim();
  if (!manualTitleSuggestion || !docTitleSuggestion || !docTitleSuggestionText) return;
  docTitleSuggestionText.textContent = manualTitleSuggestion;
  docTitleSuggestion.hidden = false;
}

async function requestManualTitleSuggestion() {
  const doc = currentDoc;
  if (!currentUser || !currentUser.isAdmin || !doc) return;
  if (doc._pending) { toast('文档正在创建，请稍候再试'); return; }
  if (manualTitleAbortController) return;
  hideManualTitleSuggestion();
  const run = ++manualTitleRun;

  // The click is deliberate, so save first and let the server read the exact
  // document version. Normal typing and document switching never wait here.
  if (doc._dirty) {
    await saveCurrent({ reorder: false });
    if (run !== manualTitleRun || currentDoc !== doc) return;
    if (doc._dirty) { toast('正文尚未保存，请稍候再试'); return; }
  }
  const version = doc.version;
  const controller = new AbortController();
  manualTitleAbortController = controller;
  docTitleAiBtn.classList.add('loading');
  syncManualTitleButton();
  try {
    const result = await api('/api/ai/suggest-title', 'POST', { docId: doc.id, version }, { signal: controller.signal });
    if (run !== manualTitleRun || currentDoc !== doc || doc.version !== version || doc._dirty) return;
    if (result.status === 'below_minimum') {
      toast('正文至少写够 ' + (result.minimumChars || 40) + ' 个字后再拟标题');
      return;
    }
    if (result.status !== 'ok' || !result.title) {
      toast('这篇内容暂时不适合拟标题');
      return;
    }
    showManualTitleSuggestion(result.title);
  } catch (e) {
    if (controller.signal.aborted) return;
    const message = String(e && e.message || '');
    if (message.includes('busy')) toast('AI 正在拟其他标题，请稍候再试');
    else toast('AI 拟标题失败：' + (message || '请稍后重试'));
  } finally {
    if (manualTitleAbortController === controller) manualTitleAbortController = null;
    if (docTitleAiBtn) docTitleAiBtn.classList.remove('loading');
    syncManualTitleButton();
  }
}

function applyManualTitleSuggestion() {
  const title = String(manualTitleSuggestion || '').trim();
  if (!title || !currentDoc) return;
  setDocTitle(title);
  currentDoc.title = title;
  currentDoc.title_origin = 'manual';
  currentDoc._dirty = true;
  lastEditedAt = Date.now();
  cancelAutoTitleWork();
  cacheDoc(currentDoc);
  updateListItem(currentDoc, { reorder: false });
  updateDocumentTitle(title);
  hideManualTitleSuggestion();
  scheduleAutoSave();
  docTitleEl.focus();
  docTitleEl.select();
  toast('已采用 AI 建议标题');
}

function runAutoTitleWhenIdle(docId, run) {
  autoTitleTimer = null;
  if (run !== autoTitleRun || !currentDoc || currentDoc.id !== docId || !autoTitleIsEligible(currentDoc)) return;
  const pageWait = AUTO_TITLE_PAGE_IDLE_MS - (Date.now() - autoTitleLastActivityAt);
  if (pageWait > 0) return deferAutoTitleRun(docId, run, pageWait);
  // The regular save remains the only write on the edit path. Wait for it instead
  // of reading editor text or sending unsaved content to the server.
  if (currentDoc._dirty) return deferAutoTitleRun(docId, run, 1500);
  const request = () => requestAutoTitle(docId, run);
  if (typeof requestIdleCallback === 'function') requestIdleCallback(request, { timeout: 1000 });
  else setTimeout(request, 0);
}

async function requestAutoTitle(docId, run) {
  if (run !== autoTitleRun || !currentDoc || currentDoc.id !== docId || !autoTitleIsEligible(currentDoc)) return;
  const version = currentDoc.version;
  const controller = new AbortController();
  autoTitleAbortController = controller;
  try {
    const result = await api('/api/ai/auto-title', 'POST', { docId, version }, { signal: controller.signal });
    if (run !== autoTitleRun || !currentDoc || currentDoc.id !== docId) return;
    if (result.status === 'below_minimum') return;
    // The server has claimed the one permitted attempt before contacting the model.
    currentDoc.auto_title_attempted_at = Date.now();
    cacheDoc(currentDoc);
    if (result.status !== 'ok' || !result.title || currentDoc.version !== version) return;
    await applyAutoTitle(docId, version, result.title, run);
  } catch (e) {
    if (controller.signal.aborted) return;
    // Another document may be using the sole server-side title slot. This is a
    // harmless deferred retry, not another model invocation for this document.
    if (String(e && e.message || '').includes('busy')) deferAutoTitleRun(docId, run, 30000);
  } finally {
    if (autoTitleAbortController === controller) autoTitleAbortController = null;
  }
}

async function applyAutoTitle(docId, version, title, run) {
  if (run !== autoTitleRun || !currentDoc || currentDoc.id !== docId || currentDoc.title_origin !== 'untitled' || currentDoc.version !== version) return;
  if (document.activeElement === docTitleEl) return;
  const controller = new AbortController();
  autoTitleApplyAbortController = controller;
  try {
    const saved = await api('/api/documents/' + docId + '/auto-title', 'PUT', { title, version }, { signal: controller.signal });
    if (run !== autoTitleRun || !currentDoc || currentDoc.id !== docId) return;
    currentDoc.title = saved.title;
    currentDoc.title_origin = saved.title_origin;
    currentDoc.auto_title_attempted_at = saved.auto_title_attempted_at;
    currentDoc.version = saved.version;
    // Do not call saveCurrent or refresh the sidebar: this metadata update must
    // preserve updated_at and the article's existing place in the document list.
    setDocTitle(saved.title);
    updateDocumentTitle(saved.title);
    cacheDoc(currentDoc);
    updateListItem(currentDoc, { reorder: false });
  } catch (e) {
    // A local edit or switch makes the expected version fail; that is intentional.
  } finally {
    if (autoTitleApplyAbortController === controller) autoTitleApplyAbortController = null;
  }
}

document.addEventListener('pointerdown', noteAutoTitlePageActivity, true);
document.addEventListener('keydown', noteAutoTitlePageActivity, true);
document.addEventListener('selectionchange', noteAutoTitlePageActivity);
document.addEventListener('scroll', noteAutoTitlePageActivity, true);


/* ---------- 自动保存 ---------- */
function scheduleAutoSave(delay) {
  if (!currentDoc) return;
  // 新建请求还在进行时，编辑器已经可用。只记录真实输入的保存意图，
  // 等文档 ID 落地后由 newDoc/newDocInFolder 立即 flush，避免首笔粘贴丢失。
  if (currentDoc._pending) {
    const hasContent = (editorEl.textContent || '').trim() ||
      editorEl.querySelector('img, table, hr, video, audio, iframe');
    if (hasContent || docTitleEl.value.trim()) currentDoc._pendingSave = true;
    return;
  }
  if (switching) return;
  if (currentDoc._revalidating) return; // 缓存校验期间暂停保存，避免旧缓存内容覆盖服务器最新版本
  if (saveTimer) clearTimeout(saveTimer);
  saveStateEl.textContent = '编辑中…';
  saveTimer = setTimeout(saveCurrent, Number.isFinite(delay) ? Math.max(0, delay) : 1000);
}

async function saveCurrent(opts) {
  if (!currentDoc) return;
  // 乐观新建期间（id 尚为 local-*）：暂存保存意图，等真实 ID 落地后再 flush
  if (currentDoc._pending) { currentDoc._pendingSave = true; return; }
  if (currentDoc._assetUploads) { currentDoc._pendingSave = true; return; }
  opts = opts || {};
  const title = (docTitleEl.value.trim() || '无标题').slice(0, TITLE_MAX);
  // 保存前剥离 AI 改写残留的呼吸高亮 mark，避免被序列化进数据库
  stripAiFlashMarks(editorEl);
  const content = replaceUploadedSources(editor.getHTML(), currentDoc._assetReplacements);
  try {
    const res = await api('/api/documents/' + currentDoc.id, 'PUT', { title, content, title_origin: currentDoc.title_origin });
    currentDoc.title = title;
    currentDoc.title_origin = title === DEFAULT_UNTITLED_TITLE ? 'untitled' : 'manual';
    currentDoc.content = content;
    const now = (res && res.updated_at) || Date.now();
    currentDoc.updated_at = now;
    if (res && typeof res.version === 'number') {
      currentDoc.version = res.version;
      // 自己保存成功后，dismissedVersion 不再适用，重置
      dismissedVersion = 0;
      hideVersionBanner();
    }
    saveStateEl.textContent = '已保存 ' + timeStr();
    currentDoc._dirty = false;
    cacheDoc(currentDoc);
    updateDocumentTitle(title);
    // 更新列表中该项的标题和时间（不重新拉列表，避免抖动）
    updateListItem(currentDoc, { reorder: opts.reorder !== false });
  } catch (e) {
    saveStateEl.textContent = '保存失败';
    toast('保存失败：' + (e.message || e));
  }
}

/* 后台保存指定文档（不依赖 currentDoc，用于切换/新建时不阻塞首屏）。
   快照在调用前已捕获，因此即便 currentDoc 已切到别的文档，也能把旧文档存对。 */
function saveDocInBackground(doc, title, html) {
  if (!doc) return;
  if (doc._assetUploads) {
    doc._pendingAssetSave = { title, html };
    return;
  }
  html = replaceUploadedSources(html, doc._assetReplacements);
  api('/api/documents/' + doc.id, 'PUT', { title, content: html, title_origin: doc.title_origin }).then(res => {
    doc.title = title;
    doc.title_origin = title === DEFAULT_UNTITLED_TITLE ? 'untitled' : 'manual';
    doc.content = html;
    doc.updated_at = (res && res.updated_at) || Date.now();
    if (res && typeof res.version === 'number') doc.version = res.version;
    doc._dirty = false;
    cacheDoc(doc);
    if (currentDoc && currentDoc.id === doc.id) {
      saveStateEl.textContent = '已保存 ' + timeStr();
      updateDocumentTitle(title);
      // 自己保存成功后，dismissedVersion 不再适用，重置
      dismissedVersion = 0;
      hideVersionBanner();
    }
    updateListItem(doc, { reorder: false });
  }).catch(e => {
    if (currentDoc && currentDoc.id === doc.id) saveStateEl.textContent = '保存失败';
    toast('保存失败：' + (e.message || e));
  });
}

/* 快照当前文档并后台保存，不阻塞后续新建/切换/复制操作 */
function saveCurrentInBackground() {
  if (!currentDoc) return;
  // 乐观新建期间（id 尚为 local-*）：暂存保存意图，等真实 ID 落地后再 flush，
  // 否则 PUT /api/documents/local-xxx 会 404 且丢失用户已输入的内容
  if (currentDoc._pending) { currentDoc._pendingSave = true; return; }
  stripAiFlashMarks(editorEl);
  const doc = currentDoc;
  const title = (docTitleEl.value.trim() || '无标题').slice(0, TITLE_MAX);
  const html = editor.getHTML();
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (doc._assetUploads) {
    doc._pendingAssetSave = { title, html };
    return;
  }
  saveDocInBackground(doc, title, html);
}

/* 把非关键重活（大纲/统计）延后到空闲帧执行，避免阻塞切换首屏 */
function scheduleAfterSwitch(fn) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => fn(), { timeout: 300 });
  } else {
    setTimeout(fn, 0);
  }
}

function updateListItem(doc, opts) {
  opts = opts || {};
  const item = docListEl.querySelector('.doc-item[data-id="' + doc.id + '"]');
  if (!item) return;
  // 只更新标题文本节点，不能对 .doc-title 容器直接 textContent——
  // 那会冲掉 .doc-title-text/.doc-pin/.doc-star 子元素，让 flex 容器失去
  // white-space:nowrap 约束，标题折成多行，且星标/置顶按钮消失。
  const titleEl = item.querySelector('.doc-title-text');
  if (titleEl) titleEl.textContent = doc.title || '无标题';
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
  // 多端同步轮询停掉
  stopVersionPolling();
  stopShareStatsPolling();
  hideVersionBanner();
  // 桌面模式：本地认证不应跳登录页，显示错误即可
  if (isDesktopMode()) {
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;color:#c0392b;font-family:sans-serif;padding:24px;text-align:center">' +
      '<h2 style="margin:0 0 8px">桌面认证失败</h2>' +
      '<p style="margin:0;color:#666">请重启知著 PenMark。如问题持续，请联系技术支持。</p>' +
      '</div>';
    return;
  }
  const redirect = window.location.pathname + window.location.search + window.location.hash;
  window.location.href = '/login.html?redirect=' + encodeURIComponent(redirect);
}
async function api(url, method, body, opts = {}) {
  const opt = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (opts.signal) opt.signal = opts.signal;
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  if (r.status === 401) {
    handleAuthFailure();
    throw new Error('need login');
  }
  if (!r.ok) {
    let errBody = null;
    try { errBody = await r.json(); } catch (e) {}
    // 常见英文错误翻译成中文（避免移动端 toast 看不懂）
    const raw = (errBody && errBody.error) || ('HTTP ' + r.status);
    const cn = translateApiError(raw);
    const requestId = errBody && typeof errBody.requestId === 'string' ? errBody.requestId : '';
    throw new Error(requestId ? cn + '（错误编号：' + requestId + '）' : cn);
  }
  return r.json();
}

// 将常见英文 API 错误翻译为中文
function translateApiError(msg) {
  if (!msg) return msg;
  const map = {
    'unauthorized': '未登录或登录已过期',
    'not found': '未找到该资源',
    'invalid url': '链接格式不正确',
    'forbidden': '没有权限',
  };
  if (map[msg]) return map[msg];
  // 含 "not found" 的也翻译
  if (/not found/i.test(msg)) return msg.replace(/not found/i, '未找到');
  return msg;
}

/* ---------- 文档列表 + 文件夹 ---------- */
let folders = [];
let sidebarDocs = [];
let starFilter = false;
// 文档列表排序状态：field=updated|created|title，order=asc|desc。默认 updated_desc 与后端一致。
let sortState = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem('penmark_sort') || '{}');
    if (raw && ['updated','created','title'].includes(raw.field) && ['asc','desc'].includes(raw.order)) return raw;
  } catch (_) {}
  return { field: 'updated', order: 'desc' };
})();
let expandedFolders = new Set(JSON.parse(localStorage.getItem('penmark_expanded_folders') || '[]'));
let draggingDocId = null;
let renamingFolderId = null;
let docClipboard = null;
let sharedDocuments = [];
let sharedDocumentsRequest = 0;

async function loadSidebar() {
  try {
    const [fRes, dRes] = await Promise.all([api('/api/folders'), api('/api/documents')]);
    folders = fRes;
    sidebarDocs = dRes;
    renderSidebar(dRes);
  } catch (e) {
    // 401 由 api() 内部处理；其他错误提示避免 unhandled rejection
    if (e && e.message !== 'need login') toast('刷新列表失败');
  }
}

function persistExpanded() {
  localStorage.setItem('penmark_expanded_folders', JSON.stringify([...expandedFolders]));
}

function renderSidebar(docs) {
  docListEl.innerHTML = '';
  // 排序：置顶永远优先，非置顶文档按 sortState 排序（field + order）
  const sorted = [...docs].sort((a, b) => {
    const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const f = sortState.field, o = sortState.order === 'asc' ? 1 : -1;
    if (f === 'title') {
      return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN') * o;
    }
    const key = f === 'created' ? 'created_at' : 'updated_at';
    const ta = new Date(a[key]).getTime();
    const tb = new Date(b[key]).getTime();
    return (ta - tb) * o;
  });
  // 星标筛选视图：平铺显示所有星标文档，不按文件夹分组
  if (starFilter) {
    const starredDocs = sorted.filter(d => d.starred);
    if (!starredDocs.length) {
      docListEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-faint);font-size:12px;">暂无星标文档，点击文档上的星标按钮收藏</div>';
      return;
    }
    starredDocs.forEach(d => docListEl.appendChild(buildDocItem(d)));
    return;
  }
  const hasShared = isMobile() && sharedDocuments.length > 0;
  if (!sorted.length && !folders.length && !hasShared) {
    docListEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink-faint);font-size:12px;">&#26242;&#26080;&#25991;&#26723;&#65292;&#28857;&#20987;&#19978;&#26041;&#26032;&#24314;&#24320;&#22987;</div>';
    return;
  }
  if (hasShared) renderSharedSidebarSection();
  if (!sorted.length && !folders.length) return;
  const grouped = {};
  const unfiled = [];
  sorted.forEach(d => {
    if (d.folder_id) (grouped[d.folder_id] = grouped[d.folder_id] || []).push(d);
    else unfiled.push(d);
  });
  folders.forEach(f => renderFolderItem(f, grouped[f.id] || []));
  renderUnfiledSection(unfiled);
}

function renderSharedSidebarSection() {
  const section = document.createElement('section');
  section.className = 'shared-sidebar-section';
  section.innerHTML =
    '<div class="shared-sidebar-head">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>' +
      '<span>&#19982;&#25105;&#20849;&#20139;</span>' +
    '</div>';
  sharedDocuments.slice(0, 12).forEach(doc => {
    const token = String(doc.token || '');
    if (!token) return;
    const permission = doc.permission === 'edit' ? '\u53ef\u7f16\u8f91' : '\u53ea\u8bfb';
    const owner = String(doc.owner_nickname || '\u67d0\u4f4d\u7528\u6237');
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'shared-sidebar-item';
    item.setAttribute('data-share-token', token);
    item.setAttribute('aria-label', '\u6253\u5f00\u5171\u4eab\u6587\u6863\uff1a' + String(doc.title || '\u65e0\u6807\u9898'));
    item.innerHTML =
      '<span class="shared-sidebar-title">' + escapeHtml(doc.title || '\u65e0\u6807\u9898') + '</span>' +
      '<span class="shared-sidebar-meta"><span>' + escapeHtml(owner) + '</span><span class="shared-sidebar-permission">' + permission + '</span><span>' + formatDateShort(new Date(doc.updated_at || Date.now())) + '</span></span>';
    item.addEventListener('click', () => window.location.assign('/s/' + encodeURIComponent(token)));
    section.appendChild(item);
  });
  docListEl.appendChild(section);
}

async function loadSharedDocuments() {
  const request = ++sharedDocumentsRequest;
  try {
    const rows = await api('/api/shared-with-me');
    if (request !== sharedDocumentsRequest) return sharedDocuments;
    sharedDocuments = Array.isArray(rows) ? rows : [];
  } catch (_) {
    if (request !== sharedDocumentsRequest) return sharedDocuments;
    sharedDocuments = [];
  }
  if (isMobile()) renderSidebar(sidebarDocs);
  return sharedDocuments;
}
function renderFolderItem(folder, docs) {
  const expanded = expandedFolders.has(folder.id);
  const wrap = document.createElement('div');
  wrap.className = 'folder-item' + (expanded ? ' expanded' : '');
  wrap.setAttribute('data-folder-id', folder.id);

  const head = document.createElement('div');
  head.className = 'folder-head';
  head.innerHTML =
    '<span class="folder-arrow"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg></span>' +
    '<span class="folder-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4a2 2 0 0 1 2-2h5l2 3h5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4z"/></svg></span>' +
    '<span class="folder-name">' + escapeHtml(folder.name) + '</span>' +
    '<button class="folder-count" data-act="new" title="在此文件夹新建文档"><span class="fc-num">' + (folder.doc_count || 0) + '</span><span class="fc-add" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span></button>' +
    '<button class="folder-menu" title="更多操作"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>';
  head.addEventListener('click', (e) => {
    if (e.target.closest('.folder-menu') || e.target.closest('.folder-name-input')) return;
    if (e.target.closest('.folder-count')) { e.stopPropagation(); newDocInFolder(folder.id); return; }
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
  bindFolderSortDrag(head, folder.id);

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
    '<div class="folder-head"><span class="folder-arrow" style="visibility:hidden"><svg width="12" height="12" viewBox="0 0 24 24"></svg></span>' +
    '<span class="folder-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4a2 2 0 0 1 2-2h5l2 3h5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4z"/></svg></span>' +
    '<span class="folder-name">未分类</span>' +
    '<button class="folder-count" data-act="new" title="新建文档"><span class="fc-num">' + docs.length + '</span><span class="fc-add" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span></button>' +
    '<button class="folder-menu" title="更多操作"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button></div>';
  const head = wrap.querySelector('.folder-head');
  head.querySelector('.folder-count').addEventListener('click', (e) => {
    e.stopPropagation();
    newDocInFolder(null);
  });
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
  if (doc.starred) item.classList.add('starred');
  item.setAttribute('data-id', doc.id);
  item.setAttribute('draggable', 'true');
  const starred = !!doc.starred;
  const pinned = !!doc.pinned;
  item.innerHTML =
    '<div class="doc-title">' +
      '<button class="doc-star' + (starred ? ' active' : '') + '" title="' + (starred ? '取消星标' : '星标') + '" aria-label="星标"><svg width="13" height="13" viewBox="0 0 24 24" fill="' + (starred ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>' +
      (pinned ? '<span class="doc-pin" title="已置顶"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v4.76a2 2 0 0 1-1.11 1.55l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg></span>' : '') +
      '<span class="doc-title-text">' + escapeHtml(doc.title || '无标题') + '</span>' +
    '</div>' +
    '<div class="doc-meta">' + relativeTime(doc.updated_at) + '</div>' +
    (doc.snippet ? '<div class="doc-snippet">' + escapeHtml(doc.snippet) + '</div>' : '') +
    '<button class="doc-menu" title="更多操作"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>' +
    '<button class="doc-del" title="删除" aria-label="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>';
  if (docClipboard && docClipboard.mode === 'cut' && String(docClipboard.docId) === String(doc.id)) {
    item.classList.add('cutting');
  }
  item.addEventListener('click', (e) => {
    if (e.target.classList.contains('doc-del')) { e.stopPropagation(); confirmDelete(doc); }
    else if (e.target.closest('.doc-menu')) { e.stopPropagation(); showDocMenu(doc, item.querySelector('.doc-menu')); }
    else if (e.target.closest('.doc-star')) { e.stopPropagation(); toggleDocStar(doc, item); }
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

// 星标切换：乐观更新 UI，失败回滚
async function toggleDocStar(doc, item) {
  const next = doc.starred ? 0 : 1;
  const prev = doc.starred;
  doc.starred = next;
  const btn = item && item.querySelector && item.querySelector('.doc-star');
  const svg = btn && btn.querySelector('svg');
  if (btn) {
    btn.classList.toggle('active', !!next);
    btn.title = next ? '取消星标' : '星标';
    if (svg) svg.setAttribute('fill', next ? 'currentColor' : 'none');
  }
  if (item && item.classList) item.classList.toggle('starred', !!next);
  const cached = sidebarDocs.find(x => x.id === doc.id);
  if (cached) cached.starred = next;
  if (currentDoc && currentDoc.id === doc.id) currentDoc.starred = next;
  try {
    await api('/api/documents/' + doc.id + '/star', 'POST', { starred: next });
    // 星标筛选视图下，取消星标后该文档应从列表消失
    if (starFilter && !next) renderSidebar(sidebarDocs);
  } catch (e) {
    doc.starred = prev;
    if (cached) cached.starred = prev;
    if (currentDoc && currentDoc.id === doc.id) currentDoc.starred = prev;
    if (btn) {
      btn.classList.toggle('active', !!prev);
      btn.title = prev ? '取消星标' : '星标';
      if (svg) svg.setAttribute('fill', prev ? 'currentColor' : 'none');
    }
    if (item && item.classList) item.classList.toggle('starred', !!prev);
    toast('操作失败：' + (e.message || e));
  }
}

// 置顶切换：乐观更新 UI + 重新排序列表（pinned 优先）
async function toggleDocPin(doc, item) {
  const next = doc.pinned ? 0 : 1;
  const prev = doc.pinned;
  doc.pinned = next;
  const cached = sidebarDocs.find(x => x.id === doc.id);
  if (cached) cached.pinned = next;
  if (currentDoc && currentDoc.id === doc.id) currentDoc.pinned = next;
  try {
    await api('/api/documents/' + doc.id + '/pin', 'POST', { pinned: next });
    // 置顶改变后重新渲染列表（排序变化）
    renderSidebar(sidebarDocs);
  } catch (e) {
    doc.pinned = prev;
    if (cached) cached.pinned = prev;
    if (currentDoc && currentDoc.id === doc.id) currentDoc.pinned = prev;
    toast('操作失败：' + (e.message || e));
  }
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

// 文件夹拖动排序：用全局变量记录当前拖动的文件夹 ID，区分"文件夹排序"和"文档移动"
let _draggingFolderId = null;

function bindFolderSortDrag(head, folderId) {
  head.setAttribute('draggable', 'true');
  head.addEventListener('dragstart', (e) => {
    _draggingFolderId = folderId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/penmark-folder', String(folderId));
    }
  });
  head.addEventListener('dragend', () => {
    _draggingFolderId = null;
    // 清除所有插入指示线
    document.querySelectorAll('.folder-head.sort-before, .folder-head.sort-after').forEach(el => {
      el.classList.remove('sort-before', 'sort-after');
    });
  });
  head.addEventListener('dragover', (e) => {
    if (_draggingFolderId === null || _draggingFolderId === folderId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    // 根据鼠标在 head 上的位置（上半/下半）决定插入到前面还是后面
    const rect = head.getBoundingClientRect();
    const isBefore = (e.clientY - rect.top) < rect.height / 2;
    head.classList.toggle('sort-before', isBefore);
    head.classList.toggle('sort-after', !isBefore);
  });
  head.addEventListener('dragleave', (e) => {
    if (!head.contains(e.relatedTarget)) {
      head.classList.remove('sort-before', 'sort-after');
    }
  });
  head.addEventListener('drop', (e) => {
    if (_draggingFolderId === null || _draggingFolderId === folderId) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = head.getBoundingClientRect();
    const isBefore = (e.clientY - rect.top) < rect.height / 2;
    head.classList.remove('sort-before', 'sort-after');
    reorderFolders(_draggingFolderId, folderId, isBefore);
    _draggingFolderId = null;
  });
}

async function reorderFolders(draggedId, targetId, isBefore) {
  // 重新排序 folders 数组
  const draggedIdx = folders.findIndex(f => String(f.id) === String(draggedId));
  if (draggedIdx < 0) return;
  const targetIdx = folders.findIndex(f => String(f.id) === String(targetId));
  if (targetIdx < 0) return;
  const [moved] = folders.splice(draggedIdx, 1);
  let insertIdx = folders.findIndex(f => String(f.id) === String(targetId));
  if (insertIdx < 0) insertIdx = folders.length;
  if (!isBefore) insertIdx += 1;
  folders.splice(insertIdx, 0, moved);
  // 立即重新渲染，避免延迟感
  renderSidebar(sidebarDocs);
  // 持久化到后端
  try {
    await api('/api/folders/sort', 'PUT', { ids: folders.map(f => f.id) });
  } catch (e) {
    toast('文件夹排序失败：' + (e.message || e));
    await loadSidebar();
  }
}

function bindDropTarget(targetEl, folderId, highlightEl) {
  const hl = highlightEl || targetEl;
  targetEl.addEventListener('dragover', (e) => {
    // 文件夹排序拖动时不在文档 drop target 上显示高亮
    if (_draggingFolderId !== null) return;
    // dataTransfer.types 在旧 Chrome(<71)/某些 Safari 是 DOMStringList，没有 indexOf；
    // 用 Array.from 包装兼容所有浏览器，否则会抛 TypeError 导致 preventDefault 不执行、drop 永远不触发
    const types = e.dataTransfer && e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
    const hasDoc = draggingDocId !== null || types.indexOf('text/penmark-doc') >= 0;
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

// “移动到”子菜单：列出文件夹供选择，桌面/移动端通用（拖拽在触屏不可用）
const moveMenu = document.createElement('div');
moveMenu.className = 'folder-context-menu move-menu';
moveMenu.hidden = true;
document.body.appendChild(moveMenu);

function closeContextMenus() {
  folderContextMenu.hidden = true;
  folderContextMenu.style.display = 'none';
  docContextMenu.hidden = true;
  docContextMenu.style.display = 'none';
  moveMenu.hidden = true;
  moveMenu.style.display = 'none';
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
moveMenu.addEventListener('pointerdown', (e) => e.stopPropagation());

function showFolderMenu(folder, anchor) {
  closeContextMenus();
  const pasteItem = docClipboard ? '<div class="fcm-item" data-act="paste">' + (docClipboard.mode === 'cut' ? '粘贴剪切的文章' : '粘贴复制的文章') + '</div>' : '';
  folderContextMenu.innerHTML = folder.unfiled
    ? (pasteItem || '<div class="fcm-item disabled">没有可粘贴的文章</div>')
    : '<div class="fcm-item" data-act="new">在此新建文档</div>' +
      '<div class="fcm-item" data-act="rename">重命名</div>' +
      pasteItem +
      '<div class="fcm-item" data-act="export">导出此文件夹</div>' +
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
    else if (act === 'export') downloadExport('/api/export/folder/' + folder.id, (folder.name || '文件夹') + '.zip');
    else if (act === 'delete') deleteFolder(folder);
  };
}

function showDocMenu(doc, anchor, point) {
  closeContextMenus();
  const starLabel = doc.starred ? '取消星标' : '星标';
  const pinLabel = doc.pinned ? '取消置顶' : '置顶';
  docContextMenu.innerHTML =
    '<div class="fcm-item" data-act="versions">版本历史</div>' +
    '<div class="fcm-item" data-act="star">' + starLabel + '</div>' +
    '<div class="fcm-item" data-act="pin">' + pinLabel + '</div>' +
    '<div class="fcm-item" data-act="move">移动到…</div>' +
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
    if (act === 'versions') {
      closeContextMenus();
      openVersionHistory(doc);
      return;
    }
    if (act === 'move') {
      // 不关闭 docContextMenu，让 moveMenu 贴着它展开
      showMoveMenu(doc, docContextMenu);
      return;
    }
    closeContextMenus();
    if (act === 'star') {
      const item = docListEl.querySelector('.doc-item[data-id="' + doc.id + '"]');
      toggleDocStar(doc, item);
    }
    else if (act === 'pin') {
      const item = docListEl.querySelector('.doc-item[data-id="' + doc.id + '"]');
      toggleDocPin(doc, item);
    }
    else if (act === 'duplicate') duplicateDoc(doc);
    else if (act === 'copy') copyDoc(doc);
    else if (act === 'cut') cutDoc(doc);
    else if (act === 'delete') confirmDelete(doc);
  };
}

// 移动到子菜单：列出所有文件夹 + 未分类，高亮当前所在位置
function showMoveMenu(doc, anchor) {
  folderContextMenu.hidden = true;
  folderContextMenu.style.display = 'none';
  const currentFolderId = doc.folder_id || null;
  let html = '';
  if (!folders.length) {
    html = '<div class="fcm-item disabled">暂无文件夹，先新建一个</div>';
  } else {
    folders.forEach(f => {
      const isCurrent = String(f.id) === String(currentFolderId);
      html += '<div class="fcm-item' + (isCurrent ? ' current' : '') + '" data-folder-id="' + f.id + '">' +
        escapeHtml(f.name) + (isCurrent ? '<span class="move-current-tag">当前</span>' : '') +
      '</div>';
    });
  }
  // 未分类选项（与上方文件夹用分隔线区分）
  const isUnfiled = currentFolderId === null;
  html += '<div class="fcm-item unfiled-item' + (isUnfiled ? ' current' : '') + '" data-folder-id="">' +
    '未分类' + (isUnfiled ? '<span class="move-current-tag">当前</span>' : '') +
  '</div>';
  moveMenu.innerHTML = html;
  moveMenu.style.display = 'block';
  // 定位：贴着 anchor（docContextMenu）右侧展开；空间不足时贴左侧
  const rect = anchor.getBoundingClientRect();
  const menuW = 200; // 与 .folder-context-menu min-width 一致
  let left = rect.right + 4;
  if (left + menuW > window.innerWidth - 8) left = rect.left - menuW - 4;
  moveMenu.style.left = Math.max(8, left) + 'px';
  moveMenu.style.top = Math.min(rect.top, window.innerHeight - 200) + 'px';
  moveMenu.hidden = false;
  moveMenu.onclick = (e) => {
    e.stopPropagation();
    const item = e.target.closest('.fcm-item');
    if (!item || item.classList.contains('disabled') || item.classList.contains('current')) return;
    const raw = item.getAttribute('data-folder-id');
    const fid = raw === '' ? null : Number(raw);
    closeContextMenus();
    moveDocToFolder(doc.id, fid);
  };
}

async function newDocInFolder(folderId) {
  cancelAutoTitleWork();
  cancelManualTitleSuggestion();
  saveCurrentInBackground(); // 旧文档后台保存，不阻塞新建
  switching = true;
  // 关闭 AI 弹窗：预览属于旧文档，避免应用到新文档
  closeAiModal();
  if (aiChatAbortController) { try { aiChatAbortController.abort(); } catch (_) {} aiChatAbortController = null; aiPanelThinking = false; setAiSendButtonMode('send'); }
  // 乐观创建：先在本地立即可写，后台再落库（第一铁律：新建 < 100ms）
  currentDoc = { id: 'local-' + Date.now(), title: '无标题', content: '', updated_at: Date.now(), folder_id: folderId, version: 1, _pending: true };
  syncManualTitleButton();
  expandedFolders.add(folderId);
  persistExpanded();
  setDocTitle('');
  editor.clear();
  saveStateEl.textContent = '新文档';
  docTitleEl.focus();
  updateDocumentTitle('无标题');
  dismissedVersion = 0;
  hideVersionBanner();
  hideDashboard();
  enterMobileEditor();
  // 后台落库 + 刷新侧边栏
  try {
    const res = await api('/api/documents', 'POST', { title: '无标题', content: '', folder_id: folderId });
    currentDoc.id = res.id;
    setDocumentRoute(res.id);
    currentDoc.title_origin = 'untitled';
    currentDoc.updated_at = (res && res.updated_at) || Date.now();
    if (res && typeof res.version === 'number') currentDoc.version = res.version;
    delete currentDoc._pending;
    syncManualTitleButton();
    scheduleAutoTitleForCurrentDoc();
    updateDocumentTitle('无标题');
    // 落库期间若用户已输入，flush 一次保存
    if (currentDoc._pendingSave) { delete currentDoc._pendingSave; saveCurrent(); }
    loadSidebar().then(() => {
      Array.prototype.forEach.call(docListEl.querySelectorAll('.doc-item'), el => {
        el.classList.toggle('active', el.getAttribute('data-id') == res.id);
      });
    });
    startVersionPolling();
    startShareStatsPolling();
    toast('已新建文档');
  } catch (e) {
    toast('新建失败：' + (e.message || e));
    saveStateEl.textContent = '新建失败';
  }
  finally {
    switching = false;
    // 与 openDoc/newDoc 的 finally 对齐：用户若在新建期间点了别的文档，切过去
    if (pendingSwitchId != null) {
      const next = pendingSwitchId;
      const nextOptions = pendingSwitchOptions || {};
      pendingSwitchId = null;
      pendingSwitchOptions = null;
      if (currentDoc && currentDoc.id !== next) openDoc(next, nextOptions);
    }
  }
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
    saveCurrentInBackground(); // 旧文档后台保存，不阻塞新建
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
  if (!await showConfirm({ title: '删除文件夹', desc: '删除文件夹「' + folder.name + '」？里面的文档会移到「未分类」。', confirmText: '删除', danger: true })) return;
  try {
    await api('/api/folders/' + folder.id, 'DELETE');
    expandedFolders.delete(folder.id);
    persistExpanded();
    await loadSidebar();
    toast('已删除文件夹');
  } catch (e) { toast('删除失败：' + (e.message || e)); }
}

async function openDoc(id, options = {}) {
  const historyMode = options.historyMode || 'push';
  // 切换中又点了别的文档：记下最新意图，前序完成后切到它，避免并发 openDoc 互踩
  if (switching) { cancelAutoTitleWork(); cancelManualTitleSuggestion(); pendingSwitchId = id; pendingSwitchOptions = options; return false; }
  if (currentDoc && String(currentDoc.id) === String(id)) {
    // 已是当前文档：仅确保移动端切到编辑器视图
    enterMobileEditor();
    if (historyMode !== 'none') setDocumentRoute(id, { replace: historyMode === 'replace' });
    return true;
  }
  cancelAutoTitleWork();
  cancelManualTitleSuggestion();
  // 旧文档快照后后台保存，不阻塞切换（第一铁律：切换 < 200ms）
  saveCurrentInBackground();
  switching = true;
  // 切换文档时关闭 AI 排版/改写弹窗：弹窗里的预览属于旧文档，避免应用到新文档造成数据错位
  closeAiModal();
  // 若有进行中的 AI 对话请求，中止它避免响应回到新文档的对话面板
  if (aiChatAbortController) { try { aiChatAbortController.abort(); } catch (_) {} aiChatAbortController = null; aiPanelThinking = false; setAiSendButtonMode('send'); }
  const targetId = id;
  let openSucceeded = false; // 标记本次打开是否成功，用于 finally 决定是否放行同文档重试
  // 加载遮罩：避免旧内容在 fetch 期间继续可见造成闪烁
  if (editorWrap) editorWrap.classList.add('editor-loading');
  try {
    const doc = readCachedDoc(id) || await api('/api/documents/' + id);
    currentDoc = doc;
    currentDoc._dirty = false;
    syncManualTitleButton();
    setDocTitle(doc.title === '无标题' ? '' : doc.title);
    setEditorHTML(doc.content || '');
    // 兜底清理历史脏数据：旧版本可能把 AI 改写的 <mark class="ai-flash"> 存进了数据库
    stripAiFlashMarks(editorEl);
    Array.prototype.forEach.call(docListEl.querySelectorAll('.doc-item'), el => {
      el.classList.toggle('active', el.getAttribute('data-id') == id);
    });
    saveStateEl.textContent = '已加载';
    cacheDoc(doc);
    scheduleAutoTitleForCurrentDoc();
    refreshToolbar();
    updateDocumentTitle(doc.title);
    enterMobileEditor();
    // 重活延后到空闲帧，不阻塞首屏；切走后不再为旧目标刷新
    scheduleAfterSwitch(() => {
      if (currentDoc && currentDoc.id === targetId) {
        updateStats();
        updateOutline(true);
      }
    });
    // 多端同步：开启版本号轮询
    dismissedVersion = 0;
    hideVersionBanner();
    startVersionPolling();
    startShareStatsPolling();
    hideDashboard();
    if (historyMode !== 'none') setDocumentRoute(doc.id, { replace: historyMode === 'replace' });
    // 若 AI 面板已打开，切换文档时刷新对话历史与上下文提示
    if (aiPanel && !aiPanel.hidden) {
      refreshAiPanelContext();
      loadAiChatHistory(doc.id);
    }
    if (doc._fromCache) {
      // 缓存校验期间暂停自动保存，避免用户基于旧缓存内容编辑并保存，覆盖服务器最新版本
      currentDoc._revalidating = true;
      revalidateCachedDoc(doc).finally(() => {
        if (currentDoc && String(currentDoc.id) === String(doc.id)) currentDoc._revalidating = false;
      });
    }
    else optimizeLegacyImages(doc);
    openSucceeded = true;
  } catch (e) { toast('打开失败：' + (e.message || e)); }
  finally {
    if (editorWrap) editorWrap.classList.remove('editor-loading');
    switching = false;
    // 切换中若用户又点了别的文档，递归切到最新意图
    if (pendingSwitchId != null) {
      const next = pendingSwitchId;
      const nextOptions = pendingSwitchOptions || {};
      pendingSwitchId = null;
      pendingSwitchOptions = null;
      // 仅在 targetId 成功打开时才跳过对同一文档的重复切换；
      // 若 targetId 打开失败，用户在加载期间对 targetId 的再次点击应视为重试，应放行
      if (!openSucceeded || next !== targetId) openDoc(next, nextOptions);
    }
  }
  return openSucceeded;
}

async function newDoc() {
  cancelAutoTitleWork();
  cancelManualTitleSuggestion();
  saveCurrentInBackground(); // 旧文档后台保存，不阻塞新建
  switching = true;
  // 乐观创建：先在本地立即可写，后台再落库（第一铁律：新建 < 100ms）
  currentDoc = { id: 'local-' + Date.now(), title: '无标题', content: '', updated_at: Date.now(), version: 1, _pending: true };
  syncManualTitleButton();
  setDocTitle('');
  editor.clear();
  saveStateEl.textContent = '新文档';
  docTitleEl.focus();
  updateDocumentTitle('无标题');
  dismissedVersion = 0;
  hideVersionBanner();
  hideDashboard();
  enterMobileEditor();
  // 后台落库 + 刷新侧边栏
  try {
    const res = await api('/api/documents', 'POST', { title: '无标题', content: '' });
    currentDoc.id = res.id;
    setDocumentRoute(res.id);
    currentDoc.title_origin = 'untitled';
    currentDoc.updated_at = (res && res.updated_at) || Date.now();
    if (res && typeof res.version === 'number') currentDoc.version = res.version;
    delete currentDoc._pending;
    syncManualTitleButton();
    scheduleAutoTitleForCurrentDoc();
    updateDocumentTitle('无标题');
    // 落库期间若用户已输入，flush 一次保存
    if (currentDoc._pendingSave) { delete currentDoc._pendingSave; saveCurrent(); }
    loadSidebar().then(() => {
      Array.prototype.forEach.call(docListEl.querySelectorAll('.doc-item'), el => {
        el.classList.toggle('active', el.getAttribute('data-id') == res.id);
      });
    });
    startVersionPolling();
    startShareStatsPolling();
    toast('已新建文档');
  } catch (e) {
    toast('新建失败：' + (e.message || e));
    saveStateEl.textContent = '新建失败';
  }
  finally {
    switching = false;
    if (pendingSwitchId != null) {
      const next = pendingSwitchId;
      const nextOptions = pendingSwitchOptions || {};
      pendingSwitchId = null;
      pendingSwitchOptions = null;
      if (!currentDoc || String(currentDoc.id) !== String(next)) openDoc(next, nextOptions);
    }
  }
}

$('newDocBtn').addEventListener('click', newDoc);
$('newFolderBtn').addEventListener('click', createFolder);

async function confirmDelete(doc) {
  if (!await showConfirm({ title: '删除文档', desc: '删除「' + (doc.title || '无标题') + '」？此操作不可恢复。', confirmText: '删除', danger: true })) return;
  try {
    await api('/api/documents/' + doc.id, 'DELETE');
    if (currentDoc && currentDoc.id === doc.id) {
      // 复用 loadSidebar 拉到的列表，避免紧接着再发一次 /api/documents（原 P1-1 性能问题）
      const remaining = await loadSidebar();
      if (remaining && remaining.length) await openDoc(remaining[0].id);
      else if (remaining && remaining.length === 0) { currentDoc = null; await newDoc(); }
      // remaining === null：loadSidebar 失败，保持当前状态，不切换
    } else {
      await loadSidebar();
    }
    toast('已删除');
  } catch (e) { toast('删除失败：' + (e.message || e)); }
}

/* ---------- 标题 ---------- */
docTitleEl.addEventListener('input', () => {
  hideManualTitleSuggestion();
  if (currentDoc) currentDoc.title_origin = 'manual';
  cancelAutoTitleWork();
  // 防御：IME 组字、拖拽入栏、历史数据回填可能突破 maxlength，实时截断
  if (docTitleEl.value.length > TITLE_MAX) {
    docTitleEl.value = docTitleEl.value.slice(0, TITLE_MAX);
    docTitleEl.setSelectionRange(TITLE_MAX, TITLE_MAX);
  }
  autoGrowTitle();
  updateDocumentTitle(docTitleEl.value);
  scheduleAutoSave();
});
// 回车键：飞书风格，从标题跳转到正文开头（禁止在标题内手动换行）
docTitleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    editorEl.focus();
    const r = document.createRange();
    r.setStart(editorEl, 0);
    r.collapse(true);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
});

function textPositionAt(root, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let node;
  while ((node = walker.nextNode())) {
    const next = consumed + node.nodeValue.length;
    if (offset <= next) return { node, offset: Math.max(0, offset - consumed) };
    consumed = next;
  }
  return null;
}

function removeLeadingText(root, count) {
  if (count <= 0) return;
  const end = textPositionAt(root, count);
  if (!end) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(end.node, end.offset);
  range.deleteContents();
}

function paragraphsFromPlainText(lines) {
  const firstContent = lines.findIndex(line => line.trim());
  if (firstContent === -1) return '';
  return lines.slice(firstContent).map(line => line.trim()
    ? '<p>' + escapeHtml(line.trim()) + '</p>'
    : '<p><br></p>'
  ).join('');
}

// 标题粘贴：飞书式逻辑 —— 第一段留标题，剩余段落插入正文开头
// 避免整篇文章被压成一行进入标题输入框
docTitleEl.addEventListener('paste', (e) => {
  const cd = e.clipboardData || window.clipboardData;
  if (!cd) return;
  const html = cd.getData('text/html');
  const text = cd.getData('text/plain') || '';

  // 简单单行短文本：让浏览器默认处理（保留光标位置、Ctrl+Z 等）
  const isSingleLineText = !html && text && !text.includes('\n') && text.length <= 100;
  if (isSingleLineText) return;

  e.preventDefault();

  let firstText = '';
  let restHtml = '';

  if (html && editor._shouldPasteAsHTML(html)) {
    // 复用编辑器的 HTML 清洗逻辑（保留公众号/微信图文样式）
    const cleanedHtml = editor._cleanPastedHTML(html);
    const doc = new DOMParser().parseFromString(cleanedHtml, 'text/html');
    const body = doc.body;

    // 找第一个块级元素作为第一段
    const blockSel = 'p, h1, h2, h3, h4, h5, h6, div, li, blockquote, pre, table, section, article';
    const firstBlock = Array.from(body.querySelectorAll(blockSel)).find(block => block.textContent.trim() && !block.querySelector(blockSel));

    if (firstBlock && firstBlock.textContent.trim()) {
      const sourceText = firstBlock.textContent || '';
      const leadingWhitespace = (sourceText.match(/^\s*/) || [''])[0].length;
      const titleSource = sourceText.slice(leadingWhitespace);
      firstText = titleSource.slice(0, TITLE_MAX).replace(/\s+/g, ' ').trim();

      // Keep the overflow from the first paragraph, preserving inline rich-text markup.
      removeLeadingText(firstBlock, leadingWhitespace + Math.min(TITLE_MAX, titleSource.length));
      if (!firstBlock.textContent.trim() && !firstBlock.querySelector('img, table, hr, video, audio')) {
        firstBlock.remove();
      }
      restHtml = body.innerHTML;
    } else {
      // 没有块级元素，整段都是 inline：按纯文本处理
      const inlineText = (text || body.textContent || '').trim();
      firstText = inlineText.slice(0, TITLE_MAX);
      restHtml = paragraphsFromPlainText([inlineText.slice(TITLE_MAX)]);
    }
  } else if (text) {
    // 纯文本：按换行拆分
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const firstLineIndex = lines.findIndex(line => line.trim());
    if (firstLineIndex !== -1) {
      const firstLine = lines[firstLineIndex].trim();
      firstText = firstLine.slice(0, TITLE_MAX);
      const remainingLines = [firstLine.slice(TITLE_MAX)].concat(lines.slice(firstLineIndex + 1));
      restHtml = paragraphsFromPlainText(remainingLines);
    }
  }

  if (!firstText) return;

  // 设置标题
  setDocTitle(firstText);
  if (currentDoc) currentDoc.title_origin = 'manual';
  cancelAutoTitleWork();
  updateDocumentTitle(firstText);
  scheduleAutoSave();

  // 剩余内容插入到编辑器开头
  if (restHtml && restHtml.trim()) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = restHtml;
    const frag = document.createDocumentFragment();
    while (tempDiv.firstChild) frag.appendChild(tempDiv.firstChild);
    if (editorEl.firstChild) {
      editorEl.insertBefore(frag, editorEl.firstChild);
    } else {
      editorEl.appendChild(frag);
    }
    editor._afterChange();
    if (editor._afterPasteCleanup) setTimeout(() => editor._afterPasteCleanup(), 60);
  }
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
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
      '<div class="search-empty-title">未找到匹配文档</div>' +
      '<div class="search-empty-hint">换个关键词试试</div>';
    docListEl.appendChild(empty);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'folder-item expanded';
  wrap.innerHTML = '<div class="folder-head"><span class="folder-arrow" style="visibility:hidden"><svg width="12" height="12" viewBox="0 0 24 24"></svg></span><span class="folder-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span><span class="folder-name">搜索结果</span><span class="folder-count">' + results.length + '</span></div>';
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

/* ---------- 移动端主页/编辑器双层架构 ---------- */
const sidebarEl = $('sidebar');

/* 首页侧边栏列宽拖拽（桌面端）：240~340px（当前 260px 的 ±30%），持久化到 localStorage，双击恢复默认。
   移动端 resizer 被 CSS 隐藏（移动端 sidebar 是抽屉式），此逻辑不会触发。 */
const sidebarResizer = $('sidebarResizer');
if (sidebarResizer && sidebarEl) {
  const SB_KEY = 'penmark:sidebar-width';
  const SB_MIN = 240;
  const SB_MAX = 340;
  const applySidebarWidth = (w) => {
    const clamped = Math.max(SB_MIN, Math.min(SB_MAX, w));
    sidebarEl.style.flexBasis = clamped + 'px';
  };
  // 初始化：读取上次拖拽保存的宽度
  const savedW = Number(localStorage.getItem(SB_KEY));
  if (savedW && savedW >= SB_MIN) applySidebarWidth(savedW);

  let sbDragging = false, sbStartX = 0, sbStartW = 0;
  sidebarResizer.addEventListener('pointerdown', (e) => {
    sbDragging = true;
    sbStartX = e.clientX;
    sbStartW = sidebarEl.getBoundingClientRect().width;
    sidebarResizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('pointermove', (e) => {
    if (!sbDragging) return;
    applySidebarWidth(sbStartW + (e.clientX - sbStartX));
  });
  document.addEventListener('pointerup', () => {
    if (!sbDragging) return;
    sbDragging = false;
    sidebarResizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(SB_KEY, String(Math.round(sidebarEl.getBoundingClientRect().width)));
  });
  // 双击恢复默认列宽（清除持久化 + inline 样式，回到 CSS 默认 260px）
  sidebarResizer.addEventListener('dblclick', () => {
    localStorage.removeItem(SB_KEY);
    sidebarEl.style.flexBasis = '';
  });
}
const MOBILE_MQ = window.matchMedia('(max-width: 760px)');
// 桌面端识别：Electron 桌面应用，或 userAgent 不是移动设备的桌面浏览器
// 关键：桌面浏览器窗口缩小到 760px 以下不切移动版，避免"被锁成超宽移动板"
// 只有真正的手机/平板（iPhone/Android/iPad）才走移动版
// viewport meta 的改写在 index.html / login.html 的 head 内联脚本中提前执行
const IS_DESKTOP_APP = !!(window.desktop && window.desktop.isDesktop);
// 允许通过 URL 强制移动版（如 ?mobile=1 / ?mobile=true 或仅 ?mobile），方便 Chrome DevTools 模拟时调试
// 注：location.search 的正则结果只保留一次，故先取捕获组到局部变量再做布尔运算
(function () {
  const m = /[?&]mobile(?:=([^&]*))?/i.exec(location.search);
  const FORCE_MOBILE_RAW = m ? (typeof m[1] === 'undefined' ? '1' : m[1]) : null;
  window.__FORCE_MOBILE__ = FORCE_MOBILE_RAW !== null &&
    FORCE_MOBILE_RAW !== '0' && FORCE_MOBILE_RAW !== 'false';
})();
const FORCE_MOBILE = !!window.__FORCE_MOBILE__;
const MOBILE_UA_BASE = /Android|iPhone|iPod|Windows Phone|Mobile|BB10|PlayBook/i.test(navigator.userAgent)
  && !/iPad/i.test(navigator.userAgent); // iPad 屏幕大，走桌面布局更合理
const MOBILE_UA = FORCE_MOBILE || MOBILE_UA_BASE;
function isMobile() {
  if (IS_DESKTOP_APP) return FORCE_MOBILE ? MOBILE_MQ.matches : false;
  if (!MOBILE_UA) return false;
  return MOBILE_MQ.matches;
}

// 进入编辑器视图（移动端）
function enterMobileEditor() {
  if (!isMobile()) return;
  document.body.classList.add('mobile-editor-active');
  closeMobileSheet();
  hideVersionBanner();
}
// 返回主页视图（移动端）：保存当前文档，切回主页
async function mobileBack(options = {}) {
  if (!isMobile()) return;
  // 先保存未保存的草稿，避免丢失
  if (currentDoc && saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (currentDoc) {
    try { await saveCurrent({ reorder: false }); } catch (e) { /* 忽略保存失败，仍允许返回 */ }
  }
  document.body.classList.remove('mobile-editor-active');
  closeMobileSheet();
  // 主页底部导航高亮"文档"
  document.querySelectorAll('.mbn-item').forEach(el => el.classList.remove('active'));
  const docsTab = document.getElementById('mbnDocs');
  if (docsTab) docsTab.classList.add('active');
  if (options.updateRoute !== false) clearDocumentRoute({ replace: true });
}
$('mobileMenuBtn').addEventListener('click', mobileBack);

/* ---------- 导出 ---------- */
function suggestedFilename(ext) {
  const title = (docTitleEl.value.trim() || '知著文档').replace(/[\\/:*?"<>|]/g, '_').replace(/\.+$/, '');
  const d = new Date();
  const date = d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  return title + '-' + date + '.' + ext;
}

function showExportLoading() {
  const button = $('exportToggle');
  const spinner = button && button.querySelector('.tb-spinner');
  if (button) button.classList.add('loading');
  if (spinner) spinner.hidden = false;
}
function hideExportLoading() {
  const button = $('exportToggle');
  const spinner = button && button.querySelector('.tb-spinner');
  if (button) button.classList.remove('loading');
  if (spinner) spinner.hidden = true;
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
// 纯文本导出：剥除所有标签，AI 最易读
function exportTXT() {
  const txt = editor.toPlainText();
  downloadBlob(new Blob(['\ufeff', txt], { type: 'text/plain;charset=utf-8' }), suggestedFilename('txt'));
  toast('已导出纯文本');
}
// PDF 导出：用 dom-to-image 截图 + 自建极简 PDF 容器，直接下载，不弹系统打印框
async function exportPDF() {
  if (!currentDoc) { toast('请先打开一个文档'); return; }
  if (exportPDF._busy) { toast('正在导出，请稍候'); return; }
  exportPDF._busy = true;
  showExportLoading('正在导出 PDF…');
  try {
    const width = 794; // A4 宽度 @96dpi
    const content = sanitizeForImageExport(editor.getHTML());
    const style = EXPORT_IMAGE_STYLES.default;
    const html = buildExportImageHTML(content, style.css, width);
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-99999px;top:0;width:' + width + 'px;';
    container.innerHTML = html;
    document.body.appendChild(container);
    const node = container.querySelector('.export-doc');
    // 等待图片 + 字体
    const imgs = node.querySelectorAll('img');
    await Promise.all(Array.from(imgs).map(img => img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; })));
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (_) {} }
    void node.offsetHeight;
    const scale = 2; // 2x 清晰度
    const fullW = width * scale;
    const fullH = node.scrollHeight * scale;
    // 用 JPEG 便于 PDF DCTDecode 嵌入
    const jpegDataUrl = await window.domtoimage.toJpeg(node, {
      width: width,
      height: node.scrollHeight,
      style: { transform: 'scale(' + scale + ')', transformOrigin: 'top left' },
      quality: 0.92
    });
    document.body.removeChild(container);
    const pdfBlob = await buildImagePDF(jpegDataUrl, fullW, fullH);
    downloadBlob(pdfBlob, suggestedFilename('pdf'));
    toast('已导出 PDF');
  } catch (e) {
    toast('导出失败：' + (e.message || e));
  } finally {
    exportPDF._busy = false;
    hideExportLoading();
  }
}

// 极简图片型 PDF 构造器：JPEG + DCTDecode，支持自动分页
// 不依赖任何库，离线可用；文字不可选（图片型 PDF）
async function buildImagePDF(jpegDataUrl, pxW, pxH) {
  // A4 portrait: 595x842 pt
  const pageW = 595, pageH = 842;
  // 图片按页宽等比缩放
  const drawW = pageW;
  const drawH = pageW * (pxH / pxW);
  // 把整图切成多页：每页对应 drawH 的一段
  // 先把 JPEG 解码到 Image，再用 canvas 切片重新编码为 JPEG（每页一张）
  const srcImg = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = jpegDataUrl; });
  const pages = [];
  if (drawH <= pageH) {
    pages.push({ dataUrl: jpegDataUrl, w: pageW, h: drawH });
  } else {
    // 按 pageH 对应的源像素高度切片
    const sliceSrcH = Math.round(srcImg.height * (pageH / drawH));
    let y = 0;
    while (y < srcImg.height) {
      const sh = Math.min(sliceSrcH, srcImg.height - y);
      const canvas = document.createElement('canvas');
      canvas.width = srcImg.width;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(srcImg, 0, y, srcImg.width, sh, 0, 0, srcImg.width, sh);
      pages.push({ dataUrl: canvas.toDataURL('image/jpeg', 0.92), w: pageW, h: pageW * (sh / srcImg.width) });
      y += sh;
    }
  }
  // 构造 PDF bytes
  const enc = (s) => unescape(encodeURIComponent(s));
  const parts = [];
  const offsets = [];
  let pos = 0;
  function write(str) { const b = enc(str); const bytes = new Uint8Array(b.length); for (let i=0;i<b.length;i++) bytes[i]=b.charCodeAt(i)&0xFF; parts.push(bytes); pos += bytes.length; }
  function writeBin(bytes) { parts.push(bytes); pos += bytes.length; }
  const objNums = [];
  let nextObj = 1;
  function allocObj() { const n = nextObj++; objNums.push(n); return n; }
  const catalogId = allocObj();
  const pagesId = allocObj();
  const pageObjIds = [];
  const contentObjIds = [];
  const imgObjIds = [];
  for (const p of pages) {
    pageObjIds.push(allocObj());
    contentObjIds.push(allocObj());
    imgObjIds.push(allocObj());
  }
  // header（二进制标记）
  write('%PDF-1.4\n');
  writeBin(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
  // 收集图片字节
  const imgBinArr = [];
  for (let i = 0; i < pages.length; i++) {
    const b64 = pages[i].dataUrl.split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    imgBinArr.push(bytes);
  }
  // 计算每页图片的像素尺寸
  const pageImgPx = [];
  if (pages.length === 1) {
    pageImgPx.push({ w: srcImg.width, h: srcImg.height });
  } else {
    for (const p of pages) {
      // 切片后的像素宽=源图宽，高=按绘制比例反推
      const pxW = srcImg.width;
      const pxH = Math.round(srcImg.width * (p.h / p.w));
      pageImgPx.push({ w: pxW, h: pxH });
    }
  }
  // 写 image XObject（DCTDecode JPEG）
  for (let i = 0; i < pages.length; i++) {
    const bytes = imgBinArr[i];
    const px = pageImgPx[i];
    offsets[imgObjIds[i]] = pos;
    write(imgObjIds[i] + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + px.w + ' /Height ' + px.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + bytes.length + ' >>\nstream\n');
    writeBin(bytes);
    write('\nendstream\nendobj\n');
  }
  // 写 content stream
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const stream = 'q\n' + p.w + ' 0 0 ' + p.h + ' 0 0 cm\n/Im' + i + ' Do\nQ\n';
    const streamBytes = enc(stream);
    offsets[contentObjIds[i]] = pos;
    write(contentObjIds[i] + ' 0 obj\n<< /Length ' + streamBytes.length + ' >>\nstream\n' + stream + 'endstream\nendobj\n');
  }
  // 写 page 对象
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    offsets[pageObjIds[i]] = pos;
    write(pageObjIds[i] + ' 0 obj\n<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH + '] /Resources << /XObject << /Im' + i + ' ' + imgObjIds[i] + ' 0 R >> >> /Contents ' + contentObjIds[i] + ' 0 R >>\nendobj\n');
  }
  // Pages
  offsets[pagesId] = pos;
  const kids = pageObjIds.map(n => n + ' 0 R').join(' ');
  write(pagesId + ' 0 obj\n<< /Type /Pages /Count ' + pages.length + ' /Kids [' + kids + '] >>\nendobj\n');
  // Catalog
  offsets[catalogId] = pos;
  write(catalogId + ' 0 obj\n<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>\nendobj\n');
  // xref
  const xrefPos = pos;
  write('xref\n0 ' + (objNums.length + 1) + '\n0000000000 65535 f \n');
  for (let i = 1; i <= objNums.length; i++) {
    const off = offsets[i] || 0;
    write(String(off).padStart(10, '0') + ' 00000 n \n');
  }
  write('trailer\n<< /Size ' + (objNums.length + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');
  return new Blob(parts, { type: 'application/pdf' });
}
// 真 .docx 导出：服务端生成标准 OOXML，AI 文档解析器可读
async function exportWord() {
  if (!currentDoc) return;
  if (exportWord._busy) { toast('正在导出，请稍候'); return; }
  exportWord._busy = true;
  showExportLoading('正在导出 Word…');
  // 发送当前编辑器 HTML（含未保存改动），服务端解析为 docx
  const html = editor.getHTML();
  const title = (docTitleEl.value.trim() || '无标题').slice(0, TITLE_MAX);
  try {
    const resp = await fetch('/api/export/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, title })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || '导出失败');
    }
    const blob = await resp.blob();
    downloadBlob(blob, suggestedFilename('docx'));
    toast('已导出 Word（.docx）');
  } catch (e) {
    toast('导出失败：' + (e.message || e));
  } finally {
    exportWord._busy = false;
    hideExportLoading();
  }
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
  if (downloadExportImage._busy) { toast('正在导出，请稍候'); return; }
  downloadExportImage._busy = true;
  showExportLoading('正在导出图片…');
  const container = $('exportRenderContainer');

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
    downloadExportImage._busy = false;
    hideExportLoading();
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

// 内置排版预设：label 显示在按钮上，prompt 是发给 AI 的提示词（中文，与 ai.js layoutPresetInstructions 保持同步）
const AI_PRESETS = {
  wash: { label: '洗排版（不改字）', prompt: '洗排版（长文阅读）：只调整 HTML 结构，绝不改变任何可见文字、标点、数字、顺序或信息；不得增删、改写、概括、纠错或合并句子。严禁移除或降级原文已有的 <strong> 加粗与 <mark> 高亮，这些是作者标注的重点词，必须原样保留。移除普通文字里多余的内联样式和包裹；不要输出 style、class、font、color、background、字号、字距、行距或对齐属性。保留已有图片、链接、链接卡片和自定义 data 属性。小标题统一使用 <h3>；仅当原文存在明确的 <h1>/<h2> 更高级别章节层级时才保留其层级，否则所有小标题一律用 <h3>，不使用 <h1>，不凭空新增章节。每个自然段使用一个 <p>，让每个 <h3> 标题与其紧随其后的正文段落归为一组，组与组之间靠正常间距自然分隔，不要为了凑版面插入 <br>、空段、全角空格或 &nbsp;。把真正的项目符号/序号整理为 <ul>/<ol><li>，不要用字符“•”“-”“—”假装列表。只在原文已经明确强调，或确实承担结论、警示、核心标签的短语上添加 <strong>；每段最多 1 处、每节最多 4 处，绝不加粗整句、整段或连续多项。不要使用 blockquote、表格、代码块，除非原文已有相应语义。' },
  share: { label: '分享前排版', prompt: '分享前排版：让文章更适合分享传播。建立清晰的标题层级、简短易读的段落、统一的列表、适度的强调与间距。不改动任何文字。' },
  light: { label: '轻度整理', prompt: '轻度整理：仅在原文强烈暗示时，规范化段落、标题、列表、间距，以及引用/代码/表格结构，不做多余改动。' },
  formal: { label: '正式文档', prompt: '正式文档排版：使用保守的标题、编号章节、段落、引用块与表格，仅在原文明确暗示时使用。' },
  clean: { label: '清理杂样式', prompt: '清理杂样式：去除混乱的内联包裹与冗余样式，保留语义化 HTML 和简洁的段落/标题/列表。' }
};

const AI_REWRITE_PRESETS = [
  { label: '\u53ea\u505a\u6392\u7248', value: '\u53ea\u5bf9\u9009\u4e2d\u5185\u5bb9\u505a\u6392\u7248\u548c\u5206\u6bb5\u6574\u7406\uff0c\u4e0d\u5220\u5b57\uff0c\u4e0d\u6539\u5199\u8bcd\u53e5\uff0c\u4e0d\u8865\u5145\u65b0\u5185\u5bb9\u3002' },
  { label: '\u6da6\u8272', value: '\u5728\u4e0d\u6539\u53d8\u539f\u610f\u548c\u7ec6\u8282\u7684\u524d\u63d0\u4e0b\uff0c\u8ba9\u9009\u4e2d\u6587\u5b57\u66f4\u987a\u3001\u66f4\u81ea\u7136\u3002' },
  { label: '\u6269\u5199', value: '\u57fa\u4e8e\u9009\u4e2d\u5185\u5bb9\u9002\u5ea6\u6269\u5199\uff0c\u4e0d\u865a\u6784\u4e8b\u5b9e\uff0c\u98ce\u683c\u548c\u5168\u6587\u4fdd\u6301\u4e00\u81f4\u3002' }
];

function openAiModal(title, bodyHtml) {
  if (!aiModal) return;
  hideFloatMenu();
  hideCtxMenu();
  floatMenuImg.hidden = true;
  aiModalTitle.textContent = title;
  aiModalBody.innerHTML = bodyHtml;
  aiModal.hidden = false;
}

function closeAiModal() {
  if (aiModal) aiModal.hidden = true;
  pendingAiLayoutHtml = '';
  pendingAiRewriteText = '';
  pendingAiRewrite = null;
}

if (aiModalClose) aiModalClose.addEventListener('click', closeAiModal);
if (aiModal) {
  aiModal.addEventListener('pointerdown', (e) => {
    if (e.target === aiModal) closeAiModal();
  });
}

/* ---------- AI 对话面板（右侧丝滑滑入） ---------- */
const aiPanel = $('aiPanel');
const aiPanelOverlay = $('aiPanelOverlay');
const aiPanelClose = $('aiPanelClose');
const aiPanelContext = $('aiPanelContext');
const aiPanelMessages = $('aiPanelMessages');
const aiPanelInput = $('aiPanelInput');
const aiPanelSend = $('aiPanelSend');
const aiQuickTags = $('aiQuickTags');
const aiChatBtn = $('aiChatBtn');
let aiPanelHistory = []; // 当前文档对话历史（按文档保留）
let aiPanelThinking = false;
let aiPanelLoadedDocId = null;
let aiChatAbortController = null; // AI 对话请求的 AbortController，发送按钮可中断

function toggleAiPanel() {
  if (!aiPanel) return;
  if (aiPanel.hidden) openAiPanel(); else closeAiPanel();
}

function openAiPanel() {
  if (!aiPanel) return;
  aiPanel.hidden = false;
  aiPanelOverlay.hidden = false;
  // 双 RAF：先显示出来再触发动画类，过渡才生效
  requestAnimationFrame(() => requestAnimationFrame(() => {
    aiPanel.classList.add('show');
    aiPanelOverlay.classList.add('show');
  }));
  if (aiChatBtn) aiChatBtn.classList.add('active');
  refreshAiPanelContext();
  // 拉取当前文档历史
  const docId = currentDoc && currentDoc.id;
  if (docId && docId !== aiPanelLoadedDocId) {
    loadAiChatHistory(docId);
  } else if (!docId) {
    aiPanelHistory = [];
    aiPanelLoadedDocId = null;
    renderAiPanelMessages();
    refreshAiPanelContext();
  }
  setTimeout(() => { if (aiPanelInput) aiPanelInput.focus(); }, 280);
}

function closeAiPanel() {
  if (!aiPanel) return;
  aiPanel.classList.remove('show');
  aiPanelOverlay.classList.remove('show');
  if (aiChatBtn) aiChatBtn.classList.remove('active');
  // 等过渡结束再 hidden，避免硬切
  setTimeout(() => {
    if (!aiPanel.classList.contains('show')) { aiPanel.hidden = true; aiPanelOverlay.hidden = true; }
  }, 280);
}

function refreshAiPanelContext() {
  if (!aiPanelContext) return;
  // 优先感知编辑器选区：先看实时选区；焦点移到 AI 输入框后实时选区会丢失，
  // 回退到 savedAiRange（selectionchange 持续保存的最后一次编辑器选区），
  // 这样"全选后打开 AI 面板"仍能看到选区上下文。
  let selText = '';
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    const range = sel.getRangeAt(0);
    if (editorEl.contains(range.commonAncestorContainer)) {
      selText = sel.toString();
    }
  }
  if (!selText && savedAiRange && !savedAiRange.collapsed) {
    selText = savedAiRange.toString();
  }
  if (selText) {
    const n = selText.length;
    const preview = selText.replace(/\s+/g, ' ').trim().slice(0, 50);
    aiPanelContext.textContent = '已选 ' + n + ' 字：' + preview + (n > 50 ? '…' : '');
    return;
  }
  // 无选区时回退到文档名
  if (currentDoc && currentDoc.id) {
    const t = (currentDoc.title || '无标题').trim();
    aiPanelContext.textContent = '当前文档：' + (t.length > 22 ? t.slice(0, 22) + '…' : t);
  } else {
    aiPanelContext.textContent = '未选择文档';
  }
}

async function loadAiChatHistory(docId) {
  try {
    const rows = await api('/api/documents/' + docId + '/chat-history', 'GET');
    // await 期间文档可能已切换（快速 A→B→C），丢弃过期响应避免覆盖新文档历史
    if (!currentDoc || currentDoc.id !== docId) return;
    aiPanelHistory = rows.map(r => ({ role: r.role, content: r.content, created_at: r.created_at }));
    aiPanelLoadedDocId = docId;
    renderAiPanelMessages();
    refreshAiPanelContext();
    // 滚到底部
    if (aiPanelMessages) aiPanelMessages.scrollTop = aiPanelMessages.scrollHeight;
  } catch (e) {
    // 表尚未建好或网络异常时静默：用户仍可发送（首条会触发后端建表）
    if (!currentDoc || currentDoc.id !== docId) return;
    aiPanelHistory = [];
    aiPanelLoadedDocId = docId;
    renderAiPanelMessages();
  }
}

function renderAiPanelMessages() {
  if (!aiPanelMessages) return;
  aiPanelMessages.innerHTML = '';
  if (aiPanelHistory.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'ai-msg-hint';
    hint.textContent = currentDoc ? '问我任何关于本文的问题，或试试下面的快捷指令。' : '请先选择一个文档，再开始对话。';
    aiPanelMessages.appendChild(hint);
    return;
  }
  for (const m of aiPanelHistory) {
    aiPanelMessages.appendChild(buildAiMessageEl(m.role, m.content));
  }
}

function buildAiMessageEl(role, content, opts) {
  opts = opts || {};
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg ' + (role === 'user' ? 'ai-msg-user' : 'ai-msg-ai');
  if (opts.error) wrap.classList.add('ai-msg-error');
  wrap.textContent = content;
  if (role === 'assistant' && !opts.error) {
    const actions = document.createElement('div');
    actions.className = 'ai-msg-actions';
    const insertBtn = document.createElement('button');
    insertBtn.className = 'ai-msg-action';
    insertBtn.type = 'button';
    insertBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>插入到文档';
    insertBtn.addEventListener('click', () => insertAiMessageToEditor(content));
    const copyBtn = document.createElement('button');
    copyBtn.className = 'ai-msg-action';
    copyBtn.type = 'button';
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>复制';
    copyBtn.addEventListener('click', () => copyAiMessage(content, copyBtn));
    actions.appendChild(insertBtn);
    actions.appendChild(copyBtn);
    wrap.appendChild(actions);
  }
  return wrap;
}

function appendAiMessage(role, content, opts) {
  aiPanelHistory.push({ role, content });
  if (aiPanelMessages) {
    // 移除空状态提示
    const hint = aiPanelMessages.querySelector('.ai-msg-hint');
    if (hint) hint.remove();
    aiPanelMessages.appendChild(buildAiMessageEl(role, content, opts));
    aiPanelMessages.scrollTop = aiPanelMessages.scrollHeight;
    updateAiBackToBottom();
  }
}

function buildTypingEl() {
  const el = document.createElement('div');
  el.className = 'ai-msg ai-msg-ai ai-msg-typing-wrap';
  const typing = document.createElement('div');
  typing.className = 'ai-msg-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  el.appendChild(typing);
  return el;
}

function insertAiMessageToEditor(text) {
  if (!text) return;
  editorEl.focus();
  // 恢复上次选区，没有就追加到光标位置
  document.execCommand('insertHTML', false, escapeHtml(text).replace(/\n/g, '<br>'));
  editor._afterChange && editor._afterChange();
  toast('已插入到文档');
}

function copyAiMessage(text, btn) {
  if (!text) return;
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(fallback);
  } else {
    fallback();
  }
  if (btn) {
    const old = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>已复制';
    setTimeout(() => { btn.innerHTML = old; }, 1500);
  } else {
    toast('已复制');
  }
}

async function sendAiMessage() {
  if (!aiPanelInput || aiPanelThinking) return;
  const text = aiPanelInput.value.trim();
  if (!text) return;
  if (!currentDoc || !currentDoc.id) {
    toast('请先选择一个文档');
    return;
  }
  // 在加入新消息前快照历史，发给后端（避免把当前消息重复带进 history）
  const historySnapshot = aiPanelHistory.slice(-20).map(m => ({ role: m.role, content: m.content }));
  // 渲染用户消息
  appendAiMessage('user', text);
  aiPanelInput.value = '';
  autoGrowAiInput();
  // 显示 typing
  aiPanelThinking = true;
  setAiSendButtonMode('stop');
  if (aiPanelMessages) {
    const typingEl = buildTypingEl();
    aiPanelMessages.appendChild(typingEl);
    aiPanelMessages.scrollTop = aiPanelMessages.scrollHeight;
  }
  // 独立 AbortController：让发送按钮可中断当前请求
  aiChatAbortController = new AbortController();
  // 快照当前文档 ID：await 期间用户可能切换文档，响应要落回原文档的对话
  const sentDocId = currentDoc.id;
  try {
    const data = await api('/api/ai/chat', 'POST', {
      docId: sentDocId,
      message: text,
      history: historySnapshot
    }, { signal: aiChatAbortController.signal });
    // 移除 typing
    if (aiPanelMessages) {
      const t = aiPanelMessages.querySelector('.ai-msg-typing-wrap');
      if (t) t.remove();
    }
    // 文档已切换：响应不追加到新文档的对话（服务端已写入原文档的历史，下次切回仍可见）
    if (!currentDoc || currentDoc.id !== sentDocId) return;
    appendAiMessage('assistant', data.reply || '');
    if (aiPanelMessages) aiPanelMessages.scrollTop = aiPanelMessages.scrollHeight;
  } catch (e) {
    if (aiPanelMessages) {
      const t = aiPanelMessages.querySelector('.ai-msg-typing-wrap');
      if (t) t.remove();
    }
    // 用户主动取消：静默，不打扰
    if (e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''))) {
      appendAiMessage('assistant', '（已停止）', { error: true });
    } else {
      appendAiMessage('assistant', '请求失败：' + (e.message || e), { error: true });
      toast('AI 请求失败');
    }
  } finally {
    aiPanelThinking = false;
    aiChatAbortController = null;
    setAiSendButtonMode('send');
    if (aiPanelInput) aiPanelInput.focus();
  }
}

// 中止当前 AI 对话请求
function stopAiChat() {
  if (aiChatAbortController) {
    try { aiChatAbortController.abort(); } catch (e) {}
  }
}

// 发送按钮在「发送」/「停止」两种模式间切换
function setAiSendButtonMode(mode) {
  if (!aiPanelSend) return;
  const isStop = mode === 'stop';
  const icon = aiPanelSend.querySelector('.ai-panel-send-icon');
  if (icon) {
    icon.setAttribute('fill', isStop ? 'currentColor' : 'none');
    icon.setAttribute('stroke', isStop ? 'none' : 'currentColor');
    icon.innerHTML = isStop
      ? '<rect x="6" y="6" width="12" height="12" rx="2"/>'
      : '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>';
  }
  if (isStop) {
    aiPanelSend.classList.add('is-stop');
    aiPanelSend.title = '停止生成';
    aiPanelSend.setAttribute('aria-label', '停止生成');
    aiPanelSend.disabled = false;
  } else {
    aiPanelSend.classList.remove('is-stop');
    aiPanelSend.title = '发送';
    aiPanelSend.setAttribute('aria-label', '发送');
    aiPanelSend.disabled = false;
  }
}

function autoGrowAiInput() {
  if (!aiPanelInput) return;
  aiPanelInput.style.height = 'auto';
  aiPanelInput.style.height = Math.min(aiPanelInput.scrollHeight, 120) + 'px';
}

if (aiPanelClose) aiPanelClose.addEventListener('click', closeAiPanel);
// 面板常驻：点击外部不再关闭，用户可继续在文档里编辑、选区、选插入位置
// overlay 已设为 pointer-events:none，不会拦截文档点击
if (aiPanelSend) aiPanelSend.addEventListener('click', () => {
  // 思考中：按钮变停止，点击中断当前请求；否则发送
  if (aiPanelThinking) stopAiChat();
  else sendAiMessage();
});
if (aiPanelInput) {
  aiPanelInput.addEventListener('input', autoGrowAiInput);
  aiPanelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAiMessage();
    }
  });
}
// 「回到底部」按钮：向上翻历史时显示，新消息到达自动滚到底则隐藏
const aiBackToBottomBtn = $('aiBackToBottom');
if (aiPanelMessages) {
  aiPanelMessages.addEventListener('scroll', updateAiBackToBottom, { passive: true });
}
if (aiBackToBottomBtn) {
  aiBackToBottomBtn.addEventListener('click', aiBackToBottom);
}
function updateAiBackToBottom() {
  if (!aiPanelMessages || !aiBackToBottomBtn) return;
  const awayFromBottom = aiPanelMessages.scrollHeight - aiPanelMessages.scrollTop - aiPanelMessages.clientHeight > 120;
  if (awayFromBottom && aiPanelMessages.scrollHeight > aiPanelMessages.clientHeight + 200) {
    aiBackToBottomBtn.hidden = false;
  } else {
    aiBackToBottomBtn.hidden = true;
  }
}
function aiBackToBottom() {
  if (!aiPanelMessages) return;
  aiPanelMessages.scrollTop = aiPanelMessages.scrollHeight;
  if (aiBackToBottomBtn) aiBackToBottomBtn.hidden = true;
}
if (aiQuickTags) {
  aiQuickTags.addEventListener('click', (e) => {
    const tag = e.target.closest('.ai-tag');
    if (!tag) return;
    const prompt = tag.getAttribute('data-prompt') || '';
    if (!aiPanelInput) return;
    // 选区有内容时附上选区
    const sel = window.getSelection();
    const selText = sel && sel.toString ? sel.toString().trim() : '';
    if (selText && editorEl.contains(sel.anchorNode)) {
      aiPanelInput.value = prompt + '\n\n选区：\n' + selText;
    } else {
      aiPanelInput.value = prompt;
    }
    autoGrowAiInput();
    aiPanelInput.focus();
    // 光标放到末尾
    const len = aiPanelInput.value.length;
    aiPanelInput.setSelectionRange(len, len);
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

function restoreAiSelection(range) {
  const targetRange = range || savedAiRange;
  if (!targetRange) return false;
  try {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(targetRange);
    return true;
  } catch (_) {
    return false;
  }
}

function rangeToHtml(range) {
  try {
    const holder = document.createElement('div');
    holder.appendChild(range.cloneContents());
    return holder.innerHTML;
  } catch (_) {
    return null;
  }
}

// AI 返回是异步的。目标 Range 必须独立保存，不能依赖会随新选区变化的 savedAiRange。
function captureAiRewriteTarget(selectedText) {
  if (!currentDoc || !currentDoc.id || !savedAiRange) return null;
  const range = savedAiRange.cloneRange();
  const sourceHtml = rangeToHtml(range);
  if (sourceHtml == null) return null;
  return {
    docId: currentDoc.id,
    range,
    sourceHtml,
    selectedText: selectedText || range.toString(),
    contextText: getDocumentContextText(),
    editorVersion: editorContentVersion,
    replacement: ''
  };
}

function aiRewriteTargetIsCurrent(transaction) {
  if (!transaction || !transaction.range || !currentDoc || currentDoc.id !== transaction.docId) return false;
  try {
    if (!editorEl.contains(transaction.range.commonAncestorContainer)) return false;
    return transaction.range.toString() === transaction.selectedText &&
      rangeToHtml(transaction.range) === transaction.sourceHtml;
  } catch (_) {
    return false;
  }
}

function applyAiRewriteTransaction(transaction) {
  if (!transaction || !transaction.replacement) return false;
  if (!aiRewriteTargetIsCurrent(transaction)) {
    toast('原选区已改动，AI 建议未替换；请重新生成');
    return false;
  }
  if (!restoreAiSelection(transaction.range)) {
    toast('未能恢复原选区，请重新生成');
    return false;
  }
  // 浏览器原生的单次“替换选区”操作，Ctrl/⌘+Z 会完整恢复原文并保持重做链。
  const inserted = document.execCommand('insertHTML', false, textToEditorHtml(transaction.replacement));
  if (!inserted) {
    toast('未能应用 AI 建议，请重试');
    return false;
  }
  markEditorChanged();
  showAiUndoBubble();
  return true;
}
/* AI 选区视觉保持：用 CSS Custom Highlight API 给 savedAiRange 加半透明高亮，
   这样点击 AI 输入框后虽然浏览器原生选区高亮消失，但视觉上仍能看到选区范围。
   不破坏 DOM，不影响编辑器内容。 */
function setAiSelectionHighlight(range) {
  if (!window.Highlight || !CSS || !CSS.highlights) return;
  if (!range) { CSS.highlights.delete('ai-selection'); return; }
  try {
    const hl = new Highlight(range);
    CSS.highlights.set('ai-selection', hl);
  } catch (_) {}
}
function clearAiSelectionHighlight() {
  if (window.Highlight && CSS && CSS.highlights) {
    CSS.highlights.delete('ai-selection');
  }
}

function textToEditorHtml(text) {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

/* 剥离 AI 改写残留的 <mark class="ai-flash">：把 mark 解包为它的子节点，
   保留文字内容、丢弃 mark 标签。AI 改写的高亮本应是一次性呼吸动画，
   但 setTimeout 解包可能被自动保存/切换抢占，导致 mark 被持久化进数据库。
   在保存前与打开文档时各清一次，确保不留痕。 */
function stripAiFlashMarks(root) {
  if (!root || !root.querySelectorAll) return;
  const marks = root.querySelectorAll('mark.ai-flash');
  if (!marks.length) return;
  marks.forEach(m => {
    const p = m.parentNode;
    if (!p) return;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
    if (p.normalize) p.normalize();
  });
}

function markEditorChanged() {
  editorEl.dispatchEvent(new Event('input', { bubbles: true }));
  updateStats();
  updateOutline();
  scheduleAutoSave();
}

/* ---------- AI 排版：自定义预设（按账号绑定） ---------- */
let aiCustomPresets = []; // 当前用户的自定义预设
let aiLayoutCurrentPreset = 'wash';
let aiLayoutCurrentCustomPrompt = '';
const AI_ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const AI_ICON_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
const AI_ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

/* ---------- 系统预设用户级隐藏（localStorage，个人偏好，不跨设备同步） ---------- */
const HIDDEN_BUILTIN_KEY = 'aiHiddenBuiltin';
function getHiddenBuiltin() {
  try { return JSON.parse(localStorage.getItem(HIDDEN_BUILTIN_KEY) || '[]'); } catch (_) { return []; }
}
function setHiddenBuiltin(arr) {
  try { localStorage.setItem(HIDDEN_BUILTIN_KEY, JSON.stringify(arr)); } catch (_) {}
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => {});
  }
  return new Promise(resolve => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    resolve();
  });
}

// 渲染预设按钮行：系统预设（未隐藏）+ 自定义预设 + 新建预设按钮（虚线外框）
function renderAiPresetRow() {
  const row = $('aiPresetRow');
  if (!row) return;
  const hidden = getHiddenBuiltin();
  let html = Object.keys(AI_PRESETS).filter(k => !hidden.includes(k)).map(key =>
    '<button class="ai-preset' + (aiLayoutCurrentPreset === key && !aiLayoutCurrentCustomPrompt ? ' active' : '') + '" data-preset="' + key + '">' + AI_PRESETS[key].label + '</button>'
  ).join('');
  if (Array.isArray(aiCustomPresets) && aiCustomPresets.length) {
    html += aiCustomPresets.map((p, i) =>
      '<span class="ai-preset-custom" data-preset="custom" data-custom-index="' + i + '" title="' + escapeHtml((p.prompt || '').slice(0, 80)) + '">' +
        '<span class="ai-preset-label">' + escapeHtml(p.label) + '</span>' +
        '<span class="ai-preset-icon" data-act="edit" title="编辑">' + AI_ICON_PENCIL + '</span>' +
        '<span class="ai-preset-icon" data-act="delete" title="删除">' + AI_ICON_TRASH + '</span>' +
      '</span>'
    ).join('');
  }
  html += '<button class="ai-preset-add-btn" id="aiPresetNew" title="新建预设">' + AI_ICON_PLUS + '新建预设</button>';
  row.innerHTML = html;
  // 系统预设点击：选中 + 显示提示词预览
  row.querySelectorAll('.ai-preset[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-preset');
      aiLayoutCurrentPreset = key;
      aiLayoutCurrentCustomPrompt = '';
      row.querySelectorAll('.ai-preset, .ai-preset-custom').forEach(b => b.classList.toggle('active', b === btn));
      showAiPresetTip(AI_PRESETS[key].prompt, key);
    });
  });
  // 自定义预设点击：选中 + 显示提示词预览；图标走编辑/删除
  row.querySelectorAll('.ai-preset-custom').forEach(el => {
    el.addEventListener('click', (e) => {
      const icon = e.target.closest('.ai-preset-icon');
      const idx = Number(el.getAttribute('data-custom-index'));
      if (icon) {
        e.stopPropagation();
        const act = icon.getAttribute('data-act');
        if (act === 'edit') editCustomPreset(idx);
        else if (act === 'delete') deleteCustomPreset(idx);
        return;
      }
      aiLayoutCurrentPreset = 'custom';
      aiLayoutCurrentCustomPrompt = (aiCustomPresets[idx] && aiCustomPresets[idx].prompt) || '';
      row.querySelectorAll('.ai-preset, .ai-preset-custom').forEach(b => b.classList.toggle('active', b === el));
      showAiPresetTip((aiCustomPresets[idx] && aiCustomPresets[idx].prompt) || '', null);
    });
  });
  const newBtn = $('aiPresetNew');
  if (newBtn) newBtn.addEventListener('click', createCustomPreset);
  renderAiHiddenRow();
}

// 显示提示词预览（2-3行半透明，再点展开完整，可复制不可改）
function showAiPresetTip(prompt, key) {
  const tip = $('aiPresetTip');
  if (!tip) return;
  tip.classList.remove('expanded');
  const textEl = $('aiPresetTipText');
  if (textEl) textEl.textContent = prompt || '';
  const hint = $('aiPresetTipHint');
  if (hint) hint.textContent = '点击展开完整提示词';
  tip.hidden = false;
  // 仅系统预设可隐藏
  const hideBtn = $('aiPresetTipHide');
  if (hideBtn) { hideBtn.hidden = !key; hideBtn.setAttribute('data-key', key || ''); }
}
function hideAiPresetTip() {
  const tip = $('aiPresetTip');
  if (tip) { tip.hidden = true; tip.classList.remove('expanded'); }
}

// 渲染已隐藏的系统预设恢复区
function renderAiHiddenRow() {
  const row = $('aiPresetHiddenRow');
  if (!row) return;
  const hidden = getHiddenBuiltin();
  if (!hidden.length) { row.hidden = true; row.innerHTML = ''; return; }
  row.hidden = false;
  row.innerHTML = '<span class="ai-preset-hidden-label">已隐藏：</span>' + hidden.map(key =>
    '<button class="ai-preset-restore" data-restore="' + key + '">' + (AI_PRESETS[key] && AI_PRESETS[key].label || key) + ' 恢复</button>'
  ).join('');
  row.querySelectorAll('.ai-preset-restore').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-restore');
      setHiddenBuiltin(getHiddenBuiltin().filter(k => k !== key));
      toast('已恢复「' + (AI_PRESETS[key] && AI_PRESETS[key].label || key) + '」');
      // 恢复后若当前选中的是 share 且 share 刚恢复，保持选中；否则不改动选中态
      renderAiPresetRow();
    });
  });
}

async function openAiLayoutModal(initialPreset = 'wash') {
  if (!currentDoc) { toast('请先打开一篇文档'); return; }
  openAiModal('AI 排版',
    '<div class="ai-modal-panel" id="aiLayoutPanel">' +
      '<div class="ai-note">默认已选「洗排版（不改字）」：整理整篇结构与重点，但不删字、不改写。点任意预设可查看提示词。</div>' +
      '<div class="ai-warning" id="aiStatusNote"></div>' +
      '<div class="ai-preset-row" id="aiPresetRow"></div>' +
      '<div class="ai-preset-tip" id="aiPresetTip" hidden>' +
        '<div class="ai-preset-tip-text" id="aiPresetTipText"></div>' +
        '<div class="ai-preset-tip-hint" id="aiPresetTipHint">点击展开完整提示词</div>' +
        '<div class="ai-preset-tip-actions">' +
          '<button class="ai-preset-tip-btn" id="aiPresetTipCopy">复制提示词</button>' +
          '<button class="ai-preset-tip-btn danger" id="aiPresetTipHide" hidden>隐藏此预设</button>' +
        '</div>' +
      '</div>' +
      '<div class="ai-preset-hidden-row" id="aiPresetHiddenRow" hidden></div>' +
      '<div class="ai-warning" id="aiLayoutWarning" hidden></div>' +
      '<div class="ai-preview empty" id="aiLayoutPreview">点击生成后在这里预览</div>' +
      '<div class="ai-actions">' +
        '<button class="ai-action" id="aiLayoutRun" disabled>生成预览</button>' +
        '<button class="ai-action primary" id="aiLayoutApply" disabled>应用到文档</button>' +
      '</div>' +
    '</div>');
  aiLayoutCurrentPreset = AI_PRESETS[initialPreset] ? initialPreset : 'wash';
  aiLayoutCurrentCustomPrompt = '';
  renderAiPresetRow();
  showAiPresetTip(AI_PRESETS[aiLayoutCurrentPreset].prompt, aiLayoutCurrentPreset);
  $('aiLayoutRun').addEventListener('click', () => runAiLayout(aiLayoutCurrentPreset, aiLayoutCurrentCustomPrompt));
  refreshAiStatus('aiLayoutRun');
  $('aiLayoutApply').addEventListener('click', applyAiLayoutResult);
  // 提示词预览：点击展开/收起
  const tip = $('aiPresetTip');
  if (tip) tip.addEventListener('click', (e) => {
    if (e.target.closest('.ai-preset-tip-btn')) return; // 点操作按钮不触发展开
    tip.classList.toggle('expanded');
    const hint = $('aiPresetTipHint');
    if (hint) hint.textContent = tip.classList.contains('expanded') ? '点击收起' : '点击展开完整提示词';
  });
  const copyBtn = $('aiPresetTipCopy');
  if (copyBtn) copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const textEl = $('aiPresetTipText');
    copyText(textEl ? textEl.textContent : '').then(() => toast('提示词已复制'));
  });
  const hideBtn = $('aiPresetTipHide');
  if (hideBtn) hideBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const key = hideBtn.getAttribute('data-key');
    if (!key) return;
    const hidden = getHiddenBuiltin();
    if (!hidden.includes(key)) { hidden.push(key); setHiddenBuiltin(hidden); }
    toast('已隐藏「' + (AI_PRESETS[key] && AI_PRESETS[key].label || key) + '」');
    // 隐藏当前选中预设后回退到 share
    if (aiLayoutCurrentPreset === key) {
      aiLayoutCurrentPreset = 'share';
      aiLayoutCurrentCustomPrompt = '';
    }
    renderAiPresetRow();
    hideAiPresetTip();
  });
  // 拉取当前用户的自定义预设（失败静默，仍可用内置预设）
  await refreshAiCustomPresets();
}

// 拉取自定义预设并重渲染按钮行（渲染统一交给 renderAiPresetRow）
async function refreshAiCustomPresets() {
  try {
    aiCustomPresets = await api('/api/ai/presets', 'GET');
  } catch (e) {
    aiCustomPresets = [];
  }
  if (!Array.isArray(aiCustomPresets)) aiCustomPresets = [];
  renderAiPresetRow();
}

async function createCustomPreset() {
  const label = await showPrompt({ title: '新建预设', desc: '请输入预设名称（显示在按钮上）', placeholder: '如：精简排版', confirmText: '下一步' });
  if (!label || !label.trim()) return;
  const prompt = await showPrompt({ title: '新建预设', desc: '请输入提示词，描述你希望 AI 如何排版（最多 3000 字，Ctrl+Enter 提交）', placeholder: '如：去除所有底色和格式，段落两端对齐…', confirmText: '创建', multiline: true, maxlength: 3000 });
  if (prompt === null) return;
  try {
    await api('/api/ai/presets', 'POST', { label: label.trim(), prompt: prompt.trim() });
    toast('预设已创建');
    await refreshAiCustomPresets();
  } catch (e) {
    toast('创建失败：' + (e.message || e));
  }
}

async function editCustomPreset(idx) {
  const p = aiCustomPresets[idx];
  if (!p) return;
  const label = await showPrompt({ title: '编辑预设', desc: '预设名称', value: p.label, confirmText: '下一步' });
  if (label === null) return;
  if (!label || !label.trim()) { toast('名称不能为空'); return; }
  const prompt = await showPrompt({ title: '编辑预设', desc: '提示词（最多 3000 字，Ctrl+Enter 提交）', value: p.prompt, confirmText: '保存', multiline: true, maxlength: 3000 });
  if (prompt === null) return;
  try {
    await api('/api/ai/presets/' + p.id, 'PUT', { label: label.trim(), prompt: prompt.trim() });
    toast('预设已更新');
    await refreshAiCustomPresets();
  } catch (e) {
    toast('更新失败：' + (e.message || e));
  }
}

async function deleteCustomPreset(idx) {
  const p = aiCustomPresets[idx];
  if (!p) return;
  const ok = await showConfirm({ title: '删除预设', desc: '确定删除「' + p.label + '」？此操作不可撤销。', danger: true, confirmText: '删除' });
  if (!ok) return;
  try {
    await api('/api/ai/presets/' + p.id, 'DELETE');
    toast('已删除');
    // 若删除的正是当前选中的自定义预设，回退到 share 并收起提示词
    if (aiLayoutCurrentPreset === 'custom') {
      aiLayoutCurrentPreset = 'share';
      aiLayoutCurrentCustomPrompt = '';
      hideAiPresetTip();
    }
    await refreshAiCustomPresets();
  } catch (e) {
    toast('删除失败：' + (e.message || e));
  }
}

let _aiLayoutRunning = false; // AI 排版重入守卫，防止"停止"按钮触发新请求
async function runAiLayout(preset, customPrompt) {
  // 同 runAiRewrite：停止按钮和生成按钮共用 runBtn，重入守卫拦截双触发
  if (_aiLayoutRunning) return;
  _aiLayoutRunning = true;
  const runBtn = $('aiLayoutRun');
  const applyBtn = $('aiLayoutApply');
  const preview = $('aiLayoutPreview');
  const warning = $('aiLayoutWarning');
  applyBtn.disabled = true;
  warning.hidden = true;
  preview.classList.add('empty');
  preview.textContent = '正在排版，稍等一下…';
  // 创建 AbortController 支持用户取消（AI 排版最长 90s）
  const ac = new AbortController();
  const origText = runBtn.textContent;
  runBtn.textContent = '停止';
  const onStop = () => ac.abort();
  runBtn.addEventListener('click', onStop);
  try {
    const res = await api('/api/ai/layout', 'POST', { html: editor.getHTML(), preset, customPrompt: customPrompt || '', docId: currentDoc && currentDoc.id }, { signal: ac.signal });
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
    if (e && e.name === 'AbortError') {
      preview.textContent = '已取消';
    } else {
      preview.textContent = '生成失败：' + (e.message || e);
    }
  } finally {
    runBtn.removeEventListener('click', onStop);
    runBtn.textContent = origText;
    _aiLayoutRunning = false;
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
  if (!selectedText.trim()) { toast('请先选中要处理的文字'); return; }
  const transaction = captureAiRewriteTarget(selectedText);
  if (!transaction) { toast('选区已变化，请重新选中'); return; }
  pendingAiRewriteText = '';
  pendingAiRewrite = null;
  const presetHtml = '<button class="ai-preset ai-preset-layout" id="aiRewriteWholeLayout" type="button" title="整理整篇文章，不改字">整篇洗排版</button>' + AI_REWRITE_PRESETS.map((p, i) =>
    '<button class="ai-preset" data-rewrite-preset="' + i + '">' + p.label + '</button>'
  ).join('');
  openAiModal('AI 改选区',
    '<div class="ai-modal-panel" id="aiRewritePanel">' +
      '<div class="ai-note">这里默认只替换选中文字。要整理整篇文章且不改字，请点「整篇洗排版」。</div>' +
      '<div class="ai-preset-row">' + presetHtml + '</div>' +
      '<div class="ai-warning" id="aiStatusNote"></div>' +
      '<div class="ai-field"><label>指令</label><textarea class="ai-input" id="aiRewriteInstruction" placeholder="输入对选中文字的处理要求，或点上方预设套用参考指令"></textarea></div>' +
      '<div class="ai-preview empty" id="aiRewritePreview">先生成建议，确认后才会替换选区</div>' +
      '<div class="ai-actions">' +
        '<button class="ai-action" id="aiRewriteRun" disabled>生成预览</button>' +
        '<button class="ai-action" id="aiRewriteApply" disabled>应用改写</button>' +
      '</div>' +
    '</div>');
  const input = $('aiRewriteInstruction');
  const runBtn = $('aiRewriteRun');
  const applyBtn = $('aiRewriteApply');
  let aiReady = false;
  input.value = '';
  input.focus();
  const updateRunBtn = () => { runBtn.disabled = !(aiReady && input.value.trim().length > 0); };
  input.addEventListener('input', updateRunBtn);
  const wholeLayoutBtn = $('aiRewriteWholeLayout');
  if (wholeLayoutBtn) wholeLayoutBtn.addEventListener('click', () => openAiLayoutModal('wash'));
  aiModalBody.querySelectorAll('[data-rewrite-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = AI_REWRITE_PRESETS[Number(btn.getAttribute('data-rewrite-preset'))].value;
      input.focus();
      updateRunBtn();
    });
  });
  runBtn.addEventListener('click', () => runAiRewrite(transaction));
  applyBtn.addEventListener('click', applyAiRewriteResult);
  runBtn.disabled = true;
  refreshAiStatus('aiRewriteRun').then(ok => { aiReady = ok; updateRunBtn(); });
}

let pendingAiRewrite = null;
let _aiRewriteRunning = false; // 防止“停止”按钮在中止旧请求时又触发新请求
async function runAiRewrite(transaction) {
  if (_aiRewriteRunning) return;
  _aiRewriteRunning = true;
  const runBtn = $('aiRewriteRun');
  const applyBtn = $('aiRewriteApply');
  const preview = $('aiRewritePreview');
  const instructionEl = $('aiRewriteInstruction');
  if (!runBtn || !applyBtn || !preview || !instructionEl) { _aiRewriteRunning = false; return; }
  const instruction = instructionEl.value.trim();
  if (!instruction) { toast('请输入指令'); _aiRewriteRunning = false; return; }
  pendingAiRewriteText = '';
  pendingAiRewrite = null;
  const oldNote = $('aiRewriteChangedNote');
  if (oldNote) oldNote.remove();
  preview.classList.add('empty');
  preview.textContent = '正在处理，稍等一下...';
  applyBtn.disabled = true;
  applyBtn.classList.remove('primary');
  const ac = new AbortController();
  const origText = runBtn.textContent;
  runBtn.textContent = '停止';
  const onStop = () => ac.abort();
  runBtn.addEventListener('click', onStop);
  try {
    const res = await api('/api/ai/rewrite-selection', 'POST', {
      selectedText: transaction.selectedText,
      instruction,
      contextText: transaction.contextText,
      docId: transaction.docId
    }, { signal: ac.signal });
    transaction.replacement = res.replacement || '';
    if (!transaction.replacement) { throw new Error('AI 未返回内容'); }
    // 切换文档或关闭弹窗时，旧请求的结果只能作废，绝不能落到新文档。
    if (!currentDoc || currentDoc.id !== transaction.docId || !aiModal || aiModal.hidden) return;
    const targetStillCurrent = aiRewriteTargetIsCurrent(transaction);
    const changedWhileWaiting = editorContentVersion !== transaction.editorVersion;
    preview.classList.remove('empty');
    if (!targetStillCurrent) {
      preview.classList.add('empty');
      preview.textContent = '等待期间原选区已改动，建议不会覆盖新内容；请重新生成。';
      return;
    }
    pendingAiRewriteText = transaction.replacement;
    pendingAiRewrite = transaction;
    preview.innerHTML = textToEditorHtml(transaction.replacement);
    if (changedWhileWaiting) {
      preview.insertAdjacentHTML('afterend', '<div class="ai-note" id="aiRewriteChangedNote">等待期间你继续编辑了文档；建议尚未应用。确认后只会替换原选区。</div>');
    }
    applyBtn.classList.add('primary');
    applyBtn.disabled = false;
  } catch (e) {
    if (!preview.isConnected) return;
    preview.classList.add('empty');
    if (e && e.name === 'AbortError') preview.textContent = '已取消';
    else preview.textContent = '生成失败：' + (e.message || e);
    pendingAiRewriteText = '';
    pendingAiRewrite = null;
  } finally {
    runBtn.removeEventListener('click', onStop);
    runBtn.textContent = origText;
    _aiRewriteRunning = false;
  }
}

function applyAiRewriteResult() {
  if (!pendingAiRewrite) { toast('请先生成改写建议'); return; }
  if (!applyAiRewriteTransaction(pendingAiRewrite)) return;
  hideFloatMenu();
  closeAiModal();
  toast('AI 已替换选区；可按 Ctrl/⌘ + Z 撤销');
}

function openAiRewriteSuggestionModal(transaction, changedWhileWaiting) {
  const canApply = aiRewriteTargetIsCurrent(transaction);
  const note = canApply
    ? (changedWhileWaiting ? '等待期间你继续编辑了文档。建议尚未自动应用；确认后只替换最初的选区。' : '这是 AI 生成的改写建议，确认后才会替换选区。')
    : '等待期间原选区已改动。为保护你新写的内容，这条建议不能直接应用，请重新生成。';
  pendingAiRewriteText = transaction.replacement;
  pendingAiRewrite = canApply ? transaction : null;
  openAiModal('AI 改写建议',
    '<div class="ai-modal-panel">' +
      '<div class="ai-note">' + note + '</div>' +
      '<div class="ai-preview">' + textToEditorHtml(transaction.replacement) + '</div>' +
      '<div class="ai-actions"><button class="ai-action primary" id="aiRewriteSuggestionApply"' + (canApply ? '' : ' disabled') + '>应用改写</button></div>' +
    '</div>');
  const applyBtn = $('aiRewriteSuggestionApply');
  if (applyBtn) applyBtn.addEventListener('click', applyAiRewriteResult);
}

/* ---------- 快速 AI：浮动菜单内嵌输入框，回车直接改写选区 ---------- */
const fmAiQuick = $('fmAiQuick');
const fmAiSubmit = $('fmAiSubmit');
const fmAiPreview = $('fmAiPreview');
let aiAbortController = null;

// 提交按钮状态切换
function setAiSubmitLoading(loading) {
  if (!fmAiSubmit) return;
  fmAiSubmit.classList.toggle('loading', !!loading);
  fmAiSubmit.title = loading ? '停止' : '提交（回车）';
  fmAiSubmit.setAttribute('aria-label', loading ? '停止' : '提交');
  const icon = fmAiSubmit.querySelector('.fm-ai-submit-icon');
  if (!icon) return;
  icon.setAttribute('fill', loading ? 'currentColor' : 'none');
  icon.setAttribute('stroke', loading ? 'none' : 'currentColor');
  icon.innerHTML = loading
    ? '<rect x="6" y="6" width="12" height="12" rx="2"/>'
    : '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>';
}

if (fmAiQuick) {
  // 关键修复：preventDefault 阻止默认 focus 切换，但显式调用 focus() 仍会改全局选区。
  // 所以在 focus 前先 saveAiSelection（已由 selectionchange 持续保存），
  // 同时启用 CSS Custom Highlight 让选区视觉上保持高亮。
  fmAiQuick.addEventListener('mousedown', (e) => {
    saveAiSelection(); // 在 focus 改变选区前再保存一次（兜底）
    e.preventDefault();
    e.stopPropagation();
    fmAiQuick.focus();
    // 启用 AI 选区视觉保持高亮
    setAiSelectionHighlight(savedAiRange);
  });
  // 记录输入内容 + 时间戳，用于 1 分钟内恢复
  fmAiQuick.addEventListener('input', () => {
    fmAiQuickLastInput = fmAiQuick.value;
    fmAiQuickLastTime = Date.now();
    // 任务 6：检测溢出，超出输入框长度时下方显示全文
    updateAiPreview();
  });
  // input 失焦：清除 AI 选区高亮
  fmAiQuick.addEventListener('blur', () => {
    clearAiSelectionHighlight();
  });
  fmAiQuick.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runQuickAi();
    } else if (e.key === 'Escape') {
      fmAiQuick.value = '';
      fmAiQuickLastInput = '';
      fmAiQuickLastTime = 0;
      clearAiSelectionHighlight();
      hideAiPreview();
      fmAiQuick.blur();
      hideFloatMenu();
    }
  });
}

// 提交/停止按钮：mousedown 阻止 input 失焦，click 触发提交或停止
if (fmAiSubmit) {
  fmAiSubmit.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  fmAiSubmit.addEventListener('click', () => {
    if (aiAbortController) {
      // 当前在 loading，点击即停止
      aiAbortController.abort();
      return;
    }
    runQuickAi();
  });
}

// 任务 6：输入框溢出时下方显示全文
function updateAiPreview() {
  if (!fmAiPreview || !fmAiQuick) return;
  const value = fmAiQuick.value;
  if (!value) { hideAiPreview(); return; }
  // 检测是否溢出：临时 clone 测量，或直接看 scrollWidth
  const overflowed = fmAiQuick.scrollWidth > fmAiQuick.clientWidth + 1;
  if (overflowed) {
    fmAiPreview.textContent = value;
    fmAiPreview.hidden = false;
  } else {
    hideAiPreview();
  }
}
function hideAiPreview() {
  if (fmAiPreview) { fmAiPreview.hidden = true; fmAiPreview.textContent = ''; }
}

async function runQuickAi() {
  const instruction = fmAiQuick.value.trim();
  if (!instruction) { toast('请输入指令'); fmAiQuick.focus(); return; }
  // 焦点已移到 input 内时 saveAiSelection 会返回空，回退到之前保存的编辑器选区。
  let selectedText = saveAiSelection();
  if (!selectedText && savedAiRange) selectedText = savedAiRange.toString();
  if (!selectedText) { toast('请先选中要改写的文字'); return; }
  const transaction = captureAiRewriteTarget(selectedText);
  if (!transaction) { toast('选区已变化，请重新选中'); return; }

  aiAbortController = new AbortController();
  setAiSubmitLoading(true);
  fmAiQuick.placeholder = 'AI 思考中…';
  fmAiQuick.disabled = true;
  try {
    const res = await api('/api/ai/rewrite-selection', 'POST', {
      selectedText: transaction.selectedText,
      instruction,
      contextText: transaction.contextText,
      docId: transaction.docId
    }, { signal: aiAbortController.signal });
    transaction.replacement = res && res.replacement || '';
    if (!transaction.replacement) { toast('AI 未返回内容'); return; }
    if (!currentDoc || currentDoc.id !== transaction.docId) return;

    const changedWhileWaiting = editorContentVersion !== transaction.editorVersion;
    const targetStillCurrent = aiRewriteTargetIsCurrent(transaction);
    // 快速改写在用户没有继续编辑时保持“一键完成”；只要期间有编辑，
    // 就退化成可确认的建议，不能让迟到的网络响应突然改正文。
    if (changedWhileWaiting || !targetStillCurrent) {
      fmAiQuick.value = '';
      fmAiQuickLastInput = '';
      fmAiQuickLastTime = 0;
      hideAiPreview();
      hideFloatMenu();
      clearAiSelectionHighlight();
      openAiRewriteSuggestionModal(transaction, changedWhileWaiting);
      toast(targetStillCurrent ? 'AI 建议已生成，请确认后应用' : '原选区已改动，AI 建议未自动应用');
      return;
    }
    if (!applyAiRewriteTransaction(transaction)) return;
    fmAiQuick.value = '';
    fmAiQuickLastInput = '';
    fmAiQuickLastTime = 0;
    hideAiPreview();
    hideFloatMenu();
    clearAiSelectionHighlight();
    toast('已改写 可按 Ctrl/⌘ + Z 撤销');
  } catch (e) {
    if (e && e.name === 'AbortError') toast('已停止');
    else toast('AI 失败：' + (e.message || e));
  } finally {
    aiAbortController = null;
    setAiSubmitLoading(false);
    fmAiQuick.disabled = false;
    fmAiQuick.placeholder = '改写成...';
  }
}

/* 悬浮撤销气泡：与 Ctrl/⌘ + Z 使用同一条浏览器原生撤销链 */
let aiUndoBubble = null;
let aiUndoTimer = null;
function showAiUndoBubble() {
  hideAiUndoBubble();
  aiUndoBubble = document.createElement('div');
  aiUndoBubble.className = 'ai-undo-bubble';
  aiUndoBubble.innerHTML =
    '<span class="ai-undo-text">已用 AI 改写</span>' +
    '<button type="button" class="ai-undo-btn" title="撤销本次 AI 改写">撤销</button>';
  document.body.appendChild(aiUndoBubble);
  const er = editorEl.getBoundingClientRect();
  const bw = aiUndoBubble.offsetWidth;
  aiUndoBubble.style.left = (er.left + er.width / 2 - bw / 2) + 'px';
  aiUndoBubble.style.top = (er.top + 14) + 'px';
  aiUndoBubble.querySelector('.ai-undo-btn').addEventListener('click', () => {
    // 绝不根据“当前光标”手工插回原文。直接撤销原生 insertHTML 事务，
    // 才会准确把改写结果替换回原样，并保留正确的 redo 顺序。
    if (editor.undo()) toast('已撤销 AI 改写');
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
    ['Ctrl/\u2318 + Alt + I', '\u9009\u533a AI \u6539\u5199/\u6392\u7248'],
    ['Ctrl/\u2318 + Alt + G', 'AI \u62df\u6807\u9898'],
    ['Ctrl/\u2318 + J', 'AI \u5bf9\u8bdd\u9762\u677f']
  ]],
  ['文档', [
    ['Ctrl/⌘ + N', '新建文章'],
    ['Ctrl/⌘ + S', '保存当前文章'],
    ['Ctrl/⌘ + F', '搜索文章'],
    ['Ctrl/⌘ + /', '打开快捷键面板'],
    ['Ctrl/⌘ + Shift + O', '打开章节'],
    ['Ctrl/⌘ + Alt + R', '切换阅读模式']
  ]],
  ['文字', [
    ['Ctrl/⌘ + B', '加粗'],
    ['Ctrl/⌘ + I', '斜体'],
    ['Ctrl/⌘ + U', '下划线'],
    ['Ctrl/⌘ + Shift + X', '删除线'],
    ['Ctrl/⌘ + K', '插入链接'],
    ['Ctrl/⌘ + \\', '清除格式'],
    ['Ctrl/⌘ + Shift + P', '格式刷']
  ]],
  ['段落', [
    ['Ctrl/⌘ + A', '选中当前段落（再按一次选全文）'],
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
    ['Ctrl/⌘ + Alt + D', '导出 Markdown'],
    ['Ctrl/⌘ + Shift + W', '导出 Word']
  ]]
];

function buildShortcutHelp() {
  const el = document.createElement('div');
  el.className = 'shortcut-overlay';
  el.hidden = true;
  el.innerHTML = '<div class="shortcut-panel" role="dialog" aria-modal="true" aria-label="快捷键">' +
    '<div class="shortcut-head"><strong>快捷键</strong><button class="shortcut-close" type="button" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>' +
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
let lastCtrlATime = 0; // 飞书式 Ctrl+A 两段选：记录上次按 Ctrl+A 的时间
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    if (versionHistoryModal && !versionHistoryModal.hidden) { closeVersionHistory(); return; }
    hideShortcutHelp();
    if (!responsiveOutline.hidden) { closeResponsiveOutline(); return; }
    if (aiModal && !aiModal.hidden) { closeAiModal(); return; }
    if (aiPanel && !aiPanel.hidden) { closeAiPanel(); return; }
  }
  if (!ctrl) return;
  if (isNativeField(e.target) && e.target !== docTitleEl && e.target !== searchInput) return;
  const k = e.key.toLowerCase();
  if (k === '/') { e.preventDefault(); showShortcutHelp(); }
  else if (k === 'a' && !e.altKey && !e.shiftKey) {
    // 飞书式 Ctrl+A：编辑器内按一次选当前段落，500ms 内再按选全文；非编辑器聚焦时不拦截
    if (document.activeElement === editorEl) {
      const now = Date.now();
      if (now - lastCtrlATime < 500) {
        lastCtrlATime = 0; // 第二次：放行浏览器原生全选
      } else {
        lastCtrlATime = now;
        const block = editor._currentBlock();
        if (block) {
          e.preventDefault();
          editor.selectBlock(block);
          toast('连续按两次 Ctrl+A 选择全文');
        }
        // 无当前块时不拦截，放行浏览器原生全选
      }
    }
  }
  else if (k === 'a' && e.altKey) { e.preventDefault(); openAiLayoutModal(); }
  else if (k === 'i' && e.altKey) { e.preventDefault(); openAiRewriteModal(); }
  else if (k === 'g' && e.altKey) { e.preventDefault(); requestManualTitleSuggestion(); }
  else if (k === 's' && !e.altKey) { e.preventDefault(); if (saveTimer) clearTimeout(saveTimer); saveCurrent(); }
  else if (k === 'n' && !e.shiftKey) { e.preventDefault(); newDoc(); }
  else if (k === 'f' && !e.shiftKey) {
    // Ctrl+F 只在焦点已位于全局搜索框时重新聚焦它；
    // 其余情况放行浏览器原生查找，让它在当前文档正文内全文查找，
    // 而不是跳到全局搜索框去搜所有文档。
    if (document.activeElement === searchInput) { e.preventDefault(); searchInput.select(); }
  }
  else if (k === 'o' && e.shiftKey && !e.altKey) { e.preventDefault(); openResponsiveOutline(); }
  else if (k === 'r' && e.altKey) { e.preventDefault(); toggleReadingMode(); }
  else if (k === 'h' && e.shiftKey && !e.altKey) { e.preventDefault(); exportHTML(); }
  else if (k === 'd' && e.altKey && !e.shiftKey) { e.preventDefault(); exportMarkdown(); }
  else if (k === 'w' && e.shiftKey && !e.altKey) { e.preventDefault(); exportWord(); }
  else if (k === 'p' && e.shiftKey && !e.altKey) { e.preventDefault(); activatePaintFormat(); }
  else if (k === 'j' && !e.altKey && !e.shiftKey) { e.preventDefault(); toggleAiPanel(); }
});

// 离开页面前用 keepalive fetch 发送未保存内容
// 浏览器不会等 async fetch 完成，普通 saveCurrent() 在 beforeunload 里大概率丢失；
// keepalive 标志允许请求在页面卸载后继续发送（类似 sendBeacon 但支持完整 fetch API）
function beaconSave() {
  if (!currentDoc || currentDoc._pending || switching) return;
  if (!saveTimer) return; // 没有待保存的内容
  clearTimeout(saveTimer); saveTimer = null;
  const title = (docTitleEl.value.trim() || '无标题').slice(0, TITLE_MAX);
  stripAiFlashMarks(editorEl);
  const content = editor.getHTML();
  try {
    fetch('/api/documents/' + currentDoc.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify({ title, content })
    }).catch(() => {});
  } catch(_) {}
}

// 离开前保存
window.addEventListener('beforeunload', () => {
  if (currentDoc && saveTimer) beaconSave();
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
    syncManualTitleButton();
    if (currentUser && currentUser.isAdmin) {
      // Enhancement only: document listing and opening never wait for this read.
      api('/api/admin/auto-title-settings').then(setting => {
        autoTitleEnabled = !!setting.enabled;
        scheduleAutoTitleForCurrentDoc();
      }).catch(() => { autoTitleEnabled = false; });
    }
    updateUserBadge();
    bindAvatarUpload();
    updateShareButton();
    updateMobileChrome();
    // 鉴权通过，显示正文（移除 pre-auth 隐藏类）
    document.body.classList.remove('pre-auth');

    const routedDocumentId = getRoutedDocumentId();
    if (routedDocumentId) {
      loadSidebar();
      const opened = await openDoc(routedDocumentId, { historyMode: 'none' });
      if (opened) return;
      clearDocumentRoute({ replace: true });
    }
    const docs = await api('/api/documents');
    if (isMobile()) {
      await loadSidebar();
      void loadSharedDocuments();
    } else if (docs.length) {
      await loadSidebar();
      showDashboard();
    } else {
      let received = [];
      try { received = await api('/api/shared-with-me?limit=1'); } catch (_) {}
      if (Array.isArray(received) && received.length) {
        await loadSidebar();
        showDashboard();
      } else {
        const res = await api('/api/documents', 'POST', {
          title: '\u6b22\u8fce\u4f7f\u7528 \u77e5\u8457 PenMark',
          content: welcomeContent()
        });
        await loadSidebar();
        await openDoc(res.id);
      }
    }
  } catch (e) {
    if (e.message === 'need login') return;
    toast('初始化失败：' + (e.message || e));
    editor.clear();
  }
}

/* ---------- 桌面端主页仪表盘 ---------- */
const dashboardEl = $('dashboard');

function showDashboard() {
  if (!dashboardEl) return;
  renderDashboard();
  dashboardEl.hidden = false;
  document.body.classList.add('dashboard-active');
  updateDocumentTitle('主页');
}

function hideDashboard() {
  if (!dashboardEl) return;
  dashboardEl.hidden = true;
  document.body.classList.remove('dashboard-active');
}

// 渲染仪表盘内容（统计 + 最近文档）
let dashboardRenderRun = 0;
async function renderDashboard() {
  const renderRun = ++dashboardRenderRun;
  const dashUserName = $('dashUserName');
  if (dashUserName && currentUser) {
    dashUserName.textContent = currentUser.nickname || currentUser.username || '\u670b\u53cb';
  }
  const [docsResult, sharedResult] = await Promise.allSettled([
    api('/api/documents?preview=1'),
    api('/api/shared-with-me')
  ]);
  if (renderRun !== dashboardRenderRun) return;
  const docs = docsResult.status === 'fulfilled' && Array.isArray(docsResult.value) ? docsResult.value : [];
  const sharedDocs = sharedResult.status === 'fulfilled' && Array.isArray(sharedResult.value) ? sharedResult.value : [];

  const total = docs.length;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const weekUpdated = docs.filter(d => (d.updated_at || 0) > weekAgo).length;
  let totalWords = 0;
  docs.forEach(d => { totalWords += Number(d.content_length || 0); });
  $('statTotal').textContent = total;
  $('statWeek').textContent = weekUpdated;
  $('statWords').textContent = totalWords > 9999 ? (totalWords / 10000).toFixed(1) + '\u4e07' : totalWords;

  renderDashboardSharedDocs(sharedDocs);
  const dashDocs = $('dashDocs');
  if (!dashDocs) return;
  const recent = docs.slice().sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, 6);
  if (!recent.length) {
    dashDocs.innerHTML = '<div class="dash-empty">&#36824;&#27809;&#26377;&#25991;&#26723;&#65292;&#28857;&#20987;&#21491;&#19978;&#35282;&#8220;&#26032;&#24314;&#25991;&#26723;&#8221;&#24320;&#22987;</div>';
    return;
  }
  dashDocs.innerHTML = recent.map(d => {
    const snippet = String(d.snippet || '').trim().slice(0, 80) || '\u7a7a\u6587\u6863';
    const dateStr = formatDateShort(new Date(d.updated_at || Date.now()));
    return '<button class="dash-doc" data-id="' + d.id + '">' +
      '<div class="dash-doc-title">' + escapeHtml(d.title || '\u65e0\u6807\u9898') + '</div>' +
      '<div class="dash-doc-snippet">' + escapeHtml(snippet) + '</div>' +
      '<div class="dash-doc-meta">' + dateStr + '</div>' +
    '</button>';
  }).join('');
  dashDocs.querySelectorAll('.dash-doc').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-id'));
      if (id) openDoc(id);
    });
  });
}

function renderDashboardSharedDocs(docs) {
  const section = $('dashSharedSection');
  const list = $('dashSharedDocs');
  if (!section || !list) return;
  if (!docs.length) {
    section.hidden = true;
    list.innerHTML = '';
    return;
  }
  section.hidden = false;
  list.innerHTML = docs.map(doc => {
    const permission = doc.permission === 'edit' ? '\u53ef\u7f16\u8f91' : '\u53ea\u8bfb';
    const owner = escapeHtml(String(doc.owner_nickname || '\u67d0\u4f4d\u7528\u6237'));
    const title = escapeHtml(String(doc.title || '\u65e0\u6807\u9898'));
    const token = escapeHtml(String(doc.token || ''));
    const date = formatDateShort(new Date(doc.updated_at || doc.last_opened_at || Date.now()));
    return '<button class="dash-doc dash-shared-doc" data-share-token="' + token + '">' +
      '<div class="dash-doc-title">' + title + '</div>' +
      '<div class="dash-shared-meta"><span>' + owner + '</span><span class="dash-shared-permission">' + permission + '</span><span>' + date + '</span></div>' +
    '</button>';
  }).join('');
  list.querySelectorAll('[data-share-token]').forEach(btn => {
    btn.addEventListener('click', () => {
      const token = btn.getAttribute('data-share-token');
      if (token) window.location.assign('/s/' + encodeURIComponent(token));
    });
  });
}
function formatDateShort(d) {
  const now = new Date();
  const diff = now - d;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

// 仪表盘按钮
const dashNewBtn = $('dashNewBtn');
if (dashNewBtn) dashNewBtn.addEventListener('click', () => { newDoc(); });

// 点击左上角品牌 logo：返回仪表盘（仅桌面端，且当前在编辑文档时）
const brandLockup = document.querySelector('.brand-lockup');
if (brandLockup) {
  brandLockup.style.cursor = 'pointer';
  brandLockup.title = '返回主页';
  brandLockup.addEventListener('click', async () => {
    if (isMobile() || !currentDoc) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { await saveCurrent({ reorder: false }); } catch (e) { /* 保存失败仍允许返回 */ }
    currentDoc = null;
    setDocTitle('');
    editor.clear();
    if (saveStateEl) saveStateEl.textContent = '';
    hideVersionBanner();
    stopVersionPolling();
  stopShareStatsPolling();
    clearDocumentRoute({ replace: true });
    showDashboard();
  });
}

window.addEventListener('popstate', () => {
  const routedDocumentId = getRoutedDocumentId();
  if (routedDocumentId) {
    openDoc(routedDocumentId, { historyMode: 'none' });
    return;
  }
  if (isMobile()) {
    mobileBack({ updateRoute: false });
    return;
  }
  if (!currentDoc) {
    showDashboard();
    return;
  }
  cancelAutoTitleWork();
  cancelManualTitleSuggestion();
  saveCurrentInBackground();
  currentDoc = null;
  setDocTitle('');
  editor.clear();
  if (saveStateEl) saveStateEl.textContent = '';
  hideVersionBanner();
  stopVersionPolling();
  stopShareStatsPolling();
  showDashboard();
});
function updateUserBadge() {
  const badge = $('userBadge');
  if (!badge || !currentUser) return;
  badge.querySelector('.user-name').textContent = currentUser.nickname || currentUser.username;
  badge.style.display = '';
  // 头像：优先用 avatar base64，否则用首字母 + 纯色背景
  const avatarEl = badge.querySelector('.user-avatar');
  if (avatarEl) {
    if (currentUser.avatar) {
      avatarEl.innerHTML = '<img src="' + currentUser.avatar + '" alt="">';
      avatarEl.style.background = '';
    } else {
      const initial = (currentUser.nickname || currentUser.username || '?').slice(0, 1).toUpperCase();
      avatarEl.innerHTML = escapeHtml(initial);
      avatarEl.style.background = pickAvatarColor(currentUser.username || currentUser.nickname || '');
    }
  }
  // 移动端"我的"标签固定显示"我的"，避免长用户名撑变形
  const meTab = document.getElementById('mbnMe');
  if (meTab) {
    const label = meTab.querySelector('span');
    if (label) label.textContent = '我的';
  }
}

// 根据用户名 hash 取一个柔和的纯色头像背景
const AVATAR_COLORS = ['#6f897a', '#8a6f89', '#89766f', '#6f7d89', '#89836f', '#73897f'];
function pickAvatarColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/* ---------- 头像裁剪弹窗（拖动选区 + 缩放） ---------- */
const avatarCropModal = $('avatarCropModal');
const avatarCropStage = $('avatarCropStage');
const avatarCropImage = $('avatarCropImage');
const avatarCropZoom = $('avatarCropZoom');
const avatarCropStatus = $('avatarCropStatus');
const avatarCropConfirm = $('avatarCropConfirm');
const avatarCropCancel = $('avatarCropCancel');
const avatarCropClose = $('avatarCropClose');
let avatarCrop = null;
const AVATAR_TARGET_BYTES = 180 * 1024;

function clampAvatarCrop() {
  const s = avatarCrop;
  if (!s || !s.frame) return;
  const maxX = Math.max(0, (s.image.naturalWidth * s.scale - s.frame) / 2);
  const maxY = Math.max(0, (s.image.naturalHeight * s.scale - s.frame) / 2);
  s.x = Math.max(-maxX, Math.min(maxX, s.x));
  s.y = Math.max(-maxY, Math.min(maxY, s.y));
}
function drawAvatarCrop() {
  const s = avatarCrop;
  if (!s) return;
  avatarCropImage.style.width = (s.image.naturalWidth * s.scale) + 'px';
  avatarCropImage.style.height = (s.image.naturalHeight * s.scale) + 'px';
  avatarCropImage.style.transform = 'translate(-50%,-50%) translate(' + s.x + 'px,' + s.y + 'px)';
}
function layoutAvatarCrop() {
  const s = avatarCrop;
  if (!s || !avatarCropStage.clientWidth) return;
  s.frame = avatarCropStage.clientWidth;
  s.minScale = Math.max(s.frame / s.image.naturalWidth, s.frame / s.image.naturalHeight);
  s.scale = s.minScale * s.zoom / 100;
  clampAvatarCrop();
  drawAvatarCrop();
}
function closeAvatarCropper(force) {
  const s = avatarCrop;
  if (!s || (s.saving && !force)) return;
  URL.revokeObjectURL(s.url);
  avatarCrop = null;
  avatarCropModal.hidden = true;
  avatarCropImage.removeAttribute('src');
  avatarCropZoom.value = '100';
  avatarCropConfirm.disabled = false;
  avatarCropConfirm.textContent = '保存头像';
}
async function encodeAvatarCrop() {
  const s = avatarCrop;
  if (!s) throw new Error('裁剪未就绪，无法编码');
  const crop = s.frame / s.scale;
  const sx = s.image.naturalWidth / 2 - s.x / s.scale - crop / 2;
  const sy = s.image.naturalHeight / 2 - s.y / s.scale - crop / 2;
  // 检测 webp 编码支持（iOS < 14 等环境 canvas 不支持 webp 编码，toDataURL 会回退为 png）
  const supportsWebp = (() => {
    try { return document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp'); }
    catch (_) { return false; }
  })();
  const types = supportsWebp ? ['image/webp', 'image/jpeg'] : ['image/jpeg'];
  // 兜底：若所有档位都超过目标，取体积最小的一档返回，绝不因体积拒绝用户
  let bestUrl = null;
  let bestBytes = Infinity;
  for (const outputSize of [512, 448, 384, 320, 256, 192, 160]) {
    const canvas = document.createElement('canvas');
    canvas.width = outputSize; canvas.height = outputSize;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, outputSize, outputSize);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s.image, sx, sy, crop, crop, 0, 0, outputSize, outputSize);
    for (const type of types) {
      for (const quality of [.92, .84, .76, .68, .6]) {
        // 用 canvas.toDataURL 直接生成标准 data URL，避免 toBlob 在部分浏览器
        // 返回空 blob.type 导致 FileReader.readAsDataURL 生成 data:;base64, 格式
        const dataUrl = canvas.toDataURL(type, quality);
        const m = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!m) continue;
        // base64 解码后字节数 = 字符数 × 3/4 - padding
        const b64 = m[2];
        const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
        const bytes = Math.floor(b64.length * 3 / 4) - padding;
        if (bytes <= AVATAR_TARGET_BYTES) return dataUrl;
        if (bytes < bestBytes) { bestBytes = bytes; bestUrl = dataUrl; }
      }
    }
  }
  // 所有档位都超目标：取最小档兜底（通常是 160px × .6，体积很小），不让用户上传失败
  if (bestUrl) return bestUrl;
  throw new Error('图片编码失败，请换一张图');
}
async function saveCroppedAvatar(avatar) {
  const resp = await fetch('/api/user/avatar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || '保存失败');
  }
  currentUser.avatar = (await resp.json()).avatar;
  updateUserBadge();
}
async function openAvatarCropper(file, onSaved) {
  if (!file) return;
  if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
  if (file.size > 8 * 1024 * 1024) { toast('图片过大，请小于 8MB 后重试'); return; }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = url;
    });
    if (Math.min(image.naturalWidth, image.naturalHeight) < 160) throw new Error('图片尺寸过小，最短边需大于 160 像素');
    if (avatarCrop) URL.revokeObjectURL(avatarCrop.url);
    avatarCrop = { image, url, onSaved, zoom: 100, minScale: 1, scale: 1, frame: 0, x: 0, y: 0, saving: false };
    avatarCropImage.src = url;
    avatarCropZoom.value = '100';
    avatarCropStatus.textContent = '建议选择正方形区域，输出为 512×512 像素头像';
    avatarCropModal.hidden = false;
    requestAnimationFrame(() => { layoutAvatarCrop(); avatarCropStage.focus(); });
  } catch (e) {
    URL.revokeObjectURL(url);
    toast(e.message || '打开图片失败');
  }
}
function chooseUserAvatar(onSaved) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => openAvatarCropper(input.files && input.files[0], onSaved);
  input.click();
}
if (avatarCropStage) {
  let drag = null;
  avatarCropStage.addEventListener('pointerdown', (e) => {
    if (!avatarCrop || avatarCrop.saving) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, imageX: avatarCrop.x, imageY: avatarCrop.y };
    avatarCropStage.setPointerCapture(e.pointerId);
    avatarCropStage.classList.add('dragging');
    e.preventDefault();
  });
  avatarCropStage.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId || !avatarCrop) return;
    avatarCrop.x = drag.imageX + e.clientX - drag.x;
    avatarCrop.y = drag.imageY + e.clientY - drag.y;
    clampAvatarCrop(); drawAvatarCrop();
  });
  const endAvatarDrag = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    if (avatarCropStage.hasPointerCapture(e.pointerId)) avatarCropStage.releasePointerCapture(e.pointerId);
    drag = null; avatarCropStage.classList.remove('dragging');
  };
  avatarCropStage.addEventListener('pointerup', endAvatarDrag);
  avatarCropStage.addEventListener('pointercancel', endAvatarDrag);
}
if (avatarCropZoom) avatarCropZoom.addEventListener('input', () => {
  if (!avatarCrop || avatarCrop.saving) return;
  avatarCrop.zoom = Number(avatarCropZoom.value);
  avatarCrop.scale = avatarCrop.minScale * avatarCrop.zoom / 100;
  clampAvatarCrop(); drawAvatarCrop();
});
if (avatarCropClose) avatarCropClose.addEventListener('click', () => closeAvatarCropper());
if (avatarCropCancel) avatarCropCancel.addEventListener('click', () => closeAvatarCropper());
if (avatarCropModal) avatarCropModal.addEventListener('pointerdown', (e) => { if (e.target === avatarCropModal) closeAvatarCropper(); });
if (avatarCropConfirm) avatarCropConfirm.addEventListener('click', async () => {
  const s = avatarCrop;
  if (!s || s.saving) return;
  s.saving = true; avatarCropConfirm.disabled = true; avatarCropConfirm.textContent = '保存中';
  avatarCropStatus.textContent = '正在上传头像…';
  try {
    await saveCroppedAvatar(await encodeAvatarCrop());
    const onSaved = s.onSaved;
    closeAvatarCropper(true);
    if (onSaved) onSaved();
    toast('头像已更新');
  } catch (e) {
    if (avatarCrop) {
      avatarCrop.saving = false; avatarCropConfirm.disabled = false; avatarCropConfirm.textContent = '保存头像';
      avatarCropStatus.textContent = '建议选择正方形区域，输出为 512×512 像素头像';
    }
    toast(e.message || '保存失败');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && avatarCropModal && !avatarCropModal.hidden) closeAvatarCropper();
});
function bindAvatarUpload() {
  const badge = $('userBadge');
  if (!badge) return;
  const avatarEl = badge.querySelector('.user-avatar');
  if (avatarEl && !avatarEl.dataset.bound) {
    avatarEl.dataset.bound = '1';
    avatarEl.title = '点击更换头像';
    avatarEl.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => openAvatarCropper(input.files && input.files[0]);
      input.click();
    });
  }
}

/* ---------- 图片剪裁弹窗（自由选区，8 手柄调整） ----------
   关键修复：
   1. 用 fetch + blob + createObjectURL 加载图片，绕开 Canvas CORS 污染
   2. 剪裁前备份原 src 到 data-crop-original，失败时还原
   3. 选区覆盖在图片上（飞书式），4 角 + 4 边手柄
*/
const imageCropModal = $('imageCropModal');
const imageCropStage = $('imageCropStage');
const imageCropImage = $('imageCropImage');
const imageCropSelection = $('imageCropSelection');
const imageCropConfirm = $('imageCropConfirm');
const imageCropCancel = $('imageCropCancel');
const imageCropClose = $('imageCropClose');
let imageCropState = null; // { imgEl, container, image, blobUrl, sel, scale, naturalW, naturalH, displayW, displayH }

async function openImageCropper(container) {
  if (!container) return;
  const imgEl = container.querySelector('img') || (container.tagName === 'IMG' ? container : null);
  if (!imgEl) { toast('未找到图片'); return; }
  const src = imgEl.src;
  if (!src) { toast('图片源无效'); return; }
  imageCropConfirm.disabled = true;
  imageCropConfirm.textContent = '加载中...';
  try {
    // 用 fetch + blob 加载图片，绕开 Canvas CORS 污染
    // data URL 直接用，http(s)/相对路径走 fetch
    let blobUrl;
    if (/^data:image\//i.test(src)) {
      blobUrl = src;
    } else {
      const resp = await fetch(src, { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      blobUrl = URL.createObjectURL(blob);
    }
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = blobUrl;
    });
    imageCropState = {
      imgEl, container, image, blobUrl,
      naturalW: image.naturalWidth,
      naturalH: image.naturalHeight,
      sel: null
    };
    imageCropImage.src = blobUrl;
    imageCropModal.hidden = false;
    requestAnimationFrame(() => {
      layoutImageCrop();
      imageCropStage.focus();
      imageCropConfirm.disabled = false;
      imageCropConfirm.textContent = '确定剪裁';
    });
  } catch (e) {
    toast('图片加载失败：' + (e.message || e));
  }
}

function layoutImageCrop() {
  const s = imageCropState;
  if (!s || !imageCropStage.clientWidth) return;
  const stageMaxW = imageCropStage.clientWidth;
  const stageMaxH = window.innerHeight * 0.6;
  // 按比例缩放图片到 stage 内
  const ratio = Math.min(stageMaxW / s.naturalW, stageMaxH / s.naturalH, 1);
  const displayW = Math.round(s.naturalW * ratio);
  const displayH = Math.round(s.naturalH * ratio);
  s.displayW = displayW;
  s.displayH = displayH;
  s.scale = s.naturalW / displayW; // 显示像素 → 原图像素
  imageCropImage.style.width = displayW + 'px';
  imageCropImage.style.height = displayH + 'px';
  imageCropStage.style.width = displayW + 'px';
  imageCropStage.style.height = displayH + 'px';
  // 选区初始为图片中心 80% 区域
  const selW = displayW * 0.8;
  const selH = displayH * 0.8;
  const selX = (displayW - selW) / 2;
  const selY = (displayH - selH) / 2;
  s.sel = { x: selX, y: selY, w: selW, h: selH };
  drawImageCropSelection();
}

function drawImageCropSelection() {
  const s = imageCropState;
  if (!s || !s.sel) return;
  imageCropSelection.style.left = s.sel.x + 'px';
  imageCropSelection.style.top = s.sel.y + 'px';
  imageCropSelection.style.width = s.sel.w + 'px';
  imageCropSelection.style.height = s.sel.h + 'px';
}

function clampImageCropSel() {
  const s = imageCropState;
  if (!s || !s.sel) return;
  const stageW = s.displayW;
  const stageH = s.displayH;
  s.sel.w = Math.max(20, Math.min(s.sel.w, stageW));
  s.sel.h = Math.max(20, Math.min(s.sel.h, stageH));
  s.sel.x = Math.max(0, Math.min(s.sel.x, stageW - s.sel.w));
  s.sel.y = Math.max(0, Math.min(s.sel.y, stageH - s.sel.h));
}

if (imageCropSelection) {
  let drag = null; // { type: 'move'|'n'|'s'|'e'|'w'|'nw'|'ne'|'sw'|'se', startX, startY, sel }
  imageCropSelection.addEventListener('pointerdown', (e) => {
    const s = imageCropState;
    if (!s || !s.sel) return;
    const handle = e.target.closest('.image-crop-handle');
    const type = handle ? handle.getAttribute('data-handle') : 'move';
    drag = { type, startX: e.clientX, startY: e.clientY, sel: { ...s.sel } };
    imageCropSelection.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
  imageCropSelection.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const s = imageCropState;
    if (!s) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (drag.type === 'move') {
      s.sel.x = drag.sel.x + dx;
      s.sel.y = drag.sel.y + dy;
    } else {
      // 8 手柄调整大小
      let nx = drag.sel.x, ny = drag.sel.y, nw = drag.sel.w, nh = drag.sel.h;
      const minSize = 20;
      if (drag.type.includes('n')) { ny = drag.sel.y + dy; nh = drag.sel.h - dy; if (nh < minSize) { ny = drag.sel.y + drag.sel.h - minSize; nh = minSize; } }
      if (drag.type.includes('s')) { nh = drag.sel.h + dy; if (nh < minSize) nh = minSize; }
      if (drag.type.includes('w')) { nx = drag.sel.x + dx; nw = drag.sel.w - dx; if (nw < minSize) { nx = drag.sel.x + drag.sel.w - minSize; nw = minSize; } }
      if (drag.type.includes('e')) { nw = drag.sel.w + dx; if (nw < minSize) nw = minSize; }
      s.sel = { x: nx, y: ny, w: nw, h: nh };
    }
    clampImageCropSel();
    drawImageCropSelection();
  });
  const endImageCropDrag = (e) => {
    if (!drag) return;
    if (imageCropSelection.hasPointerCapture(e.pointerId)) imageCropSelection.releasePointerCapture(e.pointerId);
    drag = null;
  };
  imageCropSelection.addEventListener('pointerup', endImageCropDrag);
  imageCropSelection.addEventListener('pointercancel', endImageCropDrag);
}

function closeImageCropper() {
  const s = imageCropState;
  if (s && s.blobUrl && /^blob:/.test(s.blobUrl)) URL.revokeObjectURL(s.blobUrl);
  imageCropState = null;
  imageCropModal.hidden = true;
  imageCropImage.removeAttribute('src');
  imageCropImage.style.width = '';
  imageCropImage.style.height = '';
}

if (imageCropClose) imageCropClose.addEventListener('click', closeImageCropper);
if (imageCropCancel) imageCropCancel.addEventListener('click', closeImageCropper);
if (imageCropModal) imageCropModal.addEventListener('pointerdown', (e) => { if (e.target === imageCropModal) closeImageCropper(); });
if (imageCropConfirm) imageCropConfirm.addEventListener('click', () => {
  const s = imageCropState;
  if (!s || !s.sel) return;
  // 选区显示像素 → 原图像素
  const sx = s.sel.x * s.scale;
  const sy = s.sel.y * s.scale;
  const sw = s.sel.w * s.scale;
  const sh = s.sel.h * s.scale;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  try {
    ctx.drawImage(s.image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    // 备份原 src 便于撤回（首次剪裁时备份，多次剪裁不覆盖备份）
    if (!s.imgEl.getAttribute('data-crop-original')) {
      s.imgEl.setAttribute('data-crop-original', s.imgEl.src);
    }
    // 替换原图 src
    s.imgEl.src = dataUrl;
    // 触发保存
    if (typeof editor !== 'undefined' && editor._afterChange) editor._afterChange();
    closeImageCropper();
    toast('图片已剪裁');
  } catch (e) {
    toast('剪裁失败：' + (e.message || '图片可能存在跨域限制'));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && imageCropModal && !imageCropModal.hidden) closeImageCropper();
});
window.addEventListener('resize', () => {
  if (imageCropState) layoutImageCrop();
});

// 设置入口仅管理员可见；分享入口对管理员及被授权用户可见
function updateShareButton() {
  const shareBtn = $('shareBtn');
  if (shareBtn) shareBtn.style.display = (currentUser && (currentUser.isAdmin || currentUser.can_share)) ? '' : 'none';
  const settingsBtn = $('settingsBtn');
  if (settingsBtn) settingsBtn.style.display = (currentUser && currentUser.isAdmin) ? '' : 'none';
  // 移动端分享按钮和设置入口同步
  const mobileShareBtn = document.getElementById('mobileShareBtn');
  if (mobileShareBtn) {
    mobileShareBtn.hidden = !(currentUser && (currentUser.isAdmin || currentUser.can_share));
  }
  const mbnSettings = document.getElementById('mbnSettings');
  if (mbnSettings) mbnSettings.hidden = true;
}

// 初始化移动端 chrome（底部导航、迷你工具栏）
function updateMobileChrome() {
  // 迷你工具栏按钮：转发到既有 handleAction / editor.exec
  const mobileToolbar = document.getElementById('mobileToolbar');
  if (mobileToolbar && !mobileToolbar.dataset.bound) {
    // 移动端点工具栏按钮会让编辑器失焦，selection 可能丢失。
    // 在 mousedown 捕获阶段（焦点还没转移）先缓存光标 Range，供异步操作（如插入图片）使用。
    mobileToolbar.addEventListener('mousedown', () => {
      try {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
          const r = sel.getRangeAt(0);
          if (editorEl.contains(r.commonAncestorContainer)) _mobileSavedRange = r.cloneRange();
        }
      } catch (_) {}
    }, true);
    mobileToolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.mt-btn');
      if (!btn) return;
      const cmd = btn.getAttribute('data-cmd');
      const action = btn.getAttribute('data-action');
      if (cmd) { editor.exec(cmd); refreshToolbar(); }
      else if (action === 'share') { openShareModal(); }
      else if (action) {
        handleAction(action);
        // 编辑动作执行后立即关闭底部抽屉
        closeMobileSheet();
      }
    });
    mobileToolbar.dataset.bound = '1';
  }

  // "更多"按钮：打开底部抽屉
  const mobileMoreBtn = document.getElementById('mobileMoreBtn');
  if (mobileMoreBtn && !mobileMoreBtn.dataset.bound) {
    mobileMoreBtn.addEventListener('click', openMobileSheet);
    mobileMoreBtn.dataset.bound = '1';
  }
  const mobileDocMenuBtn = document.getElementById('mobileDocMenuBtn');
  if (mobileDocMenuBtn && !mobileDocMenuBtn.dataset.bound) {
    mobileDocMenuBtn.addEventListener('click', () => openMobileSheet('document'));
    mobileDocMenuBtn.dataset.bound = '1';
  }

  // 关闭抽屉
  const sheetOverlay = document.getElementById('sheetOverlay');
  const mobileSheetClose = document.getElementById('mobileSheetClose');
  if (sheetOverlay && !sheetOverlay.dataset.bound) {
    sheetOverlay.addEventListener('click', closeMobileSheet);
    sheetOverlay.dataset.bound = '1';
  }
  if (mobileSheetClose && !mobileSheetClose.dataset.bound) {
    mobileSheetClose.addEventListener('click', closeMobileSheet);
    mobileSheetClose.dataset.bound = '1';
  }

  // 移动端底部导航
  const mbnSearch = document.getElementById('mbnSearch');
  if (mbnSearch && !mbnSearch.dataset.bound) {
    mbnSearch.addEventListener('click', () => {
      const si = document.getElementById('searchInput');
      if (si) { si.focus(); si.scrollIntoView({ block: 'center' }); }
      setActiveMbn(mbnSearch);
    });
    mbnSearch.dataset.bound = '1';
  }
  const mbnNewDoc = document.getElementById('mbnNewDoc');
  if (mbnNewDoc && !mbnNewDoc.dataset.bound) {
    mbnNewDoc.addEventListener('click', () => { newDoc(); });
    mbnNewDoc.dataset.bound = '1';
  }
  const mbnTrash = document.getElementById('mbnTrash');
  if (mbnTrash && !mbnTrash.dataset.bound) {
    mbnTrash.addEventListener('click', () => { openTrash(); });
    mbnTrash.dataset.bound = '1';
  }
  const mbnMe = document.getElementById('mbnMe');
  if (mbnMe && !mbnMe.dataset.bound) {
    mbnMe.addEventListener('click', () => {
      openMobileSheet('me');
      setActiveMbn(mbnMe);
    });
    mbnMe.dataset.bound = '1';
  }
  const mbnDocs = document.getElementById('mbnDocs');
  if (mbnDocs && !mbnDocs.dataset.bound) {
    mbnDocs.addEventListener('click', () => {
      // 已经在主页
      setActiveMbn(mbnDocs);
      // 如果在编辑器视图，返回主页
      if (document.body.classList.contains('mobile-editor-active')) mobileBack();
    });
    mbnDocs.dataset.bound = '1';
  }

  // 移动端分享按钮
  const mobileShareBtn = document.getElementById('mobileShareBtn');
  if (mobileShareBtn && !mobileShareBtn.dataset.bound) {
    mobileShareBtn.addEventListener('click', () => { openShareModal(); });
    mobileShareBtn.dataset.bound = '1';
  }
}

function setActiveMbn(el) {
  document.querySelectorAll('.mbn-item').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
}

/* ---------- 移动端底部抽屉：折叠工具网格 / 我的菜单 ---------- */
function openMobileSheet(mode) {
  mode = mode || 'tools';
  const sheet = document.getElementById('mobileSheet');
  const overlay = document.getElementById('sheetOverlay');
  if (!sheet || !overlay) return;
  const titleEl = sheet.querySelector('.ms-title');
  if (titleEl) titleEl.textContent = mode === 'me' ? '我的' : (mode === 'document' ? '文档' : '更多工具');
  populateMobileSheet(mode);
  sheet.hidden = false;
  overlay.hidden = false;
  // 强制重排，启动过渡
  void sheet.offsetHeight;
  sheet.classList.add('show');
  overlay.classList.add('show');
  sheet.setAttribute('aria-hidden', 'false');
}

function closeMobileSheet() {
  const sheet = document.getElementById('mobileSheet');
  const overlay = document.getElementById('sheetOverlay');
  if (!sheet || !overlay) return;
  sheet.classList.remove('show');
  overlay.classList.remove('show');
  sheet.setAttribute('aria-hidden', 'true');
  // 等过渡完再隐藏
  setTimeout(() => {
    if (!sheet.classList.contains('show')) { sheet.hidden = true; overlay.hidden = true; }
  }, 250);
}

// 根据模式构建底部抽屉内容
function populateMobileSheet(mode) {
  const body = document.getElementById('msBody');
  if (!body) return;
  body.innerHTML = ''; // 每次都重建，确保内容与 mode 一致
  if (mode === 'me') { populateMeSheet(body); return; }
  if (mode === 'document') { populateDocumentSheet(body); return; }
  populateToolsSheet(body);
}

// "我的"菜单：用户信息卡 + 主题切换 + 退出登录
function populateMeSheet(body) {
  // 清空旧内容（上传头像后会重新调用本函数）
  while (body && body.firstChild) body.removeChild(body.firstChild);
  const name = (currentUser && (currentUser.nickname || currentUser.username)) || '未登录';
  const uname = (currentUser && currentUser.username) || '';
  const initial = (name || '?').slice(0, 1).toUpperCase();
  const isAdmin = currentUser && currentUser.isAdmin;

  const card = document.createElement('div');
  card.className = 'ms-me-card';
  const avatarHtml = (currentUser && currentUser.avatar)
    ? '<img src="' + currentUser.avatar + '" alt="">'
    : escapeHtml(initial);
  const avatarBg = (currentUser && currentUser.avatar) ? '' : (' style="background:' + pickAvatarColor(uname || name) + '"');
  card.innerHTML =
    '<div class="ms-me-avatar" title="点击更换头像"' + avatarBg + '>' + avatarHtml + '</div>' +
    '<div class="ms-me-info">' +
      '<div class="ms-me-name">' + escapeHtml(name) + (isAdmin ? ' <span class="ms-me-badge">管理员</span>' : '') + '</div>' +
      (uname ? '<div class="ms-me-username">@' + escapeHtml(uname) + '</div>' : '') +
    '</div>';
  // 移动端头像也支持点击上传
  const mobileAvatar = card.querySelector('.ms-me-avatar');
  if (mobileAvatar) {
    mobileAvatar.style.cursor = 'pointer';
    mobileAvatar.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async () => {
        await openAvatarCropper(input.files && input.files[0], () => populateMeSheet(body));
        // 上传完成后重新填充面板，刷新头像
        populateMeSheet(body);
      };
      input.click();
    });
  }
  body.appendChild(card);

  const section = document.createElement('div');
  section.className = 'ms-section';
  const grid = document.createElement('div');
  grid.className = 'ms-grid';

  // 主题切换
  const themeBtn = document.createElement('button');
  themeBtn.className = 'ms-item';
  themeBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg><span>切换主题</span>';
  themeBtn.addEventListener('click', () => { closeMobileSheet(); toggleTheme(); });
  grid.appendChild(themeBtn);

  // 退出登录（桌面模式隐藏）
  if (!window.desktop || !window.desktop.isDesktop) {
    const logoutBtnEl = document.createElement('button');
    logoutBtnEl.className = 'ms-item ms-item-danger';
    logoutBtnEl.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg><span>退出登录</span>';
    logoutBtnEl.addEventListener('click', async () => {
      closeMobileSheet();
      stopVersionPolling();
  stopShareStatsPolling();
      hideVersionBanner();
      try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) {}
      window.location.href = '/login.html';
    });
    grid.appendChild(logoutBtnEl);
  }

  section.appendChild(grid);
  body.appendChild(section);
}

// 构建底部抽屉里的折叠工具网格
function populateDocumentSheet(body) {
  const doc = currentDoc;
  body.replaceChildren();
  if (!doc || !doc.id) {
    const empty = document.createElement('div');
    empty.className = 'version-history-empty';
    empty.textContent = '请先打开一篇文档。';
    body.appendChild(empty);
    return;
  }
  const section = document.createElement('div');
  section.className = 'ms-section';
  const title = document.createElement('div');
  title.className = 'ms-section-title';
  title.textContent = '文档';
  const grid = document.createElement('div');
  grid.className = 'ms-grid';
  const entries = [{
    label: '版本历史',
    icon: VERSION_HISTORY_ICON,
    action: () => openVersionHistory(doc)
  }];
  if (getDocumentOutlineHeadings().length) {
    entries.push({
      label: '章节',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 5.5v16"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>',
      action: () => openResponsiveOutline()
    });
  }
  const titleAiWrap = document.getElementById('docTitleAiWrap');
  if (titleAiWrap && !titleAiWrap.hidden) {
    entries.push({
      label: 'AI 拟标题',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
      action: () => requestManualTitleSuggestion()
    });
  }
  entries.forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ms-item';
    button.innerHTML = item.icon + '<span>' + item.label + '</span>';
    button.addEventListener('click', () => {
      closeMobileSheet();
      item.action();
    });
    grid.appendChild(button);
  });
  section.append(title, grid);
  body.appendChild(section);
}
function populateToolsSheet(body) {
  const fmtIcon = (svg) => svg;
  const items = [
    { section: '段落', children: [
      { label: '标题1', action: () => editor.exec('formatBlock', '<H1>') },
      { label: '标题2', action: () => editor.exec('formatBlock', '<H2>') },
      { label: '标题3', action: () => editor.exec('formatBlock', '<H3>') },
      { label: '正文',  action: () => editor.exec('formatBlock', '<P>') },
      { label: '引用',  action: () => editor.exec('formatBlock', '<BLOCKQUOTE>'), svg: '<svg viewBox="0 0 24 24"><path d="M5 8c0-1.7 1.3-3 3-3v2c-.6 0-1 .4-1 1v1h1v3H5V8zm9 0c0-1.7 1.3-3 3-3v2c-.6 0-1 .4-1 1v1h1v3h-3V8z" fill="currentColor" stroke="none"/></svg>' },
      { label: '代码块', action: () => editor.insertCodeBlock(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>' },
    ]},
    { section: '格式', children: [
      { label: '删除线', cmd: 'strikeThrough', text: 'S' },
      { label: '无序列表', cmd: 'insertUnorderedList', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3.5" y1="6" x2="3.5" y2="6"/><line x1="3.5" y1="12" x2="3.5" y2="12"/><line x1="3.5" y1="18" x2="3.5" y2="18"/></svg>' },
      { label: '有序列表', cmd: 'insertOrderedList', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>' },
      { label: '行内代码', action: () => editor.insertCodeInline(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>' },
      { label: '清除格式', cmd: 'removeFormat', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v6M4 17v3h16v-6"/><line x1="4" y1="12" x2="20" y2="12"/></svg>' },
    ]},
    { section: '插入', children: [
      { label: '表格', action: () => editor.insertTable(3, 3), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>' },
      { label: '分隔线', action: () => editor.insertHR(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="12" x2="20" y2="12"/></svg>' },
      { label: '插入目录', action: () => editor.insertTOC(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="14" y2="12"/><line x1="8" y1="18" x2="14" y2="18"/><circle cx="3.5" cy="6" r="1.2" fill="currentColor"/><circle cx="3.5" cy="12" r="1.2" fill="currentColor"/><circle cx="3.5" cy="18" r="1.2" fill="currentColor"/></svg>' },
    ]},
    { section: 'AI', children: [
      { label: 'AI 排版', action: () => openAiLayoutModal(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4M8.5 14.5c-1.2-1-2-2.6-2-4.3A5.5 5.5 0 0 1 12 4.7a5.5 5.5 0 0 1 5.5 5.5c0 1.7-.8 3.3-2 4.3-.8.7-1.1 1.3-1.2 2h-4.6c-.1-.7-.4-1.3-1.2-2Z"/></svg>' },
      { label: 'AI 改写', action: () => openAiRewriteModal(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l1.5 4.5L18 10l-4.5 1.5L12 16l-1.5-4.5L6 10l4.5-1.5z"/></svg>' },
    ]},
    { section: '字体', children: [
      { label: '字体', select: 'fontSelect' },
      { label: '主题', action: () => toggleTheme(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>' },
    ]},
    { section: '文件', children: [
      { label: '导出 Word', action: () => exportWord(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>' },
      { label: '导出 HTML', action: () => exportHTML(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>' },
      { label: '导出 MD', action: () => exportMarkdown(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>' },
      { label: '导出图片', action: () => openExportImageModal(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' },
      { label: '阅读模式', action: () => toggleReadingMode(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>' },
    ]},
  ];
  if (getDocumentOutlineHeadings().length) {
    items.splice(3, 0, { section: '文档', children: [
      { label: '章节', action: () => openResponsiveOutline(), svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 5.5v16"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>' }
    ]});
  }

  body.innerHTML = '';
  items.forEach(sec => {
    const section = document.createElement('div');
    section.className = 'ms-section';
    const title = document.createElement('div');
    title.className = 'ms-section-title';
    title.textContent = sec.section;
    section.appendChild(title);
    const grid = document.createElement('div');
    grid.className = 'ms-grid';
    sec.children.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'ms-item';
      if (item.select) {
        // 字体下拉
        const sel = document.getElementById(item.select);
        if (sel) {
          const clone = sel.cloneNode(true);
          clone.className = 'ms-select';
          clone.id = '';
          clone.value = sel.value;
          clone.addEventListener('change', () => {
            sel.value = clone.value;
            sel.dispatchEvent(new Event('change'));
          });
          grid.appendChild(clone);
          return;
        }
      }
      let iconHtml = '';
      if (item.svg) iconHtml = item.svg;
      else if (item.text) iconHtml = '<' + (item.cmd === 'strikeThrough' ? 's' : 'b') + '>' + item.text + '</' + (item.cmd === 'strikeThrough' ? 's' : 'b') + '>';
      btn.innerHTML = iconHtml + '<span>' + item.label + '</span>';
      btn.addEventListener('click', () => {
        closeMobileSheet();
        if (item.cmd) editor.exec(item.cmd);
        else if (item.action) item.action();
        refreshToolbar();
      });
      grid.appendChild(btn);
    });
    section.appendChild(grid);
    body.appendChild(section);
  });
}

$('logoutBtn').addEventListener('click', async () => {
  if (window.desktop && window.desktop.isDesktop) return; // 桌面模式无退出登录
  stopVersionPolling();
  stopShareStatsPolling();
  hideVersionBanner();
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
    else if (tab === 'ai') await renderAiWritingSettings();
    else if (tab === 'import') renderImportTab();
    else if (tab === 'export') renderExportTab();
  } catch (e) {
    settingsModalBody.innerHTML = '<div class="share-error">加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
  }
}
async function renderAiWritingSettings() {
  const setting = await api('/api/admin/auto-title-settings');
  autoTitleEnabled = !!setting.enabled;
  settingsModalBody.innerHTML =
    '<section class="auto-title-settings">' +
      '<div class="auto-title-copy"><h3>AI &#20889;&#20316;&#36741;&#21161;</h3>' +
      '<p>&#27491;&#25991;&#36798;&#21040; 40 &#23383;&#24182;&#20572;&#31508;&#19968;&#27573;&#26102;&#38388;&#21518;&#65292;&#20026;&#24403;&#21069;&#25991;&#26723;&#33258;&#21160;&#25311;&#23450;&#26631;&#39064;&#12290;</p>' +
      '<small>&#20165;&#23545;&#31649;&#29702;&#21592;&#33258;&#24049;&#30340;&#26080;&#26631;&#39064;&#25991;&#26723;&#29983;&#25928;&#65292;&#27599;&#31687;&#26368;&#22810;&#35831;&#27714;&#19968;&#27425;&#12290;</small></div>' +
      '<label class="auto-title-toggle"><input id="autoTitleEnabled" type="checkbox"' + (autoTitleEnabled ? ' checked' : '') + '><span aria-hidden="true"></span></label>' +
    '</section>';
  const toggle = $('autoTitleEnabled');
  toggle.addEventListener('change', async () => {
    const next = toggle.checked;
    toggle.disabled = true;
    try {
      const saved = await api('/api/admin/auto-title-settings', 'PUT', { enabled: next });
      autoTitleEnabled = !!saved.enabled;
      toggle.checked = autoTitleEnabled;
      if (autoTitleEnabled) scheduleAutoTitleForCurrentDoc();
      else cancelAutoTitleWork();
    } catch (e) {
      toggle.checked = !next;
    } finally {
      toggle.disabled = false;
    }
  });
}


/* ---------- 批量导入 MD 文档 ---------- */
let importState = null; // { running, total, done, failed, logs, abortFlag }
let importGroups = null; // 扫描后的分组结果，供 doImport 使用

function renderImportTab() {
  settingsModalBody.innerHTML =
    '<section class="import-panel">' +
      '<div class="import-head">' +
        '<h3>批量导入 Markdown</h3>' +
        '<p>选择 Obsidian vault 或任意文件夹，自动以第一层子文件夹名作为产品文件夹，根目录 MD 进未分类。</p>' +
        '<small>iOS 移动端可能不支持文件夹选择，建议在桌面浏览器操作。</small>' +
      '</div>' +
      '<div class="import-actions">' +
        '<label class="import-pick-btn">' +
          '<input type="file" id="importFileInput" webkitdirectory directory multiple hidden>' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>' +
          '<span>选择文件夹</span>' +
        '</label>' +
        '<button class="import-abort-btn" id="importAbortBtn" type="button" hidden>取消</button>' +
      '</div>' +
      '<div class="import-preview" id="importPreview" hidden></div>' +
      '<div class="import-progress" id="importProgress" hidden>' +
        '<div class="import-progress-bar"><div class="import-progress-fill" id="importProgressFill"></div></div>' +
        '<div class="import-progress-text" id="importProgressText">准备中…</div>' +
      '</div>' +
      '<div class="import-result" id="importResult"></div>' +
      '<div class="import-undo" id="importUndo" hidden></div>' +
      '<div class="import-log" id="importLog" hidden></div>' +
    '</section>';
  $('importFileInput').addEventListener('change', onImportFolderPicked);
  const abortBtn = $('importAbortBtn');
  if (abortBtn) abortBtn.addEventListener('click', () => {
    if (importState) importState.abortFlag = true;
    toast('正在取消…');
  });
  checkImportUndo();
}

// 检查是否有 7 天内可撤销的导入批次，有则显示"撤销上一次导入"按钮
async function checkImportUndo() {
  const box = $('importUndo');
  if (!box) return;
  box.hidden = true;
  let batch = null;
  try { batch = await api('/api/import/last-batch'); } catch (_) { return; }
  if (!batch) return;
  const days = Math.max(0, Math.floor((Date.now() - Number(batch.created_at)) / 86400000));
  const ago = days >= 1 ? days + ' 天前' : '今天';
  const folderPart = batch.folder_count > 0 ? ('、<strong>' + batch.folder_count + '</strong> 个文件夹') : '';
  box.innerHTML =
    '<div class="import-undo-info">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>' +
      '<span>上次导入 <strong>' + batch.doc_count + '</strong> 篇文档' + folderPart + '（' + ago + '），可撤销</span>' +
    '</div>' +
    '<button class="import-undo-btn" id="importUndoBtn" type="button">撤销上一次导入</button>';
  box.hidden = false;
  $('importUndoBtn').addEventListener('click', onImportUndo);
}

async function onImportUndo() {
  const ok = await showConfirm({
    title: '撤销上一次导入',
    desc: '撤销后，本次导入的文档（含已编辑内容）将移入回收站，可随时恢复；本次导入且当前为空的文件夹会被删除。确定撤销？',
    confirmText: '撤销导入',
    danger: true
  });
  if (!ok) return;
  const btn = $('importUndoBtn');
  if (btn) { btn.disabled = true; btn.textContent = '撤销中…'; }
  try {
    const r = await api('/api/import/undo', 'POST', {});
    toast('已撤销：' + r.docs_moved + ' 篇文档移入回收站' + (r.folders_deleted > 0 ? '，删除 ' + r.folders_deleted + ' 个空文件夹' : ''));
    await loadSidebar();
    checkImportUndo(); // 刷新撤销区（撤销后应隐藏）
  } catch (err) {
    toast('撤销失败：' + (err.message || err));
    if (btn) { btn.disabled = false; btn.textContent = '撤销上一次导入'; }
  }
}

function renderExportTab() {
  settingsModalBody.innerHTML =
    '<section class="export-panel">' +
      '<div class="export-head">' +
        '<h3>导出 Markdown</h3>' +
        '<p>把文档导出为 Markdown 文件，按文件夹分组，图片放入各文件夹的 images/ 子目录。可直接导入 Obsidian。</p>' +
      '</div>' +
      '<div class="export-actions">' +
        '<button class="export-all-btn" id="exportAllBtn" type="button">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
          '<span>导出全部文档</span>' +
        '</button>' +
      '</div>' +
      '<div class="export-tip">导出单个文件夹：在左侧文件夹上点击「更多」→「导出此文件夹」。</div>' +
    '</section>';
  $('exportAllBtn').addEventListener('click', () => downloadExport('/api/export/all', 'PenMark-导出.zip'));
}

// 通用导出下载：fetch zip → blob → 触发下载。能正确处理错误（非 zip 时显示后端错误信息）
async function downloadExport(url, filename) {
  const btn = document.querySelector('.export-all-btn');
  if (btn) btn.disabled = true;
  toast('正在打包导出…');
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast('导出失败：' + (err.error || res.statusText));
      return;
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast('导出成功');
  } catch (err) {
    toast('导出失败：' + (err.message || err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function onImportFolderPicked(e) {
  const files = Array.from(e.target.files || []);
  window._importAllFiles = files;
  const mdFiles = files.filter(f => /\.(md|markdown)$/i.test(f.name));
  if (!mdFiles.length) { toast('未找到 .md 文件'); return; }
  if (importState && importState.running) { toast('正在导入中，请等待或取消'); return; }

  // 分组：取 MD 文件的"直接父目录"作为产品文件夹名（B 层）。
  // 无论用户选了哪个层级（选了太外层的 E 而非 A），MD 的直接父目录永远是正确的 B 层。
  // 干扰层（前缀空文件夹、图片子目录）因为没有 MD 文件，不参与分组。
  // 如果 MD 直接在选择的根目录下（parts.length === 2，无 B 层包裹），进未分类。
  const groups = new Map(); // folderName -> [{file, relPath}]
  mdFiles.forEach(f => {
    const parts = String(f.webkitRelativePath || f.name).split('/');
    // parts 末尾是文件名，直接父目录 = parts[parts.length - 2]
    const folderName = parts.length > 2 ? parts[parts.length - 2] : null; // null = 未分类
    if (!groups.has(folderName)) groups.set(folderName, []);
    groups.get(folderName).push({ file: f, relPath: parts.slice(1).join('/') });
  });
  importGroups = groups;

  // 显示预览
  const previewEl = $('importPreview');
  if (!previewEl) return;
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    if (a[0] === null) return 1; // 未分类排最后
    if (b[0] === null) return -1;
    return a[0].localeCompare(b[0], 'zh-CN');
  });
  const folderCount = groups.size - (groups.has(null) ? 1 : 0);
  let previewHtml =
    '<div class="import-preview-head">检测到 ' + mdFiles.length + ' 个文档，分布于 ' +
    folderCount + ' 个文件夹：</div>' +
    '<div class="import-preview-list">';
  for (const [name, items] of sortedGroups) {
    // 样例原始路径：取该文件夹下第一个 MD 的完整 webkitRelativePath
    // 用户可借此一眼看出"直接父目录"提取是否正确（如出现 z/x 等异常段会立刻暴露）
    const samplePath = String((items[0] && items[0].file && items[0].file.webkitRelativePath) || items[0].file.name || '').replace(/\\/g, '/');
    previewHtml +=
      '<div class="import-preview-folder">' +
        '<div class="import-preview-row">' +
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>' +
          '<span class="import-preview-name">' + escapeHtml(name || '未分类') + '</span>' +
          '<span class="import-preview-count">' + items.length + ' 篇</span>' +
        '</div>' +
        '<div class="import-preview-path" title="' + escapeHtml(samplePath) + '">' + escapeHtml(samplePath) + '</div>' +
      '</div>';
  }
  previewHtml += '</div>';
  previewHtml +=
    '<div class="import-preview-actions">' +
      '<button class="import-confirm-btn" id="importConfirmBtn" type="button">确认导入</button>' +
      '<button class="import-repick-btn" id="importRepickBtn" type="button">重新选择</button>' +
    '</div>';
  previewEl.innerHTML = previewHtml;
  previewEl.hidden = false;
  // 隐藏进度/结果区（可能来自上次导入）
  $('importProgress').hidden = true;
  $('importResult').innerHTML = '';
  $('importLog').hidden = true;

  $('importConfirmBtn').addEventListener('click', doImport);
  $('importRepickBtn').addEventListener('click', () => {
    previewEl.hidden = true;
    $('importFileInput').value = ''; // 重置以便重新选同一文件夹
    $('importFileInput').click();
  });
}

async function doImport() {
  if (!importGroups) return;
  const groups = importGroups;
  const total = [...groups.values()].reduce((s, items) => s + items.length, 0);

  importState = { running: true, total, done: 0, failed: 0, logs: [], abortFlag: false };
  $('importPreview').hidden = true;
  $('importProgress').hidden = false;
  $('importAbortBtn').hidden = false;
  $('importResult').innerHTML = '';
  $('importLog').hidden = true;
  updateImportProgress(0, '创建文件夹…');

  // 1) 批量创建文件夹（去重），查询现有 folders 避免重名
  const folderIdMap = new Map();
  const newFolderIds = []; // 本次导入新建的文件夹 ID（撤销时按此清理空文件夹）
  try {
    const existing = await api('/api/folders');
    existing.forEach(f => folderIdMap.set(f.name, f.id));
  } catch (_) {}
  for (const name of groups.keys()) {
    if (name === null) continue;
    if (folderIdMap.has(name)) continue;
    const truncated = name.slice(0, 40); // server.js 限制 40 字符
    try {
      const r = await api('/api/folders', 'POST', { name: truncated });
      folderIdMap.set(name, r.id);
      if (r.id) newFolderIds.push(r.id);
    } catch (err) {
      logImport('文件夹创建失败：' + name + ' — ' + (err.message || err));
    }
  }

  // 2) 串行处理每个 MD 文件
  const importedDocIds = []; // 本次导入的文档 ID（撤销时按此移入回收站）
  let fileIdx = 0;
  for (const [folderName, items] of groups) {
    if (importState.abortFlag) break;
    const folderId = folderIdMap.get(folderName) || null;
    for (const { file, relPath } of items) {
      if (importState.abortFlag) break;
      try {
        const docId = await importOneMdFile(file, relPath, folderId);
        if (docId) importedDocIds.push(docId);
        importState.done++;
      } catch (err) {
        importState.failed++;
        logImport('失败：' + relPath + ' — ' + (err.message || err));
      }
      fileIdx++;
      updateImportProgress(fileIdx, '');
      if (fileIdx % 10 === 0) await new Promise(r => setTimeout(r, 0));
    }
  }

  importState.running = false;
  $('importAbortBtn').hidden = true;
  const ok = importState.done, fail = importState.failed;
  $('importProgressText').textContent = '完成';
  $('importResult').innerHTML =
    '<div class="import-summary">' +
      '<span class="import-ok">成功 ' + ok + '</span>' +
      '<span class="import-fail">失败 ' + fail + '</span>' +
      (fail ? '<button class="import-show-log" id="importShowLog">查看日志</button>' : '') +
    '</div>';
  const showLog = $('importShowLog');
  if (showLog) showLog.addEventListener('click', () => { $('importLog').hidden = false; });
  if (ok > 0) {
    await loadSidebar();
    toast('已导入 ' + ok + ' 篇文档');
    // 记录导入批次，供"撤销上一次导入"使用（7 天内可撤销）
    // 失败不影响导入结果，仅意味着失去一键撤销入口
    try {
      await api('/api/import/batch', 'POST', {
        doc_ids: importedDocIds,
        folder_ids: newFolderIds
      });
    } catch (_) {}
    checkImportUndo(); // 刚导入完，刷新撤销按钮
  }
  window._importAllFiles = null;
  importGroups = null;
}

async function importOneMdFile(file, relPath, folderId) {
  let text = await file.text();
  // 预处理：提取本地图片引用 ![](path)，替换为占位符（markdownToHtml 不处理图片语法）
  const imgPlaceholders = []; // { placeholder, src, alt }
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
    if (/^(https?:|data:|mailto:)/i.test(src)) return m; // 网络图片跳过
    const placeholder = '\u0001IMG' + imgPlaceholders.length + '\u0001';
    imgPlaceholders.push({ placeholder, src, alt });
    return placeholder;
  });

  let html = markdownToHtml(text);
  // 把占位符替换回 <img>（占位符经过 escapeHtml 仍保留 \u0001 字符）
  html = html.replace(/\u0001IMG(\d+)\u0001/g, (m, idx) => {
    const ref = imgPlaceholders[Number(idx)];
    if (!ref) return '';
    return '<img src="' + ref.placeholder + '" alt="' + escapeHtml(ref.alt || '') + '">';
  });

  // 标题：第一个 # 标题或文件名
  const titleMatch = text.match(/^\s*#\s+(.+)$/m);
  const title = (titleMatch ? titleMatch[1] : file.name.replace(/\.(md|markdown)$/i, '')).slice(0, 100);

  // 创建文档
  const created = await api('/api/documents', 'POST', { title, content: html, folder_id: folderId });
  const docId = created.id;
  if (!docId) throw new Error('文档创建未返回 id');

  if (imgPlaceholders.length === 0) return; // 无图直接结束

  // 上传图片并替换占位符
  const fileDir = String(file.webkitRelativePath || '').split('/').slice(0, -1).join('/');
  const replacements = [];
  for (const ref of imgPlaceholders) {
    if (importState && importState.abortFlag) break;
    try {
      const imgFile = resolveImageFile(ref.src, fileDir);
      if (!imgFile) { logImport('图片缺失：' + ref.src + '（' + relPath + '）'); continue; }
      if (imgFile.size > 12 * 1024 * 1024) { logImport('图片过大跳过：' + ref.src); continue; }
      const dataUrl = await readFileAsDataUrl(imgFile);
      const r = await api('/api/documents/' + docId + '/assets', 'POST', { data_url: dataUrl });
      replacements.push({ placeholder: ref.placeholder, url: r.url });
    } catch (err) {
      logImport('图片上传失败：' + ref.src + ' — ' + (err.message || err));
    }
  }
  if (replacements.length) {
    let finalHtml = html;
    for (const r of replacements) finalHtml = finalHtml.split(r.placeholder).join(r.url);
    await api('/api/documents/' + docId, 'PUT', { title, content: finalHtml });
  }
  return docId;
}

// 在 webkitRelativePath 同目录下查找图片文件
function resolveImageFile(src, fileDir) {
  const allFiles = window._importAllFiles || [];
  const cleanSrc = String(src).replace(/\\/g, '/').replace(/^\.\//, '');
  const candidate = (fileDir ? fileDir + '/' : '') + cleanSrc;
  // 1) 完全匹配 webkitRelativePath
  let f = allFiles.find(x => String(x.webkitRelativePath || '').replace(/\\/g, '/') === candidate);
  if (f) return f;
  // 2) 仅按文件名匹配（同目录）
  const baseName = cleanSrc.split('/').pop();
  const dirPrefix = fileDir ? fileDir + '/' : '';
  f = allFiles.find(x => {
    const p = String(x.webkitRelativePath || '').replace(/\\/g, '/');
    return p === dirPrefix + baseName;
  });
  if (f) return f;
  // 3) 全局按 basename 匹配（兜底）
  f = allFiles.find(x => x.name === baseName && /^(png|jpe?g|gif|webp|svg|bmp)$/i.test(x.name.split('.').pop() || ''));
  return f || null;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function updateImportProgress(done, extra) {
  const total = importState.total;
  const pct = total ? Math.round(done * 100 / total) : 0;
  $('importProgressFill').style.width = pct + '%';
  $('importProgressText').textContent = extra || (done + ' / ' + total + '（' + pct + '%）');
}

function logImport(msg) {
  importState.logs.push(msg);
  const el = $('importLog');
  if (el && !el.hidden) {
    const line = document.createElement('div');
    line.className = 'import-log-line';
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }
}


/* ---------- 用户管理 ---------- */
async function renderUserManagement() {
  const users = await api('/api/admin/users');
  let html = '<div class="user-table-wrap"><table class="user-table"><thead><tr><th>用户名</th><th>昵称</th><th>状态</th><th>分享权限</th><th>备注</th><th>操作</th></tr></thead><tbody>';
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
  html += '</tbody></table></div>';
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
      '<div class="review-item-author">' + escapeHtml(d.author_nickname || '') + ' ' + relativeTime(d.updated_at) + '</div>' +
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
      html += '<span class="sensitive-tag">' + escapeHtml(w.word) + '<button class="sensitive-tag-remove" data-id="' + w.id + '" aria-label="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></span>';
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
  const copyIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const shareIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
  let html = '<div class="invite-toolbar">' +
    '<div class="invite-stat">共 ' + list.length + ' 个 未用 ' + unused + ' 已用 ' + used + '</div>' +
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
        : '<div class="invite-row-actions"><button class="invite-share-btn" data-code="' + code + '" title="分享">' + shareIcon + '分享</button><button class="invite-del" data-code="' + code + '" title="删除">删除</button></div>';
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
      if (!await showConfirm({ title: '删除邀请码', desc: '确定删除邀请码 ' + code + '？', confirmText: '删除', danger: true })) return;
      try {
        await api('/api/invites/' + encodeURIComponent(code), 'DELETE');
        toast('已删除');
        loadSettingsTab('invites');
      } catch (e) { toast('删除失败：' + (e.message || e)); }
    });
  });
  // 分享按钮：打开分享弹窗（选文案、复制邀请码/链接/文案）
  settingsModalBody.querySelectorAll('.invite-share-btn').forEach(btn => {
    btn.addEventListener('click', () => openInviteShare(btn.getAttribute('data-code')));
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

/* ---------- 邀请码分享弹窗：单一温暖文案、复制邀请码/链接/文案 ---------- */
const inviteShareModal = $('inviteShareModal');
const inviteShareBody = $('inviteShareBody');
$('inviteShareClose').addEventListener('click', () => { inviteShareModal.hidden = true; });
inviteShareModal.addEventListener('click', (e) => { if (e.target === inviteShareModal) inviteShareModal.hidden = true; });

// 文案：温暖邀请 + 说明邀请制与一人一次。链接已内嵌邀请码，打开后自动填写且不可改；
// 服务端校验有效性，篡改码无法注册。邀请码大小写敏感，不可转大写。
const INVITE_SHARE_TEXT = '我在使用「知著 PenMark」记录和整理想法，邀请你一起来体验。\n\n这是为你生成的邀请链接，仅可供 1 人注册，使用后将自动失效：\n\n{url}';

function buildInviteUrl(code) {
  return window.location.origin + '/login?invite=' + encodeURIComponent(code);
}

function openInviteShare(code) {
  const safeCode = escapeHtml(code);
  const url = buildInviteUrl(code);
  const text = INVITE_SHARE_TEXT.replace(/\{url\}/g, url).replace(/\{code\}/g, code);

  let html = '';
  html += '<div class="invite-share-target">';
  html += '<span class="invite-share-target-label">邀请码</span>';
  html += '<code class="invite-code">' + safeCode + '</code>';
  html += '</div>';
  html += '<div>';
  html += '<span class="invite-share-section-label">邀请文案</span>';
  html += '<textarea class="invite-share-preview" id="inviteSharePreview" readonly>' + escapeHtml(text) + '</textarea>';
  html += '</div>';
  html += '<div class="invite-share-actions">';
  html += '<button type="button" class="btn btn-secondary" id="inviteCopyCode">复制邀请码</button>';
  html += '<button type="button" class="btn btn-secondary" id="inviteCopyLink">复制链接</button>';
  html += '<button type="button" class="btn btn-primary" id="inviteCopyText">复制文案</button>';
  html += '</div>';
  html += '<p class="invite-share-tip">这是邀请制工具，每个邀请码仅限一人注册，用完即失效。若要邀请多人，请生成多个邀请码分别分享。</p>';

  inviteShareBody.innerHTML = html;
  inviteShareModal.hidden = false;

  const previewEl = $('inviteSharePreview');
  // 只读预览按内容自适应高度，避免长文案出现滚动条
  previewEl.style.height = 'auto';
  previewEl.style.height = Math.max(previewEl.scrollHeight, 96) + 'px';
  const copyToClipboard = (text, msg) => {
    navigator.clipboard.writeText(text).then(() => toast(msg)).catch(() => toast('复制失败，请手动复制'));
  };
  $('inviteCopyCode').addEventListener('click', () => copyToClipboard(code, '已复制邀请码：' + code));
  $('inviteCopyLink').addEventListener('click', () => copyToClipboard(url, '已复制链接'));
  $('inviteCopyText').addEventListener('click', () => copyToClipboard(previewEl.value, '已复制文案'));
}

/* ---------- 回收站 ---------- */
const trashModal = $('trashModal');
const trashModalBody = $('trashModalBody');
$('trashBtn').addEventListener('click', openTrash);

/* ---------- 星标筛选 ---------- */
const starBtn = $('starBtn');
if (starBtn) {
  starBtn.addEventListener('click', () => {
    starFilter = !starFilter;
    starBtn.classList.toggle('active', starFilter);
    renderSidebar(sidebarDocs);
  });
}

/* ---------- 文档列表排序（搜索框内排序图标 + 下拉菜单） ---------- */
const sortToggleBtn = $('sortToggle');
const sortPopoverEl = $('sortPopover');
const sortOrderToggleBtn = $('sortOrderToggle');
const sortOrderLabelEl = $('sortOrderLabel');
if (sortToggleBtn && sortPopoverEl) {
  const ORDER_LABELS = { asc: '升序', desc: '降序' };
  function applySortUI() {
    sortPopoverEl.querySelectorAll('[data-field]').forEach(b => {
      b.setAttribute('aria-selected', b.getAttribute('data-field') === sortState.field ? 'true' : 'false');
    });
    if (sortOrderLabelEl) sortOrderLabelEl.textContent = ORDER_LABELS[sortState.order] || '降序';
    if (sortOrderToggleBtn) sortOrderToggleBtn.classList.toggle('asc', sortState.order === 'asc');
  }
  function persistSort() {
    try { localStorage.setItem('penmark_sort', JSON.stringify(sortState)); } catch (_) {}
  }
  function openSortPopover() {
    sortPopoverEl.hidden = false;
    sortToggleBtn.classList.add('active');
    sortToggleBtn.setAttribute('aria-expanded', 'true');
  }
  function closeSortPopover() {
    sortPopoverEl.hidden = true;
    sortToggleBtn.classList.remove('active');
    sortToggleBtn.setAttribute('aria-expanded', 'false');
  }
  applySortUI();
  sortToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (sortPopoverEl.hidden) openSortPopover(); else closeSortPopover();
  });
  sortPopoverEl.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-field]');
    if (opt) {
      sortState = { field: opt.getAttribute('data-field'), order: sortState.order };
      persistSort(); applySortUI();
      closeSortPopover();
      renderSidebar(sidebarDocs);
      return;
    }
    if (e.target.closest('#sortOrderToggle')) {
      sortState = { field: sortState.field, order: sortState.order === 'asc' ? 'desc' : 'asc' };
      persistSort(); applySortUI();
      renderSidebar(sidebarDocs);
    }
  });
  document.addEventListener('click', (e) => {
    if (!sortPopoverEl.hidden && !sortPopoverEl.contains(e.target) && !sortToggleBtn.contains(e.target)) {
      closeSortPopover();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sortPopoverEl.hidden) closeSortPopover();
  });
}

/* ---------- 截断的标题/文件夹名 hover 时显示完整文本（原生 title 提示） ---------- */
docListEl.addEventListener('mouseover', (e) => {
  const el = e.target.closest('.doc-title-text, .folder-name');
  if (!el) return;
  const text = el.textContent.trim();
  const truncated = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
  if (truncated) {
    if (el.getAttribute('title') !== text) el.setAttribute('title', text);
  } else if (el.getAttribute('title') === text) {
    el.removeAttribute('title');
  }
});
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
        if (!await showConfirm({ title: '永久删除', desc: '永久删除不可恢复，确定？', confirmText: '永久删除', danger: true })) return;
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
  return '<h1>你好，开始写点什么吧</h1>' +
    '<p>知著是你的一片安静角落。打开就写，关上就存——不用操心格式，不用被面板打扰。</p>' +
    '<p>你可以把它当日记本、灵感库、读书笔记，或者是存放那些「先放着，以后再看」的地方。怎么用都行，它是你的。</p>' +
    '<p>从微信或公众号粘贴过来的图文，样式和图片都在，不用重新排版。想插入图片直接拖进来，点击拖角就能缩放。写完了想给人看，生成一个链接发过去就行——可以设密码、定有效期，也可以让对方直接编辑。</p>' +
    '<p>几个顺手的小事：行首敲 <kbd>#</kbd> 加空格变标题，敲 <kbd>-</kbd> 加空格变列表，敲 <kbd>&gt;</kbd> 加空格变引用。按 <kbd>Ctrl</kbd>+<kbd>/</kbd> 看所有快捷键。</p>' +
    '<p>写得愉快。</p>';
}

/* ---------- 分享弹窗 ---------- */
const shareModal = $('shareModal');
const shareModalBody = $('shareModalBody');
$('shareModalClose').addEventListener('click', () => shareModal.hidden = true);
shareModal.addEventListener('click', (e) => { if (e.target === shareModal) shareModal.hidden = true; });
const SHARE_THEME_LABELS = { light: '\u7eb8\u58a8', feishu: '\u96fe\u7eb8', dark: '\u591c\u58a8' };
const SHARE_THEME_ORDER = ['light', 'feishu', 'dark'];

function currentEditorTheme() {
  const theme = document.documentElement.getAttribute('data-theme');
  return SHARE_THEME_ORDER.includes(theme) ? theme : 'light';
}

function shareThemeOption(theme, active) {
  const label = SHARE_THEME_LABELS[theme];
  const check = '<svg class="share-theme-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
  return '<button type="button" class="share-theme-btn theme-' + theme + (active ? ' active' : '') + '" data-theme="' + theme + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
    '<span class="share-theme-preview" aria-hidden="true"><span class="share-theme-preview-title"></span><span class="share-theme-preview-line"></span><span class="share-theme-preview-line short"></span></span>' +
    '<span class="share-theme-card-foot"><span>' + label + '</span>' + check + '</span>' +
  '</button>';
}

function shareCopyText(url, share) {
  const author = String((currentUser && (currentUser.nickname || currentUser.username)) || '\u77e5\u8457\u7528\u6237')
    .replace(/\s+/g, ' ').trim().slice(0, 50) || '\u77e5\u8457\u7528\u6237';
  const title = String(docTitleEl.value || (currentDoc && currentDoc.title) || '\u65e0\u6807\u9898')
    .replace(/\s+/g, ' ').trim();
  const shortTitle = title.length > SHARE_TEXT_TITLE_MAX ? title.slice(0, SHARE_TEXT_TITLE_MAX) + '\u2026' : (title || '\u65e0\u6807\u9898');
  let text = author + ' \u7ed9\u4f60\u5206\u4eab\u4e86\u6587\u6863\u201c' + shortTitle + '\u201d\n' + url;
  // 有密码保护时，把明文密码一并带上，方便对方直接打开
  if (share && share.has_password) {
    const pinInputs = document.querySelectorAll('#sharePin .pin-input');
    let pwd = '';
    if (pinInputs.length) {
      pwd = Array.prototype.map.call(pinInputs, inp => inp.value).join('');
    }
    if (pwd) text += '\n\u8bbf\u95ee\u5bc6\u7801\uff1a' + pwd;
  }
  return text;
}

function writeShareText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => writeShareTextFallback(text));
  }
  return writeShareTextFallback(text);
}

function writeShareTextFallback(text) {
  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (!document.execCommand('copy')) throw new Error('copy failed');
      resolve();
    } catch (err) {
      reject(err);
    } finally {
      document.body.removeChild(textarea);
    }
  });
}

// 访客统计小胶囊：点击打开分享弹窗（与分享按钮行为一致，便于查看详情）
const shareStatsBtnEl = document.getElementById('shareStatsBtn');
if (shareStatsBtnEl) {
  shareStatsBtnEl.addEventListener('click', () => openShareModal());
}

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
        const res = await api('/api/documents/' + currentDoc.id + '/share', 'POST', { permission: 'view', theme: currentEditorTheme() });
        toast('已开启分享');
        renderShareForm({ permission: res.permission, has_password: res.has_password, expire_at: res.expire_at, theme: res.theme, url: res.url });
        refreshShareStats();
      } catch (e) { toast('开启失败：' + (e.message || e)); }
    });
    return;
  }

  const permission = share.permission;
  const hasPassword = !!share.has_password;
  const expireAt = share.expire_at;
  const editorTheme = currentEditorTheme();
  const selectedTheme = SHARE_THEME_ORDER.includes(share.theme) ? share.theme : editorTheme;
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
          '<input type="text" maxlength="1" class="pin-input" inputmode="numeric" pattern="[0-9]*" autocomplete="off" aria-label="访问码第 1 位">' +
          '<input type="text" maxlength="1" class="pin-input" inputmode="numeric" pattern="[0-9]*" autocomplete="off" aria-label="访问码第 2 位">' +
          '<input type="text" maxlength="1" class="pin-input" inputmode="numeric" pattern="[0-9]*" autocomplete="off" aria-label="访问码第 3 位">' +
          '<input type="text" maxlength="1" class="pin-input" inputmode="numeric" pattern="[0-9]*" autocomplete="off" aria-label="访问码第 4 位">' +
        '</div>' +
        '<span class="share-pin-hint">4 位数字，输完自动保存</span>' +
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
        '<button class="share-copy share-copy-link" id="shareCopyLink">\u590d\u5236\u94fe\u63a5</button>' +
        '<button class="share-copy" id="shareCopy">复制</button>' +
      '</div>' +
      '<div class="share-hint" id="shareHint">' + buildShareHint(share) + '</div>' +
    '</div>' +
    '<div class="share-section share-visitors-section">' +
      '<div class="share-label">最近访客<span class="share-visitors-meta" id="shareVisitorsMeta"></span></div>' +
      '<div class="share-visitors-list" id="shareVisitorsList"><div class="share-visitors-loading">加载中…</div></div>' +
    '</div>' +
    '<div class="share-actions">' +
      '<button class="share-revoke" id="shareRevoke">撤销分享</button>' +
    '</div>';

  const themeRow = $('shareThemeRow');
  if (themeRow) {
    const themeSection = themeRow.closest('.share-section');
    if (themeSection) {
      themeSection.classList.add('share-theme-section');
      const themeLabel = themeSection.querySelector('.share-label');
      if (themeLabel) {
        themeLabel.textContent = '\u5206\u4eab\u9875\u9762\u5916\u89c2';
        const themeHead = document.createElement('div');
        themeHead.className = 'share-theme-head';
        themeLabel.parentNode.insertBefore(themeHead, themeLabel);
        themeHead.appendChild(themeLabel);
        const current = document.createElement('span');
        current.className = 'share-theme-current';
        current.textContent = '\u5f53\u524d\u7f16\u8f91\u5668\uff1a' + SHARE_THEME_LABELS[editorTheme];
        themeHead.appendChild(current);
      }
      const help = document.createElement('div');
      help.className = 'share-theme-help';
      help.textContent = '\u8bfb\u8005\u9996\u6b21\u6253\u5f00\u65f6\u91c7\u7528\u6b64\u4e3b\u9898\uff0c\u4e4b\u540e\u53ef\u81ea\u884c\u5207\u6362\u9605\u8bfb\u5916\u89c2\u3002';
      themeRow.insertAdjacentElement('beforebegin', help);
    }
    themeRow.innerHTML = SHARE_THEME_ORDER.map(theme => shareThemeOption(theme, theme === selectedTheme)).join('');
  }
  const shareCopyButton = $('shareCopy');
  if (shareCopyButton) shareCopyButton.textContent = '\u590d\u5236\u5206\u4eab\u6587\u6848';
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
  const shareCopyLinkButton = $('shareCopyLink');
  if (shareCopyLinkButton) {
    shareCopyLinkButton.addEventListener('click', () => {
      writeShareText(url).then(
        () => toast('\u94fe\u63a5\u5df2\u590d\u5236'),
        () => toast('\u590d\u5236\u5931\u8d25\uff0c\u8bf7\u624b\u52a8\u590d\u5236\u94fe\u63a5')
      );
    });
  }

  $('shareCopy').addEventListener('click', () => {
    writeShareText(shareCopyText(url, share)).then(
      () => toast('\u5206\u4eab\u6587\u6848\u5df2\u590d\u5236'),
      () => toast('\u590d\u5236\u5931\u8d25\uff0c\u8bf7\u624b\u52a8\u590d\u5236\u94fe\u63a5')
    );
    return;
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
        shareModalBody.querySelectorAll('.share-theme-btn').forEach(b => {
          const active = b === btn;
          b.classList.toggle('active', active);
          b.setAttribute('aria-pressed', String(active));
        });
      } catch (e) { toast('更新失败'); }
    });
  });

  // 拉取并渲染最近访客列表
  loadShareVisitors();
}

// 分享弹窗：拉取访客统计并渲染列表
async function loadShareVisitors() {
  const listEl = $('shareVisitorsList');
  const metaEl = $('shareVisitorsMeta');
  if (!listEl || !currentDoc) return;
  try {
    const r = await fetch('/api/documents/' + currentDoc.id + '/share-stats', { credentials: 'same-origin' });
    if (!r.ok) { listEl.innerHTML = '<div class="share-visitors-empty">暂无访客数据</div>'; return; }
    const data = await r.json();
    const total = data.total || 0;
    const online = data.online_30min || 0;
    if (metaEl) metaEl.textContent = total > 0 ? ' ' + total + ' 人访问' + (online > 0 ? ' ' + online + ' 人在线' : '') : '';
    const visitors = data.visitors || [];
    if (!visitors.length) {
      listEl.innerHTML = '<div class="share-visitors-empty">还没有访客记录</div>';
      return;
    }
    listEl.innerHTML = visitors.slice(0, 20).map(v => {
      const isReg = !!v.is_registered;
      const name = v.nickname || '游客';
      const initial = (name || '?').slice(-1).toUpperCase();
      const time = v.last_visit_at ? relativeTime(v.last_visit_at) : '';
      const cnt = v.visit_count > 1 ? ' 访问 ' + v.visit_count + ' 次' : '';
      return '<div class="share-visitor' + (isReg ? ' registered' : '') + '">' +
        '<span class="share-visitor-avatar' + (isReg ? ' registered' : '') + '">' + escapeHtml(initial) + '</span>' +
        '<span class="share-visitor-info">' +
          '<span class="share-visitor-name">' + escapeHtml(name) + '</span>' +
          '<span class="share-visitor-meta">' + time + cnt + '</span>' +
        '</span>' +
      '</div>';
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="share-visitors-empty">加载失败</div>';
  }
}

function buildShareHint(share) {
  const parts = [];
  if (share.has_password) parts.push('需密码');
  parts.push(share.permission === 'edit' ? '可编辑' : '仅查看');
  if (share.expire_at) parts.push('过期 ' + new Date(share.expire_at).toLocaleString());
  else parts.push('永久有效');
  return parts.join(' ');
}

function setupPinInputs() {
  const pinRow = $('sharePinRow');
  if (!pinRow) return;
  const inputs = pinRow.querySelectorAll('.pin-input');
  inputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 1);
      if (input.value && i < inputs.length - 1) inputs[i + 1].focus();
      if (Array.prototype.every.call(inputs, inp => inp.value)) {
        const pwd = Array.prototype.map.call(inputs, inp => inp.value).join('');
        // updateShare 内部已 toast 错误（如 "保存失败：密码须为4位或以上字母或数字"），
        // 这里 .catch 仅吞掉 re-throw 避免 unhandled rejection，不再二次提示
        updateShare({ password: pwd }).then(() => toast('密码已保存')).catch(() => { /* updateShare 已 toast */ });
      }
    });
    input.addEventListener('paste', (e) => {
      const digits = (e.clipboardData && e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, inputs.length);
      if (!digits) return;
      e.preventDefault();
      inputs.forEach((inp, index) => { inp.value = digits[index] || ''; });
      inputs[Math.min(digits.length, inputs.length - 1)].focus();
      if (digits.length === inputs.length) updateShare({ password: digits }).then(() => toast('密码已保存')).catch(() => { /* updateShare 已 toast */ });
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
  if (!await showConfirm({ title: '撤销分享', desc: '撤销分享？持有链接的人将无法再访问。', confirmText: '撤销', danger: true })) return;
  try {
    await api('/api/documents/' + currentDoc.id + '/share', 'DELETE');
    toast('已撤销分享');
    renderShareForm(null);
    refreshShareStats();
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

const responsiveOutlineLauncher = document.createElement('button');
responsiveOutlineLauncher.className = 'responsive-outline-launcher';
responsiveOutlineLauncher.type = 'button';
responsiveOutlineLauncher.hidden = true;
responsiveOutlineLauncher.title = '打开章节（Ctrl/⌘ + Shift + O）';
responsiveOutlineLauncher.setAttribute('aria-label', '打开章节');
responsiveOutlineLauncher.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 5.5v16"/><path d="M8 7h8M8 11h8M8 15h5"/></svg><span>章节</span>';
document.body.appendChild(responsiveOutlineLauncher);

const responsiveOutlineOverlay = document.createElement('div');
responsiveOutlineOverlay.className = 'responsive-outline-overlay';
responsiveOutlineOverlay.hidden = true;
const responsiveOutline = document.createElement('section');
responsiveOutline.className = 'responsive-outline';
responsiveOutline.hidden = true;
responsiveOutline.setAttribute('role', 'dialog');
responsiveOutline.setAttribute('aria-modal', 'true');
responsiveOutline.setAttribute('aria-label', '章节');
responsiveOutline.innerHTML = '<div class="responsive-outline-head"><strong>章节</strong><button class="responsive-outline-close" type="button" title="关闭" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div><ol class="responsive-outline-list"></ol>';
document.body.append(responsiveOutlineOverlay, responsiveOutline);

let responsiveOutlineHeadings = [];
let responsiveOutlineScrollRoot = null;
let responsiveOutlineScrollHandler = null;
let responsiveOutlineScrollFrame = null;
let responsiveOutlineRestoreFocus = null;

function getDocumentOutlineHeadings() {
  // 只要存在 1 个及以上有效标题即显示大纲，不依赖文档篇幅，避免短文档无大纲反馈
  const headings = Array.from(editorEl.querySelectorAll('h1, h2, h3')).filter(h => !h.closest('.toc') && h.textContent.trim());
  if (!headings.length) return [];
  const prefix = 'outline-' + (currentDoc ? currentDoc.id : 'draft') + '-';
  headings.forEach((h, i) => { h.id = prefix + i; });
  return headings;
}

function setOutlineLauncherVisible(isAvailable) {
  const useDrawer = isAvailable && (readingMode || window.innerWidth <= 1340 || docOutline.hidden);
  responsiveOutlineLauncher.hidden = !useDrawer;
}

function getResponsiveOutlineActiveIndex() {
  if (!responsiveOutlineHeadings.length) return -1;
  const wrap = document.querySelector('.editor-wrap');
  const marker = readingMode ? 88 : (wrap ? wrap.getBoundingClientRect().top + 32 : 32);
  let active = 0;
  responsiveOutlineHeadings.forEach((heading, index) => {
    if (heading.getBoundingClientRect().top <= marker) active = index;
  });
  return active;
}

function updateResponsiveOutlineActive() {
  const active = getResponsiveOutlineActiveIndex();
  responsiveOutline.querySelectorAll('[data-responsive-outline-index]').forEach((button, index) => {
    const isActive = index === active;
    button.classList.toggle('active', isActive);
    if (isActive) button.setAttribute('aria-current', 'location');
    else button.removeAttribute('aria-current');
  });
}

function startResponsiveOutlineTracking() {
  if (responsiveOutlineScrollRoot && responsiveOutlineScrollHandler) responsiveOutlineScrollRoot.removeEventListener('scroll', responsiveOutlineScrollHandler);
  if (responsiveOutlineScrollFrame) cancelAnimationFrame(responsiveOutlineScrollFrame);
  responsiveOutlineScrollRoot = readingMode ? window : document.querySelector('.editor-wrap');
  responsiveOutlineScrollHandler = () => {
    if (responsiveOutlineScrollFrame) return;
    responsiveOutlineScrollFrame = requestAnimationFrame(() => {
      responsiveOutlineScrollFrame = null;
      updateResponsiveOutlineActive();
    });
  };
  if (responsiveOutlineScrollRoot) responsiveOutlineScrollRoot.addEventListener('scroll', responsiveOutlineScrollHandler, { passive: true });
  updateResponsiveOutlineActive();
}

function closeResponsiveOutline(restoreFocus) {
  if (responsiveOutline.hidden) return;
  if (responsiveOutlineScrollRoot && responsiveOutlineScrollHandler) responsiveOutlineScrollRoot.removeEventListener('scroll', responsiveOutlineScrollHandler);
  if (responsiveOutlineScrollFrame) cancelAnimationFrame(responsiveOutlineScrollFrame);
  responsiveOutlineScrollRoot = null;
  responsiveOutlineScrollHandler = null;
  responsiveOutlineScrollFrame = null;
  responsiveOutline.hidden = true;
  responsiveOutlineOverlay.hidden = true;
  if (restoreFocus !== false && responsiveOutlineRestoreFocus && document.contains(responsiveOutlineRestoreFocus)) responsiveOutlineRestoreFocus.focus();
  responsiveOutlineRestoreFocus = null;
}

function scrollToDocumentHeading(heading) {
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  if (readingMode) {
    window.scrollTo({ top: Math.max(0, window.scrollY + heading.getBoundingClientRect().top - 64), behavior });
    return;
  }
  const wrap = document.querySelector('.editor-wrap');
  if (!wrap) return;
  const top = heading.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop - 24;
  wrap.scrollTo({ top: Math.max(0, top), behavior });
}

function openResponsiveOutline() {
  const headings = getDocumentOutlineHeadings();
  if (!headings.length) { toast('还没有标题，暂不显示章节'); return; }
  responsiveOutlineHeadings = headings;
  const list = responsiveOutline.querySelector('.responsive-outline-list');
  list.innerHTML = headings.map((heading, index) => {
    const level = heading.tagName.toLowerCase();
    return '<li class="level-' + level + '"><button type="button" data-responsive-outline-index="' + index + '">' + escapeHtml(heading.textContent.trim()) + '</button></li>';
  }).join('');
  list.querySelectorAll('[data-responsive-outline-index]').forEach(button => {
    button.addEventListener('click', () => {
      const target = headings[parseInt(button.getAttribute('data-responsive-outline-index'), 10)];
      closeResponsiveOutline(false);
      if (target) scrollToDocumentHeading(target);
    });
  });
  responsiveOutlineRestoreFocus = document.activeElement;
  responsiveOutline.hidden = false;
  responsiveOutlineOverlay.hidden = false;
  startResponsiveOutlineTracking();
  const firstItem = list.querySelector('button');
  if (firstItem) firstItem.focus();
}

responsiveOutlineLauncher.addEventListener('click', openResponsiveOutline);
responsiveOutlineOverlay.addEventListener('click', () => closeResponsiveOutline());
responsiveOutline.querySelector('.responsive-outline-close').addEventListener('click', () => closeResponsiveOutline());

function updateOutline(immediate, delay) {
  if (outlineTimer) clearTimeout(outlineTimer);
  const build = () => {
    const visibleHeadings = getDocumentOutlineHeadings();
    if (!visibleHeadings.length) {
      docOutline.hidden = true;
      setOutlineLauncherVisible(false);
      closeResponsiveOutline(false);
      return;
    }
    if (readingMode || window.innerWidth <= 1340) {
      docOutline.hidden = true;
      setOutlineLauncherVisible(true);
      return;
    }
    // 强制按文档顺序分配唯一 ID（消除导入文档中可能的重复 ID）
    const prefix = 'outline-' + (currentDoc ? currentDoc.id : 'draft') + '-';
    visibleHeadings.forEach((h, i) => { h.id = prefix + i; });
    let html = '<div class="outline-title">大纲</div><ol class="outline-list">';
    visibleHeadings.forEach((h, i) => {
      const level = h.tagName.toLowerCase();
      const indent = level === 'h2' ? 'padding-left:1.2em;' : (level === 'h3' ? 'padding-left:2.4em;' : '');
      const text = h.textContent.trim();
      html += '<li style="' + indent + '"><a href="#' + h.id + '" data-outline-idx="' + i + '">' + escapeHtml(text) + '</a></li>';
    });
    html += '</ol>';
    docOutline.innerHTML = html;
    docOutline.hidden = false;
    positionOutline();
    setOutlineLauncherVisible(docOutline.hidden);
    setupOutlineObserver(visibleHeadings);
  };
  if (immediate) {
    build();
  } else {
    outlineTimer = setTimeout(build, Number.isFinite(delay) ? Math.max(0, delay) : 300);
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
  if (available < 240) {
    docOutline.hidden = true;
    return;
  }
  const width = Math.min(300, available - 40);
  docOutline.style.width = width + 'px';
  docOutline.style.left = Math.max(sidebarRect.right + 16, shellRect.left - width - 24) + 'px';
  docOutline.style.top = Math.max((toolbar ? toolbar.getBoundingClientRect().bottom : 0) + 24, shellRect.top + 48) + 'px';
}

window.addEventListener('resize', () => {
  if (readingMode || window.innerWidth <= 1340) updateOutline(true);
  else if (!docOutline.hidden) {
    positionOutline();
    setOutlineLauncherVisible(docOutline.hidden);
  } else updateOutline();
});

/* 监听 .document-shell 尺寸变化（滚动条出现/消失、侧边栏展开收起等），
   同步 .doc-outline 位置，避免大纲浮窗偏移到正文区（"目录贴正文"症状根因） */
(function initOutlineResizeObserver() {
  const tryInit = () => {
    const shell = document.querySelector('.document-shell');
    if (!shell || !window.ResizeObserver) return false;
    let roTimer = null;
    const ro = new ResizeObserver(() => {
      if (roTimer) clearTimeout(roTimer);
      roTimer = setTimeout(() => {
        if (!docOutline.hidden) positionOutline();
      }, 50);
    });
    ro.observe(shell);
    // 侧边栏宽度变化也会影响位置，一并监听
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) ro.observe(sidebar);
    return true;
  };
  if (!tryInit()) {
    // shell 可能晚于本脚本出现，延迟重试
    setTimeout(tryInit, 500);
    setTimeout(tryInit, 1500);
  }
})();
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
    stripBlockBackgrounds(editorEl); // 阅读模式随主题，去掉段落级内联底色
    highlightCodeBlocks(editorEl);
  } else {
    editorEl.contentEditable = 'true';
    restoreHighlightedCode(editorEl);
  }
  updateOutline(true);
}

readingExitBtn.addEventListener('click', toggleReadingMode);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && readingMode) {
    e.preventDefault();
    toggleReadingMode();
  }
});

init();
