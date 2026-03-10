import { app, BrowserWindow, ipcMain, session, net } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = app.getPath('userData');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try { return existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) : {}; }
  catch { return {}; }
}
function saveConfig(cfg) { writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n'); }

let mainWindow = null;
let loginWindow = null;
let loginState = { loggedIn: false, accountName: null };

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 960,
    minWidth: 480,
    minHeight: 600,
    title: 'Path of Ascent',
    backgroundColor: '#06070a',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'electron-preload.js'),
    },
  });

  mainWindow.loadFile(join(__dirname, 'dist', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function openLoginWindow() {
  if (loginWindow) { loginWindow.focus(); return; }

  loginWindow = new BrowserWindow({
    width: 1100, height: 800,
    title: 'Log in to Path of Exile',
    parent: mainWindow,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  loginWindow.loadURL('https://www.pathofexile.com/login');

  const pollInterval = setInterval(async () => {
    if (!loginWindow || loginWindow.isDestroyed()) { clearInterval(pollInterval); return; }
    try {
      const cookies = await session.defaultSession.cookies.get({ domain: '.pathofexile.com' });
      const poesessid = cookies.find(c => c.name === 'POESESSID');
      if (poesessid) {
        loginState.loggedIn = true;
        saveConfig({ ...loadConfig(), poesessid: poesessid.value });
        console.log('Login detected — POESESSID captured');

        try {
          const name = await loginWindow.webContents.executeJavaScript(
            `(document.querySelector('.profile-link a, .account-name')?.textContent?.trim()) || null`
          );
          if (name) loginState.accountName = name;
        } catch {}

        clearInterval(pollInterval);
        // Warm the CF session on trade page, then close
        loginWindow.loadURL('https://www.pathofexile.com/trade/search/Standard');
        setTimeout(() => { if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close(); }, 4000);

        // Notify main window
        if (mainWindow) mainWindow.webContents.send('login-state', { loggedIn: true, accountName: loginState.accountName });
      }
    } catch {}
  }, 2000);

  loginWindow.on('closed', () => { loginWindow = null; clearInterval(pollInterval); });
}

async function restoreSession() {
  const cfg = loadConfig();
  if (!cfg.poesessid) return false;
  try {
    await session.defaultSession.cookies.set({
      url: 'https://www.pathofexile.com',
      name: 'POESESSID', value: cfg.poesessid,
      domain: '.pathofexile.com', path: '/',
    });
    loginState.loggedIn = true;
    console.log('Session restored from saved POESESSID');
    return true;
  } catch (err) {
    console.error('Restore failed:', err.message);
    return false;
  }
}

// Trade API proxy using Electron's net module (uses session cookies automatically)
function tradeFetch(url, method, body) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method, url, useSessionCookies: true });
    request.setHeader('Content-Type', 'application/json');
    request.setHeader('Accept', 'application/json');

    let responseBody = '';
    let statusCode = 0;
    let contentType = '';

    request.on('response', (response) => {
      statusCode = response.statusCode;
      contentType = response.headers['content-type']?.[0] || '';
      response.on('data', (chunk) => { responseBody += chunk.toString(); });
      response.on('end', () => resolve({ status: statusCode, body: responseBody, contentType }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

app.whenReady().then(async () => {
  // --- IPC Handlers ---
  ipcMain.handle('get-config', async () => {
    const cfg = loadConfig();
    const cookies = await session.defaultSession.cookies.get({ domain: '.pathofexile.com' }).catch(() => []);
    return {
      loggedIn: loginState.loggedIn && cookies.some(c => c.name === 'POESESSID'),
      hasSession: !!cfg.poesessid,
      cfReady: cookies.some(c => c.name === 'cf_clearance'),
      accountName: loginState.accountName,
      browserOpen: true,
    };
  });

  ipcMain.handle('login', () => { openLoginWindow(); return { ok: true }; });

  ipcMain.handle('logout', async () => {
    saveConfig({});
    loginState = { loggedIn: false, accountName: null };
    await session.defaultSession.cookies.remove('https://www.pathofexile.com', 'POESESSID').catch(() => {});
    await session.defaultSession.cookies.remove('https://www.pathofexile.com', 'cf_clearance').catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('trade-fetch', async (_e, { url, method, body }) => {
    try {
      return await tradeFetch(url, method, body || null);
    } catch (err) {
      return { status: 502, body: JSON.stringify({ error: err.message }), contentType: 'application/json' };
    }
  });

  await restoreSession();
  createMainWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!mainWindow) createMainWindow(); });
