// Piupiu 桌面版启动器（Electron 主进程）：
//   1. 只允许运行一个实例（再次打开就把已有窗口提到前面）
//   2. 用 App 自带的 Node（ELECTRON_RUN_AS_NODE）在后台启动 Gateway（内核：server.js + 界面），
//      安装版模式（PIUPIU_APP=1）：数据在系统用户目录，随机本机端口、只监听 127.0.0.1
//   3. Gateway 就绪后打开窗口；退出时一起关掉 Gateway
//   4. 自动更新（updater.cjs）：内核后台下载 + 验签，「重启更新」后生效，新版起不来自动退回；
//      外壳 Windows 静默安装、Mac 打开下载页
// 安全：窗口开隔离、禁止网页使用 Node、开沙箱、拒绝一切权限请求；只允许停留在本机 Gateway 的页面，
// 外部链接一律交给系统浏览器——链上有人把网页攻击代码写进代币名，界面万一渲染出来也碰不到本机。
const { app, BrowserWindow, Menu, dialog, shell, session, nativeTheme, nativeImage, ipcMain } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const up = require('./updater.cjs');

const PRODUCT = 'Piupiu';
const PKG = require('./package.json');
// 和 Gateway 的 APP_HOME 一致（engine/live/config.js）：macOS ~/Library/Application Support/Piupiu，Windows %APPDATA%\Piupiu
const HOME = process.env.PIUPIU_HOME || path.join(app.getPath('appData'), PRODUCT);
app.setPath('userData', path.join(HOME, 'electron'));   // Electron 自己的缓存放子目录，不和 Gateway 的 data/ 混在一起
const LOG_DIR = path.join(HOME, 'logs');
const CORE_DIR = path.join(HOME, 'core');      // 自动更新下载的内核
const UPD_DIR = path.join(HOME, 'update');     // 更新状态（status.json 给 Gateway / 界面看）、外壳安装包、更新地址
const PUBKEY = fs.readFileSync(path.join(__dirname, 'update-pubkey.pem'), 'utf8');
const SHELL_VERSION = app.getVersion();
const EXIT_RESTART = 75, EXIT_INSTALL_SHELL = 76;   // Gateway 用这两个退出码请求「重启更新」/「安装新外壳」

// 打包后 Gateway 和 npm 在 resources/ 下（extraResources，不进 asar：子进程要直接读这些文件）；开发时用 desktop/build/
const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'build');
const BUNDLED = path.join(RES, 'gateway');
const BUNDLED_VERSION = JSON.parse(fs.readFileSync(path.join(BUNDLED, 'package.json'), 'utf8')).version;
const NPM_CLI = path.join(RES, 'npm', 'bin', 'npm-cli.js');

