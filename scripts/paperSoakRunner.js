#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'logs', 'engine.log');
const SOAK_DIR = path.join(ROOT, 'data', 'soak');

// When SOAK_VALIDATE=1 the runner runs for 2 minutes and exits code 0 if a
// hard stop triggered (validates the detection path against bad credentials)
// or code 1 if no hard stop was observed (unexpected).
const VALIDATE_MODE = process.env.SOAK_VALIDATE === '1';
const DURATION_MINUTES = VALIDATE_MODE ? 2 : Number(process.env.SOAK_DURATION_MINUTES || 120);
const SNAPSHOT_INTERVAL_MINUTES = Number(process.env.SOAK_SNAPSHOT_INTERVAL_MINUTES || 5);
const ENGINE_NAME = process.env.SOAK_PM2_NAME || 'trading-engine';

const DURATION_MS = DURATION_MINUTES * 60_000;
const SNAPSHOT_MS = SNAPSHOT_INTERVAL_MINUTES * 60_000;
const POLL_MS = 10_000;                // hard-stop check granularity
const CRASH_LOOP_THRESHOLD = 3;        // max new PM2 restarts allowed during soak
const SNAPSHOT_SCHEMA_VERSION = '2';   // bump when snapshot shape changes

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readLogEntries() {
  if (!fs.existsSync(LOG_FILE)) return [];
  const raw = fs.readFileSync(LOG_FILE, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    const obj = safeJsonParse(line);
    if (obj && obj.timestamp && obj.message) {
      parsed.push(obj);
    }
  }
  return parsed;
}

function parseEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

function checkPaperModeSafety() {
  const env = parseEnvFile();
  const paperMode = String(env.PAPER_MODE || '').toLowerCase();
  const liveArmed = String(env.LIVE_TRADING_ARMED || '').toLowerCase();

  if (paperMode !== 'true') {
    throw new Error('HARD STOP: PAPER_MODE must be true for soak test.');
  }
  if (liveArmed === 'true') {
    throw new Error('HARD STOP: LIVE_TRADING_ARMED must be false for soak test.');
  }
}

function startEnginePaperOnly() {
  const envPrefix = [
    "$env:PAPER_MODE='true'",
    "$env:LIVE_TRADING_ARMED='false'",
    "$env:SOAK_RUN='true'",
  ].join('; ');

  // Try restart first (process must already be in PM2 list).
  // If it fails (process not found / not running), fall back to startOrRestart
  // via the ecosystem config so PM2 always ends up with a live entry.
  try {
    execSync(`${envPrefix}; pm2 restart ${ENGINE_NAME} --update-env`, {
      cwd: ROOT, stdio: 'inherit', shell: 'powershell.exe',
    });
  } catch {
    console.warn(`[Soak] pm2 restart failed — falling back to pm2 startOrRestart ecosystem.config.js`);
    execSync(
      `${envPrefix}; pm2 startOrRestart ecosystem.config.js --only ${ENGINE_NAME} --update-env`,
      { cwd: ROOT, stdio: 'inherit', shell: 'powershell.exe' }
    );
  }
}

// Returns the PM2 restart count for the engine process, or -1 on error.
function getPm2RestartCount() {
  try {
    const out = execSync(`pm2 jlist`, { cwd: ROOT, timeout: 10_000, encoding: 'utf-8', shell: 'powershell.exe' });
    const list = JSON.parse(out);
    const entry = list.find((p) => p.name === ENGINE_NAME);
    return entry ? Number(entry.pm2_env?.restart_time ?? 0) : -1;
  } catch {
    return -1;
  }
}

function findHardStop(entries, sinceMs) {
  const recent = entries.filter((e) => Date.parse(e.timestamp) >= sinceMs);
  for (const e of recent) {
    const msg = String(e.message || '');
    const stack = String(e.stack || '');
    const err = String(e.error || '');

    // BOOT FAILED — authoritative. Logged by boot().catch() via Winston before
    // process.exit(1). This IS the definitive terminal signal for any startup crash.
    if (msg === 'BOOT FAILED' || msg.startsWith('BOOT FAILED')) {
      return `Engine boot failure: ${err || msg}`;
    }

    if (msg.includes('STARTUP ASSERTION FAILED') || err.includes('STARTUP ASSERTION FAILED') || stack.includes('STARTUP ASSERTION FAILED')) {
      return `Startup assertion failure detected: ${msg || err}`;
    }

    const startupPrimaryFail = msg.includes('[Startup] RPC unreachable') && String(e.label || '').toLowerCase() === 'primary';
    const explicitPrimaryFail = msg.includes('STARTUP ASSERTION FAILED: primary RPC unreachable');
    const anyPrimaryFailure = msg.toLowerCase().includes('primary rpc unreachable');
    if (startupPrimaryFail || explicitPrimaryFail || anyPrimaryFailure) {
      return `Primary RPC startup failure detected: ${msg}`;
    }
  }
  return null;
}

