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

  describe('trailing stop', () => {
    it('triggers at 25% retrace from peak when peak >= 1.15x (regression: would not have triggered under old logic)', () => {
      const signal = makeSignal(0);
      pm.openTrade(signal, healthySurvival);
      const { tokenCA } = signal;
      pm.updatePrice(tokenCA, 0.000001);   // anchor: entry = 1.0x
      pm.updatePrice(tokenCA, 0.0000014);  // peak: 1.4x (above 1.15x activation; old logic required > 1.5x)
      pm.updatePrice(tokenCA, 0.000001);   // retrace to 1.0x; trail floor = 1.4 * 0.75 = 1.05x, so 1.0 <= 1.05 triggers
      const closed = pm.getClosedPositions();
      expect(closed.length).toBe(1);
      expect(closed[0].tokenCA).toBe(tokenCA);
      expect(closed[0].exitReason).toContain('TRAILING_STOP');
      expect(closed[0].exitReason).toContain('peak 1.40x');
      expect(closed[0].exitReason).toContain('trail floor 1.05x');
    });

    it('triggers at 25% retrace from a higher peak (peak 3x retrace to 1.4x; new triggers, old would not)', () => {
      const signal = makeSignal(0);
      pm.openTrade(signal, healthySurvival);
      const { tokenCA } = signal;
      pm.updatePrice(tokenCA, 0.000001);   // anchor: entry = 1.0x
      pm.updatePrice(tokenCA, 0.000003);   // peak: 3.0x (triggers tier markers but does not close)
      pm.updatePrice(tokenCA, 0.0000014);  // retrace to 1.4x; trail floor = 3.0 * 0.75 = 2.25x, so 1.4 <= 2.25 triggers
      const closed = pm.getClosedPositions();
      expect(closed.length).toBe(1);
      expect(closed[0].tokenCA).toBe(tokenCA);
      expect(closed[0].exitReason).toContain('TRAILING_STOP');
      expect(closed[0].exitReason).toContain('peak 3.00x');
      expect(closed[0].exitReason).toContain('trail floor 2.25x');
    });

    it('does not trigger when peak below 1.15x activation threshold', () => {
      const signal = makeSignal(0);
      pm.openTrade(signal, healthySurvival);
      const { tokenCA } = signal;
      pm.updatePrice(tokenCA, 0.000001);    // anchor: entry = 1.0x
      pm.updatePrice(tokenCA, 0.00000114);  // peak: 1.14x (below 1.15x activation)
      pm.updatePrice(tokenCA, 0.00000086);  // retrace to 0.86x; trailing not active (peak 1.14x < 1.15x) and above hard stop, so nothing fires
      const closed = pm.getClosedPositions();
      expect(closed.length).toBe(0);
      const open = pm.getOpenPositions().find(p => p.tokenCA === tokenCA);
      expect(open).toBeDefined();
    });
  });
});

describe('PositionManager — weighted realizedMultiple (tiered exits)', () => {
  let pm: PositionManager;

  beforeEach(() => {
    pm = new PositionManager(baseConfig);
  });

  const ENTRY = 0.000001;

  it('all four tiers trigger → weighted realizedMultiple 2.65x', () => {
    const signal = makeSignal(0);
    pm.openTrade(signal, healthySurvival);
    const { tokenCA } = signal;
    pm.updatePrice(tokenCA, ENTRY);          // anchor
    pm.updatePrice(tokenCA, ENTRY * 1.5);    // tier 1
    pm.updatePrice(tokenCA, ENTRY * 2.0);    // tier 2
    pm.updatePrice(tokenCA, ENTRY * 3.0);    // tier 3
    pm.updatePrice(tokenCA, ENTRY * 5.0);    // tier 4 → terminal TP_TIER_4
    const closed = pm.getClosedPositions();
    expect(closed.length).toBe(1);
    expect(closed[0].realizedMultiple).toBeCloseTo(2.65, 4);
    expect(closed[0].exitReason).toContain('TP_TIER_4');
  });

  it('1 tier then trailing stop at 1.2x → weighted realizedMultiple 1.29x', () => {
    const signal = makeSignal(0);
    pm.openTrade(signal, healthySurvival);
    const { tokenCA } = signal;
    pm.updatePrice(tokenCA, ENTRY);          // anchor
    pm.updatePrice(tokenCA, ENTRY * 1.6);    // tier 1 triggers, peak = 1.6x
    pm.updatePrice(tokenCA, ENTRY * 1.2);    // trailing stop: 1.2 <= 1.6*0.75
    const closed = pm.getClosedPositions();
    expect(closed.length).toBe(1);
    expect(closed[0].realizedMultiple).toBeCloseTo(1.29, 4);
    expect(closed[0].exitReason).toContain('TRAILING_STOP');
  });

  it('2 tiers then terminal exit at 0.40x → weighted realizedMultiple 1.21x', () => {
    const signal = makeSignal(0);
    pm.openTrade(signal, healthySurvival);
    const { tokenCA } = signal;
    pm.updatePrice(tokenCA, ENTRY);          // anchor
    pm.updatePrice(tokenCA, ENTRY * 2.0);    // tiers 1 and 2 trigger, peak = 2.0x
    pm.updatePrice(tokenCA, ENTRY * 0.4);    // terminal exit at 0.40x (a low-tenure stop)
    const closed = pm.getClosedPositions();
    expect(closed.length).toBe(1);
    expect(closed[0].realizedMultiple).toBeCloseTo(1.21, 4);
    // The 0.40x tick trips HARD_STOP (0.40 <= 1 - stopLossPct). We assert the
    // weighted multiple rather than the exit reason: the multiple is what this
    // test verifies, and it's 0.40x at the terminal regardless.
  });
});
