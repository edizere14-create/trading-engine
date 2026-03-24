import { WalletPerformanceStats, WalletTier } from '../core/types';
import { WalletRegistry } from '../registry/walletRegistry';
import { logger } from '../core/logger';

export class WalletPerformanceTracker {
  private stats: Map<string, WalletPerformanceStats> = new Map();
  private walletRegistry: WalletRegistry;
  private cooldownLosses: number;
  private cooldownHours: number;

  constructor(
    walletRegistry: WalletRegistry,
    cooldownLosses: number,
    cooldownHours: number
  ) {
    this.walletRegistry = walletRegistry;
    this.cooldownLosses = cooldownLosses;
    this.cooldownHours = cooldownHours;

    // Initialize stats for all tracked wallets
    for (const wallet of walletRegistry.getAll()) {
      this.stats.set(wallet.address, {
        address: wallet.address,
        tier: wallet.tier,
        copiedTrades: 0,
        copiedWins: 0,
        copiedLosses: 0,
        copiedWinRate: 0,
        avgWinMultiple: 0,
        avgLossMultiple: 0,
        totalPnLSOL: 0,
        recentAccuracy: 0,
        isCoolingDown: false,
      });
    }
  }

  /**
   * Record the result of a copy trade attributed to a wallet.
   */
  recordCopyResult(
    walletAddress: string,
    outcome: 'WIN' | 'LOSS' | 'BREAKEVEN',
    realizedMultiple: number
  ): void {
    let entry = this.stats.get(walletAddress);
    if (!entry) {
      const walletInfo = this.walletRegistry.getWalletStats(walletAddress);
      entry = {
        address: walletAddress,
        tier: walletInfo?.tier ?? 'B',
        copiedTrades: 0,
        copiedWins: 0,
        copiedLosses: 0,
        copiedWinRate: 0,
        avgWinMultiple: 0,
        avgLossMultiple: 0,
        totalPnLSOL: 0,
        recentAccuracy: 0,
        isCoolingDown: false,
      };
      this.stats.set(walletAddress, entry);
    }

    entry.copiedTrades++;
    entry.lastCopiedAt = new Date();

    const pnlFraction = realizedMultiple - 1; // e.g. 1.3x = +0.3

    if (outcome === 'WIN') {
      entry.copiedWins++;
      entry.avgWinMultiple = this.runningAvg(entry.avgWinMultiple, realizedMultiple, entry.copiedWins);
      entry.totalPnLSOL += pnlFraction; // normalized per 1 SOL
    } else if (outcome === 'LOSS') {
      entry.copiedLosses++;
      entry.avgLossMultiple = this.runningAvg(entry.avgLossMultiple, realizedMultiple, entry.copiedLosses);
      entry.totalPnLSOL += pnlFraction;
    }

    entry.copiedWinRate = entry.copiedTrades > 0
      ? entry.copiedWins / entry.copiedTrades
      : 0;

    // Check for consecutive losses → cooldown
    this.evaluateCooldown(entry, outcome);

    logger.info('Wallet performance updated', {
      wallet: walletAddress,
      tier: entry.tier,
      copiedTrades: entry.copiedTrades,
      winRate: (entry.copiedWinRate * 100).toFixed(1) + '%',
      totalPnLSOL: entry.totalPnLSOL.toFixed(4),
      isCoolingDown: entry.isCoolingDown,
    });
  }

  isOnCooldown(walletAddress: string): boolean {
    const entry = this.stats.get(walletAddress);
    if (!entry) return false;
    if (!entry.isCoolingDown) return false;

    // Check if cooldown has expired
    if (entry.cooldownUntil && new Date() > entry.cooldownUntil) {
      entry.isCoolingDown = false;
      entry.cooldownUntil = undefined;
      logger.info('Wallet cooldown expired', { wallet: walletAddress });
      return false;
    }

    return true;
  }

  getStats(walletAddress: string): WalletPerformanceStats | null {
    return this.stats.get(walletAddress) ?? null;
  }

  getAllStats(): WalletPerformanceStats[] {
    return Array.from(this.stats.values());
  }

  /**
   * Get wallets ranked by copy-trade profit.
   */
  getRankedWallets(): WalletPerformanceStats[] {
    return this.getAllStats()
      .filter(s => s.copiedTrades >= 3) // minimum sample
      .sort((a, b) => b.totalPnLSOL - a.totalPnLSOL);
  }

  /**
   * Dynamically adjust wallet tier based on copy-trade performance.
   */
  getEffectiveTier(walletAddress: string): WalletTier {
    const entry = this.stats.get(walletAddress);
    if (!entry || entry.copiedTrades < 5) {
      // Not enough data — use registry tier
      return this.walletRegistry.getWalletStats(walletAddress)?.tier ?? 'B';
    }

    // Promote/demote based on actual copy performance
    if (entry.copiedWinRate >= 0.60 && entry.totalPnLSOL > 0) return 'S';
    if (entry.copiedWinRate >= 0.45 && entry.totalPnLSOL > 0) return 'A';
    return 'B';
  }

  private evaluateCooldown(
    entry: WalletPerformanceStats,
    latestOutcome: 'WIN' | 'LOSS' | 'BREAKEVEN'
  ): void {
    if (latestOutcome !== 'LOSS') {
      // Win or breakeven resets any cooldown path
      return;
    }

    // Count recent consecutive losses  
    // Simple heuristic: if losses exceed threshold relative to recent trades
    const recentLosses = this.countRecentConsecutiveLosses(entry);
    
    if (recentLosses >= this.cooldownLosses) {
      entry.isCoolingDown = true;
      entry.cooldownUntil = new Date(Date.now() + this.cooldownHours * 3600_000);
      logger.warn('Wallet placed on cooldown', {
        wallet: entry.address,
        consecutiveLosses: recentLosses,
        cooldownUntil: entry.cooldownUntil.toISOString(),
      });
    }
  }

  private countRecentConsecutiveLosses(entry: WalletPerformanceStats): number {
    // Approximate: if recent win rate is very low over enough trades, trigger
    if (entry.copiedTrades < this.cooldownLosses) return 0;
    
    // Use loss/win ratio of recent trades as proxy
    // When copiedLosses - copiedWins >= cooldownLosses, we have a problem
    const netLosses = entry.copiedLosses - entry.copiedWins;
    return Math.max(0, netLosses);
  }

  private runningAvg(prevAvg: number, newValue: number, count: number): number {
    if (count <= 1) return newValue;
    return prevAvg + (newValue - prevAvg) / count;
  }
}
