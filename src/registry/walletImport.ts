import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import { WalletEntry, WalletRegistry } from './walletRegistry';

/**
 * Importing a curated wallet list (for example a leaderboard export) into the
 * registry file. Pure functions here; scripts/importWallets.ts is the CLI.
 *
 * The registry file is the only thing the engine reads, so any source that can
 * produce { address, pnl30d, tier, tradeCount, lastActive } works.
 */

export type Tier = 'S' | 'A' | 'B';
export type ImportMode = 'replace' | 'merge';

export interface ImportOptions {
  /** Multiplies the file's PnL to get USD (1 if the file is already in USD). */
  pnlMultiplier: number;
  /** Wallets with fewer trades than this are skipped (too few to mean anything). */
  minTrades: number;
  /** Wallets with more trades than this are skipped as bot-like; null = no limit. */
  maxTrades: number | null;
  /** Keep at most this many wallets, best PnL first. */
  max: number;
  exclude: Set<string>;
  now: Date;
}

export interface SkippedRow {
  line: number;
  address: string;
  reason: string;
}

export interface ImportResult {
  entries: WalletEntry[];
  skipped: SkippedRow[];
  warnings: string[];
  /** What `line` in skipped rows and warnings counts: file lines (CSV) or records (JSON). */
  unit: 'line' | 'record';
}

export const DEFAULT_IMPORT_OPTIONS: Omit<ImportOptions, 'now'> = {
  pnlMultiplier: 1,
  minTrades: 20,
  maxTrades: null,
  max: 60,
  exclude: new Set<string>(),
};

/** Trade counts above this get a warning (not a skip): a human rarely does this many. */
export const BOT_LIKE_TRADES = 1000;

// ── CSV ──────────────────────────────────────────────────────────────

/** Minimal RFC-4180 style parser: quoted fields, "" escapes, CRLF or LF, optional BOM. */
export function parseCsv(input: string): { header: string[]; rows: { line: number; cells: string[] }[] } {
  const text = input.replace(/^﻿/, '');
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = () => {
    cells.push(cell);
    cell = '';
    if (cells.some((c) => c.trim() !== '')) records.push({ line: recordLine, cells });
    cells = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else if (ch === '\r') {
      // swallowed; the following \n (if any) ends the record
    } else if (ch === '\n') {
      endRecord();
      line++;
      recordLine = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || cells.length > 0) endRecord();

  if (records.length === 0) return { header: [], rows: [] };
  const [head, ...rows] = records;
  return { header: head.cells.map((h) => h.trim()), rows };
}

const COLUMN_ALIASES: Record<'address' | 'pnl' | 'winRate' | 'trades' | 'tier' | 'lastActive', string[]> = {
  address: ['address', 'wallet', 'walletaddress', 'trader', 'account'],
  pnl: ['pnl30d', 'pnl', 'pnlusd', 'profit', 'profitusd', 'realizedpnl', 'totalpnl'],
  winRate: ['winrate', 'win', 'winpct', 'winpercent', 'winratepct'],
  trades: ['tradecount', 'trades', 'txns', 'transactions', 'numtrades', 'totaltrades'],
  tier: ['tier'],
  lastActive: ['lastactive', 'lasttradetime', 'lasttrade', 'lastseen'],
};

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export function resolveColumns(header: string[]): Partial<Record<keyof typeof COLUMN_ALIASES, number>> {
  const normalized = header.map(normalizeHeader);
  const out: Partial<Record<keyof typeof COLUMN_ALIASES, number>> = {};
  for (const key of Object.keys(COLUMN_ALIASES) as (keyof typeof COLUMN_ALIASES)[]) {
    const idx = normalized.findIndex((h) => COLUMN_ALIASES[key].includes(h));
    if (idx >= 0) out[key] = idx;
  }
  return out;
}

/** "$1,234.5", "12.3K", "-$2M", "(500)", "63%" -> number; null if unreadable or empty. */
export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (s === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,%\s]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  s = s.replace(/^\$/, '');
  const m = /^(\d+(?:\.\d+)?|\.\d+)([kmb])?$/i.exec(s);
  if (m === null) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase() as 'k' | 'm' | 'b'] ?? 1;
  const value = parseFloat(m[1]) * mult;
  return negative ? -value : value;
}

