import fs from 'fs';
import os from 'os';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import {
  DEFAULT_IMPORT_OPTIONS,
  ImportOptions,
  buildEntries,
  buildEntriesFromJson,
  deriveTier,
  isValidAddress,
  jsonToTable,
  parseCsv,
  parseFieldMap,
  parseNumber,
  planImport,
  writeWalletsFile,
} from '../src/registry/walletImport';
import { WalletEntry, WalletRegistry } from '../src/registry/walletRegistry';

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const NOW = new Date('2026-10-07T12:00:00Z');
const addr = () => Keypair.generate().publicKey.toBase58();
const opts = (over: Partial<ImportOptions> = {}): ImportOptions => ({
  ...DEFAULT_IMPORT_OPTIONS,
  exclude: new Set<string>(),
  now: NOW,
  ...over,
});
const entry = (address: string, pnl = 1000, tier: 'S' | 'A' | 'B' = 'B'): WalletEntry => ({
  address,
  pnl30d: pnl,
  tier,
  tradeCount: 50,
  lastActive: NOW,
});

describe('parseCsv', () => {
  it('handles a BOM, CRLF, quoted commas and escaped quotes, and skips blank lines', () => {
    const r = parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n\r\n3,4\r\n');
    expect(r.header).toEqual(['a', 'b']);
    expect(r.rows.map((x) => x.cells)).toEqual([['x,1', 'he said "hi"'], ['3', '4']]);
  });

  it('reports the line of each record, counting newlines inside quotes', () => {
    const r = parseCsv('a,b\n"multi\nline",1\nz,2');
    expect(r.rows.map((x) => x.line)).toEqual([2, 4]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [] });
  });
});

describe('parseNumber', () => {
  it.each([
    ['1234', 1234],
    ['$1,234.50', 1234.5],
    ['-$2M', -2_000_000],
    ['12.3K', 12_300],
    ['(500)', -500],
    ['63%', 63],
    ['1.5b', 1_500_000_000],
    ['+7', 7],
  ])('reads %s', (raw, expected) => expect(parseNumber(raw)).toBeCloseTo(expected as number, 6));

  it.each(['', '  ', 'abc', '1.2.3', '12X', undefined])('returns null for %p', (raw) =>
    expect(parseNumber(raw as string | undefined)).toBeNull()
  );
});

describe('deriveTier', () => {
  it('uses PnL and win rate, and caps at B without a win rate', () => {
    expect(deriveTier(600_000, 0.7)).toBe('S');
    expect(deriveTier(600_000, 0.6)).toBe('A');
    expect(deriveTier(150_000, 0.55)).toBe('A');
    expect(deriveTier(150_000, 0.4)).toBe('B');
    expect(deriveTier(5_000_000, null)).toBe('B');
  });
});

describe('isValidAddress', () => {
  it('accepts a real key and rejects junk and wrong-length base58', () => {
    expect(isValidAddress(addr())).toBe(true);
    expect(isValidAddress('not-an-address')).toBe(false);
    expect(isValidAddress('')).toBe(false);
    expect(isValidAddress('1111111')).toBe(false);
  });
});

