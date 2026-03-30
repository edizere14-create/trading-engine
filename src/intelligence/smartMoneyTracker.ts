/**
 * ═══════════════════════════════════════════════════════════════
 *  SMART MONEY TRACKER — Behavioral Wallet Clustering
 * ═══════════════════════════════════════════════════════════════
 *
 * Tracks a curated set of high-performance wallets on-chain.
 * When 3+ tracked wallets buy the same token within a tight window
 * (10 seconds), fires a high-confidence signal.
 *
 * Key differences from the existing ClusterDetector in smartWalletStream:
 * - Tighter window: 10s vs 600s — catches coordinated moves, not slow accumulation
 * - Wallet scoring: weights by historical win rate, not just PnL
 * - Velocity tracking: measures BUY acceleration (buys/second)
 * - Auto-graduation: promotes wallets that consistently hit winners
 */

import { bus } from '../core/eventBus';
import { SwapEvent } from '../core/types';
import { WalletRegistry } from '../registry/walletRegistry';
import { logger } from '../core/logger';

// ── TYPES ─────────────────────────────────────────────────

export interface TrackedWallet {
  address: string;
  tier: 'S' | 'A' | 'B';
  winRate: number;          // 0-1
  avgMultiple: number;      // average exit multiple
  totalTrades: number;
  recentBuys: WalletBuy[];  // sliding window
  score: number;            // composite wallet quality score 0-100
}

interface WalletBuy {
  tokenCA: string;
  amountSOL: number;
  priceSOL: number;
  timestamp: number;
  slot: number;
}

export interface SmartMoneySignal {
  tokenCA: string;
  wallets: string[];
  walletScores: number[];   // parallel array of wallet quality scores
  avgWalletScore: number;
  totalBuySOL: number;
  buyVelocity: number;      // buys per second within the convergence window
  windowMs: number;
  firstBuyAt: number;
  lastBuyAt: number;
  confidence: number;       // 0-1
}

interface TokenBuyWindow {
  tokenCA: string;
  buys: { wallet: string; amountSOL: number; priceSOL: number; timestamp: number; score: number }[];
}

// ── CONFIG ─────────────────────────────────────────────────

const CONVERGENCE_WINDOW_MS = 10_000;     // 10 second window for cluster detection
const MIN_WALLETS_FOR_SIGNAL = 3;          // need 3+ smart wallets buying
const MIN_AVG_WALLET_SCORE = 40;           // minimum average wallet quality
const MIN_BUY_SOL = 0.1;                   // ignore dust buys
const CLEANUP_INTERVAL_MS = 30_000;        // clean stale windows every 30s
const MAX_WALLET_HISTORY = 50;             // recent buys per wallet
const WALLET_SCORE_DECAY_HOURS = 168;      // scores decay over 7 days

// Wallet scoring weights
const WIN_RATE_WEIGHT = 40;
const AVG_MULTIPLE_WEIGHT = 30;
const TRADE_COUNT_WEIGHT = 15;
const TIER_WEIGHT = 15;

// ── ENGINE ─────────────────────────────────────────────────

export class SmartMoneyTracker {
  private walletRegistry: WalletRegistry;
  private trackedWallets: Map<string, TrackedWallet> = new Map();
  private buyWindows: Map<string, TokenBuyWindow> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private signalHistory: SmartMoneySignal[] = [];
  private totalSignals = 0;
  private totalBuysProcessed = 0;

  constructor(walletRegistry: WalletRegistry) {
    this.walletRegistry = walletRegistry;
    this.initializeFromRegistry();
  }

  start(): void {
    // Listen to all swap events for BUY detection
    bus.on('swap:detected', (event) => this.onSwap(event));

    // Periodic cleanup of stale buy windows
    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);

