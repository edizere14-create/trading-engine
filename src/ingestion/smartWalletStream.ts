import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { bus } from '../core/eventBus';
import { SwapEvent, ClusterAlert } from '../core/types';
import { WalletRegistry } from '../registry/walletRegistry';
import { logger } from '../core/logger';
import { disableWsReconnect, enableWsReconnect, resetWsReconnectCount } from './wsControl';

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const USDC_MINT   = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Known DEX program IDs for swap detection
const SWAP_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM V4
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   // Orca Whirlpool
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',   // Meteora DLMM
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',   // Jupiter v6
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',   // PumpFun Bonding Curve
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',   // PumpSwap AMM
]);

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_COOLDOWN_MS = 120_000;
const EVENT_DEDUP_TTL_MS = 120_000;
const EVENT_FINGERPRINT_TTL_MS = 10_000;
const CLEANUP_INTERVAL_MS = 60_000;

// ── CONNECTION POOL ─────────────────────────────────────
const MAX_SUBS_PER_CONNECTION = 400; // conservative buffer under RPC ~512 ceiling
const SUBSCRIBE_BATCH_SIZE = 50;
const SUBSCRIBE_BATCH_DELAY_MS = 200;
const SILENCE_THRESHOLD_MS = 30 * 60_000; // 30 min — most wallets don't transact every few minutes
const SILENCE_CHECK_INTERVAL_MS = 60_000;
const SILENCE_RESUB_MAX_PER_CYCLE = 10; // limit churn per cycle
const COVERAGE_WARMUP_MS = 10 * 60_000; // 10 min warmup before coverage checks fire
const COVERAGE_DEGRADED_PCT = 0.15;    // warn below 15% (realistic: most wallets don't transact every 10 min)
const COVERAGE_CRITICAL_PCT = 0.05;    // halt only below 5% (near-total subscription failure)

interface ClusterEntry {
  wallet: string;
  timestamp: number;
  pnl30d: number;
}

interface SubscriptionRef {
  connection: Connection;
  subId: number;
  address: string;
  subscribedAt: number;
  lastLogAt: number | null;
}

class ClusterDetector {
  private buyMap: Map<string, ClusterEntry[]> = new Map();
  private readonly WINDOW_MS = 600_000; // 600 seconds
  private readonly MIN_WALLETS = 3;

  recordBuy(tokenCA: string, wallet: string, walletRegistry: WalletRegistry): void {
    const now = Date.now();
    const stats = walletRegistry.getWalletStats(wallet);
    const entry: ClusterEntry = {
      wallet,
      timestamp: now,
      pnl30d: stats?.pnl30d ?? 0,
    };

    const existing = this.buyMap.get(tokenCA) ?? [];
    existing.push(entry);

    // Prune expired entries
    const pruned = existing.filter((e) => now - e.timestamp < this.WINDOW_MS);
    this.buyMap.set(tokenCA, pruned);

    // Deduplicate wallets in window
    const uniqueWallets = new Set(pruned.map((e) => e.wallet));

    if (uniqueWallets.size >= this.MIN_WALLETS) {
      const totalWeightedPnL = pruned.reduce((sum, e) => sum + e.pnl30d, 0);
      const alert: ClusterAlert = {
        tokenCA,
        wallets: Array.from(uniqueWallets),
        totalWeightedPnL,
        windowSeconds: this.WINDOW_MS / 1000,
        triggeredAt: new Date(),
      };
      bus.emit('cluster:alert', alert);
      logger.info('Cluster alert triggered', {
        tokenCA,
        walletCount: uniqueWallets.size,
        totalWeightedPnL,
      });
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [tokenCA, entries] of this.buyMap) {
      const pruned = entries.filter((e) => now - e.timestamp < this.WINDOW_MS);
      if (pruned.length === 0) {
        this.buyMap.delete(tokenCA);
      } else {
        this.buyMap.set(tokenCA, pruned);
      }
    }
  }
}