// 更新地址：环境变量（测试用）> 签名清单里迁移过的地址 > 安装包内置
const updateBase = () => {
  if (process.env.PIUPIU_UPDATE_BASE) return process.env.PIUPIU_UPDATE_BASE.replace(/\/?$/, '/');
  try { const b = fs.readFileSync(path.join(UPD_DIR, 'base.txt'), 'utf8').trim(); if (/^https:\/\//.test(b)) return b.replace(/\/?$/, '/'); } catch { /* 没迁移过 */ }
  return String(PKG.piupiu?.updateBase || '').replace(/\/?$/, '/');
};

let win = null, gw = null, port = 0, quitting = false, core = null, startedAt = 0, restarting = false;
// downloading = 正在下载的包（{ kind, version, got, total }），checking = 正在检查；界面据此在右下角显示进度
const status = { shellVersion: SHELL_VERSION, coreVersion: null, coreOta: false, coreReady: null, shell: null, checkedAt: null, error: null, checking: false, downloading: null };
const writeStatus = () => { try { fs.mkdirSync(UPD_DIR, { recursive: true }); fs.writeFileSync(path.join(UPD_DIR, 'status.json'), JSON.stringify(status)); } catch { /* 下次再写 */ } };
const log = (m) => { try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(path.join(LOG_DIR, 'updater.log'), `${new Date().toISOString()} ${m}\n`); } catch { /* 忽略 */ } };

if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// 系统代理（含 PAC 规则）：浏览器界面自动走，但后台服务是独立的 Node 进程不会。读出系统对币安的代理决定，
// 交给后台服务（NODE_USE_ENV_PROXY 让 fetch / http 认 HTTPS_PROXY）。只支持 HTTP / HTTPS 代理；SOCKS 无法用，须开增强模式（TUN）。
// PIUPIU_PROXY=off 强制直连，PIUPIU_PROXY=http://… 手动指定。
async function proxyEnv() {
  try {
    const manual = process.env.PIUPIU_PROXY;
    let url = null;
    if (manual) url = /^(off|none|direct)$/i.test(manual) ? null : (/^[a-z]+:\/\//i.test(manual) ? manual : `http://${manual}`);
    else if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
      const r = await session.defaultSession.resolveProxy('https://www.binance.com/');
      const m = /^(?:PROXY|HTTPS?)\s+([^\s;]+)/i.exec(String(r || '').trim());
      if (m) url = `http://${m[1]}`;
    }
    if (!url) return {};
    log(`后台服务使用代理 ${url.replace(/\/\/[^@]*@/, '//***@')}`);
    return { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: 'localhost,127.0.0.1,::1' };
  } catch (e) { log(`读取系统代理失败：${e.message}`); return {}; }
}

function startGateway(extraEnv = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.openSync(path.join(LOG_DIR, 'gateway.log'), 'a');
  fs.writeSync(out, `\n===== ${new Date().toISOString()} 启动 Gateway ${core.version}${core.ota ? '（自动更新的内核）' : ''}，端口 ${port} =====\n`);
  startedAt = Date.now();
  const child = gw = spawn(process.execPath, [path.join(core.dir, 'server.js')], {
    cwd: core.dir,
    // 用户的环境变量照常继承（高级用户可以覆盖 MODE / LIVE_TRADE 等）；这几项由启动器决定
    env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '1', PIUPIU_APP: '1', PIUPIU_HOME: HOME, PIUPIU_NPM_CLI: NPM_CLI, PIUPIU_SHELL_VERSION: SHELL_VERSION, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.on('exit', (code, sig) => {
    if (gw === child) gw = null;
    if (quitting || restarting) return;
    if (code === EXIT_RESTART) return restart('用户点了重启更新');
    if (code === EXIT_INSTALL_SHELL) return installShell();
    // 自动更新的内核 30 秒内就退出：当成坏版本，退回上一个
    if (core.ota && Date.now() - startedAt < 30_000) { log(`内核 ${core.version} 启动后很快退出（${code ?? sig}），标记为坏版本并退回`); up.markBad(CORE_DIR, core.version); return restart('退回上一个版本'); }
    const r = dialog.showMessageBoxSync({ type: 'error', title: PRODUCT, message: 'Piupiu 后台服务意外退出', detail: `退出码 ${code ?? sig}。日志：${path.join(LOG_DIR, 'gateway.log')}`, buttons: ['重新启动', '退出'], defaultId: 0 });
    if (r === 0) boot(); else app.quit();
  });
}

async function waitReady(ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!gw) throw new Error('后台服务没有启动成功');
    try { const r = await fetch(`http://127.0.0.1:${port}/api/ping`); if (r.ok) return; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('后台服务启动超时');
}

const ORIGIN = () => `http://127.0.0.1:${port}`;
// 窗口底色跟随用户选的主题（data/prefs.json 的 state.theme），界面加载前不闪另一种颜色
const PREFS_FILE = path.join(HOME, 'data', 'prefs.json');
const savedTheme = () => { try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')).state?.theme === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } };   // 没保存过设置时默认黑暗
// Windows：和 mac 一样隐藏系统标题栏（也没有菜单栏）；最小化 / 最大化 / 关闭三个按钮由界面顶栏自己画（preload.cjs 开放这三个动作），
// 大小和间距与顶栏里其他图标按钮一致，不用系统叠加按钮（它们每个 46px 宽、占满顶栏高度，和顶栏其他控件不协调）
const fromOurWindow = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;
ipcMain.on('win:minimize', (e) => { if (fromOurWindow(e)) win.minimize(); });
ipcMain.on('win:toggle-maximize', (e) => { if (fromOurWindow(e)) (win.isMaximized() ? win.unmaximize() : win.maximize()); });
ipcMain.on('win:close', (e) => { if (fromOurWindow(e)) win.close(); });
ipcMain.handle('win:is-maximized', (e) => fromOurWindow(e) && win.isMaximized());
// 设置里的「检查更新」：立刻检查，返回检查后的状态
ipcMain.handle('app:check-updates', async (e) => { if (!fromOurWindow(e)) return null; await checkUpdates(); return status; });
function windowBg() { return savedTheme() === 'dark' ? '#121212' : '#f4f2ec'; }
// 应用图标（设置 → 外观 → 应用图标：白色 / 黑色，data/prefs.json 的 state.appIcon）。mac 换 Dock 图标，Windows 换窗口和任务栏图标；
// 安装包本身的图标（访达、开始菜单）是白色，不随设置变
const savedIcon = () => { try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')).state?.appIcon === 'black' ? 'black' : 'white'; } catch { return 'white'; } };
let iconNow = null;
function applyIcon(force = false) {
  const c = savedIcon();
  if (c === iconNow && !force) return;
  try {
    // Windows 用裁掉留白的版本：mac 图标按苹果规范四周留 10% 空白，Windows 任务栏不会再加底板，留白会让图标只有一半大
    const img = nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, 'icons', `icon-${c}${process.platform === 'win32' ? '-win' : ''}.png`)));
    if (process.platform === 'darwin') app.dock?.setIcon(img);
    else if (win && !win.isDestroyed()) win.setIcon(img);
    iconNow = c;
  } catch (e) { log(`应用图标切换失败：${e.message}`); }
}
// 系统控件（mac 红绿灯、Windows 标题栏、右键菜单）跟随界面主题：界面改主题 → Gateway 写 data/prefs.json → 这里读到后切换
function followTheme() {
  const apply = () => { nativeTheme.themeSource = savedTheme(); if (win && !win.isDestroyed()) win.setBackgroundColor(windowBg()); applyIcon(); };
  apply();
  let t = null;
  try { fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true }); fs.watch(path.dirname(PREFS_FILE), (ev, f) => { if (f === 'prefs.json') { clearTimeout(t); t = setTimeout(apply, 200); } }); } catch { /* 监听不了就只在启动时应用 */ }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 680, show: false, backgroundColor: windowBg(), title: PRODUCT,
    // mac：隐藏系统标题栏，红绿灯放进界面的顶栏里（顶栏左边留出位置、可拖动窗口，见 web/src/index.css 的 .mac-shell）
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 22 } } : {}),
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden' } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  // 外部链接（BscScan、OKX、X、下载页…）交给系统浏览器；页面只能停留在本机 Gateway
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url) && !url.startsWith(ORIGIN())) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN())) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } });
  if (process.platform === 'win32') {
    // 不显示菜单栏（编辑 / 视图 / 窗口）：复制粘贴本来就是系统快捷键；刷新与缩放的快捷键在这里补上
    win.removeMenu();
    const sendMax = () => { if (win && !win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized()); };
    win.on('maximize', sendMax); win.on('unmaximize', sendMax);
    win.webContents.on('before-input-event', (e, i) => {
      if (i.type !== 'keyDown') return;
      const wc = win.webContents;
      if (i.key === 'F5' || (i.control && i.key.toLowerCase() === 'r')) { e.preventDefault(); wc.reload(); }
      else if (i.control && (i.key === '=' || i.key === '+')) { e.preventDefault(); wc.setZoomLevel(wc.getZoomLevel() + 0.5); }
      else if (i.control && i.key === '-') { e.preventDefault(); wc.setZoomLevel(wc.getZoomLevel() - 0.5); }
      else if (i.control && i.key === '0') { e.preventDefault(); wc.setZoomLevel(0); }
    });
  }
  win.once('ready-to-show', () => { win.show(); if (process.platform !== 'darwin') applyIcon(true); });
  win.on('focus', () => { if (!status.checking && Date.now() - (status.checkedAt || 0) > 10 * 60_000) checkUpdates(); });
  win.on('closed', () => { win = null; });
  win.loadURL(`${ORIGIN()}/`);
}

