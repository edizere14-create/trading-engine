import { runPhaseB } from '../src/safety/phaseB';
import { TokenSafetyChecker } from '../src/safety/tokenSafetyChecker';
import { checkHoneypot } from '../src/safety/honeypot';
import { checkDeployerBlacklist } from '../src/safety/deployerBlacklist';
import { PumpSwapGraduationEvent, TokenSafetyResult } from '../src/core/types';
import { AntifragileEngine } from '../src/antifragile/antifragileEngine';

jest.mock('../src/safety/honeypot');
jest.mock('../src/safety/deployerBlacklist');

const mockedHoneypot = checkHoneypot as jest.MockedFunction<typeof checkHoneypot>;
const mockedDeployer = checkDeployerBlacklist as jest.MockedFunction<typeof checkDeployerBlacklist>;

const baseEvent: PumpSwapGraduationEvent = {
  signature: 'test-sig',
  slot: 416647963,
  tokenCA: '6Aixvhgirbn8rHmAtFnwHNBqgxtenKDz8ycvHeQepump',
  poolAddress: '7ugTEN5mq5kGURByfXrK1AqTAJ76wQMauggskosVzEoK',
  deployer: 'DeployerWa11et1111111111111111111111111111111',
  initialLiquiditySOL: 99,
  detectedAt: Date.now(),
};

const BUDGET_MS = 250;

function cleanTokenSafetyResult(overrides: Partial<TokenSafetyResult> = {}): TokenSafetyResult {
  return {
    tokenCA: baseEvent.tokenCA,
    isSafe: true,
    reasons: [],
    rugScore: 0,
    topHolderPct: 0.05,
    holderConcentrationOk: true,
    lpLocked: true,
    mintAuthRevoked: true,
    freezeAuthRevoked: true,
    isHoneypot: false,
    checkedAt: new Date(),
    ...overrides,
  };
}

function makeChecker(result: TokenSafetyResult | Promise<TokenSafetyResult>): TokenSafetyChecker {
  return {
    check: jest.fn().mockResolvedValue(result instanceof Promise ? undefined : result)
      .mockImplementation(() => result instanceof Promise ? result : Promise.resolve(result)),
  } as unknown as TokenSafetyChecker;
}

function cleanHoneypotResult() {
  return {
    passed: true,
    classification: 'CLEAN' as const,
    sellQuoteSlippagePct: 5,
    durationMs: 50,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedHoneypot.mockResolvedValue(cleanHoneypotResult());
  mockedDeployer.mockResolvedValue({ passed: true });
});

