import fs from 'fs';
import os from 'os';
import path from 'path';
import { PaperTradeGate } from '../src/calibration/paperTrader';

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function group(p: number, wins: number, losses: number): any[] {
  const base = { mode: 'PAPER', tokenCA: 't', predictedWP: p, sizeUSD: 50, signal: { totalScore: 8 }, edgesFired: ['AUTONOMOUS'] };
  return [
    ...Array.from({ length: wins }, (_, i) => ({ ...base, id: `w${p}-${i}`, outcome: 'WIN', realizedMultiple: 2.0 })),
    ...Array.from({ length: losses }, (_, i) => ({ ...base, id: `l${p}-${i}`, outcome: 'LOSS', realizedMultiple: 0.6 })),
  ];
}

async function gateFor(trades: any[], minAuc?: number): Promise<PaperTradeGate> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')), 'paperTrades.json');
  fs.writeFileSync(file, JSON.stringify(trades));
  return PaperTradeGate.load(file, minAuc === undefined ? {} : { minAuc });
}

const wpReasons = (g: PaperTradeGate) => g.getStatus().blockedReasons.filter((r) => r.startsWith('WP'));

// calibrated (each bucket wins at about its own rate) and discriminating, positive EV, 60 trades
const GOOD = () => [...group(0.15, 3, 17), ...group(0.55, 11, 9), ...group(0.85, 17, 3)];

describe('paper gate win-probability checks', () => {
  it('unlocks when the model is calibrated AND discriminates, with enough trades and positive EV', async () => {
    const s = (await gateFor(GOOD())).getStatus();
    expect(s.blockedReasons).toEqual([]);
    expect(s.gateUnlocked).toBe(true);
    expect(s.wpCalibrationError).toBeLessThanOrEqual(0.15);
    expect(s.wpAuc).toBeGreaterThanOrEqual(0.65);
  });

  it('blocks a model that ranks nothing (constant prediction) even though its calibration looks fine', async () => {
    const g = await gateFor(group(0.5, 30, 30));
    const reasons = wpReasons(g).join(' | ');
    expect(g.getStatus().wpAuc).toBe(0.5);
    expect(reasons).toMatch(/AUC/);
    expect(g.getStatus().gateUnlocked).toBe(false);
  });

  it('blocks a model that ranks well but is badly calibrated', async () => {
    // winners get 0.95, losers 0.85, plus a calibrated middle group: ranks well, buckets are far off
    const g = await gateFor([...group(0.95, 30, 0), ...group(0.85, 0, 30), ...group(0.55, 11, 9)]);
    const reasons = wpReasons(g).join(' | ');
    expect(reasons).toMatch(/calibration gap/);
    expect(g.getStatus().gateUnlocked).toBe(false);
  });

  it('says so when there are too few wins or losses to judge', async () => {
    const g = await gateFor(group(0.8, 55, 5));
    expect(wpReasons(g).join(' | ')).toMatch(/at least 10 wins and 10 losses/);
    expect(g.getStatus().gateUnlocked).toBe(false);
  });

  it('says so when calibration cannot be measured because predictions sit in too few buckets', async () => {
    const g = await gateFor([...group(0.9, 25, 5), ...group(0.1, 5, 25)]);
    expect(wpReasons(g).join(' | ')).toMatch(/can't be measured yet/);
  });

  it('honours the configured AUC minimum', async () => {
    const strict = await gateFor(GOOD(), 0.99);
    expect(wpReasons(strict).join(' | ')).toMatch(/AUC/);
    expect(strict.getStatus().gateUnlocked).toBe(false);
  });

  it('still reports the legacy MAE, and it no longer decides the outcome', async () => {
    const s = (await gateFor(GOOD())).getStatus();
    expect(typeof s.wpCalibrationAccuracy).toBe('number');
    expect(s.wpCalibrationAccuracy).toBeGreaterThan(0.15); // would have blocked under the old rule
    expect(s.gateUnlocked).toBe(true);
  });

  it('still blocks on negative EV and on too few trades', async () => {
    const losing = GOOD().map((t) => ({ ...t, realizedMultiple: t.outcome === 'WIN' ? 1.1 : 0.4 }));
    expect((await gateFor(losing)).getStatus().blockedReasons.join(' | ')).toMatch(/Negative EV/);
    expect((await gateFor(GOOD().slice(0, 20))).getStatus().blockedReasons.join(' | ')).toMatch(/more trades/);
  });
});

describe('margin rule: the AUC must beat random with confidence, not just pass the minimum', () => {
  // calibrated in every bucket, so only the discrimination checks can block it.
  // AUC is about 0.63 on 60 trades, so its 95% lower bound is just under 0.5.
  const MARGINAL = () => [...group(0.35, 7, 13), ...group(0.55, 11, 9), ...group(0.65, 13, 7)];

  it('blocks a point estimate that clears a lower minimum but whose lower bound does not clear 0.5', async () => {
    const g = await gateFor(MARGINAL(), 0.5); // point estimate passes this minimum
    const s = g.getStatus();
    expect(s.wpAuc).toBeGreaterThanOrEqual(0.5);
    expect(s.wpAucLower95).toBeLessThanOrEqual(0.5);
    expect(s.blockedReasons).toHaveLength(1);
    expect(s.blockedReasons[0]).toMatch(/isn't reliably better than random/);
    expect(s.gateUnlocked).toBe(false);
  });

  it('reports both reasons when the point estimate is also under the configured minimum', async () => {
    const reasons = (await gateFor(MARGINAL())).getStatus().blockedReasons.join(' | ');
    expect(reasons).toMatch(/AUC\) 0\.\d+ is below 0\.65/);
    expect(reasons).toMatch(/isn't reliably better than random/);
  });

  it('passes when both the point estimate and the lower bound clear their thresholds', async () => {
    const s = (await gateFor(GOOD())).getStatus();
    expect(s.wpAuc).toBeGreaterThanOrEqual(0.65);
    expect(s.wpAucLower95).toBeGreaterThan(0.5);
    expect(s.gateUnlocked).toBe(true);
  });
});
