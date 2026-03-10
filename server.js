import express from 'express';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3333;
const GGG_BASE = 'https://www.pathofexile.com';
const CONFIG_PATH = join(__dirname, 'config.json');
const DIAG_PATH = join(__dirname, 'diagnostics');
const CHROME_PATH = '/usr/bin/google-chrome';

if (!existsSync(DIAG_PATH)) mkdirSync(DIAG_PATH, { recursive: true });

// --- Config persistence ---
function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  }
  return {};
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// --- Persistent Chrome browser session ---
let cfBrowser = null;
let cfPage = null;
let cfSession = { ready: false, refreshing: false, loggedIn: false, accountName: null };

/**
 * Launch visible Chrome window for PoE login.
 * User logs in manually → we capture POESESSID + cf_clearance.
 * Browser stays alive for all trade API calls.
 */
async function launchLoginSession() {
  if (cfSession.refreshing) return;
  cfSession.refreshing = true;
  cfSession.loggedIn = false;
  cfSession.accountName = null;
  console.log('Launching Chrome for PoE login...');

  try {
    if (cfBrowser) await cfBrowser.close().catch(() => {});

    cfBrowser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: false, // Visible — user logs in here
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1100,800',
      ],
    });
    cfPage = await cfBrowser.newPage();
    await cfPage.setViewport({ width: 1080, height: 750 });

    // Navigate to PoE login page
    await cfPage.goto('https://www.pathofexile.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    cfSession.ready = true;
    console.log('Login window open — waiting for user to log in...');

    // Poll for POESESSID cookie (user logging in)
    pollForLogin();

  } catch (err) {
    console.error('Login launch error:', err.message);
    cfSession.ready = true;
  } finally {
    cfSession.refreshing = false;
  }
}

/**
 * Background poll: check cookies every 2s until POESESSID appears.
 * Once found, session is authenticated — minimize window.
 */
async function pollForLogin() {
  for (let i = 0; i < 300; i++) { // 10 minutes max
    await new Promise(r => setTimeout(r, 2000));
    if (!cfPage || cfPage.isClosed()) return;
    try {
      const cookies = await cfPage.cookies('https://www.pathofexile.com');
      const poesessid = cookies.find(c => c.name === 'POESESSID');
      const cfClearance = cookies.find(c => c.name === 'cf_clearance');

      if (poesessid) {
        cfSession.loggedIn = true;
        console.log(`Login detected! POESESSID found. CF: ${cfClearance ? 'yes' : 'no'}`);

        // Save session cookie for persistence across restarts
        saveConfig({ ...loadConfig(), poesessid: poesessid.value });

        // Try to get account name from the page
        try {
          const accountName = await cfPage.evaluate(() => {
            const el = document.querySelector('.profile-link a, .account-name, [class*="account"] a');
            return el?.textContent?.trim() || null;
          });
          if (accountName) {
            cfSession.accountName = accountName;
            console.log(`Account: ${accountName}`);
          }
        } catch {}

        // Navigate to trade page to keep the session warm
        try {
          await cfPage.goto('https://www.pathofexile.com/trade/search/Standard', {
            waitUntil: 'networkidle2',
            timeout: 20000,
          });
        } catch {}

        return;
      }
    } catch (err) {
      // Page might be navigating
      if (err.message.includes('destroyed') || err.message.includes('detached')) return;
    }
  }
  console.log('Login poll timed out after 10 minutes');
}

/**
 * Restore session from saved cookies on startup (skip visible login if valid).
 */
async function restoreSession() {
  const cfg = loadConfig();
  if (!cfg.poesessid) return false;

  console.log('Restoring saved session...');
  cfSession.refreshing = true;

  try {
    if (cfBrowser) await cfBrowser.close().catch(() => {});

    cfBrowser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new', // Headless for restore — no window needed
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
      ],
    });
    cfPage = await cfBrowser.newPage();
    await cfPage.setViewport({ width: 1920, height: 1080 });

    // Set saved POESESSID
    await cfPage.setCookie({
      name: 'POESESSID', value: cfg.poesessid,
      domain: '.pathofexile.com', path: '/',
    });

    // Navigate to trade page — triggers CF challenge + validates session
    await cfPage.goto('https://www.pathofexile.com/trade/search/Standard', {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });

    // Wait for CF to resolve
    let solved = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const cookies = await cfPage.cookies('https://www.pathofexile.com');
      if (cookies.some(c => c.name === 'cf_clearance')) {
        solved = true;
        console.log(`CF solved after ${(i + 1) * 2}s`);
        break;
      }
      const title = await cfPage.title();
      if (!title.includes('moment') && !title.includes('Checking')) {
        solved = true;
        break;
      }
    }

    // Verify session is still valid by checking if we're not redirected to login
    const url = cfPage.url();
    if (url.includes('/login')) {
      console.log('Saved session expired — need fresh login');
      await cfBrowser.close().catch(() => {});
      cfBrowser = null;
      cfPage = null;
      cfSession.refreshing = false;
      return false;
    }

    cfSession.ready = true;
    cfSession.loggedIn = true;
    console.log(`Session restored (${solved ? 'CF solved' : 'no CF needed'})`);
    return true;

  } catch (err) {
    console.error('Session restore failed:', err.message);
    cfSession.refreshing = false;
    return false;
  } finally {
    cfSession.refreshing = false;
  }
}

