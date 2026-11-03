// 预加载脚本（沙盒内）：只向界面开放窗口的最小化 / 最大化 / 关闭，供 Windows 顶栏里自绘的三个按钮使用。
// 界面拿不到 ipcRenderer 本身，也无法发送别的消息。
const { contextBridge, ipcRenderer } = require('electron');
// 检查更新（所有平台）：设置里的「检查更新」按钮用
contextBridge.exposeInMainWorld('piupiuApp', { checkUpdates: () => ipcRenderer.invoke('app:check-updates') });
// 窗口按钮只在 Windows 开放：Mac 用系统红绿灯，界面不该再画一套窗口按钮
if (process.platform === 'win32') contextBridge.exposeInMainWorld('piupiuWindow', {
  minimize: () => ipcRenderer.send('win:minimize'),
  toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onMaximizeChange: (cb) => { const h = (_e, v) => cb(!!v); ipcRenderer.on('win:maximized', h); return () => ipcRenderer.removeListener('win:maximized', h); },
});
