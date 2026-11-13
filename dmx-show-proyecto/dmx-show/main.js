// DMX Show — app de escritorio (Electron)
// - Sirve la app en http://localhost:8095 (así localStorage y el "modo puente" de ShowKontrol funcionan solos)
// - Puente /sk/<ip:puerto>/... → ShowKontrol (reemplaza a "Abrir DMX Show.bat")
// - Permite Web MIDI sin preguntar
// - Se actualiza sola desde GitHub Releases
const { app, BrowserWindow, session, dialog, powerSaveBlocker, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { autoUpdater } = require('electron-updater');

const PORT = 8095; // la página detecta el puente por este puerto: no cambiarlo
const APP_DIR = path.join(__dirname, 'app');

// el reloj del show no debe frenarse cuando la ventana queda detrás de Pro DMX
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;

// ---------- servidor local + puente a ShowKontrol ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function proxyShowKontrol(req, res) {
  // /sk/192.168.68.51:8090/api/v1/state  →  http://192.168.68.51:8090/api/v1/state
  const m = req.url.match(/^\/sk\/([^/]+)(\/.*)?$/);
  if (!m) { res.writeHead(400); return res.end(); }
  const [host, port] = decodeURIComponent(m[1]).split(':');
  if (!/^[\w.-]+$/.test(host || '')) { res.writeHead(400); return res.end(); }
  const timeout = Math.min(10000, Math.max(200, parseInt(req.headers['x-timeout'], 10) || 1500));
  let done = false;
  const up = http.request({ host, port: +port || 8090, path: m[2] || '/', method: 'GET', headers: { accept: req.headers.accept || '*/*' } }, r => {
    done = true;
    res.writeHead(r.statusCode || 502, { 'content-type': r.headers['content-type'] || 'application/octet-stream', 'cache-control': 'no-store' });
    r.pipe(res);
  });
  up.setTimeout(timeout, () => { if (!done) { done = true; up.destroy(); res.writeHead(504); res.end(); } });
  up.on('error', () => { if (!done) { done = true; res.writeHead(502); res.end(); } });
  up.end();
}

function serveFile(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(APP_DIR, p));
  if (!file.startsWith(APP_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/sk/')) return proxyShowKontrol(req, res);
      serveFile(req, res);
    });
    srv.on('error', reject);
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

// ---------- ventana ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#06080e',
    autoHideMenuBar: true,
    title: 'DMX Show ' + app.getVersion(),
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false }
  });
  win.maximize();
  win.on('page-title-updated', e => { e.preventDefault(); });
  // enlaces externos → navegador del sistema
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith('http://localhost:' + PORT)) shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL('http://localhost:' + PORT + '/');
}

// ---------- actualización automática ----------
function setupUpdates() {
  if (!app.isPackaged) return; // en desarrollo (npm start) no busca
  autoUpdater.autoDownload = true;          // descarga en segundo plano
  autoUpdater.autoInstallOnAppQuit = true;  // si no reinicias, se instala al cerrar la app
  autoUpdater.on('update-downloaded', async info => {
    // nunca reinicia sola: puede haber un show en curso
    const r = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Reiniciar ahora', 'Al cerrar la app'],
      defaultId: 1, cancelId: 1,
      title: 'Actualización lista',
      message: 'DMX Show ' + info.version + ' está lista.',
      detail: 'Si estás en pleno show, elige "Al cerrar la app" y se instalará la próxima vez que la cierres.'
    });
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', () => {}); // sin internet: sigue funcionando normal
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  // Web MIDI: permitir sin preguntar
  const allow = ['midi', 'midiSysex', 'clipboard-sanitized-write', 'clipboard-read'];
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allow.includes(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => allow.includes(perm));

  try { await startServer(); }
  catch (e) {
    dialog.showErrorBox('DMX Show', 'El puerto ' + PORT + ' ya está en uso.\nCierra "Abrir DMX Show.bat" (o la otra ventana de DMX Show) y vuelve a abrir la app.');
    app.quit(); return;
  }
  powerSaveBlocker.start('prevent-display-sleep'); // que la PC no se duerma en pleno show
  createWindow();
  setupUpdates();
});

app.on('window-all-closed', () => app.quit());
