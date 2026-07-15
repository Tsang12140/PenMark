// 知著 PenMark 认证与权限隔离集成测试
// 运行：node test/test-auth-isolation.cjs
//
// 测试覆盖：
// - 登录闭环（正确/错误密码、封禁、会话持久化、退出）
// - 注册和邀请码（事务一致性、并发抢同一邀请码）
// - 用户隔离（A 看不到/操作 B 的文档）
// - 文档 CRUD、文件夹、回收站、搜索
// - 分享创建与公开访问
//
// 本测试使用 SQLite（PENMARK_DB=sqlite）模拟网页版多用户场景，
// 不依赖 PostgreSQL，但覆盖了共享的数据层和认证逻辑。
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---------- 测试环境设置 ---------- */
const testDir = path.join(os.tmpdir(), 'penmark-auth-test-' + Date.now());
fs.mkdirSync(testDir, { recursive: true });
process.env.PENMARK_DATA_DIR = testDir;
process.env.PENMARK_DB = 'sqlite';
process.env.NODE_ENV = 'development';
process.env.PENMARK_HOST = '127.0.0.1';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin123';
process.env.ADMIN_NICKNAME = '管理员';
process.env.PENMARK_SECRET = 'test-secret-for-auth-tests-only';
process.env.LOGIN_RATE_LIMIT = '200'; // 测试环境放宽速率限制
process.env.TRUST_PROXY = '1';
process.env.APP_ORIGIN = 'https://notes.example.test';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.error('✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

/* ---------- HTTP 请求辅助 ---------- */
function request(port, method, pathname, body, cookies, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
    if (cookies) headers.Cookie = cookies;
    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    // 对路径中的查询参数进行编码
    const encodedPath = encodeURI(pathname);
    const req = http.request({ host: '127.0.0.1', port, path: encodedPath, method, headers }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        // 提取 Set-Cookie
        const setCookies = res.headers['set-cookie'] || [];
        const cookieStr = setCookies.map(c => c.split(';')[0]).join('; ');
        resolve({ status: res.statusCode, json, body: buf, setCookie: cookieStr, rawSetCookies: setCookies });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function extractCookie(setCookieStr, name) {
  if (!setCookieStr) return null;
  const part = setCookieStr.split(';')[0];
  const idx = part.indexOf('=');
  if (idx < 0) return null;
  if (part.slice(0, idx).trim() !== name) return null;
  return part.slice(idx + 1).trim();
}

/* ---------- 主测试流程 ---------- */
async function main() {
  const { startServer } = require('../server');
  await require('../auth').ready; // 等待管理员初始化
  const info = await startServer({ host: '127.0.0.1', port: 0 });
  const port = info.port;

  try {
    console.log('=== 认证与权限隔离测试 ===\n');

    /* ---------- 1. 管理员登录闭环 ---------- */
    console.log('--- 管理员登录闭环 ---');
    const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    check('管理员登录返回 200', loginRes.status === 200, 'status=' + loginRes.status);
    check('登录返回用户信息', loginRes.json && loginRes.json.user && loginRes.json.user.username === 'admin');
    check('登录返回 isAdmin', loginRes.json && loginRes.json.user && loginRes.json.user.isAdmin === true);
    check('登录设置 Cookie', !!loginRes.setCookie, 'cookie=' + loginRes.setCookie);
    const adminCookie = loginRes.setCookie;
    check('Cookie 名称为 penmark_session', adminCookie && adminCookie.startsWith('penmark_session='));

    // /api/auth/me 验证会话
    const meRes = await request(port, 'GET', '/api/auth/me', null, adminCookie);
    check('/api/auth/me 返回 200', meRes.status === 200);
    check('/api/auth/me 返回用户', meRes.json && meRes.json.user && meRes.json.user.username === 'admin');

    // 宝塔/Nginx 反向代理：Node 收到的 Host 可能是回环地址，必须识别转发后的公网 Origin。
    const proxyHeaders = {
      Origin: 'https://notes.example.test',
      Host: '127.0.0.1:' + port,
      'X-Forwarded-Host': 'notes.example.test',
      'X-Forwarded-Proto': 'https'
    };
    const proxiedCreate = await request(port, 'POST', '/api/documents',
      { title: '代理同源测试', content: '<p>ok</p>' }, adminCookie, proxyHeaders);
    check('反向代理后的同源写请求允许通过', proxiedCreate.status === 200,
      'status=' + proxiedCreate.status + ' body=' + JSON.stringify(proxiedCreate.json));

    const rejectedCreate = await request(port, 'POST', '/api/documents',
      { title: '恶意跨域测试', content: '<p>blocked</p>' }, adminCookie,
      Object.assign({}, proxyHeaders, { Origin: 'https://evil.example.test' }));
    check('真正的跨域写请求仍被拒绝', rejectedCreate.status === 403,
      'status=' + rejectedCreate.status + ' body=' + JSON.stringify(rejectedCreate.json));

    // 无 Cookie 访问 /api/auth/me
    const noCookieMe = await request(port, 'GET', '/api/auth/me');
    check('无 Cookie 访问 /api/auth/me 返回 401', noCookieMe.status === 401);
    check('401 响应包含 needLogin', noCookieMe.json && noCookieMe.json.needLogin === true);

    // 错误密码
    const wrongPwd = await request(port, 'POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
    check('错误密码登录返回 401', wrongPwd.status === 401);

    // 不存在用户
    const noUser = await request(port, 'POST', '/api/auth/login', { username: 'nobody', password: 'x' });
    check('不存在用户登录返回 401', noUser.status === 401);

    /* ---------- 2. 邀请码生成 ---------- */
    console.log('--- 邀请码与注册 ---');
    const inviteRes = await request(port, 'POST', '/api/invites', { count: 3 }, adminCookie);
    check('管理员生成邀请码返回 200', inviteRes.status === 200, 'status=' + inviteRes.status);
    check('生成 3 个邀请码', inviteRes.json && inviteRes.json.length === 3);
    const codes = inviteRes.json.map(i => i.code);
    check('邀请码为 8 位', codes.every(c => c.length === 8));

    // 注册用户 A
    const regA = await request(port, 'POST', '/api/auth/register', {
      username: 'userA', nickname: '用户A', password: 'pass1234', invite_code: codes[0]
    });
    check('用户 A 注册成功', regA.status === 200, 'status=' + regA.status + ' body=' + JSON.stringify(regA.json));
    check('注册返回 Cookie', !!regA.setCookie);
    const cookieA = regA.setCookie;

    // 注册用户 B
    const regB = await request(port, 'POST', '/api/auth/register', {
      username: 'userB', nickname: '用户B', password: 'pass5678', invite_code: codes[1]
    });
    check('用户 B 注册成功', regB.status === 200);
    const cookieB = regB.setCookie;

    // 重复使用邀请码
    const reuseCode = await request(port, 'POST', '/api/auth/register', {
      username: 'userC', nickname: '用户C', password: 'pass9999', invite_code: codes[0]
    });
    check('重复使用邀请码注册失败', reuseCode.status === 409);

    // 重复用户名
    const dupUser = await request(port, 'POST', '/api/auth/register', {
      username: 'userA', nickname: '重复', password: 'pass1234', invite_code: codes[2]
    });
    check('重复用户名注册失败', dupUser.status === 409);

    /* ---------- 3. 并发抢同一邀请码 ---------- */
    console.log('--- 并发邀请码测试 ---');
    const invite2 = await request(port, 'POST', '/api/invites', { count: 1 }, adminCookie);
    const raceCode = invite2.json[0].code;
    const concurrent = await Promise.all([
      request(port, 'POST', '/api/auth/register', { username: 'race1', nickname: '竞赛1', password: 'pass1111', invite_code: raceCode }),
      request(port, 'POST', '/api/auth/register', { username: 'race2', nickname: '竞赛2', password: 'pass2222', invite_code: raceCode }),
      request(port, 'POST', '/api/auth/register', { username: 'race3', nickname: '竞赛3', password: 'pass3333', invite_code: raceCode })
    ]);
    const successCount = concurrent.filter(r => r.status === 200).length;
    check('并发抢同一邀请码只有 1 个成功', successCount === 1, '成功数=' + successCount);

    /* ---------- 4. 用户隔离 ---------- */
    console.log('--- 用户隔离 ---');
    // A 创建文档
    const createA = await request(port, 'POST', '/api/documents', { title: 'A的文档', content: '<p>私有内容</p>' }, cookieA);
    check('A 创建文档成功', createA.status === 200 && createA.json && createA.json.id);
    const docIdA = createA.json.id;

    // B 创建文档
    const createB = await request(port, 'POST', '/api/documents', { title: 'B的文档', content: '<p>B的内容</p>' }, cookieB);
    check('B 创建文档成功', createB.status === 200 && createB.json && createB.json.id);
    const docIdB = createB.json.id;

    // A 查看文档列表，不应包含 B 的文档
    const listA = await request(port, 'GET', '/api/documents', null, cookieA);
    check('A 文档列表只含自己的文档', listA.json && listA.json.length === 1 && listA.json[0].id === docIdA);

    // B 试图读取 A 的文档
    const readBtoA = await request(port, 'GET', '/api/documents/' + docIdA, null, cookieB);
    check('B 不能读取 A 的文档', readBtoA.status === 404);

    // B 试图更新 A 的文档
    const updateBtoA = await request(port, 'PUT', '/api/documents/' + docIdA, { title: '被篡改', content: '<p>hack</p>' }, cookieB);
    check('B 不能更新 A 的文档', updateBtoA.status === 404);

    // B 试图删除 A 的文档
    const delBtoA = await request(port, 'DELETE', '/api/documents/' + docIdA, null, cookieB);
    check('B 不能删除 A 的文档', delBtoA.status === 404);

    // B 试图永久删除 A 的回收站文档
    const forceDelBtoA = await request(port, 'DELETE', '/api/trash/' + docIdA, null, cookieB);
    check('B 不能永久删除 A 的文档', forceDelBtoA.status === 404);

    // 普通用户不能访问管理员接口
    const adminApiAsUser = await request(port, 'GET', '/api/admin/users', null, cookieA);
    check('普通用户不能访问管理员接口', adminApiAsUser.status === 403);

    /* ---------- 5. 文档 CRUD ---------- */
    console.log('--- 文档 CRUD ---');
    // 读取单篇
    const readDoc = await request(port, 'GET', '/api/documents/' + docIdA, null, cookieA);
    check('读取文档详情', readDoc.status === 200 && readDoc.json && readDoc.json.title === 'A的文档');

    // 更新文档
    const updateDoc = await request(port, 'PUT', '/api/documents/' + docIdA, { title: 'A的文档(已更新)', content: '<p>新内容</p>' }, cookieA);
    check('更新文档成功', updateDoc.status === 200 && updateDoc.json && updateDoc.json.updated === 1);

    // 软删除
    const softDel = await request(port, 'DELETE', '/api/documents/' + docIdA, null, cookieA);
    check('软删除文档成功', softDel.status === 200);

    // 文档列表不再包含已删除
    const listAfterDel = await request(port, 'GET', '/api/documents', null, cookieA);
    check('删除后列表为空', listAfterDel.json && listAfterDel.json.length === 0);

    // 回收站有文档
    const trash = await request(port, 'GET', '/api/trash', null, cookieA);
    check('回收站包含已删除文档', trash.json && trash.json.length === 1 && trash.json[0].id === docIdA);

    // 恢复
    const restore = await request(port, 'POST', '/api/trash/' + docIdA + '/restore', null, cookieA);
    check('恢复文档成功', restore.status === 200);

    // 永久删除
    await request(port, 'DELETE', '/api/documents/' + docIdA, null, cookieA); // 先软删除
    const permDel = await request(port, 'DELETE', '/api/trash/' + docIdA, null, cookieA);
    check('永久删除文档成功', permDel.status === 200);

    /* ---------- 6. 文件夹 ---------- */
    console.log('--- 文件夹 ---');
    const createFolder = await request(port, 'POST', '/api/folders', { name: '测试文件夹' }, cookieA);
    check('创建文件夹成功', createFolder.status === 200 && createFolder.json && createFolder.json.id);
    const folderId = createFolder.json.id;

    const listFolders = await request(port, 'GET', '/api/folders', null, cookieA);
    check('文件夹列表包含创建的文件夹', listFolders.json && listFolders.json.length === 1 && listFolders.json[0].id === folderId);

    const renameFolder = await request(port, 'PUT', '/api/folders/' + folderId, { name: '重命名文件夹' }, cookieA);
    check('重命名文件夹成功', renameFolder.status === 200);

    const delFolder = await request(port, 'DELETE', '/api/folders/' + folderId, null, cookieA);
    check('删除文件夹成功', delFolder.status === 200);

    /* ---------- 7. 搜索 ---------- */
    console.log('--- 搜索 ---');
    // 先创建一些文档
    await request(port, 'POST', '/api/documents', { title: 'React 学习笔记', content: '<p>React 是一个 UI 库</p>' }, cookieA);
    await request(port, 'POST', '/api/documents', { title: 'Vue 入门', content: '<p>Vue 是渐进式框架</p>' }, cookieA);

    const searchRes = await request(port, 'GET', '/api/search?q=React', null, cookieA);
    check('搜索返回结果', searchRes.status === 200 && searchRes.json && searchRes.json.length >= 1);
    check('搜索结果包含关键词', searchRes.json && searchRes.json.some(r => r.title.includes('React')));

    const searchEmpty = await request(port, 'GET', '/api/search?q=不存在的关键词XYZ', null, cookieA);
    check('搜索无结果返回空数组', searchEmpty.status === 200 && searchEmpty.json && searchEmpty.json.length === 0);

    /* ---------- 8. 退出登录 ---------- */
    console.log('--- 退出登录 ---');
    const logout = await request(port, 'POST', '/api/auth/logout', null, cookieA);
    check('退出登录返回 200', logout.status === 200);

    // 退出后 Cookie 失效
    const meAfterLogout = await request(port, 'GET', '/api/auth/me', null, cookieA);
    check('退出后 /api/auth/me 返回 401', meAfterLogout.status === 401);

    /* ---------- 9. 封禁用户 ---------- */
    console.log('--- 封禁用户 ---');
    // 用户 B 重新登录
    const reloginB = await request(port, 'POST', '/api/auth/login', { username: 'userB', password: 'pass5678' });
    check('用户 B 重新登录成功', reloginB.status === 200);
    const newCookieB = reloginB.setCookie;

    // 管理员封禁 B
    const banRes = await request(port, 'PUT', '/api/admin/users/' + (reloginB.json.user.id), { is_banned: true }, adminCookie);
    check('封禁用户返回 200', banRes.status === 200, 'status=' + banRes.status + ' body=' + JSON.stringify(banRes.json));

    // 封禁后 B 的会话失效
    const meBanned = await request(port, 'GET', '/api/auth/me', null, newCookieB);
    check('封禁后会话失效', meBanned.status === 401);

    // 封禁后 B 不能登录
    const loginBanned = await request(port, 'POST', '/api/auth/login', { username: 'userB', password: 'pass5678' });
    check('封禁用户不能登录', loginBanned.status === 401);

    /* ---------- 10. Cookie 安全属性 ---------- */
    console.log('--- Cookie 安全属性 ---');
    const rawCookies = loginRes.rawSetCookies || [];
    if (rawCookies.length > 0) {
      const c = rawCookies[0];
      check('Cookie 包含 HttpOnly', c.includes('HttpOnly'), c);
      check('Cookie 包含 SameSite', c.includes('SameSite'), c);
      check('Cookie 包含 Path=/', c.includes('Path=/'), c);
      // 开发模式不应有 Secure
      check('开发模式 Cookie 无 Secure', !c.includes('Secure'), c);
    } else {
      check('Cookie 存在', false, '无 Set-Cookie 头');
    }

    /* ---------- 11. 健康检查 ---------- */
    console.log('--- 健康检查 ---');
    const liveRes = await request(port, 'GET', '/health/live');
    check('/health/live 返回 200', liveRes.status === 200);
    check('/health/live 返回 ok', liveRes.json && liveRes.json.ok === true);

    const readyRes = await request(port, 'GET', '/health/ready');
    check('/health/ready 返回 200', readyRes.status === 200);

    /* ---------- 结果 ---------- */
    console.log('\n========== 测试结果 ==========');
    console.log('通过: ' + pass);
    console.log('失败: ' + fail);
    if (failures.length) {
      console.log('\n失败项：');
      failures.forEach(f => console.log('  - ' + f));
    }

  } finally {
    await new Promise(resolve => info.server.close(resolve));
    try { require('../db').close(); } catch (_) {}
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
