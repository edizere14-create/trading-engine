export interface EquityMetrics {
  currentCapital: number;
  peakCapital: number;
  drawdownPct: number;
  drawdownUSD: number;
  dailyPnLPct: number;
  weeklyPnLPct: number;
  monthlyPnLPct: number;
  totalROI: number;
  sharpeRatio: number;
  winStreak: number;
  lossStreak: number;
  avgWinR: number;
  avgLossR: number;
  profitFactor: number;
  recoveryFactor: number;
  equityCurve: number[];
}
