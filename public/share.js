// 知著 PenMark 分享公开页逻辑
// 解析 token → 查元信息 → 必要时弹密码 → 加载文档 → 按权限渲染只读/可编辑
import { setupImagePreview } from './image-preview.js';

const $ = id => document.getElementById(id);
const container = $('shareContainer');
const toastStack = $('toastStack');
const tocEl = $('shareToc');
const tocToggle = $('shareTocToggle');
const tocOverlay = $('shareTocOverlay');
const tocSheet = $('shareTocSheet');
const tocSheetList = $('shareTocSheetList');
const tocSheetClose = $('shareTocSheetClose');
const chapterDock = $('shareChapterDock');
const chapterDockLabel = $('shareChapterDockLabel');
const readingDock = $('shareReadingDock');
let shareTocHeadings = [];
let shareTocObserver = null;
let shareTocKeepClickedUntil = 0;
let shareTocRestoreFocus = null;
let shareProgressBound = false;
let readingProgressFrame = 0;
setupImagePreview(container, '.share-reader img, .share-editor img');

const token = (function() {
  const parts = location.pathname.split('/');
  return parts[parts.length - 1] || '';
})();

let shareInfo = null;
let shareTheme = 'light';
const SHARE_THEMES = ['light', 'feishu', 'dark'];
const THEME_LABELS = { light: '纸墨', feishu: '雾纸', dark: '夜墨' };
const THEME_COLORS = { light: '#F4F2ED', feishu: '#F4F6F4', dark: '#171B1C' };

function shareThemeStorageKey() {
  return 'penmark_share_theme:' + token;
}

function applyShareTheme(theme, persist = true) {
  theme = SHARE_THEMES.includes(theme) ? theme : 'light';
  shareTheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.light);
  document.documentElement.setAttribute('data-theme', theme);
  if (persist) {
    try { localStorage.setItem(shareThemeStorageKey(), theme); } catch(_) {}
  }
  const themeBtn = $('themeToggle');
  if (themeBtn) {
    const label = '\u5207\u6362\u9605\u8bfb\u4e3b\u9898\uff08\u5f53\u524d\uff1a' + THEME_LABELS[shareTheme] + '\uff09';
    themeBtn.title = label;
    themeBtn.setAttribute('aria-label', label);
  }
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastStack.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2100);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  if (day < 30) return day + ' 天前';
  const d = new Date(ts);
  const p = n => n < 10 ? '0' + n : n;
  return (d.getMonth() + 1) + '-' + p(d.getDate());
}

// 右上角登录入口：带上 redirect 回到本分享页；已登录则换成"工作台"
function setupShareLoginBtn() {
  const btn = $('shareLoginBtn');
  if (!btn) return;
  const back = location.pathname + location.search;
  btn.href = '/login.html?redirect=' + encodeURIComponent(back);
  // 非阻塞检查登录态：已登录则升级为"工作台"入口
  fetch('/api/auth/me', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || !data.user) return;
      btn.classList.add('logged-in');
      btn.href = '/';
      btn.title = '进入工作台';
      const label = btn.querySelector('.share-login-label');
      if (label) label.textContent = '工作台';
      const svg = btn.querySelector('svg');
      if (svg) svg.innerHTML = '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>';
    })
    // 网络异常/500/JSON 解析失败等都被吞掉，但至少打一次日志便于排查
    // （否则"登录用户在分享页看不到工作台入口"问题无从诊断）
    .catch(e => console.warn('[share] /api/auth/me 检查失败：', e && e.message));
}