describe('buildEntries', () => {
  const [a, b, c] = [addr(), addr(), addr()];

  it('reads loosely named columns and normalizes numbers', () => {
    const csv = `Wallet Address,PnL (USD),Win Rate,Trades\n${a},"$600,000",70%,120\n`;
    // "Wallet Address" -> walletaddress ; "PnL (USD)" -> pnlusd
    const r = buildEntries(csv, opts());
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ address: a, pnl30d: 600_000, tradeCount: 120, tier: 'S' });
    expect(r.entries[0].lastActive).toEqual(NOW);
  });

  it('applies the PnL multiplier', () => {
    const r = buildEntries(`address,pnl,trades\n${a},100,50\n`, opts({ pnlMultiplier: 150 }));
    expect(r.entries[0].pnl30d).toBe(15_000);
  });

  it('throws a clear error when a required column is missing', () => {
    expect(() => buildEntries('address,pnl\nx,1\n', opts())).toThrow(/trade_count/);
    expect(() => buildEntries('', opts())).toThrow(/missing required/);
  });

  it('skips bad rows with a reason and keeps the good ones', () => {
    const csv = [
      'address,pnl30d,trade_count',
      `${a},1000,50`,
      'garbage,1000,50',
      `${b},-5,50`,
      `${c},1000,3`,
      `${addr()},abc,50`,
      `${addr()},1000,`,
    ].join('\n');
    const r = buildEntries(csv, opts());
    expect(r.entries.map((e) => e.address)).toEqual([a]);
    const reasons = r.skipped.map((s) => s.reason).join(' | ');
    expect(reasons).toMatch(/not a valid Solana address/);
    expect(reasons).toMatch(/PnL is not positive/);
    expect(reasons).toMatch(/fewer than 20 trades/);
    expect(reasons).toMatch(/unreadable PnL/);
    expect(reasons).toMatch(/unreadable trade count/);
    expect(r.skipped.find((s) => s.address === 'garbage')!.line).toBe(3);
  });

  it('drops bot-like wallets only when --max-trades is set, and always warns above 1,000', () => {
    const csv = `address,pnl30d,trade_count\n${a},1000,5000\n`;
    const warned = buildEntries(csv, opts());
    expect(warned.entries).toHaveLength(1);
    expect(warned.warnings.join(' ')).toMatch(/bot-like/);
    const dropped = buildEntries(csv, opts({ maxTrades: 1000 }));
    expect(dropped.entries).toHaveLength(0);
    expect(dropped.skipped[0].reason).toMatch(/looks like a bot/);
  });

  it('treats a win rate above 1 as a percent and rejects impossible values', () => {
    const csv = `address,pnl30d,win_rate,trade_count\n${a},600000,70,50\n${b},600000,0.7,50\n${c},600000,250,50\n`;
    const r = buildEntries(csv, opts());
    expect(r.entries.map((e) => e.tier)).toEqual(['S', 'S']);
    expect(r.skipped.map((s) => s.reason).join()).toMatch(/win rate out of range/);
  });

  it('lets an explicit tier column win and rejects an unknown tier', () => {
    const csv = `address,pnl30d,trade_count,tier\n${a},1000,50,s\n${b},1000,50,Z\n${c},1000,50,\n`;
    const r = buildEntries(csv, opts());
    expect(r.entries.find((e) => e.address === a)!.tier).toBe('S');
    expect(r.entries.find((e) => e.address === c)!.tier).toBe('B');
    expect(r.skipped.map((s) => s.reason).join()).toMatch(/tier must be S, A or B/);
  });

  it('uses last_active when given, and falls back with a warning when unreadable', () => {
    const csv = `address,pnl30d,trade_count,last_active\n${a},1000,50,2026-09-30T10:00:00Z\n${b},1000,50,nope\n`;
    const r = buildEntries(csv, opts());
    expect(r.entries.find((e) => e.address === a)!.lastActive).toEqual(new Date('2026-09-30T10:00:00Z'));
    expect(r.entries.find((e) => e.address === b)!.lastActive).toEqual(NOW);
    expect(r.warnings.join()).toMatch(/unreadable last-active/);
  });

  it('keeps the higher-PnL row for a duplicate address', () => {
    const r = buildEntries(`address,pnl30d,trade_count\n${a},100,50\n${a},900,60\n${a},300,70\n`, opts());
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].pnl30d).toBe(900);
    expect(r.skipped).toHaveLength(2);
  });

  it('honours the exclude list', () => {
    const r = buildEntries(`address,pnl30d,trade_count\n${a},100,50\n${b},200,50\n`, opts({ exclude: new Set([a]) }));
    expect(r.entries.map((e) => e.address)).toEqual([b]);
  });

  it('sorts by PnL and caps at --max, reporting what the cap dropped', () => {
    const [x, y, z] = [addr(), addr(), addr()];
    const r = buildEntries(`address,pnl30d,trade_count\n${x},100,50\n${y},300,50\n${z},200,50\n`, opts({ max: 2 }));
    expect(r.entries.map((e) => e.address)).toEqual([y, z]);
    expect(r.skipped.find((s) => s.address === x)!.reason).toMatch(/beyond --max 2/);
  });
});

