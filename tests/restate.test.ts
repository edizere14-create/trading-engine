import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
// @ts-ignore sql.js has no bundled types
import initSqlJs from 'sql.js';
import {
  JournalData,
  gateView,
  isAutonomousOnly,
  overallSummary,
  parseDrainPct,
  readJournal,
  restateRecord,
  restateTrades,
  summarizeByExitMode,
  writeRestated,
} from '../src/calibration/restate';

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── fixtures ──────────────────────────────────────────────────────────

const rec = (over: Record<string, unknown> = {}) => ({
  id: 'id-1',
  tokenCA: '26orwj6e9iH2HzpvPsGk9R2jGNbzPDfaLrWStfFdpump',
  mode: 'PAPER',
  exitMode: 'RUG_TRIGGER',
  outcome: 'BREAKEVEN',
  realizedMultiple: 1.0,
  realizedPnLUSD: 0,
  sizeUSD: 15,
  predictedWP: 0.4,
  edgesFired: ['AUTONOMOUS'],
  exitPriceLamports: '32',
  ...over,
});

const journalOf = (
  rows: Array<{ id: string; entry?: number; exit?: number; reason?: string }>,
  partials: Array<{ positionId: string; tier: number; pctClosed: number }> = []
): JournalData => ({
  rows: new Map(
    rows.map((r) => [r.id, { id: r.id, entryPriceSOL: r.entry, exitPriceSOL: r.exit, exitReason: r.reason }])
  ),
  partials: partials.reduce((m, p) => m.set(p.positionId, [...(m.get(p.positionId) ?? []), p]), new Map<string, any[]>()),
});

const P = 3.2137e-8; // the pool price in the real 26orwj trade

// ── parsing ───────────────────────────────────────────────────────────

describe('parseDrainPct', () => {
  it.each([
    ['RUG_TRIGGER: vault drain 58.9%', 58.9],
    ['RUG_TRIGGER: vault drain 98.2%', 98.2],
    ['RUG_TRIGGER: vault drain 45%', 45],
  ])('reads %s', (reason, pct) => expect(parseDrainPct(reason)).toBe(pct));

  it.each([undefined, '', 'HARD_STOP (61.0% loss)', 'RUG_TRIGGER: something else'])('returns null for %p', (reason) =>
    expect(parseDrainPct(reason as string | undefined)).toBeNull()
  );
});

// ── one record ────────────────────────────────────────────────────────

