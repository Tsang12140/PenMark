const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'penmark-security-test-'));
process.env.PENMARK_DATA_DIR = root;
process.env.PENMARK_DESKTOP = '1';
process.env.PENMARK_DESKTOP_TOKEN = crypto.randomBytes(32).toString('hex');
process.env.PENMARK_HOST = '127.0.0.1';

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  let passed = 0;
  const check = (name, value) => { if (!value) throw new Error('失败：' + name); passed++; };
  const { startServer } = require('../server');
  const info = await startServer({ host: '127.0.0.1', port: 0 });
  try {
    const host = `127.0.0.1:${info.port}`;
    const noCookie = await request(info.port, '/api/auth/me', { Host: host });
    check('无桌面会话不能访问 API', noCookie.status === 401);
    const wrongCookie = await request(info.port, '/api/auth/me', { Host: host, Cookie: 'penmark_desktop_session=wrong' });
    check('错误桌面会话不能访问 API', wrongCookie.status === 401);
    const ok = await request(info.port, '/api/auth/me', {
      Host: host,
      Cookie: `penmark_desktop_session=${process.env.PENMARK_DESKTOP_TOKEN}`
    });
    check('正确桌面会话可以访问 API', ok.status === 200 && ok.body.includes('本地用户'));
    const badHost = await request(info.port, '/', { Host: 'attacker.example' });
    check('异常 Host 被拒绝', badHost.status === 403);
    console.log(`\n========== 桌面安全测试结果 ==========\n通过: ${passed}\n失败: 0`);
  } finally {
    await new Promise(resolve => info.server.close(resolve));
    try { require('../db').close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exit(1); });