async function init() {
  if (!token) { renderError('链接无效'); return; }
  try {
    const infoRes = await fetch('/api/public/share/' + token + '/info');
    if (infoRes.status === 404) { renderError('链接不存在或已被撤销'); return; }
    if (infoRes.status === 410) { renderError('链接已过期'); return; }
    if (!infoRes.ok) { renderError('加载失败'); return; }
    shareInfo = await infoRes.json();

    // 应用主题：优先读者上次选择，否则用作者预设
    let savedTheme = null;
    try { savedTheme = localStorage.getItem(shareThemeStorageKey()); } catch(_) {}
    applyShareTheme(savedTheme && SHARE_THEMES.includes(savedTheme) ? savedTheme : (shareInfo.theme || 'light'), false);
    const themeBtn = $('themeToggle');
    themeBtn.hidden = false;
    themeBtn.addEventListener('click', () => {
      const idx = SHARE_THEMES.indexOf(shareTheme);
      const next = SHARE_THEMES[(idx + 1) % SHARE_THEMES.length];
      applyShareTheme(next);
      toast('主题：' + THEME_LABELS[next]);
    });

    // 右上角登录入口：带 redirect，登录后回到本分享页
    setupShareLoginBtn();

    // 先尝试直接拿文档；若需密码会返回 401
    const docRes = await fetch('/api/public/share/' + token + '/doc', { credentials: 'same-origin' });
    if (docRes.status === 401) {
      renderPasswordForm();
      return;
    }
    if (!docRes.ok) { renderError('加载失败'); return; }
    const data = await docRes.json();
    renderDoc(data);
    setupVisitors(token);
  } catch (e) {
    renderError('网络错误：' + (e.message || e));
  }
}

function renderPasswordForm() {
  container.classList.add('share-access-gate');
  container.innerHTML =
    '<div class="share-pwd-card">' +
      '<div class="share-pwd-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L21 4l-3-3z"/></svg></div>' +
      '<div class="share-pwd-title">需要密码访问</div>' +
      '<div class="share-pwd-desc">请输入 4 位访问码</div>' +
      '<div class="share-pin" id="pwdPin">' +
        '<input type="text" maxlength="1" class="pin-input pwd-pin" inputmode="numeric" pattern="[0-9]*" autocomplete="off" aria-label="访问码第 1 位">' +
        '<input type="text" maxlength="1" class="pin-input pwd-pin" inputmode="numeric" pattern="[0-9]*" autocomplete="off" aria-label="访问码第 2 位">' +
        '<input type="text" maxlength="1" class="pin-input pwd-pin" inputmode="numeric" pattern="[0-9]*" autocomplete="off" aria-label="访问码第 3 位">' +
        '<input type="text" maxlength="1" class="pin-input pwd-pin" inputmode="numeric" pattern="[0-9]*" autocomplete="off" aria-label="访问码第 4 位">' +
      '</div>' +
      '<div class="share-pwd-error" id="pwdError"></div>' +
    '</div>';
  const inputs = container.querySelectorAll('.pwd-pin');
  inputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 1);
      if (input.value && i < inputs.length - 1) inputs[i + 1].focus();
      if (Array.prototype.every.call(inputs, inp => inp.value)) submitPassword();
    });
    input.addEventListener('paste', (e) => {
      const digits = (e.clipboardData && e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, inputs.length);
      if (!digits) return;
      e.preventDefault();
      inputs.forEach((inp, index) => { inp.value = digits[index] || ''; });
      inputs[Math.min(digits.length, inputs.length - 1)].focus();
      if (digits.length === inputs.length) submitPassword();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && i > 0) inputs[i - 1].focus();
    });
  });
  if (inputs[0]) inputs[0].focus();
}

async function submitPassword() {
  const inputs = container.querySelectorAll('.pwd-pin');
  const pwd = Array.prototype.map.call(inputs, inp => inp.value).join('');
  const errEl = $('pwdError');
  if (pwd.length !== 4) { errEl.textContent = '请输入完整 4 位访问码'; return; }
  errEl.textContent = '';
  // 清空输入以便重试
  try {
    const res = await fetch('/api/public/share/' + token + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: pwd })
    });
    if (res.status === 401) {
      errEl.textContent = '密码错误';
      inputs.forEach(inp => inp.value = '');
      if (inputs[0]) inputs[0].focus();
      return;
    }
    if (res.status === 410) { errEl.textContent = '链接已过期'; return; }
    if (!res.ok) { errEl.textContent = '访问失败'; return; }
    const docRes = await fetch('/api/public/share/' + token + '/doc', { credentials: 'same-origin' });
    if (!docRes.ok) { errEl.textContent = '加载文档失败'; return; }
    const data = await docRes.json();
    renderDoc(data);
    // 关键修复：密码验证成功后也要上报访客，否则加密分享的访问记录永远为空
    setupVisitors(token);
  } catch (e) { errEl.textContent = '网络错误'; }
}

