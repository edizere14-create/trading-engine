/**
 * ═══════════════════════════════════════════════════════════════
 *  HIDDEN MARKOV MODEL — Regime Detection
 * ═══════════════════════════════════════════════════════════════
 * 
 * Replaces simple EMA-based regime with probabilistic HMM:
 * - 4 hidden states: RISK_ON, NEUTRAL, RISK_OFF, CRISIS
 * - Observable emissions: SOL returns, DEX volume, token launch rate, volatility
 * - Viterbi decoding for most likely state sequence
 * - Online Baum-Welch for parameter adaptation
 * - Regime persistence probability (sticky transitions)
 */

import { logger } from '../core/logger';
import fs from 'fs';
import path from 'path';

export type HMMRegime = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF' | 'CRISIS';

const REGIMES: HMMRegime[] = ['RISK_ON', 'NEUTRAL', 'RISK_OFF', 'CRISIS'];
const N = REGIMES.length;

export interface RegimeSnapshot {
  currentRegime: HMMRegime;
  probabilities: Record<HMMRegime, number>;
  transitionFrom: HMMRegime | null;
  confidence: number;
  volatilityPercentile: number;
  regimeDurationBars: number;
  expectedDuration: number;        // expected bars remaining in regime
  riskMultiplier: number;          // 0-1 recommended size multiplier
  timestamp: Date;
}

export interface HMMObservation {
  solReturn1h: number;             // % return
  dexVolumeChange: number;         // % change
  tokenLaunchRate: number;         // launches/hour normalized
  realizedVol: number;             // annualized % vol
  smartMoneyNetFlow: number;       // normalized -1 to 1
}

export class HiddenMarkovRegimeDetector {
  // Transition matrix A[i][j] = P(state j | state i) — sticky diagonal
  private A: number[][] = [];
  // Emission parameters: Gaussian per (state, observation_dim)
  private emissionMeans: number[][] = [];
  private emissionVars: number[][] = [];
  // State distribution
  private stateDist: number[] = [];
  // History
  private observationHistory: HMMObservation[] = [];
  private regimeHistory: { regime: HMMRegime; timestamp: Date }[] = [];
  private currentRegimeStart = 0;

  private readonly filePath: string;
  private readonly OBS_DIMS = 5;
  private readonly MAX_HISTORY = 1000;
  private readonly STICKY_FACTOR = 0.85; // probability of staying in same state

  constructor(filePath: string = './data/hmm_regime.json') {
    this.filePath = path.resolve(filePath);
    this.initializeParameters();
  }

  private initializeParameters(): void {
    // Transition matrix — heavily diagonal (sticky)
    this.A = Array.from({ length: N }, (_, i) =>
      Array.from({ length: N }, (_, j) =>
        i === j ? this.STICKY_FACTOR : (1 - this.STICKY_FACTOR) / (N - 1)
      )
    );

    // Emission means per state per observation dimension
    // [solReturn, dexVolChange, tokenLaunchRate, realizedVol, smartMoneyFlow]
    this.emissionMeans = [
      [0.02, 0.15, 0.7, 0.3, 0.3],    // RISK_ON: positive returns, high activity
      [0.0, 0.0, 0.5, 0.5, 0.0],       // NEUTRAL: flat
      [-0.01, -0.10, 0.3, 0.7, -0.2],  // RISK_OFF: negative, declining
      [-0.05, -0.30, 0.1, 1.0, -0.5],  // CRISIS: sharp decline, high vol
    ];

    // Emission variances (diagonal covariance)
    this.emissionVars = [
      [0.01, 0.05, 0.1, 0.1, 0.2],    // RISK_ON
      [0.02, 0.08, 0.15, 0.15, 0.3],  // NEUTRAL (higher variance)
      [0.02, 0.10, 0.1, 0.2, 0.2],    // RISK_OFF
      [0.05, 0.15, 0.1, 0.3, 0.3],    // CRISIS
    ];

    // Uniform initial distribution
    this.stateDist = new Array(N).fill(1 / N);
  }

  async load(): Promise<void> {
    if (!fs.existsSync(this.filePath)) return;

    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const data = JSON.parse(raw);

    if (data.A) this.A = data.A;
    if (data.emissionMeans) this.emissionMeans = data.emissionMeans;
    if (data.emissionVars) this.emissionVars = data.emissionVars;
    if (data.stateDist) this.stateDist = data.stateDist;

    logger.info('HMM regime model loaded', { path: this.filePath });
  }

