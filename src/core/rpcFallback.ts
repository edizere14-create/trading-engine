import { Connection } from '@solana/web3.js';
import { logger } from './logger';

// After a transport failure on the primary, go to the backup first for this long
// so every call during an outage doesn't pay the primary's timeout first.
const PRIMARY_COOLDOWN_MS = 30_000;

const TRANSPORT_ERROR_PATTERNS = [
  'fetch failed',
  'failed to fetch',
  'timeout',
  'timed out',
  'etimedout',
  'econnreset',
  'econnrefused',
  'enotfound',
  'socket hang up',
  'network error',
  'too many requests',
  '429',
  '502',
  '503',
  '504',
  'bad gateway',
  'service unavailable',
];

/**
 * True if an RPC error looks like the endpoint being unreachable or overloaded,
 * as opposed to the RPC answering with an application error ("account not
 * found", invalid params). Only transport errors are worth retrying elsewhere.
 */
export function isTransportError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSPORT_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * HTTP RPC with fallback for read-only calls. Runs `fn` against the primary;
 * if it fails with a transport error, retries once on the backup. After a
 * primary transport failure the backup is tried first for a short cooldown.
 * Application errors are rethrown untouched. With no backup it simply calls
 * the primary, so behavior is unchanged.
 *
 * Only use this for idempotent reads. It does not touch WebSockets.
 */
export class RpcFallback {
  private primaryFailedAt = 0;

  constructor(
    private readonly name: string,
    private readonly primary: Connection,
    private readonly backup: Connection | null
  ) {}

  async call<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    if (!this.backup) return fn(this.primary);

    const backupFirst = Date.now() - this.primaryFailedAt < PRIMARY_COOLDOWN_MS;
    const first = backupFirst ? this.backup : this.primary;
    const second = backupFirst ? this.primary : this.backup;

    try {
      return await fn(first);
    } catch (err) {
      if (!isTransportError(err)) throw err;
      if (first === this.primary) this.primaryFailedAt = Date.now();
      logger.warn(`[${this.name}] RPC call failed, trying other endpoint`, {
        failed: first === this.primary ? 'primary' : 'backup',
        err: err instanceof Error ? err.message : String(err),
      });
      return fn(second);
    }
  }
}