export class SmartWalletStream {
  private rpcUrl: string;
  private backupRpcUrl: string | null;
  private primaryConnection: Connection;
  private backupConnection: Connection | null;
  private activeConnection: Connection;
  private walletRegistry: WalletRegistry;
  private subscriptions: Map<string, SubscriptionRef> = new Map();
  private connectionPool: Connection[] = [];
  private connectionSubCounts: Map<Connection, number> = new Map();
  private clusterDetector: ClusterDetector;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private silenceInterval: ReturnType<typeof setInterval> | null = null;
  private lastEventTime: number = Date.now();
  private reconnectAttempts = 0;
  private isReconnecting = false;
  private isClearing = false;
  private reconnectCooldownUntil = 0;
  private isStopped = false;
  private recentSignatures: Map<string, number> = new Map();
  private recentEventFingerprints: Map<string, number> = new Map();
  private inFlightSignatures: Set<string> = new Set();

  constructor(connection: Connection, walletRegistry: WalletRegistry, backupConnection?: Connection) {
    this.primaryConnection = connection;
    this.backupConnection = backupConnection ?? null;
    this.activeConnection = connection;
    this.walletRegistry = walletRegistry;
    this.clusterDetector = new ClusterDetector();

    // Extract RPC URLs for creating pool connections
    // @ts-expect-error — Connection._rpcEndpoint is internal but needed for pool
    this.rpcUrl = connection._rpcEndpoint ?? connection.rpcEndpoint ?? '';
    // @ts-expect-error — same for backup
    this.backupRpcUrl = backupConnection ? (backupConnection._rpcEndpoint ?? backupConnection.rpcEndpoint ?? null) : null;

    // Seed pool with existing connections
    this.connectionPool.push(connection);
    this.connectionSubCounts.set(connection, 0);
    if (backupConnection) {
      this.connectionPool.push(backupConnection);
      this.connectionSubCounts.set(backupConnection, 0);
      // Disable WS retry on backup until needed (prevents idle 429 loops)
      disableWsReconnect(backupConnection);
    }
  }

  async start(): Promise<void> {
    this.isStopped = false;
    this.recentSignatures.clear();
    this.recentEventFingerprints.clear();
    this.inFlightSignatures.clear();

    // Verify RPC is reachable before subscribing
    const usable = await this.pickUsableConnection();
    if (usable) {
      this.activeConnection = usable;
    }

    // Limit WS auto-reconnects on the active connection (default is Infinity)
    enableWsReconnect(this.activeConnection, 3);

    const wallets = this.walletRegistry.getAll();
    if (wallets.length === 0) {
      logger.warn('SmartWalletStream: no wallets to monitor');
      return;
    }

    await this.subscribeAll(wallets.map(w => w.address));
    this.startHealthCheck();
    this.startSilenceDetector();

    // Periodic cleanup for cluster state + dedupe cache
    this.cleanupInterval = setInterval(() => {
      this.clusterDetector.cleanup();
      this.cleanupSignatureCache();
    }, CLEANUP_INTERVAL_MS);
  }

  /** Try active, then other. Returns the first connection where getSlot() succeeds, or null. */
  private async pickUsableConnection(): Promise<Connection | null> {
    const candidates = [this.primaryConnection, this.backupConnection].filter(Boolean) as Connection[];
    for (const conn of candidates) {
      try {
        await conn.getSlot();
        return conn;
      } catch {
        const label = conn === this.primaryConnection ? 'primary' : 'backup';
        logger.warn(`[WalletStream] ${label} RPC unreachable at startup — trying next`);
        disableWsReconnect(conn);
      }
    }
    logger.warn('[WalletStream] All RPCs unreachable at startup — using primary as fallback');
    return null;
  }

  // ── CONNECTION POOL ────────────────────────────────────

