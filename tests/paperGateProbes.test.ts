import fs from 'fs';
import os from 'os';
import path from 'path';
import { PaperTradeGate } from '../src/calibration/paperTrader';
import { PositionManager } from '../src/position/positionManager';
import { TradeSignal, SurvivalSnapshot } from '../src/core/types';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function rec(over: Record<string, unknown>): any {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    mode: 'PAPER',
    tokenCA: 'tok',
    outcome: 'WIN',
    realizedMultiple: 1.5,
    predictedWP: 0.6,
    sizeUSD: 50,
    signal: { totalScore: 8 },
    edgesFired: ['AUTONOMOUS'],
    ...over,
  };
}

async function gateFor(trades: any[]): Promise<PaperTradeGate> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')), 'paperTrades.json');
  fs.writeFileSync(file, JSON.stringify(trades));
  return PaperTradeGate.load(file);
}

describe('PaperTradeGate ignores $1 probes in its statistics', () => {
  it('counts only real trades toward the total, win rate and EV', async () => {
    const gate = await gateFor([
      rec({ outcome: 'WIN', realizedMultiple: 2.0 }),
      rec({ outcome: 'WIN', realizedMultiple: 1.5 }),
      rec({ outcome: 'LOSS', realizedMultiple: 0.5 }),
      rec({ outcome: 'LOSS', realizedMultiple: 0.3, sizeUSD: 1, isProbe: true }),
      rec({ outcome: 'LOSS', realizedMultiple: 0.2, sizeUSD: 1, isProbe: true }),
    ]);
    const s = gate.getStatus();
    expect(s.completedTrades).toBe(3);
    expect(s.actualWinRate).toBeCloseTo(2 / 3, 5);
    expect(s.actualEV).toBeCloseTo((2.0 + 1.5 + 0.5) / 3 - 1, 5);
  });

  it('detects probes recorded before the flag existed, by size', async () => {
    const gate = await gateFor([
      rec({ outcome: 'WIN', realizedMultiple: 2.0 }),
      rec({ outcome: 'LOSS', realizedMultiple: 0.3, sizeUSD: 1 }), // legacy probe, no isProbe field
    ]);
    expect(gate.getStatus().completedTrades).toBe(1);
  });

  it('leaves the statistics unchanged when there are no probes', async () => {
    const gate = await gateFor([
      rec({ outcome: 'WIN', realizedMultiple: 2.0 }),
      rec({ outcome: 'LOSS', realizedMultiple: 0.5 }),
    ]);
    const s = gate.getStatus();
    expect(s.completedTrades).toBe(2);
    expect(s.actualWinRate).toBeCloseTo(0.5, 5);
  });

  it('a gate made only of probes has no completed trades', async () => {
    const gate = await gateFor([rec({ sizeUSD: 1, isProbe: true }), rec({ sizeUSD: 1 })]);
    expect(gate.getStatus().completedTrades).toBe(0);
  });
});

describe('the probe flag travels from the signal to the position', () => {
  const config = {
    mode: 'PAPER' as const, maxConcurrent: 5, maxTradesPerDay: 20, capitalUSD: 1000, sizePct: 0.05,
    solPriceUSD: 150, maxHoldMs: 180_000, stopLossPct: 0.4, tightStopWindowMs: 10_000, tightStopPct: 0.25,
  };
  const survival: SurvivalSnapshot = {
    state: 'NORMAL', dailyPnLPct: 0, weeklyPnLPct: 0, consecutiveLosses: 0, sizeMultiplier: 1,
    highVarianceEnabled: true, message: '',
  };
  const signal = (isProbe?: boolean): TradeSignal => ({
    tokenCA: `t-${Math.random().toString(36).slice(2)}`, source: 'AUTONOMOUS', triggerWallet: 'w', walletTier: 'A',
    walletPnL30d: 0, convictionSOL: 1, clusterWallets: [], clusterSize: 1, totalClusterSOL: 1,
    entryPriceSOL: 4e-7, timestamp: new Date(), slot: 1, score: 7, confidence: 0.8, isProbe,
  });

  it('marks a probe position, and leaves a normal one unmarked', () => {
    const pm = new PositionManager(config);
    pm.openTrade(signal(true), survival);
    pm.openTrade(signal(), survival);
    const [probe, normal] = pm.getOpenPositions();
    expect(probe.isProbe).toBe(true);
    expect(normal.isProbe).toBeUndefined();
  });
});
