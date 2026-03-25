import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const PAPER_TRADES_PATH = path.resolve(process.cwd(), 'data', 'paperTrades.json');

export async function GET() {
  try {
    const raw = fs.readFileSync(PAPER_TRADES_PATH, 'utf-8');
    const allTrades = JSON.parse(raw) as Record<string, unknown>[];

    // Filter to only executed trades (not SKIPs), sorted newest first
    const trades = allTrades
      .filter((t) => t.decision !== 'SKIP' && t.outcome !== 'AVOIDED' && t.outcome !== 'AVOIDED_RUG')
      .reverse();

    return NextResponse.json({ trades });
  } catch (err) {
    return NextResponse.json({ trades: [], error: String(err) });
  }
}