  private getAvailableConnection(): Connection {
    // Find a connection with room under the limit
    for (const conn of this.connectionPool) {
      const count = this.connectionSubCounts.get(conn) ?? 0;
      if (count < MAX_SUBS_PER_CONNECTION) {
        enableWsReconnect(conn, 3); // Re-enable WS before subscribing (may have been disabled)
        return conn;
      }
    }

    // All full — create a new connection
    const url = this.backupRpcUrl && this.connectionPool.length % 2 === 1
      ? this.backupRpcUrl
      : this.rpcUrl;

    const conn = new Connection(url, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30_000,
    });
    enableWsReconnect(conn, 3);
    this.connectionPool.push(conn);
    this.connectionSubCounts.set(conn, 0);
    logger.info('[WalletStream] Added connection to pool', {
      poolSize: this.connectionPool.length,
      rpc: url.substring(0, 30) + '...',
    });
    return conn;
  }

  // ── BATCH SUBSCRIPTION ─────────────────────────────────

  private async subscribeAll(walletAddresses: string[]): Promise<void> {
    logger.info('[WalletStream] Subscribing wallets in batches', {
      total: walletAddresses.length,
      batchSize: SUBSCRIBE_BATCH_SIZE,
      maxSubsPerConnection: MAX_SUBS_PER_CONNECTION,
    });

    for (let i = 0; i < walletAddresses.length; i += SUBSCRIBE_BATCH_SIZE) {
      const batch = walletAddresses.slice(i, i + SUBSCRIBE_BATCH_SIZE);
      await Promise.all(batch.map(addr => this.subscribeWallet(addr)));

      if (i + SUBSCRIBE_BATCH_SIZE < walletAddresses.length) {
        await new Promise(r => setTimeout(r, SUBSCRIBE_BATCH_DELAY_MS));
      }
    }

    this.logCoverageReport();
    logger.info('[WalletStream] Subscription complete', {
      active: this.subscriptions.size,
      total: walletAddresses.length,
    });
  }

  private async subscribeWallet(address: string): Promise<void> {
    if (this.subscriptions.has(address)) return; // already subscribed

    const conn = this.getAvailableConnection();
    try {
      const pubkey = new PublicKey(address);
      const subId = conn.onLogs(
        pubkey,
        (logs: Logs, ctx: Context) => {
          this.lastEventTime = Date.now();
          this.reconnectAttempts = 0;

          // Track last log time for silence detection
          const sub = this.subscriptions.get(address);
          if (sub) sub.lastLogAt = Date.now();

          this.handleLogs(logs, ctx, address).catch((err) => {
            logger.warn('Wallet handleLogs error', {
              wallet: address,
              err: err instanceof Error ? err.message : String(err),
            });
          });
        },
        'confirmed'
      );

      this.subscriptions.set(address, {
        connection: conn,
        subId,
        address,
        subscribedAt: Date.now(),
        lastLogAt: null,
      });
      this.connectionSubCounts.set(conn, (this.connectionSubCounts.get(conn) ?? 0) + 1);
    } catch (err) {
      logger.error('Wallet subscription failed', {
        wallet: address,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async unsubscribeWallet(address: string): Promise<void> {
    const sub = this.subscriptions.get(address);
    if (!sub) return;

    try {
      await sub.connection.removeOnLogsListener(sub.subId);
    } catch {
      // Socket may be closing/closed — safe to ignore
    }

    this.connectionSubCounts.set(
      sub.connection,
      Math.max(0, (this.connectionSubCounts.get(sub.connection) ?? 1) - 1)
    );
    this.subscriptions.delete(address);
  }

  private async resubscribeWallet(address: string): Promise<void> {
    await this.unsubscribeWallet(address);
    await this.subscribeWallet(address);
  }

  // ── SILENCE DETECTION ──────────────────────────────────

  private startSilenceDetector(): void {
    if (this.silenceInterval) clearInterval(this.silenceInterval);

    this.silenceInterval = setInterval(async () => {
      if (this.isStopped) return;

      const now = Date.now();
      let resubCount = 0;

      for (const [address, sub] of this.subscriptions) {
        const silentMs = now - (sub.lastLogAt ?? sub.subscribedAt);

        if (silentMs > SILENCE_THRESHOLD_MS) {
          logger.debug('[WalletStream] Wallet silent — resubscribing', {
            wallet: address,
            silentMinutes: Math.round(silentMs / 60_000),
          });
          await this.resubscribeWallet(address);
          resubCount++;

          // Don't resubscribe too many at once
          if (resubCount >= SILENCE_RESUB_MAX_PER_CYCLE) {
            break;
          }
        }
      }

      this.checkCoverageHealth();
    }, SILENCE_CHECK_INTERVAL_MS);
  }

  // ── COVERAGE MONITORING ────────────────────────────────

  private logCoverageReport(): void {
    const total = this.subscriptions.size;
    const active = [...this.subscriptions.values()].filter(s => s.lastLogAt !== null).length;
    const silent = [...this.subscriptions.values()].filter(
      s => s.lastLogAt === null && Date.now() - s.subscribedAt > 60_000
    ).length;

    logger.info('[WalletStream] Coverage report', {
      total,
      seenLogs: active,
      silentOver60s: silent,
      poolSize: this.connectionPool.length,
      connectionDistribution: this.connectionPool.map(
        (conn, i) => `conn${i}:${this.connectionSubCounts.get(conn) ?? 0}`
      ).join(', '),
    });
  }

  private checkCoverageHealth(): void {
    const total = this.subscriptions.size;
    if (total === 0) return;

    // Don't check coverage until subscriptions have had time to receive logs
    const oldestSub = Math.min(...[...this.subscriptions.values()].map(s => s.subscribedAt));
    const uptimeMs = Date.now() - oldestSub;
    if (uptimeMs < COVERAGE_WARMUP_MS) {
      logger.debug('[WalletStream] Coverage check skipped — warming up', {
        uptimeSeconds: Math.round(uptimeMs / 1000),
        warmupSeconds: Math.round(COVERAGE_WARMUP_MS / 1000),
      });
      return;
    }

    const recentlySeen = [...this.subscriptions.values()].filter(
      s => s.lastLogAt && Date.now() - s.lastLogAt < 10 * 60_000
    ).length;

    const coveragePct = recentlySeen / total;

    if (coveragePct < COVERAGE_CRITICAL_PCT) {
      logger.error('[WalletStream] Coverage CRITICAL — wallet stream degraded', {
        coveragePct: Math.round(coveragePct * 100),
        recentlySeen,
        total,
      });
      bus.emit('system:halt', {
        reason: `Wallet stream coverage critical: ${Math.round(coveragePct * 100)}%`,
        resumeAt: undefined,
      });
    } else if (coveragePct < COVERAGE_DEGRADED_PCT) {
      logger.warn('[WalletStream] Coverage degraded', {
        coveragePct: Math.round(coveragePct * 100),
        recentlySeen,
        total,
      });
    }
  }

  private startHealthCheck(): void {
    if (this.healthInterval) clearInterval(this.healthInterval);

    this.healthInterval = setInterval(async () => {
      if (this.isStopped || this.isReconnecting) return;

      // Skip ALL health checks during cooldown after a recent reconnect
      if (Date.now() < this.reconnectCooldownUntil) return;

      const silentMs = Date.now() - this.lastEventTime;

      // If no events for 90s, subscriptions are likely dead
      if (silentMs > 90_000) {
        logger.warn('Wallet stream silent \u2014 reconnecting', {
          silentSeconds: Math.round(silentMs / 1000),
          attempt: this.reconnectAttempts + 1,
        });
        await this.reconnect();
        return;
      }

      // Verify connection is healthy
      try {
        await this.activeConnection.getSlot();
      } catch {
        logger.warn('Wallet stream RPC unreachable \u2014 reconnecting');
        await this.reconnect();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private async reconnect(): Promise<void> {
    if (this.isStopped || this.isReconnecting) return;
    this.isReconnecting = true;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error('Wallet stream max reconnect attempts reached \u2014 triggering HALT');
      bus.emit('system:halt', { reason: 'Wallet stream WebSocket unrecoverable', resumeAt: undefined });
      this.isReconnecting = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS
    );

    logger.info('Wallet stream reconnecting', { attempt: this.reconnectAttempts, delayMs: delay });
    await new Promise((r) => setTimeout(r, delay));

    // Failover to backup immediately on first attempt, then alternate
    if (this.backupConnection && this.reconnectAttempts % 2 === 1) {
      logger.info('Wallet stream failing over to backup RPC');
      disableWsReconnect(this.activeConnection); // Stop old connection's WS retry loop
      this.activeConnection = this.backupConnection;
      enableWsReconnect(this.activeConnection, 3);
    } else if (this.reconnectAttempts > 1) {
      logger.info('Wallet stream returning to primary RPC');
      disableWsReconnect(this.activeConnection); // Stop old connection's WS retry loop
      this.activeConnection = this.primaryConnection;
      enableWsReconnect(this.activeConnection, 3);
    }

    try {
      await this.clearSubscriptions();
      const wallets = this.walletRegistry.getAll();
      await this.subscribeAll(wallets.map(w => w.address));

      // Verify the connection actually works before declaring success
      try {
        await this.activeConnection.getSlot();
      } catch {
        logger.warn('Wallet stream reconnected but RPC still unreachable — will retry next cycle');
        this.reconnectCooldownUntil = Date.now() + RECONNECT_COOLDOWN_MS;
        return;
      }

      this.lastEventTime = Date.now();
      this.reconnectCooldownUntil = Date.now() + RECONNECT_COOLDOWN_MS;
      resetWsReconnectCount(this.activeConnection);
      logger.info('Wallet stream reconnected successfully', { attempt: this.reconnectAttempts });
    } catch (err) {
      logger.error('Wallet stream reconnect failed', {
        attempt: this.reconnectAttempts,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isReconnecting = false;
    }
  }

  private async handleLogs(logs: Logs, ctx: Context, walletAddress: string): Promise<void> {
    if (logs.err) return;

    // Check if this is a swap — look for known DEX program invocations
    const isSwap = logs.logs.some((l) => {
      for (const prog of SWAP_PROGRAMS) {
        if (l.includes(prog)) return true;
      }
      return false;
    });

    if (!isSwap) return;

    const dedupeKey = `${walletAddress}:${logs.signature}`;
    const now = Date.now();
    const seenAt = this.recentSignatures.get(dedupeKey);
    if (seenAt && now - seenAt < EVENT_DEDUP_TTL_MS) {
      return;
    }
    if (this.inFlightSignatures.has(dedupeKey)) {
      return;
    }
    this.inFlightSignatures.add(dedupeKey);

    try {
      const event = await this.parseSwap(logs.signature, ctx.slot, walletAddress);
      if (event) {
        const fingerprint = `${walletAddress}:${ctx.slot}:${event.tokenCA}:${event.action}:${event.amountSOL.toFixed(6)}`;
        const seenFingerprintAt = this.recentEventFingerprints.get(fingerprint);
        if (seenFingerprintAt && now - seenFingerprintAt < EVENT_FINGERPRINT_TTL_MS) {
          this.recentSignatures.set(dedupeKey, now);
          return;
        }

        this.recentSignatures.set(dedupeKey, now);
        this.recentEventFingerprints.set(fingerprint, now);
        bus.emit('swap:detected', event);

        if (event.action === 'BUY') {
          this.clusterDetector.recordBuy(event.tokenCA, walletAddress, this.walletRegistry);
        }

        logger.info('Smart wallet swap detected', {
          signature: logs.signature,
          wallet: walletAddress,
          tokenCA: event.tokenCA,
          action: event.action,
          amountSOL: event.amountSOL,
          slot: ctx.slot,
        });
      }
    } catch (err) {
      logger.warn('Swap parse failed', {
        sig: logs.signature,
        wallet: walletAddress,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inFlightSignatures.delete(dedupeKey);
    }
  }

  private async parseSwap(
    signature: string,
    slot: number,
    walletAddress: string
  ): Promise<SwapEvent | null> {
    const tx = await this.activeConnection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx?.meta || !tx.transaction) return null;

    // Find the wallet's account index
    const accountKeys = tx.transaction.message.accountKeys;
    const walletIndex = accountKeys.findIndex(
      (k) => k.pubkey.toBase58() === walletAddress
    );
    if (walletIndex === -1) return null;

    // SOL balance change for this wallet
    const preSol = tx.meta.preBalances[walletIndex];
    const postSol = tx.meta.postBalances[walletIndex];
    const solDelta = (postSol - preSol) / 1e9;

    // Extract token mints involved (excluding SOL and USDC)
    const preTokens = tx.meta.preTokenBalances ?? [];
    const postTokens = tx.meta.postTokenBalances ?? [];

    // Find token balances belonging to this wallet
    const walletPostTokens = postTokens.filter(
      (b) => b.owner === walletAddress && b.mint !== WRAPPED_SOL && b.mint !== USDC_MINT
    );
    const walletPreTokens = preTokens.filter(
      (b) => b.owner === walletAddress && b.mint !== WRAPPED_SOL && b.mint !== USDC_MINT
    );

    if (walletPostTokens.length === 0 && walletPreTokens.length === 0) return null;

    // Determine the token CA and amount change
    const tokenMint = walletPostTokens[0]?.mint ?? walletPreTokens[0]?.mint;
    if (!tokenMint) return null;

    const preAmount = BigInt(
      walletPreTokens.find((b) => b.mint === tokenMint)?.uiTokenAmount.amount ?? '0'
    );
    const postAmount = BigInt(
      walletPostTokens.find((b) => b.mint === tokenMint)?.uiTokenAmount.amount ?? '0'
    );
    const tokenDelta = postAmount - preAmount;

    // BUY = SOL decreased, tokens increased
    // SELL = SOL increased, tokens decreased
    const action: 'BUY' | 'SELL' = tokenDelta > 0n ? 'BUY' : 'SELL';
    const amountSOL = Math.abs(solDelta);
    const amountTokens = tokenDelta < 0n ? -tokenDelta : tokenDelta;

    if (amountSOL === 0 || amountTokens === 0n) return null;

    const priceSOL = amountSOL / Number(amountTokens);

    return {
      tokenCA: tokenMint,
      wallet: walletAddress,
      action,
      amountSOL,
      amountTokens,
      priceSOL,
      slot,
      timestamp: new Date(),
      isSmartWallet: true,
    };
  }

  private cleanupSignatureCache(): void {
    const now = Date.now();
    const cutoff = now - EVENT_DEDUP_TTL_MS;
    const fingerprintCutoff = now - EVENT_FINGERPRINT_TTL_MS;
    for (const [key, ts] of this.recentSignatures) {
      if (ts < cutoff) {
        this.recentSignatures.delete(key);
      }
    }
    for (const [key, ts] of this.recentEventFingerprints) {
      if (ts < fingerprintCutoff) {
        this.recentEventFingerprints.delete(key);
      }
    }
  }

  private async clearSubscriptions(): Promise<void> {
    if (this.isClearing) return;
    this.isClearing = true;

    try {
      // Snapshot and detach before async cleanup so concurrent reconnects don't share references
      const subs = new Map(this.subscriptions);
      this.subscriptions.clear();

      for (const [, sub] of subs) {
        try {
          await sub.connection.removeOnLogsListener(sub.subId);
        } catch {
          // Socket may be CLOSING/CLOSED — safe to ignore
        }
      }

      // Reset sub counts and disable WS retry on all pool connections
      for (const conn of this.connectionPool) {
        this.connectionSubCounts.set(conn, 0);
        disableWsReconnect(conn);
      }
    } finally {
      this.isClearing = false;
    }
  }

  async stop(): Promise<void> {
    this.isStopped = true;

    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.silenceInterval) {
      clearInterval(this.silenceInterval);
      this.silenceInterval = null;
    }

    await this.clearSubscriptions();
    logger.info('SmartWalletStream stopped');
  }
}
