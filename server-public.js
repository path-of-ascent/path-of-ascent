import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3333;
const GGG_BASE = 'https://www.pathofexile.com';

const app = express();
app.use(express.json());

// Proxy trade API requests to GGG
app.use(['/api/trade2', '/api/trade'], async (req, res) => {
  const target = `${GGG_BASE}${req.originalUrl}`;

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

// Serve static files
app.use(express.static(join(__dirname, 'dist')));
app.get('/{*splat}', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Path of Ascent running at http://localhost:${PORT}`);
});
