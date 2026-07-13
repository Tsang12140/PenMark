// 知著 PenMark 登录/注册页逻辑
(function () {
  // 应用本地保存的主题
  try {
    var saved = localStorage.getItem('penmark_theme');
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', saved === 'dark' ? '#171B1C' : (saved === 'feishu' ? '#F4F6F4' : '#F4F2ED'));
    }
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
    if (v.length < 2) { showFieldError('loginUsernameError', '用户名至少 2 位'); return; }
    clearFieldError('loginUsernameError');
  });
  loginUsername.addEventListener('input', function () { clearFieldError('loginUsernameError'); clearError('loginError'); });

  loginPassword.addEventListener('blur', function () {
    var v = loginPassword.value;
    if (!v) { showFieldError('loginPasswordError', '请输入密码'); return; }
    if (v.length < 6) { showFieldError('loginPasswordError', '密码至少 6 位'); return; }
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
    if (v.length < 2) { showFieldError('regUsernameError', '用户名至少 2 位'); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(v)) { showFieldError('regUsernameError', '仅限字母、数字、下划线'); return; }
    clearFieldError('regUsernameError');
  });
  regUsername.addEventListener('input', function () { clearFieldError('regUsernameError'); clearError('regError'); });

  regNickname.addEventListener('blur', function () {
    var v = regNickname.value.trim();
    if (!v) { showFieldError('regNicknameError', '请输入昵称'); return; }
    if (v.length < 2) { showFieldError('regNicknameError', '昵称至少 2 位'); return; }
    clearFieldError('regNicknameError');
  });
  regNickname.addEventListener('input', function () { clearFieldError('regNicknameError'); clearError('regError'); });

  regPassword.addEventListener('blur', function () {
    var v = regPassword.value;
    if (!v) { showFieldError('regPasswordError', '请输入密码'); return; }
    if (v.length < 6) { showFieldError('regPasswordError', '密码至少 6 位'); return; }
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
    else if (username.length < 2) { showFieldError('loginUsernameError', '用户名至少 2 位'); ok = false; }
    if (!password) { showFieldError('loginPasswordError', '请输入密码'); ok = false; }
    else if (password.length < 6) { showFieldError('loginPasswordError', '密码至少 6 位'); ok = false; }
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
      window.location.href = '/';
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
    else if (username.length < 2) { showFieldError('regUsernameError', '用户名至少 2 位'); ok = false; }
    else if (!/^[a-zA-Z0-9_]+$/.test(username)) { showFieldError('regUsernameError', '仅限字母、数字、下划线'); ok = false; }
    if (!nickname) { showFieldError('regNicknameError', '请输入昵称'); ok = false; }
    else if (nickname.length < 2) { showFieldError('regNicknameError', '昵称至少 2 位'); ok = false; }
    if (!password) { showFieldError('regPasswordError', '请输入密码'); ok = false; }
    else if (password.length < 6) { showFieldError('regPasswordError', '密码至少 6 位'); ok = false; }
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
      window.location.href = '/';
    }).catch(function (err) {
      showError('regError', '网络错误：' + (err.message || err));
      regSubmit.disabled = false;
      regSubmit.textContent = '注册';
    });
  });

  // 自动聚焦
  loginUsername.focus();
})();
