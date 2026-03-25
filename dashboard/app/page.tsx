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
  gate: string;
  aggression: string;
  equityDD: string;
  edgesEnabled: string;
  journalCount: number;
  lastHaltReason?: string | null;
  lastHaltAt?: string | null;
  haltCount10m?: number;
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
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  reason?: string;
  haltCount?: number;
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

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
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
      </div>
      <StatusCell label="GATE" value={status.gate}
        color={status.gate === 'LOCKED' ? 'red' : 'green'} />
      <StatusCell label="AGGRESSION" value={status.aggression}
        color={status.aggression === 'NORMAL' ? 'green' : 'yellow'} />
      <StatusCell label="EQUITY DD" value={status.equityDD} color="text" />
      <StatusCell label="EDGES" value={status.edgesEnabled} color="cyan" />
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
            Waiting for pool events…
          </div>
        )}
        {[...logs].reverse().map((log, i) => (
          <div key={i} className="text-[11px] leading-relaxed border-b border-terminal-border/30 pb-1">
            <span className="text-terminal-dim">{formatTime(log.timestamp)}</span>{' '}
            <LogIcon message={log.message} />{' '}
            <span className="text-terminal-text">{truncMsg(log.message)}</span>
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
