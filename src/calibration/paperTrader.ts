import fs from 'fs';
import path from 'path';
import { TradeRecord, PaperGateStatus, EdgeName } from '../core/types';
import { logger } from '../core/logger';
import { isProbeTrade } from '../risk/probePolicy';
import { evaluateWinProbability, MIN_BUCKET_TRADES } from './wpMetrics';

export interface PaperTradeSummary {
  totalTrades: number;
  winRate: number;
  avgWinnerMultiple: number;
  avgLoserMultiple: number;
  bestTrade: { id: string; multiple: number; tokenCA: string } | null;
  worstTrade: { id: string; multiple: number; tokenCA: string } | null;
  mostReliableEdge: { edge: EdgeName; winRate: number; count: number } | null;
}

export interface PaperTradeRuntimeMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  realizedMultipleAvg: number;
  averageScoreAtEntry: number;
}

export class PaperTradeGate {
  readonly MINIMUM_TRADES = 50;
  readonly MAX_WP_CALIBRATION_ERROR = 0.15;
  readonly MIN_WP_CLASS_SAMPLES = 10;   // wins and losses each needed before the AUC means anything
  readonly MIN_CALIBRATION_BUCKETS = 3; // probability buckets (of 10) that must have enough trades
  readonly MIN_WP_AUC_LOWER_BOUND = 0.5; // the AUC's 95% lower bound must be above this: better than random with confidence
  private trades: TradeRecord[] = [];
  private filePath: string;
  private minWpAuc: number;

  private constructor(trades: TradeRecord[], filePath: string, minWpAuc: number) {
    this.trades = trades;
    this.filePath = filePath;
    this.minWpAuc = minWpAuc;
  }

  /** options.minAuc is the required AUC (WP_CALIBRATION_AUC_MIN); defaults to 0.65. */
  static async load(filePath: string, options: { minAuc?: number } = {}): Promise<PaperTradeGate> {
    const minAuc = options.minAuc ?? 0.65;
    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
      logger.warn('paperTrades.json not found — creating empty file', { path: resolved });
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(resolved, '[]', 'utf-8');
      return new PaperTradeGate([], resolved, minAuc);
    }

    const raw = fs.readFileSync(resolved, 'utf-8');
    const json = JSON.parse(raw);
    const parsed: TradeRecord[] = Array.isArray(json) ? json : (json.trades ?? []);
    logger.info('Paper trades loaded', {
      count: parsed.length,
      probesExcludedFromStats: parsed.filter(isProbeTrade).length,
      path: resolved,
    });
    return new PaperTradeGate(parsed, resolved, minAuc);
  }

  /** Completed trades that count toward the gate: probes are recorded but not counted. */
  private countable(): TradeRecord[] {
    return this.trades.filter((t) => t.outcome !== undefined && !isProbeTrade(t));
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
    const completed = this.countable();
    const wins = completed.filter((t) => t.outcome === 'WIN').length;
    const actualWinRate = completed.length > 0 ? wins / completed.length : 0;
    const predictedWinRate =
      completed.length > 0
        ? completed.reduce((s, t) => s + t.predictedWP, 0) / completed.length
        : 0;

    // Legacy mean absolute error between predicted WP and the 0/1 outcome. For binary
    // outcomes even a perfectly calibrated model scores about 2p(1-p) (0.5 at p = 0.5), so
    // it can't meet a 15% limit and no longer gates; it is kept for continuity.
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

    const wp = evaluateWinProbability(
      completed.map((t) => ({ predictedWP: t.predictedWP, won: t.outcome === 'WIN' }))
    );

    const blockedReasons: string[] = [];

    if (completed.length < this.MINIMUM_TRADES) {
      blockedReasons.push(
        `Need ${this.MINIMUM_TRADES - completed.length} more trades (${completed.length}/${this.MINIMUM_TRADES})`
      );
    }

    // Win-probability quality: needs enough of both outcomes, then calibration AND discrimination
    if (wp.wins < this.MIN_WP_CLASS_SAMPLES || wp.losses < this.MIN_WP_CLASS_SAMPLES) {
      blockedReasons.push(
        `WP check needs at least ${this.MIN_WP_CLASS_SAMPLES} wins and ${this.MIN_WP_CLASS_SAMPLES} losses (have ${wp.wins} wins / ${wp.losses} losses)`
      );
    } else {
      if (wp.calibrationError === null || wp.calibrationBuckets < this.MIN_CALIBRATION_BUCKETS) {
        blockedReasons.push(
          `WP calibration can't be measured yet: only ${wp.calibrationBuckets} of 10 probability buckets have ${MIN_BUCKET_TRADES}+ trades (need ${this.MIN_CALIBRATION_BUCKETS})`
        );
      } else if (wp.calibrationError > this.MAX_WP_CALIBRATION_ERROR) {
        blockedReasons.push(
          `WP calibration gap ${(wp.calibrationError * 100).toFixed(1)}% exceeds ${this.MAX_WP_CALIBRATION_ERROR * 100}% — predicted probabilities don't match outcomes; retrain model`
        );
      }
      if (wp.auc === null || wp.auc < this.minWpAuc) {
        blockedReasons.push(
          `WP discrimination (AUC) ${wp.auc === null ? 'n/a' : wp.auc.toFixed(3)} is below ${this.minWpAuc.toFixed(2)} — predictions don't separate winners from losers`
        );
      }
      // Margin rule: the point estimate alone can be luck on a small sample, so the lower end
      // of its 95% interval (AUC - 1.96 x standard error) must also clear 0.5.
      if (wp.aucLower95 === null || wp.aucLower95 <= this.MIN_WP_AUC_LOWER_BOUND) {
        blockedReasons.push(
          `WP discrimination isn't reliably better than random: AUC ${wp.auc === null ? 'n/a' : wp.auc.toFixed(3)}, 95% lower bound ${wp.aucLower95 === null ? 'n/a' : wp.aucLower95.toFixed(3)} (must be above ${this.MIN_WP_AUC_LOWER_BOUND.toFixed(2)})`
        );
      }
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
      wpCalibrationError: wp.calibrationError,
      wpCalibrationBuckets: wp.calibrationBuckets,
      wpAuc: wp.auc,
      wpAucStdErr: wp.aucStdErr,
      wpAucLower95: wp.aucLower95,
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
    const completed = this.countable();

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

  getRuntimeMetrics(): PaperTradeRuntimeMetrics {
    const completed = this.countable();
    const wins = completed.filter((t) => t.outcome === 'WIN').length;
    const losses = completed.filter((t) => t.outcome === 'LOSS').length;
    const breakeven = completed.filter((t) => t.outcome === 'BREAKEVEN').length;

    const withMultiple = completed.filter((t) => typeof t.realizedMultiple === 'number');
    const realizedMultipleAvg = withMultiple.length > 0
      ? withMultiple.reduce((sum, t) => sum + (t.realizedMultiple ?? 0), 0) / withMultiple.length
      : 0;

    const withScore = completed.filter((t) => typeof t.signal?.totalScore === 'number');
    const averageScoreAtEntry = withScore.length > 0
      ? withScore.reduce((sum, t) => sum + (t.signal?.totalScore ?? 0), 0) / withScore.length
      : 0;

    return {
      totalTrades: completed.length,
      wins,
      losses,
      breakeven,
      realizedMultipleAvg,
      averageScoreAtEntry,
    };
  }

  private saveToDisk(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.trades, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2), 'utf-8');
  }
}
