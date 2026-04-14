import { NextResponse } from 'next/server';
import initSqlJs from 'sql.js';
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
  const dbPath = path.resolve(process.cwd(), DATA_DIR, 'journal.db');

  try {
    const SQL = await initSqlJs();
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);
    const stmt = db.prepare("SELECT * FROM trades WHERE outcome IS NOT NULL");
    const trades: Record<string, unknown>[] = [];
    while (stmt.step()) {
      trades.push(stmt.getAsObject() as Record<string, unknown>);
    }
    stmt.free();
    db.close();

    if (trades.length === 0) {
      // Return placeholder data when no trades exist yet
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
      const matching = trades.filter((t) => hasFactor(t, factor));

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

    // If legacy rows are missing factor fields, still show baseline signal quality.
    if (stats.every((s) => s.sampleSize === 0) && trades.length > 0) {
      const wins = trades.filter((t) => t.outcome === 'WIN').length;
      const losses = trades.filter((t) => t.outcome === 'LOSS').length;
      const multiples = trades
        .map((t) => toNumber(t.realizedMultiple))
        .filter((m): m is number => m != null);
      const avgMult = multiples.length > 0
        ? multiples.reduce((a, b) => a + b, 0) / multiples.length
        : 0;

      stats.push({
        factor: 'allClosedTrades',
        winRate: trades.length > 0 ? wins / trades.length : 0,
        lossRate: trades.length > 0 ? losses / trades.length : 0,
        sampleSize: trades.length,
        avgMultiple: avgMult,
        ev: avgMult - 1,
      });
    }

    return NextResponse.json({ factors: stats, tradesAnalyzed: trades.length });
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