describe('planImport', () => {
  const [a, b, c, d] = [addr(), addr(), addr(), addr()];
  const existing = [entry(a), entry(b)];
  const imported = [entry(b, 5000), entry(c, 4000)];

  it('replace: the import becomes the whole registry', () => {
    const p = planImport(existing, imported, 'replace');
    expect(p.final.map((w) => w.address).sort()).toEqual([b, c].sort());
    expect(p.added).toEqual([c]);
    expect(p.removed).toEqual([a]);
    expect(p.updated).toEqual([b]);
    expect(p.unchanged).toEqual([]);
  });

  it('merge: adds and updates, removes nothing', () => {
    const p = planImport(existing, imported, 'merge');
    expect(p.final.map((w) => w.address).sort()).toEqual([a, b, c].sort());
    expect(p.final.find((w) => w.address === b)!.pnl30d).toBe(5000);
    expect(p.removed).toEqual([]);
    expect(p.unchanged).toEqual([a]);
  });

  it('merge with an exclude list removes those wallets from the registry', () => {
    const p = planImport([...existing, entry(d)], imported, 'merge', new Set([d]));
    expect(p.final.map((w) => w.address)).not.toContain(d);
    expect(p.removed).toEqual([d]);
  });
});

describe('writeWalletsFile', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wimport-'));

  it('writes a file the registry loads back, with ISO dates', async () => {
    const out = path.join(dir(), 'nested', 'wallets.json');
    const entries = [entry(addr(), 900, 'A'), entry(addr(), 100)];
    const r = await writeWalletsFile(entries, out, NOW);
    expect(r.backupPath).toBeNull();
    const reg = await WalletRegistry.load(out);
    expect(reg.count()).toBe(2);
    expect(JSON.parse(fs.readFileSync(out, 'utf-8'))[0].lastActive).toBe(NOW.toISOString());
    expect(fs.readdirSync(path.dirname(out)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('keeps a timestamped backup of the previous file', async () => {
    const out = path.join(dir(), 'wallets.json');
    fs.writeFileSync(out, '[]');
    const r = await writeWalletsFile([entry(addr())], out, NOW);
    expect(r.backupPath).toMatch(/wallets\.json\.bak-20261007-120000$/);
    expect(fs.readFileSync(r.backupPath!, 'utf-8')).toBe('[]');
  });

  it('refuses an empty registry and leaves the existing file alone', async () => {
    const out = path.join(dir(), 'wallets.json');
    fs.writeFileSync(out, '[{"keep":"me"}]');
    await expect(writeWalletsFile([], out, NOW)).rejects.toThrow(/empty/);
    expect(fs.readFileSync(out, 'utf-8')).toBe('[{"keep":"me"}]');
  });

  it('rejects an entry the registry schema would refuse, without touching the existing file or leaving a temp file', async () => {
    const d = dir();
    const out = path.join(d, 'wallets.json');
    fs.writeFileSync(out, '[]');
    const bad = [{ ...entry(addr()), tradeCount: 1.5 }];
    await expect(writeWalletsFile(bad, out, NOW)).rejects.toThrow();
    expect(fs.readFileSync(out, 'utf-8')).toBe('[]');
    expect(fs.readdirSync(d)).toEqual(['wallets.json']);
  });
});

describe('JSON input', () => {
  const [a, b, c] = [addr(), addr(), addr()];
  const json = (v: unknown) => JSON.stringify(v);

  it('reads a flat array with loosely named keys', () => {
    const r = buildEntriesFromJson(json([{ wallet: a, realizedPnl: 600000, winRate: 70, trades: 140 }]), opts());
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ address: a, pnl30d: 600000, tradeCount: 140, tier: 'S' });
    expect(r.unit).toBe('record');
  });

  it.each(['data', 'wallets', 'traders', 'results', 'items', 'leaderboard'])('unwraps { %s: [...] }', (key) => {
    const r = buildEntriesFromJson(json({ [key]: [{ address: a, pnl: 1000, trade_count: 50 }] }), opts());
    expect(r.entries.map((e) => e.address)).toEqual([a]);
  });

  it('unwraps one level deeper, such as { data: { traders: [...] } }', () => {
    const r = buildEntriesFromJson(json({ data: { traders: [{ address: a, pnl: 1000, trades: 50 }] } }), opts());
    expect(r.entries).toHaveLength(1);
  });

  it('finds fields inside nested objects, preferring the shallowest key', () => {
    const rec = { address: a, summary: { pnl: 1000, trades: 50, winRate: 0.6 }, pnl: null };
    const r = buildEntriesFromJson(json([rec]), opts());
    // top-level pnl is null (empty), and it wins over the nested one, so this record is skipped
    expect(r.entries).toHaveLength(0);
    const ok = buildEntriesFromJson(json([{ address: a, summary: { pnl: 1000, trades: 50, winRate: 0.6 } }]), opts());
    expect(ok.entries[0]).toMatchObject({ pnl30d: 1000, tradeCount: 50 });
  });

  it('uses --field paths, and they win over auto-detected keys', () => {
    const rec = { id: a, pnl: 1, stats: { realized: 2500, count: 90, win: 0.55 } };
    const map = parseFieldMap('address=id,pnl30d=stats.realized,trade_count=stats.count,win_rate=stats.win');
    const r = buildEntriesFromJson(json([rec]), opts(), map);
    expect(r.entries[0]).toMatchObject({ address: a, pnl30d: 2500, tradeCount: 90 });
  });

  it('accepts epoch seconds and milliseconds for last active', () => {
    const rows = [
      { address: a, pnl: 100, trades: 50, last_active: 1790000000 },
      { address: b, pnl: 100, trades: 50, last_active: 1790000000000 },
    ];
    const r = buildEntriesFromJson(json(rows), opts());
    const when = new Date(1790000000000);
    expect(r.entries.map((e) => e.lastActive.getTime())).toEqual([when.getTime(), when.getTime()]);
  });

  it('turns large numbers without exponent notation and ignores arrays and booleans', () => {
    const t = jsonToTable(json([{ address: a, pnl: 1e21, trades: 50, tags: ['x'], bot: true }]));
    expect(t.rows[0].cells[t.header.indexOf('pnl')]).toBe((1e21).toFixed(6));
    expect(t.header).not.toContain('tags');
  });

  it('reports the record number in skip reasons', () => {
    const r = buildEntriesFromJson(json([{ address: a, pnl: 100, trades: 50 }, { address: 'nope', pnl: 100, trades: 50 }]), opts());
    expect(r.skipped[0]).toMatchObject({ line: 2, reason: 'not a valid Solana address' });
  });

  it('gives clear errors for bad JSON, an unusable shape, and missing fields (listing what it found)', () => {
    expect(() => buildEntriesFromJson('{oops', opts())).toThrow(/not valid JSON/);
    expect(() => buildEntriesFromJson(json({ foo: 1 }), opts())).toThrow(/array of wallet records/);
    expect(() => buildEntriesFromJson(json([{ address: a, balance: 5 }]), opts())).toThrow(/missing required.*Found: address, balance/);
  });

  it('says so when the list is empty', () => {
    expect(() => buildEntriesFromJson('[]', opts())).toThrow(/no wallet records/);
  });
});

describe('parseFieldMap', () => {
  it('parses name=path pairs', () => {
    expect(parseFieldMap('pnl30d=summary.realized, win_rate=winPct')).toEqual({ pnl30d: 'summary.realized', win_rate: 'winPct' });
  });
  it('rejects unknown names and missing paths', () => {
    expect(() => parseFieldMap('profit=x')).toThrow(/name=path/);
    expect(() => parseFieldMap('pnl30d=')).toThrow(/name=path/);
  });
});