  /**
   * Process new observation and return regime classification
   */
  update(obs: HMMObservation): RegimeSnapshot {
    this.observationHistory.push(obs);
    if (this.observationHistory.length > this.MAX_HISTORY) {
      this.observationHistory.shift();
    }

    // Forward step: update state distribution
    const obsVec = this.obsToVector(obs);
    const newDist = new Array(N).fill(0);

    for (let j = 0; j < N; j++) {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        sum += this.stateDist[i] * this.A[i][j];
      }
      newDist[j] = sum * this.gaussianLikelihood(obsVec, j);
    }

    // Normalize
    const total = newDist.reduce((a, b) => a + b, 0);
    if (total > 0) {
      for (let i = 0; i < N; i++) {
        this.stateDist[i] = newDist[i] / total;
      }
    }

    // Find MAP state
    let bestState = 0;
    let bestProb = 0;
    const probabilities: Record<HMMRegime, number> = {} as any;
    for (let i = 0; i < N; i++) {
      probabilities[REGIMES[i]] = this.stateDist[i];
      if (this.stateDist[i] > bestProb) {
        bestProb = this.stateDist[i];
        bestState = i;
      }
    }

    const currentRegime = REGIMES[bestState];
    const prevRegime = this.regimeHistory.length > 0
      ? this.regimeHistory[this.regimeHistory.length - 1].regime
      : null;

    // Track regime changes
    if (currentRegime !== prevRegime) {
      this.currentRegimeStart = this.observationHistory.length;
      this.regimeHistory.push({ regime: currentRegime, timestamp: new Date() });

      logger.info('HMM regime change detected', {
        from: prevRegime,
        to: currentRegime,
        confidence: bestProb.toFixed(3),
        probabilities: Object.fromEntries(
          Object.entries(probabilities).map(([k, v]) => [k, (v as number).toFixed(3)])
        ),
      });
    }

    // Online parameter update (simplified Baum-Welch)
    if (this.observationHistory.length % 20 === 0 && this.observationHistory.length > 50) {
      this.updateEmissionParameters();
    }

    const regimeDuration = this.observationHistory.length - this.currentRegimeStart;

    // Expected remaining duration from geometric distribution
    const stayProb = this.A[bestState][bestState];
    const expectedDuration = stayProb > 0 && stayProb < 1
      ? 1 / (1 - stayProb)
      : 100;

    // Volatility percentile
    const volPercentile = this.calcVolatilityPercentile(obs.realizedVol);

