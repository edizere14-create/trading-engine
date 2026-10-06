import bs58 from 'bs58';
import { PositionManager } from '../src/position/positionManager';
import { TradeSignal, SurvivalSnapshot } from '../src/core/types';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const REAL_POOL = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const SIGNATURE = bs58.encode(new Uint8Array(64).fill(9));

const baseConfig = {
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

function signal(source: TradeSignal['source'], poolAddress?: string): TradeSignal {
  return {
    tokenCA: `token-${Math.random().toString(36).slice(2)}`,
    source,
    triggerWallet: 'wallet1',
    walletTier: 'A',
    walletPnL30d: 5,
    convictionSOL: 1,
    clusterWallets: [],
    clusterSize: 1,
    totalClusterSOL: 1,
    entryPriceSOL: 4e-7,
    timestamp: new Date(),
    slot: 1,
    score: 7,
    confidence: 0.8,
    poolAddress,
  };
}

describe('openTrade — SINGLE_WALLET needs a real pool', () => {
  it('refuses a wallet signal with no pool address', () => {
    const pm = new PositionManager(baseConfig);
    expect(pm.openTrade(signal('SINGLE_WALLET'), survival)).toBe(false);
    expect(pm.getOpenPositions()).toHaveLength(0);
  });

  it('refuses a wallet signal whose "pool" is a transaction signature', () => {
    const pm = new PositionManager(baseConfig);
    expect(pm.openTrade(signal('SINGLE_WALLET', SIGNATURE), survival)).toBe(false);
  });

  it('accepts a wallet signal with a real pool address', () => {
    const pm = new PositionManager(baseConfig);
    expect(pm.openTrade(signal('SINGLE_WALLET', REAL_POOL), survival)).toBe(true);
  });

  it('accepts a wallet signal with no pool when allowNoPoolTrades is true', () => {
    const pm = new PositionManager({ ...baseConfig, allowNoPoolTrades: true });
    expect(pm.openTrade(signal('SINGLE_WALLET'), survival)).toBe(true);
  });

  it('never affects other sources', () => {
    const pm = new PositionManager(baseConfig);
    expect(pm.openTrade(signal('AUTONOMOUS'), survival)).toBe(true);
  });
});
