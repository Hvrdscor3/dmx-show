// Puente seguro entre la página y la app: versión y actualizaciones
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dmxApp', {
  version: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: cb => ipcRenderer.on('update:status', (_e, s) => cb(s)),
  // buscar ShowKontrol en la red local
  skScan: opt => ipcRenderer.invoke('sk:scan', opt),
  // control desde el celular
  remoteStart: key => ipcRenderer.invoke('remote:start', key),
  remoteStop: () => ipcRenderer.invoke('remote:stop'),
  remoteState: s => ipcRenderer.send('remote:state', s),
  onRemote: cb => ipcRenderer.on('remote:cmd', (_e, m) => cb(m))
});
