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
 * seconds via DexScreener API, ensuring no position starves for
 * price data regardless of AMM pool availability.
 */

import axios from 'axios';
import { logger } from '../core/logger';
import { PositionManager } from '../position/positionManager';

const POLL_INTERVAL_MS = 5_000;       // poll every 5 seconds
const DEXSCREENER_TIMEOUT_MS = 4_000;
// DexScreener supports up to 30 token addresses per batch request
const MAX_BATCH_SIZE = 30;

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
   * Fetch current prices via DexScreener API.
   * Returns Map of tokenCA → priceSOL (priceNative).
   * Endpoint: GET /tokens/v1/solana/:tokenAddresses (comma-separated, max 30)
   */
  private async fetchPrices(tokenCAs: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();

    for (let i = 0; i < tokenCAs.length; i += MAX_BATCH_SIZE) {
      const batch = tokenCAs.slice(i, i + MAX_BATCH_SIZE);
      const addresses = batch.join(',');

      const resp = await axios.get(
        `https://api.dexscreener.com/tokens/v1/solana/${addresses}`,
        { timeout: DEXSCREENER_TIMEOUT_MS }
      );

      const pairs = resp.data;
      if (!Array.isArray(pairs)) continue;

      // DexScreener returns array of pair objects; pick the best (highest liquidity) per token
      for (const pair of pairs) {
        const tokenAddr = pair.baseToken?.address;
        if (!tokenAddr || !batch.includes(tokenAddr)) continue;

        const priceNative = parseFloat(pair.priceNative);
        if (!isFinite(priceNative) || priceNative <= 0) continue;

        // Keep the pair with highest liquidity for this token
        const existing = result.get(tokenAddr);
        if (!existing || priceNative > existing) {
          result.set(tokenAddr, priceNative);
        }
      }
    }

    return result;
  }
}