// Execute a trade API call through the persistent Chrome page
async function chromeFetch(url, method, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!cfPage || cfPage.isClosed()) {
      const restored = await restoreSession();
      if (!restored) throw new Error('No active session — please log in');
    }
    try {
      const result = await cfPage.evaluate(async (url, method, body) => {
        try {
          const opts = {
            method,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          };
          if (body) opts.body = body;
          const res = await fetch(url, opts);
          const text = await res.text();
          return { status: res.status, body: text, headers: Object.fromEntries(res.headers) };
        } catch (e) {
          return { status: 0, body: e.message, headers: {} };
        }
      }, url, method, body);
      return result;
    } catch (e) {
      console.log(`chromeFetch error (attempt ${attempt + 1}): ${e.message}`);
      if (attempt === 0) {
        cfPage = null;
        const restored = await restoreSession();
        if (!restored) throw new Error('Session lost — please log in again');
      } else {
        throw e;
      }
    }
  }
}

// --- Express app ---
const app = express();
app.use(express.json({ limit: '5mb' }));

// Session status
app.get('/api/config', async (_req, res) => {
  const cfg = loadConfig();
  const cookies = cfPage ? await cfPage.cookies('https://www.pathofexile.com').catch(() => []) : [];
  const hasCf = cookies.some(c => c.name === 'cf_clearance');
  const hasPoe = cookies.some(c => c.name === 'POESESSID');
  res.json({
    loggedIn: cfSession.loggedIn && hasPoe,
    hasSession: !!cfg.poesessid,
    cfReady: hasCf,
    accountName: cfSession.accountName,
    browserOpen: !!cfBrowser && !!cfPage,
  });
});

// Trigger login window
app.post('/api/login', async (_req, res) => {
  res.json({ ok: true, message: 'Opening login window...' });
  launchLoginSession();
});

// Logout — clear session
app.post('/api/logout', async (_req, res) => {
  saveConfig({});
  cfSession.loggedIn = false;
  cfSession.accountName = null;
  if (cfBrowser) await cfBrowser.close().catch(() => {});
  cfBrowser = null;
  cfPage = null;
  cfSession.ready = false;
  res.json({ ok: true });
});

// Legacy config endpoint (for manual POESESSID)
app.put('/api/config', (req, res) => {
  const cfg = loadConfig();
  if (req.body.poesessid !== undefined) cfg.poesessid = req.body.poesessid;
  saveConfig(cfg);
  res.json({ ok: true });
});

// Save build diagnostics endpoint
app.post('/api/save-build', (req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `build-${timestamp}.json`;
  const filepath = join(DIAG_PATH, filename);
  writeFileSync(filepath, JSON.stringify({ timestamp: new Date().toISOString(), ...req.body }, null, 2));
  console.log(`Saved build diagnostic: ${filename}`);
  res.json({ ok: true, filename });
});

// Save raw PoB code for testing
app.post('/api/save-pob', (req, res) => {
  const { pobCode } = req.body || {};
  if (!pobCode) return res.status(400).json({ error: 'no pobCode' });
  const filepath = join(DIAG_PATH, 'test-pob-code.txt');
  writeFileSync(filepath, pobCode);
  console.log(`Saved test PoB code: ${pobCode.length} chars`);
  res.json({ ok: true, length: pobCode.length });
});

// Get list of saved diagnostics
app.get('/api/diagnostics', (_req, res) => {
  const files = readdirSync(DIAG_PATH).filter(f => f.endsWith('.json')).sort().reverse();
  res.json({ files });
});

// Read a specific diagnostic
app.get('/api/diagnostics/:file', (req, res) => {
  const filepath = join(DIAG_PATH, req.params.file);
  if (existsSync(filepath)) {
    res.json(JSON.parse(readFileSync(filepath, 'utf-8')));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Manual cf refresh
app.post('/api/refresh-cf', async (_req, res) => {
  const restored = await restoreSession();
  res.json({ restored, loggedIn: cfSession.loggedIn });
});

// Proxy /api/trade/* and /api/trade2/* to GGG via persistent Chrome
app.use(['/api/trade2', '/api/trade'], async (req, res) => {
  const target = `${GGG_BASE}${req.originalUrl}`;

  try {
    if (!cfPage) {
      res.status(503).json({ error: 'No active session — click "Log in with PoE" to start' });
      return;
    }

    const body = req.method === 'POST' ? JSON.stringify(req.body) : null;
    if (body && req.originalUrl.includes('/search/')) {
      console.log('Trade search:', req.originalUrl);
    }

    const result = await chromeFetch(target, req.method, body);

    // If CF blocks, try refreshing
    if (result.status === 403 && result.body.includes('cf-')) {
      console.log('CF blocked — restoring session...');
      await restoreSession();
      res.status(503).json({ error: 'Cloudflare session expired. Refreshing — try again.' });
      return;
    }

    res.status(result.status);
    if (result.headers['content-type']) {
      res.setHeader('Content-Type', result.headers['content-type']);
    }
    res.send(result.body);
  } catch (err) {
    console.error('Proxy error:', err.message);
    if (err.message.includes('not ready') || err.message.includes('destroyed') || err.message.includes('log in')) {
      await restoreSession().catch(() => {});
    }
    res.status(502).json({ error: err.message });
  }
});

// Serve test PoB code
app.get('/api/test-pob', (_req, res) => {
  const fp = join(DIAG_PATH, 'test-pob-code.txt');
  if (existsSync(fp)) res.type('text').send(readFileSync(fp, 'utf-8'));
  else res.status(404).json({ error: 'No test code saved' });
});

// Serve PWA
app.use(express.static(join(__dirname, 'dist')));
app.get('/{*splat}', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

// Start
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`PoB Trade running at http://localhost:${PORT}`);

  // Try to restore saved session first (headless, no window)
  const restored = await restoreSession();
  if (!restored) {
    console.log('No saved session — waiting for user to log in via the app');
  }
});
