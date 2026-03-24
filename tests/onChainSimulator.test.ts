/**
 * OnChainSimulator Unit Tests
 */
import { OnChainSimulator, SandwichEstimate, ExitRiskModel } from '../src/simulation/onChainSimulator';
import { Connection } from '@solana/web3.js';

jest.mock('../src/core/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

const mockConnection = {
  getAccountInfo: jest.fn().mockResolvedValue({ data: Buffer.alloc(0), owner: { toString: () => 'test' } }),
  getBalance: jest.fn().mockResolvedValue(50_000_000_000), // 50 SOL
  getTokenLargestAccounts: jest.fn().mockResolvedValue({
    value: [
      { address: 'acc1', amount: '1000000', uiAmount: 100 },
      { address: 'acc2', amount: '500000', uiAmount: 50 },
    ],
  }),
  getParsedProgramAccounts: jest.fn().mockResolvedValue([]),
  getTokenSupply: jest.fn().mockResolvedValue({ value: { uiAmount: 1000000 } }),
} as unknown as Connection;

describe('OnChainSimulator', () => {
  let simulator: OnChainSimulator;

  beforeEach(() => {
    simulator = new OnChainSimulator(mockConnection);
  });

  describe('Sandwich Risk Estimation', () => {
    it('should return SAFE for small trades in deep pool', () => {
      const estimate = simulator.estimateSandwichRisk(
        100,    // 100 SOL pool reserves
        0.1,    // 0.1 SOL trade
        0.1,    // 0.1% price impact
      );

      expect(estimate).toBeDefined();
      expect(estimate.vulnerability).toBeGreaterThanOrEqual(0);
      expect(estimate.vulnerability).toBeLessThanOrEqual(10);
      expect(estimate.recommendation).toBe('SAFE');
    });

    it('should flag high vulnerability for large trades in thin pool', () => {
      const estimate = simulator.estimateSandwichRisk(
        5,      // only 5 SOL reserves (thin)
        3,      // 3 SOL trade (60% of pool)
        15,     // 15% impact
      );

      expect(estimate.vulnerability).toBeGreaterThan(4);
      expect(['USE_JITO', 'ABORT', 'REDUCE_SIZE']).toContain(estimate.recommendation);
    });

    it('should estimate expected cost in bps', () => {
      const estimate = simulator.estimateSandwichRisk(50, 5, 5);
      expect(estimate.expectedCostBps).toBeGreaterThanOrEqual(0);
    });

    it('should compute optimal frontrun size', () => {
      const estimate = simulator.estimateSandwichRisk(50, 2, 2);
      expect(estimate.optimalFrontrunSize).toBeGreaterThan(0);
      expect(estimate.optimalFrontrunSize).toBeLessThan(2); // Less than trade size
    });

    it('should provide profitable threshold', () => {
      const estimate = simulator.estimateSandwichRisk(50, 1, 1);
      expect(estimate.profitableAbove).toBeGreaterThan(0);
    });
  });

  describe('Exit Risk Modeling', () => {
    it('should model exit risk for standard position', () => {
      const risk = simulator.modelExitRisk(
        2,        // 2 SOL position
        50,       // 50 SOL reserves
        50000,    // 50k token reserves
        0.05,     // slightly growing liquidity
      );

      expect(risk).toBeDefined();
      expect(risk.currentLiquiditySOL).toBe(50);
      expect(risk.estimatedExitSlippagePct).toBeGreaterThan(0);
      expect(risk.riskScore).toBeGreaterThanOrEqual(0);
      expect(risk.riskScore).toBeLessThanOrEqual(10);
      expect(risk.liquidityTrend).toBe('STABLE');
    });

    it('should flag high risk for large position relative to pool', () => {
      const risk = simulator.modelExitRisk(
        20,       // 20 SOL position (40% of pool)
        50,       // 50 SOL reserves
        50000,    // 50k tokens
        -0.5,     // draining liquidity
      );

      expect(risk.riskScore).toBeGreaterThan(5);
      expect(risk.liquidityTrend).toBe('DRAINING');
      expect(risk.optimalExitChunkSOL).toBeLessThan(20); // Should chunk
    });

    it('should recommend chunked exit for high-impact positions', () => {
      const risk = simulator.modelExitRisk(10, 20, 20000, 0);

      // With 50% of pool, impact will be high → should chunk
      expect(risk.optimalExitChunkSOL).toBeLessThanOrEqual(10);
      expect(risk.optimalExitIntervalMs).toBeGreaterThan(0);
    });

    it('should classify liquidity trends correctly', () => {
      const growing = simulator.modelExitRisk(1, 50, 50000, 0.2);
      expect(growing.liquidityTrend).toBe('GROWING');

      const stable = simulator.modelExitRisk(1, 50, 50000, 0.0);
      expect(stable.liquidityTrend).toBe('STABLE');

      const declining = simulator.modelExitRisk(1, 50, 50000, -0.2);
      expect(declining.liquidityTrend).toBe('DECLINING');

      const draining = simulator.modelExitRisk(1, 50, 50000, -0.5);
      expect(draining.liquidityTrend).toBe('DRAINING');
    });

    it('should return time to exit estimate', () => {
      const risk = simulator.modelExitRisk(5, 50, 50000, 0);
      expect(risk.timeToExit).toBeGreaterThan(0);
    });
  });

  describe('Pool Simulation', () => {
    it('should return conservative defaults on connection failure', async () => {
      const failConn = {
        getAccountInfo: jest.fn().mockResolvedValue(null),
      } as unknown as Connection;

      const sim = new OnChainSimulator(failConn);
      const result = await sim.simulatePool('invalidPool123456789012345678901234567890123', 'tokenXYZ');

      expect(result.reserveSOL).toBe(0);
      expect(result.liquidityScore).toBe(0);
      expect(result.isDeepEnough).toBe(false);
      expect(result.holderDistribution).toBe('WHALE_DOMINATED');
    });
  });
});
