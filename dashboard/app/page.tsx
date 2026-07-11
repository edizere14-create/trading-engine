'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

/* ── Types ─────────────────────────────────────────────────────── */

interface Status {
  mode: string;
  wallets: number;
  deployers: number;
  paperTrades: number;
  paperTradesTarget: number;
  executedTrades?: number;
  gate: string;
  aggression: string;
  equityDD: string;
  edgesEnabled: string;
  journalCount: number;
  lastHaltReason?: string | null;
  lastHaltAt?: string | null;
  haltCount10m?: number;
  dexHitRatePct?: number | null;
  jupiterHitRatePct?: number | null;
  cacheKeepaliveRatePct?: number | null;
}

interface Trade {
  id?: number;
  tokenCA: string;
  entryTimestamp: string;
  exitTimestamp?: string;
  outcome?: string;
  entryPriceSOL?: number;
  exitPriceSOL?: number;
  realizedMultiple?: number;
  edgesFired?: string;
  deployerTier?: string;
  initialLiquiditySOL?: number;
  exitMode?: string;
  priceBasisInvalid?: boolean;
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  reason?: string;
  haltCount?: number;
  count?: number;
  tokenCA?: string;
  liqSOL?: number;
  totalScore?: number;
}

interface FactorStat {
  factor: string;
  winRate: number;
  sampleSize: number;
  ev: number;
}

/* ── Dashboard ─────────────────────────────────────────────────── */

export default function Dashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [factors, setFactors] = useState<FactorStat[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const fetchAll = useCallback(async () => {
    const [sRes, jRes, lRes, fRes] = await Promise.all([
      fetch('/api/status').then((r) => r.json()).catch(() => ({})),
      fetch('/api/journal').then((r) => r.json()).catch(() => ({ trades: [] })),
      fetch('/api/logs').then((r) => r.json()).catch(() => ({ logs: [] })),
      fetch('/api/factors').then((r) => r.json()).catch(() => ({ factors: [] })),
    ]);
    setStatus(sRes as Status);
    setTrades(jRes.trades ?? []);
    setLogs(lRes.logs ?? []);
    setFactors(fRes.factors ?? []);
    setLastRefresh(new Date());
  }, []);

  useEffect(() => {
    fetchAll();
    const iv = setInterval(fetchAll, 10_000);
    return () => clearInterval(iv);
  }, [fetchAll]);

  return (
    <main className="min-h-screen p-4 max-w-[1600px] mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-terminal-border pb-3">
        <h1 className="text-terminal-green text-xl font-bold glow-green tracking-wider">
          EDDYI TRADING ENGINE
        </h1>
        <span className="text-terminal-dim text-xs">
          Last refresh: {mounted ? lastRefresh.toLocaleTimeString() : ''} — auto 10s
        </span>
      </div>

      {/* Status Banner */}
      {status && <StatusBanner status={status} />}
      {status?.lastHaltReason && <HaltBanner status={status} />}

      {/* Section 6 — Soak-C Verdict */}
      <Section6Panel trades={trades} />

      {/* Two-column: Trades table + Live feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <TradesTable trades={trades} />
        </div>
        <div>
          <LiveFeed logs={logs} />
        </div>
      </div>

      {/* Factor Chart */}
      <FactorChart factors={factors} />
    </main>
  );
}

/* ── Status Banner ─────────────────────────────────────────────── */