    logger.info('SmartMoneyTracker started', {
      trackedWallets: this.trackedWallets.size,
      convergenceWindowMs: CONVERGENCE_WINDOW_MS,
      minWalletsForSignal: MIN_WALLETS_FOR_SIGNAL,
    });
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  getStats() {
    return {
      trackedWallets: this.trackedWallets.size,
      activeBuyWindows: this.buyWindows.size,
      totalSignals: this.totalSignals,
      totalBuysProcessed: this.totalBuysProcessed,
      recentSignals: this.signalHistory.slice(-10),
      topWallets: Array.from(this.trackedWallets.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(w => ({ address: w.address, score: w.score, winRate: w.winRate, tier: w.tier })),
    };
  }

  // ── INITIALIZATION ─────────────────────────────────────

  private initializeFromRegistry(): void {
    const wallets = this.walletRegistry.getAll();
    for (const w of wallets) {
      const score = this.calculateWalletScore(w.tier, 0.5, 1.5, w.tradeCount);
      this.trackedWallets.set(w.address, {
        address: w.address,
        tier: w.tier,
        winRate: 0.5,       // default until we observe
        avgMultiple: 1.5,   // default optimistic
        totalTrades: w.tradeCount,
        recentBuys: [],
        score,
      });
    }
  }

  // ── SWAP HANDLER ───────────────────────────────────────

  private onSwap(event: SwapEvent): void {
    // Only track BUYs from smart wallets above dust threshold
    if (event.action !== 'BUY') return;
    if (event.amountSOL < MIN_BUY_SOL) return;
    if (!event.isSmartWallet) return;

    const wallet = this.trackedWallets.get(event.wallet);
    if (!wallet) return;

    this.totalBuysProcessed++;

    // Record this buy
    const buy: WalletBuy = {
      tokenCA: event.tokenCA,
      amountSOL: event.amountSOL,
      priceSOL: event.priceSOL,
      timestamp: Date.now(),
      slot: event.slot,
    };

    wallet.recentBuys.push(buy);
    if (wallet.recentBuys.length > MAX_WALLET_HISTORY) {
      wallet.recentBuys = wallet.recentBuys.slice(-MAX_WALLET_HISTORY);
    }

    // Add to token buy window
    this.recordBuyInWindow(event.tokenCA, event.wallet, event.amountSOL, event.priceSOL, wallet.score);

    // Check for convergence signal
    this.checkConvergence(event.tokenCA);
  }

  private recordBuyInWindow(
    tokenCA: string,
    wallet: string,
    amountSOL: number,
    priceSOL: number,
    walletScore: number
  ): void {
    const window = this.buyWindows.get(tokenCA) ?? { tokenCA, buys: [] };
    const now = Date.now();

    // Prune buys outside the convergence window
    window.buys = window.buys.filter(b => now - b.timestamp < CONVERGENCE_WINDOW_MS);

    // Don't double-count same wallet in same window
    if (window.buys.some(b => b.wallet === wallet)) return;

    window.buys.push({ wallet, amountSOL, priceSOL, timestamp: now, score: walletScore });
    this.buyWindows.set(tokenCA, window);
  }

  // ── CONVERGENCE DETECTION ──────────────────────────────

  private checkConvergence(tokenCA: string): void {
    const window = this.buyWindows.get(tokenCA);
    if (!window || window.buys.length < MIN_WALLETS_FOR_SIGNAL) return;

    const now = Date.now();
    const freshBuys = window.buys.filter(b => now - b.timestamp < CONVERGENCE_WINDOW_MS);

    if (freshBuys.length < MIN_WALLETS_FOR_SIGNAL) return;

    const uniqueWallets = new Set(freshBuys.map(b => b.wallet));
    if (uniqueWallets.size < MIN_WALLETS_FOR_SIGNAL) return;

    // Calculate signal quality
    const walletScores = freshBuys.map(b => b.score);
    const avgScore = walletScores.reduce((s, v) => s + v, 0) / walletScores.length;

    if (avgScore < MIN_AVG_WALLET_SCORE) {
      logger.debug('SmartMoney convergence below quality threshold', {
        tokenCA,
        walletCount: uniqueWallets.size,
        avgScore: avgScore.toFixed(1),
      });
      return;
    }

    const totalBuySOL = freshBuys.reduce((s, b) => s + b.amountSOL, 0);
    const timestamps = freshBuys.map(b => b.timestamp);
    const firstBuy = Math.min(...timestamps);
    const lastBuy = Math.max(...timestamps);
    const windowMs = lastBuy - firstBuy;
    const buyVelocity = windowMs > 0 ? freshBuys.length / (windowMs / 1000) : freshBuys.length;

    // Confidence: more wallets + higher scores + faster convergence = higher confidence
    const walletBonus = Math.min(1, (uniqueWallets.size - MIN_WALLETS_FOR_SIGNAL + 1) * 0.2);
    const scoreBonus = Math.min(1, avgScore / 80);
    const velocityBonus = Math.min(1, buyVelocity * 0.5);
    const confidence = Math.min(1, (walletBonus + scoreBonus + velocityBonus) / 2.5);

    const signal: SmartMoneySignal = {
      tokenCA,
      wallets: Array.from(uniqueWallets),
      walletScores,
      avgWalletScore: avgScore,
      totalBuySOL,
      buyVelocity,
      windowMs,
      firstBuyAt: firstBuy,
      lastBuyAt: lastBuy,
      confidence,
    };

    this.signalHistory.push(signal);
    if (this.signalHistory.length > 100) {
      this.signalHistory = this.signalHistory.slice(-50);
    }
    this.totalSignals++;

    logger.info('SmartMoney convergence signal', {
      tokenCA,
      walletCount: uniqueWallets.size,
      avgWalletScore: avgScore.toFixed(1),
      totalBuySOL: totalBuySOL.toFixed(4),
      buyVelocity: buyVelocity.toFixed(2),
      windowMs,
      confidence: confidence.toFixed(2),
    });

    // Emit trade signal — use the median entry price from the smart wallets
    const sortedPrices = freshBuys.map(b => b.priceSOL).sort((a, b) => a - b);
    const medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)];

