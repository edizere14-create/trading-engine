/**
 * ═══════════════════════════════════════════════════════════════
 *  POOL PRICE STREAM — Reserve-Based Price Tracking
 * ═══════════════════════════════════════════════════════════════
 *
 * Subscribes to on-chain swap logs for pool addresses tied to open
 * positions. On every swap event, fetches updated pool reserves and
 * computes the exact spot price via the constant product formula
 * (x * y = k). This eliminates external API dependencies for price
 * tracking — price is derived directly from the Solana pool state.
 */

import { Connection, PublicKey, Logs } from '@solana/web3.js';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';
import { OnChainSimulator } from '../simulation/onChainSimulator';
import { isWsOpen, removeLogsListenerBounded } from './wsControl';
import { RpcFailover } from './rpcFailover';

// Known DEX program IDs — used to filter swap logs from noise
const SWAP_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM V4
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   // Orca Whirlpool
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',   // Meteora DLMM
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',   // Jupiter v6
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',   // PumpFun Bonding Curve
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',   // PumpSwap AMM
]);

const RESERVE_FETCH_COOLDOWN_MS = 500; // don't re-fetch reserves more than 2x/sec per pool

interface PoolSubscription {
  poolAddress: string;
  tokenCA: string;
  subId: number;
  lastFetchAt: number;
  connection: Connection; // the connection currently carrying this subscription
}

export class PoolPriceStream {
  private connection: Connection;
  private simulator: OnChainSimulator;
  private subscriptions: Map<string, PoolSubscription> = new Map(); // tokenCA → sub
  private poolToToken: Map<string, string> = new Map(); // poolAddress → tokenCA
  private isStopped = false;
  private failover: RpcFailover;

  /**
   * Pass this stream its OWN connection pair (see cloneConnection) so a swap
   * can't disturb other streams. Without a backup no failover is attempted.
   */
  constructor(connection: Connection, simulator: OnChainSimulator, backupConnection?: Connection) {
    this.connection = connection;
    this.simulator = simulator;
    this.failover = new RpcFailover({
      name: 'PoolPriceStream',
      primary: connection,
      backup: backupConnection ?? null,
      hasSubscriptions: () => this.subscriptions.size > 0,
      socketsOpen: () => isWsOpen(this.failover.activeConnection),
      moveTo: (target) => this.moveAll(target),
    });
  }

  /**
   * Subscribe to a pool's swap events for real-time reserve-based pricing.
   * Call this when a position is opened.
   */
  subscribe(poolAddress: string, tokenCA: string): void {
    if (this.subscriptions.has(tokenCA)) {
      logger.debug('[PoolPriceStream] Already subscribed', { tokenCA, poolAddress });
      return;
    }

    try {
      const conn = this.failover.activeConnection;
      const subId = this.attach(poolAddress, tokenCA, conn);

      const sub: PoolSubscription = { poolAddress, tokenCA, subId, lastFetchAt: 0, connection: conn };
      this.subscriptions.set(tokenCA, sub);
      this.poolToToken.set(poolAddress, tokenCA);
      this.failover.start();

      logger.info('[PoolPriceStream] Subscribed to pool', { tokenCA, poolAddress });

      // Fetch initial price immediately
      this.onSwapDetected(poolAddress, tokenCA).catch(() => {});
    } catch (err) {
      logger.error('[PoolPriceStream] Failed to subscribe', {
        tokenCA,
        poolAddress,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Create the swap-log subscription for a pool on `conn`. */
  private attach(poolAddress: string, tokenCA: string, conn: Connection): number {
    const pubkey = new PublicKey(poolAddress);
    return conn.onLogs(
      pubkey,
      (logs: Logs) => {
        if (this.isStopped) return;
        if (logs.err) return;

        // Only process swap-related logs
        const isSwap = logs.logs.some(l => {
          for (const prog of SWAP_PROGRAMS) {
            if (l.includes(prog)) return true;
          }
          return false;
        });
        if (!isSwap) return;

        this.onSwapDetected(poolAddress, tokenCA).catch(err => {
          logger.warn('[PoolPriceStream] Reserve fetch error', {
            tokenCA,
            poolAddress,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      },
      'confirmed'
    );
  }

  /**
   * Failover: replay every open pool subscription onto `target`, then refresh
   * each price so the gap doesn't leave a stale one.
   */
  private async moveAll(target: Connection): Promise<void> {
    const subs = [...this.subscriptions.values()];
    await Promise.all(subs.map((sub) => removeLogsListenerBounded(sub.connection, sub.subId)));

    for (const sub of subs) {
      // Position may have closed while we were detaching
      if (this.subscriptions.get(sub.tokenCA) !== sub) continue;
      try {
        sub.subId = this.attach(sub.poolAddress, sub.tokenCA, target);
        sub.connection = target;
      } catch (err) {
        logger.error('[PoolPriceStream] Resubscribe failed after RPC switch', {
          tokenCA: sub.tokenCA,
          poolAddress: sub.poolAddress,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      this.onSwapDetected(sub.poolAddress, sub.tokenCA).catch(() => {});
    }
    logger.info('[PoolPriceStream] Subscriptions moved to new RPC', { count: subs.length });
  }

  /**
   * Unsubscribe from a pool. Call when a position is closed.
   */
  unsubscribe(tokenCA: string): void {
    const sub = this.subscriptions.get(tokenCA);
    if (!sub) return;

    // Always detach (bounded): a closed socket must not keep a stale listener
    void removeLogsListenerBounded(sub.connection, sub.subId);

    this.subscriptions.delete(tokenCA);
    this.poolToToken.delete(sub.poolAddress);
    logger.info('[PoolPriceStream] Unsubscribed from pool', {
      tokenCA,
      poolAddress: sub.poolAddress,
    });
  }

  /**
   * Handle a swap on the pool — fetch reserves and compute price.
   */
  private async onSwapDetected(poolAddress: string, tokenCA: string): Promise<void> {
    const sub = this.subscriptions.get(tokenCA);
    if (!sub) return;

    // Cooldown: don't hammer RPC on rapid successive swaps
    const now = Date.now();
    if (now - sub.lastFetchAt < RESERVE_FETCH_COOLDOWN_MS) return;
    sub.lastFetchAt = now;

    const reserves = await this.simulator.getReserves(poolAddress);
    const priceSOL = this.simulator.getSpotPrice(reserves);

    if (priceSOL <= 0) {
      logger.warn('[PoolPriceStream] Zero price from reserves', {
        tokenCA,
        poolAddress,
        reserveA: reserves.reserveA.toString(),
        reserveB: reserves.reserveB.toString(),
      });
      return;
    }

    const reserveSOL = Number(reserves.reserveB) / 10 ** reserves.decimalsB;

    bus.emit('pool:price', {
      tokenCA,
      poolAddress,
      priceSOL,
      reserveSOL,
      ammType: reserves.ammType,
      timestamp: new Date(),
    });
  }

  /** Returns whether a token is being tracked. */
  isTracking(tokenCA: string): boolean {
    return this.subscriptions.has(tokenCA);
  }

  /** Number of actively tracked pools. */
  get activeCount(): number {
    return this.subscriptions.size;
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    this.failover.stop();

    for (const [tokenCA] of this.subscriptions) {
      this.unsubscribe(tokenCA);
    }

    logger.info('[PoolPriceStream] Stopped');
  }
}
