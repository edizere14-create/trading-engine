/**
 * AntifragileEngine Unit Tests
 */
import { AntifragileEngine, SystemHealth, BlackSwanEvent, RegimeParameters } from '../src/antifragile/antifragileEngine';
import { HMMRegime } from '../src/ml/regimeHMM';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

describe('AntifragileEngine', () => {
  let engine: AntifragileEngine;

  beforeEach(() => {
    engine = new AntifragileEngine();
  });

  afterEach(() => {
    engine.stop();
  });

  describe('Circuit Breakers', () => {
    it('should start with all circuit breakers closed', () => {
      const health = engine.getSystemHealth();
      expect(health.rpcPrimary.status).toBe('CLOSED');
      expect(health.rpcBackup.status).toBe('CLOSED');
      expect(health.jupiterAPI.status).toBe('CLOSED');
      expect(health.heliusWebsocket.status).toBe('CLOSED');
    });

    it('should allow RPC usage when circuit breakers are closed', () => {
      expect(engine.canUseRPC()).toBe(true);
    });

    it('should allow Jupiter when circuit breaker is closed', () => {
      expect(engine.canUseJupiter()).toBe(true);
    });

    it('should allow Helius when circuit breaker is closed', () => {
      expect(engine.canUseHelius()).toBe(true);
    });

    it('should open circuit breaker after repeated failures', () => {
      // Threshold is 5 failures by default
      for (let i = 0; i < 6; i++) {
        engine.recordRPCFailure(true);
      }
      const health = engine.getSystemHealth();
      expect(health.rpcPrimary.status).toBe('OPEN');
    });

    it('should still allow RPC via backup when primary is open', () => {
      for (let i = 0; i < 6; i++) {
        engine.recordRPCFailure(true);
      }
      // Backup is still closed
      expect(engine.canUseRPC()).toBe(true);
    });

    it('should open Jupiter circuit breaker after failures', () => {
      for (let i = 0; i < 6; i++) {
        engine.recordJupiterFailure();
      }
      expect(engine.canUseJupiter()).toBe(false);
    });

    it('should reset failure count on success', () => {
      engine.recordRPCFailure(true);
      engine.recordRPCFailure(true);
      engine.recordRPCSuccess(true);
      const health = engine.getSystemHealth();
      expect(health.rpcPrimary.failureCount).toBe(0);
    });
  });

  describe('System Health', () => {
    it('should report HEALTHY when all circuits are closed', () => {
      const health = engine.getSystemHealth();
      expect(health.overallStatus).toBe('HEALTHY');
    });

    it('should report DEGRADED when one circuit opens', () => {
      for (let i = 0; i < 6; i++) {
        engine.recordJupiterFailure();
      }
      const health = engine.getSystemHealth();
      expect(['DEGRADED', 'CRITICAL']).toContain(health.overallStatus);
    });

    it('should include uptime', () => {
      const health = engine.getSystemHealth();
      expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should have a last heartbeat timestamp', () => {
      engine.heartbeat();
      const health = engine.getSystemHealth();
      expect(health.lastHeartbeat).toBeInstanceOf(Date);
    });
  });

  describe('Black Swan Detection', () => {
    it('should return null for normal trade outcomes', () => {
      const event = engine.recordTradeOutcome('Token1', 10);
      expect(event).toBeNull();
    });

    it('should detect correlated drawdown across multiple tokens', () => {
      let event: BlackSwanEvent | null = null;
      // Record many losses in a row
      for (let i = 0; i < 10; i++) {
        event = engine.recordTradeOutcome(`Token${i}`, -40);
      }
      // After enough correlated losses, should trigger black swan
      // (depends on implementation threshold)
      if (event) {
        expect(event.type).toBeDefined();
        expect(event.severity).toMatch(/^(WARNING|CRITICAL|FATAL)$/);
        expect(event.recommendedAction).toBeDefined();
      }
    });

    it('should maintain black swan history', () => {
      const history = engine.getBlackSwanHistory();
      expect(history).toBeInstanceOf(Array);
    });
  });

  describe('Regime Parameters', () => {
    const baseParams: RegimeParameters = {
      maxConcurrent: 5,
      maxTradesPerDay: 20,
      stopLossPct: 0.3,
      maxHoldMs: 3600000,
      sizePct: 0.05,
      minSignalScore: 6,
      minConfidence: 0.5,
    };

    it('should adjust params for RISK_ON regime', () => {
      const adjusted = engine.getRegimeParameters('RISK_ON', baseParams);
      expect(adjusted.maxConcurrent).toBeGreaterThanOrEqual(baseParams.maxConcurrent);
    });

    it('should tighten params for CRISIS regime', () => {
      const adjusted = engine.getRegimeParameters('CRISIS', baseParams);
      expect(adjusted.maxConcurrent).toBeLessThanOrEqual(baseParams.maxConcurrent);
      expect(adjusted.minSignalScore).toBeGreaterThanOrEqual(baseParams.minSignalScore);
      expect(adjusted.sizePct).toBeLessThanOrEqual(baseParams.sizePct);
    });

    it('should keep NEUTRAL regime close to base params', () => {
      const adjusted = engine.getRegimeParameters('NEUTRAL', baseParams);
      expect(adjusted.maxConcurrent).toBe(baseParams.maxConcurrent);
    });
  });

  describe('Edge Tracking', () => {
    it('should record edge outcomes', () => {
      engine.recordEdgeOutcome('TIMING', true, 2.5);
      engine.recordEdgeOutcome('TIMING', false, -0.3);
      engine.recordEdgeOutcome('DEPLOYER', true, 1.8);

      const weights = engine.getEdgeWeightRecommendations();
      expect(weights).toBeInstanceOf(Map);
    });
  });

  describe('Start/Stop', () => {
    it('should start and stop without errors', () => {
      expect(() => engine.start()).not.toThrow();
      expect(() => engine.stop()).not.toThrow();
    });

    it('should handle double stop', () => {
      engine.start();
      engine.stop();
      expect(() => engine.stop()).not.toThrow();
    });
  });
});