function renderDoc(data) {
  container.classList.remove('share-access-gate');
  const doc = data.doc;
  const canEdit = data.can_edit;
  document.title = (doc.title || '分享文档') + ' · 知著 PenMark';

  const badge = canEdit
    ? '<span class="share-badge edit">可编辑</span>'
    : '<span class="share-badge view">仅查看</span>';

  // 作者昵称：优先从 /doc 接口取，兜底从 /info 接口取（旧链接兼容）
  const ownerNickname = (data.owner_nickname || (shareInfo && shareInfo.owner_nickname) || '').trim();
  const authorHtml = ownerNickname
    ? '<span class="share-author">' + escapeHtml(ownerNickname) + '</span>'
    : '';

  // 编辑按钮（仅可编辑权限时出现）；默认查看，点击后切换为编辑
  const editBtn = canEdit
    ? '<button type="button" class="share-edit-btn" id="shareEditBtn" title="点击进入编辑">编辑</button>'
    : '';

  let html =
    '<div class="share-paper">' +
      '<div class="share-paper-head">' +
        '<h1 class="share-paper-title">' + escapeHtml(doc.title || '无标题') + '</h1>' +
        '<div class="share-paper-info">' + badge +
          authorHtml +
          '<span class="share-date">更新于 ' + relativeTime(doc.updated_at) + '</span>' +
          editBtn +
        '</div>' +
      '</div>' +
      '<div class="share-paper-body">';

  // 默认渲染为只读视图；canEdit 时也先查看，点击编辑按钮才解锁
  html += '<div class="share-reader" id="shareReader">' + (doc.content || '<p><br></p>') + '</div>';
  html += '<div class="share-footer">';
  html += '<span class="share-footer-line">— 文档结束 —</span>';
  html += '<a class="share-footer-brand" href="/" title="知著 PenMark" aria-label="知著 PenMark">' +
    '<img src="/PenMark_Brand_Assets/penmark-logo-horizontal-light.svg" alt="" class="share-brand-logo brand-logo-light">' +
    '<img src="/PenMark_Brand_Assets/penmark-logo-horizontal-dark.svg" alt="" class="share-brand-logo brand-logo-dark">' +
    '</a>';
  html += '</div>';
  html += '</div>'; // .share-paper-body

  if (canEdit) {
    html += '<div class="share-save-bar" id="shareSaveBar" hidden><span class="share-save-dot" id="saveDot"></span><span id="shareSaveState">已就绪</span></div>';
  }

  html += '</div>'; // .share-paper

  container.innerHTML = html;

  const reader = $('shareReader');
  markManualListItems(reader);
  if (reader) reader.querySelectorAll('img').forEach((image) => {
    image.loading = 'lazy'; image.decoding = 'async';
  });

  if (canEdit) setupShareEditToggle(token);
  setupProgress();
  setupTOC();
}

// 可编辑分享页：默认查看，点编辑按钮才解锁编辑
// Editor-generated "1、" items are stored as <p>, not <ol><li>.
// This class exists only in the shared reader, to preserve natural item spacing.
function markManualListItems(root) {
  if (!root) return;
  root.querySelectorAll('p').forEach((paragraph) => {
    const text = paragraph.textContent || '';
    if (/^\s*\d+\s*\u3001/.test(text)) {
      paragraph.classList.add('share-manual-list-item');
    }
  });
}

function setupShareEditToggle(token) {
  const btn = $('shareEditBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const reader = $('shareReader');
    if (!reader) return;
    // This class is only for reader typography and must not be saved to the document.
    const contentRoot = reader.cloneNode(true);
    contentRoot.querySelectorAll('.share-manual-list-item').forEach((paragraph) => {
      paragraph.classList.remove('share-manual-list-item');
    });
    const editor = document.createElement('div');
    editor.className = 'share-editor';
    editor.id = 'shareEditor';
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('spellcheck', 'true');
    editor.innerHTML = contentRoot.innerHTML;
    reader.parentNode.replaceChild(editor, reader);

    // 显示轻编辑提示与保存状态条
    const notice = document.createElement('div');
    notice.className = 'share-edit-notice';
    notice.textContent = '轻编辑模式：适合少量改字和补充，复杂排版、表格和图片请回到主编辑器处理。';
    editor.parentNode.insertBefore(notice, editor);

    // saveBar 不立即显示，等用户第一次 input 时再显示，避免"已就绪"长期悬浮遮挡内容
    const saveBar = $('shareSaveBar');
    if (saveBar) saveBar.hidden = true;

    btn.remove();
    setupEditor(token);
    setupTOC();
    editor.focus();
    // 光标定位到末尾
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch(_) {}
  });
}

