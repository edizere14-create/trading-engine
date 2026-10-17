import { PositionManager } from '../src/position/positionManager';
import { TradeSignal, SurvivalSnapshot } from '../src/core/types';
import { logger } from '../src/core/logger';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const closedLogs = () =>
  ((logger.info as jest.Mock).mock.calls as [string, Record<string, unknown>][])
    .filter(([msg]) => msg === 'Trade CLOSED')
    .map(([, meta]) => meta);

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

describe('poller deviation summary in the Trade CLOSED log', () => {
  let pm: PositionManager;
  const open = (tokenCA: string, over: Partial<typeof baseConfig & { onChainPriceFreshMs: number }> = {}) => {
    pm = new PositionManager({ ...baseConfig, ...over });
    expect(pm.openTrade(graduation(tokenCA), survival)).toBe(true);
    pm.updatePrice(tokenCA, ENTRY, 'pool'); // anchors the entry on a pool price
  };
  const closeAndRead = (tokenCA: string) => {
    pm.forceClose(tokenCA, 'TEST');
    return closedLogs()[closedLogs().length - 1];
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-12T19:31:12.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('gives the mean and the largest gap of the poller prices compared with the pool price', () => {
    open('tok-a');
    pm.updatePrice('tok-a', ENTRY * 0.9, 'poller:dex'); // -10%
    pm.updatePrice('tok-a', ENTRY * 1.2, 'poller:dex'); // +20%
    const close = closeAndRead('tok-a');

    expect(close).toMatchObject({ pollerCompared: 2, pollerDevMeanPct: '5.0', pollerDevExtremePct: '20.0' });
  });

  it('the real early-stop shape: the closing tick is itself a poller price far below the pool price', () => {
    open('tok-b');
    pm.updatePrice('tok-b', ENTRY * 0.997, 'pool');
    pm.updatePrice('tok-b', ENTRY * 0.216, 'poller:dex'); // the 37HR26 exit: -78% against a fresh pool tick

    const [close] = closedLogs();
    expect(close.reason).toMatch(/^EARLY_STOP/);
    expect(close).toMatchObject({
      lastTickSource: 'poller:dex',
      prevTickSource: 'pool',
      pollerCompared: 1,
      pollerDevMeanPct: '-78.3', // 0.216 / 0.997 - 1
      pollerDevExtremePct: '-78.3',
    });
  });

  it('reports the sign of the largest gap, not just its size', () => {
    open('tok-c');
    pm.updatePrice('tok-c', ENTRY * 1.35, 'poller:dex'); // +35%
    pm.updatePrice('tok-c', ENTRY * 0.9, 'poller:dex'); // -10%
    expect(closeAndRead('tok-c')).toMatchObject({ pollerDevExtremePct: '35.0' });

    jest.clearAllMocks();
    open('tok-d');
    pm.updatePrice('tok-d', ENTRY * 0.9, 'poller:dex');
    pm.updatePrice('tok-d', ENTRY * 1.05, 'poller:dex');
    pm.updatePrice('tok-d', ENTRY * 0.8, 'poller:dex'); // -20% is the largest gap
    expect(closeAndRead('tok-d')).toMatchObject({ pollerDevExtremePct: '-20.0' });
  });

  it('compares each poller price with the latest on-chain price at that moment', () => {
    open('tok-e');
    pm.updatePrice('tok-e', ENTRY * 1.1, 'poller:dex'); // +10% against 1.0
    pm.updatePrice('tok-e', ENTRY * 2.0, 'pool');
    pm.updatePrice('tok-e', ENTRY * 2.2, 'poller:dex'); // +10% against 2.0
    expect(closeAndRead('tok-e')).toMatchObject({ pollerCompared: 2, pollerDevMeanPct: '10.0', pollerDevExtremePct: '10.0' });
  });

  it('is tallied with the price rule on as well, alongside the ignored count', () => {
    open('tok-f', { onChainPriceFreshMs: 2_000 });
    pm.updatePrice('tok-f', ENTRY * 1.35, 'poller:dex');
    pm.updatePrice('tok-f', ENTRY * 1.35, 'poller:cache');
    const close = closeAndRead('tok-f');

    expect(close).toMatchObject({ pollerTicksIgnored: 2, pollerCompared: 2, pollerDevMeanPct: '35.0' });
    expect(pm.getClosedPositions()[0].lastPriceSOL).toBe(ENTRY); // the poller prices were not applied
  });

  it('with the rule off nothing is ignored, but comparisons are still made', () => {
    open('tok-g');
    pm.updatePrice('tok-g', ENTRY * 1.35, 'poller:dex');
    expect(closeAndRead('tok-g')).toMatchObject({ pollerTicksIgnored: 0, pollerCompared: 1 });
  });

  it('a poller price that meets no recent on-chain price is not compared', () => {
    open('tok-h');
    jest.advanceTimersByTime(15_001); // the pool price is now older than the 15s comparison window
    pm.updatePrice('tok-h', ENTRY * 1.5, 'poller:dex');
    expect(closeAndRead('tok-h')).toMatchObject({
      pollerCompared: 0,
      pollerDevMeanPct: undefined,
      pollerDevExtremePct: undefined,
    });
  });

  it('a position that never had an on-chain price compares nothing', () => {
    pm = new PositionManager({ ...baseConfig });
    expect(pm.openTrade(graduation('tok-i'), survival)).toBe(true);
    pm.updatePrice('tok-i', ENTRY, 'poller:dex'); // the poller anchors it
    pm.updatePrice('tok-i', ENTRY * 1.2, 'poller:dex');
    expect(closeAndRead('tok-i')).toMatchObject({ pollerCompared: 0, pollerDevMeanPct: undefined });
  });

  it('a position with no poller prices reports zero comparisons and no deviation figures', () => {
    open('tok-j');
    pm.updatePrice('tok-j', ENTRY * 1.1, 'pool');
    expect(closeAndRead('tok-j')).toMatchObject({
      pollerTicksIgnored: 0,
      pollerCompared: 0,
      pollerDevMeanPct: undefined,
      pollerDevExtremePct: undefined,
    });
  });

  it('does not count a NaN poller price', () => {
    open('tok-k');
    pm.updatePrice('tok-k', NaN, 'poller:dex');
    pm.updatePrice('tok-k', ENTRY * 1.1, 'poller:dex');
    expect(closeAndRead('tok-k')).toMatchObject({ pollerCompared: 1, pollerDevMeanPct: '10.0' });
  });

  it('the next position in the same token starts with a clean tally', () => {
    open('tok-l');
    pm.updatePrice('tok-l', ENTRY * 1.4, 'poller:dex');
    closeAndRead('tok-l');

    jest.clearAllMocks();
    expect(pm.openTrade(graduation('tok-l'), survival)).toBe(true);
    pm.updatePrice('tok-l', ENTRY, 'pool');
    expect(closeAndRead('tok-l')).toMatchObject({ pollerCompared: 0, pollerDevMeanPct: undefined });
  });
});
