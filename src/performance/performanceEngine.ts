import fs from 'fs';
import path from 'path';
import { TradeRecord, EdgeName, EdgePerformance } from '../core/types';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';

const ALL_EDGES: EdgeName[] = [
  'TIMING', 'DEPLOYER', 'ORGANIC_FLOW', 'MANIPULATION',
  'COORDINATION', 'KOL', 'TELEGRAM',
];

export class PerformanceEngine {
  private edgeStats: Map<EdgeName, EdgePerformance>;
  private tradeHistory: Map<EdgeName, TradeRecord[]>;
  private filePath: string;

  private readonly DISABLE_THRESHOLD_WIN_RATE = 0.35;
  private readonly DISABLE_THRESHOLD_ROI = -0.5;
  private readonly DISABLE_MIN_SAMPLES = 20;
  private readonly ROLLING_WINDOW = 20;

  private constructor(
    edgeStats: Map<EdgeName, EdgePerformance>,
    tradeHistory: Map<EdgeName, TradeRecord[]>,
    filePath: string
  ) {
    this.edgeStats = edgeStats;
    this.tradeHistory = tradeHistory;
    this.filePath = filePath;
  }

  static async load(filePath: string): Promise<PerformanceEngine> {
    const resolved = path.resolve(filePath);
    const edgeStats = new Map<EdgeName, EdgePerformance>();
    const tradeHistory = new Map<EdgeName, TradeRecord[]>();

    // Initialize all edges
    for (const edge of ALL_EDGES) {
      edgeStats.set(edge, defaultEdge(edge));
      tradeHistory.set(edge, []);
    }

    if (fs.existsSync(resolved)) {
      const raw = fs.readFileSync(resolved, 'utf-8');
      const parsed: EdgePerformance[] = JSON.parse(raw);
      for (const ep of parsed) {
        ep.lastUpdated = new Date(ep.lastUpdated);
        edgeStats.set(ep.edge, ep);
      }
      logger.info('Edge stats loaded', { path: resolved, edges: parsed.length });
    } else {
      logger.warn('edgeStats.json not found — starting fresh', { path: resolved });
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    return new PerformanceEngine(edgeStats, tradeHistory, resolved);
  }

  recordTrade(trade: TradeRecord): void {
    for (const edge of trade.edgesFired) {
      this.updateEdge(edge, trade);
    }
    this.saveToDisk();
  }

  private updateEdge(edge: EdgeName, trade: TradeRecord): void {
    const stats = this.edgeStats.get(edge) ?? defaultEdge(edge);
    const history = this.tradeHistory.get(edge) ?? [];

    history.push(trade);
    this.tradeHistory.set(edge, history);

    const isWin = trade.outcome === 'WIN';
    stats.totalFired++;
    if (isWin) stats.wins++;
    else stats.losses++;

    stats.winRate = stats.wins / stats.totalFired;
    stats.lastUpdated = new Date();

    // Avg win/loss multiples
    const winTrades = history.filter((t) => t.outcome === 'WIN' && t.realizedMultiple !== undefined);
    const lossTrades = history.filter((t) => t.outcome === 'LOSS' && t.realizedMultiple !== undefined);

    stats.avgWinMultiple =
      winTrades.length > 0
        ? winTrades.reduce((s, t) => s + (t.realizedMultiple ?? 0), 0) / winTrades.length
        : 0;

    stats.avgLossMultiple =
      lossTrades.length > 0
        ? lossTrades.reduce((s, t) => s + (t.realizedMultiple ?? 0), 0) / lossTrades.length
        : 0;

    // Rolling ROI: last ROLLING_WINDOW trades
    const recentTrades = history.slice(-this.ROLLING_WINDOW);
    stats.rollingROI =
      recentTrades.length > 0
        ? recentTrades.reduce((s, t) => s + ((t.realizedMultiple ?? 1) - 1), 0) / recentTrades.length
        : 0;

    // Auto-disable check
    if (
      stats.totalFired >= this.DISABLE_MIN_SAMPLES &&
      stats.isEnabled &&
      (stats.winRate < this.DISABLE_THRESHOLD_WIN_RATE || stats.rollingROI < this.DISABLE_THRESHOLD_ROI)
    ) {
      stats.isEnabled = false;
      stats.disabledReason =
        stats.winRate < this.DISABLE_THRESHOLD_WIN_RATE
          ? `Win rate ${(stats.winRate * 100).toFixed(1)}% below ${this.DISABLE_THRESHOLD_WIN_RATE * 100}% threshold`
          : `Rolling ROI ${stats.rollingROI.toFixed(3)} below ${this.DISABLE_THRESHOLD_ROI} threshold`;

      bus.emit('edge:disabled', stats);
      logger.warn('Edge auto-disabled', {
        edge,
        winRate: stats.winRate.toFixed(3),
        rollingROI: stats.rollingROI.toFixed(3),
        totalFired: stats.totalFired,
        reason: stats.disabledReason,
      });
    }

    this.edgeStats.set(edge, stats);
  }

  isEdgeEnabled(edge: EdgeName): boolean {
    return this.edgeStats.get(edge)?.isEnabled ?? true;
  }

  getReport(): EdgePerformance[] {
    return Array.from(this.edgeStats.values())
      .sort((a, b) => b.rollingROI - a.rollingROI);
  }

  getEdgeStats(edge: EdgeName): EdgePerformance | null {
    return this.edgeStats.get(edge) ?? null;
  }

  resetEdge(edge: EdgeName): void {
    const stats = defaultEdge(edge);
    this.edgeStats.set(edge, stats);
    this.tradeHistory.set(edge, []);
    this.saveToDisk();
    logger.info('Edge reset', { edge });
  }

  private saveToDisk(): void {
    const data = Array.from(this.edgeStats.values());
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

function defaultEdge(edge: EdgeName): EdgePerformance {
  return {
    edge,
    totalFired: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    avgWinMultiple: 0,
    avgLossMultiple: 0,
    rollingROI: 0,
    isEnabled: true,
    lastUpdated: new Date(),
  };
}
