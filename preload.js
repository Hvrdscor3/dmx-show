// Puente seguro entre la página y la app: versión y actualizaciones
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dmxApp', {
  version: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: cb => ipcRenderer.on('update:status', (_e, s) => cb(s))
});
