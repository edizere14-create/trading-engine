import { TradeJournal } from '../src/journal/tradeJournal';
import { PartialClose } from '../src/journal/journalTypes';
import os from 'os';
import path from 'path';
import fs from 'fs';

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('TradeJournal — partial_closes', () => {
  let journal: TradeJournal;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `partial-closes-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    journal = new TradeJournal(dbPath);
    await journal.waitReady();
  });

  afterEach(() => {
    journal.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('records and reads back a single partial close with all fields', () => {
    const pc: PartialClose = {
      positionId: 'pos-1',
      tier: 1,
      pctClosed: 0.30,
      exitPriceSOL: 0.0000015,
      exitTimestamp: new Date('2026-01-01T00:00:00.000Z'),
      exitMode: 'TP_TIER_1',
    };
    journal.recordPartialClose(pc);
    const rows = journal.getPartialCloses('pos-1');
    expect(rows.length).toBe(1);
    expect(rows[0].positionId).toBe('pos-1');
    expect(rows[0].tier).toBe(1);
    expect(rows[0].pctClosed).toBeCloseTo(0.30);
    expect(rows[0].exitPriceSOL).toBeCloseTo(0.0000015);
    expect(rows[0].exitTimestamp?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(rows[0].exitMode).toBe('TP_TIER_1');
  });

  it('records multiple tiers for one position and returns them in tier order', () => {
    const base = {
      positionId: 'pos-2',
      pctClosed: 0.25,
      exitPriceSOL: 0.000002,
      exitTimestamp: new Date('2026-01-01T00:00:00.000Z'),
    };
    journal.recordPartialClose({ ...base, tier: 3, exitMode: 'TP_TIER_3' });
    journal.recordPartialClose({ ...base, tier: 1, exitMode: 'TP_TIER_1' });
    journal.recordPartialClose({ ...base, tier: 2, exitMode: 'TP_TIER_2' });
    const rows = journal.getPartialCloses('pos-2');
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.tier)).toEqual([1, 2, 3]);
  });

  it('replaces rather than duplicates on same (positionId, tier)', () => {
    journal.recordPartialClose({ positionId: 'pos-3', tier: 1, pctClosed: 0.30, exitMode: 'TP_TIER_1' });
    journal.recordPartialClose({ positionId: 'pos-3', tier: 1, pctClosed: 0.40, exitMode: 'TP_TIER_1' });
    const rows = journal.getPartialCloses('pos-3');
    expect(rows.length).toBe(1);
    expect(rows[0].pctClosed).toBeCloseTo(0.40);
  });

  it('returns empty array for a position with no partial closes', () => {
    const rows = journal.getPartialCloses('nonexistent');
    expect(rows).toEqual([]);
  });

  it('isolates partial closes by positionId', () => {
    journal.recordPartialClose({ positionId: 'pos-A', tier: 1, pctClosed: 0.30, exitMode: 'TP_TIER_1' });
    journal.recordPartialClose({ positionId: 'pos-B', tier: 1, pctClosed: 0.50, exitMode: 'TP_TIER_1' });
    expect(journal.getPartialCloses('pos-A').length).toBe(1);
    expect(journal.getPartialCloses('pos-B').length).toBe(1);
    expect(journal.getPartialCloses('pos-A')[0].pctClosed).toBeCloseTo(0.30);
  });
});
