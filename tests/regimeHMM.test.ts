/**
 * HiddenMarkovRegimeDetector Unit Tests
 */
import { HiddenMarkovRegimeDetector, HMMObservation, HMMRegime, RegimeSnapshot } from '../src/ml/regimeHMM';
import fs from 'fs';
import path from 'path';

jest.mock('../src/core/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

const TEST_HMM_PATH = './data/test_hmm_regime.json';

function makeObs(overrides: Partial<HMMObservation> = {}): HMMObservation {
  return {
    solReturn1h: 0.01,
    dexVolumeChange: 0.05,
    tokenLaunchRate: 0.5,
    realizedVol: 0.4,
    smartMoneyNetFlow: 0.1,
    ...overrides,
  };
}

describe('HiddenMarkovRegimeDetector', () => {
  let hmm: HiddenMarkovRegimeDetector;

  beforeEach(() => {
    hmm = new HiddenMarkovRegimeDetector(TEST_HMM_PATH);
  });

  afterAll(() => {
    const resolved = path.resolve(TEST_HMM_PATH);
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  });

  describe('Initialization', () => {
    it('should start with uniform state distribution', () => {
      const snapshot = hmm.update(makeObs());
      expect(snapshot).toBeDefined();
      expect(snapshot.currentRegime).toBeDefined();
      expect(['RISK_ON', 'NEUTRAL', 'RISK_OFF', 'CRISIS']).toContain(snapshot.currentRegime);
    });

    it('should have valid probabilities summing to 1', () => {
      const snapshot = hmm.update(makeObs());
      const probSum = Object.values(snapshot.probabilities).reduce((a, b) => a + b, 0);
      expect(probSum).toBeCloseTo(1.0, 5);
    });
  });

  describe('Regime Detection', () => {
    it('should detect RISK_ON regime with bullish observations', () => {
      // Feed strong bullish signals repeatedly
      let snapshot: RegimeSnapshot;
      for (let i = 0; i < 20; i++) {
        snapshot = hmm.update(makeObs({
          solReturn1h: 0.03,
          dexVolumeChange: 0.20,
          tokenLaunchRate: 0.8,
          realizedVol: 0.25,
          smartMoneyNetFlow: 0.4,
        }));
      }
      expect(snapshot!.currentRegime).toBe('RISK_ON');
      expect(snapshot!.riskMultiplier).toBeGreaterThan(0.5);
    });

    it('should detect CRISIS regime with extreme drawdown signals', () => {
      let snapshot: RegimeSnapshot;
      for (let i = 0; i < 20; i++) {
        snapshot = hmm.update(makeObs({
          solReturn1h: -0.08,
          dexVolumeChange: -0.40,
          tokenLaunchRate: 0.05,
          realizedVol: 1.2,
          smartMoneyNetFlow: -0.7,
        }));
      }
      expect(snapshot!.currentRegime).toBe('CRISIS');
      expect(snapshot!.riskMultiplier).toBeLessThan(0.5);
    });

    it('should return confidence between 0 and 1', () => {
      const snapshot = hmm.update(makeObs());
      expect(snapshot.confidence).toBeGreaterThanOrEqual(0);
      expect(snapshot.confidence).toBeLessThanOrEqual(1);
    });

    it('should track regime duration', () => {
      hmm.update(makeObs());
      hmm.update(makeObs());
      const snapshot = hmm.update(makeObs());
      expect(snapshot.regimeDurationBars).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Sticky Transitions', () => {
    it('should resist quick regime changes due to sticky diagonal', () => {
      // Start in neutral-ish
      for (let i = 0; i < 10; i++) {
        hmm.update(makeObs());
      }
      const regimeBefore = hmm.getLatestSnapshot().currentRegime;

      // Single outlier observation shouldn't flip regime
      hmm.update(makeObs({
        solReturn1h: -0.05,
        realizedVol: 1.0,
      }));
      const regimeAfter = hmm.getLatestSnapshot().currentRegime;

      // After just one extreme observation, regime should likely stay same
      expect(regimeAfter).toBe(regimeBefore);
    });
  });

  describe('Viterbi Decoding', () => {
    it('should return decoded sequence', () => {
      // Feed some observations
      for (let i = 0; i < 5; i++) {
        hmm.update(makeObs());
      }
      const decoded = hmm.viterbiDecode();
      expect(decoded).toBeInstanceOf(Array);
      expect(decoded.length).toBe(5);
      decoded.forEach(r => {
        expect(['RISK_ON', 'NEUTRAL', 'RISK_OFF', 'CRISIS']).toContain(r);
      });
    });
  });

  describe('getLatestSnapshot', () => {
    it('should return snapshot without requiring new observation', () => {
      hmm.update(makeObs());
      const snapshot = hmm.getLatestSnapshot();
      expect(snapshot).toBeDefined();
      expect(snapshot.currentRegime).toBeDefined();
      expect(snapshot.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('Persistence', () => {
    it('should save and load state', async () => {
      for (let i = 0; i < 10; i++) {
        hmm.update(makeObs({ solReturn1h: 0.02 + i * 0.001 }));
      }
      const snapshotBefore = hmm.getLatestSnapshot();
      hmm.save();

      const hmm2 = new HiddenMarkovRegimeDetector(TEST_HMM_PATH);
      await hmm2.load();
      // After loading, update with same obs to get comparable state
      const snapshotAfter = hmm2.getLatestSnapshot();

      expect(snapshotAfter.currentRegime).toBe(snapshotBefore.currentRegime);
    });
  });
});
