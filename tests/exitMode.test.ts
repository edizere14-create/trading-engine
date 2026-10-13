import fs from 'fs';
import path from 'path';
import { EXIT_REASON_PREFIXES, resolveExitMode } from '../src/position/exitMode';
import { PositionManager } from '../src/position/positionManager';
import { SurvivalSnapshot, TradeSignal } from '../src/core/types';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('resolveExitMode', () => {
  it.each([
    ['HARD_STOP (61.0% loss)', 'HARD_STOP'],
    ['EARLY_STOP (31.8% loss, 2819ms)', 'EARLY_STOP'],
    ['TRAILING_STOP (peak 2.10x, trail floor 1.57x, now 1.50x)', 'TRAILING_STOP'],
    ['TP_TIER_4', 'TP_TIER_4'],
    ['MAX_HOLD (held 180s)', 'MAX_HOLD'],
    ['STALE_EXIT (no price data for 61s)', 'STALE_EXIT'],
    ['EMERGENCY: shutdown', 'EMERGENCY'],
    ['RUG_TRIGGER: vault drain 58.9%', 'RUG_TRIGGER'],
    // HybridPowerPlay's scheduled pre-migration exit, which had no prefix in the map
    ['CURVE_SAFETY_EXIT (85.2% bonding curve, 3.10 SOL accumulated)', 'CURVE_SAFETY_EXIT'],
  ])('maps %p to %s', (reason, mode) => {
    expect(resolveExitMode(reason)).toBe(mode);
  });

  it.each([undefined, '', 'UNKNOWN', 'SOMETHING_NEW (x)', 'curve_safety_exit', ' CURVE_SAFETY_EXIT'])(
    'maps %p to UNKNOWN',
    (reason) => {
      expect(resolveExitMode(reason)).toBe('UNKNOWN');
    }
  );

  it('every prefix in the table resolves to its own mode, and none is UNKNOWN', () => {
    for (const [prefix, mode] of Object.entries(EXIT_REASON_PREFIXES)) {
      expect(mode).not.toBe('UNKNOWN');
      expect(resolveExitMode(`${prefix} (details)`)).toBe(mode);
    }
  });
});

describe('every way a position can close has an exit mode (drift guard)', () => {
  const config = {
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
  const signal = (tokenCA: string): TradeSignal => ({
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
  const P = 1e-6;

  let pm: PositionManager;
  const open = (tokenCA: string, over: Partial<typeof config> = {}) => {
    pm = new PositionManager({ ...config, ...over });
    expect(pm.openTrade(signal(tokenCA), survival)).toBe(true);
    pm.updatePrice(tokenCA, P, 'pool'); // anchors the entry
  };
  const closedReason = () => pm.getClosedPositions()[0]?.exitReason;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-09T16:23:18.879Z'));
  });
  afterEach(() => jest.useRealTimers());

  it.each([
    ['EARLY_STOP', (t: string) => pm.updatePrice(t, P * 0.5, 'pool'), {}],
    [
      'HARD_STOP',
      (t: string) => {
        jest.advanceTimersByTime(11_000); // past the tight-stop window
        pm.updatePrice(t, P * 0.3, 'pool');
      },
      {},
    ],
    ['TP_TIER_4', (t: string) => pm.updatePrice(t, P * 5, 'pool'), {}],
    [
      'TRAILING_STOP',
      (t: string) => {
        pm.updatePrice(t, P * 1.4, 'pool');
        pm.updatePrice(t, P * 1.0, 'pool');
      },
      {},
    ],
    [
      'MAX_HOLD',
      (_t: string) => {
        jest.advanceTimersByTime(21_000);
        (pm as any).monitorPositions();
      },
      { maxHoldMs: 20_000 },
    ],
    [
      'STALE_EXIT',
      (_t: string) => {
        jest.advanceTimersByTime(61_000);
        (pm as any).monitorPositions();
      },
      {},
    ],
    ['EMERGENCY', (_t: string) => pm.emergencyCloseAll('shutdown'), {}],
    ['RUG_TRIGGER', (t: string) => pm.forceClose(t, 'RUG_TRIGGER: vault drain 58.9%'), {}],
  ] as Array<[string, (t: string) => void, Partial<typeof config>]>)(
    '%s',
    (expected, close, over) => {
      open('tok', over);
      close('tok');
      expect(pm.hasPosition('tok')).toBe(false);
      expect(resolveExitMode(closedReason())).toBe(expected);
    }
  );

  describe('every literal reason passed to closePosition / forceClose in src/', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(path.join(__dirname, '..', 'src'));

    // closePosition(tokenCA, `EARLY_STOP (...`), forceClose(e.tokenCA, `RUG_TRIGGER: ...`), ...
    const callPattern = /(?:closePosition|forceClose)\(\s*[A-Za-z_.]+,\s*[`'"]([A-Z][A-Z0-9_]+)/g;
    const found = new Set<string>();
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf-8').matchAll(callPattern)) found.add(m[1]);
    }

    it('finds the call sites (so this guard is not vacuously passing)', () => {
      expect(found.size).toBeGreaterThanOrEqual(7);
      expect(found.has('RUG_TRIGGER')).toBe(true);
      expect(found.has('EMERGENCY')).toBe(true);
    });

    it('maps every one of them', () => {
      const unmapped = [...found].filter((p) => resolveExitMode(`${p} (x)`) === 'UNKNOWN');
      expect(unmapped).toEqual([]);
    });
  });

  it("maps the reason HybridPowerPlay actually builds (it passes it through a variable, so the scan above can't see it)", () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'execution', 'hybridPowerPlay.ts'), 'utf-8');
    const m = /const reason = `([A-Z][A-Z_]+)/.exec(src);
    expect(m).not.toBeNull();
    expect(resolveExitMode(`${m![1]} (85.0% bonding curve, 3.00 SOL accumulated)`)).toBe('CURVE_SAFETY_EXIT');
  });
});
