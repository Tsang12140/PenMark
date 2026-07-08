// 知著 PenMark 登录页逻辑
(function () {
  var form = document.getElementById('loginForm');
  var phoneInput = document.getElementById('phoneInput');
  var passwordInput = document.getElementById('passwordInput');
  var errEl = document.getElementById('loginError');
  var submitBtn = document.getElementById('loginSubmit');

  // 应用本地保存的主题
  try {
    var saved = localStorage.getItem('penmark_theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch (_) {}

  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }
  function clearError() {
    errEl.hidden = true;
    errEl.textContent = '';
  }

  phoneInput.addEventListener('input', clearError);
  passwordInput.addEventListener('input', clearError);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError();
    var phone = phoneInput.value.trim();
    var password = passwordInput.value;
    if (!phone || !password) { showError('请输入手机号和密码'); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = '登录中…';

    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone, password: password })
    }).then(function (r) {
      return r.json().then(function (body) {
        return { ok: r.ok, body: body };
      });
    }).then(function (res) {
      if (!res.ok) {
        showError(res.body.error || '登录失败');
        submitBtn.disabled = false;
        submitBtn.textContent = '登录';
        return;
      }
      // 登录成功，跳回主页（cookie 已由服务端设置）
      window.location.href = '/';
    }).catch(function (err) {
      showError('网络错误：' + (err.message || err));
      submitBtn.disabled = false;
      submitBtn.textContent = '登录';
    });
  });

  // 自动聚焦
  phoneInput.focus();
})();
