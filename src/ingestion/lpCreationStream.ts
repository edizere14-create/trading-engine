import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { bus } from '../core/eventBus';
import { NewPoolEvent } from '../core/types';
import { logger } from '../core/logger';
import { acquireSlotWatch, isConnectionLive } from './wsLiveness';
import { disableWsReconnect, enableWsReconnect, getConnectionEndpoint, isWsOpen, removeLogsListenerBounded, resetWsReconnectCount, supportsLogsSubscribe } from './wsControl';

export const POOL_PROGRAMS = {
  RAYDIUM_AMM_V4: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  METEORA_DLMM:   new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
  ORCA_WHIRLPOOL: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
} as const;

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const USDC_MINT   = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const HEALTH_CHECK_INTERVAL_MS = 30_000; // Check every 30s
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_COOLDOWN_MS = 120_000; // Suppress health-check reconnects for 120s after a reconnect
const LIVENESS_INTERVAL_MS = 10_000;       // transport liveness probe cadence (independent of event flow)
const LIVENESS_TIMEOUT_MS = 4_000;         // a probe slower than this counts as failed
const LIVENESS_FAILS_BEFORE_FAILOVER = 3;  // consecutive failed probes (~30s) before swapping RPC
const PRIMARY_PROBES_BEFORE_FAILBACK = 6;  // consecutive healthy primary probes (~60s) before swapping back
const MIN_BACKUP_DWELL_MS = 90_000;        // stay on backup at least this long before failing back (anti-flap)
const LP_SILENCE_THRESHOLD_MS = 30 * 60_000; // New LP events are bursty; 90s causes false positives

export class LPCreationStream {
  private primaryConnection: Connection;
  private backupConnection: Connection | null;
  private activeConnection: Connection;
  private subscriptions: number[] = [];
  private subscriptionConnection: Connection | null = null; // track which connection owns subscriptions
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private livenessInterval: ReturnType<typeof setInterval> | null = null;
  private livenessFails = 0;
  private primaryProbeOk = 0;
  private failbackCount = 0;
  private isSwitching = false;
  private watchedConn: Connection | null = null;
  private releaseWatch: (() => void) | null = null;
  private lastEventTime: number = Date.now();
  private reconnectAttempts = 0;
  private isReconnecting = false;
  private isClearing = false;
  private reconnectCooldownUntil = 0;
  private isStopped = false;
  private wsHeartbeatOk = 0;
  private wsHeartbeatFail = 0;
  private rpcRole: 'primary' | 'backup' = 'primary';
  private reconnectTotal = 0;
  private failoverCount = 0;
  private lastFailoverAtMs: number | null = null;
  private lastRecoveryMs: number | null = null;
  private totalRecoveryMs = 0;
  private recoverySamples = 0;

  constructor(connection: Connection, backupConnection?: Connection) {
    this.primaryConnection = connection;
    this.backupConnection = backupConnection ?? null;
    this.activeConnection = connection;
  }

  async start(): Promise<void> {
    this.isStopped = false;

    // Verify primary RPC is reachable before subscribing
    // If it's 429'd, failover to backup immediately instead of waiting for health check
    const usable = await this.pickUsableConnection();
    if (usable) {
      this.activeConnection = usable;
    }
    logger.info('LP stream using RPC', {
      endpoint: getConnectionEndpoint(this.activeConnection),
      role: this.activeConnection === this.primaryConnection ? 'primary' : 'backup',
    });
    this.rpcRole = this.activeConnection === this.primaryConnection ? 'primary' : 'backup';

    // Limit WS auto-reconnects on the active connection (default is Infinity)
    enableWsReconnect(this.activeConnection, 3);
    // Disable WS retry on the inactive connection
    const inactive = this.activeConnection === this.primaryConnection
      ? this.backupConnection
      : this.primaryConnection;
    if (inactive) disableWsReconnect(inactive);

    await this.subscribe();
    this.startHealthCheck();
    this.startLivenessWatchdog();
  }

