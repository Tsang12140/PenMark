// 知著 PenMark 登录/注册页逻辑
(function () {
  // 桌面模式无需登录，直接跳回首页
  if (window.desktop && window.desktop.isDesktop) {
    window.location.href = '/';
    return;
  }
  // 应用本地保存的主题
  try {
    var saved = localStorage.getItem('penmark_theme');
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', saved === 'dark' ? '#171B1C' : (saved === 'feishu' ? '#F4F6F4' : '#F4F2ED'));
    }
  } catch (_) {}

  // 登录/注册后回到来源页（如分享页）。仅放行站内相对路径，防开放重定向。
  var redirectTarget = '/';
  try {
    var p = new URLSearchParams(location.search).get('redirect');
    if (p && p.charAt(0) === '/' && p.charAt(1) !== '/' && !/^[a-zA-Z]+:/.test(p)) redirectTarget = p;
  } catch (_) {}

  /* ---------- 密码显示/隐藏 ---------- */
  document.querySelectorAll('.pwd-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var targetId = btn.getAttribute('data-target');
      var input = document.getElementById(targetId);
      if (!input) return;
      var isPwd = input.type === 'password';
      input.type = isPwd ? 'text' : 'password';
      btn.querySelector('.eye-open').hidden = isPwd;
      btn.querySelector('.eye-close').hidden = !isPwd;
    });
  });

  /* ---------- Tab 切换 ---------- */
  var tabs = document.querySelectorAll('.login-tab');
  var panes = { login: document.getElementById('loginForm'), register: document.getElementById('registerForm') };
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var target = tab.getAttribute('data-tab');
      tabs.forEach(function (t) { t.classList.toggle('active', t === tab); });
      Object.keys(panes).forEach(function (k) {
        panes[k].classList.toggle('active', k === target);
        // 切换时清空所有字段错误
        panes[k].querySelectorAll('.field-error').forEach(function (e) { e.hidden = true; e.textContent = ''; });
      });
      clearError('loginError'); clearError('regError');
    });
  });

  /* ---------- 字段错误提示 ---------- */
  function showFieldError(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }
  function clearFieldError(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }
  function showError(id, msg) {
    var el = document.getElementById(id);
    el.textContent = msg;
    el.hidden = false;
  }
  function clearError(id) {
    var el = document.getElementById(id);
    el.hidden = true;
    el.textContent = '';
  }

  /* ---------- 登录字段验证 ---------- */
  var loginUsername = document.getElementById('loginUsername');
  var loginPassword = document.getElementById('loginPassword');

  loginUsername.addEventListener('blur', function () {
    var v = loginUsername.value.trim();
    if (!v) { showFieldError('loginUsernameError', '请输入用户名'); return; }
    if (v.length < 4) { showFieldError('loginUsernameError', '用户名至少 4 位'); return; }
    clearFieldError('loginUsernameError');
  });
  loginUsername.addEventListener('input', function () { clearFieldError('loginUsernameError'); clearError('loginError'); });

  loginPassword.addEventListener('blur', function () {
    var v = loginPassword.value;
    if (!v) { showFieldError('loginPasswordError', '请输入密码'); return; }
    if (v.length < 6 || v.length > 16) { showFieldError('loginPasswordError', '密码须 6-16 位'); return; }
    clearFieldError('loginPasswordError');
  });
  loginPassword.addEventListener('input', function () { clearFieldError('loginPasswordError'); clearError('loginError'); });

  /* ---------- 注册字段验证 ---------- */
  var regUsername = document.getElementById('regUsername');
  var regNickname = document.getElementById('regNickname');
  var regPassword = document.getElementById('regPassword');
  var regInvite = document.getElementById('regInvite');

  regUsername.addEventListener('blur', function () {
    var v = regUsername.value.trim();
    if (!v) { showFieldError('regUsernameError', '请输入用户名'); return; }
    if (v.length < 4 || v.length > 20) { showFieldError('regUsernameError', '用户名须 4-20 位'); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(v)) { showFieldError('regUsernameError', '仅限字母、数字、下划线'); return; }
    clearFieldError('regUsernameError');
  });
  regUsername.addEventListener('input', function () { clearFieldError('regUsernameError'); clearError('regError'); });

  regNickname.addEventListener('blur', function () {
    var v = regNickname.value.trim();
    if (!v) { showFieldError('regNicknameError', '请输入昵称'); return; }
    if (v.length < 2 || v.length > 20) { showFieldError('regNicknameError', '昵称须 2-20 个字符'); return; }
    clearFieldError('regNicknameError');
  });
  regNickname.addEventListener('input', function () { clearFieldError('regNicknameError'); clearError('regError'); });

  regPassword.addEventListener('blur', function () {
    var v = regPassword.value;
    if (!v) { showFieldError('regPasswordError', '请输入密码'); return; }
    if (v.length < 6 || v.length > 16) { showFieldError('regPasswordError', '密码须 6-16 位'); return; }
    clearFieldError('regPasswordError');
  });
  regPassword.addEventListener('input', function () { clearFieldError('regPasswordError'); clearError('regError'); });

  regInvite.addEventListener('blur', function () {
    var v = regInvite.value.trim();
    if (!v) { showFieldError('regInviteError', '请输入邀请码'); return; }
    if (v.length !== 8) { showFieldError('regInviteError', '邀请码为 8 位'); return; }
    clearFieldError('regInviteError');
  });
  regInvite.addEventListener('input', function () { clearFieldError('regInviteError'); clearError('regError'); });

  /* ---------- 登录 ---------- */
  var loginForm = document.getElementById('loginForm');
  var loginSubmit = document.getElementById('loginSubmit');
  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError('loginError');
    var username = loginUsername.value.trim();
    var password = loginPassword.value;
    var ok = true;
    if (!username) { showFieldError('loginUsernameError', '请输入用户名'); ok = false; }
    else if (username.length < 4) { showFieldError('loginUsernameError', '用户名至少 4 位'); ok = false; }
    if (!password) { showFieldError('loginPasswordError', '请输入密码'); ok = false; }
    else if (password.length < 6 || password.length > 16) { showFieldError('loginPasswordError', '密码须 6-16 位'); ok = false; }
    if (!ok) return;

    loginSubmit.disabled = true;
    loginSubmit.textContent = '登录中…';
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    }).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, body: body }; });
    }).then(function (res) {
      if (!res.ok) {
        showError('loginError', res.body.error || '登录失败');
        loginSubmit.disabled = false;
        loginSubmit.textContent = '登录';
        return;
      }
      window.location.href = redirectTarget;
    }).catch(function (err) {
      showError('loginError', '网络错误：' + (err.message || err));
      loginSubmit.disabled = false;
      loginSubmit.textContent = '登录';
    });
  });

  /* ---------- 注册 ---------- */
  var regForm = document.getElementById('registerForm');
  var regSubmit = document.getElementById('regSubmit');
  regForm.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError('regError');
    var username = regUsername.value.trim();
    var nickname = regNickname.value.trim();
    var password = regPassword.value;
    var invite = regInvite.value.trim();
    var ok = true;
    if (!username) { showFieldError('regUsernameError', '请输入用户名'); ok = false; }
    else if (username.length < 4 || username.length > 20) { showFieldError('regUsernameError', '用户名须 4-20 位'); ok = false; }
    else if (!/^[a-zA-Z0-9_]+$/.test(username)) { showFieldError('regUsernameError', '仅限字母、数字、下划线'); ok = false; }
    if (!nickname) { showFieldError('regNicknameError', '请输入昵称'); ok = false; }
    else if (nickname.length < 2 || nickname.length > 20) { showFieldError('regNicknameError', '昵称须 2-20 个字符'); ok = false; }
    if (!password) { showFieldError('regPasswordError', '请输入密码'); ok = false; }
    else if (password.length < 6 || password.length > 16) { showFieldError('regPasswordError', '密码须 6-16 位'); ok = false; }
    if (!invite) { showFieldError('regInviteError', '请输入邀请码'); ok = false; }
    else if (invite.length !== 8) { showFieldError('regInviteError', '邀请码为 8 位'); ok = false; }
    if (!ok) return;

    regSubmit.disabled = true;
    regSubmit.textContent = '注册中…';
    fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, nickname: nickname, password: password, invite_code: invite })
    }).then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, body: body }; });
    }).then(function (res) {
      if (!res.ok) {
        showError('regError', res.body.error || '注册失败');
        regSubmit.disabled = false;
        regSubmit.textContent = '注册';
        return;
      }
      window.location.href = redirectTarget;
    }).catch(function (err) {
      showError('regError', '网络错误：' + (err.message || err));
      regSubmit.disabled = false;
      regSubmit.textContent = '注册';
    });
  });

  // URL 参数 ?invite=xxx：自动填入邀请码并锁定，切到注册 tab。
  // 注意：必须放在 tab 事件绑定之后，regTab.click() 才能生效；
  // 邀请码大小写敏感（混合大小写字符集），不可 toUpperCase，否则与服务端不匹配会误报"已失效"。
  try {
    var inviteCode = new URLSearchParams(location.search).get('invite');
    if (inviteCode) {
      inviteCode = inviteCode.trim();
      var regInviteInput = document.getElementById('regInvite');
      if (regInviteInput) {
        regInviteInput.value = inviteCode;
        regInviteInput.readOnly = true;
        // 完全锁定：不可编辑、不可选中、不可复制。邀请码随链接专属，不能从注册页抠走转手。
        regInviteInput.style.opacity = '.6';
        regInviteInput.style.cursor = 'not-allowed';
        regInviteInput.style.userSelect = 'none';
        regInviteInput.style.webkitUserSelect = 'none';
        ['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart'].forEach(function (evt) {
          regInviteInput.addEventListener(evt, function (e) { e.preventDefault(); });
        });
      }
      var regTab = document.querySelector('.login-tab[data-tab="register"]');
      if (regTab) regTab.click();
      var regNicknameEl = document.getElementById('regNickname');
      if (regNicknameEl) regNicknameEl.focus();
      return;
    }
  } catch (_) {}

  // 自动聚焦
  loginUsername.focus();
})();
