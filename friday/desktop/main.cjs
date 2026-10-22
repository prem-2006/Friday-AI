// Friday's desktop notch: a thin black pill just above the taskbar, like
// Wispr Flow. Hold Caps Lock anywhere to talk (friday/services' keyboard hook
// tells the notch); Friday answers out loud.
//
// The notch is a thin shell around the project folder: it shows Friday's
// #/notch page from the folder's dev server, so any change to the folder shows
// up at once, and this file restarts the shell when it changes itself. No
// reinstall is ever needed. If the app or services are not running, the shell
// starts them (logs go to data/desktop-*.log).
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
} = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const WEB = process.env.FRIDAY_WEB_URL || 'http://localhost:5173';
const API = process.env.FRIDAY_APP_URL || 'http://127.0.0.1:4310';
const SERVICES = process.env.FRIDAY_SERVICES_URL || 'http://127.0.0.1:8765';
const NOTCH = { width: 460, height: 120, gap: 6 };

if (!app.requestSingleInstanceLock()) app.exit(0);

// Friday speaks without anyone clicking first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const children = [];
let notch = null;
let tray = null;

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch {
    return false;
  }
}

function start(name, command, args, cwd) {
  const log = fs.openSync(path.join(REPO, 'data', `desktop-${name}.log`), 'a');
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', log, log],
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  children.push(child);
}

// Starts what is not running yet, and waits until the notch page can load.
async function ensureFriday() {
  fs.mkdirSync(path.join(REPO, 'data'), { recursive: true });
  if (!(await reachable(`${API}/api/workspace`)) || !(await reachable(WEB)))
    start('app', 'npm', ['run', 'dev'], REPO);
  if (!(await reachable(`${SERVICES}/health`)))
    start(
      'services',
      'python',
      ['-m', 'uv', 'run', 'python', '-m', 'friday_services'],
      path.join(REPO, 'friday', 'services'),
    );
  for (let i = 0; i < 120 && !(await reachable(WEB)); i++)
    await new Promise((resolve) => setTimeout(resolve, 1000));
}

function place(window) {
  const { workArea } = screen.getPrimaryDisplay();
  window.setBounds({
    x: Math.round(workArea.x + (workArea.width - NOTCH.width) / 2),
    y: Math.round(workArea.y + workArea.height - NOTCH.height - NOTCH.gap),
    width: NOTCH.width,
    height: NOTCH.height,
  });
}

function openMain(hash = '#/home') {
  void shell.openExternal(`${WEB}/${hash}`);
}

function createNotch() {
  notch = new BrowserWindow({
    width: NOTCH.width,
    height: NOTCH.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false,
    },
  });
  notch.setAlwaysOnTop(true, 'screen-saver');
  // Clicks pass through to whatever is underneath, except on the pill itself.
  notch.setIgnoreMouseEvents(true, { forward: true });
  place(notch);
  notch.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  notch.once('ready-to-show', () => notch.showInactive());
  void notch.loadURL(`${WEB}/#/notch`);
  // If the dev server restarts, load the page again.
  notch.webContents.on('did-fail-load', () =>
    setTimeout(() => notch && void notch.loadURL(`${WEB}/#/notch`), 2000),
  );
}

function trayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Friday: hold Caps Lock to talk');
  const startsWithWindows = () =>
    app.getLoginItemSettings(loginItem()).openAtLogin;
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Open Friday', click: () => openMain('#/home') },
      { label: 'Voice screen', click: () => openMain('#/friday') },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: startsWithWindows(),
        click: (item) =>
          app.setLoginItemSettings({
            ...loginItem(),
            openAtLogin: item.checked,
          }),
      },
      { label: 'Reload', click: () => notch?.reload() },
      { type: 'separator' },
      { label: 'Quit Friday', click: () => app.quit() },
    ]);
  tray.setContextMenu(menu());
  tray.on('click', () => openMain('#/home'));
}

// Starting with Windows runs this same folder through Electron.
function loginItem() {
  return { path: process.execPath, args: [__dirname] };
}

// The shell itself updates by restarting when its own files change.
function watchSelf() {
  let timer;
  for (const file of ['main.cjs', 'preload.cjs'])
    fs.watch(path.join(__dirname, file), () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 500);
    });
}

ipcMain.on('friday:interactive', (_event, on) =>
  notch?.setIgnoreMouseEvents(!on, { forward: true }),
);
ipcMain.on('friday:open', (_event, hash) =>
  openMain(typeof hash === 'string' && hash.startsWith('#/') ? hash : '#/home'),
);

app.whenReady().then(async () => {
  // The mic is for Friday's own pages only.
  const local = (url) => {
    try {
      return ['localhost', '127.0.0.1'].includes(new URL(url).hostname);
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionRequestHandler(
    (contents, permission, allow) =>
      allow(permission === 'media' && local(contents.getURL())),
  );
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission, origin) => permission === 'media' && local(origin),
  );
  createTray();
  await ensureFriday();
  createNotch();
  watchSelf();
  screen.on('display-metrics-changed', () => notch && place(notch));
});

app.on('window-all-closed', () => {
  // The notch lives in the tray; closing windows does not quit it.
});

app.on('before-quit', () => {
  // Stops what the shell started, with everything those started in turn.
  for (const child of children)
    if (child.pid)
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
      });
});
