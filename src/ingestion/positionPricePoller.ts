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
const JUPITER_TIMEOUT_MS = 4_000;
// DexScreener supports up to 30 token addresses per batch request
const MAX_BATCH_SIZE = 30;
const JUPITER_PRICE_URL = 'https://lite-api.jup.ag/price/v3';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const CACHE_KEEPALIVE_MS = 180_000;
const METRICS_WINDOW_MS = 60_000;

interface PriceCacheEntry {
  priceSOL: number;
  updatedAt: number;
}

export class PositionPricePoller {
  private positionManager: PositionManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isStopped = false;
  private consecutiveFailures = 0;
  private lastSuccessAt = 0;
  private lastKnownPrices = new Map<string, PriceCacheEntry>();
  private metricsWindowStartedAt = Date.now();
  private metrics = {
    dexHits: 0,
    jupiterHits: 0,
    cacheKeepaliveHits: 0,
  };

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
      const { prices, sources } = await this.fetchPrices(tokenCAs);
      let updatedCount = 0;
      let keepaliveCount = 0;
      const now = Date.now();

      for (const pos of positions) {
        const priceData = prices.get(pos.tokenCA);
        if (priceData && priceData > 0) {
          const source = sources.get(pos.tokenCA) ?? 'dex';
          this.positionManager.updatePrice(pos.tokenCA, priceData);
          this.lastKnownPrices.set(pos.tokenCA, {
            priceSOL: priceData,
            updatedAt: now,
          });
          updatedCount++;
          if (source === 'jupiter') {
            this.metrics.jupiterHits++;
          } else {
            this.metrics.dexHits++;
          }
          continue;
        }

        const cached = this.lastKnownPrices.get(pos.tokenCA);
        if (cached && now - cached.updatedAt <= CACHE_KEEPALIVE_MS) {
          // Keep position watchdog alive during brief provider outages.
          this.positionManager.updatePrice(pos.tokenCA, cached.priceSOL);
          keepaliveCount++;
          this.metrics.cacheKeepaliveHits++;
        }
      }

      if (updatedCount > 0 || keepaliveCount > 0) {
        logger.debug('[PricePoller] Updated prices', {
          positions: positions.length,
          updated: updatedCount,
          keepalive: keepaliveCount,
        });
      }

      this.consecutiveFailures = 0;
      this.lastSuccessAt = Date.now();
      this.flushMetricsIfDue();
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