export function isValidAddress(addr: string): boolean {
  try {
    return new PublicKey(addr).toBytes().length === 32;
  } catch {
    return false;
  }
}

/**
 * Tier from PnL (USD) and win rate (0-1). Mirrors scripts/syncWallets.ts but
 * leaves out its average-peak-multiple condition, which a leaderboard export
 * does not have, so S and A are somewhat easier to reach here. A wallet with no
 * win rate is capped at B. An explicit tier column always wins.
 */
export function deriveTier(pnlUSD: number, winRate: number | null): Tier {
  if (winRate === null) return 'B';
  if (pnlUSD > 500_000 && winRate > 0.65) return 'S';
  if (pnlUSD > 100_000 && winRate > 0.5) return 'A';
  return 'B';
}

// ── Build entries from a table (CSV or JSON) ─────────────────────────

/** What both input formats are turned into. `unit` names what `line` counts in messages. */
export interface Table {
  header: string[];
  rows: { line: number; cells: string[] }[];
  unit?: 'line' | 'record';
}

export function buildEntries(csvText: string, options: ImportOptions): ImportResult {
  return buildEntriesFromTable(parseCsv(csvText), options);
}

export function buildEntriesFromJson(jsonText: string, options: ImportOptions, fieldMap: FieldMap = {}): ImportResult {
  return buildEntriesFromTable(jsonToTable(jsonText, fieldMap), options);
}

export function buildEntriesFromTable(table: Table, options: ImportOptions): ImportResult {
  const { header, rows } = table;
  const unit = table.unit ?? 'line';
  const warnings: string[] = [];
  const skipped: SkippedRow[] = [];
  const cols = resolveColumns(header);

  if (cols.address === undefined || cols.pnl === undefined || cols.trades === undefined) {
    const missing = [
      cols.address === undefined ? 'address' : null,
      cols.pnl === undefined ? 'pnl' : null,
      cols.trades === undefined ? 'trade_count' : null,
    ].filter((x): x is string => x !== null);
    const found = header.slice(0, 40).join(', ') + (header.length > 40 ? ', …' : '');
    throw new Error(`Input is missing required column(s): ${missing.join(', ')}. Found: ${found || '(no header)'}`);
  }

  const best = new Map<string, WalletEntry>();

  for (const { line, cells } of rows) {
    const address = (cells[cols.address] ?? '').trim();
    const skip = (reason: string) => skipped.push({ line, address, reason });

    if (isValidAddress(address) === false) {
      skip('not a valid Solana address');
      continue;
    }
    if (options.exclude.has(address)) {
      skip('excluded');
      continue;
    }

    const pnlRaw = parseNumber(cells[cols.pnl]);
    if (pnlRaw === null) {
      skip('missing or unreadable PnL');
      continue;
    }
    const pnlUSD = pnlRaw * options.pnlMultiplier;
    if (pnlUSD <= 0) {
      skip('PnL is not positive');
      continue;
    }

    const tradesRaw = parseNumber(cells[cols.trades]);
    if (tradesRaw === null || tradesRaw < 0) {
      skip('missing or unreadable trade count');
      continue;
    }
    const tradeCount = Math.round(tradesRaw);
    if (tradeCount < options.minTrades) {
      skip(`fewer than ${options.minTrades} trades (${tradeCount})`);
      continue;
    }
    if (options.maxTrades !== null && tradeCount > options.maxTrades) {
      skip(`looks like a bot: ${tradeCount} trades is above the ${options.maxTrades} limit`);
      continue;
    }

    let winRate: number | null = null;
    if (cols.winRate !== undefined) {
      const wr = parseNumber(cells[cols.winRate]);
      if (wr !== null) {
        const asFraction = wr > 1 ? wr / 100 : wr;
        if (asFraction < 0 || asFraction > 1) {
          skip(`win rate out of range (${cells[cols.winRate]})`);
          continue;
        }
        winRate = asFraction;
      }
    }

    let tier: Tier = deriveTier(pnlUSD, winRate);
    if (cols.tier !== undefined) {
      const t = (cells[cols.tier] ?? '').trim().toUpperCase();
      if (t === 'S' || t === 'A' || t === 'B') tier = t;
      else if (t !== '') {
        skip(`tier must be S, A or B (got "${cells[cols.tier]}")`);
        continue;
      }
    }

    let lastActive = options.now;
    if (cols.lastActive !== undefined) {
      const raw = (cells[cols.lastActive] ?? '').trim();
      if (raw !== '') {
        // 9-10 digits is epoch seconds, 11-13 is epoch milliseconds (JSON APIs often send these)
        const d = /^\d{9,13}$/.test(raw) ? new Date(raw.length <= 10 ? Number(raw) * 1000 : Number(raw)) : new Date(raw);
        if (Number.isNaN(d.getTime())) warnings.push(`${unit} ${line}: unreadable last-active "${raw}", using import time`);
        else lastActive = d;
      }
    }

    if (tradeCount > BOT_LIKE_TRADES) {
      warnings.push(`${unit} ${line}: ${address} has ${tradeCount} trades, which looks bot-like (use --max-trades to drop such wallets)`);
    }

    const entry: WalletEntry = { address, pnl30d: pnlUSD, tier, tradeCount, lastActive };
    const prev = best.get(address);
    if (prev === undefined) {
      best.set(address, entry);
    } else if (entry.pnl30d > prev.pnl30d) {
      best.set(address, entry);
      skipped.push({ line, address, reason: 'duplicate (kept this one: higher PnL)' });
    } else {
      skipped.push({ line, address, reason: 'duplicate (kept the earlier one: higher PnL)' });
    }
  }

  const sorted = [...best.values()].sort((a, b) => b.pnl30d - a.pnl30d);
  const kept = sorted.slice(0, options.max);
  for (const dropped of sorted.slice(options.max)) {
    skipped.push({ line: 0, address: dropped.address, reason: `beyond --max ${options.max} (lower PnL)` });
  }

  return { entries: kept, skipped, warnings, unit };
}

