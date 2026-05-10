import { runPhaseA } from '../src/safety/phaseA';
import { PumpSwapGraduationEvent } from '../src/core/types';

const baseEvent: PumpSwapGraduationEvent = {
  signature: 'test-sig',
  slot: 416647963,
  tokenCA: '6Aixvhgirbn8rHmAtFnwHNBqgxtenKDz8ycvHeQepump',
  poolAddress: '7ugTEN5mq5kGURByfXrK1AqTAJ76wQMauggskosVzEoK',
  deployer: 'DeployerWa11et1111111111111111111111111111111',
  initialLiquiditySOL: 99,
  detectedAt: Date.now(),
};

describe('runPhaseA', () => {
  describe('liquidity gate', () => {
    it('passes when liquidity >= 3 SOL', () => {
      const result = runPhaseA({ ...baseEvent, initialLiquiditySOL: 3 });
      expect(result.passed).toBe(true);
      expect(result.trace.liquidity).toEqual({ passed: true, valueSOL: 3 });
    });

    it('passes well above threshold', () => {
      const result = runPhaseA({ ...baseEvent, initialLiquiditySOL: 99 });
      expect(result.passed).toBe(true);
      expect(result.trace.liquidity?.valueSOL).toBe(99);
    });

    it('rejects when liquidity < 3 SOL', () => {
      const result = runPhaseA({ ...baseEvent, initialLiquiditySOL: 2.99 });
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('liquidity');
      expect(result.trace.liquidity).toEqual({ passed: false, valueSOL: 2.99 });
    });

    it('rejects on zero liquidity', () => {
      const result = runPhaseA({ ...baseEvent, initialLiquiditySOL: 0 });
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('liquidity');
    });

    it('does not populate scammyName trace when liquidity short-circuits', () => {
      const result = runPhaseA({ ...baseEvent, initialLiquiditySOL: 1 }, 'rug');
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('liquidity');
      expect(result.trace.scammyName).toBeUndefined();
    });
  });

  describe('scammyName gate', () => {
    it('passes when name is clean and liquidity adequate', () => {
      const result = runPhaseA(baseEvent, 'PEPE');
      expect(result.passed).toBe(true);
      expect(result.trace.scammyName).toEqual({ passed: true });
    });

    it('passes when name is missing (no signal == not scam signal)', () => {
      const result = runPhaseA(baseEvent, undefined);
      expect(result.passed).toBe(true);
      expect(result.trace.scammyName).toEqual({ passed: true });
    });

    it('passes when name is null', () => {
      const result = runPhaseA(baseEvent, null);
      expect(result.passed).toBe(true);
    });

    it('rejects on standalone "rug"', () => {
      const result = runPhaseA(baseEvent, 'rug pull coin');
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('scammyName');
      expect(result.trace.scammyName).toEqual({ passed: false });
    });

    it('rejects on "honeypot" anywhere in name', () => {
      const result = runPhaseA(baseEvent, 'MyHoneypotCoin');
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('scammyName');
    });

    it('populates liquidity trace even when scammyName fails', () => {
      const result = runPhaseA(baseEvent, 'rug');
      expect(result.failedCheck).toBe('scammyName');
      expect(result.trace.liquidity).toEqual({ passed: true, valueSOL: 99 });
      expect(result.trace.scammyName).toEqual({ passed: false });
    });
  });

  describe('full pass', () => {
    it('all checks pass with clean event', () => {
      const result = runPhaseA(baseEvent, 'Doge Killer');
      expect(result.passed).toBe(true);
      expect(result.failedCheck).toBeUndefined();
      expect(result.trace.liquidity?.passed).toBe(true);
      expect(result.trace.scammyName?.passed).toBe(true);
    });
  });

  describe('telemetry', () => {
    it('returns durationMs as a number', () => {
      const result = runPhaseA(baseEvent, 'PEPE');
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns durationMs on failure path too', () => {
      const result = runPhaseA({ ...baseEvent, initialLiquiditySOL: 1 });
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
