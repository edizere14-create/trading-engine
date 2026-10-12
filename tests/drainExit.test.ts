import { estimateDrainExitPrice } from '../src/position/drainExit';
import { PositionManager } from '../src/position/positionManager';
import { TradeSignal, SurvivalSnapshot } from '../src/core/types';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('estimateDrainExitPrice', () => {
  it('the 58.9% drain from the real trade: about 0.17x of the last price', () => {
    const price = estimateDrainExitPrice(3.2137e-8, 58.9)!;
    expect(price / 3.2137e-8).toBeCloseTo(0.4110 ** 2, 4); // 0.1689
  });

  it('scales with the square of what is left of the SOL side', () => {
    expect(estimateDrainExitPrice(1, 40)! ).toBeCloseTo(0.36, 10); // the smallest drain the vault stream reports
    expect(estimateDrainExitPrice(1, 50)! ).toBeCloseTo(0.25, 10);
    expect(estimateDrainExitPrice(1, 90)! ).toBeCloseTo(0.01, 10);
  });

  it('caps a total drain instead of returning zero (a zero price is treated as "no price")', () => {
    expect(estimateDrainExitPrice(1, 100)!).toBeCloseTo(1e-6, 12);
    expect(estimateDrainExitPrice(1, 250)!).toBeCloseTo(1e-6, 12);
  });

  it.each([
    [0, 50],
    [-1, 50],
    [NaN, 50],
    [Infinity, 50],
    [1, 0],
    [1, -5],
    [1, NaN],
  ])('returns undefined for lastPrice=%p dropPct=%p so the caller keeps its old fallback', (price, drop) => {
    expect(estimateDrainExitPrice(price, drop)).toBeUndefined();
  });
});

describe('a RUG_TRIGGER exit at the estimated price is booked as the loss it is', () => {
  const survival: SurvivalSnapshot = {
    state: 'NORMAL',
    dailyPnLPct: 0,
    weeklyPnLPct: 0,
    consecutiveLosses: 0,
    sizeMultiplier: 1.0,
    highVarianceEnabled: true,
    message: '',
  };
  const signal: TradeSignal = {
    tokenCA: 'tok-rug',
    source: 'AUTONOMOUS',
    poolAddress: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    triggerWallet: 'deployer',
    walletTier: 'B',
    walletPnL30d: 0,
    convictionSOL: 67.4,
    clusterWallets: [],
    clusterSize: 1,
    totalClusterSOL: 67.4,
    entryPriceSOL: 0,
    timestamp: new Date(),
    slot: 1,
    score: 10,
    confidence: 1,
  };
  const newManager = () =>
    new PositionManager({
      mode: 'PAPER',
      maxConcurrent: 5,
      maxTradesPerDay: 20,
      capitalUSD: 1000,
      sizePct: 0.05,
      solPriceUSD: 150,
      maxHoldMs: 180_000,
      stopLossPct: 0.6,
      tightStopWindowMs: 10_000,
      tightStopPct: 0.25,
    });

  it('before: closing without a price booked the drain as breakeven', () => {
    const pm = newManager();
    pm.openTrade(signal, survival);
    pm.updatePrice('tok-rug', 3.2137e-8, 'pool'); // anchors the entry
    pm.forceClose('tok-rug', 'RUG_TRIGGER: vault drain 58.9%', undefined);
    const closed = pm.getClosedPositions()[0];
    expect(closed.realizedMultiple).toBeCloseTo(1, 6);
    expect(closed.outcome).toBe('BREAKEVEN');
  });

  it('after: the estimated exit price books about 0.17x, a LOSS', () => {
    const pm = newManager();
    pm.openTrade(signal, survival);
    pm.updatePrice('tok-rug', 3.2137e-8, 'pool');
    const open = pm.getOpenPositions()[0];
    const exit = estimateDrainExitPrice(open.lastPriceSOL, 58.9);
    pm.forceClose('tok-rug', 'RUG_TRIGGER: vault drain 58.9%', exit);
    const closed = pm.getClosedPositions()[0];
    expect(closed.realizedMultiple).toBeCloseTo(0.4110 ** 2, 4);
    expect(closed.outcome).toBe('LOSS');
    expect(closed.realizedPnLSOL!).toBeLessThan(0);
  });
});