  /** Try primary, then backup. Returns the first connection where getSlot() succeeds, or null. */
  private async pickUsableConnection(): Promise<Connection | null> {
    const candidates = [this.primaryConnection, this.backupConnection].filter(Boolean) as Connection[];
    for (const conn of candidates) {
      if (!supportsLogsSubscribe(conn)) {
        const label = conn === this.primaryConnection ? 'primary' : 'backup';
        logger.warn(`LP stream ${label} RPC skipped — logsSubscribe unsupported`, {
          endpoint: getConnectionEndpoint(conn),
        });
        disableWsReconnect(conn);
        continue;
      }
      try {
        await conn.getSlot();
        return conn;
      } catch {
        const label = conn === this.primaryConnection ? 'primary' : 'backup';
        logger.warn(`LP stream ${label} RPC unreachable at startup — trying next`);
        disableWsReconnect(conn);
      }
    }
    logger.warn('LP stream all RPCs unreachable at startup — using primary as fallback');
    return null;
  }

  private async subscribe(): Promise<void> {
    // Clear any existing subscriptions on the OLD connection before subscribing on the new one
    await this.clearSubscriptions();

    const entries = Object.entries(POOL_PROGRAMS);
    for (let i = 0; i < entries.length; i++) {
      const [name, programId] = entries[i];
      try {
        const subId = this.activeConnection.onLogs(
          programId,
          (logs: Logs, ctx: Context) => {
            this.lastEventTime = Date.now();
            this.reconnectAttempts = 0;
            this.handleLogs(logs, ctx, name).catch((err) => {
              logger.warn('LP handleLogs error', {
                program: name,
                err: err instanceof Error ? err.message : String(err),
              });
            });
          },
          'confirmed'
        );
        this.subscriptions.push(subId);
        logger.info('LP stream subscribed', { program: name, programId: programId.toBase58() });
        // Stagger subscriptions slightly to avoid burst
        if (i < entries.length - 1) await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        logger.error('LP subscription failed', {
          program: name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.subscriptionConnection = this.activeConnection;
  }

  private startHealthCheck(): void {
    if (this.healthInterval) clearInterval(this.healthInterval);

    this.healthInterval = setInterval(async () => {
      if (this.isStopped || this.isReconnecting) return;

      // Skip ALL health checks during cooldown after a recent reconnect
      if (Date.now() < this.reconnectCooldownUntil) return;

      const silentMs = Date.now() - this.lastEventTime;

      // LP creation is naturally bursty; only treat very long silence as suspicious.
      if (silentMs > LP_SILENCE_THRESHOLD_MS) {
        this.wsHeartbeatFail++;
        logger.warn('LP stream silent — reconnecting', {
          silentSeconds: Math.round(silentMs / 1000),
          attempt: this.reconnectAttempts + 1,
          rpcRole: this.rpcRole,
          reconnectBudget: `${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
        });
        await this.reconnect();
        return;
      }

      // WS events have flowed recently — the subscription is alive.
      // Avoid HTTP getSlot() probes which can produce false positives when the
      // provider rate-limits HTTP but keeps WebSocket connections alive.
      this.wsHeartbeatOk++;
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /** Keep exactly one slot-watch reference, on whichever connection is active. */
  private syncSlotWatch(): void {
    if (this.watchedConn === this.activeConnection) return;
    this.releaseWatch?.();
    this.watchedConn = this.activeConnection;
    this.releaseWatch = acquireSlotWatch(this.activeConnection);
  }

  /** getSlot() with a hard timeout. True only if the RPC answered in time. */
  private async probe(conn: Connection): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), LIVENESS_TIMEOUT_MS);
    });
    try {
      return await Promise.race([conn.getSlot().then(() => true, () => false), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Transport-level watchdog. Unlike the 30-min silence check (LP events are
   * bursty), this probes the active line every 10s: the socket must be OPEN and
   * getSlot() must answer. Three consecutive failures swap to the other RPC. While
   * on the backup, the primary is probed in the background and restored once it
   * has been healthy for several consecutive probes.
   */
  private startLivenessWatchdog(): void {
    if (this.livenessInterval) clearInterval(this.livenessInterval);
    this.livenessInterval = setInterval(() => {
      this.checkLiveness().catch((err) => {
        logger.warn('LP liveness check error', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }, LIVENESS_INTERVAL_MS);
  }

  private async checkLiveness(): Promise<void> {
    if (this.isStopped || this.isReconnecting || this.isSwitching) return;

    const active = this.activeConnection;
    this.syncSlotWatch();
    const alive = isWsOpen(active) && (await isConnectionLive(active, (c) => this.probe(c)));

    // State may have changed while the probe was in flight
    if (active !== this.activeConnection || this.isStopped || this.isReconnecting || this.isSwitching) return;

    if (alive) {
      this.wsHeartbeatOk++;
      this.livenessFails = 0;
    } else {
      this.wsHeartbeatFail++;
      this.livenessFails++;
      logger.warn('LP stream liveness probe failed', {
        consecutive: this.livenessFails,
        threshold: LIVENESS_FAILS_BEFORE_FAILOVER,
        rpcRole: this.rpcRole,
        endpoint: getConnectionEndpoint(active),
      });
      if (this.livenessFails >= LIVENESS_FAILS_BEFORE_FAILOVER) {
        const other = this.rpcRole === 'primary' ? this.backupConnection : this.primaryConnection;
        if (other) {
          await this.switchTo(other, 'liveness');
        } else {
          logger.warn('LP stream liveness failing but no alternate RPC configured');
        }
        return;
      }
    }

    // Background failback: only while on backup, after a minimum dwell time
    if (
      this.rpcRole === 'backup' &&
      supportsLogsSubscribe(this.primaryConnection) &&
      Date.now() - (this.lastFailoverAtMs ?? 0) >= MIN_BACKUP_DWELL_MS
    ) {
      if (await this.probe(this.primaryConnection)) {
        this.primaryProbeOk++;
        if (this.primaryProbeOk >= PRIMARY_PROBES_BEFORE_FAILBACK) {
          await this.switchTo(this.primaryConnection, 'failback');
        }
      } else {
        this.primaryProbeOk = 0;
      }
    }
  }

  /** Hot-swap all LP subscriptions to `target`. Verifies the target answers first. */
  private async switchTo(target: Connection, reason: 'liveness' | 'failback'): Promise<void> {
    if (this.isStopped || this.isReconnecting || this.isSwitching || target === this.activeConnection) return;
    if (!supportsLogsSubscribe(target)) {
      logger.warn('LP stream switch skipped — logsSubscribe unsupported', {
        reason,
        endpoint: getConnectionEndpoint(target),
      });
      return;
    }

    this.isSwitching = true;
    try {
      // Don't abandon the current line for one that is also down
      if (!(await this.probe(target))) {
        logger.warn('LP stream switch aborted — target RPC not responding', {
          reason,
          endpoint: getConnectionEndpoint(target),
        });
        this.primaryProbeOk = 0;
        return;
      }

      const prevRole = this.rpcRole;
      const toPrimary = target === this.primaryConnection;
      // Don't close the old connection: other streams share it, and an explicit
      // close would leave their subscriptions silently dead.
      this.activeConnection = target;
      this.rpcRole = toPrimary ? 'primary' : 'backup';
      if (toPrimary) {
        this.failbackCount++;
        if (this.lastFailoverAtMs) {
          this.lastRecoveryMs = Date.now() - this.lastFailoverAtMs;
          this.totalRecoveryMs += this.lastRecoveryMs;
          this.recoverySamples++;
        }
      } else {
        this.failoverCount++;
        this.lastFailoverAtMs = Date.now();
      }
      enableWsReconnect(target, 3);
      await this.subscribe();

      this.lastEventTime = Date.now();
      this.livenessFails = 0;
      this.primaryProbeOk = 0;
      this.reconnectCooldownUntil = Date.now() + RECONNECT_COOLDOWN_MS;
      resetWsReconnectCount(target);
      logger.info('LP stream RPC role changed', {
        from: prevRole,
        to: this.rpcRole,
        reason,
        endpoint: getConnectionEndpoint(target),
      });
    } finally {
      this.isSwitching = false;
    }
  }

  private async reconnect(): Promise<void> {
    if (this.isStopped || this.isReconnecting || this.isSwitching) return;
    this.isReconnecting = true;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error('LP stream max reconnect attempts reached — triggering HALT', {
        reconnectAttempts: this.reconnectAttempts,
        budget: `${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
        rpcRole: this.rpcRole,
        heartbeatOk: this.wsHeartbeatOk,
        heartbeatFail: this.wsHeartbeatFail,
      });
      bus.emit('system:halt', { reason: 'LP stream WebSocket unrecoverable', resumeAt: undefined });
      this.isReconnecting = false;
      return;
    }

    this.reconnectAttempts++;
    this.reconnectTotal++;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS
    );

    logger.info('LP stream reconnecting', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
      budget: `${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
      rpcRole: this.rpcRole,
    });
    await new Promise((r) => setTimeout(r, delay));

    // Failover to backup immediately on first attempt, then alternate
    if (this.backupConnection && this.reconnectAttempts % 2 === 1) {
      if (supportsLogsSubscribe(this.backupConnection)) {
        const prevRole = this.rpcRole;
        this.activeConnection = this.backupConnection;
        this.rpcRole = 'backup';
        this.failoverCount++;
        this.lastFailoverAtMs = Date.now();
        enableWsReconnect(this.activeConnection, 3);
        logger.info('LP stream RPC role changed', {
          from: prevRole,
          to: this.rpcRole,
          endpoint: getConnectionEndpoint(this.activeConnection),
          reconnectBudget: `${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
        });
      } else {
        logger.warn('LP stream backup RPC skipped during failover — logsSubscribe unsupported', {
          endpoint: getConnectionEndpoint(this.backupConnection),
          reconnectBudget: `${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
        });
      }
    } else if (this.reconnectAttempts > 1) {
      const prevRole = this.rpcRole;
      this.activeConnection = this.primaryConnection;
      this.rpcRole = 'primary';
      if (this.lastFailoverAtMs) {
        this.lastRecoveryMs = Date.now() - this.lastFailoverAtMs;
        this.totalRecoveryMs += this.lastRecoveryMs;
        this.recoverySamples++;
      }
      enableWsReconnect(this.activeConnection, 3);
      logger.info('LP stream RPC role changed', {
        from: prevRole,
        to: this.rpcRole,
        endpoint: getConnectionEndpoint(this.activeConnection),
        reconnectBudget: `${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
      });
    }
    // On attempt 1 with no backup, stays on primary

    try {
      await this.subscribe();
      // Do NOT reset reconnectAttempts here — only reset when real events arrive
      // in the onLogs callback. This keeps exponential backoff intact.

      // Verify the connection responds before declaring success.
      // Use a 5s timeout so a slow/rate-limited HTTP endpoint doesn't hang here.
      const lpReachable = await Promise.race([
        this.activeConnection.getSlot().then(() => true, () => false),
        new Promise<false>(r => setTimeout(() => r(false), 5_000)),
      ]);
      if (!lpReachable) {
        logger.warn('LP stream reconnected but RPC still unreachable — will retry next cycle');
        this.reconnectCooldownUntil = Date.now() + RECONNECT_COOLDOWN_MS;
        return;
      }

      this.lastEventTime = Date.now(); // Reset timer after reconnection
      this.reconnectCooldownUntil = Date.now() + RECONNECT_COOLDOWN_MS;
      resetWsReconnectCount(this.activeConnection);
      logger.info('LP stream reconnected successfully', {
        attempt: this.reconnectAttempts,
        rpcRole: this.rpcRole,
        heartbeatOk: this.wsHeartbeatOk,
        heartbeatFail: this.wsHeartbeatFail,
      });
    } catch (err) {
      logger.error('LP stream reconnect failed', {
        attempt: this.reconnectAttempts,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isReconnecting = false;
    }
  }

  private async handleLogs(logs: Logs, ctx: Context, programName: string): Promise<void> {
    const isNewPool =
      logs.logs.some((l) => l.includes('initialize2')) ||
      logs.logs.some((l) => l.includes('InitializeLbPair'));

    if (!isNewPool || logs.err) return;

    try {
      const event = await this.parsePoolCreation(logs.signature, ctx.slot, programName);
      if (event) {
        bus.emit('pool:created', event);
        logger.info('New pool detected', {
          tokenCA: event.tokenCA,
          liqSOL: event.initialLiquiditySOL,
          deployer: event.deployer,
          program: programName,
          slot: ctx.slot,
        });
      }
    } catch (err) {
      logger.warn('Pool parse failed', {
        sig: logs.signature,
        program: programName,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async parsePoolCreation(
    signature: string,
    slot: number,
    programName: string
  ): Promise<NewPoolEvent | null> {
    const tx = await this.activeConnection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx?.meta || !tx.transaction) return null;

    // Extract token CA: the non-SOL/non-USDC mint in the pool
    const mints =
      tx.meta.postTokenBalances
        ?.map((b) => b.mint)
        .filter((m) => m !== WRAPPED_SOL && m !== USDC_MINT) ?? [];

    if (mints.length === 0) return null;

    // Deduplicate mints
    const uniqueMints = [...new Set(mints)];
    const tokenCA = uniqueMints[0];

    const deployer = tx.transaction.message.accountKeys[0].pubkey.toBase58();

    // Estimate initial SOL liquidity from SOL balance change
    const preBalance = tx.meta.preBalances[0];
    const postBalance = tx.meta.postBalances[0];
    const solChange = Math.abs((postBalance - preBalance) / 1e9);

    return {
      poolAddress: signature, // refined later with account parsing
      tokenCA,
      baseToken: 'SOL',
      initialLiquiditySOL: solChange,
      deployer,
      signature,
      slot,
      detectedAt: new Date(),
      source: 'RPC_LOGS',
    };
  }

  private async clearSubscriptions(): Promise<void> {
    if (this.isClearing) return;
    this.isClearing = true;

    try {
      // Snapshot and detach before async cleanup
      const conn = this.subscriptionConnection ?? this.activeConnection;
      const subIds = [...this.subscriptions];
      this.subscriptions = [];
      this.subscriptionConnection = null;

      // Always detach (bounded): a closed socket must not keep stale listeners
      await Promise.all(subIds.map((subId) => removeLogsListenerBounded(conn, subId)));
    } finally {
      this.isClearing = false;
    }
  }

  public getTelemetry(): {
    reconnectAttempts: number;
    reconnectTotal: number;
    reconnectBudget: string;
    rpcRole: 'primary' | 'backup';
    failoverCount: number;
    failbackCount: number;
    lastRecoveryMs: number | null;
    avgRecoveryMs: number;
    wsHeartbeatOk: number;
    wsHeartbeatFail: number;
    subscriptionCount: number;
  } {
    return {
      reconnectAttempts: this.reconnectAttempts,
      reconnectTotal: this.reconnectTotal,
      reconnectBudget: `${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
      rpcRole: this.rpcRole,
      failoverCount: this.failoverCount,
      failbackCount: this.failbackCount,
      lastRecoveryMs: this.lastRecoveryMs,
      avgRecoveryMs: this.recoverySamples > 0 ? this.totalRecoveryMs / this.recoverySamples : 0,
      wsHeartbeatOk: this.wsHeartbeatOk,
      wsHeartbeatFail: this.wsHeartbeatFail,
      subscriptionCount: this.subscriptions.length,
    };
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = null;
    }
    this.releaseWatch?.();
    this.releaseWatch = null;
    this.watchedConn = null;
    await this.clearSubscriptions();
    disableWsReconnect(this.primaryConnection);
    if (this.backupConnection) disableWsReconnect(this.backupConnection);
    logger.info('LP stream stopped');
  }
}