let themeFollowed = false;
async function boot() {
  if (!themeFollowed) { themeFollowed = true; followTheme(); }
  core = up.pickCore({ coreDir: CORE_DIR, bundledDir: BUNDLED, bundledVersion: BUNDLED_VERSION });
  Object.assign(status, { coreVersion: core.version, coreOta: core.ota, coreReady: null }); writeStatus();
  try {
    port = await freePort();
    startGateway(await proxyEnv());
    await waitReady();
    if (core.ota) { up.markGood(CORE_DIR, core.version); up.cleanup(CORE_DIR); }
    if (win) win.loadURL(`${ORIGIN()}/`); else createWindow();
  } catch (e) {
    if (core.ota) { log(`内核 ${core.version} 没能启动（${e.message}），退回上一个版本`); up.markBad(CORE_DIR, core.version); await stopGateway(); return boot(); }
    dialog.showErrorBox(PRODUCT, `${e.message}\n日志：${path.join(LOG_DIR, 'gateway.log')}`);
    quitting = true; gw?.kill(); app.quit();
  }
}

async function restart(why) {
  log(`重启后台服务：${why}`);
  restarting = true;
  await stopGateway();
  restarting = false;
  await boot();
}

function stopGateway() {
  if (!gw) return Promise.resolve();
  return new Promise((resolve) => {
    const p = gw; const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* 已退出 */ } resolve(); }, 5000);
    p.once('exit', () => { clearTimeout(t); resolve(); });
    try { p.kill('SIGTERM'); } catch { clearTimeout(t); resolve(); }
  });
}

