// 知著 PenMark 桌面版 — Electron 主进程
// 职责：启动本地 Express 服务、创建窗口、管理生命周期、外部链接拦截
// 安全：contextIsolation=true、nodeIntegration=false、sandbox=true、仅监听 127.0.0.1
const {
  app,
  BrowserWindow,
  shell,
  Menu,
  dialog,
  ipcMain,
  session
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let mainWindow = null;
let serverInfo = null;
let serverOrigin = null;

/* ---------- 单实例锁：重复启动时唤醒已有窗口 ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const w = wins[0];
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  app.whenReady().then(boot).catch(err => {
    showErrorDialog('启动失败', err && err.message ? err.message : String(err));
    app.quit();
  });

  app.on('window-all-closed', () => {
    cleanupAndQuit();
  });

  app.on('before-quit', () => {
    cleanupAndQuit();
  });
}

/* ---------- 桌面环境变量设置（必须在 require server.js 之前） ---------- */
function setupDesktopEnv() {
  const isDev = !app.isPackaged;
  let dataDir;
  if (isDev) {
    // 开发模式用独立目录，避免测试数据污染生产数据
    dataDir = path.join(app.getPath('appData'), 'PenMark-Dev');
  } else {
    // 生产模式：%APPDATA%\PenMark
    dataDir = app.getPath('userData');
  }
  fs.mkdirSync(dataDir, { recursive: true });

  // 创建子目录
  for (const sub of ['assets', 'backups', 'logs']) {
    const p = path.join(dataDir, sub);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }

  process.env.PENMARK_DATA_DIR = dataDir;
  process.env.PENMARK_DESKTOP = '1';
  process.env.PENMARK_DESKTOP_TOKEN = crypto.randomBytes(32).toString('hex');
  process.env.PENMARK_HOST = '127.0.0.1';
  process.env.PORT = '0'; // 动态空闲端口

  return dataDir;
}

/* ---------- 主启动流程 ---------- */
async function boot() {
  const dataDir = setupDesktopEnv();
  log('桌面数据目录：' + dataDir);

  // 延迟 require，确保环境变量已设置
  let startServer;
  try {
    ({ startServer } = require('../server'));
  } catch (err) {
    showErrorDialog('服务模块加载失败', err.message);
    app.quit();
    return;
  }

  // 启动本地服务（仅绑定 127.0.0.1，动态端口）
  try {
    serverInfo = await startServer({ host: '127.0.0.1', port: 0 });
    serverOrigin = `http://127.0.0.1:${serverInfo.port}`;
    await session.defaultSession.cookies.set({
      url: serverOrigin,
      name: 'penmark_desktop_session',
      value: process.env.PENMARK_DESKTOP_TOKEN,
      httpOnly: true,
      sameSite: 'strict'
    });
    log('本地服务运行于 ' + serverOrigin);
  } catch (err) {
    showErrorDialog('本地服务启动失败', err.message || String(err));
    app.quit();
    return;
  }

  createWindow();
  setupMenu();
  setupIpc();
}

/* ---------- 创建主窗口 ---------- */
function createWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    width: state.width || 1280,
    height: state.height || 820,
    x: Number.isFinite(state.x) ? state.x : undefined,
    y: Number.isFinite(state.y) ? state.y : undefined,
    minWidth: 900,
    minHeight: 600,
    title: '知著 PenMark',
    backgroundColor: '#ffffff',
    icon: resolveIcon(),
    show: false, // 等加载完成后再显示，避免白屏
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  // 最大化记忆
  if (state.isMaximized) {
    win.maximize();
  }

  mainWindow = win;

  const url = serverOrigin + '/';
  win.loadURL(url).catch(err => {
    log('页面加载失败：' + (err && err.message ? err.message : err));
  });

  // 首次准备好后显示窗口
  win.once('ready-to-show', () => {
    win.show();
  });

  // 如果加载超时（5s），也显示窗口（避免一直白屏）
  setTimeout(() => {
    if (win && !win.isVisible()) win.show();
  }, 5000);

  /* ---------- 外部链接交给系统浏览器 ---------- */
  // 拦截新窗口打开
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) {
      // 同源（本地服务）链接允许在应用内打开
      if (isLocalUrl(target)) {
        return { action: 'allow' };
      }
      shell.openExternal(target);
    }
    return { action: 'deny' };
  });

  // 拦截页面内导航
  win.webContents.on('will-navigate', (event, target) => {
    if (!isLocalUrl(target)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(target)) {
        shell.openExternal(target);
      }
    }
  });

  // 阻止非预期协议（file://、自定义协议等）
  win.webContents.on('will-redirect', (event, target) => {
    if (!isLocalUrl(target) && !target.startsWith('devtools://')) {
      event.preventDefault();
    }
  });

  /* ---------- 窗口状态记忆 ---------- */
  const saveState = () => {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    saveWindowState({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: win.isMaximized()
    });
  };
  win.on('resize', saveState);
  win.on('move', saveState);
  win.on('close', saveState);

  win.on('closed', () => {
    mainWindow = null;
  });
}

