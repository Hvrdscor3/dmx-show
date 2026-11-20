// DMX Show — app de escritorio (Electron)
// - Sirve la app en http://localhost:8095 (así localStorage y el "modo puente" de ShowKontrol funcionan solos)
// - Puente /sk/<ip:puerto>/... → ShowKontrol
// - Permite Web MIDI sin preguntar
// - Se actualiza sola desde GitHub Releases
const { app, BrowserWindow, session, dialog, powerSaveBlocker, shell, ipcMain } = require('electron');
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

// ---------- control desde el celular (WiFi) ----------
// Servidor aparte en la red local (puerto 8096), solo mientras está activado en Ajustes.
// El celular abre http://<ip-de-la-pc>:8096/?k=<clave> · cada orden lleva la clave.
// Ordenes: POST /api/cmd {t:'scene'|'fader'|'section'|...} → la página (renderer) por IPC.
// Estado:  GET /api/state → lo último que mandó la página (escenas, faders, sección).
const os = require('os');
const REMOTE_PORT = 8096;
const remote = { srv: null, key: '', state: {} };
function lanIps() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
}
function remoteHandler(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/' || u.pathname === '/remote.html') {
    return fs.readFile(path.join(APP_DIR, 'remote.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }); res.end(data);
    });
  }
  if (!u.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
  if (!remote.key || u.searchParams.get('k') !== remote.key) { res.writeHead(403); return res.end(); }
  if (u.pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    return res.end(JSON.stringify(remote.state || {}));
  }
  if (u.pathname === '/api/cmd' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let msg = null; try { msg = JSON.parse(body); } catch (e) {}
      if (!msg || typeof msg.t !== 'string') { res.writeHead(400); return res.end(); }
      if (win && !win.isDestroyed()) win.webContents.send('remote:cmd', msg);
      res.writeHead(204); res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
}
ipcMain.handle('remote:start', (_e, key) => new Promise(resolve => {
  remote.key = String(key || '');
  const done = () => resolve({ ok: true, port: REMOTE_PORT, ips: lanIps() });
  if (remote.srv) return done();
  const srv = http.createServer(remoteHandler);
  srv.on('error', err => { remote.srv = null; resolve({ ok: false, error: err.code || String(err) }); });
  srv.listen(REMOTE_PORT, '0.0.0.0', () => { remote.srv = srv; done(); });
}));
ipcMain.handle('remote:stop', () => { if (remote.srv) { remote.srv.close(); remote.srv = null; } remote.key = ''; return { ok: true }; });
ipcMain.on('remote:state', (_e, s) => { remote.state = s; });

// ---------- búsqueda de ShowKontrol en la red (su IP cambia: DHCP) ----------
// 1) esta PC y las IPs donde ya estuvo · 2) todas las IPs de la red de cada adaptador (según su máscara,
// p. ej. /22 en los TP-Link Deco: 192.168.68.x–71.x) con el puerto abierto · 3) confirma que sea ShowKontrol.
const net = require('net');
const ipToInt = ip => ip.split('.').reduce((a, b) => ((a << 8) + (+b)) >>> 0, 0);
const intToIp = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
function subnetHosts() {
  const hosts = [], nets = [];
  for (const i of Object.values(os.networkInterfaces()).flat()) {
    if (!i || i.family !== 'IPv4' || i.internal || /^169\.254\./.test(i.address)) continue;
    let bits = i.cidr ? +i.cidr.split('/')[1] : 24;
    bits = Math.max(22, Math.min(30, bits || 24));            // máximo 1022 IPs por red
    const mask = (0xFFFFFFFF << (32 - bits)) >>> 0, base = (ipToInt(i.address) & mask) >>> 0, size = 2 ** (32 - bits);
    nets.push(intToIp(base) + '/' + bits);
    for (let k = 1; k < size - 1; k++) hosts.push(intToIp((base + k) >>> 0));
  }
  return { hosts: [...new Set(hosts)], nets: [...new Set(nets)] };
}
function tcpOpen(host, port, ms) {
  return new Promise(res => {
    const s = net.connect({ host, port }); let d = false;
    const fin = v => { if (d) return; d = true; s.destroy(); res(v); };
    s.setTimeout(ms, () => fin(false)); s.once('connect', () => fin(true)); s.once('error', () => fin(false));
  });
}
function skInfo(host, port, ms) {
  return new Promise(res => {
    const rq = http.get({ host, port, path: '/api/v1', timeout: ms, headers: { accept: 'application/json' } }, r => {
      let b = ''; r.setEncoding('utf8');
      r.on('data', c => { b += c; if (b.length > 65536) rq.destroy(); });
      r.on('end', () => { try { const j = JSON.parse(b); res(j && /showkontrol/i.test(j.name || '') ? j : null); } catch (e) { res(null); } });
    });
    rq.on('timeout', () => { rq.destroy(); res(null); }); rq.on('error', () => res(null));
  });
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
let skScanBusy = null;
ipcMain.handle('sk:scan', (_e, opt) => {
  if (skScanBusy) return skScanBusy;
  skScanBusy = (async () => {
    const port = +(opt && opt.port) || 8090;
    const hints = [...new Set(((opt && opt.hints) || []).map(String).filter(h => /^\d+\.\d+\.\d+\.\d+$/.test(h)))];
    const { hosts, nets } = subnetHosts();
    for (const h of ['127.0.0.1', ...hints]) { const j = await skInfo(h, port, 700); if (j) return { found: [{ host: h + ':' + port, info: j }], nets }; }
    const open = []; await pool(hosts, 256, async h => { if (await tcpOpen(h, port, 450)) open.push(h); });
    const found = []; await pool(open, 16, async h => { const j = await skInfo(h, port, 1500); if (j) found.push({ host: h + ':' + port, info: j }); });
    return { found, nets, open: open.filter(h => !found.some(f => f.host.startsWith(h + ':'))) };
  })();
  return skScanBusy.finally(() => { skScanBusy = null; });
});

// ---------- ventana ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#06080e',
    autoHideMenuBar: true,
    title: 'DMX Show ' + app.getVersion(),
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  });
  win.maximize();
  win.on('page-title-updated', e => { e.preventDefault(); });
  // enlaces externos → navegador del sistema
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith('http://localhost:' + PORT)) shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL('http://localhost:' + PORT + '/');
}

