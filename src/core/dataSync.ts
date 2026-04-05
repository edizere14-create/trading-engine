// ── Cloud Data Persistence via Supabase Storage ────────────────────────────
// Syncs local data/ and logs/ files to Supabase Storage so they survive
// Render's ephemeral filesystem restarts.
//
// Strategy:
//   1. On boot: download all files from Supabase → local disk
//   2. Periodic: upload changed files (by mtime) every SYNC_INTERVAL_MS
//   3. On shutdown: final upload of all tracked files

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { logger } from './logger';

const SYNC_INTERVAL_MS = 30_000; // 30 seconds

// Files to persist (relative to project root)
const TRACKED_FILES = [
  'data/paperTrades.json',
  'data/journal.db',
  'data/deployer_intelligence.json',
  'data/deployers.json',
  'data/wallets.json',
  'data/ml_model.json',
  'data/hmm_regime.json',
  'data/sentinel_events.json',
  'logs/engine.log',
];

interface FileState {
  localPath: string;
  remotePath: string;
  lastSyncedMtime: number;
}

export class DataSync {
  private supabaseUrl: string;
  private supabaseKey: string;
  private bucket: string;
  private files: FileState[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private rootDir: string;

  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL || '';
    this.supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
    this.bucket = process.env.SUPABASE_BUCKET || 'trading-data';
    this.rootDir = process.cwd();

    for (const rel of TRACKED_FILES) {
      this.files.push({
        localPath: path.resolve(this.rootDir, rel),
        remotePath: rel.replace(/\\/g, '/'),
        lastSyncedMtime: 0,
      });
    }
  }

  get enabled(): boolean {
    return !!(this.supabaseUrl && this.supabaseKey);
  }

  // ── Restore all files from Supabase on boot ──────────────────────────────
  async restore(): Promise<void> {
    if (!this.enabled) {
      logger.warn('DataSync disabled — SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
      return;
    }

    logger.info('DataSync: restoring files from Supabase Storage...');
    let restored = 0;

    for (const file of this.files) {
      try {
        const data = await this.download(file.remotePath);
        if (data) {
          // Ensure directory exists
          const dir = path.dirname(file.localPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(file.localPath, data);
          const stat = fs.statSync(file.localPath);
          file.lastSyncedMtime = stat.mtimeMs;
          restored++;
          logger.info(`DataSync: restored ${file.remotePath} (${data.length} bytes)`);
        }
      } catch (err) {
        // File might not exist in cloud yet — that's fine
        logger.debug(`DataSync: ${file.remotePath} not in cloud yet`);
      }
    }

    logger.info(`DataSync: restore complete (${restored}/${this.files.length} files)`);
  }

  // ── Start periodic sync ──────────────────────────────────────────────────
  start(): void {
    if (!this.enabled) return;

    this.timer = setInterval(() => {
      this.syncChanged().catch((err) => {
        logger.error('DataSync: periodic sync failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, SYNC_INTERVAL_MS);

    logger.info(`DataSync: periodic sync started (every ${SYNC_INTERVAL_MS / 1000}s)`);
  }

  // ── Upload only files that changed since last sync ───────────────────────
  async syncChanged(): Promise<void> {
    for (const file of this.files) {
      try {
        if (!fs.existsSync(file.localPath)) continue;

        const stat = fs.statSync(file.localPath);
        if (stat.mtimeMs <= file.lastSyncedMtime) continue;

        const data = fs.readFileSync(file.localPath);
        await this.upload(file.remotePath, data);
        file.lastSyncedMtime = stat.mtimeMs;
        logger.debug(`DataSync: synced ${file.remotePath} (${data.length} bytes)`);
      } catch (err) {
        logger.error(`DataSync: failed to sync ${file.remotePath}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Final sync + stop timer ──────────────────────────────────────────────
  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (!this.enabled) return;

    logger.info('DataSync: final sync on shutdown...');
    // Force-sync all existing files regardless of mtime
    for (const file of this.files) {
      try {
        if (!fs.existsSync(file.localPath)) continue;
        const data = fs.readFileSync(file.localPath);
        await this.upload(file.remotePath, data);
        logger.info(`DataSync: final sync ${file.remotePath}`);
      } catch (err) {
        logger.error(`DataSync: shutdown sync failed for ${file.remotePath}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Supabase Storage: download ───────────────────────────────────────────
  private download(remotePath: string): Promise<Buffer | null> {
    const url = `${this.supabaseUrl}/storage/v1/object/${this.bucket}/${remotePath}`;
    return this.httpRequest('GET', url);
  }

  // ── Supabase Storage: upload (upsert) ────────────────────────────────────
  private upload(remotePath: string, data: Buffer): Promise<Buffer | null> {
    const url = `${this.supabaseUrl}/storage/v1/object/${this.bucket}/${remotePath}`;
    return this.httpRequest('PUT', url, data);
  }

  // ── HTTP helper ──────────────────────────────────────────────────────────
  private httpRequest(
    method: string,
    url: string,
    body?: Buffer,
  ): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.supabaseKey}`,
        apikey: this.supabaseKey,
      };

      if (body) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['Content-Length'] = String(body.length);
        headers['x-upsert'] = 'true';
      }

      const req = mod.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const result = Buffer.concat(chunks);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(result);
            } else if (res.statusCode === 404 && method === 'GET') {
              resolve(null); // File doesn't exist yet
            } else {
              reject(
                new Error(
                  `Supabase ${method} ${parsed.pathname} → ${res.statusCode}: ${result.toString().slice(0, 200)}`,
                ),
              );
            }
          });
        },
      );

      req.on('error', reject);
      req.setTimeout(15_000, () => {
        req.destroy(new Error('Request timed out'));
      });

      if (body) req.write(body);
      req.end();
    });
  }
}
