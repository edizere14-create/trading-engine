/**
 * OnlineLearner Unit Tests
 */
import { OnlineLearner, MLFeatureVector } from '../src/ml/onlineLearner';
import { SignalVector } from '../src/core/types';
import { MicrostructureFeatures } from '../src/microstructure/featureExtractor';
import fs from 'fs';
import path from 'path';

// Mock the event bus and logger to prevent side effects
jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

const TEST_MODEL_PATH = './data/test_ml_model.json';

function makeSignal(overrides: Partial<SignalVector> = {}): SignalVector {
  return {
    timingEdge: 7,
    deployerQuality: 6,
    organicFlow: 5,
    manipulationRisk: 8,
    coordinationStrength: 4,
    socialVelocity: 3,
    totalScore: 33,
    confidence: 0.75,
    ...overrides,
  };
}

function makeMicro(overrides: Partial<MicrostructureFeatures> = {}): MicrostructureFeatures {
  return {
    tokenCA: 'TokenABC123',
    windowMs: 30000,
    buyClusterCount: 5,
    buyClusterFrequency: 0.4,
    uniqueBuyers: 15,
    uniqueSellers: 5,
    walletDiversityScore: 0.7,
    liquidityGrowthSlope: 0.3,
    volumeSpikeSlope: 0.5,
    volumeAccelerating: true,
    impulseExhaustionScore: 0.2,
    buyToSellRatio: 3.0,
    averageBuySizeSOL: 2.5,
    buySizeDecelerating: false,
    smartWalletBuyCount: 3,
    smartWalletSellCount: 1,
    smartMoneyNetFlow: 0.6,
    capturedAt: new Date(),
    ...overrides,
  };
}

