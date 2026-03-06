// Build script: embeds dist/ into the server and compiles to standalone binaries
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'fs';
import { join, relative } from 'path';

function walkDir(dir, base) {
  const files = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(base, full);
    if (statSync(full).isDirectory()) {
      Object.assign(files, walkDir(full, base));
    } else {
      files[rel] = readFileSync(full).toString('base64');
    }
  }
  return files;
}

// Read all dist files
const distDir = join(import.meta.dirname, 'dist');
if (!existsSync(distDir)) {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}

const embedded = walkDir(distDir, distDir);
console.log(`Embedding ${Object.keys(embedded).length} files from dist/`);

// Generate the bundled server
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const serverCode = `
import express from 'express';

const PORT = process.env.PORT || 3333;
const GGG_BASE = 'https://www.pathofexile.com';

// Embedded static files
const FILES = ${JSON.stringify(embedded)};

const MIME = ${JSON.stringify(mimeTypes)};

function getMime(path) {
  const ext = '.' + path.split('.').pop();
  return MIME[ext] || 'application/octet-stream';
}

const app = express();
app.use(express.json());

// Proxy trade API requests to GGG
app.use(['/api/trade2', '/api/trade'], async (req, res) => {
  const target = \`\${GGG_BASE}\${req.originalUrl}\`;
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://www.pathofexile.com',
      'Referer': 'https://www.pathofexile.com/trade/search/',
    };
    const fetchOpts = { method: req.method, headers };
    if (req.method === 'POST') {
      fetchOpts.body = JSON.stringify(req.body);
    }
    const upstream = await fetch(target, fetchOpts);
    res.status(upstream.status);
    for (const [k, v] of upstream.headers) {
      if (!['content-encoding', 'transfer-encoding', 'connection', 'set-cookie'].includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    res.send(body);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Trade API proxy error' });
  }
});

// Serve embedded static files
app.use((req, res) => {
  let path = req.path === '/' ? 'index.html' : req.path.slice(1);
  const data = FILES[path];
  if (data) {
    res.setHeader('Content-Type', getMime(path));
    res.send(Buffer.from(data, 'base64'));
  } else {
    // SPA fallback
    const index = FILES['index.html'];
    if (index) {
      res.setHeader('Content-Type', 'text/html');
      res.send(Buffer.from(index, 'base64'));
    } else {
      res.status(404).send('Not found');
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(\`Path of Ascent running at http://localhost:\${PORT}\`);
  // Try to open browser
  const open = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  import('child_process').then(cp => cp.exec(\`\${open} http://localhost:\${PORT}\`)).catch(() => {});
});
`;

if (!existsSync('release')) mkdirSync('release');
writeFileSync('release/server-bundled.js', serverCode);
console.log('Wrote release/server-bundled.js');
console.log('Now run: bun build release/server-bundled.js --compile --target=bun-<platform>-x64 --outfile=release/pob-trade');
