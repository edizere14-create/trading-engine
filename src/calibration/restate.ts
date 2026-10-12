import fs from 'fs';
import os from 'os';
import path from 'path';
// @ts-ignore sql.js has no bundled types
import initSqlJs from 'sql.js';
import { estimateDrainExitPrice } from '../position/drainExit';
import { PaperTradeGate } from './paperTrader';

/**
 * Restating paper trades that were closed by a vault drain (RUG_TRIGGER).
 *
 * Until the exit-price fix, a drain closed the position at the last price seen before it, so a pool
 * that lost 44-98% of its SOL in one transaction was booked as breakeven or better. This rebuilds
 * those results from the drain size recorded in the journal, into a NEW file; the live trades file
 * and the journal are only ever read.
 *
 * It is an estimate, the same one the engine now uses: after a drain that leaves a fraction r of the
 * pool's SOL, a constant-product pool's price is about r^2 of what it was. Take-profit tiers that had
 * already sold part of the position are kept, because that part really was banked.
 */

/** The target multiples of the take-profit tiers, as PositionManager.buildExitTiers sets them. */
export const TIER_MULTIPLES: Record<number, number> = { 1: 1.5, 2: 2.0, 3: 3.0, 4: 5.0 };

/** How close tier-aware arithmetic must come to the booked multiple to be trusted. */
const BASIS_TOLERANCE = 0.03;

// ── Reading the journal (never writes) ───────────────────────────────

export interface JournalRow {
  id: string;
  entryPriceSOL?: number;
  exitPriceSOL?: number;
  exitReason?: string;
  peakMultiple?: number;
  realizedMultiple?: number;
}

export interface PartialRow {
  positionId: string;
  tier: number;
  pctClosed: number;
}