function setupEditor(token) {
  const editorEl = $('shareEditor');
  const stateEl = $('shareSaveState');
  const dotEl = $('saveDot');
  const saveBar = $('shareSaveBar');
  let saveTimer = null;
  let fadeTimer = null;

  // 显示保存状态条（编辑中、保存中、已保存）
  function showSaveBar() {
    if (!saveBar) return;
    saveBar.hidden = false;
    saveBar.classList.remove('fade-out');
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  }
  // 保存成功后 2s 自动淡出，避免长期遮挡内容
  function scheduleFadeOut() {
    if (!saveBar) return;
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      saveBar.classList.add('fade-out');
      // 淡出动画结束后彻底隐藏，避免占用焦点和点击区域
      setTimeout(() => { if (saveBar.classList.contains('fade-out')) saveBar.hidden = true; }, 350);
    }, 2000);
  }

  // 待办事项勾选委托：点击 .todo-check 切换 .checked + .todo-item.done
  editorEl.addEventListener('click', (e) => {
    const check = e.target.closest('.todo-check');
    if (!check) return;
    const item = check.closest('.todo-item');
    const checked = check.classList.toggle('checked');
    if (item) item.classList.toggle('done', checked);
    editorEl.dispatchEvent(new Event('input', { bubbles: true }));
  });

  editorEl.addEventListener('input', () => {
    showSaveBar();
    stateEl.textContent = '编辑中…';
    if (dotEl) dotEl.classList.add('editing');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const title = extractTitle(editorEl);
        const content = editorEl.innerHTML;
        const res = await fetch('/api/public/share/' + token + '/doc', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ title, content })
        });
        if (res.ok) {
          stateEl.textContent = '已保存 ' + timeStr();
          if (dotEl) dotEl.classList.remove('editing');
          scheduleFadeOut();
        } else if (res.status === 403) {
          stateEl.textContent = '无编辑权限';
        } else {
          stateEl.textContent = '保存失败';
        }
      } catch (e) { stateEl.textContent = '保存失败'; }
    }, 1500);
  });

  // 关闭/刷新页面前 flush 未保存的编辑（1.5s 防抖窗口内的内容），
  // 用 keepalive 确保请求在页面卸载时仍能发出，避免轻编辑模式丢字
  window.addEventListener('beforeunload', () => {
    if (!saveTimer) return; // 没有待保存的内容
    clearTimeout(saveTimer); saveTimer = null;
    const title = extractTitle(editorEl);
    const content = editorEl.innerHTML;
    try {
      fetch('/api/public/share/' + token + '/doc', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        keepalive: true,
        body: JSON.stringify({ title, content })
      }).catch(() => {});
    } catch (_) {}
  });
}

function extractTitle(editorEl) {
  const h1 = editorEl.querySelector('h1');
  if (h1 && h1.textContent.trim()) return h1.textContent.trim();
  const firstHeading = editorEl.querySelector('h2, h3');
  if (firstHeading && firstHeading.textContent.trim()) return firstHeading.textContent.trim().slice(0, 60);
  const firstP = editorEl.querySelector('p');
  if (firstP && firstP.textContent.trim()) return firstP.textContent.trim().slice(0, 60);
  return '无标题';
}

function setupProgress() {
  const bar = $('readingProgress');
  if (!bar) return;
  if (!shareProgressBound) {
    window.addEventListener('scroll', scheduleReadingProgress, { passive: true });
    shareProgressBound = true;
  }
  updateReadingProgress();
}

function scheduleReadingProgress() {
  if (readingProgressFrame) return;
  readingProgressFrame = requestAnimationFrame(() => {
    readingProgressFrame = 0;
    updateReadingProgress();
  });
}

