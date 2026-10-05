import { usableEntryPrice } from '../src/position/entryPrice';
import { PositionManager } from '../src/position/positionManager';
import { TradeSignal, SurvivalSnapshot } from '../src/core/types';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('usableEntryPrice', () => {
  it.each([3e-8, 4e-7, 9.99e-7, 1e-6, 0.0025])('keeps a real price of %p unchanged (no floor)', (p) => {
    expect(usableEntryPrice(p)).toBe(p);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])('returns 0 (unknown) for unusable price %p', (p) => {
    expect(usableEntryPrice(p)).toBe(0);
  });
});

describe('a real sub-1e-6 entry price is kept as the basis', () => {
  const config = {
    mode: 'PAPER' as const,
    maxConcurrent: 5,
    maxTradesPerDay: 20,
    capitalUSD: 1000,
    sizePct: 0.05,
    solPriceUSD: 150,
    maxHoldMs: 180_000,
    stopLossPct: 0.4,
    tightStopWindowMs: 10_000,
    tightStopPct: 0.25,
  };
  const survival: SurvivalSnapshot = {
    state: 'NORMAL',
    dailyPnLPct: 0,
    weeklyPnLPct: 0,
    consecutiveLosses: 0,
    sizeMultiplier: 1.0,
    highVarianceEnabled: true,
    message: '',
  };

  function signal(entryPriceSOL: number): TradeSignal {
    return {
      tokenCA: 'token-sub-floor',
      source: 'SINGLE_WALLET',
      triggerWallet: 'wallet1',
      walletTier: 'A',
      walletPnL30d: 5,
      convictionSOL: 1,
      clusterWallets: [],
      clusterSize: 1,
      totalClusterSOL: 1,
      entryPriceSOL,
      timestamp: new Date(),
      slot: 1,
      score: 7,
      confidence: 0.8,
    };
  }

  it('measures multiples against the real entry, not a 1e-6 placeholder', () => {
    const pm = new PositionManager(config);
    const real = 4e-7; // below the old 1e-6 floor
    pm.openTrade(signal(usableEntryPrice(real)), survival);

    const pos = pm.getOpenPositions()[0];
    expect(pos.entryPriceSOL).toBe(real);
    expect(pos.entryPriceBasis).toBe('OPEN_PRICE');

    // A flat tick is a 1.0x move against the real entry. Against the old
    // placeholder it would have read 0.4x and tripped the stop immediately.
    pm.updatePrice('token-sub-floor', real);
    expect(pm.getOpenPositions()).toHaveLength(1);
    expect(pm.getClosedPositions()).toHaveLength(0);
  });

  it('still stops out on a genuine drop from the real entry', () => {
    const pm = new PositionManager(config);
    const real = 4e-7;
    pm.openTrade(signal(usableEntryPrice(real)), survival);
    pm.updatePrice('token-sub-floor', real * 0.7); // -30% inside the 10s window
    const closed = pm.getClosedPositions();
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toMatch(/^EARLY_STOP/);
    expect(closed[0].realizedMultiple).toBeCloseTo(0.7, 5);
  });
});
