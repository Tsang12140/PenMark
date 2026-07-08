// 知著 PenMark 登录/注册页逻辑
(function () {
  // 应用本地保存的主题
  try {
    var saved = localStorage.getItem('penmark_theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch (_) {}

  /* ---------- Tab 切换 ---------- */
  var tabs = document.querySelectorAll('.login-tab');
  var panes = { login: document.getElementById('loginForm'), register: document.getElementById('registerForm') };
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var target = tab.getAttribute('data-tab');
      tabs.forEach(function (t) { t.classList.toggle('active', t === tab); });
      Object.keys(panes).forEach(function (k) { panes[k].classList.toggle('active', k === target); });
      clearError('loginError'); clearError('regError');
    });
  });

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

  ['loginUsername', 'loginPassword'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', function () { clearError('loginError'); });
  });
  ['regUsername', 'regNickname', 'regPassword', 'regInvite'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', function () { clearError('regError'); });
  });

  /* ---------- 登录 ---------- */
  var loginForm = document.getElementById('loginForm');
  var loginSubmit = document.getElementById('loginSubmit');
  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError('loginError');
    var username = document.getElementById('loginUsername').value.trim();
    var password = document.getElementById('loginPassword').value;
    if (!username || !password) { showError('loginError', '请输入用户名和密码'); return; }

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
    var username = document.getElementById('regUsername').value.trim();
    var nickname = document.getElementById('regNickname').value.trim();
    var password = document.getElementById('regPassword').value;
    var invite = document.getElementById('regInvite').value.trim();
    if (!username || !nickname || !password || !invite) {
      showError('regError', '请填写完整信息'); return;
    }

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
  document.getElementById('loginUsername').focus();
})();
