import { runSafetyPipeline } from '../src/safety/orchestrator';
import { runPhaseA, PhaseAResult } from '../src/safety/phaseA';
import { runPhaseB, PhaseBResult } from '../src/safety/phaseB';
import { PumpSwapGraduationEvent } from '../src/core/types';
import { TokenSafetyChecker } from '../src/safety/tokenSafetyChecker';

jest.mock('../src/safety/phaseA');
jest.mock('../src/safety/phaseB');

const mockedRunPhaseA = runPhaseA as jest.MockedFunction<typeof runPhaseA>;
const mockedRunPhaseB = runPhaseB as jest.MockedFunction<typeof runPhaseB>;

const baseEvent: PumpSwapGraduationEvent = {
  signature: 'test-sig',
  slot: 416647963,
  tokenCA: '6Aixvhgirbn8rHmAtFnwHNBqgxtenKDz8ycvHeQepump',
  poolAddress: '7ugTEN5mq5kGURByfXrK1AqTAJ76wQMauggskosVzEoK',
  deployer: 'DeployerWa11et1111111111111111111111111111111',
  initialLiquiditySOL: 99,
  detectedAt: Date.now(),
};

const mockTokenSafetyChecker = {} as unknown as TokenSafetyChecker;

function phaseAPass(): PhaseAResult {
  return {
    passed: true,
    trace: {
      liquidity: { passed: true, valueSOL: 99 },
      scammyName: { passed: true },
    },
    durationMs: 1,
  };
}

function phaseAFail(failedCheck: 'liquidity' | 'scammyName'): PhaseAResult {
  return {
    passed: false,
    failedCheck,
    trace: failedCheck === 'liquidity'
      ? { liquidity: { passed: false, valueSOL: 1 } }
      : { liquidity: { passed: true, valueSOL: 99 }, scammyName: { passed: false } },
    durationMs: 1,
  };
}

function phaseBPass(): PhaseBResult {
  return {
    passed: true,
    trace: {
      lpLock: { passed: true, locked: true },
      mintAuthority: { passed: true, revoked: true },
      freezeAuthority: { passed: true, revoked: true },
      holderConcentration: { passed: true, topPct: 15 },
      honeypot: { passed: true, classification: 'CLEAN', sellQuoteSlippagePct: 5 },
      deployerBlacklist: { passed: true },
    },
    durationMs: 220,
  };
}

