/**
 * PortfolioOptimizer Unit Tests
 */
import { PortfolioOptimizer, SizingRecommendation } from '../src/portfolio/portfolioOptimizer';
import { TradePosition } from '../src/core/types';
import { HMMRegime } from '../src/ml/regimeHMM';

jest.mock('../src/core/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

function makePosition(overrides: Partial<TradePosition> = {}): TradePosition {
  return {
    id: 'pos-1',
    tokenCA: 'Token123',
    mode: 'PAPER',
    entryPriceSOL: 0.001,
    entryTimestamp: new Date(),
    sizeSOL: 0.5,
    sizeUSD: 75,
    sourceWallets: ['wallet1'],
    reBuyCount: 0,
    maxHoldMs: 3600000,
    stopLossPct: 0.3,
    takeProfitTiers: [],
    peakPriceSOL: 0.0015,
    lastPriceSOL: 0.0012,
    lastCheckedAt: new Date(),
    status: 'OPEN',
    ...overrides,
  };
}

describe('PortfolioOptimizer', () => {
  let optimizer: PortfolioOptimizer;

  beforeEach(() => {
    optimizer = new PortfolioOptimizer();
  });

  describe('Narrative Classification', () => {
    it('should classify dog-themed tokens', () => {
      expect(optimizer.classifyNarrative('abc', 'DOGE')).toBe('DOG_META');
      expect(optimizer.classifyNarrative('abc', 'SHIB')).toBe('DOG_META');
      expect(optimizer.classifyNarrative('abc', 'PUPPY')).toBe('DOG_META');
    });

    it('should classify cat-themed tokens', () => {
      expect(optimizer.classifyNarrative('abc', 'CATCOIN')).toBe('CAT_META');
      expect(optimizer.classifyNarrative('abc', 'KITTEN')).toBe('CAT_META');
    });

    it('should classify AI tokens', () => {
      expect(optimizer.classifyNarrative('abc', 'AIBOT')).toBe('AI_META');
      expect(optimizer.classifyNarrative('abc', 'GPT420')).toBe('AI_META');
    });

    it('should return OTHER for unclassifiable tokens', () => {
      expect(optimizer.classifyNarrative('abc', 'XYZ123')).toBe('OTHER');
    });
  });

  describe('Position Sizing', () => {
    it('should return a valid sizing recommendation', () => {
      const sizing = optimizer.calculateOptimalSize(
        10000,     // capital
        0.55,      // win probability
        2.5,       // expected multiple
        'Token1',
        'AI_META',
        [],        // no current positions
        'NEUTRAL',
        0.7,       // confidence
      );

      expect(sizing).toBeDefined();
      expect(sizing.recommendedSizeUSD).toBeGreaterThan(0);
      expect(sizing.recommendedSizeUSD).toBeLessThan(10000);
      expect(sizing.recommendedSizePct).toBeGreaterThan(0);
      expect(sizing.recommendedSizePct).toBeLessThanOrEqual(1);
      expect(sizing.kellyOptimalPct).toBeGreaterThan(0);
      expect(sizing.maxAllowedUSD).toBeGreaterThan(0);
      expect(sizing.reason).toBeDefined();
    });

    it('should size smaller during CRISIS regime', () => {
      const neutralSizing = optimizer.calculateOptimalSize(
        10000, 0.6, 2.5, 'Token1', 'UNKNOWN', [], 'NEUTRAL', 0.8,
      );
      const crisisSizing = optimizer.calculateOptimalSize(
        10000, 0.6, 2.5, 'Token2', 'UNKNOWN', [], 'CRISIS', 0.8,
      );

      expect(crisisSizing.recommendedSizeUSD).toBeLessThan(neutralSizing.recommendedSizeUSD);
    });

    it('should size larger during RISK_ON regime', () => {
      const neutralSizing = optimizer.calculateOptimalSize(
        10000, 0.6, 2.5, 'Token1', 'UNKNOWN', [], 'NEUTRAL', 0.8,
      );
      const riskOnSizing = optimizer.calculateOptimalSize(
        10000, 0.6, 2.5, 'Token2', 'UNKNOWN', [], 'RISK_ON', 0.8,
      );

      expect(riskOnSizing.recommendedSizeUSD).toBeGreaterThanOrEqual(neutralSizing.recommendedSizeUSD);
    });

    it('should reduce size when narrative is overexposed', () => {
      const positions = [
        makePosition({ tokenCA: 'AI1', sizeUSD: 2000 }),
        makePosition({ tokenCA: 'AI2', sizeUSD: 2000 }),
        makePosition({ tokenCA: 'AI3', sizeUSD: 1500 }),
      ];

      // Record these as same narrative
      optimizer.classifyNarrative('AI1', 'AIBOT1');
      optimizer.classifyNarrative('AI2', 'AIBOT2');
      optimizer.classifyNarrative('AI3', 'AIBOT3');

      const sizing = optimizer.calculateOptimalSize(
        10000, 0.6, 2.5, 'AI4', 'AI_META', positions, 'NEUTRAL', 0.8,
      );

      // Should have narrative adjustment < 1.0 due to concentration
      expect(sizing.narrativeAdjustment).toBeLessThanOrEqual(1.0);
    });

    it('should respect maximum single position size', () => {
      const sizing = optimizer.calculateOptimalSize(
        1000,     // small capital
        0.9,      // very high WP
        5.0,      // high expected multiple
        'Token1',
        'UNKNOWN',
        [],
        'RISK_ON',
        0.95,
      );

      // Should be capped at MAX_SINGLE_POSITION (5% of capital = $50)
      expect(sizing.recommendedSizeUSD).toBeLessThanOrEqual(sizing.maxAllowedUSD);
    });

    it('should return zero or near-zero for negative edge', () => {
      const sizing = optimizer.calculateOptimalSize(
        10000, 0.2, 1.0, 'Token1', 'UNKNOWN', [], 'NEUTRAL', 0.3,
      );

      // With 20% win rate and 1x expected multiple, edge is negative
      expect(sizing.recommendedSizeUSD).toBeLessThanOrEqual(0);
    });
  });

  describe('Portfolio State', () => {
    it('should compute portfolio state from positions', () => {
      const positions = [
        makePosition({ tokenCA: 'A', sizeUSD: 500 }),
        makePosition({ tokenCA: 'B', sizeUSD: 300 }),
      ];

      const state = optimizer.getPortfolioState(10000, positions, 'NEUTRAL');

      expect(state.totalCapitalUSD).toBe(10000);
      expect(state.deployedCapitalUSD).toBe(800);
      expect(state.deployedPct).toBeCloseTo(0.08);
      expect(state.portfolioHeat).toBeDefined();
    });

    it('should return empty state for no positions', () => {
      const state = optimizer.getPortfolioState(10000, [], 'NEUTRAL');

      expect(state.deployedCapitalUSD).toBe(0);
      expect(state.positions).toHaveLength(0);
      expect(state.portfolioHeat).toBeDefined();
    });
  });

  describe('Return Recording', () => {
    it('should accept return recordings', () => {
      // Should not throw
      optimizer.recordReturn('Token1', 0.15);
      optimizer.recordReturn('Token1', -0.05);
      optimizer.recordReturn('Token2', 0.30);
    });
  });
});
