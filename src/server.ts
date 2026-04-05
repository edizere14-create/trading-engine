// ── Render entry point ─────────────────────────────────────────────────────
// 1. Starts Next.js dashboard on PORT (satisfies Render health check)
// 2. Loads the trading engine in the background
//
// The dashboard reads data/ and logs/ from the same filesystem as the engine,
// so both MUST run in the same process / service.

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import next from 'next';

const PORT = parseInt(process.env.PORT || '10000', 10);
const app = next({ dev: false, dir: './dashboard' });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  createServer((req: IncomingMessage, res: ServerResponse) => {
    // Health endpoint for Render
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }
    // Everything else → Next.js dashboard
    const parsedUrl = parse(req.url || '/', true);
    handle(req, res, parsedUrl);
  }).listen(PORT, () => {
    console.log(`Dashboard + health server listening on port ${PORT}`);
    // Now load the trading engine (heavy imports happen here)
    require('./index');
  });
}).catch((err: Error) => {
  console.error('Failed to start Next.js dashboard:', err);
  // Fall back to health-only server + engine
  createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), dashboard: 'failed' }));
  }).listen(PORT, () => {
    console.log(`Health-only server listening on port ${PORT} (dashboard failed)`);
    require('./index');
  });
});
