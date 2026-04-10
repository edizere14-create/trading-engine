/**
 * ═══════════════════════════════════════════════════════════════
 *  POSITION PRICE POLLER — Periodic Price Fetching for Open Positions
 * ═══════════════════════════════════════════════════════════════
 *
 * The PoolPriceStream only works for tokens with AMM pools (Raydium,
 * Orca, etc.). Most trades are on pump.fun bonding curve tokens which
 * DON'T have AMM pools — so they receive ZERO price updates and hit
 * STALE_EXIT after 60s.
 *
 * This poller fetches current prices for ALL open positions every N
 * seconds via Jupiter Price API, ensuring no position starves for
 * price data regardless of AMM pool availability.
 */

import axios from 'axios';
import { logger } from '../core/logger';
import { PositionManager } from '../position/positionManager';

const POLL_INTERVAL_MS = 5_000;       // poll every 5 seconds
const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v2';
const JUPITER_TIMEOUT_MS = 4_000;     // 4s timeout (must finish within poll interval)
const MAX_BATCH_SIZE = 100;           // Jupiter supports up to 100 IDs per request
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export class PositionPricePoller {
  private positionManager: PositionManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isStopped = false;
  private consecutiveFailures = 0;
  private lastSuccessAt = 0;

  constructor(positionManager: PositionManager) {
    this.positionManager = positionManager;
  }

  start(): void {
    if (this.timer) return;
    this.isStopped = false;

    logger.info('[PricePoller] Started', { intervalMs: POLL_INTERVAL_MS });

    // Initial poll immediately
    this.poll().catch(() => {});

    this.timer = setInterval(() => {
      if (this.isStopped) return;
      this.poll().catch(() => {});
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    this.isStopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('[PricePoller] Stopped');
  }

  private async poll(): Promise<void> {
    const positions = this.positionManager.getOpenPositions();
    if (positions.length === 0) return;

    const tokenCAs = positions.map(p => p.tokenCA);

    try {
      const prices = await this.fetchPrices(tokenCAs);
      let updatedCount = 0;

      for (const pos of positions) {
        const priceData = prices.get(pos.tokenCA);
        if (priceData && priceData > 0) {
          this.positionManager.updatePrice(pos.tokenCA, priceData);
          updatedCount++;
        }
      }

      if (updatedCount > 0) {
        logger.debug('[PricePoller] Updated prices', {
          positions: positions.length,
          updated: updatedCount,
        });
      }

      this.consecutiveFailures = 0;
      this.lastSuccessAt = Date.now();
    } catch (err) {
      this.consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);

      // Only log every 5th failure to avoid spam
      if (this.consecutiveFailures <= 3 || this.consecutiveFailures % 5 === 0) {
        logger.warn('[PricePoller] Fetch failed', {
          error: msg,
          consecutiveFailures: this.consecutiveFailures,
          positionCount: positions.length,
        });
      }
    }
  }

  /**
   * Fetch current prices via Jupiter Price API.
   * Returns Map of tokenCA → priceSOL.
   */
  private async fetchPrices(tokenCAs: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();

    // Batch into chunks of MAX_BATCH_SIZE
    for (let i = 0; i < tokenCAs.length; i += MAX_BATCH_SIZE) {
      const batch = tokenCAs.slice(i, i + MAX_BATCH_SIZE);
      const ids = batch.join(',');

      const resp = await axios.get(JUPITER_PRICE_URL, {
        params: { ids, vsToken: SOL_MINT },
        timeout: JUPITER_TIMEOUT_MS,
      });

      const data = resp.data?.data;
      if (!data) continue;

      for (const tokenCA of batch) {
        const entry = data[tokenCA];
        if (entry?.price) {
          // Jupiter returns price as string, vsToken=SOL gives price in SOL
          const priceSOL = parseFloat(entry.price);
          if (isFinite(priceSOL) && priceSOL > 0) {
            result.set(tokenCA, priceSOL);
          }
        }
      }
    }

    return result;
  }
}