      this.flushMetricsIfDue();
    }
  }

  /**
   * Fetch current prices via DexScreener API.
   * Returns Map of tokenCA → priceSOL (priceNative).
   * Source order:
   *   1) DexScreener priceNative (SOL-denominated)
   *   2) Jupiter v3 USD prices converted to SOL
   * Endpoint: GET /tokens/v1/solana/:tokenAddresses (comma-separated, max 30)
   */
  private async fetchPrices(tokenCAs: string[]): Promise<{
    prices: Map<string, number>;
    sources: Map<string, 'dex' | 'jupiter'>;
  }> {
    const result = new Map<string, number>();
    const sources = new Map<string, 'dex' | 'jupiter'>();
    await this.fetchDexScreenerPrices(tokenCAs, result, sources);

    const missing = tokenCAs.filter((tokenCA) => !result.has(tokenCA));
    if (missing.length > 0) {
      await this.fetchJupiterPrices(missing, result, sources);
    }

    return { prices: result, sources };
  }

  private async fetchDexScreenerPrices(
    tokenCAs: string[],
    result: Map<string, number>,
    sources: Map<string, 'dex' | 'jupiter'>,
  ): Promise<void> {
    for (let i = 0; i < tokenCAs.length; i += MAX_BATCH_SIZE) {
      const batch = tokenCAs.slice(i, i + MAX_BATCH_SIZE);
      const addresses = batch.join(',');

      try {
        const resp = await axios.get(
          `https://api.dexscreener.com/tokens/v1/solana/${addresses}`,
          { timeout: DEXSCREENER_TIMEOUT_MS }
        );

        const pairs = resp.data;
        if (!Array.isArray(pairs)) continue;

        // Keep the most liquid SOL-quoted pair per token.
        const bestByToken = new Map<string, { priceSOL: number; liquidityUSD: number }>();

        for (const pair of pairs) {
          const tokenAddr = pair?.baseToken?.address;
          if (!tokenAddr || !batch.includes(tokenAddr)) continue;

          const quoteSymbol = String(pair?.quoteToken?.symbol ?? '').toUpperCase();
          if (quoteSymbol !== 'SOL' && quoteSymbol !== 'WSOL') continue;

          const priceNative = Number.parseFloat(String(pair?.priceNative ?? ''));
          if (!Number.isFinite(priceNative) || priceNative <= 0) continue;

          const liquidityUSD = Number(pair?.liquidity?.usd ?? 0);
          const existing = bestByToken.get(tokenAddr);
          if (!existing || liquidityUSD > existing.liquidityUSD) {
            bestByToken.set(tokenAddr, { priceSOL: priceNative, liquidityUSD });
          }
        }

        for (const [tokenAddr, picked] of bestByToken.entries()) {
          result.set(tokenAddr, picked.priceSOL);
          sources.set(tokenAddr, 'dex');
        }
      } catch {
        // Continue other batches/sources if one batch fails.
      }
    }
  }

  private async fetchJupiterPrices(
    tokenCAs: string[],
    result: Map<string, number>,
    sources: Map<string, 'dex' | 'jupiter'>,
  ): Promise<void> {
    for (let i = 0; i < tokenCAs.length; i += MAX_BATCH_SIZE) {
      const batch = tokenCAs.slice(i, i + MAX_BATCH_SIZE);
      const ids = [SOL_MINT, ...batch].join(',');

      try {
        const resp = await axios.get(JUPITER_PRICE_URL, {
          params: { ids },
          timeout: JUPITER_TIMEOUT_MS,
        });

        const data = resp.data as Record<string, { usdPrice?: number }>;
        const solUsd = Number(data?.[SOL_MINT]?.usdPrice ?? 0);
        if (!Number.isFinite(solUsd) || solUsd <= 0) continue;

        for (const tokenCA of batch) {
          const tokenUsd = Number(data?.[tokenCA]?.usdPrice ?? 0);
          if (!Number.isFinite(tokenUsd) || tokenUsd <= 0) continue;
          result.set(tokenCA, tokenUsd / solUsd);
          sources.set(tokenCA, 'jupiter');
        }
      } catch {
        // Continue to next batch; caller handles empty map.
      }
    }
  }

  private flushMetricsIfDue(): void {
    const now = Date.now();
    const windowMs = now - this.metricsWindowStartedAt;
    if (windowMs < METRICS_WINDOW_MS) return;

    const dexHits = this.metrics.dexHits;
    const jupiterHits = this.metrics.jupiterHits;
    const cacheKeepaliveHits = this.metrics.cacheKeepaliveHits;
    const totalHits = dexHits + jupiterHits + cacheKeepaliveHits;

    logger.info('Position price source snapshot', {
      windowSeconds: Math.round(windowMs / 1000),
      dexHits,
      jupiterHits,
      cacheKeepaliveHits,
      totalHits,
      dexHitRatePct: totalHits > 0 ? Number(((dexHits / totalHits) * 100).toFixed(1)) : 0,
      jupiterHitRatePct: totalHits > 0 ? Number(((jupiterHits / totalHits) * 100).toFixed(1)) : 0,
      cacheKeepaliveRatePct: totalHits > 0 ? Number(((cacheKeepaliveHits / totalHits) * 100).toFixed(1)) : 0,
    });

    this.metrics = { dexHits: 0, jupiterHits: 0, cacheKeepaliveHits: 0 };
    this.metricsWindowStartedAt = now;
  }
}
