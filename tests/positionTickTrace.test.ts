import { PositionManager } from '../src/position/positionManager';
import { passesLiquidityFloor } from '../src/safety/phaseA';
import { TradeSignal, SurvivalSnapshot } from '../src/core/types';
import { logger } from '../src/core/logger';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const infoCalls = () => (logger.info as jest.Mock).mock.calls as [string, Record<string, unknown>][];
const ticksLogged = () => infoCalls().filter(([msg]) => msg === 'Position tick').map(([, meta]) => meta);
const closedLog = () => infoCalls().filter(([msg]) => msg === 'Trade CLOSED').map(([, meta]) => meta);

describe('passesLiquidityFloor', () => {
  it('is the safety pipeline floor (3 SOL), not the MIN_LIQUIDITY_SOL setting', () => {
    expect(passesLiquidityFloor(67.4)).toBe(true); // the graduation trades recorded as failed under a setting of 100
    expect(passesLiquidityFloor(3)).toBe(true);
    expect(passesLiquidityFloor(2.99)).toBe(false);
  });

  it.each([undefined, NaN, Infinity, -1])('treats %p as not passed', (v) => {
    expect(passesLiquidityFloor(v as number | undefined)).toBe(false);
  });
});

describe('tick trace for early stops', () => {
  const config = {
    mode: 'PAPER' as const,
    maxConcurrent: 5,
    maxTradesPerDay: 20,
    capitalUSD: 1000,
    sizePct: 0.05,
    solPriceUSD: 150,
    maxHoldMs: 180_000,
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
  // a graduation-style signal: entry price unknown, anchored on the first tick
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

  let pm: PositionManager;
  beforeEach(() => {
    jest.clearAllMocks();
    pm = new PositionManager({ ...config });
  });

  it('explains the 0.366 early stop: which source gave each of the last two ticks, and the gap between them', () => {
    expect(pm.openTrade(graduation('tok-a'), survival)).toBe(true);
    pm.updatePrice('tok-a', 530e-9, 'pool'); // anchors the entry
    pm.updatePrice('tok-a', 194e-9, 'poller:dex'); // -63%: inside the 10s window, past the 25% stop

    const [close] = closedLog();
    expect(close.reason).toMatch(/^EARLY_STOP/);
    expect(close).toMatchObject({
      entryPriceBasis: 'FIRST_TICK',
      peakMultiple: '1.000',
      ticksSeen: 2,
      lastTickSource: 'poller:dex',
      lastTickMultiple: '0.366',
      prevTickSource: 'pool',
      prevTickMultiple: '1.000',
    });
    expect(typeof close.msBetweenLastTicks).toBe('number');
  });

  it('logs only the first three ticks, with the source, and marks the anchoring tick', () => {
    pm.openTrade(graduation('tok-b'), survival);
    pm.updatePrice('tok-b', 1e-6, 'pool');
    for (const p of [1.01e-6, 1.02e-6, 1.03e-6, 1.04e-6]) pm.updatePrice('tok-b', p, 'swap');

    const ticks = ticksLogged();
    expect(ticks).toHaveLength(3);
    expect(ticks[0]).toMatchObject({ n: 1, source: 'pool', anchoring: true, multiple: undefined });
    expect(ticks[1]).toMatchObject({ n: 2, source: 'swap', anchoring: false, multiple: '1.010' });
  });

  it('defaults the source to "unknown" so existing callers keep working', () => {
    pm.openTrade(graduation('tok-c'), survival);
    pm.updatePrice('tok-c', 1e-6);
    expect(ticksLogged()[0].source).toBe('unknown');
  });

  it('starts a fresh trace for the next position in the same token', () => {
    pm.openTrade(graduation('tok-d'), survival);
    pm.updatePrice('tok-d', 1e-6, 'pool');
    pm.updatePrice('tok-d', 0.5e-6, 'pool'); // early stop closes it
    expect(closedLog()).toHaveLength(1);

    jest.clearAllMocks();
    pm.openTrade(graduation('tok-d'), survival);
    pm.updatePrice('tok-d', 2e-6, 'swap');
    expect(ticksLogged()[0]).toMatchObject({ n: 1, source: 'swap', anchoring: true });
  });

  it('reports no tick data for a position closed without any tick (for example a forced close)', () => {
    pm.openTrade(graduation('tok-e'), survival);
    pm.forceClose('tok-e', 'TEST');
    expect(closedLog()[0]).toMatchObject({ ticksSeen: 0, lastTickSource: undefined });
  });
});