function StatusBanner({ status }: { status: Status }) {
  const pct = status.paperTradesTarget > 0
    ? Math.round((status.paperTrades / status.paperTradesTarget) * 100)
    : 0;
  const executedTrades = status.executedTrades ?? status.paperTrades;
  const avoidedTrades = Math.max(0, status.paperTrades - executedTrades);
  const sourceMix = formatSourceMix(status);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-9 gap-2">
      <StatusCell label="MODE" value={status.mode} color="cyan" />
      <StatusCell label="WALLETS" value={String(status.wallets)} color="green" />
      <StatusCell label="DEPLOYERS" value={String(status.deployers)} color="green" />
      <div className="bg-terminal-surface border border-terminal-border rounded p-2">
        <div className="text-[10px] text-terminal-dim uppercase tracking-widest">Paper Trades</div>
        <div className="text-terminal-yellow text-sm font-bold">
          {status.paperTrades}/{status.paperTradesTarget}
        </div>
        <div className="w-full bg-terminal-border rounded-full h-1.5 mt-1">
          <div
            className="bg-terminal-yellow h-1.5 rounded-full transition-all"
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <div className="text-[10px] text-terminal-dim mt-1">
          Exec: {executedTrades} | Avoided: {avoidedTrades}
        </div>
      </div>
      <StatusCell label="GATE" value={status.gate}
        color={status.gate === 'LOCKED' ? 'red' : 'green'} />
      <StatusCell label="AGGRESSION" value={status.aggression}
        color={status.aggression === 'NORMAL' ? 'green' : 'yellow'} />
      <StatusCell label="EQUITY DD" value={status.equityDD} color="text" />
      <StatusCell label="EDGES" value={status.edgesEnabled} color="cyan" />
      <StatusCell label="PRICE SOURCES" value={sourceMix} color="text" />
    </div>
  );
}

function StatusCell({ label, value, color }: {
  label: string;
  value: string;
  color: 'green' | 'red' | 'yellow' | 'cyan' | 'text';
}) {
  const colorClass: Record<string, string> = {
    green: 'text-terminal-green',
    red: 'text-terminal-red',
    yellow: 'text-terminal-yellow',
    cyan: 'text-terminal-cyan',
    text: 'text-terminal-text',
  };

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded p-2">
      <div className="text-[10px] text-terminal-dim uppercase tracking-widest">{label}</div>
      <div className={`text-sm font-bold ${colorClass[color]}`}>{value}</div>
    </div>
  );
}

function HaltBanner({ status }: { status: Status }) {
  return (
    <div className="bg-terminal-surface border border-terminal-red rounded p-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-terminal-red font-bold tracking-wider">LAST HALT</span>
        <span className="text-terminal-dim">
          {status.lastHaltAt ? formatTime(status.lastHaltAt) : '--:--:--'}
        </span>
      </div>
      <div className="text-terminal-text text-xs mt-1">
        {status.lastHaltReason}
      </div>
      <div className="text-terminal-dim text-[10px] mt-1">
        recent 10m: {status.haltCount10m ?? 0}
      </div>
    </div>
  );
}

/* ── Section 6: Soak-C Verdict ────────────────────────────────────
 * Pre-registered rule: on ≥50 valid trades, PASS requires all of:
 *   win rate (RM≥1.05) ≥ 25%, top exit mode ≤ 50% of trades,
 *   avg multiple ≥ 1.05. Below 50 valid trades the verdict is PENDING.
 * ────────────────────────────────────────────────────────────────── */

const SOAK_C_MIN_SAMPLE = 50;
const SOAK_C_WIN_THRESHOLD = 1.05;
const SOAK_C_MIN_WIN_RATE = 0.25;
const SOAK_C_MAX_CONCENTRATION = 0.5;
const SOAK_C_MIN_AVG_MULTIPLE = 1.05;

interface Section6Result {
  validCount: number;
  sampleSizeOk: boolean;
  winRate: number;
  winRateOk: boolean;
  exitModeDist: { mode: string; count: number; pct: number }[];
  topExitModePct: number;
  concentrationOk: boolean;
  avgMultiple: number;
  avgMultipleOk: boolean;
  overallPass: boolean;
}