// ---------- actualización automática ----------
// estado que ve la página: {state:'checking'|'latest'|'available'|'downloading'|'ready'|'error'|'dev', version, percent}
let upd = { state: 'idle' };
function sendUpd(s) { upd = s; if (win && !win.isDestroyed()) win.webContents.send('update:status', s); }

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:install', () => { if (upd.state === 'ready') autoUpdater.quitAndInstall(); });
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) { sendUpd({ state: 'dev' }); return upd; }
  if (upd.state === 'ready' || upd.state === 'downloading') { sendUpd(upd); return upd; }
  try { await autoUpdater.checkForUpdates(); } catch (e) { sendUpd({ state: 'error' }); }
  return upd;
});

let askedFor = null;
function setupUpdates() {
  if (!app.isPackaged) return; // en desarrollo (npm start) no busca
  autoUpdater.autoDownload = true;          // descarga en segundo plano
  autoUpdater.autoInstallOnAppQuit = true;  // si no reinicias, se instala al cerrar la app
  autoUpdater.on('checking-for-update', () => { if (upd.state !== 'ready' && upd.state !== 'downloading') sendUpd({ state: 'checking' }); });
  autoUpdater.on('update-not-available', () => sendUpd({ state: 'latest' }));
  autoUpdater.on('update-available', info => sendUpd({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', p => sendUpd({ state: 'downloading', version: upd.version, percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', async info => {
    sendUpd({ state: 'ready', version: info.version });
    if (askedFor === info.version) return; // solo pregunta una vez por versión
    askedFor = info.version;
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
  autoUpdater.on('error', () => { if (upd.state !== 'ready') sendUpd({ state: 'error' }); }); // sin internet: sigue funcionando normal
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