function updateReadingProgress() {
  const bar = $('readingProgress');
  const root = document.scrollingElement || document.documentElement;
  const total = root.scrollHeight - root.clientHeight;
  const scrolled = total > 0 ? Math.min(1, Math.max(0, root.scrollTop / total)) : 0;
  if (bar) {
    bar.style.width = (scrolled * 100) + '%';
    bar.style.opacity = scrolled > 0.01 ? '1' : '0';
  }
}
function setShareTocExpanded(expanded) {
  [tocToggle, chapterDock].forEach(control => {
    if (control) control.setAttribute('aria-expanded', String(expanded));
  });
}
function closeShareTocSheet(restoreFocus) {
  if (!tocSheet || tocSheet.hidden) return;
  tocSheet.hidden = true;
  if (tocOverlay) tocOverlay.hidden = true;
  setShareTocExpanded(false);
  if (restoreFocus !== false && shareTocRestoreFocus && document.contains(shareTocRestoreFocus)) shareTocRestoreFocus.focus();
  shareTocRestoreFocus = null;
}

function openShareTocSheet() {
  if (!tocSheet || !shareTocHeadings.length) return;
  shareTocRestoreFocus = document.activeElement;
  tocSheet.hidden = false;
  if (tocOverlay) tocOverlay.hidden = false;
  setShareTocExpanded(true);
  const first = tocSheetList && tocSheetList.querySelector('button');
  if (first) first.focus();
}

function setShareTocActive(id) {
  tocEl.querySelectorAll('a[data-target]').forEach(link => link.classList.toggle('active', link.getAttribute('data-target') === id));
  if (tocSheetList) tocSheetList.querySelectorAll('button[data-target]').forEach(button => {
    const isActive = button.getAttribute('data-target') === id;
    button.classList.toggle('active', isActive);
    if (isActive) button.setAttribute('aria-current', 'location');
    else button.removeAttribute('aria-current');
  });
  const activeHeading = shareTocHeadings.find(heading => heading.id === id);
  if (activeHeading && chapterDockLabel) {
    const label = activeHeading.textContent.trim();
    chapterDockLabel.textContent = label;
    chapterDock.setAttribute('aria-label', '\u6253\u5f00\u7ae0\u8282\uff0c\u5f53\u524d\uff1a' + label);
  }
}

function jumpToShareHeading(id, closeSheet) {
  const heading = id && document.getElementById(id);
  if (!heading) return;
  setShareTocActive(id);
  shareTocKeepClickedUntil = Date.now() + 700;
  history.replaceState(null, '', '#' + encodeURIComponent(id));
  const top = Math.max(0, window.scrollY + heading.getBoundingClientRect().top - 88);
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  if (closeSheet) closeShareTocSheet(false);
  window.scrollTo({ top, behavior });
}

function setupTOC() {
  const root = $('shareReader') || $('shareEditor');
  if (!root) return;
  const headings = Array.from(root.querySelectorAll('h1, h2, h3')).filter(h => h.textContent.trim());
  const compactText = (root.innerText || '').replace(/\s/g, '');
  if (headings.length < 2 || compactText.length < 600) {
    tocEl.innerHTML = '';
    tocEl.hidden = true;
    shareTocHeadings = [];
    if (tocToggle) tocToggle.hidden = true;
    if (readingDock) readingDock.hidden = true;
    closeShareTocSheet(false);
    if (shareTocObserver) shareTocObserver.disconnect();
    return;
  }

  shareTocHeadings = headings;
  let html = '<div class="share-toc-title">目录</div><ol class="share-toc-list">';
  let sheetHtml = '';
  headings.forEach((h, i) => {
    const id = h.id || (h.id = 'sh-' + i);
    const level = h.tagName.toLowerCase();
    const indent = level === 'h2' ? 'padding-left:1em;' : (level === 'h3' ? 'padding-left:2em;' : '');
    const text = escapeHtml(h.textContent.trim());
    html += '<li style="' + indent + '"><a href="#' + id + '" data-target="' + id + '">' + text + '</a></li>';
    sheetHtml += '<li class="level-' + level + '"><button type="button" data-target="' + id + '">' + text + '</button></li>';
  });
  html += '</ol>';
  tocEl.innerHTML = html;
  tocEl.hidden = false;
  if (tocSheetList) tocSheetList.innerHTML = sheetHtml;
  if (tocToggle) tocToggle.hidden = false;
  if (readingDock) readingDock.hidden = false;

  tocEl.querySelectorAll('a[data-target]').forEach(link => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      jumpToShareHeading(link.getAttribute('data-target'), false);
    });
  });
  if (tocSheetList) tocSheetList.querySelectorAll('button[data-target]').forEach(button => {
    button.addEventListener('click', () => jumpToShareHeading(button.getAttribute('data-target'), true));
  });

  if (shareTocObserver) shareTocObserver.disconnect();
  shareTocObserver = new IntersectionObserver((entries) => {
    if (Date.now() < shareTocKeepClickedUntil) return;
    entries.forEach(entry => {
      if (entry.isIntersecting) setShareTocActive(entry.target.id);
    });
  }, { rootMargin: '-80px 0px -70% 0px' });
  headings.forEach(h => shareTocObserver.observe(h));
  setShareTocActive(headings[0].id);
  updateReadingProgress();
}

