/**
 * ═══════════════════════════════════════════════════════════════
 *  TOXIC FLOW BACKRUNNER — Post-Sandwich Dip Capture
 * ═══════════════════════════════════════════════════════════════
 *
 * Detects sandwich attacks in real-time by observing the pattern:
 *   1. Attacker buys (frontrun) → price spikes
 *   2. Victim buys at inflated price
 *   3. Attacker sells (backrun) → price crashes below natural level
 *
 * The crash after step 3 creates an unnatural dip. This engine
 * "backruns the backrunner" — buying the dip and selling seconds
 * later when the pool rebalances to its natural price.
 *
 * NOT performing the sandwich itself (that would be predatory MEV).
 * We profit from the aftermath — the artificial inefficiency.
 */

import { Connection } from '@solana/web3.js';
import { bus } from '../core/eventBus';
import { SwapEvent } from '../core/types';
import { logger } from '../core/logger';

// ── TYPES ─────────────────────────────────────────────────

interface SwapRecord {
  wallet: string;
  action: 'BUY' | 'SELL';
  amountSOL: number;
  priceSOL: number;
  timestamp: number;
  slot: number;
}

export interface SandwichEvent {
  tokenCA: string;
  attackerWallet: string;
  victimWallet: string;
  frontrunBuy: SwapRecord;
  victimBuy: SwapRecord;
  backrunSell: SwapRecord;
  priceBeforeAttack: number;
  priceAfterAttack: number;    // the dip price — our entry target
  naturalPrice: number;        // estimated fair price (pre-attack)
  dipPct: number;              // how far below natural price
  detectedAt: number;
}

export interface BackrunOpportunity {
  tokenCA: string;
  sandwich: SandwichEvent;
  entryPrice: number;          // price to buy at (post-crash)
  targetPrice: number;         // price to sell at (rebalance target)
  expectedProfitPct: number;
  confidence: number;
  maxHoldMs: number;
}

// ── CONFIG ─────────────────────────────────────────────────

const SWAP_WINDOW_MS = 15_000;       // 15s window to detect sandwich pattern
const MIN_ATTACK_SIZE_SOL = 0.5;     // attacker must move >= 0.5 SOL
const MIN_DIP_PCT = 3.0;             // dip must be >= 3% below pre-attack price
const MAX_DIP_PCT = 30.0;            // dips > 30% are probably not rebalancing — rug risk
const MIN_LIQUIDITY_SOL = 5.0;       // pool must have >= 5 SOL liquidity
const REBALANCE_TARGET_PCT = 0.7;    // expect 70% recovery of the dip
const MAX_HOLD_MS = 30_000;          // exit within 30 seconds
const CLEANUP_INTERVAL_MS = 30_000;
const MAX_SWAPS_PER_TOKEN = 100;     // cap stored swaps per token

// Known MEV bot patterns: rapid buy→sell within same block or adjacent blocks
const MAX_SLOT_GAP_SANDWICH = 3;     // frontrun and backrun within 3 slots

// ── ENGINE ─────────────────────────────────────────────────

export class ToxicFlowBackrunner {
  private connection: Connection;
  private swapHistory: Map<string, SwapRecord[]> = new Map();
  private priceHistory: Map<string, { price: number; timestamp: number }[]> = new Map();
  private detectedSandwiches: SandwichEvent[] = [];
  private opportunities: BackrunOpportunity[] = [];
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private totalSwapsAnalyzed = 0;
  private totalSandwichesDetected = 0;
  private totalOpportunities = 0;
  private enabled = true;
  private readonly onSwapDetected = (event: SwapEvent) => this.onSwap(event);

  constructor(connection: Connection) {
    this.connection = connection;
  }

  start(): void {
    if (this.cleanupInterval) {
      return;
    }

    this.enabled = true;
    // Listen to ALL swaps (not just smart wallets) — sandwich attacks come from any wallet
    bus.on('swap:detected', this.onSwapDetected);

    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);

