// ── Render entry point ─────────────────────────────────────────────────────
// Binds the health-check HTTP port BEFORE loading the heavy trading engine,
// so Render sees the port open within seconds and doesn't time out.

import { createServer } from 'http';

const PORT = parseInt(process.env.PORT || '10000', 10);

createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
}).listen(PORT, () => {
  console.log(`Health server listening on port ${PORT}`);
  // Now load the trading engine (heavy imports happen here)
  require('./index');
});