// ---------- 自动更新 ----------
async function fetchSigned(name, kind) {
  const base = updateBase();
  if (!base) throw new Error('没有配置更新地址');
  const [b, s] = await Promise.all([`${base}update/${name}`, `${base}update/${name}.sig`].map(async (u) => {
    const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${u} → HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }));
  const m = up.verifyManifest(b, s.toString('utf8'), PUBKEY, kind);
  // 只有签名清单能迁移更新地址（以后换成 Piupiu 自己的域名时用）
  if (m.moveTo && /^https:\/\/[^\s]+$/.test(m.moveTo) && m.moveTo !== base) { fs.mkdirSync(UPD_DIR, { recursive: true }); fs.writeFileSync(path.join(UPD_DIR, 'base.txt'), m.moveTo); log(`更新地址迁移到 ${m.moveTo}`); }
  return { m, base };
}

// 下载（续传、重试、校验见 updater.cjs 的 downloadFile）；进度写进 status.downloading，界面右下角显示百分比
async function download(url, dest, sha256, size, label) {
  let lastWrite = 0;
  try {
    await up.downloadFile(url, dest, { sha256, size, log, onProgress: (got) => { status.downloading = { ...label, got, total: size || null }; if (Date.now() - lastWrite > 1000) { lastWrite = Date.now(); writeStatus(); } } });
  } finally { status.downloading = null; writeStatus(); }
}

const untar = (file, dir) => new Promise((resolve, reject) => {
  fs.mkdirSync(dir, { recursive: true });
  execFile('tar', ['-xzf', file, '-C', dir], { windowsHide: true, timeout: 5 * 60_000 }, (e) => (e ? reject(e) : resolve()));
});