    logger.info('ToxicFlowBackrunner started', {
      swapWindowMs: SWAP_WINDOW_MS,
      minDipPct: MIN_DIP_PCT,
      maxHoldMs: MAX_HOLD_MS,
    });
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    bus.off('swap:detected', this.onSwapDetected);
    this.enabled = false;
  }

  getStats() {
    return {
      totalSwapsAnalyzed: this.totalSwapsAnalyzed,
      totalSandwichesDetected: this.totalSandwichesDetected,
      totalOpportunities: this.totalOpportunities,
      activeTokens: this.swapHistory.size,
      recentSandwiches: this.detectedSandwiches.slice(-10),
      recentOpportunities: this.opportunities.slice(-10),
    };
  }

  // ── SWAP HANDLER ───────────────────────────────────────

  private onSwap(event: SwapEvent): void {
    if (!this.enabled) return;
    this.totalSwapsAnalyzed++;

    const record: SwapRecord = {
      wallet: event.wallet,
      action: event.action,
      amountSOL: event.amountSOL,
      priceSOL: event.priceSOL,
      timestamp: Date.now(),
      slot: event.slot,
    };

    // Store swap
    const history = this.swapHistory.get(event.tokenCA) ?? [];
    history.push(record);
    if (history.length > MAX_SWAPS_PER_TOKEN) {
      this.swapHistory.set(event.tokenCA, history.slice(-MAX_SWAPS_PER_TOKEN));
    } else {
      this.swapHistory.set(event.tokenCA, history);
    }

    // Store price
    const prices = this.priceHistory.get(event.tokenCA) ?? [];
    prices.push({ price: event.priceSOL, timestamp: Date.now() });
    if (prices.length > 200) {
      this.priceHistory.set(event.tokenCA, prices.slice(-100));
    } else {
      this.priceHistory.set(event.tokenCA, prices);
    }

    // Only check for sandwich pattern after a SELL (the backrun)
    if (event.action === 'SELL') {
      this.detectSandwich(event.tokenCA, record);
    }
  }

  // ── SANDWICH DETECTION ─────────────────────────────────

  private detectSandwich(tokenCA: string, latestSell: SwapRecord): void {
    const history = this.swapHistory.get(tokenCA);
    if (!history || history.length < 3) return;

    const now = Date.now();
    const recentSwaps = history.filter(s => now - s.timestamp < SWAP_WINDOW_MS);
    if (recentSwaps.length < 3) return;

    // Look for the pattern: BUY(attacker) → BUY(victim) → SELL(attacker)
    // The attacker's sell wallet matches their buy wallet
    const sellerWallet = latestSell.wallet;

    // Find earlier BUY from the same wallet (the frontrun)
    const attackerBuy = recentSwaps.find(
      s => s.wallet === sellerWallet
        && s.action === 'BUY'
        && s.amountSOL >= MIN_ATTACK_SIZE_SOL
        && s.timestamp < latestSell.timestamp
        && Math.abs(s.slot - latestSell.slot) <= MAX_SLOT_GAP_SANDWICH
    );

    if (!attackerBuy) return;

    // Find a BUY from a DIFFERENT wallet between the frontrun and backrun (victim)
    const victimBuy = recentSwaps.find(
      s => s.wallet !== sellerWallet
        && s.action === 'BUY'
        && s.timestamp > attackerBuy.timestamp
        && s.timestamp < latestSell.timestamp
    );

    if (!victimBuy) return;

    // Calculate pre-attack natural price: average price before the frontrun
    const naturalPrice = this.estimateNaturalPrice(tokenCA, attackerBuy.timestamp);
    if (naturalPrice <= 0) return;

    // Price after the attacker's backrun sell
    const priceAfterAttack = latestSell.priceSOL;

    // The dip: how far below natural price did the backrun push it?
    const dipPct = ((naturalPrice - priceAfterAttack) / naturalPrice) * 100;

    if (dipPct < MIN_DIP_PCT || dipPct > MAX_DIP_PCT) return;

    const sandwich: SandwichEvent = {
      tokenCA,
      attackerWallet: sellerWallet,
      victimWallet: victimBuy.wallet,
      frontrunBuy: attackerBuy,
      victimBuy,
      backrunSell: latestSell,
      priceBeforeAttack: naturalPrice,
      priceAfterAttack,
      naturalPrice,
      dipPct,
      detectedAt: now,
    };

    this.detectedSandwiches.push(sandwich);
    if (this.detectedSandwiches.length > 100) {
      this.detectedSandwiches = this.detectedSandwiches.slice(-50);
    }
    this.totalSandwichesDetected++;

    logger.info('Sandwich attack detected', {
      tokenCA,
      attackerWallet: sellerWallet,
      victimWallet: victimBuy.wallet,
      dipPct: dipPct.toFixed(2),
      naturalPrice: naturalPrice.toFixed(10),
      postAttackPrice: priceAfterAttack.toFixed(10),
      attackSize: attackerBuy.amountSOL.toFixed(4),
    });

    // Evaluate if this is a backrun opportunity
    this.evaluateOpportunity(sandwich);
  }

  // ── OPPORTUNITY EVALUATION ─────────────────────────────

  private evaluateOpportunity(sandwich: SandwichEvent): void {
    // Expected rebalance: price should recover ~70% of the dip
    const recoveryTarget = sandwich.priceAfterAttack +
      (sandwich.naturalPrice - sandwich.priceAfterAttack) * REBALANCE_TARGET_PCT;

    const expectedProfitPct = ((recoveryTarget - sandwich.priceAfterAttack) / sandwich.priceAfterAttack) * 100;

    // Confidence factors
    let confidence = 0.5;

    // Larger dips with clear sandwich pattern = higher confidence
    if (sandwich.dipPct >= 5) confidence += 0.1;
    if (sandwich.dipPct >= 10) confidence += 0.1;

    // Attacker buy + sell sizes should be similar (clean sandwich)
    const sizeRatio = Math.min(
      sandwich.frontrunBuy.amountSOL / sandwich.backrunSell.amountSOL,
      sandwich.backrunSell.amountSOL / sandwich.frontrunBuy.amountSOL
    );
    if (sizeRatio > 0.8) confidence += 0.15;

    // Tighter slot gap = more likely automated MEV bot = cleaner pattern
    const slotGap = Math.abs(sandwich.backrunSell.slot - sandwich.frontrunBuy.slot);
    if (slotGap <= 1) confidence += 0.1;

    confidence = Math.min(1, confidence);

    if (expectedProfitPct < 1.0) {
      logger.debug('Sandwich backrun skipped — insufficient profit', {
        tokenCA: sandwich.tokenCA,
        expectedProfitPct: expectedProfitPct.toFixed(2),
      });
      return;
    }

    const opportunity: BackrunOpportunity = {
      tokenCA: sandwich.tokenCA,
      sandwich,
      entryPrice: sandwich.priceAfterAttack,
      targetPrice: recoveryTarget,
      expectedProfitPct,
      confidence,
      maxHoldMs: MAX_HOLD_MS,
    };

    this.opportunities.push(opportunity);
    if (this.opportunities.length > 100) {
      this.opportunities = this.opportunities.slice(-50);
    }
    this.totalOpportunities++;

    logger.info('Sandwich backrun opportunity', {
      tokenCA: sandwich.tokenCA,
      dipPct: sandwich.dipPct.toFixed(2),
      entryPrice: sandwich.priceAfterAttack.toFixed(10),
      targetPrice: recoveryTarget.toFixed(10),
      expectedProfitPct: expectedProfitPct.toFixed(2),
      confidence: confidence.toFixed(2),
    });

    // Emit trade signal
    bus.emit('trade:signal', {
      tokenCA: sandwich.tokenCA,
      source: 'AUTONOMOUS' as const,
      triggerWallet: 'TOXIC_FLOW_BACKRUNNER',
      walletTier: 'S' as const,
      walletPnL30d: 0,
      convictionSOL: Math.min(0.5, sandwich.frontrunBuy.amountSOL * 0.3), // size relative to attack
      clusterWallets: [],
      clusterSize: 0,
      totalClusterSOL: 0,
      entryPriceSOL: Math.max(sandwich.priceAfterAttack, 0.000001),
      timestamp: new Date(),
      slot: sandwich.backrunSell.slot,
      score: Math.min(10, 5 + expectedProfitPct * 0.5),
      confidence,
      overrideSizeUSD: undefined,
      overrideMaxHoldMs: MAX_HOLD_MS,
    });
  }

  // ── PRICE ESTIMATION ───────────────────────────────────

  private estimateNaturalPrice(tokenCA: string, beforeTimestamp: number): number {
    const prices = this.priceHistory.get(tokenCA);
    if (!prices || prices.length === 0) return 0;

    // Get prices from before the attack (10s lookback)
    const preAttackPrices = prices.filter(
      p => p.timestamp < beforeTimestamp && p.timestamp > beforeTimestamp - 10_000
    );

    if (preAttackPrices.length === 0) {
      // Fall back to the last known price before the attack
      const lastBefore = prices
        .filter(p => p.timestamp < beforeTimestamp)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      return lastBefore?.price ?? 0;
    }

    // Use median price to resist outliers
    const sorted = preAttackPrices.map(p => p.price).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  // ── CLEANUP ────────────────────────────────────────────

  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - 60_000; // keep 60s of swap history

    for (const [tokenCA, history] of this.swapHistory) {
      const pruned = history.filter(s => s.timestamp > cutoff);
      if (pruned.length === 0) {
        this.swapHistory.delete(tokenCA);
        this.priceHistory.delete(tokenCA);
      } else {
        this.swapHistory.set(tokenCA, pruned);
      }
    }

    for (const [tokenCA, prices] of this.priceHistory) {
      const pruned = prices.filter(p => p.timestamp > cutoff);
      if (pruned.length === 0) {
        this.priceHistory.delete(tokenCA);
      } else {
        this.priceHistory.set(tokenCA, pruned);
      }
    }
  }
}
