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
      const matching = trades.filter((t) => {
        const ef = t.edgesFired;
        if (typeof ef === 'string') {
          try {
            const arr = JSON.parse(ef) as string[];
            return arr.includes(factor);
          } catch { return false; }
        }
        return false;
      });

      const wins = matching.filter((t) => t.outcome === 'WIN').length;
      const losses = matching.filter((t) => t.outcome === 'LOSS').length;
      const total = matching.length;

      const multiples = matching
        .map((t) => (typeof t.realizedMultiple === 'number' ? t.realizedMultiple : 1))
        .filter((m) => !isNaN(m));

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
