const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  login: () => ipcRenderer.invoke('login'),
  logout: () => ipcRenderer.invoke('logout'),
  tradeFetch: (opts) => ipcRenderer.invoke('trade-fetch', opts),
  onLoginState: (cb) => ipcRenderer.on('login-state', (_e, data) => cb(data)),
});
