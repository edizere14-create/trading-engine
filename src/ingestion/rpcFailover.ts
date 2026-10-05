import { Connection } from '@solana/web3.js';
import { logger } from '../core/logger';
import { enableWsReconnect, getConnectionEndpoint, supportsLogsSubscribe } from './wsControl';
import { acquireSlotWatch, isConnectionLive } from './wsLiveness';

// Same thresholds as the LP / migration / wallet stream watchdogs.
const LIVENESS_INTERVAL_MS = 10_000;       // transport liveness probe cadence
const LIVENESS_TIMEOUT_MS = 4_000;         // a probe slower than this counts as failed
const LIVENESS_FAILS_BEFORE_FAILOVER = 3;  // consecutive failed probes (~30s) before swapping RPC
const PRIMARY_PROBES_BEFORE_FAILBACK = 6;  // consecutive healthy primary probes (~60s) before swapping back
const MIN_BACKUP_DWELL_MS = 90_000;        // stay on backup at least this long before failing back (anti-flap)

export type SwitchReason = 'liveness' | 'failback';

export interface RpcFailoverOptions {
  /** Label used in logs. */
  name: string;
  primary: Connection;
  /** Without a backup the controller never starts and behaves as a no-op. */
  backup: Connection | null;
  /** True while the owner holds subscriptions that need protecting. */
  hasSubscriptions: () => boolean;
  /** True if every socket carrying the owner's subscriptions is OPEN. */
  socketsOpen: () => boolean;
  /**
   * Move all of the owner's subscriptions onto `target`. The controller has
   * already made `target` the active connection, so new subscriptions created
   * while this runs land on it.
   */
  moveTo: (target: Connection, reason: SwitchReason) => Promise<void>;
}

/**
 * Per-owner RPC failover for position-bound streams. Probes the active line
 * every 10s (sockets OPEN + getSlot() answering); three consecutive failures
 * swap to the other RPC, after verifying it answers. While on the backup, the
 * primary is probed in the background and restored after a run of healthy
 * probes and a minimum dwell. Each owner should hold its OWN Connection pair so
 * a swap here cannot disturb another stream's sockets.
 */
export class RpcFailover {
  private active: Connection;
  private role: 'primary' | 'backup' = 'primary';
  private timer: ReturnType<typeof setInterval> | null = null;
  private fails = 0;
  private primaryOk = 0;
  private isSwitching = false;
  private stopped = true;
  private failoverCount = 0;
  private failbackCount = 0;
  private lastFailoverAtMs: number | null = null;
  private watchedConn: Connection | null = null;
  private releaseWatch: (() => void) | null = null;

  constructor(private readonly opts: RpcFailoverOptions) {
    this.active = opts.primary;
  }

  /** The connection owners should create new subscriptions on. */
  get activeConnection(): Connection {
    return this.active;
  }

  get rpcRole(): 'primary' | 'backup' {
    return this.role;
  }

  /** Idempotent. Does nothing when no backup is configured. */
  start(): void {
    if (!this.opts.backup || this.timer) return;
    this.stopped = false;
    enableWsReconnect(this.active, 3);
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logger.warn(`[${this.opts.name}] Liveness check error`, {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }, LIVENESS_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.syncWatch(null);
  }

  /** Hold a slot watch on `wanted` (or none), releasing any previous one. */
  private syncWatch(wanted: Connection | null): void {
    if (this.watchedConn === wanted) return;
    this.releaseWatch?.();
    this.releaseWatch = null;
    this.watchedConn = null;
    if (wanted) {
      this.releaseWatch = acquireSlotWatch(wanted);
      this.watchedConn = wanted;
    }
  }

  getTelemetry(): { rpcRole: 'primary' | 'backup'; failoverCount: number; failbackCount: number } {
    return { rpcRole: this.role, failoverCount: this.failoverCount, failbackCount: this.failbackCount };
  }

  /** getSlot() with a hard timeout. True only if the RPC answered in time. */
  private async probe(conn: Connection): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), LIVENESS_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => conn.getSlot()).then(() => true, () => false),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.isSwitching) return;

    const active = this.active;

    if (this.opts.hasSubscriptions()) {
      this.syncWatch(active);
      const alive = this.opts.socketsOpen() && (await isConnectionLive(active, (c) => this.probe(c)));

      // State may have changed while the probe was in flight
      if (active !== this.active || this.stopped || this.isSwitching) return;

      if (alive) {
        this.fails = 0;
      } else {
        this.fails++;
        logger.warn(`[${this.opts.name}] Liveness probe failed`, {
          consecutive: this.fails,
          threshold: LIVENESS_FAILS_BEFORE_FAILOVER,
          rpcRole: this.role,
          endpoint: getConnectionEndpoint(active),
        });
        if (this.fails >= LIVENESS_FAILS_BEFORE_FAILOVER) {
          const other = this.role === 'primary' ? this.opts.backup : this.opts.primary;
          if (other) await this.switchTo(other, 'liveness');
          return;
        }
      }
    } else {
      // Nothing subscribed (no sockets open), so there is nothing to protect yet.
      // Drop the slot watch too so an idle stream doesn't hold a socket open.
      this.fails = 0;
      this.syncWatch(null);
    }

    // Background failback: only while on backup, after a minimum dwell time
    if (
      this.role === 'backup' &&
      supportsLogsSubscribe(this.opts.primary) &&
      Date.now() - (this.lastFailoverAtMs ?? 0) >= MIN_BACKUP_DWELL_MS
    ) {
      if (await this.probe(this.opts.primary)) {
        this.primaryOk++;
        if (this.primaryOk >= PRIMARY_PROBES_BEFORE_FAILBACK) {
          await this.switchTo(this.opts.primary, 'failback');
        }
      } else {
        this.primaryOk = 0;
      }
    }
  }

  private async switchTo(target: Connection, reason: SwitchReason): Promise<void> {
    if (this.stopped || this.isSwitching || target === this.active) return;
    if (!supportsLogsSubscribe(target)) {
      logger.warn(`[${this.opts.name}] Switch skipped — logsSubscribe unsupported`, {
        reason,
        endpoint: getConnectionEndpoint(target),
      });
      return;
    }

    this.isSwitching = true;
    try {
      // Don't abandon the current line for one that is also down
      if (!(await this.probe(target))) {
        logger.warn(`[${this.opts.name}] Switch aborted — target RPC not responding`, {
          reason,
          endpoint: getConnectionEndpoint(target),
        });
        this.primaryOk = 0;
        return;
      }

      const prevRole = this.role;
      const toPrimary = target === this.opts.primary;
      this.active = target;
      this.role = toPrimary ? 'primary' : 'backup';
      if (toPrimary) {
        this.failbackCount++;
      } else {
        this.failoverCount++;
        this.lastFailoverAtMs = Date.now();
      }
      enableWsReconnect(target, 3);

      try {
        await this.opts.moveTo(target, reason);
      } catch (err) {
        logger.error(`[${this.opts.name}] Moving subscriptions failed`, {
          reason,
          err: err instanceof Error ? err.message : String(err),
        });
      }

      this.fails = 0;
      this.primaryOk = 0;
      logger.info(`[${this.opts.name}] RPC role changed`, {
        from: prevRole,
        to: this.role,
        reason,
        endpoint: getConnectionEndpoint(target),
      });
    } finally {
      this.isSwitching = false;
    }
  }
}
