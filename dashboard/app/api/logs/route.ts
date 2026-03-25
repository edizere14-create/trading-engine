import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  reason?: string;
  haltCount?: number;
  count?: number;
  tokenCA?: string;
  deployer?: string;
  liqSOL?: number;
  program?: string;
  totalScore?: number;
  wallet?: string;
  action?: string;
  amountSOL?: number;
}

export async function GET() {
  const logPath = path.resolve(process.cwd(), 'logs', 'engine.log');
  const autonomousOnly = (process.env.AUTONOMOUS_ONLY ?? 'true').toLowerCase() === 'true';
  const heartbeatMessages = ['Health snapshot', 'Execution quality snapshot'];

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');

    const entries: LogEntry[] = [];
    const haltDedup = new Map<string, { timestampMs: number; index: number }>();
    const eventDedup = new Map<string, { timestampMs: number; index: number }>();
    const relevant = [
      'Pool detected',
      'New pool detected',
      'Signal ready',
      'Risk decision',
      'Trade decision',
      'Paper trade recorded',
      'trade:opened',
      'trade:closed',
      'Autonomous signal emitted',
      'Autonomous execution',
      'System health changed',
      ...heartbeatMessages,
      'SYSTEM HALT',
    ];
    if (!autonomousOnly) {
      relevant.push('Smart wallet swap');
    }

    // Read last 200 lines for recent activity
    const recentLines = lines.slice(-200);

    for (const line of recentLines) {
      try {
        const parsed = JSON.parse(line);
        const msg: string = parsed.message ?? '';
        const timestampMs = Date.parse(parsed.timestamp ?? '') || Date.now();

        if (!relevant.some((r) => msg.includes(r))) continue;

        if (msg === 'SYSTEM HALT') {
          const reason = typeof parsed.reason === 'string' ? parsed.reason : 'unknown';
          const key = reason;
          const prev = haltDedup.get(key);
          if (prev && timestampMs - prev.timestampMs <= 60_000) {
            const prior = entries[prev.index];
            prior.haltCount = (prior.haltCount ?? 1) + 1;
            haltDedup.set(key, { timestampMs, index: prev.index });
            continue;
          }
          entries.push({
            timestamp: parsed.timestamp,
            level: parsed.level,
            message: `SYSTEM HALT: ${reason}`,
            reason,
            haltCount: 1,
          });
          haltDedup.set(key, { timestampMs, index: entries.length - 1 });
          continue;
        }

        const eventKey = `${msg}|${parsed.tokenCA ?? ''}|${parsed.wallet ?? ''}|${parsed.action ?? ''}`;
        const prior = eventDedup.get(eventKey);
        if (prior && timestampMs - prior.timestampMs <= 10_000) {
          const priorEntry = entries[prior.index];
          priorEntry.count = (priorEntry.count ?? 1) + 1;
          eventDedup.set(eventKey, { timestampMs, index: prior.index });
          continue;
        }

        entries.push({
          timestamp: parsed.timestamp,
          level: parsed.level,
          message: msg,
          count: 1,
          tokenCA: parsed.tokenCA,
          deployer: parsed.deployer,
          liqSOL: parsed.liqSOL,
          program: parsed.program,
          totalScore: parsed.total ?? parsed.totalScore,
          wallet: parsed.wallet,
          action: parsed.action,
          amountSOL: parsed.amountSOL,
        });
        eventDedup.set(eventKey, { timestampMs, index: entries.length - 1 });
      } catch {
        // Skip non-JSON lines
      }
    }

    // In autonomous-only mode, wallet spam can push heartbeat entries outside the recent window.
    // Backfill latest heartbeat snapshots so the live feed still shows engine liveness.
    if (entries.length === 0 && autonomousOnly) {
      const needed = new Set(heartbeatMessages);
      for (let i = lines.length - 1; i >= 0 && needed.size > 0; i--) {
        const line = lines[i];
        try {
          const parsed = JSON.parse(line);
          const msg: string = parsed.message ?? '';
          if (![...needed].some((m) => msg.includes(m))) continue;

          entries.push({
            timestamp: parsed.timestamp,
            level: parsed.level,
            message: msg,
          });
          for (const m of [...needed]) {
            if (msg.includes(m)) needed.delete(m);
          }
        } catch {
          // Skip non-JSON lines
        }
      }
      entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    }

    return NextResponse.json({ logs: entries.slice(-50) });
  } catch {
    return NextResponse.json({ logs: [] });
  }
}
