import { randomUUID } from 'crypto';
import {
  CopyPosition,
  CopyTradeSignal,
  CopyExitTier,
  SwapEvent,
  SystemMode,
  SurvivalSnapshot,
} from '../core/types';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';
import { WalletPerformanceTracker } from './walletPerformanceTracker';

interface CopyTradeConfig {
  mode: SystemMode;
  capitalUSD: number;
  copySizePct: number;       // fraction of capital per trade
  maxConcurrent: number;
  maxTradesPerDay: number;
  stopLossPct: number;       // e.g. 0.30 = -30%
  maxHoldMs: number;
  clusterBonusPct: number;   // extra size for cluster signals
  reBuyExtendMs: number;     // extend hold on re-buy
  solPriceUSD: number;       // current SOL price (updated externally)
}

export class CopyTradeManager {
  private positions: Map<string, CopyPosition> = new Map(); // tokenCA → position
  private closedPositions: CopyPosition[] = [];
  private tradesToday: number = 0;
  private config: CopyTradeConfig;
  private walletTracker: WalletPerformanceTracker;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: CopyTradeConfig, walletTracker: WalletPerformanceTracker) {
    this.config = config;
    this.walletTracker = walletTracker;
  }

  start(): void {
    // Monitor open positions every 10 seconds for time exits & stop losses
    this.monitorInterval = setInterval(() => this.monitorPositions(), 10_000);

    // Reset daily trade count at midnight UTC
    const now = new Date();
    const msUntilMidnight =
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).getTime() - now.getTime();
    setTimeout(() => {
      this.tradesToday = 0;
      setInterval(() => { this.tradesToday = 0; }, 86_400_000);
    }, msUntilMidnight);

    logger.info('CopyTradeManager started', {
      mode: this.config.mode,
      maxConcurrent: this.config.maxConcurrent,
      maxTradesPerDay: this.config.maxTradesPerDay,
      stopLossPct: this.config.stopLossPct,
      maxHoldMs: this.config.maxHoldMs,
    });
  }

  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  updateSOLPrice(priceUSD: number): void {
    this.config.solPriceUSD = priceUSD;
  }

  /**
   * Attempt to open a copy trade from a signal. Returns true if trade was opened.
   */
  openTrade(signal: CopyTradeSignal, survival: SurvivalSnapshot): boolean {
    // Gate: survival halt
    if (survival.state === 'HALT') {
      logger.warn('Copy trade blocked: SURVIVAL_HALT', { tokenCA: signal.tokenCA });
      return false;
    }

    // Gate: max concurrent
    if (this.positions.size >= this.config.maxConcurrent) {
      logger.info('Copy trade blocked: MAX_CONCURRENT', {
        tokenCA: signal.tokenCA,
        openPositions: this.positions.size,
      });
      return false;
    }

    // Gate: max trades per day
    if (this.tradesToday >= this.config.maxTradesPerDay) {
      logger.info('Copy trade blocked: MAX_DAILY_TRADES', {
        tokenCA: signal.tokenCA,
        tradesToday: this.tradesToday,
      });
      return false;
    }

    // Gate: already have position in this token
    if (this.positions.has(signal.tokenCA)) {
      logger.debug('Copy trade skipped: already positioned', { tokenCA: signal.tokenCA });
      return false;
    }

    // Gate: wallet on cooldown
    if (this.walletTracker.isOnCooldown(signal.triggerWallet)) {
      logger.info('Copy trade blocked: WALLET_COOLDOWN', {
        wallet: signal.triggerWallet,
        tokenCA: signal.tokenCA,
      });
      return false;
    }

    // Size calculation
    let sizeSOL = this.calculateSize(signal, survival);
    const sizeUSD = sizeSOL * this.config.solPriceUSD;

    // Safety floor: never risk more than 5% of capital on one trade
    const maxSizeUSD = this.config.capitalUSD * 0.05;
    if (sizeUSD > maxSizeUSD) {
      sizeSOL = maxSizeUSD / this.config.solPriceUSD;
    }

    // Build exit tiers — aggressive for memecoins
    const tiers = this.buildExitTiers();

    // Determine max hold — extend for clusters
    let maxHoldMs = this.config.maxHoldMs;
    if (signal.source === 'CLUSTER') {
      maxHoldMs = Math.round(maxHoldMs * 1.5); // clusters have stronger signal, hold longer
    }

    const position: CopyPosition = {
      id: randomUUID(),
      tokenCA: signal.tokenCA,
      mode: this.config.mode,
      entryPriceSOL: signal.entryPriceSOL,
      entryTimestamp: new Date(),
      sizeSOL,
      sizeUSD,
      sourceWallets: [signal.triggerWallet, ...signal.clusterWallets.filter(w => w !== signal.triggerWallet)],
      reBuyCount: 0,
      maxHoldMs,
      stopLossPct: this.config.stopLossPct,
      takeProfitTiers: tiers,
      peakPriceSOL: signal.entryPriceSOL,
      lastCheckedAt: new Date(),
      status: 'OPEN',
    };

    this.positions.set(signal.tokenCA, position);
    this.tradesToday++;

    bus.emit('copy:opened', position);

    logger.info('Copy trade OPENED', {
      id: position.id,
      tokenCA: signal.tokenCA,
      mode: this.config.mode,
      sizeSOL: sizeSOL.toFixed(4),
      sizeUSD: sizeUSD.toFixed(2),
      source: signal.source,
      triggerWallet: signal.triggerWallet,
      score: signal.score.toFixed(1),
      walletTier: signal.walletTier,
      clusterSize: signal.clusterSize,
      maxHoldMs,
      stopLossPct: this.config.stopLossPct,
    });

    return true;
  }

  /**
   * Handle a mirror sell: a tracked wallet sells a token we're holding.
   */
  handleMirrorSell(event: SwapEvent): void {
    const position = this.positions.get(event.tokenCA);
    if (!position) return;

    // Only mirror sells from wallets that triggered our entry
    if (!position.sourceWallets.includes(event.wallet)) return;

    bus.emit('copy:mirrorSell', {
      tokenCA: event.tokenCA,
      wallet: event.wallet,
      amountSOL: event.amountSOL,
    });

    logger.info('Mirror sell detected — closing position', {
      tokenCA: event.tokenCA,
      wallet: event.wallet,
      amountSOL: event.amountSOL,
    });

    this.closePosition(event.tokenCA, 'MIRROR_SELL', event.priceSOL);
  }

  /**
   * Handle a re-buy: a tracked wallet buys more of a token we're holding.
   * Increases conviction — extend hold time.
   */
  handleReBuy(event: SwapEvent): void {
    const position = this.positions.get(event.tokenCA);
    if (!position) return;

    position.reBuyCount++;
    position.maxHoldMs += this.config.reBuyExtendMs;

    if (!position.sourceWallets.includes(event.wallet)) {
      position.sourceWallets.push(event.wallet);
    }

    bus.emit('copy:reBuy', {
      tokenCA: event.tokenCA,
      wallet: event.wallet,
      amountSOL: event.amountSOL,
      reBuyCount: position.reBuyCount,
    });

    logger.info('Re-buy conviction boost', {
      tokenCA: event.tokenCA,
      wallet: event.wallet,
      reBuyCount: position.reBuyCount,
      newMaxHoldMs: position.maxHoldMs,
    });
  }

  /**
   * Update price for a token and check exit conditions.
   */
  updatePrice(tokenCA: string, currentPriceSOL: number): void {
    const position = this.positions.get(tokenCA);
    if (!position) return;

    position.lastCheckedAt = new Date();

    // Track peak
    if (currentPriceSOL > position.peakPriceSOL) {
      position.peakPriceSOL = currentPriceSOL;
    }

    const multiple = currentPriceSOL / position.entryPriceSOL;

    // Stop loss
    if (multiple <= (1 - position.stopLossPct)) {
      this.closePosition(tokenCA, `STOP_LOSS (${((1 - multiple) * 100).toFixed(1)}% loss)`, currentPriceSOL);
      return;
    }

    // Check take-profit tiers
    for (const tier of position.takeProfitTiers) {
      if (tier.triggered) continue;
      if (multiple >= tier.multiple) {
        tier.triggered = true;
        tier.triggeredAt = new Date();
        logger.info('Take-profit tier hit', {
          tokenCA,
          multiple: tier.multiple,
          currentMultiple: multiple.toFixed(2),
          exitPct: (tier.pct * 100).toFixed(0) + '%',
        });
      }
    }

    // If all tiers triggered, close fully
    const allTriggered = position.takeProfitTiers.every(t => t.triggered);
    if (allTriggered) {
      this.closePosition(tokenCA, 'ALL_TIERS_HIT', currentPriceSOL);
      return;
    }

    // Trailing stop: if we've been above 1.5x and drop back to 1.1x, exit
    const peakMultiple = position.peakPriceSOL / position.entryPriceSOL;
    if (peakMultiple > 1.5 && multiple < 1.1) {
      this.closePosition(tokenCA, `TRAILING_STOP (peak ${peakMultiple.toFixed(1)}x, now ${multiple.toFixed(2)}x)`, currentPriceSOL);
      return;
    }
  }

  /**
   * Close all positions in emergency.
   */
  emergencyCloseAll(reason: string): void {
    for (const [tokenCA] of this.positions) {
      this.closePosition(tokenCA, `EMERGENCY: ${reason}`);
    }
  }

  hasPosition(tokenCA: string): boolean {
    return this.positions.has(tokenCA);
  }

  getOpenPositions(): CopyPosition[] {
    return Array.from(this.positions.values());
  }

  getClosedPositions(): CopyPosition[] {
    return this.closedPositions;
  }

  getStats() {
    const closed = this.closedPositions;
    const wins = closed.filter(p => p.outcome === 'WIN').length;
    const losses = closed.filter(p => p.outcome === 'LOSS').length;
    const totalPnL = closed.reduce((s, p) => s + (p.realizedPnLSOL ?? 0), 0);
    return {
      openCount: this.positions.size,
      closedCount: closed.length,
      wins,
      losses,
      winRate: closed.length > 0 ? wins / closed.length : 0,
      totalPnLSOL: totalPnL,
      tradesToday: this.tradesToday,
    };
  }

  private closePosition(tokenCA: string, reason: string, exitPriceSOL?: number): void {
    const position = this.positions.get(tokenCA);
    if (!position) return;

    position.status = 'CLOSED';
    position.exitReason = reason;

    if (exitPriceSOL) {
      const multiple = exitPriceSOL / position.entryPriceSOL;
      position.realizedMultiple = multiple;
      position.realizedPnLSOL = (multiple - 1) * position.sizeSOL;
      position.outcome = multiple >= 1.02 ? 'WIN' : multiple <= 0.98 ? 'LOSS' : 'BREAKEVEN';
    } else {
      // No price available — assume loss (conservative)
      position.realizedMultiple = 0.7;
      position.realizedPnLSOL = -0.3 * position.sizeSOL;
      position.outcome = 'LOSS';
    }

    this.positions.delete(tokenCA);
    this.closedPositions.push(position);

    // Record in wallet performance tracker
    for (const wallet of position.sourceWallets) {
      this.walletTracker.recordCopyResult(
        wallet,
        position.outcome!,
        position.realizedMultiple!
      );
    }

    bus.emit('copy:closed', position);

    logger.info('Copy trade CLOSED', {
      id: position.id,
      tokenCA,
      reason,
      mode: position.mode,
      multiple: position.realizedMultiple?.toFixed(3),
      pnlSOL: position.realizedPnLSOL?.toFixed(4),
      outcome: position.outcome,
      holdMs: Date.now() - position.entryTimestamp.getTime(),
      reBuyCount: position.reBuyCount,
    });
  }

  private monitorPositions(): void {
    const now = Date.now();

    for (const [tokenCA, position] of this.positions) {
      const holdMs = now - position.entryTimestamp.getTime();

      // Time exit: edge expired
      if (holdMs > position.maxHoldMs) {
        this.closePosition(tokenCA, `TIME_EXIT (held ${Math.round(holdMs / 1000)}s)`);
        continue;
      }

      // Stale check: if we haven't updated price in 2 minutes, something is wrong
      const staleSince = now - position.lastCheckedAt.getTime();
      if (staleSince > 120_000) {
        logger.warn('Position price stale', {
          tokenCA,
          staleSinceMs: staleSince,
        });
      }
    }
  }

  private calculateSize(signal: CopyTradeSignal, survival: SurvivalSnapshot): number {
    const baseSizeUSD = this.config.capitalUSD * this.config.copySizePct;
    let sizeUSD = baseSizeUSD;

    // Score multiplier: higher score = larger position
    if (signal.score >= 7) sizeUSD *= 1.5;
    else if (signal.score >= 5) sizeUSD *= 1.0;
    else sizeUSD *= 0.5;

    // Cluster bonus
    if (signal.source === 'CLUSTER') {
      sizeUSD *= (1 + this.config.clusterBonusPct);
    }

    // Tier bonus: S wallets get more allocation
    if (signal.walletTier === 'S') sizeUSD *= 1.3;
    else if (signal.walletTier === 'A') sizeUSD *= 1.1;

    // Survival multiplier
    sizeUSD *= survival.sizeMultiplier;

    return sizeUSD / this.config.solPriceUSD;
  }

  private buildExitTiers(): CopyExitTier[] {
    return [
      { multiple: 1.3, pct: 0.40, triggered: false },  // Take 40% at 1.3x
      { multiple: 1.6, pct: 0.30, triggered: false },  // Take 30% at 1.6x
      { multiple: 2.5, pct: 0.20, triggered: false },  // Take 20% at 2.5x
      { multiple: 5.0, pct: 0.10, triggered: false },  // Moonbag 10% at 5x
    ];
  }
}
