/**
 * ═══════════════════════════════════════════════════════════════
 *  STATISTICAL ARBITRAGE ENGINE — Cross-DEX Spread Capture
 * ═══════════════════════════════════════════════════════════════
 *
 * Market-neutral strategy: monitors the same token across multiple
 * AMMs (Raydium vs Meteora, Orca Whirlpool vs Raydium, etc).
 * When the spread exceeds execution cost, simultaneously buys cheap
 * and sells expensive.
 *
 * No directional risk — profit comes from market inefficiency.
 */

import { Connection } from '@solana/web3.js';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';
import { NewPoolEvent, SwapEvent } from '../core/types';
import axios from 'axios';

// ── TYPES ─────────────────────────────────────────────────

export interface DEXQuote {
  dex: string;
  inputMint: string;
  outputMint: string;
  inAmount: number;       // lamports
  outAmount: number;      // lamports
  priceImpactPct: number;
  routePlan: string[];
  fetchedAt: number;
}

export interface SpreadOpportunity {
  tokenCA: string;
  buyDex: string;
  sellDex: string;
  buyPrice: number;       // SOL per token
  sellPrice: number;      // SOL per token
  spreadPct: number;
  grossProfitSOL: number;
  netProfitSOL: number;   // after gas + slippage + fees
  confidence: number;     // 0-1 based on quote freshness
  detectedAt: number;
}

interface PoolPriceFeed {
  tokenCA: string;
  dex: string;
  priceSOL: number;
  liquiditySOL: number;
  updatedAt: number;
}

// ── CONFIG ─────────────────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';

const RAYDIUM_LABEL = 'Raydium';
const METEORA_LABEL = 'Meteora';
const ORCA_LABEL = 'Orca';

// Minimum spread to cover gas + slippage + solver fees
const MIN_SPREAD_PCT = 0.5;          // 0.5% minimum spread
const MIN_NET_PROFIT_SOL = 0.001;    // minimum 0.001 SOL profit
const QUOTE_STALENESS_MS = 5_000;    // quotes older than 5s are stale
const SCAN_INTERVAL_MS = 3_000;      // check spreads every 3 seconds
const MAX_TRADE_SIZE_SOL = 1.0;      // max arb trade size
const MIN_TRADE_SIZE_SOL = 0.05;     // min arb trade size
const GAS_COST_SOL = 0.005;          // estimated gas per leg (2 legs = 0.01)
const JITO_TIP_SOL = 0.001;          // Jito bundle tip

// ── ENGINE ─────────────────────────────────────────────────

export class StatArbEngine {
  private connection: Connection;
  private priceFeeds: Map<string, PoolPriceFeed[]> = new Map();
  private watchedTokens: Set<string> = new Set();
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private opportunities: SpreadOpportunity[] = [];
  private totalScans = 0;
  private totalOpportunities = 0;
  private totalExecuted = 0;
  private enabled = true;
  private readonly onPoolCreated = (event: NewPoolEvent) => {
    this.watchedTokens.add(event.tokenCA);
  };
  private readonly onSwapDetected = (event: SwapEvent) => {
    this.updatePriceFeed(event.tokenCA, this.inferDex(event), event.priceSOL, event.amountSOL);
  };

  constructor(connection: Connection) {
    this.connection = connection;
  }

  start(): void {
    if (this.scanInterval) {
      return;
    }

    this.enabled = true;
    // Listen for new pools — automatically add tokens to watch list
    bus.on('pool:created', this.onPoolCreated);

    // Listen for swap events to build price feeds from live data
    bus.on('swap:detected', this.onSwapDetected);

    // Periodic spread scanning
    this.scanInterval = setInterval(() => this.scanSpreads(), SCAN_INTERVAL_MS);

    logger.info('StatArbEngine started', {
      minSpreadPct: MIN_SPREAD_PCT,
      scanIntervalMs: SCAN_INTERVAL_MS,
      maxTradeSizeSOL: MAX_TRADE_SIZE_SOL,
    });
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    bus.off('pool:created', this.onPoolCreated);
    bus.off('swap:detected', this.onSwapDetected);
    this.enabled = false;
  }

  addToken(tokenCA: string): void {
    this.watchedTokens.add(tokenCA);
  }