function isLocalUrl(url) {
  if (!url || !serverOrigin) return false;
  try {
    return new URL(url).origin === serverOrigin;
  } catch (_) {
    return false;
  }
}

/* ---------- 窗口状态持久化 ---------- */
function getStateFile() {
  return path.join(process.env.PENMARK_DATA_DIR || app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const raw = fs.readFileSync(getStateFile(), 'utf8');
    const s = JSON.parse(raw);
    return {
      width: s.width || 1280,
      height: s.height || 820,
      x: typeof s.x === 'number' ? s.x : undefined,
      y: typeof s.y === 'number' ? s.y : undefined,
      isMaximized: !!s.isMaximized
    };
  } catch (_) {
    return {};
  }
}

function saveWindowState(state) {
  try {
    fs.writeFileSync(getStateFile(), JSON.stringify(state));
  } catch (_) {}
}

/* ---------- 应用图标 ---------- */
function resolveIcon() {
  const candidates = [
    path.join(__dirname, '..', 'public', 'PenMark_Brand_Assets', 'penmark-app-icon-512.png'),
    path.join(__dirname, '..', 'public', 'penmark-app-icon-512.png'),
    path.join(__dirname, '..', 'public', 'favicon.ico')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return undefined;
}

/* ---------- 中文菜单 ---------- */
function setupMenu() {
  const isDev = !app.isPackaged;
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建文档',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow && mainWindow.webContents.send('menu:new-doc')
        },
        { type: 'separator' },
        {
          label: '打开数据目录',
          click: () => {
            const dir = process.env.PENMARK_DATA_DIR;
            if (dir) shell.openPath(dir);
          }
        },
        {
          label: '备份数据库…',
          click: () => doBackup()
        },
        {
          label: '导入旧版数据库…',
          click: () => doImportLegacyDatabase()
        },
        { type: 'separator' },
        {
          label: '导出资料库…',
          click: () => doExportLibrary()
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'CmdOrCtrl+Q',
          role: 'quit'
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        ...(isDev ? [{ role: 'toggleDevTools', label: '开发者工具' }] : []),
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '快捷键面板',
          accelerator: 'CmdOrCtrl+/',
          click: () => mainWindow && mainWindow.webContents.send('menu:shortcuts')
        },
        {
          label: '关于知著 PenMark',
          click: () => showAbout()
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trustedIpc(handler) {
  return (event, ...args) => {
    const frameUrl = event.senderFrame && event.senderFrame.url;
    if (!isLocalUrl(frameUrl)) throw new Error('拒绝非 PenMark 页面调用桌面接口');
    return handler(event, ...args);
  };
}
/* ---------- IPC 处理 ---------- */
function setupIpc() {
  ipcMain.handle('desktop:isDesktop', trustedIpc(() => true));
  ipcMain.handle('desktop:getDataDir', trustedIpc(() => process.env.PENMARK_DATA_DIR || ''));
  ipcMain.handle('desktop:openDataDir', trustedIpc(() => {
    const dir = process.env.PENMARK_DATA_DIR;
    if (dir) shell.openPath(dir);
    return true;
  }));
  ipcMain.handle('desktop:backup', trustedIpc(() => doBackup()));
  ipcMain.handle('desktop:exportLibrary', trustedIpc(() => doExportLibrary()));
  ipcMain.handle('desktop:openExternal', trustedIpc((e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return true;
    }
    return false;
  }));
}

/* ---------- 备份 ---------- */
async function doBackup() {
  const dataDir = process.env.PENMARK_DATA_DIR;
  if (!dataDir) return false;
  const dbPath = path.join(dataDir, 'penmark.db');

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const result = await dialog.showSaveDialog({
    title: '备份数据库',
    defaultPath: `penmark-backup-${ts}.db`,
    filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
  });
  if (result.canceled || !result.filePath) return false;

  try {
    if (!fs.existsSync(dbPath)) throw new Error('数据库文件不存在');
    const db = require('../db');
    await db.backup(result.filePath);

    dialog.showMessageBox({
      type: 'info',
      title: '备份完成',
      message: '数据库已备份到：\n' + result.filePath
    });
    return true;
  } catch (err) {
    dialog.showMessageBox({
      type: 'error',
      title: '备份失败',
      message: '备份数据库时出错：\n' + (err.message || err)
    });
    return false;
  }
}

/* ---------- 安全导入旧版 Node 数据库 ---------- */
async function doImportLegacyDatabase() {
  const result = await dialog.showOpenDialog({
    title: '选择旧版 PenMark 数据库',
    properties: ['openFile'],
    filters: [{ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] }]
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) return false;
  const sourcePath = result.filePaths[0];
  try {
    const db = require('../db');
    const auth = require('../auth');
    const { inspectLegacyDatabase, importLegacyDatabase } = require('./importer.cjs');
    const info = inspectLegacyDatabase(sourcePath, db.name);
    const confirm = await dialog.showMessageBox({
      type: 'question',
      title: '确认导入旧版数据',
      message: `检测到 ${info.documents} 篇文档、${info.folders} 个文件夹。`,
      detail: '导入只会新增数据，不会覆盖或删除当前资料库。旧版未分类文档会放进单独的“旧版导入”文件夹。',
      buttons: ['开始导入', '取消'],
      defaultId: 0,
      cancelId: 1
    });
    if (confirm.response !== 0) return false;
    const user = auth.ensureDesktopUser();
    const stats = importLegacyDatabase(sourcePath, db, user.id);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:library-imported');
    dialog.showMessageBox({
      type: 'info',
      title: '导入完成',
      message: `已导入 ${stats.importedDocuments} 篇文档、${stats.importedFolders} 个文件夹。`,
      detail: '原数据库没有被修改，当前资料库中的既有内容也没有被覆盖。'
    });
    return true;
  } catch (err) {
    dialog.showMessageBox({
      type: 'error',
      title: '导入失败',
      message: err.message || String(err),
      detail: '没有删除或覆盖当前资料库中的内容。'
    });
    return false;
  }
}
/* ---------- 导出整个资料库为 Markdown 文件夹 ---------- */
async function doExportLibrary() {
  const dataDir = process.env.PENMARK_DATA_DIR;
  if (!dataDir) {
    dialog.showMessageBox({
      type: 'error',
      title: '导出失败',
      message: '未找到数据目录环境变量。'
    });
    return false;
  }

  // 选择目标目录
  const result = await dialog.showOpenDialog({
    title: '选择导出目标文件夹',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) return false;
  const targetDir = result.filePaths[0];

  // 检查目标目录是否非空（避免覆盖已有资料）
  try {
    const entries = fs.readdirSync(targetDir);
    if (entries.length > 0) {
      const warn = await dialog.showMessageBox({
        type: 'warning',
        title: '目标文件夹非空',
        message: '所选文件夹不为空。',
        detail: '继续导出可能覆盖同名文件。是否继续？',
        buttons: ['继续导出', '取消'],
        defaultId: 1,
        cancelId: 1
      });
      if (warn.response !== 0) return false;
    }
  } catch (_) {}

  // 执行导出
  try {
    const { exportLibrary } = require('./exporter.cjs');
    const stats = exportLibrary(targetDir);
    const msg = `导出完成。\n\n成功：${stats.exported} 篇\n失败：${stats.failed} 篇\n总计：${stats.total} 篇\n\n导出位置：${targetDir}`;
    const box = await dialog.showMessageBox({
      type: 'info',
      title: '导出完成',
      message: msg,
      buttons: ['打开文件夹', '关闭'],
      defaultId: 0
    });
    if (box.response === 0) shell.openPath(targetDir);
    return true;
  } catch (err) {
    dialog.showMessageBox({
      type: 'error',
      title: '导出失败',
      message: '导出资料库时出错：\n' + (err.message || err)
    });
    return false;
  }
}

/* ---------- 关于对话框 ---------- */
function showAbout() {
  dialog.showMessageBox({
    type: 'info',
    title: '关于知著 PenMark',
    message: '知著 PenMark',
    detail: '本地优先的个人长期记录软件\n\n数据目录：' + (process.env.PENMARK_DATA_DIR || '未知') + '\n版本：' + app.getVersion()
  });
}

/* ---------- 错误对话框 ---------- */
function showErrorDialog(title, message) {
  try {
    dialog.showErrorBox(title, String(message));
  } catch (_) {}
}

/* ---------- 日志 ---------- */
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    const logDir = path.join(process.env.PENMARK_DATA_DIR || app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'desktop.log'), line);
  } catch (_) {}
  console.log(line.trim());
}

/* ---------- 退出清理 ---------- */
let cleaned = false;
function cleanupAndQuit() {
  if (cleaned) return;
  cleaned = true;
  try {
    if (serverInfo && serverInfo.server) {
      serverInfo.server.close();
    }
  } catch (_) {}
  try {
    const db = require('../db');
    if (db && typeof db.close === 'function') db.close();
  } catch (_) {}
  app.quit();
}
