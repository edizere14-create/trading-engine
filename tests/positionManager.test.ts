import { PositionManager } from '../src/position/positionManager';
import { TradeSignal, SurvivalSnapshot } from '../src/core/types';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const baseConfig = {
  mode: 'PAPER' as const,
  maxConcurrent: 5,
  maxTradesPerDay: 20,
  capitalUSD: 1000,
  sizePct: 0.05,
  solPriceUSD: 150,
  maxHoldMs: 180_000,
  stopLossPct: 0.40,
};

const healthySurvival: SurvivalSnapshot = {
  state: 'NORMAL',
  dailyPnLPct: 0,
  weeklyPnLPct: 0,
  consecutiveLosses: 0,
  sizeMultiplier: 1.0,
  highVarianceEnabled: true,
  message: '',
};

function makeSignal(entryPriceSOL: number): TradeSignal {
  return {
    tokenCA: `token-${Math.random().toString(36).slice(2)}`,
    source: 'AUTONOMOUS',
    triggerWallet: 'wallet1',
    walletTier: 'A',
    walletPnL30d: 5,
    convictionSOL: 1,
    clusterWallets: [],
    clusterSize: 1,
    totalClusterSOL: 1,
    entryPriceSOL,
    timestamp: new Date(),
    slot: 1000,
    score: 7,
    confidence: 0.8,
  };
}

describe('PositionManager — entry price invariants', () => {
  let pm: PositionManager;

  beforeEach(() => {
    pm = new PositionManager(baseConfig);
  });

  describe('openTrade with non-zero entry price', () => {
    it('sets priceBasisInvalid=false and entryPriceBasis=OPEN_PRICE', () => {
      const signal = makeSignal(0.000001);
      pm.openTrade(signal, healthySurvival);
      const pos = pm.getOpenPositions()[0];
      expect(pos.priceBasisInvalid).toBe(false);
      expect(pos.entryPriceBasis).toBe('OPEN_PRICE');
    });
  });

  describe('openTrade with zero entry price', () => {
    it('sets priceBasisInvalid=true and entryPriceBasis=undefined', () => {
      const signal = makeSignal(0);
      pm.openTrade(signal, healthySurvival);
      const pos = pm.getOpenPositions()[0];
      expect(pos.priceBasisInvalid).toBe(true);
      expect(pos.entryPriceBasis).toBeUndefined();
    });

    it('does not evaluate exits while unanchored', () => {
      const signal = makeSignal(0);
      pm.openTrade(signal, healthySurvival);
      const { tokenCA } = signal;
      // A price that would normally hit hard-stop if entry were 0.000001
      pm.updatePrice(tokenCA, 0.0000001);
      expect(pm.getOpenPositions().find(p => p.tokenCA === tokenCA)?.status).toBe('OPEN');
    });
  });

  describe('updatePrice anchoring', () => {
    it('anchors entry on first valid tick and does not close on that tick', () => {
      const signal = makeSignal(0);
      pm.openTrade(signal, healthySurvival);
      const { tokenCA } = signal;
      const anchorPrice = 0.000001;
      pm.updatePrice(tokenCA, anchorPrice);
      const pos = pm.getOpenPositions().find(p => p.tokenCA === tokenCA);
      expect(pos).toBeDefined();
      expect(pos!.entryPriceSOL).toBe(anchorPrice);
      expect(pos!.entryPriceBasis).toBe('FIRST_TICK');
      expect(pos!.priceBasisInvalid).toBe(false);
    });

    it('evaluates exits normally after anchoring', () => {
      const signal = makeSignal(0);
      pm.openTrade(signal, healthySurvival);
      const { tokenCA } = signal;
      pm.updatePrice(tokenCA, 0.000001);           // anchor tick
      pm.updatePrice(tokenCA, 0.0000001);          // 10x drawdown — should hit hard stop
      const closed = pm.getClosedPositions();
      expect(closed.length).toBe(1);
      expect(closed[0].tokenCA).toBe(tokenCA);
    });

    it('peakPriceSOL and lastPriceSOL are set on anchor tick', () => {
      const signal = makeSignal(0);
      pm.openTrade(signal, healthySurvival);
      const { tokenCA } = signal;
      pm.updatePrice(tokenCA, 0.000005);
      const pos = pm.getOpenPositions().find(p => p.tokenCA === tokenCA);
      expect(pos!.peakPriceSOL).toBe(0.000005);
      expect(pos!.lastPriceSOL).toBe(0.000005);
    });
  });
});