if (tocToggle) tocToggle.addEventListener('click', () => {
  if (tocSheet && !tocSheet.hidden) closeShareTocSheet();
  else openShareTocSheet();
});
if (chapterDock) chapterDock.addEventListener('click', () => {
  if (tocSheet && !tocSheet.hidden) closeShareTocSheet();
  else openShareTocSheet();
});
if (tocOverlay) tocOverlay.addEventListener('click', () => closeShareTocSheet());
if (tocSheetClose) tocSheetClose.addEventListener('click', () => closeShareTocSheet());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && tocSheet && !tocSheet.hidden) closeShareTocSheet();
});

function renderError(msg) {
  container.classList.remove('share-access-gate');
  container.innerHTML =
    '<div class="share-error-card">' +
      '<div class="share-error-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>' +
      '<div class="share-error-msg">' + escapeHtml(msg) + '</div>' +
      '<a class="share-error-link" href="/">返回首页</a>' +
    '</div>';
}

/* ---------- 访客记录：Canvas 指纹 + 上报 + 右上角胶囊 ---------- */

// 生成或读取访客指纹（存 localStorage，重装浏览器会变）
function getVisitorFingerprint() {
  try {
    const cached = localStorage.getItem('penmark_fp');
    if (cached && /^[a-f0-9]{16}$/.test(cached)) return cached;
  } catch(_) {}

  // Canvas 渲染指纹：画一段文字+图形，取 toDataURL 后做 hash
  let canvasSignal = '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 240; canvas.height = 60;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px "Arial"';
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 240, 60);
    ctx.fillStyle = '#069';
    ctx.fillText('PenMark-知著 PenMark 游客指纹·', 2, 4);
    ctx.fillStyle = 'rgba(102,204,0,0.7)';
    ctx.fillText('PenMark-知著 PenMark 游客指纹·', 4, 6);
    canvasSignal = canvas.toDataURL();
  } catch(e) { canvasSignal = 'no-canvas'; }

  // 信号集合：canvas + UA + 屏幕 + 时区 + 语言
  const signals = [
    canvasSignal,
    navigator.userAgent || '',
    navigator.language || '',
    (navigator.languages || []).join(','),
    screen.width + 'x' + screen.height + 'x' + (screen.colorDepth || 0),
    new Date().getTimezoneOffset(),
    Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  ].join('||');

  // SHA-256 → 取前 16 位 hex
  // 兜底：SHA-256 不可用时用简单 hash
  const fallback = () => {
    let h = 5381;
    for (let i = 0; i < signals.length; i++) h = ((h << 5) + h + signals.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, '0') + (h >>> 8).toString(16).padStart(8, '0');
  };

  const result = (async () => {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signals));
      const arr = Array.from(new Uint8Array(buf));
      const hex = arr.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
      try { localStorage.setItem('penmark_fp', hex); } catch(_) {}
      return hex;
    } catch(e) {
      const hex = fallback();
      try { localStorage.setItem('penmark_fp', hex); } catch(_) {}
      return hex;
    }
  })();

  // 同步返回：第一次访问时还没算完，先用 fallback 占位，下次访问再用 SHA-256
  // 实际上 getVisitorFingerprint 是 async 调用方，下面我们让它返回 Promise
  return result;
}

// 生成昵称：游客 + 后 4 位 hex
function nicknameFromFingerprint(fp) {
  const tail = (fp || '').slice(-4);
  return '游客 ' + tail;
}

let _visitorPollTimer = null;
let _visitorsSetup = false;