describe('runPhaseB', () => {
  describe('full pass', () => {
    it('all checks pass with clean inputs', async () => {
      const checker = makeChecker(cleanTokenSafetyResult());
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);

      expect(result.passed).toBe(true);
      expect(result.failedCheck).toBeUndefined();
      expect(result.trace.lpLock.passed).toBe(true);
      expect(result.trace.mintAuthority.passed).toBe(true);
      expect(result.trace.freezeAuthority.passed).toBe(true);
      expect(result.trace.holderConcentration.passed).toBe(true);
      expect(result.trace.honeypot.passed).toBe(true);
      expect(result.trace.deployerBlacklist.passed).toBe(true);
    });

    it('returns durationMs as a number', async () => {
      const checker = makeChecker(cleanTokenSafetyResult());
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('individual check failures', () => {
    it('fails on lpLock', async () => {
      const checker = makeChecker(cleanTokenSafetyResult({ lpLocked: false }));
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('lpLock');
    });

    it('fails on mintAuthority', async () => {
      const checker = makeChecker(cleanTokenSafetyResult({ mintAuthRevoked: false }));
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('mintAuthority');
    });

    it('fails on freezeAuthority', async () => {
      const checker = makeChecker(cleanTokenSafetyResult({ freezeAuthRevoked: false }));
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('freezeAuthority');
    });

    it('fails on holderConcentration', async () => {
      const checker = makeChecker(cleanTokenSafetyResult({
        topHolderPct: 0.45,
        holderConcentrationOk: false,
      }));
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('holderConcentration');
      expect(result.trace.holderConcentration.topPct).toBe(45);
    });

    it('fails on honeypot UNCONFIRMED', async () => {
      const checker = makeChecker(cleanTokenSafetyResult());
      mockedHoneypot.mockResolvedValueOnce({
        passed: false,
        classification: 'UNCONFIRMED',
        sellQuoteSlippagePct: 75,
        durationMs: 50,
      });
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('honeypot');
      expect(result.trace.honeypot.classification).toBe('UNCONFIRMED');
      expect(result.trace.honeypot.sellQuoteSlippagePct).toBe(75);
    });

    it('fails on honeypot INDEX_LAG', async () => {
      const checker = makeChecker(cleanTokenSafetyResult());
      mockedHoneypot.mockResolvedValueOnce({
        passed: false,
        classification: 'INDEX_LAG',
        durationMs: 50,
      });
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('honeypot');
      expect(result.trace.honeypot.classification).toBe('INDEX_LAG');
    });

    it('fails on deployerBlacklist', async () => {
      const checker = makeChecker(cleanTokenSafetyResult());
      mockedDeployer.mockResolvedValueOnce({ passed: false, reason: 'known scammer' });
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('deployerBlacklist');
    });
  });

  describe('failedCheck resolution order (multiple failures)', () => {
    it('lpLock beats mintAuthority', async () => {
      const checker = makeChecker(cleanTokenSafetyResult({
        lpLocked: false,
        mintAuthRevoked: false,
      }));
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.failedCheck).toBe('lpLock');
    });

    it('mintAuthority beats freezeAuthority', async () => {
      const checker = makeChecker(cleanTokenSafetyResult({
        mintAuthRevoked: false,
        freezeAuthRevoked: false,
      }));
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.failedCheck).toBe('mintAuthority');
    });

    it('holderConcentration beats honeypot', async () => {
      const checker = makeChecker(cleanTokenSafetyResult({
        topHolderPct: 0.45,
        holderConcentrationOk: false,
      }));
      mockedHoneypot.mockResolvedValueOnce({
        passed: false,
        classification: 'UNCONFIRMED',
        sellQuoteSlippagePct: 75,
        durationMs: 50,
      });
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.failedCheck).toBe('holderConcentration');
    });

    it('honeypot beats deployerBlacklist', async () => {
      const checker = makeChecker(cleanTokenSafetyResult());
      mockedHoneypot.mockResolvedValueOnce({
        passed: false,
        classification: 'INDEX_LAG',
        durationMs: 50,
      });
      mockedDeployer.mockResolvedValueOnce({ passed: false, reason: 'known' });
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.failedCheck).toBe('honeypot');
    });
  });

  describe('tokenSafetyChecker timeout', () => {
    it('fails all four tokenSafety trace fields on timeout', async () => {
      // Checker hangs; per-check budget fires
      const checker = makeChecker(new Promise<TokenSafetyResult>(() => { /* hang */ }));
      const result = await runPhaseB(baseEvent, checker, 50);

      expect(result.passed).toBe(false);
      expect(result.trace.lpLock.passed).toBe(false);
      expect(result.trace.mintAuthority.passed).toBe(false);
      expect(result.trace.freezeAuthority.passed).toBe(false);
      expect(result.trace.holderConcentration.passed).toBe(false);
      expect(result.trace.holderConcentration.topPct).toBe(0);
    });

    it('failedCheck = lpLock on timeout (declared order)', async () => {
      const checker = makeChecker(new Promise<TokenSafetyResult>(() => { /* hang */ }));
      const result = await runPhaseB(baseEvent, checker, 50);
      expect(result.failedCheck).toBe('lpLock');
    });

    it('still includes honeypot and deployer in trace even when tokenSafety times out', async () => {
      const checker = makeChecker(new Promise<TokenSafetyResult>(() => { /* hang */ }));
      const result = await runPhaseB(baseEvent, checker, 50);
      expect(result.trace.honeypot).toBeDefined();
      expect(result.trace.honeypot.passed).toBe(true);
      expect(result.trace.deployerBlacklist).toBeDefined();
      expect(result.trace.deployerBlacklist.passed).toBe(true);
    });
  });

  describe('parallel execution', () => {
    it('does not run checks sequentially', async () => {
      let tokenSafetyResolveAt = 0;
      let honeypotResolveAt = 0;

      const checker = makeChecker(new Promise<TokenSafetyResult>((resolve) => {
        setTimeout(() => {
          tokenSafetyResolveAt = performance.now();
          resolve(cleanTokenSafetyResult());
        }, 30);
      }));

      mockedHoneypot.mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => {
          honeypotResolveAt = performance.now();
          resolve(cleanHoneypotResult());
        }, 30);
      }));

      const start = performance.now();
      await runPhaseB(baseEvent, checker, 200);
      const elapsed = performance.now() - start;

      // If sequential: ~60ms. If parallel: ~30ms. Allow generous margin.
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('antifragile param passthrough', () => {
    it('passes antifragile to honeypot when provided', async () => {
      const checker = makeChecker(cleanTokenSafetyResult());
      const fakeAntifragile = {} as AntifragileEngine;
      await runPhaseB(baseEvent, checker, BUDGET_MS, fakeAntifragile);

      expect(mockedHoneypot).toHaveBeenCalledWith(
        baseEvent.tokenCA,
        expect.any(BigInt),
        BUDGET_MS,
        fakeAntifragile,
      );
    });

    it('omits antifragile when not provided', async () => {
      const checker = makeChecker(cleanTokenSafetyResult());
      await runPhaseB(baseEvent, checker, BUDGET_MS);

      expect(mockedHoneypot).toHaveBeenCalledWith(
        baseEvent.tokenCA,
        expect.any(BigInt),
        BUDGET_MS,
        undefined,
      );
    });
  });

  describe('trace observability', () => {
    it('topPct is percentage 0-100, not fraction', async () => {
      const checker = makeChecker(cleanTokenSafetyResult({ topHolderPct: 0.42 }));
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.trace.holderConcentration.topPct).toBe(42);
    });

    it('honeypot classification feeds through to trace', async () => {
      const checker = makeChecker(cleanTokenSafetyResult());
      mockedHoneypot.mockResolvedValueOnce({
        passed: true,
        classification: 'CLEAN',
        sellQuoteSlippagePct: 8.5,
        durationMs: 50,
      });
      const result = await runPhaseB(baseEvent, checker, BUDGET_MS);
      expect(result.trace.honeypot.classification).toBe('CLEAN');
      expect(result.trace.honeypot.sellQuoteSlippagePct).toBe(8.5);
    });
  });
});
