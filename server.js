import express from 'express';
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from 'fs';
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

// Ensure diagnostics directory exists
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

// --- Persistent Chrome browser for CF-bypassed API calls ---
let cfBrowser = null;
let cfPage = null;
let cfSession = { ready: false, refreshing: false };

async function refreshCfSession() {
  if (cfSession.refreshing) return;
  cfSession.refreshing = true;
  console.log('Launching Chrome to solve Cloudflare challenge...');

  try {
    // Close old browser if exists
    if (cfBrowser) await cfBrowser.close().catch(() => {});

    cfBrowser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
      ],
    });
    cfPage = await cfBrowser.newPage();
    await cfPage.setViewport({ width: 1920, height: 1080 });

    // Navigate to trade page — triggers Cloudflare challenge
    await cfPage.goto('https://www.pathofexile.com/trade/search/Standard', {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });

    // Wait for CF challenge to resolve
    let solved = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const cookies = await cfPage.cookies('https://www.pathofexile.com');
      if (cookies.some(c => c.name === 'cf_clearance')) {
        solved = true;
        console.log(`CF challenge solved after ${(i + 1) * 2}s`);
        break;
      }
      const title = await cfPage.title();
      if (!title.includes('moment') && !title.includes('Checking')) {
        solved = true;
        console.log(`Page loaded without challenge after ${(i + 1) * 2}s`);
        break;
      }
    }

    // Override POESESSID with user's configured one
    const cfg = loadConfig();
    if (cfg.poesessid) {
      await cfPage.setCookie({
        name: 'POESESSID', value: cfg.poesessid,
        domain: '.pathofexile.com', path: '/',
      });
      console.log('Set user POESESSID on Chrome session');
    }

    cfSession.ready = true;
    const cookies = await cfPage.cookies('https://www.pathofexile.com');
    console.log(`Session ${solved ? 'solved' : 'timeout'}. Cookies: ${cookies.map(c => c.name).join(', ')}`);
    // Keep browser alive — API calls route through cfPage
  } catch (err) {
    console.error('Cloudflare session error:', err.message);
    cfSession.ready = true;
  } finally {
    cfSession.refreshing = false;
  }
}

// Execute a trade API call through the persistent Chrome page (same TLS fingerprint)
async function chromeFetch(url, method, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!cfPage || cfPage.isClosed()) {
      await refreshCfSession();
      if (!cfPage) throw new Error('Chrome session not ready');
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
      // Detached frame / crashed page — refresh and retry once
      console.log(`chromeFetch error (attempt ${attempt + 1}): ${e.message}`);
      if (attempt === 0) {
        cfPage = null;
        await refreshCfSession();
      } else {
        throw e;
      }
    }
  }
}

// --- Express app ---
const app = express();
app.use(express.json({ limit: '5mb' }));

// Config API (POESESSID)
app.get('/api/config', (_req, res) => {
  const cfg = loadConfig();
  res.json({
    hasSession: !!cfg.poesessid,
    cfReady: cfSession.ready && !!cfPage,
  });
});

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
  
  const diagnosticData = {
    timestamp: new Date().toISOString(),
    ...req.body
  };
  
  writeFileSync(filepath, JSON.stringify(diagnosticData, null, 2));
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
  await refreshCfSession();
  res.json({ ready: cfSession.ready, hasCf: !!cfSession.cookies });
});

// Proxy /api/trade/* and /api/trade2/* to GGG via persistent Chrome (CF bypass)
app.use(['/api/trade2', '/api/trade'], async (req, res) => {
  const target = `${GGG_BASE}${req.originalUrl}`;

  try {
    if (!cfPage) {
      res.status(503).json({ error: 'Chrome session not ready — try again shortly' });
      return;
    }

    const body = req.method === 'POST' ? JSON.stringify(req.body) : null;
    if (body && req.originalUrl.includes('/search/')) {
      console.log('Trade search:', req.originalUrl);
    }

    const result = await chromeFetch(target, req.method, body);

    // If CF blocks, try refreshing the session
    if (result.status === 403 && result.body.includes('cf-')) {
      console.log('CF blocked — refreshing...');
      await refreshCfSession();
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
    // If Chrome crashed, try to recover
    if (err.message.includes('not ready') || err.message.includes('destroyed')) {
      await refreshCfSession();
    }
    res.status(502).json({ error: 'Trade API proxy error: ' + err.message });
  }
});

// Serve PWA
app.use(express.static(join(__dirname, 'dist')));
app.get('/{*splat}', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

// Start
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`PoB Trade running at http://localhost:${PORT}`);
  const cfg = loadConfig();
  if (!cfg.poesessid) {
    console.log('  No POESESSID — set it in the app settings');
  }
  // Auto-solve Cloudflare on startup
  await refreshCfSession();
});
