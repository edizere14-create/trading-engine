import { SwapEvent, CopyTradeSignal, CopyTradeSource, WalletTier } from '../core/types';
import { WalletRegistry } from '../registry/walletRegistry';
import { logger } from '../core/logger';

interface TokenBuyHistory {
  wallets: Map<string, { amountSOL: number; timestamp: number; tier: WalletTier }>;
  firstSeenAt: number;
}

export class SwapSignalEvaluator {
  private walletRegistry: WalletRegistry;
  private tokenBuys: Map<string, TokenBuyHistory> = new Map();
  private minSwapSOL: number;
  private maxSwapSOL: number;
  private tokenMaxAgeMs: number;

  // Tracks tokens we've already emitted signals for (avoid duplicates)
  private emittedTokens: Set<string> = new Set();

  constructor(
    walletRegistry: WalletRegistry,
    minSwapSOL: number,
    maxSwapSOL: number,
    tokenMaxAgeMs: number
  ) {
    this.walletRegistry = walletRegistry;
    this.minSwapSOL = minSwapSOL;
    this.maxSwapSOL = maxSwapSOL;
    this.tokenMaxAgeMs = tokenMaxAgeMs;

    // Cleanup old entries every 5 minutes
    setInterval(() => this.cleanup(), 300_000);
  }

  /**
   * Evaluate a swap event and decide if it's worth copying.
   * Returns null if the swap doesn't warrant a trade.
   */
  evaluate(event: SwapEvent): CopyTradeSignal | null {
    // Only care about BUY signals for entries
    if (event.action !== 'BUY') return null;

    // Filter dust and whale-only plays
    if (event.amountSOL < this.minSwapSOL) return null;
    if (event.amountSOL > this.maxSwapSOL) return null;

    // Must be a tracked smart wallet
    const stats = this.walletRegistry.getWalletStats(event.wallet);
    if (!stats) return null;

    // Record this buy
    this.recordBuy(event, stats.tier);

    const history = this.tokenBuys.get(event.tokenCA)!;
    const clusterWallets = Array.from(history.wallets.keys());
    const clusterSize = clusterWallets.length;
    const totalClusterSOL = Array.from(history.wallets.values())
      .reduce((sum, w) => sum + w.amountSOL, 0);

    // Score the signal
    const score = this.computeScore(event, stats.tier, stats.pnl30d, clusterSize, totalClusterSOL);

    // Must meet minimum score threshold
    if (score < 3.0) {
      logger.debug('Swap signal below threshold', {
        tokenCA: event.tokenCA,
        wallet: event.wallet,
        score: score.toFixed(1),
        amountSOL: event.amountSOL,
      });
      return null;
    }

    // Determine source type
    const source: CopyTradeSource = clusterSize >= 3 ? 'CLUSTER' : 'SINGLE_WALLET';

    // Confidence based on data quality
    const confidence = this.computeConfidence(stats.tier, clusterSize, event.amountSOL);

    const signal: CopyTradeSignal = {
      tokenCA: event.tokenCA,
      source,
      triggerWallet: event.wallet,
      walletTier: stats.tier,
      walletPnL30d: stats.pnl30d,
      convictionSOL: event.amountSOL,
      clusterWallets,
      clusterSize,
      totalClusterSOL,
      entryPriceSOL: event.priceSOL,
      timestamp: event.timestamp,
      slot: event.slot,
      score,
      confidence,
    };

    logger.info('Copy trade signal generated', {
      tokenCA: event.tokenCA,
      wallet: event.wallet,
      tier: stats.tier,
      amountSOL: event.amountSOL,
      score: score.toFixed(2),
      source,
      clusterSize,
      confidence: confidence.toFixed(2),
    });

    return signal;
  }

  /**
   * Check if a token has already been traded (dedup).
   */
  hasEmitted(tokenCA: string): boolean {
    return this.emittedTokens.has(tokenCA);
  }

  markEmitted(tokenCA: string): void {
    this.emittedTokens.add(tokenCA);
  }

  /**
   * Check if a token has re-buy activity (existing wallets adding more).
   * Returns the updated count.
   */
  getReBuyCount(tokenCA: string, excludeWallet?: string): number {
    const history = this.tokenBuys.get(tokenCA);
    if (!history) return 0;
    if (!excludeWallet) return history.wallets.size;
    return Array.from(history.wallets.keys()).filter(w => w !== excludeWallet).length;
  }

  getTokenAge(tokenCA: string): number {
    const history = this.tokenBuys.get(tokenCA);
    if (!history) return Infinity;
    return Date.now() - history.firstSeenAt;
  }

  private recordBuy(event: SwapEvent, tier: WalletTier): void {
    let history = this.tokenBuys.get(event.tokenCA);
    if (!history) {
      history = { wallets: new Map(), firstSeenAt: Date.now() };
      this.tokenBuys.set(event.tokenCA, history);
    }

    const existing = history.wallets.get(event.wallet);
    if (existing) {
      // Re-buy: accumulate
      existing.amountSOL += event.amountSOL;
      existing.timestamp = Date.now();
    } else {
      history.wallets.set(event.wallet, {
        amountSOL: event.amountSOL,
        timestamp: Date.now(),
        tier,
      });
    }
  }

  private computeScore(
    event: SwapEvent,
    tier: WalletTier,
    pnl30d: number,
    clusterSize: number,
    totalClusterSOL: number
  ): number {
    let score = 0;

    // 1. Wallet tier (0–3)
    score += tier === 'S' ? 3 : tier === 'A' ? 2 : 1;

    // 2. Conviction — how much SOL (0–2.5)
    // 0.05–0.1 SOL = low conviction, >0.3 SOL = strong conviction
    if (event.amountSOL >= 0.5) score += 2.5;
    else if (event.amountSOL >= 0.3) score += 2.0;
    else if (event.amountSOL >= 0.1) score += 1.0;
    else score += 0.5;

    // 3. Cluster confirmation (0–3)
    if (clusterSize >= 4) score += 3;
    else if (clusterSize >= 3) score += 2.5;
    else if (clusterSize >= 2) score += 1.5;

    // 4. PnL track record (0–1.5)
    if (pnl30d > 50) score += 1.5;       // >50 SOL profit
    else if (pnl30d > 20) score += 1.0;
    else if (pnl30d > 5) score += 0.5;

    return Math.min(10, score);
  }

  private computeConfidence(
    tier: WalletTier,
    clusterSize: number,
    amountSOL: number
  ): number {
    let conf = 0.4; // base

    // Tier adds confidence
    if (tier === 'S') conf += 0.25;
    else if (tier === 'A') conf += 0.15;
    else conf += 0.05;

    // Cluster adds confidence
    if (clusterSize >= 3) conf += 0.2;
    else if (clusterSize >= 2) conf += 0.1;

    // Conviction adds confidence
    if (amountSOL >= 0.3) conf += 0.15;
    else if (amountSOL >= 0.1) conf += 0.05;

    return Math.min(1, conf);
  }

  private cleanup(): void {
    const now = Date.now();
    const maxAge = Math.max(this.tokenMaxAgeMs, 3_600_000); // at least 1hr retention

    for (const [tokenCA, history] of this.tokenBuys) {
      if (now - history.firstSeenAt > maxAge) {
        this.tokenBuys.delete(tokenCA);
        this.emittedTokens.delete(tokenCA);
      }
    }
  }
}