  getStats() {
    return {
      watchedTokens: this.watchedTokens.size,
      totalScans: this.totalScans,
      totalOpportunities: this.totalOpportunities,
      totalExecuted: this.totalExecuted,
      recentOpportunities: this.opportunities.slice(-10),
    };
  }

  // ── CORE LOOP ──────────────────────────────────────────

  private async scanSpreads(): Promise<void> {
    if (!this.enabled || this.watchedTokens.size === 0) return;
    this.totalScans++;

    for (const tokenCA of this.watchedTokens) {
      try {
        await this.checkSpread(tokenCA);
      } catch (err) {
        // Don't let one token crash the loop
        logger.debug('StatArb spread check failed', {
          tokenCA,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Prune tokens we haven't seen price data for in 10 minutes
    const now = Date.now();
    for (const tokenCA of this.watchedTokens) {
      const feeds = this.priceFeeds.get(tokenCA);
      if (!feeds || feeds.every(f => now - f.updatedAt > 600_000)) {
        this.watchedTokens.delete(tokenCA);
        this.priceFeeds.delete(tokenCA);
      }
    }
  }

  private async checkSpread(tokenCA: string): Promise<void> {
    // Get quotes from Jupiter for different DEX routes
    const tradeAmountLamports = Math.floor(MIN_TRADE_SIZE_SOL * 1e9);

    const [buyQuotes, sellQuotes] = await Promise.all([
      this.getMultiDexQuotes(SOL_MINT, tokenCA, tradeAmountLamports),
      this.getMultiDexQuotes(tokenCA, SOL_MINT, tradeAmountLamports),
    ]);

    if (buyQuotes.length < 2) return; // Need at least 2 DEXes

    // Also use our live price feed data
    const liveFeeds = this.priceFeeds.get(tokenCA) ?? [];
    const now = Date.now();
    const freshFeeds = liveFeeds.filter(f => now - f.updatedAt < QUOTE_STALENESS_MS);

    // Find best buy (lowest price) and best sell (highest price)
    let bestBuy: { dex: string; priceSOL: number; source: string } | null = null;
    let bestSell: { dex: string; priceSOL: number; source: string } | null = null;

    // From Jupiter quotes
    for (const q of buyQuotes) {
      const effectivePrice = q.inAmount / q.outAmount; // SOL per token
      if (!bestBuy || effectivePrice < bestBuy.priceSOL) {
        bestBuy = { dex: q.dex, priceSOL: effectivePrice, source: 'jupiter' };
      }
    }

    for (const q of sellQuotes) {
      const effectivePrice = q.outAmount / q.inAmount; // SOL per token
      if (!bestSell || effectivePrice > bestSell.priceSOL) {
        bestSell = { dex: q.dex, priceSOL: effectivePrice, source: 'jupiter' };
      }
    }

    // From live swap feeds
    for (const feed of freshFeeds) {
      if (!bestBuy || feed.priceSOL < bestBuy.priceSOL) {
        bestBuy = { dex: feed.dex, priceSOL: feed.priceSOL, source: 'live' };
      }
      if (!bestSell || feed.priceSOL > bestSell.priceSOL) {
        bestSell = { dex: feed.dex, priceSOL: feed.priceSOL, source: 'live' };
      }
    }

    if (!bestBuy || !bestSell || bestBuy.dex === bestSell.dex) return;

    const spreadPct = ((bestSell.priceSOL - bestBuy.priceSOL) / bestBuy.priceSOL) * 100;

    if (spreadPct < MIN_SPREAD_PCT) return;

    // Calculate profitability
    const tradeSize = Math.min(MAX_TRADE_SIZE_SOL, Math.max(MIN_TRADE_SIZE_SOL, spreadPct * 0.1));
    const grossProfitSOL = tradeSize * (spreadPct / 100);
    const executionCost = GAS_COST_SOL * 2 + JITO_TIP_SOL; // buy + sell gas + Jito
    const netProfitSOL = grossProfitSOL - executionCost;

    if (netProfitSOL < MIN_NET_PROFIT_SOL) return;

    // Confidence based on quote freshness
    const quoteAge = Math.max(
      ...buyQuotes.map(q => now - q.fetchedAt),
      ...freshFeeds.map(f => now - f.updatedAt)
    );
    const confidence = Math.max(0, 1 - quoteAge / QUOTE_STALENESS_MS);

    const opportunity: SpreadOpportunity = {
      tokenCA,
      buyDex: bestBuy.dex,
      sellDex: bestSell.dex,
      buyPrice: bestBuy.priceSOL,
      sellPrice: bestSell.priceSOL,
      spreadPct,
      grossProfitSOL,
      netProfitSOL,
      confidence,
      detectedAt: now,
    };

    this.opportunities.push(opportunity);
    if (this.opportunities.length > 100) {
      this.opportunities = this.opportunities.slice(-50);
    }
    this.totalOpportunities++;

    logger.info('StatArb opportunity detected', {
      tokenCA,
      buyDex: bestBuy.dex,
      sellDex: bestSell.dex,
      spreadPct: spreadPct.toFixed(3),
      netProfitSOL: netProfitSOL.toFixed(6),
      confidence: confidence.toFixed(2),
    });

    // Emit for execution (the trade:signal handler in index.ts will pick this up)
    bus.emit('trade:signal', {
      tokenCA,
      source: 'AUTONOMOUS' as const,
      triggerWallet: 'STAT_ARB_ENGINE',
      walletTier: 'S' as const,
      walletPnL30d: 0,
      convictionSOL: tradeSize,
      clusterWallets: [],
      clusterSize: 0,
      totalClusterSOL: tradeSize,
      entryPriceSOL: bestBuy.priceSOL,
      timestamp: new Date(),
      slot: 0,
      score: Math.min(10, 5 + spreadPct * 2), // higher spread = higher score
      confidence,
      overrideSizeUSD: undefined,
      overrideMaxHoldMs: 30_000, // arb should close in 30 seconds max
    });
  }

  // ── JUPITER MULTI-DEX QUOTES ───────────────────────────

  private async getMultiDexQuotes(
    inputMint: string,
    outputMint: string,
    amount: number
  ): Promise<DEXQuote[]> {
    try {
      const resp = await axios.get(JUPITER_QUOTE_URL, {
        params: {
          inputMint,
          outputMint,
          amount: amount.toString(),
          slippageBps: 50,
          onlyDirectRoutes: true, // direct routes to isolate per-DEX pricing
        },
        timeout: 3000,
      });

      if (!resp.data?.data || !Array.isArray(resp.data.data)) {
        // Try alternate response format
        const routes = resp.data?.routePlan ?? resp.data?.data ?? [];
        if (!Array.isArray(routes)) return [];
      }

      const quotes: DEXQuote[] = [];
      const routesData = resp.data.data ?? [resp.data];

      for (const route of (Array.isArray(routesData) ? routesData : [routesData])) {
        if (!route) continue;
        const dex = route.routePlan?.[0]?.swapInfo?.label
          ?? route.routePlan?.[0]?.ammKey
          ?? 'unknown';
        quotes.push({
          dex,
          inputMint,
          outputMint,
          inAmount: Number(route.inAmount ?? amount),
          outAmount: Number(route.outAmount ?? 0),
          priceImpactPct: Number(route.priceImpactPct ?? 0),
          routePlan: (route.routePlan ?? []).map((r: any) => r?.swapInfo?.label ?? r?.ammKey ?? ''),
          fetchedAt: Date.now(),
        });
      }

      return quotes;
    } catch {
      return [];
    }
  }

  // ── LIVE PRICE FEED ────────────────────────────────────

  private updatePriceFeed(tokenCA: string, dex: string, priceSOL: number, liquiditySOL: number): void {
    if (!this.watchedTokens.has(tokenCA)) return;

    const feeds = this.priceFeeds.get(tokenCA) ?? [];
    const existing = feeds.find(f => f.dex === dex);

    if (existing) {
      existing.priceSOL = priceSOL;
      existing.liquiditySOL = liquiditySOL;
      existing.updatedAt = Date.now();
    } else {
      feeds.push({ tokenCA, dex, priceSOL, liquiditySOL, updatedAt: Date.now() });
      this.priceFeeds.set(tokenCA, feeds);
    }
  }

  private inferDex(event: { tokenCA: string; wallet: string; amountSOL: number }): string {
    // In production this would come from parsed tx data.
    // For now, use wallet address heuristic or default
    return 'Unknown';
  }
}