function computeSection6(trades: Trade[]): Section6Result {
  const valid = trades.filter((t) => t.priceBasisInvalid !== true && t.exitMode);
  const validCount = valid.length;
  const sampleSizeOk = validCount >= SOAK_C_MIN_SAMPLE;

  const wins = valid.filter((t) => (t.realizedMultiple ?? 0) >= SOAK_C_WIN_THRESHOLD).length;
  const winRate = validCount > 0 ? wins / validCount : 0;
  const winRateOk = winRate >= SOAK_C_MIN_WIN_RATE;

  const counts = new Map<string, number>();
  for (const t of valid) {
    const mode = t.exitMode as string;
    counts.set(mode, (counts.get(mode) ?? 0) + 1);
  }
  const exitModeDist = [...counts.entries()]
    .map(([mode, count]) => ({ mode, count, pct: validCount > 0 ? count / validCount : 0 }))
    .sort((a, b) => b.count - a.count);
  const topExitModePct = exitModeDist[0]?.pct ?? 0;
  const concentrationOk = topExitModePct <= SOAK_C_MAX_CONCENTRATION;

  const avgMultiple = validCount > 0
    ? valid.reduce((sum, t) => sum + (t.realizedMultiple ?? 0), 0) / validCount
    : 0;
  const avgMultipleOk = avgMultiple >= SOAK_C_MIN_AVG_MULTIPLE;

  return {
    validCount,
    sampleSizeOk,
    winRate,
    winRateOk,
    exitModeDist,
    topExitModePct,
    concentrationOk,
    avgMultiple,
    avgMultipleOk,
    overallPass: sampleSizeOk && winRateOk && concentrationOk && avgMultipleOk,
  };
}

function Section6Panel({ trades }: { trades: Trade[] }) {
  const r = computeSection6(trades);

  const verdict = !r.sampleSizeOk ? 'PENDING' : r.overallPass ? 'PASS' : 'FAIL';
  const verdictColor = verdict === 'PASS'
    ? 'text-terminal-green bg-terminal-green/10 border-terminal-green'
    : verdict === 'FAIL'
      ? 'text-terminal-red bg-terminal-red/10 border-terminal-red'
      : 'text-terminal-yellow bg-terminal-yellow/10 border-terminal-yellow';

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded">
      <div className="px-3 py-2 border-b border-terminal-border flex items-center justify-between">
        <span className="text-terminal-cyan text-xs font-bold tracking-wider">SOAK-C VERDICT</span>
        <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${verdictColor}`}>
          {verdict}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-3">
        <StatusCell
          label="SAMPLE"
          value={`${r.validCount}/${SOAK_C_MIN_SAMPLE}`}
          color={r.sampleSizeOk ? 'green' : 'yellow'}
        />
        <StatusCell
          label={`WIN RATE (≥${SOAK_C_WIN_THRESHOLD}x)`}
          value={`${(r.winRate * 100).toFixed(1)}%`}
          color={r.winRateOk ? 'green' : 'red'}
        />
        <StatusCell
          label="TOP EXIT MODE"
          value={`${r.exitModeDist[0]?.mode ?? '—'} ${(r.topExitModePct * 100).toFixed(0)}%`}
          color={r.concentrationOk ? 'green' : 'red'}
        />
        <StatusCell
          label="AVG MULTIPLE"
          value={`${r.avgMultiple.toFixed(3)}x`}
          color={r.avgMultipleOk ? 'green' : 'red'}
        />
      </div>
      {r.exitModeDist.length > 0 && (
        <div className="px-3 pb-3 flex flex-wrap gap-2">
          {r.exitModeDist.map((e) => (
            <span key={e.mode} className="text-[10px] text-terminal-dim">
              {e.mode}: <span className="text-terminal-text">{e.count}</span>{' '}
              ({(e.pct * 100).toFixed(0)}%)
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Trades Table ──────────────────────────────────────────────── */

function TradesTable({ trades }: { trades: Trade[] }) {
  return (
    <div className="bg-terminal-surface border border-terminal-border rounded">
      <div className="px-3 py-2 border-b border-terminal-border flex items-center justify-between">
        <span className="text-terminal-cyan text-xs font-bold tracking-wider">PAPER TRADES</span>
        <span className="text-terminal-dim text-[10px]">{trades.length} trades</span>
      </div>
      <div className="overflow-auto max-h-[400px]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-terminal-surface">
            <tr className="text-terminal-dim border-b border-terminal-border">
              <th className="text-left px-3 py-1.5">TOKEN</th>
              <th className="text-left px-3 py-1.5">ENTRY</th>
              <th className="text-left px-3 py-1.5">TIER</th>
              <th className="text-right px-3 py-1.5">LIQ SOL</th>
              <th className="text-right px-3 py-1.5">MULT</th>
              <th className="text-center px-3 py-1.5">OUTCOME</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-8 text-terminal-dim">
                  No trades yet — engine is collecting data
                </td>
              </tr>
            )}
            {trades.map((t, i) => (
              <tr
                key={t.id ?? i}
                className="border-b border-terminal-border/50 hover:bg-terminal-border/30 transition-colors"
              >
                <td className="px-3 py-1.5 text-terminal-text font-mono">
                  {t.tokenCA.slice(0, 8)}…
                </td>
                <td className="px-3 py-1.5 text-terminal-dim">
                  {formatTime(t.entryTimestamp)}
                </td>
                <td className="px-3 py-1.5">
                  <TierBadge tier={t.deployerTier} />
                </td>
                <td className="px-3 py-1.5 text-right text-terminal-text">
                  {t.initialLiquiditySOL?.toFixed(1) ?? '—'}
                </td>
                <td className={`px-3 py-1.5 text-right font-bold ${
                  (t.realizedMultiple ?? 1) >= 1 ? 'text-terminal-green' : 'text-terminal-red'
                }`}>
                  {t.realizedMultiple != null ? `${t.realizedMultiple.toFixed(2)}x` : '—'}
                </td>
                <td className="px-3 py-1.5 text-center">
                  <OutcomeBadge outcome={t.outcome} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TierBadge({ tier }: { tier?: string }) {
  if (!tier) return <span className="text-terminal-dim">—</span>;
  const colors: Record<string, string> = {
    S: 'text-terminal-yellow bg-terminal-yellow/10',
    A: 'text-terminal-cyan bg-terminal-cyan/10',
    B: 'text-terminal-text bg-terminal-text/10',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${colors[tier] ?? colors.B}`}>
      {tier}
    </span>
  );
}