    bus.emit('trade:signal', {
      tokenCA,
      source: 'AUTONOMOUS' as const,
      triggerWallet: freshBuys[0].wallet,
      walletTier: 'S' as const,
      walletPnL30d: 0,
      convictionSOL: totalBuySOL,
      clusterWallets: Array.from(uniqueWallets),
      clusterSize: uniqueWallets.size,
      totalClusterSOL: totalBuySOL,
      entryPriceSOL: Math.max(medianPrice, 0.000001),
      timestamp: new Date(),
      slot: 0,
      score: Math.min(10, 5 + confidence * 5),
      confidence,
      overrideSizeUSD: undefined,
      overrideMaxHoldMs: 180_000, // 3 min max hold for fast-signal trades
    });

    // Clear this window to prevent duplicate signals
    this.buyWindows.delete(tokenCA);
  }

  // ── WALLET SCORING ─────────────────────────────────────

  private calculateWalletScore(
    tier: 'S' | 'A' | 'B',
    winRate: number,
    avgMultiple: number,
    totalTrades: number
  ): number {
    const tierScore = tier === 'S' ? 1.0 : tier === 'A' ? 0.7 : 0.4;
    const winRateScore = Math.min(1, winRate);
    const multipleScore = Math.min(1, (avgMultiple - 1) / 4); // 5x = perfect
    const tradeCountScore = Math.min(1, totalTrades / 50);    // 50+ trades = mature

    return (
      tierScore * TIER_WEIGHT +
      winRateScore * WIN_RATE_WEIGHT +
      multipleScore * AVG_MULTIPLE_WEIGHT +
      tradeCountScore * TRADE_COUNT_WEIGHT
    );
  }

  /**
   * Update a wallet's performance metrics after observing a trade outcome.
   * Called externally when position:closed fires.
   */
  updateWalletPerformance(
    walletAddress: string,
    won: boolean,
    multiple: number
  ): void {
    const wallet = this.trackedWallets.get(walletAddress);
    if (!wallet) return;

    wallet.totalTrades++;
    // Running average
    const alpha = 1 / Math.min(wallet.totalTrades, 50);
    wallet.winRate = wallet.winRate * (1 - alpha) + (won ? 1 : 0) * alpha;
    wallet.avgMultiple = wallet.avgMultiple * (1 - alpha) + multiple * alpha;
    wallet.score = this.calculateWalletScore(wallet.tier, wallet.winRate, wallet.avgMultiple, wallet.totalTrades);

    // Auto-promote: B→A if score > 60, A→S if score > 80
    if (wallet.tier === 'B' && wallet.score > 60 && wallet.totalTrades >= 10) {
      wallet.tier = 'A';
      logger.info('SmartMoney wallet promoted B→A', { address: walletAddress, score: wallet.score });
    } else if (wallet.tier === 'A' && wallet.score > 80 && wallet.totalTrades >= 25) {
      wallet.tier = 'S';
      logger.info('SmartMoney wallet promoted A→S', { address: walletAddress, score: wallet.score });
    }

    // Auto-demote: if score drops below tier threshold
    if (wallet.tier === 'S' && wallet.score < 60) {
      wallet.tier = 'A';
      logger.info('SmartMoney wallet demoted S→A', { address: walletAddress, score: wallet.score });
    } else if (wallet.tier === 'A' && wallet.score < 35) {
      wallet.tier = 'B';
      logger.info('SmartMoney wallet demoted A→B', { address: walletAddress, score: wallet.score });
    }
  }

  // ── CLEANUP ────────────────────────────────────────────

  private cleanup(): void {
    const now = Date.now();
    for (const [tokenCA, window] of this.buyWindows) {
      window.buys = window.buys.filter(b => now - b.timestamp < CONVERGENCE_WINDOW_MS * 3);
      if (window.buys.length === 0) {
        this.buyWindows.delete(tokenCA);
      }
    }
  }
}
