// Saktah: Electron main process.
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, session, screen } = require('electron');
const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

// The API key comes from the environment or a local .env.local file next to
// package.json. It is never written anywhere by the app.
function readApiKey() {
  if (process.env.SMARTSPECTRA_API_KEY) return process.env.SMARTSPECTRA_API_KEY.trim();
  const file = path.join(app.getAppPath(), '.env.local');
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*SMARTSPECTRA_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/);
      if (m) return m[1];
    }
  } catch {
    // No file: the app asks for the key on its first screen instead.
  }
  return '';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: 'Saktah',
    backgroundColor: '#f4efe4',
    autoHideMenuBar: true,
    webPreferences: {
      preload: require.resolve('@smartspectra/node-sdk/preload'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep judging phrases if the window is covered by another one.
      backgroundThrottling: false,
    },
  });

  bindSmartSpectraIpc(win);

  // Screen recording for the demo (SAKTAH_PIN="x,y"): put the page at a fixed
  // spot, keep it there and on top, so the recorded area never drifts.
  const pin = (process.env.SAKTAH_PIN || '').match(/^(\d+),(\d+)$/);
  if (pin) {
    win.setContentBounds({ x: Number(pin[1]), y: Number(pin[2]), width: 1264, height: 781 });
    win.setMovable(false);
    win.setResizable(false);
    win.setAlwaysOnTop(true);
  }

  // Let the page stop the SDK engine before the window and process go away;
  // closing with frames still in flight crashed the native module.
  let closing = false;
  win.on('close', (e) => {
    if (closing) return;
    e.preventDefault();
    closing = true;
    const timeout = new Promise((r) => setTimeout(r, 8000));
    Promise.race([win.webContents.executeJavaScript('window.__saktahShutdown ? window.__saktahShutdown() : true'), timeout])
      .catch(() => {})
      .finally(() => win.destroy());
  });

  // Only ever show the bundled page.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const key = readApiKey();
  const dev = process.env.SAKTAH_DEV === '1';
  const query = {};
  if (key) query.key = key;
  if (dev) query.dev = '1';
  if (dev && /^\d+x\d+$/.test(process.env.SAKTAH_CAPTURE || '')) query.cap = process.env.SAKTAH_CAPTURE;
  if (process.env.SAKTAH_BLUR === '1') query.blur = '1';
  if (dev && process.env.SAKTAH_CALIB) query.calib = process.env.SAKTAH_CALIB;
  if (dev && /^\d+$/.test(process.env.SAKTAH_POS || '')) query.pos = process.env.SAKTAH_POS;
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });

  // Developer snapshot of the first screen (SAKTAH_SNAP=out.png), then quit.
  if (process.env.SAKTAH_SNAP) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.SAKTAH_SNAP, img.toPNG());
      app.quit();
    }, 1500));
  }

  if (process.env.SAKTAH_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  // Developer recordings (SAKTAH_DEV=1): per-phrase signal windows and full
  // exports arrive as console lines and are appended to ./recordings
  // (git-ignored). Breathing trace and talking flags only: no video exists.
  // Developer log: where the page sits on screen, in physical pixels, so a
  // screen recorder can capture exactly the app.
  if (process.env.SAKTAH_LOG === '1') {
    const where = () => {
      const r = screen.dipToScreenRect(win, win.getContentBounds());
      console.log(`${Date.now()} WINDOW ${r.x} ${r.y} ${r.width} ${r.height}`);
    };
    win.once('ready-to-show', where);
    win.on('moved', where);
    win.on('resized', where);
  }
  const recFile = path.join(app.getAppPath(), 'recordings', `session-${Date.now()}.jsonl`);
  const log = process.env.SAKTAH_LOG === '1';
  win.webContents.on('console-message', (e) => {
    const message = String(e.message || '');
    const m = message.match(/^SAKTAH_(PHRASE|EXPORT) /);
    if (m) {
      if (!dev) return;
      fs.mkdirSync(path.dirname(recFile), { recursive: true });
      fs.appendFileSync(recFile, JSON.stringify({ kind: m[1].toLowerCase(), data: JSON.parse(message.slice(m[0].length)) }) + '\n');
      if (log) console.log(`[recordings] ${m[1].toLowerCase()} -> ${path.basename(recFile)}`);
      return;
    }
    // Developer log: mirror the page console to stdout (SAKTAH_LOG=1).
    if (log) console.log(`${Date.now()} [renderer:${e.level}] ${message}`);
  });
}

app.whenReady().then(() => {
  // Camera only (no microphone), and only for the bundled local page.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    const types = (details && details.mediaTypes) || [];
    const cameraOnly = types.length === 1 && types[0] === 'video';
    callback(permission === 'media' && cameraOnly && url.startsWith('file://'));
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // The SDK finishes its native teardown just after the window closes; quit
  // once that has had time to run.
  if (process.platform !== 'darwin') setTimeout(() => app.quit(), 1500);
});
