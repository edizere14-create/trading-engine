import { PositionManager, DEFAULT_ONCHAIN_PRICE_FRESH_MS } from '../src/position/positionManager';

// The rule is opt-in (default 0); these tests switch it on explicitly.
const FRESH_MS = 15_000;
import { TradeSignal, SurvivalSnapshot } from '../src/core/types';
import { logger } from '../src/core/logger';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const infoCalls = () => (logger.info as jest.Mock).mock.calls as [string, Record<string, unknown>][];
const closedLog = () => infoCalls().filter(([msg]) => msg === 'Trade CLOSED').map(([, meta]) => meta);
const ignoredLog = () => infoCalls().filter(([msg]) => msg.startsWith('Poller price ignored')).map(([, meta]) => meta);

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

const ENTRY = 530e-9;
const POLLER_DROP = 194e-9; // the 0.366 price DexScreener gave in the real early stop

describe('price-source rule: a fresh on-chain price outranks the poller', () => {
  let pm: PositionManager;

  const open = (tokenCA: string, config: Partial<ConstructorParameters<typeof PositionManager>[0]> = {}) => {
    pm = new PositionManager({ ...baseConfig, onChainPriceFreshMs: FRESH_MS, ...config });
    expect(pm.openTrade(graduation(tokenCA), survival)).toBe(true);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-09T16:23:18.879Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('the 0.366 case: a poller price 63% below the pool price does not stop the position out', () => {
    open('tok-a');
    pm.updatePrice('tok-a', ENTRY, 'pool'); // anchors the entry
    jest.advanceTimersByTime(2_000);
    pm.updatePrice('tok-a', POLLER_DROP, 'poller:dex');

    expect(pm.hasPosition('tok-a')).toBe(true);
    expect(closedLog()).toHaveLength(0);
  });

  it('logs the disagreement once per position, with both prices and their sources', () => {
    open('tok-b');
    pm.updatePrice('tok-b', ENTRY, 'pool');
    jest.advanceTimersByTime(2_000);
    pm.updatePrice('tok-b', POLLER_DROP, 'poller:dex');
    pm.updatePrice('tok-b', POLLER_DROP, 'poller:dex');

    const logs = ignoredLog();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      tokenCA: 'tok-b',
      pollerSource: 'poller:dex',
      pollerPriceSOL: POLLER_DROP,
      onChainSource: 'pool',
      onChainPriceSOL: ENTRY,
      onChainAgeMs: 2_000,
      deviationPct: '-63.4',
    });
  });

  it('does not log a poller price that roughly agrees with the chain, but still ignores it', () => {
    open('tok-c');
    pm.updatePrice('tok-c', ENTRY, 'pool');
    pm.updatePrice('tok-c', ENTRY * 1.05, 'poller:dex');
    expect(ignoredLog()).toHaveLength(0);
    expect(pm.getOpenPositions()[0].lastPriceSOL).toBe(ENTRY); // the poller price was not applied
  });

  it('counts ignored poller prices in the Trade CLOSED log', () => {
    open('tok-d');
    pm.updatePrice('tok-d', ENTRY, 'pool');
    pm.updatePrice('tok-d', POLLER_DROP, 'poller:dex');
    pm.updatePrice('tok-d', POLLER_DROP, 'poller:cache');
    pm.updatePrice('tok-d', 100e-9, 'pool'); // a real on-chain drop closes it
    expect(closedLog()[0]).toMatchObject({ pollerTicksIgnored: 2, lastTickSource: 'pool' });
  });

  it('on-chain prices always count: a real pool drop still triggers the stop', () => {
    open('tok-e');
    pm.updatePrice('tok-e', ENTRY, 'pool');
    pm.updatePrice('tok-e', POLLER_DROP, 'pool');
    expect(closedLog()[0].reason).toMatch(/^EARLY_STOP/);
  });

  it('swap prints are on-chain too: they make poller prices wait', () => {
    open('tok-f');
    pm.updatePrice('tok-f', ENTRY, 'swap');
    pm.updatePrice('tok-f', POLLER_DROP, 'poller:jupiter');
    expect(pm.hasPosition('tok-f')).toBe(true);
  });

  it('the poller takes over once the chain has been quiet longer than the freshness window', () => {
    open('tok-g');
    pm.updatePrice('tok-g', ENTRY, 'pool');
    jest.advanceTimersByTime(FRESH_MS + 1);
    pm.updatePrice('tok-g', 150e-9, 'poller:dex'); // 0.28x, past the 60% hard stop (the tight window is over)

    expect(closedLog()[0].reason).toMatch(/^HARD_STOP/);
  });

  it('applies the poller price right at the edge of the window, not before', () => {
    open('tok-h');
    pm.updatePrice('tok-h', ENTRY, 'pool');
    jest.advanceTimersByTime(FRESH_MS); // exactly fresh: still ignored
    pm.updatePrice('tok-h', 150e-9, 'poller:dex');
    expect(pm.hasPosition('tok-h')).toBe(true);
    jest.advanceTimersByTime(1);
    pm.updatePrice('tok-h', 150e-9, 'poller:dex');
    expect(pm.hasPosition('tok-h')).toBe(false);
  });

  it('a position that never had an on-chain price is priced by the poller exactly as before', () => {
    open('tok-i');
    pm.updatePrice('tok-i', ENTRY, 'poller:dex'); // the poller anchors it
    pm.updatePrice('tok-i', POLLER_DROP, 'poller:dex');
    expect(closedLog()[0].reason).toMatch(/^EARLY_STOP/);
    expect(closedLog()[0]).toMatchObject({ pollerTicksIgnored: 0 });
  });

  it('untagged callers (source "unknown") are not treated as the poller', () => {
    open('tok-j');
    pm.updatePrice('tok-j', ENTRY, 'pool');
    pm.updatePrice('tok-j', POLLER_DROP);
    expect(closedLog()[0].reason).toMatch(/^EARLY_STOP/);
  });

  it('onChainPriceFreshMs = 0 turns the rule off', () => {
    open('tok-k', { onChainPriceFreshMs: 0 });
    pm.updatePrice('tok-k', ENTRY, 'pool');
    pm.updatePrice('tok-k', POLLER_DROP, 'poller:dex');
    expect(closedLog()[0].reason).toMatch(/^EARLY_STOP/);
  });

  it('a shorter configured window is honoured', () => {
    open('tok-l', { onChainPriceFreshMs: 3_000 });
    pm.updatePrice('tok-l', ENTRY, 'pool');
    jest.advanceTimersByTime(3_001);
    pm.updatePrice('tok-l', 150e-9, 'poller:dex');
    expect(pm.hasPosition('tok-l')).toBe(false);
  });

  it('ignores a zero or NaN on-chain price when judging freshness', () => {
    open('tok-m');
    pm.updatePrice('tok-m', ENTRY, 'poller:dex'); // no on-chain price yet, poller anchors
    pm.updatePrice('tok-m', 0, 'pool');
    pm.updatePrice('tok-m', NaN, 'swap');
    pm.updatePrice('tok-m', POLLER_DROP, 'poller:dex'); // there is still no valid on-chain price: poller counts
    expect(closedLog()[0].reason).toMatch(/^EARLY_STOP/);
  });

  it('state is cleared on close, so the next position in the same token starts clean', () => {
    open('tok-n');
    pm.updatePrice('tok-n', ENTRY, 'pool');
    pm.updatePrice('tok-n', POLLER_DROP, 'pool'); // closes it
    expect(pm.hasPosition('tok-n')).toBe(false);

    expect(pm.openTrade(graduation('tok-n'), survival)).toBe(true);
    pm.updatePrice('tok-n', ENTRY, 'poller:dex'); // no stale on-chain tick from the last position
    pm.updatePrice('tok-n', POLLER_DROP, 'poller:dex');
    expect(closedLog()).toHaveLength(2);
    expect(closedLog()[1]).toMatchObject({ pollerTicksIgnored: 0 });
  });
});