// ── JSON input ───────────────────────────────────────────────────────

const CANONICAL_FIELDS = ['address', 'pnl30d', 'win_rate', 'trade_count', 'tier', 'last_active'] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];
/** Where to find a field in each JSON record, as a dotted path: { pnl30d: 'summary.realized' }. */
export type FieldMap = Partial<Record<CanonicalField, string>>;

/** "pnl30d=summary.realized,win_rate=winPct" -> FieldMap */
export function parseFieldMap(spec: string): FieldMap {
  const map: FieldMap = {};
  for (const part of spec.split(',')) {
    if (part.trim() === '') continue;
    const [name, ...rest] = part.split('=');
    const path = rest.join('=').trim();
    const key = name.trim() as CanonicalField;
    if (CANONICAL_FIELDS.includes(key) === false || path === '') {
      throw new Error(`--field expects name=path with name one of ${CANONICAL_FIELDS.join(', ')} (got "${part}")`);
    }
    map[key] = path;
  }
  return map;
}

const WRAPPER_KEYS = ['data', 'wallets', 'traders', 'results', 'items', 'leaderboard', 'rows', 'entries'];

/** The list of records: the array itself, or the array inside a common wrapper such as { data: [...] }. */
function findRecords(node: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(node)) return node;
  if (node === null || typeof node !== 'object' || depth >= 3) return null;
  const obj = node as Record<string, unknown>;
  for (const key of WRAPPER_KEYS) {
    if (key in obj) {
      const found = findRecords(obj[key], depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function scalarToString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return /e/i.test(String(v)) ? v.toFixed(6) : String(v);
  return '';
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && Array.isArray(v) === false;

/** Leaf key -> value for one record, nearest-to-the-top first (two levels of nesting are looked at). */
function flattenRecord(record: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const queue: [unknown, number][] = [[record, 0]];
  while (queue.length > 0) {
    const [node, depth] = queue.shift()!;
    if (isObject(node) === false) continue;
    for (const [key, value] of Object.entries(node)) {
      if (isObject(value)) {
        if (depth < 2) queue.push([value, depth + 1]);
      } else if (Array.isArray(value) === false && out.has(key) === false) {
        out.set(key, scalarToString(value));
      }
    }
  }
  return out;
}

function lookupPath(record: unknown, dotted: string): string {
  let node: unknown = record;
  for (const part of dotted.split('.')) {
    if (isObject(node) === false) return '';
    node = node[part];
  }
  return scalarToString(node);
}

/**
 * Turns a JSON export into the same table a CSV gives. Keys are matched with the same loose
 * names as CSV headers; nested objects are searched two levels down. When the names don't
 * match, fieldMap says where each field lives, and its columns take priority.
 */
export function jsonToTable(jsonText: string, fieldMap: FieldMap = {}): Table {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`Input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const records = findRecords(parsed);
  if (records === null) {
    throw new Error('JSON must be an array of wallet records, or an object wrapping one (data, wallets, traders, results, items, leaderboard, rows or entries)');
  }

  if (records.length === 0) throw new Error('JSON contains no wallet records');

  const mapped = (Object.keys(fieldMap) as CanonicalField[]).filter((k) => fieldMap[k] !== undefined);
  const flats = records.map(flattenRecord);
  const leafNames: string[] = [];
  const seen = new Set<string>(mapped);
  for (const flat of flats) {
    for (const key of flat.keys()) {
      if (seen.has(key) === false) {
        seen.add(key);
        leafNames.push(key);
      }
    }
  }

  const header = [...mapped, ...leafNames];
  const rows = records.map((record, i) => ({
    line: i + 1,
    cells: [
      ...mapped.map((k) => lookupPath(record, fieldMap[k]!)),
      ...leafNames.map((k) => flats[i].get(k) ?? ''),
    ],
  }));
  return { header, rows, unit: 'record' };
}

// ── Plan the change against the existing registry ────────────────────

export interface ImportPlan {
  final: WalletEntry[];
  added: string[];
  removed: string[];
  updated: string[];
  unchanged: string[];
}

export function planImport(
  existing: WalletEntry[],
  imported: WalletEntry[],
  mode: ImportMode,
  exclude: Set<string> = new Set()
): ImportPlan {
  const existingByAddr = new Map(existing.map((w) => [w.address, w]));
  const importedByAddr = new Map(imported.map((w) => [w.address, w]));

  let final: WalletEntry[];
  if (mode === 'replace') {
    final = [...imported];
  } else {
    const merged = new Map(existingByAddr);
    for (const w of imported) merged.set(w.address, w);
    for (const addr of exclude) merged.delete(addr);
    final = [...merged.values()];
  }

  const finalAddrs = new Set(final.map((w) => w.address));
  const added = final.filter((w) => existingByAddr.has(w.address) === false).map((w) => w.address);
  const removed = existing.filter((w) => finalAddrs.has(w.address) === false).map((w) => w.address);
  const updated = final
    .filter((w) => importedByAddr.has(w.address) && existingByAddr.has(w.address))
    .map((w) => w.address);
  const unchanged = final
    .filter((w) => existingByAddr.has(w.address) && importedByAddr.has(w.address) === false)
    .map((w) => w.address);

  return { final, added, removed, updated, unchanged };
}

// ── Safe write ───────────────────────────────────────────────────────

export interface WriteResult {
  backupPath: string | null;
  count: number;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

/**
 * Writes the registry to a temp file, loads it back through WalletRegistry (so the
 * engine's own schema validates it), keeps a timestamped backup of the old file in a backups/ folder next to it,
 * then renames the temp file into place. Refuses to write an empty registry.
 */
export async function writeWalletsFile(entries: WalletEntry[], outPath: string, now: Date): Promise<WriteResult> {
  if (entries.length === 0) throw new Error('Refusing to write an empty wallet registry');

  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const tmp = `${resolved}.tmp-${process.pid}`;
  const json = JSON.stringify(
    entries.map((w) => ({ ...w, lastActive: w.lastActive.toISOString() })),
    null,
    2
  );
  fs.writeFileSync(tmp, json, 'utf-8');

  try {
    const loaded = await WalletRegistry.load(tmp);
    if (loaded.count() !== entries.length) {
      throw new Error(`Validation mismatch: wrote ${entries.length} wallets but registry loaded ${loaded.count()}`);
    }
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }

  let backupPath: string | null = null;
  if (fs.existsSync(resolved)) {
    // data/backups/ is gitignored, so backups never show up as untracked files
    const backupDir = path.join(path.dirname(resolved), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, `${path.basename(resolved)}.bak-${stamp(now)}`);
    fs.copyFileSync(resolved, backupPath);
  }
  fs.renameSync(tmp, resolved);
  return { backupPath, count: entries.length };
}
