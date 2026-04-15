import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const DATA_DIR = process.env.DATA_DIR ?? './data';

interface FactorStat {
  factor: string;
  winRate: number;
  lossRate: number;
  sampleSize: number;
  avgMultiple: number;
  ev: number;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function hasFactor(trade: Record<string, unknown>, factor: string): boolean {
  const entryLiquiditySOL = toNumber(trade.entryLiquiditySOL) ?? 0;
  const smartWalletCount = toNumber(trade.entrySmartWalletCount) ?? 0;
  const deployerTier = String(trade.deployerTier ?? '').toUpperCase();
  const marketState = String(trade.entryMarketState ?? '').toUpperCase();
  const regime = String(trade.entryRegime ?? '').toUpperCase();
  const signalTimingEdge = toNumber(trade.signalTimingEdge) ?? 0;
  const signalManipulationRisk = toNumber(trade.signalManipulationRisk) ?? 0;
  const signalCoordinationStrength = toNumber(trade.signalCoordinationStrength) ?? 0;
  const sniperBlock0Pct = toNumber(trade.sniperBlock0Pct) ?? 1;
  const buyClusterFrequency = toNumber(trade.buyClusterFrequency) ?? 0;
  const volumeSpikeSlope = toNumber(trade.volumeSpikeSlope) ?? 0;
  const predictedEV = toNumber(trade.predictedEV) ?? 0;
  const signalConfidence = toNumber(trade.signalConfidence) ?? 0;

  switch (factor) {
    case 'liqAbove60k':
      return entryLiquiditySOL > 60;
    case 'liqAbove100k':
      return entryLiquiditySOL > 100;
    case 'smartWallets3Plus':
      return smartWalletCount >= 3;
    case 'smartWallets5Plus':
      return smartWalletCount >= 5;
    case 'deployerSOrA':
      return deployerTier === 'S' || deployerTier === 'A';
    case 'deployerS':
      return deployerTier === 'S';
    case 'marketHot':
      return marketState === 'HOT';
    case 'regimeAggressive':
      return regime === 'AGGRESSIVE' || regime === 'RISK_ON';
    case 'timingEdgeHigh':
      return signalTimingEdge > 7;
    case 'manipRiskSafe':
      return signalManipulationRisk > 7;
    case 'coordinationHigh':
      return signalCoordinationStrength > 6;
    case 'sniperClean':
      return sniperBlock0Pct < 0.05;
    case 'holderVelocityFast':
      return buyClusterFrequency > 2;
    case 'volumeSpikeStrong':
      return volumeSpikeSlope > 2.1;
    case 'evAbove1R':
      return predictedEV > 1.0;
    case 'evAbove2R':
      return predictedEV > 2.0;
    case 'confidenceHigh':
      return signalConfidence > 0.7;
    default:
      return false;
  }
}

const FACTORS = [
  'liqAbove60k', 'liqAbove100k', 'smartWallets3Plus', 'smartWallets5Plus',
  'deployerSOrA', 'deployerS', 'marketHot', 'regimeAggressive',
  'timingEdgeHigh', 'manipRiskSafe', 'coordinationHigh', 'sniperClean',
  'holderVelocityFast', 'volumeSpikeStrong', 'evAbove1R', 'evAbove2R',
  'confidenceHigh',
];

export async function GET() {
  const ptPath = path.resolve(process.cwd(), DATA_DIR, 'paperTrades.json');

  try {
    const raw = fs.readFileSync(ptPath, 'utf-8');
    const allTrades: Record<string, unknown>[] = JSON.parse(raw);

    // Only analyse completed trades (have an outcome)
    const trades = allTrades.filter(
      (t) => t.outcome === 'WIN' || t.outcome === 'LOSS' || t.outcome === 'BREAKEVEN',
    );

    // Flatten signal.* sub-object into top-level fields expected by hasFactor()
    const flat: Record<string, unknown>[] = trades.map((t) => {
      const sig = (t.signal ?? {}) as Record<string, unknown>;
      return {
        ...t,
        signalTimingEdge: t.signalTimingEdge ?? sig.timingEdge,
        signalManipulationRisk: t.signalManipulationRisk ?? sig.manipulationRisk,
        signalCoordinationStrength: t.signalCoordinationStrength ?? sig.coordinationStrength,
        signalConfidence: t.signalConfidence ?? sig.confidence,
        entryMarketState: t.entryMarketState ?? t.marketState,
        entryRegime: t.entryRegime ?? t.regime,
      } as Record<string, unknown>;
    });

    if (flat.length === 0) {
      const placeholders: FactorStat[] = FACTORS.map((f) => ({
        factor: f,
        winRate: 0,
        lossRate: 0,
        sampleSize: 0,
        avgMultiple: 0,
        ev: 0,
      }));
      return NextResponse.json({ factors: placeholders, tradesAnalyzed: 0 });
    }

    // Extract factor stats from completed trades
    const stats: FactorStat[] = [];

    for (const factor of FACTORS) {
      const matching = flat.filter((t) => hasFactor(t, factor));

      const wins = matching.filter((t) => t.outcome === 'WIN').length;
      const losses = matching.filter((t) => t.outcome === 'LOSS').length;
      const total = matching.length;

      const multiples = matching
        .map((t) => toNumber(t.realizedMultiple))
        .filter((m): m is number => m != null);

      const avgMult = multiples.length > 0
        ? multiples.reduce((a, b) => a + b, 0) / multiples.length
        : 0;

      stats.push({
        factor,
        winRate: total > 0 ? wins / total : 0,
        lossRate: total > 0 ? losses / total : 0,
        sampleSize: total,
        avgMultiple: avgMult,
        ev: avgMult - 1,
      });
    }

    // If no factor had enough data, show baseline signal quality for all closed trades.
    if (stats.every((s) => s.sampleSize === 0) && flat.length > 0) {
      const wins = flat.filter((t) => t.outcome === 'WIN').length;
      const losses = flat.filter((t) => t.outcome === 'LOSS').length;
      const multiples = flat
        .map((t) => toNumber(t.realizedMultiple))
        .filter((m): m is number => m != null);
      const avgMult = multiples.length > 0
        ? multiples.reduce((a, b) => a + b, 0) / multiples.length
        : 0;

      stats.push({
        factor: 'allClosedTrades',
        winRate: flat.length > 0 ? wins / flat.length : 0,
        lossRate: flat.length > 0 ? losses / flat.length : 0,
        sampleSize: flat.length,
        avgMultiple: avgMult,
        ev: avgMult - 1,
      });
    }

    return NextResponse.json({ factors: stats, tradesAnalyzed: flat.length });
  } catch (err) {
    const placeholders: FactorStat[] = FACTORS.map((f) => ({
      factor: f,
      winRate: 0,
      lossRate: 0,
      sampleSize: 0,
      avgMultiple: 0,
      ev: 0,
    }));
    return NextResponse.json({ factors: placeholders, tradesAnalyzed: 0, error: String(err) });
  }
}
