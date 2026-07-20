// 知著 PenMark 分享公开页逻辑
// 解析 token → 查元信息 → 必要时弹密码 → 加载文档 → 按权限渲染只读/可编辑

const $ = id => document.getElementById(id);
const container = $('shareContainer');
const toastStack = $('toastStack');
const tocEl = $('shareToc');

const token = (function() {
  const parts = location.pathname.split('/');
  return parts[parts.length - 1] || '';
})();

let shareInfo = null;
let shareTheme = 'light';
const SHARE_THEMES = ['light', 'feishu', 'dark'];
const THEME_LABELS = { light: '纸墨', feishu: '雾纸', dark: '夜墨' };
const THEME_COLORS = { light: '#F4F2ED', feishu: '#F4F6F4', dark: '#171B1C' };

function applyShareTheme(theme) {
  shareTheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.light);
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('penmark_share_theme', theme); } catch(_) {}
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
    try { savedTheme = localStorage.getItem('penmark_share_theme'); } catch(_) {}
    applyShareTheme(savedTheme && SHARE_THEMES.includes(savedTheme) ? savedTheme : (shareInfo.theme || 'light'));
    const themeBtn = $('themeToggle');
    themeBtn.hidden = false;
    themeBtn.addEventListener('click', () => {
      const idx = SHARE_THEMES.indexOf(shareTheme);
      const next = SHARE_THEMES[(idx + 1) % SHARE_THEMES.length];
      applyShareTheme(next);
      toast('主题：' + THEME_LABELS[next]);
    });

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
  container.innerHTML =
    '<div class="share-pwd-card">' +
      '<div class="share-pwd-icon">🔒</div>' +
      '<div class="share-pwd-title">需要密码访问</div>' +
      '<div class="share-pwd-desc">请输入4位密码</div>' +
      '<div class="share-pin" id="pwdPin">' +
        '<input type="text" maxlength="1" class="pin-input pwd-pin" inputmode="text" autocomplete="off">' +
        '<input type="text" maxlength="1" class="pin-input pwd-pin" inputmode="text" autocomplete="off">' +
        '<input type="text" maxlength="1" class="pin-input pwd-pin" inputmode="text" autocomplete="off">' +
        '<input type="text" maxlength="1" class="pin-input pwd-pin" inputmode="text" autocomplete="off">' +
      '</div>' +
      '<div class="share-pwd-error" id="pwdError"></div>' +
    '</div>';
  const inputs = container.querySelectorAll('.pwd-pin');
  inputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (input.value && i < inputs.length - 1) inputs[i + 1].focus();
      if (Array.prototype.every.call(inputs, inp => inp.value)) submitPassword();
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
  if (pwd.length !== 4) { errEl.textContent = '请输入完整4位密码'; return; }
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
  } catch (e) { errEl.textContent = '网络错误'; }
}

function renderDoc(data) {
  const doc = data.doc;
  const canEdit = data.can_edit;
  document.title = (doc.title || '分享文档') + ' · 知著 PenMark';

  const badge = canEdit
    ? '<span class="share-badge edit">可编辑</span>'
    : '<span class="share-badge view">仅查看</span>';

  // 编辑按钮（仅可编辑权限时出现）；默认查看，点击后切换为编辑
  const editBtn = canEdit
    ? '<button type="button" class="share-edit-btn" id="shareEditBtn" title="点击进入编辑">编辑</button>'
    : '';

  let html =
    '<div class="share-paper">' +
      '<div class="share-paper-head">' +
        '<h1 class="share-paper-title">' + escapeHtml(doc.title || '无标题') + '</h1>' +
        '<div class="share-paper-info">' + badge +
          '<span class="share-date">更新于 ' + relativeTime(doc.updated_at) + '</span>' +
          editBtn +
          '<span class="share-brand" aria-label="知著 PenMark">' +
            '<img src="/PenMark_Brand_Assets/penmark-logo-horizontal-light.svg" alt="" class="share-brand-logo brand-logo-light">' +
            '<img src="/PenMark_Brand_Assets/penmark-logo-horizontal-dark.svg" alt="" class="share-brand-logo brand-logo-dark">' +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="share-paper-body">';

  // 默认渲染为只读视图；canEdit 时也先查看，点击编辑按钮才解锁
  html += '<div class="share-reader" id="shareReader">' + (doc.content || '<p><br></p>') + '</div>';
  html += '<div class="share-footer">— 文档结束 —</div>';
  html += '</div>'; // .share-paper-body

  if (canEdit) {
    html += '<div class="share-save-bar" id="shareSaveBar" hidden><span class="share-save-dot" id="saveDot"></span><span id="shareSaveState">已就绪</span></div>';
  }

  html += '</div>'; // .share-paper

  container.innerHTML = html;

  if (canEdit) setupShareEditToggle(token);
  setupProgress();
  setupTOC();
}