export interface JournalData {
  rows: Map<string, JournalRow>;
  partials: Map<string, PartialRow[]>;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Reads the journal straight through sql.js. TradeJournal is deliberately not used: its close()
 * saves the database back to disk, which a read-only tool must never do to a live file.
 */
export async function readJournal(dbPath: string): Promise<JournalData> {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const query = (sql: string): Record<string, unknown>[] => {
    const stmt = db.prepare(sql);
    const out: Record<string, unknown>[] = [];
    while (stmt.step()) out.push(stmt.getAsObject() as Record<string, unknown>);
    stmt.free();
    return out;
  };

  try {
    const rows = new Map<string, JournalRow>();
    for (const r of query('SELECT id, entryPriceSOL, exitPriceSOL, exitReason, peakMultiple, realizedMultiple FROM trades')) {
      rows.set(String(r.id), {
        id: String(r.id),
        entryPriceSOL: num(r.entryPriceSOL),
        exitPriceSOL: num(r.exitPriceSOL),
        exitReason: typeof r.exitReason === 'string' ? r.exitReason : undefined,
        peakMultiple: num(r.peakMultiple),
        realizedMultiple: num(r.realizedMultiple),
      });
    }

    const partials = new Map<string, PartialRow[]>();
    try {
      for (const r of query('SELECT positionId, tier, pctClosed FROM partial_closes')) {
        const id = String(r.positionId);
        const list = partials.get(id) ?? [];
        list.push({ positionId: id, tier: Number(r.tier), pctClosed: Number(r.pctClosed) });
        partials.set(id, list);
      }
    } catch {
      // an older journal without the partial_closes table: no tier data
    }
    return { rows, partials };
  } finally {
    db.close(); // frees memory only; sql.js does not write the file
  }
}

// ── Restating one record ─────────────────────────────────────────────

/** "RUG_TRIGGER: vault drain 58.9%" -> 58.9 */
export function parseDrainPct(reason: string | undefined): number | null {
  const m = /vault drain\s+([0-9]+(?:\.[0-9]+)?)\s*%/i.exec(reason ?? '');
  return m ? Number(m[1]) : null;
}

export type RestateStatus =
  | 'restated'
  | 'not-rug-trigger'
  | 'already-restated'
  | 'no-journal-row'
  | 'no-drain-pct'
  | 'no-prices';

export interface RestateDetail {
  id: string;
  tokenCA: string;
  drainPct: number;
  /** tier-aware: tier sales reproduce the booked multiple; unverified: they don't, so the whole position is repriced. */
  basis: 'tier-aware' | 'unverified';
  bookedMultiple: number;
  restatedMultiple: number;
  bookedPnLUSD: number;
  restatedPnLUSD: number;
}

export interface RestateResult {
  status: RestateStatus;
  record: any;
  detail?: RestateDetail;
}

const outcomeOf = (multiple: number) => (multiple >= 1.02 ? 'WIN' : multiple <= 0.98 ? 'LOSS' : 'BREAKEVEN');

export function restateRecord(record: any, journal: JournalData): RestateResult {
  if (record?.exitMode !== 'RUG_TRIGGER') return { status: 'not-rug-trigger', record };
  if (record.restated !== undefined) return { status: 'already-restated', record };

  const row = journal.rows.get(String(record.id));
  if (row === undefined) return { status: 'no-journal-row', record };

  const drainPct = parseDrainPct(row.exitReason);
  if (drainPct === null) return { status: 'no-drain-pct', record };

  const entry = row.entryPriceSOL;
  const lastPrice = row.exitPriceSOL;
  const booked = Number(record.realizedMultiple);
  const estPrice = lastPrice !== undefined ? estimateDrainExitPrice(lastPrice, drainPct) : undefined;
  if (entry === undefined || entry <= 0 || lastPrice === undefined || estPrice === undefined || !Number.isFinite(booked)) {
    return { status: 'no-prices', record };
  }

  // What had already been sold at take-profit tiers, and what was left to close at the last price
  let banked = 0;
  let sold = 0;
  for (const p of journal.partials.get(String(record.id)) ?? []) {
    const m = TIER_MULTIPLES[p.tier];
    if (m === undefined) continue;
    banked += p.pctClosed * m;
    sold += p.pctClosed;
  }
  const remaining = Math.max(1 - sold, 0);

  const reproduces = Math.abs(banked + remaining * (lastPrice / entry) - booked) <= BASIS_TOLERANCE;
  const basis = reproduces ? 'tier-aware' : 'unverified';
  const restated = (reproduces ? banked : 0) + (reproduces ? remaining : 1) * (estPrice / entry);

  const sizeUSD = Number(record.sizeUSD);
  const bookedPnL = Number(record.realizedPnLUSD);
  const restatedPnL = bookedPnL + (Number.isFinite(sizeUSD) ? sizeUSD * (restated - booked) : 0);

  const next = {
    ...record,
    realizedMultiple: restated,
    realizedPnLUSD: restatedPnL,
    outcome: outcomeOf(restated),
    exitPriceLamports: String(Math.round(estPrice * 1e9)),
    restated: {
      basis,
      drainPct,
      from: {
        realizedMultiple: record.realizedMultiple,
        realizedPnLUSD: record.realizedPnLUSD,
        outcome: record.outcome,
        exitPriceLamports: record.exitPriceLamports,
      },
    },
  };
  return {
    status: 'restated',
    record: next,
    detail: {
      id: String(record.id),
      tokenCA: String(record.tokenCA),
      drainPct,
      basis,
      bookedMultiple: booked,
      restatedMultiple: restated,
      bookedPnLUSD: bookedPnL,
      restatedPnLUSD: restatedPnL,
    },
  };
}

// ── Whole file ───────────────────────────────────────────────────────

export interface RestateRun {
  /** The JSON as read: an array, or an object with a `trades` array. */
  originalJson: unknown;
  restatedJson: unknown;
  original: any[];
  restated: any[];
  details: RestateDetail[];
  counts: Record<RestateStatus, number>;
}

export async function restateTrades(tradesPath: string, journalPath: string): Promise<RestateRun> {
  const json = JSON.parse(fs.readFileSync(tradesPath, 'utf-8'));
  const original: any[] = Array.isArray(json) ? json : (json.trades ?? []);
  const journal = await readJournal(journalPath);

  const counts: Record<RestateStatus, number> = {
    restated: 0,
    'not-rug-trigger': 0,
    'already-restated': 0,
    'no-journal-row': 0,
    'no-drain-pct': 0,
    'no-prices': 0,
  };
  const details: RestateDetail[] = [];
  const restated = original.map((rec) => {
    const r = restateRecord(rec, journal);
    counts[r.status]++;
    if (r.detail) details.push(r.detail);
    return r.record;
  });

  return {
    originalJson: json,
    restatedJson: Array.isArray(json) ? restated : { ...json, trades: restated },
    original,
    restated,
    details,
    counts,
  };
}

/** Atomic write of a derived file. Refuses to overwrite the file it was derived from. */
export function writeRestated(outPath: string, sourcePath: string, json: unknown): void {
  const out = path.resolve(outPath);
  if (out === path.resolve(sourcePath)) throw new Error('Refusing to overwrite the trades file it was read from');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf-8');
  fs.renameSync(tmp, out);
}

// ── Reporting ────────────────────────────────────────────────────────

export interface ModeSummary {
  exitMode: string;
  trades: number;
  avgMultiple: number;
  totalPnLUSD: number;
}

export function summarizeByExitMode(records: any[]): ModeSummary[] {
  const by = new Map<string, { n: number; sum: number; pnl: number }>();
  for (const r of records) {
    const k = String(r.exitMode ?? '?');
    const s = by.get(k) ?? { n: 0, sum: 0, pnl: 0 };
    s.n++;
    s.sum += Number(r.realizedMultiple) || 0;
    s.pnl += Number(r.realizedPnLUSD) || 0;
    by.set(k, s);
  }
  return [...by.entries()]
    .map(([exitMode, s]) => ({ exitMode, trades: s.n, avgMultiple: s.sum / s.n, totalPnLUSD: s.pnl }))
    .sort((a, b) => b.trades - a.trades);
}

export interface OverallSummary {
  trades: number;
  wins: number;
  winRatePct: number;
  avgMultiple: number;
  totalPnLUSD: number;
}

export function overallSummary(records: any[]): OverallSummary {
  const trades = records.length;
  const wins = records.filter((r) => r.outcome === 'WIN').length;
  return {
    trades,
    wins,
    winRatePct: trades > 0 ? (wins / trades) * 100 : 0,
    avgMultiple: trades > 0 ? records.reduce((s, r) => s + (Number(r.realizedMultiple) || 0), 0) / trades : 0,
    totalPnLUSD: records.reduce((s, r) => s + (Number(r.realizedPnLUSD) || 0), 0),
  };
}

export interface GateView {
  completedTrades: number;
  actualWinRate: number;
  actualEV: number;
  wpAuc: number | null;
  wpCalibrationError: number | null;
  gateUnlocked: boolean;
  blockedReasons: string[];
}

/** What the paper gate would say about these records, computed from a throwaway copy. */
export async function gateView(records: any[]): Promise<GateView> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restate-gate-'));
  const file = path.join(dir, 'paperTrades.json');
  try {
    fs.writeFileSync(file, JSON.stringify(records), 'utf-8');
    const s = (await PaperTradeGate.load(file)).getStatus();
    return {
      completedTrades: s.completedTrades,
      actualWinRate: s.actualWinRate,
      actualEV: s.actualEV,
      wpAuc: s.wpAuc,
      wpCalibrationError: s.wpCalibrationError,
      gateUnlocked: s.gateUnlocked,
      blockedReasons: s.blockedReasons,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Trades whose only edge is the autonomous (graduation) path. */
export const isAutonomousOnly = (r: any): boolean =>
  Array.isArray(r.edgesFired) && r.edgesFired.length === 1 && r.edgesFired[0] === 'AUTONOMOUS';
