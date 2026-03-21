import { TradeJournal } from '../journal/tradeJournal';
import { JournalEntry } from '../journal/journalTypes';
import { EquityMetrics } from './equityMetrics';
import { logger } from '../core/logger';

export type AggressionLevel = 'MAXIMUM' | 'NORMAL' | 'REDUCED' | 'MINIMAL' | 'SUSPENDED';

export class EquityCurveController {
  private initialCapital: number;
  private journal: TradeJournal;

  constructor(initialCapital: number, journal: TradeJournal) {
    this.initialCapital = initialCapital;
    this.journal = journal;
  }

  getMetrics(): EquityMetrics {
    const trades = this.journal.getAll().filter((t) => t.outcome !== undefined);
    let capital = this.initialCapital;
    let peak = capital;
    let maxDrawdown = 0;
    const curve: number[] = [capital];
    let grossWins = 0;
    let grossLosses = 0;
    let winStreak = 0;
    let lossStreak = 0;
    let currentStreak = 0;

    for (const trade of trades) {
      capital += trade.realizedPnLUSD ?? 0;
      curve.push(capital);
      if (capital > peak) peak = capital;
      const dd = (peak - capital) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;

      if (trade.outcome === 'WIN') {
        grossWins += trade.realizedPnLUSD ?? 0;
        currentStreak = currentStreak > 0 ? currentStreak + 1 : 1;
        winStreak = Math.max(winStreak, currentStreak);
      } else {
        grossLosses += Math.abs(trade.realizedPnLUSD ?? 0);
        currentStreak = currentStreak < 0 ? currentStreak - 1 : -1;
        lossStreak = Math.max(lossStreak, Math.abs(currentStreak));
      }
    }

    const wins = trades.filter((t) => t.outcome === 'WIN');
    const losses = trades.filter((t) => t.outcome === 'LOSS');

    return {
      currentCapital: capital,
      peakCapital: peak,
      drawdownPct: ((peak - capital) / peak) * 100,
      drawdownUSD: peak - capital,
      dailyPnLPct: this.calcPeriodPnL(trades, 1),
      weeklyPnLPct: this.calcPeriodPnL(trades, 7),
      monthlyPnLPct: this.calcPeriodPnL(trades, 30),
      totalROI: ((capital - this.initialCapital) / this.initialCapital) * 100,
      sharpeRatio: this.calcSharpe(trades.slice(-30)),
      winStreak,
      lossStreak,
      avgWinR:
        wins.reduce((s, t) => s + (t.realizedPnLR ?? 0), 0) / (wins.length || 1),
      avgLossR:
        losses.reduce((s, t) => s + (t.realizedPnLR ?? 0), 0) / (losses.length || 1),
      profitFactor:
        grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0,
      recoveryFactor:
        maxDrawdown > 0
          ? (capital - this.initialCapital) / (peak * maxDrawdown)
          : 0,
      equityCurve: curve,
    };
  }

  getAggressionLevel(): AggressionLevel {
    const m = this.getMetrics();

    if (m.drawdownPct > 35) return 'SUSPENDED';
    if (m.drawdownPct > 25 || m.weeklyPnLPct < -30) return 'MINIMAL';
    if (m.drawdownPct > 18 || m.lossStreak >= 3) return 'REDUCED';

    if (
      m.drawdownPct < 5 &&
      m.profitFactor > 1.8 &&
      m.totalROI > 0 &&
      m.currentCapital >= m.peakCapital * 0.98
    ) {
      return 'MAXIMUM';
    }

    return 'NORMAL';
  }

  getSizeMultiplier(): number {
    const level = this.getAggressionLevel();
    const multipliers: Record<AggressionLevel, number> = {
      MAXIMUM: 1.5,
      NORMAL: 1.0,
      REDUCED: 0.5,
      MINIMAL: 0.25,
      SUSPENDED: 0.0,
    };
    return multipliers[level];
  }

  private calcPeriodPnL(trades: JournalEntry[], days: number): number {
    const cutoff = new Date(Date.now() - days * 86400000);
    const recent = trades.filter((t) => new Date(t.entryTimestamp) > cutoff);
    return recent.reduce((s, t) => s + (t.realizedPnLUSD ?? 0), 0);
  }

  private calcSharpe(trades: JournalEntry[]): number {
    if (trades.length < 5) return 0;
    const returns = trades.map((t) => t.realizedPnLR ?? 0);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    return stdDev > 0 ? mean / stdDev : 0;
  }
}