describe('rule off by default: poller prices count, and disagreements are logged', () => {
  let pm: PositionManager;
  const openDefault = (tokenCA: string) => {
    pm = new PositionManager({ ...baseConfig }); // no onChainPriceFreshMs
    expect(pm.openTrade(graduation(tokenCA), survival)).toBe(true);
  };
  const disagreeLog = () => infoCalls().filter(([msg]) => msg.startsWith('Poller price disagrees')).map(([, meta]) => meta);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-09T16:23:18.879Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('the default is off', () => {
    expect(DEFAULT_ONCHAIN_PRICE_FRESH_MS).toBe(0);
  });

  it('applies the poller price (old behaviour) and logs the disagreement once, with both prices', () => {
    openDefault('tok-o1');
    pm.updatePrice('tok-o1', ENTRY, 'pool');
    jest.advanceTimersByTime(2_000);
    pm.updatePrice('tok-o1', POLLER_DROP, 'poller:dex');
    pm.updatePrice('tok-o1', POLLER_DROP, 'poller:dex');

    expect(closedLog()[0].reason).toMatch(/^EARLY_STOP/); // the poller price was used
    expect(closedLog()[0]).toMatchObject({ pollerTicksIgnored: 0, lastTickSource: 'poller:dex' });
    const logs = disagreeLog();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ pollerSource: 'poller:dex', onChainSource: 'pool', deviationPct: '-63.4', onChainAgeMs: 2_000 });
    expect(ignoredLog()).toHaveLength(0);
  });

  it('logs nothing when the on-chain tick is older than the 15s comparison window', () => {
    openDefault('tok-o2');
    pm.updatePrice('tok-o2', ENTRY, 'pool');
    jest.advanceTimersByTime(15_001);
    pm.updatePrice('tok-o2', 150e-9, 'poller:dex');
    expect(disagreeLog()).toHaveLength(0);
  });

  it('logs nothing for a poller price close to the on-chain one', () => {
    openDefault('tok-o3');
    pm.updatePrice('tok-o3', ENTRY, 'pool');
    pm.updatePrice('tok-o3', ENTRY * 1.1, 'poller:dex');
    expect(disagreeLog()).toHaveLength(0);
  });
});