async function setupVisitors(token) {
  // 重入防护：避免 submitPassword 自动提交场景触发两次，生成两份轮询
  if (_visitorsSetup) return;
  _visitorsSetup = true;

  const fp = await getVisitorFingerprint();
  const nickname = nicknameFromFingerprint(fp);

  // 上报访客（同时拿到访客列表）
  let data = null;
  try {
    const res = await fetch('/api/public/share/' + token + '/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ fingerprint: fp, nickname })
    });
    if (res.ok) data = await res.json();
    else console.warn('[share/visit] report failed, HTTP ' + res.status);
  } catch(e) { /* 上报失败静默，不影响阅读 */ }

  // Keep visitor reporting non-blocking for document reading.
  if (data) renderVisitorCapsule(data);

  // 30 秒轮询一次在线数（不写入，只拉取）；标签页隐藏时跳过，节省请求
  const poll = async () => {
    if (document.hidden) return;
    try {
      const r = await fetch('/api/public/share/' + token + '/visitors', { credentials: 'same-origin' });
      if (r.ok) renderVisitorCapsule(await r.json());
    } catch(_) {}
  };
  _visitorPollTimer = setInterval(poll, 30000);

  // 页面卸载时清理定时器，避免泄漏
  window.addEventListener('pagehide', () => {
    if (_visitorPollTimer) { clearInterval(_visitorPollTimer); _visitorPollTimer = null; }
  }, { once: true });
}

function renderVisitorCapsule(data) {
  let capsule = $('shareVisitors');
  if (!capsule) {
    capsule = document.createElement('div');
    capsule.className = 'share-visitors';
    capsule.id = 'shareVisitors';
    const slot = $('shareVisitorsSlot') || document.body;
    slot.appendChild(capsule);

    // 点击胶囊展开/收起列表
    capsule.addEventListener('click', (e) => {
      const trigger = e.target.closest('.sv-trigger');
      if (!trigger) return;
      const list = capsule.querySelector('.sv-list');
      if (!list) return;
      const open = list.classList.toggle('open');
      trigger.classList.toggle('active', open);
      if (open && capsule._data) renderVisitorList(list, capsule._data);
    });

    // 点击空白收起
    document.addEventListener('click', (e) => {
      if (!capsule.contains(e.target)) {
        const list = capsule.querySelector('.sv-list');
        if (list) list.classList.remove('open');
        const trigger = capsule.querySelector('.sv-trigger');
        if (trigger) trigger.classList.remove('active');
      }
    });
  }

  capsule._data = data;
  const total = data.total || 0;
  const online = data.online_30min || 0;
  capsule.innerHTML =
    '<button type="button" class="sv-trigger" title="查看访客">' +
      '<span class="sv-dot' + (online > 0 ? ' online' : '') + '"></span>' +
      '<span class="sv-text">' + total + ' 人访问' + (online > 0 ? ' · ' + online + ' 人在线' : '') + '</span>' +
      '<svg class="sv-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>' +
    '</button>' +
    '<div class="sv-list"></div>';
}

function renderVisitorList(listEl, data) {
  const visitors = data.visitors || [];
  if (!visitors.length) {
    listEl.innerHTML = '<div class="sv-empty">还没有访客记录</div>';
    return;
  }
  let html = '<div class="sv-list-head">最近访客</div>';
  visitors.slice(0, 20).forEach((v) => {
    const isMe = !!v.is_me;
    const isRegistered = !!v.is_registered;
    // 游客灰色、注册用户亮色（曾经登录过又回来，名字变亮）
    const nameClass = 'sv-name' + (isRegistered ? ' registered' : ' guest');
    html +=
      '<div class="sv-item' + (isMe ? ' me' : '') + (!isRegistered && !isMe ? ' guest' : '') + '">' +
        '<span class="sv-avatar' + (isRegistered ? ' registered' : '') + '">' + escapeHtml((v.nickname || '?').slice(-1).toUpperCase()) + '</span>' +
        '<span class="sv-info">' +
          '<span class="' + nameClass + '">' + escapeHtml(v.nickname || '游客') + (isMe ? '（你）' : '') + '</span>' +
          '<span class="sv-meta">' + relativeTime(v.last_visit_at) + (v.visit_count > 1 ? ' · 访问 ' + v.visit_count + ' 次' : '') + '</span>' +
        '</span>' +
      '</div>';
  });
  listEl.innerHTML = html;
}

init();