describe('restateRecord', () => {
  it('the real 26orwj trade: booked breakeven, restated to about 0.17x, a LOSS', () => {
    const j = journalOf([{ id: 'id-1', entry: P, exit: P, reason: 'RUG_TRIGGER: vault drain 58.9%' }]);
    const r = restateRecord(rec(), j);

    expect(r.status).toBe('restated');
    expect(r.record.realizedMultiple).toBeCloseTo(0.411 ** 2, 4);
    expect(r.record.outcome).toBe('LOSS');
    expect(r.record.realizedPnLUSD).toBeCloseTo(15 * (0.411 ** 2 - 1), 3);
    expect(r.record.exitPriceLamports).toBe('5');
    expect(r.detail).toMatchObject({ basis: 'tier-aware', drainPct: 58.9, bookedMultiple: 1 });
  });

  it('records what it replaced, so the change can be audited or undone', () => {
    const j = journalOf([{ id: 'id-1', entry: P, exit: P, reason: 'RUG_TRIGGER: vault drain 58.9%' }]);
    const { record } = restateRecord(rec(), j);
    expect(record.restated).toMatchObject({
      basis: 'tier-aware',
      drainPct: 58.9,
      from: { realizedMultiple: 1.0, realizedPnLUSD: 0, outcome: 'BREAKEVEN', exitPriceLamports: '32' },
    });
  });

  it('does not mutate the record it was given', () => {
    const original = rec();
    const snapshot = JSON.stringify(original);
    restateRecord(original, journalOf([{ id: 'id-1', entry: P, exit: P, reason: 'RUG_TRIGGER: vault drain 58.9%' }]));
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('keeps take-profit tiers that were already sold: only the remainder is repriced', () => {
    // 30% sold at 1.5x and 30% at 2.0x (banked 1.05); the other 40% was held at a last price of 2.2x entry
    const entry = 1e-7;
    const booked = 1.05 + 0.4 * 2.2; // 1.93
    const j = journalOf(
      [{ id: 'id-1', entry, exit: 2.2 * entry, reason: 'RUG_TRIGGER: vault drain 80.0%' }],
      [
        { positionId: 'id-1', tier: 1, pctClosed: 0.3 },
        { positionId: 'id-1', tier: 2, pctClosed: 0.3 },
      ]
    );
    const r = restateRecord(rec({ realizedMultiple: booked, realizedPnLUSD: 13.95, sizeUSD: 15 }), j);

    expect(r.detail!.basis).toBe('tier-aware');
    expect(r.record.realizedMultiple).toBeCloseTo(1.05 + 0.4 * 2.2 * 0.04, 6); // 1.0852
    expect(r.record.outcome).toBe('WIN'); // the banked part keeps it above breakeven
  });

  it('when the tiers do not reproduce the booked multiple, reprices the whole position and says so', () => {
    const entry = 1e-7;
    const j = journalOf([{ id: 'id-1', entry, exit: entry, reason: 'RUG_TRIGGER: vault drain 50.0%' }]);
    const r = restateRecord(rec({ realizedMultiple: 3.0 }), j); // no tier data can explain 3.0x at a 1.0x last price

    expect(r.detail!.basis).toBe('unverified');
    expect(r.record.realizedMultiple).toBeCloseTo(0.25, 6);
    expect(r.record.outcome).toBe('LOSS');
  });

  it('a 100% drain is capped, not zero', () => {
    const j = journalOf([{ id: 'id-1', entry: P, exit: P, reason: 'RUG_TRIGGER: vault drain 100.0%' }]);
    const r = restateRecord(rec(), j);
    expect(r.record.realizedMultiple).toBeCloseTo(1e-6, 9);
    expect(r.record.outcome).toBe('LOSS');
  });

  describe('records it leaves alone', () => {
    const j = journalOf([{ id: 'id-1', entry: P, exit: P, reason: 'RUG_TRIGGER: vault drain 58.9%' }]);

    it('other exit types', () => {
      const r = restateRecord(rec({ exitMode: 'HARD_STOP' }), j);
      expect(r.status).toBe('not-rug-trigger');
      expect(r.record.realizedMultiple).toBe(1.0);
    });

    it('a RUG_TRIGGER record with no journal row', () => {
      expect(restateRecord(rec({ id: 'other' }), j).status).toBe('no-journal-row');
    });

    it('a journal row whose reason has no drain size', () => {
      const none = journalOf([{ id: 'id-1', entry: P, exit: P, reason: 'RUG_TRIGGER: manual' }]);
      expect(restateRecord(rec(), none).status).toBe('no-drain-pct');
    });

    it.each([
      ['no entry price', { entry: undefined, exit: P }],
      ['a zero entry price', { entry: 0, exit: P }],
      ['no exit price', { entry: P, exit: undefined }],
    ])('missing prices: %s', (_name, prices) => {
      const bad = journalOf([{ id: 'id-1', reason: 'RUG_TRIGGER: vault drain 58.9%', ...prices }]);
      expect(restateRecord(rec(), bad).status).toBe('no-prices');
    });

    it('a record that was already restated (running the tool twice changes nothing)', () => {
      const once = restateRecord(rec(), j).record;
      const twice = restateRecord(once, j);
      expect(twice.status).toBe('already-restated');
      expect(twice.record).toBe(once);
    });
  });
});

// ── summaries ─────────────────────────────────────────────────────────

describe('summaries', () => {
  const records = [
    rec({ id: 'a', exitMode: 'TRAILING_STOP', outcome: 'WIN', realizedMultiple: 1.5, realizedPnLUSD: 10 }),
    rec({ id: 'b', exitMode: 'TRAILING_STOP', outcome: 'LOSS', realizedMultiple: 0.5, realizedPnLUSD: -4 }),
    rec({ id: 'c', exitMode: 'RUG_TRIGGER', outcome: 'WIN', realizedMultiple: 2.0, realizedPnLUSD: 20 }),
  ];

  it('groups by exit type, largest group first', () => {
    const s = summarizeByExitMode(records);
    expect(s.map((m) => m.exitMode)).toEqual(['TRAILING_STOP', 'RUG_TRIGGER']);
    expect(s[0]).toMatchObject({ trades: 2, avgMultiple: 1.0, totalPnLUSD: 6 });
  });

  it('gives the overall win rate, average multiple and PnL', () => {
    expect(overallSummary(records)).toMatchObject({ trades: 3, wins: 2, totalPnLUSD: 26 });
    expect(overallSummary(records).winRatePct).toBeCloseTo(66.67, 1);
    expect(overallSummary([])).toMatchObject({ trades: 0, winRatePct: 0, avgMultiple: 0, totalPnLUSD: 0 });
  });

  it('isAutonomousOnly is true only for a single AUTONOMOUS edge', () => {
    expect(isAutonomousOnly({ edgesFired: ['AUTONOMOUS'] })).toBe(true);
    expect(isAutonomousOnly({ edgesFired: ['AUTONOMOUS', 'SINGLE_WALLET'] })).toBe(false);
    expect(isAutonomousOnly({ edgesFired: ['SINGLE_WALLET'] })).toBe(false);
    expect(isAutonomousOnly({})).toBe(false);
  });
});

// ── files ─────────────────────────────────────────────────────────────

describe('against real files', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'restate-test-'));
  const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  async function makeJournal(dir: string): Promise<string> {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(
      'CREATE TABLE trades (id TEXT PRIMARY KEY, entryPriceSOL REAL, exitPriceSOL REAL, exitReason TEXT, peakMultiple REAL, realizedMultiple REAL)'
    );
    db.run('CREATE TABLE partial_closes (positionId TEXT, tier INTEGER, pctClosed REAL, exitPriceSOL REAL, exitTimestamp TEXT, exitMode TEXT)');
    db.run('INSERT INTO trades VALUES (?, ?, ?, ?, ?, ?)', ['id-1', P, P, 'RUG_TRIGGER: vault drain 58.9%', 1.0, 1.0]);
    db.run('INSERT INTO trades VALUES (?, ?, ?, ?, ?, ?)', ['id-2', 1e-7, 2.2e-7, 'RUG_TRIGGER: vault drain 80.0%', 2.2, 1.93]);
    db.run('INSERT INTO partial_closes VALUES (?, ?, ?, ?, ?, ?)', ['id-2', 1, 0.3, 1.5e-7, null, 'TP_TIER_1']);
    db.run('INSERT INTO partial_closes VALUES (?, ?, ?, ?, ?, ?)', ['id-2', 2, 0.3, 2e-7, null, 'TP_TIER_2']);
    const file = path.join(dir, 'journal.db');
    fs.writeFileSync(file, Buffer.from(db.export()));
    db.close();
    return file;
  }

  const trades = () => [
    rec({ id: 'id-1' }),
    rec({ id: 'id-2', realizedMultiple: 1.93, realizedPnLUSD: 13.95, outcome: 'WIN' }),
    rec({ id: 'id-3', exitMode: 'TRAILING_STOP', outcome: 'WIN', realizedMultiple: 1.2, realizedPnLUSD: 3 }),
  ];

  it('readJournal reads rows and tier sales, and leaves the journal byte-for-byte unchanged', async () => {
    const dir = tmp();
    const journal = await makeJournal(dir);
    const before = sha(journal);
    const mtime = fs.statSync(journal).mtimeMs;

    const data = await readJournal(journal);
    expect(data.rows.get('id-1')).toMatchObject({ exitReason: 'RUG_TRIGGER: vault drain 58.9%', exitPriceSOL: P });
    expect(data.partials.get('id-2')).toHaveLength(2);

    expect(sha(journal)).toBe(before);
    expect(fs.statSync(journal).mtimeMs).toBe(mtime);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readJournal copes with an older journal that has no partial_closes table', async () => {
    const dir = tmp();
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE trades (id TEXT PRIMARY KEY, entryPriceSOL REAL, exitPriceSOL REAL, exitReason TEXT, peakMultiple REAL, realizedMultiple REAL)');
    const file = path.join(dir, 'old.db');
    fs.writeFileSync(file, Buffer.from(db.export()));
    db.close();
    const data = await readJournal(file);
    expect(data.partials.size).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('restateTrades restates the RUG_TRIGGER records, counts every outcome, and never touches the inputs', async () => {
    const dir = tmp();
    const journal = await makeJournal(dir);
    const tradesFile = path.join(dir, 'paperTrades.json');
    fs.writeFileSync(tradesFile, JSON.stringify(trades()));
    const before = [sha(journal), sha(tradesFile)];

    const run = await restateTrades(tradesFile, journal);

    expect(run.counts).toMatchObject({ restated: 2, 'not-rug-trigger': 1 });
    expect(run.restated.find((r) => r.id === 'id-1').outcome).toBe('LOSS');
    expect(run.restated.find((r) => r.id === 'id-2').outcome).toBe('WIN'); // tier sales kept
    expect(run.restated.find((r) => r.id === 'id-3')).toEqual(run.original.find((r) => r.id === 'id-3'));
    expect(run.original.find((r) => r.id === 'id-1').outcome).toBe('BREAKEVEN'); // the input objects are intact
    expect([sha(journal), sha(tradesFile)]).toEqual(before);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps an object-shaped trades file ({ trades: [...] }) in the same shape', async () => {
    const dir = tmp();
    const journal = await makeJournal(dir);
    const tradesFile = path.join(dir, 'paperTrades.json');
    fs.writeFileSync(tradesFile, JSON.stringify({ version: 2, trades: trades() }));
    const run = await restateTrades(tradesFile, journal);
    expect((run.restatedJson as any).version).toBe(2);
    expect(Array.isArray((run.restatedJson as any).trades)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writeRestated writes a new file, and refuses to overwrite its source', async () => {
    const dir = tmp();
    const source = path.join(dir, 'paperTrades.json');
    fs.writeFileSync(source, '[]');
    const out = path.join(dir, 'nested', 'paperTrades.restated.json');

    writeRestated(out, source, [{ id: 'x' }]);
    expect(JSON.parse(fs.readFileSync(out, 'utf-8'))).toEqual([{ id: 'x' }]);
    expect(fs.readdirSync(path.dirname(out)).filter((f) => f.includes('.tmp-'))).toEqual([]);

    expect(() => writeRestated(source, source, [])).toThrow(/Refusing to overwrite/);
    expect(fs.readFileSync(source, 'utf-8')).toBe('[]');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('running the restated output through the tool again restates nothing more', async () => {
    const dir = tmp();
    const journal = await makeJournal(dir);
    const tradesFile = path.join(dir, 'paperTrades.json');
    fs.writeFileSync(tradesFile, JSON.stringify(trades()));
    const first = await restateTrades(tradesFile, journal);

    const restatedFile = path.join(dir, 'paperTrades.restated.json');
    writeRestated(restatedFile, tradesFile, first.restatedJson);
    const second = await restateTrades(restatedFile, journal);
    expect(second.counts.restated).toBe(0);
    expect(second.counts['already-restated']).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gateView evaluates a throwaway copy and leaves no file behind', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('restate-gate-')).length;
    const view = await gateView(trades());
    expect(view.completedTrades).toBe(3);
    expect(view.gateUnlocked).toBe(false);
    expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('restate-gate-')).length).toBe(before);
  });
});