describe('observedAt: freshness is when the price was read, not when it arrived', () => {
  let pm: PositionManager;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-09T16:23:18.879Z'));
    pm = new PositionManager({ ...baseConfig, onChainPriceFreshMs: FRESH_MS });
  });
  afterEach(() => jest.useRealTimers());

  it('a pool tick whose reserves were read 20s ago does not make the chain look fresh', () => {
    expect(pm.openTrade(graduation('tok-p1'), survival)).toBe(true);
    pm.updatePrice('tok-p1', ENTRY, 'pool', Date.now() - 20_000); // arrived now, but old data
    pm.updatePrice('tok-p1', POLLER_DROP, 'poller:dex');
    expect(closedLog()[0].reason).toMatch(/^EARLY_STOP/); // the poller price counted
  });

  it('a pool tick read just now still makes the chain fresh', () => {
    expect(pm.openTrade(graduation('tok-p2'), survival)).toBe(true);
    pm.updatePrice('tok-p2', ENTRY, 'pool', Date.now() - 100);
    pm.updatePrice('tok-p2', POLLER_DROP, 'poller:dex');
    expect(pm.hasPosition('tok-p2')).toBe(true);
  });

  it('an observedAt in the future is treated as now, and NaN falls back to now', () => {
    expect(pm.openTrade(graduation('tok-p3'), survival)).toBe(true);
    pm.updatePrice('tok-p3', ENTRY, 'pool', Date.now() + 60_000);
    jest.advanceTimersByTime(FRESH_MS + 1); // a future stamp must not keep the chain "fresh" past the window
    pm.updatePrice('tok-p3', 150e-9, 'poller:dex');
    expect(pm.hasPosition('tok-p3')).toBe(false);

    expect(pm.openTrade(graduation('tok-p4'), survival)).toBe(true);
    pm.updatePrice('tok-p4', ENTRY, 'pool', NaN);
    pm.updatePrice('tok-p4', POLLER_DROP, 'poller:dex');
    expect(pm.hasPosition('tok-p4')).toBe(true);
  });
});
