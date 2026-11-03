import { PositionManager } from '../src/position/positionManager';
import { TradeSignal, SurvivalSnapshot } from '../src/core/types';
import { bus } from '../src/core/eventBus';
import { logger } from '../src/core/logger';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const priceChecks = () =>
  (bus.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'position:priceCheck').map((c) => c[1]);
const infoCalls = () => (logger.info as jest.Mock).mock.calls as [string, Record<string, unknown>][];
const closedLogs = () => infoCalls().filter(([msg]) => msg === 'Trade CLOSED').map(([, meta]) => meta);
const deferredLogs = () => infoCalls().filter(([msg]) => msg.startsWith('Poller price deferred')).map(([, meta]) => meta);

const baseConfig = {
  mode: 'PAPER' as const,
  maxConcurrent: 5,
  maxTradesPerDay: 50,
  capitalUSD: 1000,
  sizePct: 0.05,
  solPriceUSD: 150,
  maxHoldMs: 600_000,
  stopLossPct: 0.6,
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
const graduation = (tokenCA: string): TradeSignal => ({
  tokenCA,
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
});

const ENTRY = 100e-9;

describe('poller guard: a poller price far from the on-chain price is not applied; the pool is asked to re-read', () => {
  let pm: PositionManager;
  const open = (tokenCA: string, over: Record<string, number> = {}, anchorSource = 'pool') => {
    pm = new PositionManager({ ...baseConfig, pollerGuardPct: 25, ...over });
    expect(pm.openTrade(graduation(tokenCA), survival)).toBe(true);
    pm.updatePrice(tokenCA, ENTRY, anchorSource); // anchors the entry on an on-chain price
  };
  const lastPrice = () => pm.getOpenPositions()[0].lastPriceSOL;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-02T19:24:30.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  describe('the two real exits: the pool had been quiet just over 2s when the poller said -88% / -90%', () => {
    it('with only the freshness rule (2000 ms), the poller price got through and closed the position', () => {
      open('tok-a', { pollerGuardPct: 0, onChainPriceFreshMs: 2_000 });
      jest.advanceTimersByTime(2_200); // the last pool tick is now just past the window
      pm.updatePrice('tok-a', ENTRY * 0.12, 'poller:dex');
      expect(pm.hasPosition('tok-a')).toBe(false); // the failure this guard exists for
    });

    it('with the guard, the same poller price is not applied and the pool is asked to re-read', () => {
      open('tok-b', { onChainPriceFreshMs: 2_000 });
      jest.advanceTimersByTime(2_200);
      pm.updatePrice('tok-b', ENTRY * 0.12, 'poller:dex');

      expect(pm.hasPosition('tok-b')).toBe(true);
      expect(lastPrice()).toBe(ENTRY);
      expect(priceChecks()).toEqual([{ tokenCA: 'tok-b' }]);
    });

    it('if the pool then reports a real fall, the position is stopped at the pool price', () => {
      open('tok-c');
      jest.advanceTimersByTime(2_200);
      pm.updatePrice('tok-c', ENTRY * 0.12, 'poller:dex'); // deferred
      pm.updatePrice('tok-c', ENTRY * 0.12, 'pool'); // the fresh read confirms it

      const [close] = closedLogs();
      expect(close.reason).toMatch(/^EARLY_STOP|^HARD_STOP/);
      expect(close).toMatchObject({ lastTickSource: 'pool', pollerDeferred: 1 });
    });

    it('if the pool reports no change, the position stays open', () => {
      open('tok-d');
      jest.advanceTimersByTime(2_200);
      pm.updatePrice('tok-d', ENTRY * 0.12, 'poller:dex');
      pm.updatePrice('tok-d', ENTRY, 'pool'); // the fresh read: unchanged
      expect(pm.hasPosition('tok-d')).toBe(true);
      expect(lastPrice()).toBe(ENTRY);
    });
  });

  it('a phantom high is deferred too: no new peak and no take-profit tier from a poller +35%', () => {
    open('tok-e');
    pm.updatePrice('tok-e', ENTRY * 1.55, 'poller:dex');

    const p = pm.getOpenPositions()[0];
    expect(p.peakPriceSOL).toBe(ENTRY);
    expect(p.takeProfitTiers.some((t) => t.triggered)).toBe(false);
    expect(priceChecks()).toHaveLength(1);
  });

  describe('the threshold', () => {
    it.each([
      ['-25% (exactly)', 0.75, true],
      ['+25% (exactly)', 1.25, true],
      ['-24%', 0.76, false],
      ['+10%', 1.1, false],
    ])('a poller price %s from the pool: deferred = %s', (_label, multiple, deferred) => {
      open('tok-f');
      pm.updatePrice('tok-f', ENTRY * multiple, 'poller:dex');
      expect(priceChecks()).toHaveLength(deferred ? 1 : 0);
      if (deferred === false) expect(lastPrice()).toBeCloseTo(ENTRY * multiple, 15); // applied as before
    });

    it('a different threshold is honoured', () => {
      open('tok-g', { pollerGuardPct: 50 });
      pm.updatePrice('tok-g', ENTRY * 1.4, 'poller:dex'); // +40%: under 50
      expect(priceChecks()).toHaveLength(0);
      pm.updatePrice('tok-g', ENTRY * 0.4, 'poller:dex'); // -60% vs the on-chain 1.0: over 50
      expect(priceChecks()).toHaveLength(1);
    });
  });

  it('asks for a re-read at most once a second, however many poller prices arrive', () => {
    open('tok-h');
    for (let i = 0; i < 5; i++) {
      pm.updatePrice('tok-h', ENTRY * 0.3, 'poller:dex');
      jest.advanceTimersByTime(100);
    }
    expect(priceChecks()).toHaveLength(1);

    jest.advanceTimersByTime(1_000);
    pm.updatePrice('tok-h', ENTRY * 0.3, 'poller:dex');
    expect(priceChecks()).toHaveLength(2);
  });

  it('logs the first deferral of a position once, with both prices and the threshold', () => {
    open('tok-i');
    jest.advanceTimersByTime(500);
    pm.updatePrice('tok-i', ENTRY * 0.3, 'poller:dex');
    pm.updatePrice('tok-i', ENTRY * 0.3, 'poller:cache');

    const logs = deferredLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      tokenCA: 'tok-i',
      pollerSource: 'poller:dex',
      pollerPriceSOL: ENTRY * 0.3,
      onChainSource: 'pool',
      onChainPriceSOL: ENTRY,
      onChainAgeMs: 500,
      deviationPct: '-70.0',
      guardPct: 25,
    });
  });

  it('counts deferred poller prices in the Trade CLOSED summary, and they still count as comparisons', () => {
    open('tok-j');
    pm.updatePrice('tok-j', ENTRY * 0.3, 'poller:dex');
    pm.updatePrice('tok-j', ENTRY * 1.4, 'poller:cache');
    pm.updatePrice('tok-j', ENTRY * 1.1, 'poller:dex'); // within the threshold: applied, not deferred
    pm.forceClose('tok-j', 'TEST');

    expect(closedLogs()[0]).toMatchObject({ pollerDeferred: 2, pollerCompared: 3, pollerTicksIgnored: 0 });
  });

  describe('when the guard does not apply', () => {
    it('the guard is off unless configured: the poller price is applied as before', () => {
      open('tok-k', { pollerGuardPct: 0 });
      pm.updatePrice('tok-k', ENTRY * 0.3, 'poller:dex');
      expect(priceChecks()).toHaveLength(0);
      expect(pm.hasPosition('tok-k')).toBe(false); // the early stop fired on the poller price
    });

    it('a PositionManager built without the setting has it off', () => {
      pm = new PositionManager({ ...baseConfig });
      expect(pm.openTrade(graduation('tok-l'), survival)).toBe(true);
      pm.updatePrice('tok-l', ENTRY, 'pool');
      pm.updatePrice('tok-l', ENTRY * 0.3, 'poller:dex');
      expect(priceChecks()).toHaveLength(0);
    });

    it('a position that never had an on-chain price is priced by the poller', () => {
      pm = new PositionManager({ ...baseConfig, pollerGuardPct: 25 });
      expect(pm.openTrade(graduation('tok-m'), survival)).toBe(true);
      pm.updatePrice('tok-m', ENTRY, 'poller:dex'); // the poller anchors it
      pm.updatePrice('tok-m', ENTRY * 0.3, 'poller:dex');
      expect(priceChecks()).toHaveLength(0);
      expect(pm.hasPosition('tok-m')).toBe(false);
    });

    it('an on-chain price older than 60s no longer protects: the stream is presumed dead and the poller counts', () => {
      open('tok-n');
      jest.advanceTimersByTime(60_001);
      pm.updatePrice('tok-n', ENTRY * 0.3, 'poller:dex');
      expect(priceChecks()).toHaveLength(0);
      expect(pm.hasPosition('tok-n')).toBe(false);
    });

    it('just inside 60s it still protects', () => {
      open('tok-o');
      jest.advanceTimersByTime(60_000);
      pm.updatePrice('tok-o', ENTRY * 0.3, 'poller:dex');
      expect(priceChecks()).toHaveLength(1);
      expect(pm.hasPosition('tok-o')).toBe(true);
    });

    it('prices from sources other than the poller are never deferred, however far they move', () => {
      open('tok-p');
      pm.updatePrice('tok-p', ENTRY * 0.3, 'swap');
      expect(priceChecks()).toHaveLength(0);
      expect(pm.hasPosition('tok-p')).toBe(false); // a real on-chain fall still stops it
    });

    it('swap prints count as the on-chain price the guard compares against', () => {
      open('tok-q', {}, 'swap');
      pm.updatePrice('tok-q', ENTRY * 0.3, 'poller:dex');
      expect(priceChecks()).toHaveLength(1);
    });
  });

  describe('together with the freshness rule', () => {
    it('a far-off poller price is deferred (not merely ignored); a near one is ignored as the rule says', () => {
      open('tok-r', { onChainPriceFreshMs: 2_000 });
      pm.updatePrice('tok-r', ENTRY * 0.3, 'poller:dex'); // far: deferred
      pm.updatePrice('tok-r', ENTRY * 1.05, 'poller:dex'); // near, inside the window: ignored
      pm.forceClose('tok-r', 'TEST');

      expect(closedLogs()[0]).toMatchObject({ pollerDeferred: 1, pollerTicksIgnored: 1, pollerCompared: 2 });
    });
  });

  it('state is cleared when a position closes, so the next one in the same token starts clean', () => {
    open('tok-s');
    pm.updatePrice('tok-s', ENTRY * 0.3, 'poller:dex');
    pm.forceClose('tok-s', 'TEST');

    jest.clearAllMocks();
    expect(pm.openTrade(graduation('tok-s'), survival)).toBe(true);
    pm.updatePrice('tok-s', ENTRY, 'pool');
    pm.forceClose('tok-s', 'TEST');
    expect(closedLogs()[0]).toMatchObject({ pollerDeferred: 0, pollerCompared: 0 });
    expect(priceChecks()).toHaveLength(0);
  });
});