function OutcomeBadge({ outcome }: { outcome?: string }) {
  if (!outcome) return <span className="text-terminal-dim text-[10px]">OPEN</span>;
  const isWin = outcome === 'WIN';
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
      isWin ? 'text-terminal-green bg-terminal-green/10' : 'text-terminal-red bg-terminal-red/10'
    }`}>
      {outcome}
    </span>
  );
}

/* ── Live Feed ─────────────────────────────────────────────────── */

function LiveFeed({ logs }: { logs: LogEntry[] }) {
  return (
    <div className="bg-terminal-surface border border-terminal-border rounded">
      <div className="px-3 py-2 border-b border-terminal-border flex items-center justify-between">
        <span className="text-terminal-green text-xs font-bold tracking-wider">LIVE FEED</span>
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-terminal-green opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-terminal-green" />
        </span>
      </div>
      <div className="overflow-auto max-h-[400px] p-2 space-y-1">
        {logs.length === 0 && (
          <div className="text-terminal-dim text-xs text-center py-8">
            Waiting for autonomous events…
          </div>
        )}
        {[...logs].reverse().map((log, i) => (
          <div key={i} className="text-[11px] leading-relaxed border-b border-terminal-border/30 pb-1">
            <span className="text-terminal-dim">{formatTime(log.timestamp)}</span>{' '}
            <LogIcon message={log.message} />{' '}
            <span className={getLogMessageClass(log.message)}>{truncMsg(log.message)}</span>
            {log.count && log.count > 1 && (
              <span className="text-terminal-dim ml-1">x{log.count}</span>
            )}
            {log.haltCount && log.haltCount > 1 && (
              <span className="text-terminal-red ml-1">x{log.haltCount}</span>
            )}
            {log.liqSOL != null && (
              <span className="text-terminal-cyan ml-1">{log.liqSOL.toFixed(0)} SOL</span>
            )}
            {log.totalScore != null && (
              <span className="text-terminal-yellow ml-1">score:{log.totalScore}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LogIcon({ message }: { message: string }) {
  if (message.includes('Price source mix')) {
    const severity = getPriceSourceSeverity(message);
    if (severity === 'alert') return <span className="text-terminal-red">▲</span>;
    if (severity === 'warn') return <span className="text-terminal-yellow">▲</span>;
    return <span className="text-terminal-cyan">▲</span>;
  }
  if (message.includes('SYSTEM HALT'))
    return <span className="text-terminal-red">!</span>;
  if (message.includes('Pool') || message.includes('pool'))
    return <span className="text-terminal-cyan">●</span>;
  if (message.includes('Signal'))
    return <span className="text-terminal-yellow">▶</span>;
  if (message.includes('trade'))
    return <span className="text-terminal-green">★</span>;
  if (message.includes('Risk'))
    return <span className="text-terminal-red">◆</span>;
  if (message.includes('swap') || message.includes('Swap'))
    return <span className="text-terminal-green">⇋</span>;
  return <span className="text-terminal-dim">·</span>;
}

/* ── Factor Chart ──────────────────────────────────────────────── */

function FactorChart({ factors }: { factors: FactorStat[] }) {
  const chartData = factors
    .filter((f) => f.sampleSize > 0)
    .sort((a, b) => b.ev - a.ev);

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded">
      <div className="px-3 py-2 border-b border-terminal-border flex items-center justify-between">
        <span className="text-terminal-yellow text-xs font-bold tracking-wider">FACTOR REPORT</span>
        <span className="text-terminal-dim text-[10px]">
          {chartData.length > 0 ? `${chartData.length} factors with data` : 'No trade data yet'}
        </span>
      </div>
      <div className="p-3">
        {chartData.length === 0 ? (
          <div className="text-terminal-dim text-xs text-center py-8">
            Factor analysis will appear after trades complete
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" />
              <XAxis
                dataKey="factor"
                tick={{ fontSize: 9, fill: '#555' }}
                angle={-45}
                textAnchor="end"
                interval={0}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#555' }}
                tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#111',
                  border: '1px solid #1a1a1a',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontFamily: 'JetBrains Mono, monospace',
                }}
                labelStyle={{ color: '#00ccff' }}
                formatter={(value, name) => [
                  name === 'winRate' ? `${(Number(value) * 100).toFixed(1)}%` : `${Number(value).toFixed(2)}x`,
                  name === 'winRate' ? 'Win Rate' : 'EV',
                ]}
              />
              <Bar dataKey="ev" name="EV" radius={[2, 2, 0, 0]}>
                {chartData.map((entry, idx) => (
                  <Cell
                    key={idx}
                    fill={entry.ev >= 0 ? '#00ff41' : '#ff3333'}
                    fillOpacity={0.7}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

/* ── Helpers ───────────────────────────────────────────────────── */

function formatTime(ts?: string): string {
  if (!ts) return '--:--:--';
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return ts.slice(11, 19);
  }
}

function truncMsg(msg: string): string {
  return msg.length > 80 ? msg.slice(0, 77) + '…' : msg;
}

function getPriceSourceSeverity(message: string): 'normal' | 'warn' | 'alert' {
  const cacheMatch = message.match(/CACHE\s+([0-9]+(?:\.[0-9]+)?)%/i);
  const cachePct = cacheMatch ? Number(cacheMatch[1]) : 0;

  if (!Number.isFinite(cachePct)) return 'normal';
  if (cachePct >= 20) return 'alert';
  if (cachePct >= 8) return 'warn';
  return 'normal';
}

function getLogMessageClass(message: string): string {
  if (!message.includes('Price source mix')) {
    return 'text-terminal-text';
  }

  const severity = getPriceSourceSeverity(message);
  if (severity === 'alert') return 'text-terminal-red font-bold';
  if (severity === 'warn') return 'text-terminal-yellow font-semibold';
  return 'text-terminal-cyan';
}

function formatSourceMix(status: Status): string {
  const dex = status.dexHitRatePct;
  const jup = status.jupiterHitRatePct;
  const cache = status.cacheKeepaliveRatePct;

  if (dex == null && jup == null && cache == null) {
    return 'NO SNAPSHOT YET';
  }

  const d = Number.isFinite(Number(dex)) ? Number(dex).toFixed(1) : '0.0';
  const j = Number.isFinite(Number(jup)) ? Number(jup).toFixed(1) : '0.0';
  const c = Number.isFinite(Number(cache)) ? Number(cache).toFixed(1) : '0.0';
  return `DEX ${d}% | JUP ${j}% | CACHE ${c}%`;
}