function getLatestSnapshot(entries, sinceMs) {
  const snapshots = entries.filter((e) => {
    const ts = Date.parse(e.timestamp);
    return ts >= sinceMs && e.message === 'Runtime memory snapshot';
  });

  if (snapshots.length === 0) return null;
  snapshots.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return snapshots[snapshots.length - 1];
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function summarizeSnapshots(snapshots) {
  const values = (keyPath) => snapshots
    .map((s) => keyPath.reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), s))
    .filter((v) => v !== undefined)
    .map((v) => Number(v));

  const firstLastDelta = (arr) => arr.length >= 2 ? arr[arr.length - 1] - arr[0] : 0;

  const heap = values(['heapUsedMB']);
  const rss = values(['rssMB']);
  const lpReconnect = values(['lpStream', 'reconnectTotal']);
  const walletReconnect = values(['walletStream', 'reconnectTotal']);
  const hbFail = values(['lpStream', 'wsHeartbeatFail']).map((v, i) => v + (values(['walletStream', 'wsHeartbeatFail'])[i] || 0));

  const monotonic = (arr) => {
    if (arr.length < 4) return false;
    let nonDecreasing = 0;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] >= arr[i - 1]) nonDecreasing++;
    }
    return nonDecreasing >= arr.length - 2;
  };

  const last = snapshots[snapshots.length - 1] || {};
  const gateHealth = last.gateHealth || {};
  const tradingHealth = last.tradingHealth || {};

  const heapDrift = firstLastDelta(heap);
  const rssDrift = firstLastDelta(rss);
  const reconnectDrift = firstLastDelta(lpReconnect) + firstLastDelta(walletReconnect);

  const pass =
    !monotonic(heap) &&
    !monotonic(rss) &&
    reconnectDrift <= 5 &&
    toNumber(last.lpStream?.wsHeartbeatFail, 0) + toNumber(last.walletStream?.wsHeartbeatFail, 0) <= 20;

  return {
    snapshotCount: snapshots.length,
    heapStartMB: heap[0] ?? 0,
    heapEndMB: heap[heap.length - 1] ?? 0,
    heapDriftMB: heapDrift,
    rssStartMB: rss[0] ?? 0,
    rssEndMB: rss[rss.length - 1] ?? 0,
    rssDriftMB: rssDrift,
    reconnectDrift,
    heartbeatFailsTotal: (last.lpStream?.wsHeartbeatFail || 0) + (last.walletStream?.wsHeartbeatFail || 0),
    unsubscribeWarningsTotal: last.wsErrorSuppression?.unsubscribeWarnings || 0,
    gateHealth,
    tradingHealth,
    rpcHealth: {
      lpRole: last.lpStream?.rpcRole || null,
      walletRole: last.walletStream?.rpcRole || null,
      lpFailovers: last.lpStream?.failoverCount || 0,
      walletFailovers: last.walletStream?.failoverCount || 0,
      lpAvgRecoveryMs: toNumber(last.lpStream?.avgRecoveryMs, 0),
      walletAvgRecoveryMs: toNumber(last.walletStream?.avgRecoveryMs, 0),
    },
    pass,
  };
}