async function checkCore() {
  const { m, base } = await fetchSigned('core.json', 'core');
  const st = up.readState(CORE_DIR);
  if (up.cmpVer(m.version, core.version) <= 0) return;                         // 不比现在新：不要（也挡住拿旧清单降级）
  if ((st.bad || []).includes(m.version)) return;
  if (m.minShell && up.cmpVer(SHELL_VERSION, m.minShell) < 0) { status.shellNeeded = m.minShell; return; }   // 新内核要求更新的外壳
  if (st.pending === m.version && fs.existsSync(path.join(CORE_DIR, m.version, 'server.js'))) { status.coreReady = m.version; return; }
  const tgz = path.join(UPD_DIR, m.file), tmp = path.join(CORE_DIR, `${m.version}.tmp-${Date.now()}`), dst = path.join(CORE_DIR, m.version);
  log(`下载内核 ${m.version}`);
  await download(`${base}update/${m.file}`, tgz, m.sha256, m.size, { kind: 'core', version: m.version });
  await untar(tgz, tmp);
  const inner = fs.existsSync(path.join(tmp, 'server.js')) ? tmp : path.join(tmp, 'gateway');
  if (!fs.existsSync(path.join(inner, 'server.js'))) throw new Error('内核包内容不对');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.renameSync(inner, dst);
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(tgz, { force: true });
  up.writeState(CORE_DIR, { ...up.readState(CORE_DIR), pending: m.version });
  status.coreReady = m.version; status.coreNotes = m.notes || '';
  log(`内核 ${m.version} 已就绪，等待重启生效`);
}

async function checkShell() {
  const { m, base } = await fetchSigned('shell.json', 'shell');
  if (up.cmpVer(m.version, SHELL_VERSION) <= 0) { status.shell = null; return; }
  const plat = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : null;
  const asset = plat && m[plat]?.[process.arch];
  status.shell = { version: m.version, page: m.page || base, notes: m.notes || '', action: plat === 'win' && asset ? 'install' : 'download', ready: false };
  if (plat === 'win' && asset) {   // Windows：后台先把安装包下好并核对，点「安装」时立刻开始
    const dest = path.join(UPD_DIR, asset.file);
    if (!fs.existsSync(dest) || up.sha256File(dest) !== asset.sha256) await download(`${base}download/${asset.file}`, dest, asset.sha256, asset.size, { kind: 'shell', version: m.version });
    status.shell.ready = true; status.shell.file = dest;
  }
}

let checking = null;
// 检查更新：启动 20 秒后、之后每 30 分钟、窗口回到前台（距上次超过 10 分钟）时各查一次；设置里的「检查更新」随时查。
// 清单只有 1 KB 左右，查得勤也几乎没有成本
function checkUpdates() {
  if (!updateBase()) return Promise.resolve();
  if (!checking) checking = runCheck().finally(() => { checking = null; });
  return checking;
}
async function runCheck() {
  status.checking = true; status.error = null; writeStatus();
  try {
    for (const [name, fn] of [['内核', checkCore], ['外壳', checkShell]]) {
      try { await fn(); } catch (e) { status.error = `${name}更新检查失败：${e.message}`; log(status.error); }
    }
    status.checkedAt = Date.now();
  } finally { status.checking = false; writeStatus(); }
}

function installShell() {
  const f = status.shell?.file;
  if (process.platform !== 'win32' || !f || !fs.existsSync(f)) { log('没有可安装的外壳更新'); return restart('外壳安装包不在'); }
  log(`安装外壳 ${status.shell.version}`);
  // NSIS 静默安装，装完自动重新打开（--force-run）；先退出自己，安装程序才能替换文件
  spawn(f, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  quitting = true; app.quit();
}

app.whenReady().then(async () => {
  // 拒绝一切权限请求（摄像头、麦克风、定位、通知、剪贴板读取…）；界面用不到
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  // 菜单：保留编辑（复制 / 粘贴合约地址要用）、视图缩放、窗口
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: '视图', submenu: [{ role: 'reload', label: '刷新' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' }, { role: 'toggleDevTools', label: '开发者工具' }] },
    { role: 'windowMenu' },
  ]));
  await boot();
  // 启动 20 秒后检查一次，之后每 30 分钟
  setTimeout(checkUpdates, Number(process.env.PIUPIU_UPDATE_FIRST_MS || 20_000));
  setInterval(checkUpdates, 30 * 60_000);
});

// 关掉窗口就退出（后台服务一起关）：自动功能（狙击、跟单、条件单、自动转出）只在 App 开着时运行
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (e) => {
  if (!gw) return;
  e.preventDefault(); quitting = true;
  stopGateway().then(() => app.quit());
});
