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

function requestJson(port, pathname, method, payload, headers = {}) {
  const body = JSON.stringify(payload || {});
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    req.end(body);
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

    const desktopHeaders = {
      Host: host,
      Cookie: `penmark_desktop_session=${process.env.PENMARK_DESKTOP_TOKEN}`
    };
    const safePng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const unsafeSvg = 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=';
    const created = await requestJson(info.port, '/api/documents', 'POST', {
      title: '分享图片安全测试',
      content: `<div class="img-container"><img src="${safePng}" onerror="alert(1)"></div><img src="${unsafeSvg}"><a href="javascript:alert(1)">危险链接</a>`
    }, desktopHeaders);
    check('可以创建分享图片测试文档', created.status === 200 && JSON.parse(created.body).id);
    const docId = JSON.parse(created.body).id;
    const shared = await requestJson(info.port, `/api/documents/${docId}/share`, 'POST', { permission: 'view' }, desktopHeaders);
    check('可以创建公开分享', shared.status === 200 && JSON.parse(shared.body).token);
    const shareToken = JSON.parse(shared.body).token;
    const publicDoc = await request(info.port, `/api/public/share/${shareToken}/doc`, { Host: host });
    const publicContent = publicDoc.status === 200 ? JSON.parse(publicDoc.body).doc.content : '';
    check('分享页保留安全 Base64 图片', publicContent.includes(safePng));
    check('分享页仍拦截 SVG data 图片', !publicContent.includes(unsafeSvg));
    check('分享页仍移除事件与脚本协议', !/onerror|javascript:/i.test(publicContent));

    console.log(`\n========== 桌面安全测试结果 ==========\n通过: ${passed}\n失败: 0`);
  } finally {
    await new Promise(resolve => info.server.close(resolve));
    try { require('../db').close(); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(err => { console.error(err); process.exit(1); });