// 可编辑分享页：默认查看，点编辑按钮才解锁编辑
function setupShareEditToggle(token) {
  const btn = $('shareEditBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const reader = $('shareReader');
    if (!reader) return;
    const content = reader.innerHTML;
    const editor = document.createElement('div');
    editor.className = 'share-editor';
    editor.id = 'shareEditor';
    editor.setAttribute('contenteditable', 'true');
    editor.setAttribute('spellcheck', 'true');
    editor.innerHTML = content;
    reader.parentNode.replaceChild(editor, reader);

    // 显示轻编辑提示与保存状态条
    const notice = document.createElement('div');
    notice.className = 'share-edit-notice';
    notice.textContent = '轻编辑模式：适合少量改字和补充，复杂排版、表格和图片请回到主编辑器处理。';
    editor.parentNode.insertBefore(notice, editor);

    const saveBar = $('shareSaveBar');
    if (saveBar) saveBar.hidden = false;

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
  let saveTimer = null;

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
        } else if (res.status === 403) {
          stateEl.textContent = '无编辑权限';
        } else {
          stateEl.textContent = '保存失败';
        }
      } catch (e) { stateEl.textContent = '保存失败'; }
    }, 1500);
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
  const update = () => {
    const h = document.documentElement;
    const total = h.scrollHeight - h.clientHeight;
    const scrolled = total > 0 ? h.scrollTop / total : 0;
    bar.style.width = (scrolled * 100) + '%';
    bar.style.opacity = scrolled > 0.01 ? '1' : '0';
  };
  window.addEventListener('scroll', update, { passive: true });
  update();
}

function setupTOC() {
  const root = $('shareReader') || $('shareEditor');
  if (!root) return;
  const headings = root.querySelectorAll('h1, h2, h3');
  if (headings.length < 3) { tocEl.hidden = true; return; }

  let html = '<div class="share-toc-title">目录</div><ol class="share-toc-list">';
  headings.forEach((h, i) => {
    const id = h.id || (h.id = 'sh-' + i);
    const level = h.tagName.toLowerCase();
    const indent = level === 'h2' ? 'padding-left:1em;' : (level === 'h3' ? 'padding-left:2em;' : '');
    html += '<li style="' + indent + '"><a href="#' + id + '" data-target="' + id + '">' + escapeHtml(h.textContent) + '</a></li>';
  });
  html += '</ol>';
  tocEl.innerHTML = html;
  tocEl.hidden = false;

  // 滚动高亮当前章节
  const links = tocEl.querySelectorAll('a');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        links.forEach(l => l.classList.toggle('active', l.getAttribute('data-target') === entry.target.id));
      }
    });
  }, { rootMargin: '-80px 0px -70% 0px' });
  headings.forEach(h => observer.observe(h));
}

function renderError(msg) {
  container.innerHTML =
    '<div class="share-error-card">' +
      '<div class="share-error-icon">⊘</div>' +
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

async function setupVisitors(token) {
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
  } catch(e) { /* 静默失败，不影响阅读 */ }

  if (data) renderVisitorCapsule(data);

  // 30 秒轮询一次在线数（不写入，只拉取）
  setInterval(async () => {
    try {
      const r = await fetch('/api/public/share/' + token + '/visitors', { credentials: 'same-origin' });
      if (r.ok) renderVisitorCapsule(await r.json());
    } catch(_) {}
  }, 30000);
}

function renderVisitorCapsule(data) {
  let capsule = $('shareVisitors');
  if (!capsule) {
    capsule = document.createElement('div');
    capsule.className = 'share-visitors';
    capsule.id = 'shareVisitors';
    document.body.appendChild(capsule);

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
      '<svg class="sv-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>' +
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
    html +=
      '<div class="sv-item' + (isMe ? ' me' : '') + '">' +
        '<span class="sv-avatar">' + escapeHtml((v.nickname || '?').slice(-1).toUpperCase()) + '</span>' +
        '<span class="sv-info">' +
          '<span class="sv-name">' + escapeHtml(v.nickname || '游客') + (isMe ? '（你）' : '') + '</span>' +
          '<span class="sv-meta">' + relativeTime(v.last_visit_at) + (v.visit_count > 1 ? ' · 访问 ' + v.visit_count + ' 次' : '') + '</span>' +
        '</span>' +
      '</div>';
  });
  listEl.innerHTML = html;
}

init();