    return {
      currentRegime,
      probabilities,
      transitionFrom: currentRegime !== prevRegime ? prevRegime : null,
      confidence: bestProb,
      volatilityPercentile: volPercentile,
      regimeDurationBars: regimeDuration,
      expectedDuration,
      riskMultiplier: this.getRegimeRiskMultiplier(currentRegime, bestProb),
      timestamp: new Date(),
    };
  }

  /**
   * Viterbi decoding on full observation history — for analysis/replay
   */
  viterbiDecode(): HMMRegime[] {
    const T = this.observationHistory.length;
    if (T === 0) return [];

    // Viterbi tables
    const V: number[][] = Array.from({ length: T }, () => new Array(N).fill(0));
    const backtrack: number[][] = Array.from({ length: T }, () => new Array(N).fill(0));

    // Initialize
    const obs0 = this.obsToVector(this.observationHistory[0]);
    for (let s = 0; s < N; s++) {
      V[0][s] = Math.log(1 / N) + Math.log(this.gaussianLikelihood(obs0, s) + 1e-300);
    }

    // Forward pass
    for (let t = 1; t < T; t++) {
      const obsVec = this.obsToVector(this.observationHistory[t]);
      for (let s = 0; s < N; s++) {
        let bestPrev = 0;
        let bestVal = -Infinity;
        for (let ps = 0; ps < N; ps++) {
          const val = V[t - 1][ps] + Math.log(this.A[ps][s] + 1e-300);
          if (val > bestVal) {
            bestVal = val;
            bestPrev = ps;
          }
        }
        V[t][s] = bestVal + Math.log(this.gaussianLikelihood(obsVec, s) + 1e-300);
        backtrack[t][s] = bestPrev;
      }
    }

    // Backtrack
    const states: number[] = new Array(T);
    states[T - 1] = V[T - 1].indexOf(Math.max(...V[T - 1]));
    for (let t = T - 2; t >= 0; t--) {
      states[t] = backtrack[t + 1][states[t + 1]];
    }

    return states.map(s => REGIMES[s]);
  }

  private getRegimeRiskMultiplier(regime: HMMRegime, confidence: number): number {
    const baseMultipliers: Record<HMMRegime, number> = {
      RISK_ON: 1.0,
      NEUTRAL: 0.7,
      RISK_OFF: 0.35,
      CRISIS: 0.0,
    };

    const base = baseMultipliers[regime];
    // Blend with neutral when confidence is low
    return base * confidence + 0.5 * (1 - confidence);
  }

  private obsToVector(obs: HMMObservation): number[] {
    return [obs.solReturn1h, obs.dexVolumeChange, obs.tokenLaunchRate, obs.realizedVol, obs.smartMoneyNetFlow];
  }

  private gaussianLikelihood(obs: number[], stateIndex: number): number {
    const means = this.emissionMeans[stateIndex];
    const vars = this.emissionVars[stateIndex];
    let logLik = 0;

    for (let d = 0; d < this.OBS_DIMS; d++) {
      const diff = obs[d] - means[d];
      logLik += -0.5 * Math.log(2 * Math.PI * vars[d]) - (diff * diff) / (2 * vars[d]);
    }

    return Math.exp(logLik);
  }

  private updateEmissionParameters(): void {
    // Online emission parameter update using recent observations
    const recent = this.observationHistory.slice(-100);
    const stateAssignments = this.getStateAssignmentsForRecent(recent);

    for (let s = 0; s < N; s++) {
      const stateObs = recent.filter((_, i) => stateAssignments[i] === s);
      if (stateObs.length < 5) continue;

      const vecs = stateObs.map(o => this.obsToVector(o));

      for (let d = 0; d < this.OBS_DIMS; d++) {
        const values = vecs.map(v => v[d]);
        const newMean = values.reduce((a, b) => a + b, 0) / values.length;
        const newVar = Math.max(0.001,
          values.reduce((s, x) => s + (x - newMean) ** 2, 0) / values.length
        );

        // Exponential smoothing (don't overwrite completely)
        this.emissionMeans[s][d] = 0.9 * this.emissionMeans[s][d] + 0.1 * newMean;
        this.emissionVars[s][d] = 0.9 * this.emissionVars[s][d] + 0.1 * newVar;
      }
    }
  }

  private getStateAssignmentsForRecent(recent: HMMObservation[]): number[] {
    return recent.map(obs => {
      const vec = this.obsToVector(obs);
      let bestState = 0;
      let bestLik = -Infinity;
      for (let s = 0; s < N; s++) {
        const lik = this.gaussianLikelihood(vec, s);
        if (lik > bestLik) {
          bestLik = lik;
          bestState = s;
        }
      }
      return bestState;
    });
  }

  private calcVolatilityPercentile(currentVol: number): number {
    const vols = this.observationHistory.map(o => o.realizedVol);
    if (vols.length < 10) return 0.5;
    const sorted = [...vols].sort((a, b) => a - b);
    const rank = sorted.filter(v => v <= currentVol).length;
    return rank / sorted.length;
  }

  save(): void {
    const data = {
      A: this.A,
      emissionMeans: this.emissionMeans,
      emissionVars: this.emissionVars,
      stateDist: this.stateDist,
      savedAt: new Date().toISOString(),
    };

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Get current regime snapshot without providing a new observation.
   * Returns the latest state based on current state distribution.
   */
  getLatestSnapshot(): RegimeSnapshot {
    let bestState = 0;
    let bestProb = 0;
    const probabilities: Record<HMMRegime, number> = {} as any;
    for (let i = 0; i < N; i++) {
      probabilities[REGIMES[i]] = this.stateDist[i];
      if (this.stateDist[i] > bestProb) {
        bestProb = this.stateDist[i];
        bestState = i;
      }
    }

    const currentRegime = REGIMES[bestState];
    const regimeDuration = this.observationHistory.length - this.currentRegimeStart;
    const stayProb = this.A[bestState][bestState];
    const expectedDuration = stayProb > 0 && stayProb < 1 ? 1 / (1 - stayProb) : 100;

    return {
      currentRegime,
      probabilities,
      transitionFrom: null,
      confidence: bestProb,
      volatilityPercentile: 0.5,
      regimeDurationBars: regimeDuration,
      expectedDuration,
      riskMultiplier: this.getRegimeRiskMultiplier(currentRegime, bestProb),
      timestamp: new Date(),
    };
  }
}
