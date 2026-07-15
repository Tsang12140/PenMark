const { app, BrowserWindow } = require('electron');
require('../env');

const baseUrl = process.env.PENMARK_TEST_URL || 'http://127.0.0.1:3127';

async function waitFor(win, expression, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('等待页面状态超时：' + expression);
}

async function run() {
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    throw new Error('.env 缺少 ADMIN_USERNAME 或 ADMIN_PASSWORD');
  }
  const errors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  await win.loadURL(baseUrl + '/login.html');
  const username = JSON.stringify(process.env.ADMIN_USERNAME);
  const password = JSON.stringify(process.env.ADMIN_PASSWORD);
  await win.webContents.executeJavaScript(`(() => {
    const username = document.getElementById('loginUsername');
    const password = document.getElementById('loginPassword');
    if (!username || !password) return false;
    username.value = ${username};
    password.value = ${password};
    document.getElementById('loginForm').requestSubmit();
    return true;
  })()`);
  await waitFor(win, `location.pathname === '/' && document.getElementById('editor')`);
  await waitFor(win, `document.getElementById('newDocBtn') && !document.getElementById('newDocBtn').disabled`);
  await win.webContents.executeJavaScript(`document.getElementById('newDocBtn').click()`);
  await new Promise(resolve => setTimeout(resolve, 350));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const editor = document.getElementById('editor');
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.querySelector('[data-action="table"]').click();
    await new Promise(resolve => setTimeout(resolve, 80));
    const table = editor.querySelector('table');
    if (!table) return { table: false };
    const first = table.rows[0].cells[0];
    const second = table.rows[0].cells[1];
    first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const handles = document.querySelectorAll('.table-col-resizer').length;
    second.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, shiftKey: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    const menu = document.querySelector('.table-float-menu');
    const merge = menu && menu.querySelector('[data-table-action="merge"]');
    const color = menu && menu.querySelector('#tableCellColor');
    return {
      table: true,
      rows: table.rows.length,
      cols: table.querySelectorAll(':scope > colgroup > col').length,
      handles,
      menuVisible: !!(menu && !menu.hidden),
      mergeEnabled: !!(merge && !merge.disabled),
      colorInput: !!color
    };
  })()`);
  win.destroy();
  const ok = result.table && result.rows === 3 && result.cols === 3 && result.handles === 3 &&
    result.menuVisible && result.mergeEnabled && result.colorInput && errors.length === 0;
  console.log(JSON.stringify({ ok, result, consoleErrors: errors }, null, 2));
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(run).catch(error => {
  console.error(error && error.stack || error);
  app.exit(1);
});