function phaseBFail(): PhaseBResult {
  return {
    passed: false,
    failedCheck: 'honeypot',
    trace: {
      lpLock: { passed: true, locked: true },
      mintAuthority: { passed: true, revoked: true },
      freezeAuthority: { passed: true, revoked: true },
      holderConcentration: { passed: true, topPct: 15 },
      honeypot: { passed: false, classification: 'INDEX_LAG' },
      deployerBlacklist: { passed: true },
    },
    durationMs: 280,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runSafetyPipeline', () => {
  describe('short-circuit on Phase A failure', () => {
    it('returns failedPhase A and does NOT invoke Phase B when Phase A fails liquidity', async () => {
      mockedRunPhaseA.mockReturnValueOnce(phaseAFail('liquidity'));

      const result = await runSafetyPipeline(baseEvent, mockTokenSafetyChecker, 'PEPE');

      expect(result.passed).toBe(false);
      expect(result.failedPhase).toBe('A');
      expect(result.phaseA.failedCheck).toBe('liquidity');
      expect(result.phaseB).toBeUndefined();
      expect(mockedRunPhaseB).not.toHaveBeenCalled();
    });

    it('short-circuits on Phase A scammyName failure', async () => {
      mockedRunPhaseA.mockReturnValueOnce(phaseAFail('scammyName'));

      const result = await runSafetyPipeline(baseEvent, mockTokenSafetyChecker, 'rug');

      expect(result.passed).toBe(false);
      expect(result.failedPhase).toBe('A');
      expect(result.phaseA.failedCheck).toBe('scammyName');
      expect(mockedRunPhaseB).not.toHaveBeenCalled();
    });

    it('trace contains only Phase A fields on short-circuit', async () => {
      mockedRunPhaseA.mockReturnValueOnce(phaseAFail('scammyName'));

      const result = await runSafetyPipeline(baseEvent, mockTokenSafetyChecker, 'rug');

      expect(result.trace.liquidity).toBeDefined();
      expect(result.trace.scammyName).toBeDefined();
      expect(result.trace.lpLock).toBeUndefined();
      expect(result.trace.honeypot).toBeUndefined();
    });
  });

  describe('full pipeline execution', () => {
    it('runs Phase B when Phase A passes', async () => {
      mockedRunPhaseA.mockReturnValueOnce(phaseAPass());
      mockedRunPhaseB.mockResolvedValueOnce(phaseBPass());

      const result = await runSafetyPipeline(baseEvent, mockTokenSafetyChecker, 'PEPE');

      expect(result.passed).toBe(true);
      expect(result.failedPhase).toBeUndefined();
      expect(result.phaseB).toBeDefined();
      expect(mockedRunPhaseB).toHaveBeenCalledTimes(1);
    });

    it('passes 500ms budget to Phase B', async () => {
      mockedRunPhaseA.mockReturnValueOnce(phaseAPass());
      mockedRunPhaseB.mockResolvedValueOnce(phaseBPass());

      await runSafetyPipeline(baseEvent, mockTokenSafetyChecker, 'PEPE');

      expect(mockedRunPhaseB).toHaveBeenCalledWith(
        baseEvent,
        mockTokenSafetyChecker,
        500,
        undefined,
      );
    });

    it('forwards antifragile engine to Phase B', async () => {
      mockedRunPhaseA.mockReturnValueOnce(phaseAPass());
      mockedRunPhaseB.mockResolvedValueOnce(phaseBPass());
      const fakeAntifragile = { canUseJupiter: jest.fn() } as never;

      await runSafetyPipeline(baseEvent, mockTokenSafetyChecker, 'PEPE', fakeAntifragile);

      expect(mockedRunPhaseB).toHaveBeenCalledWith(
        baseEvent,
        mockTokenSafetyChecker,
        500,
        fakeAntifragile,
      );
    });

    it('merged trace contains all 8 fields on full success', async () => {
      mockedRunPhaseA.mockReturnValueOnce(phaseAPass());
      mockedRunPhaseB.mockResolvedValueOnce(phaseBPass());

      const result = await runSafetyPipeline(baseEvent, mockTokenSafetyChecker, 'PEPE');

      expect(result.trace.liquidity).toBeDefined();
      expect(result.trace.scammyName).toBeDefined();
      expect(result.trace.lpLock).toBeDefined();
      expect(result.trace.mintAuthority).toBeDefined();
      expect(result.trace.freezeAuthority).toBeDefined();
      expect(result.trace.holderConcentration).toBeDefined();
      expect(result.trace.honeypot).toBeDefined();
      expect(result.trace.deployerBlacklist).toBeDefined();
    });
  });

  describe('Phase B failure attribution', () => {
    it('returns failedPhase B when Phase A passes but Phase B fails', async () => {
      mockedRunPhaseA.mockReturnValueOnce(phaseAPass());
      mockedRunPhaseB.mockResolvedValueOnce(phaseBFail());

      const result = await runSafetyPipeline(baseEvent, mockTokenSafetyChecker, 'PEPE');

      expect(result.passed).toBe(false);
      expect(result.failedPhase).toBe('B');
      expect(result.phaseB?.failedCheck).toBe('honeypot');
    });
  });

  describe('telemetry', () => {
    it('outer durationMs is a number on all paths', async () => {
      mockedRunPhaseA.mockReturnValueOnce(phaseAFail('liquidity'));
      const result = await runSafetyPipeline(baseEvent, mockTokenSafetyChecker);
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});