describe('OnlineLearner', () => {
  let learner: OnlineLearner;

  beforeEach(() => {
    learner = new OnlineLearner(TEST_MODEL_PATH);
  });

  afterAll(() => {
    // Cleanup test model file
    const resolved = path.resolve(TEST_MODEL_PATH);
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  });

  describe('Feature Extraction', () => {
    it('should extract features from signal + microstructure', () => {
      const signal = makeSignal();
      const micro = makeMicro();
      const features = learner.extractFeatures(signal, micro, 0.5, 0.7, 0.9);

      expect(features).toBeDefined();
      expect(features.timingEdge).toBeCloseTo(0.7); // 7/10 normalized
      expect(features.deployerQuality).toBeCloseTo(0.6);
      // regimeScore goes through Math.tanh
      expect(features.regimeScore).toBeCloseTo(Math.tanh(0.5), 5);
      expect(features.marketHeat).toBe(0.7);
      expect(features.survivalMultiplier).toBe(0.9);
    });

    it('should handle null microstructure gracefully', () => {
      const signal = makeSignal();
      const features = learner.extractFeatures(signal, null, 0.0, 0.5, 1.0);

      expect(features).toBeDefined();
      // When micro is null, defaults are used: walletDiversity=5/10=0.5, exhaust=5/10=0.5
      expect(features.walletDiversityNorm).toBeCloseTo(0.5);
      expect(features.exhaustionNorm).toBeCloseTo(0.5);
    });

    it('should compute interaction features', () => {
      const signal = makeSignal({ timingEdge: 8, coordinationStrength: 6 });
      const features = learner.extractFeatures(signal, null, 0, 0.5, 1);

      // timingXcoordination = (8/10) * (6/10) = 0.48
      expect(features.timingXcoordination).toBeCloseTo(0.48);
    });

    it('should normalize extreme values via division', () => {
      const signal = makeSignal({ timingEdge: 15, deployerQuality: -5 });
      const features = learner.extractFeatures(signal, null, 2, 5, -1);

      // timingEdge: 15/10 = 1.5 (no clamping, just division)
      expect(features.timingEdge).toBeCloseTo(1.5);
      // deployerQuality: Math.max(0, -5)/10 = 0
      expect(features.deployerQuality).toBeCloseTo(0);
    });
  });

  describe('Prediction', () => {
    it('should return a valid prediction', () => {
      const signal = makeSignal();
      const features = learner.extractFeatures(signal, makeMicro(), 0.3, 0.5, 0.8);
      const prediction = learner.predict(features);

      expect(prediction).toBeDefined();
      expect(prediction.winProbability).toBeGreaterThanOrEqual(0);
      expect(prediction.winProbability).toBeLessThanOrEqual(1);
      expect(prediction.confidence).toBeGreaterThanOrEqual(0);
      expect(prediction.confidence).toBeLessThanOrEqual(1);
      expect(prediction.expectedValue).toBeDefined();
      expect(prediction.predictedMultiple).toBeDefined();
      expect(prediction.regime).toMatch(/^(EXPLOIT|EXPLORE)$/);
      expect(prediction.optimalExitStrategy).toBeDefined();
      expect(prediction.optimalExitStrategy.stopLossPct).toBeGreaterThan(0);
      expect(prediction.optimalExitStrategy.tiers).toBeInstanceOf(Array);
    });

    it('should return feature importance map', () => {
      const features = learner.extractFeatures(makeSignal(), makeMicro(), 0, 0.5, 1);
      const prediction = learner.predict(features);

      expect(prediction.featureImportance).toBeInstanceOf(Map);
      expect(prediction.featureImportance.size).toBeGreaterThan(0);
    });
  });

  describe('Online Update', () => {
    it('should update model weights from trade outcome', () => {
      const features = learner.extractFeatures(makeSignal(), makeMicro(), 0, 0.5, 1);
      const statsBefore = learner.getModelStats();

      // Win outcome
      learner.update(features, 1, 2.5);
      const statsAfter = learner.update(features, 0, 0.3) as any;

      expect(learner.getModelStats().trainingSamples).toBe(statsBefore.trainingSamples + 2);
    });

    it('should learn from repeated patterns', () => {
      const highSignal = makeSignal({ timingEdge: 9, deployerQuality: 9 });
      const highFeatures = learner.extractFeatures(highSignal, makeMicro(), 0.5, 0.8, 1);

      const lowSignal = makeSignal({ timingEdge: 1, deployerQuality: 1 });
      const lowFeatures = learner.extractFeatures(lowSignal, null, -0.5, 0.2, 0.3);

      // Train with consistent pattern: high signal = win, low signal = loss
      for (let i = 0; i < 30; i++) {
        learner.update(highFeatures, 1, 3.0);
        learner.update(lowFeatures, 0, 0.2);
      }

      const highPred = learner.predict(highFeatures);
      const lowPred = learner.predict(lowFeatures);

      // After training, high signal should have higher win probability
      expect(highPred.winProbability).toBeGreaterThan(lowPred.winProbability);
    });
  });

  describe('Model Stats', () => {
    it('should return stats with correct structure', () => {
      const stats = learner.getModelStats();

      expect(stats).toHaveProperty('trainingSamples');
      expect(stats).toHaveProperty('calibrationError');
      expect(stats).toHaveProperty('recentError');
      expect(stats).toHaveProperty('featureImportance');
      expect(stats).toHaveProperty('topFeatures');
      expect(stats.topFeatures).toBeInstanceOf(Array);
    });
  });

  describe('Persistence', () => {
    it('should save and load model state', async () => {
      const features = learner.extractFeatures(makeSignal(), makeMicro(), 0, 0.5, 1);
      for (let i = 0; i < 10; i++) {
        learner.update(features, i % 2, i % 2 === 0 ? 2.0 : 0.5);
      }

      const predBefore = learner.predict(features);
      learner.save();

      // Load into new instance
      const learner2 = new OnlineLearner(TEST_MODEL_PATH);
      await learner2.load();
      const predAfter = learner2.predict(features);

      expect(predAfter.winProbability).toBeCloseTo(predBefore.winProbability, 2);
    });
  });

  describe('Signal Weights', () => {
    it('should return weight map keyed by feature names', () => {
      const weights = learner.getSignalWeights();
      expect(weights).toBeDefined();
      expect(typeof weights).toBe('object');
    });
  });
});
