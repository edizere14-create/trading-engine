import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { bus } from '../core/eventBus';
import { NewPoolEvent } from '../core/types';
import { logger } from '../core/logger';
import { disableWsReconnect, enableWsReconnect, getConnectionEndpoint, isWsOpen, resetWsReconnectCount, supportsLogsSubscribe } from './wsControl';

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
const LP_SILENCE_THRESHOLD_MS = 30 * 60_000; // New LP events are bursty; 90s causes false positives

export class LPCreationStream {
  private primaryConnection: Connection;
  private backupConnection: Connection | null;
  private activeConnection: Connection;
  private subscriptions: number[] = [];
  private subscriptionConnection: Connection | null = null; // track which connection owns subscriptions
  private healthInterval: ReturnType<typeof setInterval> | null = null;
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

  private async reconnect(): Promise<void> {
    if (this.isStopped || this.isReconnecting) return;
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
        disableWsReconnect(this.activeConnection); // Stop old connection's WS retry loop
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
      disableWsReconnect(this.activeConnection); // Stop old connection's WS retry loop
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
      const oldSubConn = this.subscriptionConnection;
      this.subscriptionConnection = null;

      for (const subId of subIds) {
        try {
          if (isWsOpen(conn)) {
            await conn.removeOnLogsListener(subId);
          }
        } catch {
          // Socket may be CLOSING/CLOSED — safe to ignore
        }
      }

      // Stop the old connection's WS retry if it's not the active one
      if (oldSubConn && oldSubConn !== this.activeConnection) {
        disableWsReconnect(oldSubConn);
      }
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
    await this.clearSubscriptions();
    disableWsReconnect(this.primaryConnection);
    if (this.backupConnection) disableWsReconnect(this.backupConnection);
    logger.info('LP stream stopped');
  }
}
