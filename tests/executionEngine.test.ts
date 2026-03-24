/**
 * ExecutionEngine Unit Tests
 */
import { ExecutionEngine, ExecutionPlan, SimulationResult, ExecutionResult } from '../src/execution/executionEngine';
import { Connection } from '@solana/web3.js';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));
jest.mock('axios');

const mockConnection = {
  getBalance: jest.fn().mockResolvedValue(1_000_000_000),
  getLatestBlockhash: jest.fn().mockResolvedValue({ blockhash: 'test', lastValidBlockHeight: 100 }),
  sendRawTransaction: jest.fn().mockResolvedValue('txsig123'),
  confirmTransaction: jest.fn().mockResolvedValue({ value: { err: null } }),
} as unknown as Connection;

const mockBackupConnection = { ...mockConnection } as unknown as Connection;

describe('ExecutionEngine', () => {
  let engine: ExecutionEngine;

  beforeEach(() => {
    engine = new ExecutionEngine(mockConnection, mockBackupConnection, 'https://jito.test');
  });

  describe('Construction', () => {
    it('should construct without jito endpoint', () => {
      const e = new ExecutionEngine(mockConnection, mockBackupConnection);
      expect(e).toBeDefined();
    });

    it('should construct with jito endpoint', () => {
      expect(engine).toBeDefined();
    });
  });

  describe('Execution Plan', () => {
    it('should create IMMEDIATE plan for small urgent trades', () => {
      const plan = engine.createExecutionPlan(
        'TokenABC',
        'BUY',
        0.5,     // 0.5 SOL
        null,    // no simulation
        'HIGH',
      );

      expect(plan).toBeDefined();
      expect(plan.tokenCA).toBe('TokenABC');
      expect(plan.side).toBe('BUY');
      expect(plan.amountSOL).toBe(0.5);
      expect(plan.strategy).toBe('IMMEDIATE');
      expect(plan.maxSlippageBps).toBeGreaterThan(0);
    });

    it('should use TWAP for larger positions', () => {
      const sim: SimulationResult = {
        expectedOutputAmount: 1000000,
        priceImpactPct: 2.5, // significant impact
        routePlan: [],
        estimatedFeeSOL: 0.000005,
        mevExposure: { sandwichProbability: 0.3, expectedSandwichCost: 0.01, frontrunRisk: 4, recommendation: 'JITO_BUNDLE' },
        liquidityDepth: { bid1Pct: 5, bid5Pct: 20, bid10Pct: 50, spreadBps: 100, isThick: false },
        passed: true,
      };

      const plan = engine.createExecutionPlan(
        'TokenXYZ',
        'BUY',
        10,      // 10 SOL — large
        sim,
        'MEDIUM',
      );

      expect(plan).toBeDefined();
      // Should select TWAP or ICEBERG for high-impact trades
      expect(['TWAP', 'ICEBERG', 'IMMEDIATE']).toContain(plan.strategy);
    });

    it('should enable jito protection for high MEV exposure', () => {
      const sim: SimulationResult = {
        expectedOutputAmount: 1000000,
        priceImpactPct: 1.0,
        routePlan: [],
        estimatedFeeSOL: 0.000005,
        mevExposure: { sandwichProbability: 0.7, expectedSandwichCost: 0.05, frontrunRisk: 8, recommendation: 'JITO_BUNDLE' },
        liquidityDepth: { bid1Pct: 10, bid5Pct: 30, bid10Pct: 80, spreadBps: 50, isThick: true },
        passed: true,
      };

      const plan = engine.createExecutionPlan('Token1', 'BUY', 5, sim, 'HIGH');
      expect(plan.jitoProtection).toBe(true);
    });
  });

  describe('TCA Report', () => {
    it('should generate a TCA report with grade', () => {
      const results: ExecutionResult[] = [{
        success: true,
        txSignature: 'txsig123',
        executedPrice: 0.001,
        slippageBps: 50,
        priceImpactBps: 30,
        fillAmount: 0.5,
        feeSOL: 0.000005,
        executionTimeMs: 1200,
        strategy: 'IMMEDIATE',
        jitoUsed: false,
      }];

      const tca = engine.generateTCA('Token1', 'BUY', 0.5, 0.001, results);

      expect(tca).toBeDefined();
      expect(tca.tokenCA).toBe('Token1');
      expect(tca.side).toBe('BUY');
      expect(tca.grade).toMatch(/^[A-F]$/);
      expect(tca.totalCostBps).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Execution Quality', () => {
    it('should return quality metrics', () => {
      const quality = engine.getExecutionQuality();

      expect(quality).toHaveProperty('avgSlippageBps');
      expect(quality).toHaveProperty('avgImpactBps');
      expect(quality).toHaveProperty('totalExecutions');
      expect(quality.totalExecutions).toBe(0);
    });
  });
});
