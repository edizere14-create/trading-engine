import fs from 'fs';
import path from 'path';
import { TradeRecord, PaperGateStatus, EdgeName } from '../core/types';
import { logger } from '../core/logger';

export interface PaperTradeSummary {
  totalTrades: number;
  winRate: number;
  avgWinnerMultiple: number;
  avgLoserMultiple: number;
  bestTrade: { id: string; multiple: number; tokenCA: string } | null;
  worstTrade: { id: string; multiple: number; tokenCA: string } | null;
  mostReliableEdge: { edge: EdgeName; winRate: number; count: number } | null;
}

export class PaperTradeGate {
  readonly MINIMUM_TRADES = 50;
  readonly MAX_WP_CALIBRATION_ERROR = 0.15;
  private trades: TradeRecord[] = [];
  private filePath: string;

  private constructor(trades: TradeRecord[], filePath: string) {
    this.trades = trades;
    this.filePath = filePath;
  }

  static async load(filePath: string): Promise<PaperTradeGate> {
    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
      logger.warn('paperTrades.json not found — creating empty file', { path: resolved });
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(resolved, '[]', 'utf-8');
      return new PaperTradeGate([], resolved);
    }

    const raw = fs.readFileSync(resolved, 'utf-8');
    const json = JSON.parse(raw);
    const parsed: TradeRecord[] = Array.isArray(json) ? json : (json.trades ?? []);
    logger.info('Paper trades loaded', { count: parsed.length, path: resolved });
    return new PaperTradeGate(parsed, resolved);
  }

  addTrade(trade: TradeRecord): void {
    if (trade.mode !== 'PAPER') {
      throw new Error('Only PAPER mode trades allowed before gate opens');
    }

    this.trades.push(trade);
    this.saveToDisk();

    logger.info('Paper trade recorded', {
      id: trade.id,
      tokenCA: trade.tokenCA,
      outcome: trade.outcome,
      multiple: trade.realizedMultiple,
      predictedWP: trade.predictedWP,
      predictedEV: trade.predictedEV,
      totalScore: trade.signal.totalScore,
      edgesFired: trade.edgesFired,
    });
  }

  getStatus(): PaperGateStatus {
    const completed = this.trades.filter((t) => t.outcome !== undefined);
    const wins = completed.filter((t) => t.outcome === 'WIN').length;
    const actualWinRate = completed.length > 0 ? wins / completed.length : 0;
    const predictedWinRate =
      completed.length > 0
        ? completed.reduce((s, t) => s + t.predictedWP, 0) / completed.length
        : 0;

    // Mean absolute error between predicted and actual WP
    const wpCalibrationAccuracy =
      completed.length > 0
        ? completed.reduce((s, t) => {
            const actual = t.actualWP ?? (t.outcome === 'WIN' ? 1 : 0);
            return s + Math.abs(t.predictedWP - actual);
          }, 0) / completed.length
        : 1; // worst case if no data

    const actualEV =
      completed.length > 0
        ? completed.reduce((s, t) => s + (t.realizedMultiple ?? 0), 0) / completed.length - 1
        : -1;

    const blockedReasons: string[] = [];

    if (completed.length < this.MINIMUM_TRADES) {
      blockedReasons.push(
        `Need ${this.MINIMUM_TRADES - completed.length} more trades (${completed.length}/${this.MINIMUM_TRADES})`
      );
    }

    if (wpCalibrationAccuracy > this.MAX_WP_CALIBRATION_ERROR) {
      blockedReasons.push(
        `WP calibration off by ${(wpCalibrationAccuracy * 100).toFixed(1)}% — retrain model (max ${this.MAX_WP_CALIBRATION_ERROR * 100}%)`
      );
    }

    if (actualEV <= 0) {
      blockedReasons.push(
        `Negative EV across paper trades: ${actualEV.toFixed(3)} — strategy not profitable`
      );
    }

    return {
      completedTrades: completed.length,
      requiredTrades: this.MINIMUM_TRADES,
      wpCalibrationAccuracy,
      actualEV,
      actualWinRate,
      predictedWinRate,
      gateUnlocked: blockedReasons.length === 0,
      blockedReasons,
    };
  }

  assertLiveCapitalAllowed(): void {
    const status = this.getStatus();
    if (!status.gateUnlocked) {
      throw new Error(
        `LIVE_CAPITAL_LOCKED:\n${status.blockedReasons.map((r) => `  - ${r}`).join('\n')}`
      );
    }
  }

  getSummaryReport(): PaperTradeSummary {
    const completed = this.trades.filter((t) => t.outcome !== undefined);

    if (completed.length === 0) {
      return {
        totalTrades: 0,
        winRate: 0,
        avgWinnerMultiple: 0,
        avgLoserMultiple: 0,
        bestTrade: null,
        worstTrade: null,
        mostReliableEdge: null,
      };
    }

    const wins = completed.filter((t) => t.outcome === 'WIN');
    const losses = completed.filter((t) => t.outcome === 'LOSS');

    const avgWinnerMultiple =
      wins.length > 0
        ? wins.reduce((s, t) => s + (t.realizedMultiple ?? 0), 0) / wins.length
        : 0;

    const avgLoserMultiple =
      losses.length > 0
        ? losses.reduce((s, t) => s + (t.realizedMultiple ?? 0), 0) / losses.length
        : 0;

    // Best and worst by realizedMultiple
    const sorted = [...completed]
      .filter((t) => t.realizedMultiple !== undefined)
      .sort((a, b) => (b.realizedMultiple ?? 0) - (a.realizedMultiple ?? 0));

    const bestTrade = sorted.length > 0
      ? { id: sorted[0].id, multiple: sorted[0].realizedMultiple ?? 0, tokenCA: sorted[0].tokenCA }
      : null;

    const worstTrade = sorted.length > 0
      ? {
          id: sorted[sorted.length - 1].id,
          multiple: sorted[sorted.length - 1].realizedMultiple ?? 0,
          tokenCA: sorted[sorted.length - 1].tokenCA,
        }
      : null;

    // Most reliable edge by win rate (min 5 samples)
    const edgeMap = new Map<EdgeName, { wins: number; total: number }>();
    for (const trade of completed) {
      for (const edge of trade.edgesFired) {
        const entry = edgeMap.get(edge) ?? { wins: 0, total: 0 };
        entry.total++;
        if (trade.outcome === 'WIN') entry.wins++;
        edgeMap.set(edge, entry);
      }
    }

    let mostReliableEdge: PaperTradeSummary['mostReliableEdge'] = null;
    let bestEdgeWinRate = 0;
    for (const [edge, stats] of edgeMap) {
      if (stats.total < 5) continue;
      const wr = stats.wins / stats.total;
      if (wr > bestEdgeWinRate) {
        bestEdgeWinRate = wr;
        mostReliableEdge = { edge, winRate: wr, count: stats.total };
      }
    }

    return {
      totalTrades: completed.length,
      winRate: wins.length / completed.length,
      avgWinnerMultiple,
      avgLoserMultiple,
      bestTrade,
      worstTrade,
      mostReliableEdge,
    };
  }

  private saveToDisk(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.trades, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2), 'utf-8');
  }
}