async function main() {
  checkPaperModeSafety();
  ensureDir(SOAK_DIR);

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotFile = path.join(SOAK_DIR, `paper-soak-${runId}.snapshots.json`);
  const reportFile = path.join(SOAK_DIR, `paper-soak-${runId}.report.json`);

  const mode = VALIDATE_MODE ? 'VALIDATE (hard-stop test, 2 min max)' : `SOAK ${DURATION_MINUTES}m`;
  console.log(`[Soak] ${nowIso()} mode=${mode} interval=${SNAPSHOT_INTERVAL_MINUTES}m poll=${POLL_MS / 1000}s`);

  // Baseline PM2 restart count before we touch anything
  const pm2RestartBaseline = getPm2RestartCount();
  console.log(`[Soak] PM2 restart baseline: ${pm2RestartBaseline}`);

  startEnginePaperOnly();

  const startMs = Date.now();
  const endMs = startMs + DURATION_MS;
  const snapshots = [];
  let hardStopReason = null;
  let lastSnapshotTimestamp = null;
  let nextSnapshotAtMs = startMs + SNAPSHOT_MS;

  console.log(`[Soak] Engine restarted. Hard-stop detection active.`);

  while (Date.now() < endMs) {
    await sleep(POLL_MS);

    const entries = readLogEntries();

    // ── Hard stop: log-pattern detection ────────────────────────
    hardStopReason = findHardStop(entries, startMs);
    if (hardStopReason) {
      console.error(`[Soak] HARD STOP (log): ${hardStopReason}`);
      break;
    }

    // ── Hard stop: PM2 crash-loop detection ──────────────────────
    if (pm2RestartBaseline >= 0) {
      const currentRestarts = getPm2RestartCount();
      if (currentRestarts >= 0) {
        const newRestarts = currentRestarts - pm2RestartBaseline;
        if (newRestarts > CRASH_LOOP_THRESHOLD) {
          hardStopReason = `Engine crash loop: ${newRestarts} new PM2 restarts since soak began (threshold ${CRASH_LOOP_THRESHOLD})`;
          console.error(`[Soak] HARD STOP (crash loop): ${hardStopReason}`);
          break;
        }
      }
    }

    // ── Snapshot on schedule ─────────────────────────────────────
    if (Date.now() >= nextSnapshotAtMs) {
      const snapshot = getLatestSnapshot(entries, startMs);
      if (snapshot) {
        if (snapshot.timestamp !== lastSnapshotTimestamp) {
          snapshots.push({
            _schema: SNAPSHOT_SCHEMA_VERSION,
            capturedAt: nowIso(),
            seqNo: snapshots.length + 1,
            ...snapshot,
          });
          lastSnapshotTimestamp = snapshot.timestamp;
          fs.writeFileSync(snapshotFile, JSON.stringify(snapshots, null, 2), 'utf-8');
          const elapsed = Math.round((Date.now() - startMs) / 60_000);
          console.log(`[Soak] T+${elapsed}m snapshot ${snapshots.length} at ${snapshot.timestamp}`);
        } else {
          console.log('[Soak] Latest snapshot unchanged; waiting for next interval');
        }
      } else {
        console.warn('[Soak] No runtime snapshot found yet; waiting for next interval');
      }
      nextSnapshotAtMs += SNAPSHOT_MS;
    }
  }

  const summary = summarizeSnapshots(snapshots);
  const report = {
    _schema: SNAPSHOT_SCHEMA_VERSION,
    runId,
    mode: VALIDATE_MODE ? 'validate' : 'soak',
    startedAt: new Date(startMs).toISOString(),
    endedAt: nowIso(),
    elapsedMinutes: Math.round((Date.now() - startMs) / 60_000),
    configuredDurationMinutes: DURATION_MINUTES,
    intervalMinutes: SNAPSHOT_INTERVAL_MINUTES,
    hardStop: hardStopReason ?? null,
    summary,
    pass: !hardStopReason && summary.pass,
    snapshotFile,
  };

  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');

  console.log('\n[Soak] ── Final Report ─────────────────────────────────────');
  console.log(`[Soak] mode:     ${report.mode}`);
  console.log(`[Soak] elapsed:  ${report.elapsedMinutes}m / ${DURATION_MINUTES}m`);
  console.log(`[Soak] hardStop: ${report.hardStop ?? 'none'}`);
  if (!hardStopReason) {
    console.log(`[Soak] heap:     ${summary.heapStartMB} → ${summary.heapEndMB} MB (drift ${summary.heapDriftMB > 0 ? '+' : ''}${summary.heapDriftMB})`);
    console.log(`[Soak] rss:      ${summary.rssStartMB} → ${summary.rssEndMB} MB`);
    console.log(`[Soak] reconnect drift: ${summary.reconnectDrift}`);
    console.log(`[Soak] HB fails: ${summary.heartbeatFailsTotal}`);
  }
  console.log(`[Soak] RESULT:   ${report.pass ? 'PASS' : 'FAIL'}`);
  console.log(`[Soak] report:   ${reportFile}`);
  console.log('[Soak] ─────────────────────────────────────────────────────\n');

  if (VALIDATE_MODE) {
    // In validate mode: hard stop is expected and is a PASS; no hard stop is a FAIL.
    if (hardStopReason) {
      console.log('[Soak] VALIDATE PASS: hard-stop triggered as expected — harness exits fast on bad deps');
      process.exit(0);
    } else {
      console.error('[Soak] VALIDATE FAIL: expected a hard stop but none was detected in 2 minutes');
      process.exit(1);
    }
  }

  if (hardStopReason) process.exit(2);
  if (!summary.pass) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[Soak] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
