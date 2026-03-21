import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

interface StatusData {
  mode: string;
  wallets: number;
  deployers: number;
  paperTrades: number;
  paperTradesTarget: number;
  gate: string;
  aggression: string;
  equityDD: string;
  edgesEnabled: string;
  journalCount: number;
}

export async function GET() {
  const ROOT = 'C:\\trading-engine';
  const logPath = path.join(ROOT, 'logs', 'engine.log');

  const status: StatusData = {
    mode: 'PAPER',
    wallets: 0,
    deployers: 0,
    paperTrades: 0,
    paperTradesTarget: 50,
    gate: 'LOCKED',
    aggression: 'NORMAL',
    equityDD: '0.0%',
    edgesEnabled: '7/7',
    journalCount: 0,
  };

  // Read wallet/deployer counts directly from data files
  try {
    const wallets = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'wallets.json'), 'utf-8'));
    status.wallets = Array.isArray(wallets) ? wallets.length : 0;
  } catch { /* file missing */ }

  try {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'deployers.json'), 'utf-8'));
    status.deployers = Array.isArray(data.deployers) ? data.deployers.length : 0;
  } catch { /* file missing */ }

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');

    // Parse from bottom up to get latest values
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      try {
        const entry = JSON.parse(line);
        const msg: string = entry.message ?? '';

        if (msg.includes('MODE:')) {
          status.mode = msg.replace(/.*MODE:\s*/, '').trim();
        } else if (msg.includes('PAPER TRADES:')) {
          const match = msg.match(/(\d+)\/(\d+)/);
          if (match) {
            status.paperTrades = parseInt(match[1], 10);
            status.paperTradesTarget = parseInt(match[2], 10);
          }
        } else if (msg.includes('GATE:')) {
          status.gate = msg.replace(/.*GATE:\s*/, '').trim();
        } else if (msg.includes('AGGRESSION:')) {
          status.aggression = msg.replace(/.*AGGRESSION:\s*/, '').trim();
        } else if (msg.includes('EQUITY DD:')) {
          status.equityDD = msg.replace(/.*EQUITY DD:\s*/, '').trim();
        } else if (msg.includes('EDGES ENABLED:')) {
          status.edgesEnabled = msg.replace(/.*EDGES ENABLED:\s*/, '').trim();
        } else if (msg.includes('JOURNAL:')) {
          const jMatch = msg.match(/(\d+)\s*trades/);
          if (jMatch) status.journalCount = parseInt(jMatch[1], 10);
        }

        // Stop once we find a complete status banner
        if (status.mode !== 'PAPER' || status.gate !== 'LOCKED') {
          const bannerComplete = lines.slice(Math.max(0, i - 15), i + 1)
            .some((l) => l.includes('STATUS: ACTIVE'));
          if (bannerComplete) break;
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  } catch {
    // Log file doesn't exist yet
  }

  return NextResponse.json(status);
}
