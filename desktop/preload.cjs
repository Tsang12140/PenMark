// 知著 PenMark 桌面版 — preload 脚本
// 在 contextIsolation 下通过 contextBridge 暴露最小桌面 API
// 不暴露 Node.js 能力、不暴露 ipcRenderer 原始对象
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  // 标识：前端可通过 window.desktop.isDesktop 判断是否运行在桌面环境
  isDesktop: true,

  // 获取数据目录路径
  getDataDir: () => ipcRenderer.invoke('desktop:getDataDir'),

  // 在系统文件管理器中打开数据目录
  openDataDir: () => ipcRenderer.invoke('desktop:openDataDir'),

  // 备份数据库（弹出保存对话框）
  backup: () => ipcRenderer.invoke('desktop:backup'),

  // 导出整个资料库为 Markdown 文件夹
  exportLibrary: () => ipcRenderer.invoke('desktop:exportLibrary'),

  // 用系统默认浏览器打开外部链接
  openExternal: (url) => ipcRenderer.invoke('desktop:openExternal', url),

  // 菜单事件（由主进程触发）
  onMenuNewDoc: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('menu:new-doc', handler);
    return () => ipcRenderer.removeListener('menu:new-doc', handler);
  },
  onMenuShortcuts: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('menu:shortcuts', handler);
    return () => ipcRenderer.removeListener('menu:shortcuts', handler);
  },
  onLibraryImported: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('desktop:library-imported', handler);
    return () => ipcRenderer.removeListener('desktop:library-imported', handler);
  }
});
