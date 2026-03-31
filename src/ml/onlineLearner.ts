/**
 * ═══════════════════════════════════════════════════════════════
 *  ONLINE ML PIPELINE — Self-contained, no external dependencies
 * ═══════════════════════════════════════════════════════════════
 * 
 * Implements:
 * 1. Online logistic regression (SGD) for win probability
 * 2. Bayesian calibration with beta-binomial posterior
 * 3. Feature importance tracking via gradient magnitudes
 * 4. Automatic weight recalibration from trade outcomes
 * 5. Reinforcement learning for dynamic exit optimization
 * 6. Concept drift detection (ADWIN-style)
 */

import { bus } from '../core/eventBus';
import { logger } from '../core/logger';
import { SignalVector, MicrostructureFeatures, TradeRecord, EdgeName } from './mlTypes';
import fs from 'fs';
import path from 'path';

// ── FEATURE VECTOR ────────────────────────────────────────

export interface MLFeatureVector {
  // Signal dimensions (normalized 0-1)
  timingEdge: number;
  deployerQuality: number;
  organicFlow: number;
  manipulationRisk: number;
  coordinationStrength: number;
  socialVelocity: number;
  confidence: number;

  // Microstructure features (normalized)
  walletDiversityNorm: number;
  volumeSlopeNorm: number;
  exhaustionNorm: number;
  buyToSellRatioNorm: number;
  smartMoneyFlowNorm: number;
  buyClusterFreqNorm: number;

  // Market context
  regimeScore: number;          // -1 to 1
  marketHeat: number;           // 0-1 (DEAD=0, NORMAL=0.5, HOT=1)
  survivalMultiplier: number;   // 0-1

  // Interaction features (cross-terms)
  timingXcoordination: number;
  deployerXorganic: number;
  manipulationXexhaustion: number;
}

const FEATURE_KEYS: (keyof MLFeatureVector)[] = [
  'timingEdge', 'deployerQuality', 'organicFlow', 'manipulationRisk',
  'coordinationStrength', 'socialVelocity', 'confidence',
  'walletDiversityNorm', 'volumeSlopeNorm', 'exhaustionNorm',
  'buyToSellRatioNorm', 'smartMoneyFlowNorm', 'buyClusterFreqNorm',
  'regimeScore', 'marketHeat', 'survivalMultiplier',
  'timingXcoordination', 'deployerXorganic', 'manipulationXexhaustion',
];

const NUM_FEATURES = FEATURE_KEYS.length;

// ── FEATURE BOUNDS (Layer 1: clip at the source) ──────────

interface FeatureBound {
  min: number;
  max: number;
}

const FEATURE_BOUNDS: Record<keyof MLFeatureVector, FeatureBound> = {
  timingEdge:                { min: -2,  max: 2   },
  deployerQuality:           { min: 0,   max: 1   },
  organicFlow:               { min: 0,   max: 1   },
  manipulationRisk:          { min: 0,   max: 1   },
  coordinationStrength:      { min: 0,   max: 1   },
  socialVelocity:            { min: 0,   max: 1   },
  confidence:                { min: 0,   max: 1   },
  walletDiversityNorm:       { min: 0,   max: 1   },
  volumeSlopeNorm:           { min: 0,   max: 1   },
  exhaustionNorm:            { min: 0,   max: 1   },
  buyToSellRatioNorm:        { min: 0,   max: 1   },
  smartMoneyFlowNorm:        { min: 0,   max: 1   },
  buyClusterFreqNorm:        { min: 0,   max: 1   },
  regimeScore:               { min: -1,  max: 1   },
  marketHeat:                { min: 0,   max: 1   },
  survivalMultiplier:        { min: 0,   max: 1   },
  timingXcoordination:       { min: -2,  max: 2   },
  deployerXorganic:          { min: 0,   max: 1   },
  manipulationXexhaustion:   { min: 0,   max: 1   },
};

// ── MODEL SAFETY CONSTANTS ────────────────────────────────

const LOGIT_CLIP = 15;          // sigmoid(15)≈0.9999997 — extreme but finite
const MAX_WEIGHT = 5.0;         // prevent weight explosion during SGD
const PRED_HISTORY_SIZE = 100;

// ── PREDICTION OUTPUT ─────────────────────────────────────

export interface MLPrediction {
  winProbability: number;       // 0-1 calibrated probability
  expectedValue: number;        // in R-units
  predictedMultiple: number;    // e.g. 1.8x
  confidence: number;           // 0-1 model confidence
  featureImportance: Map<string, number>;
  regime: 'EXPLOIT' | 'EXPLORE';
  optimalExitStrategy: OptimalExitStrategy;
}

export interface OptimalExitStrategy {
  stopLossPct: number;
  tiers: { multiple: number; pct: number }[];
  trailingActivation: number;   // multiple at which trailing stop activates
  trailingDistance: number;     // % below peak to trigger exit
  maxHoldMs: number;
}

// ── CONCEPT DRIFT DETECTOR (ADWIN-inspired) ───────────────

class DriftDetector {
  private window: number[] = [];
  private readonly maxSize = 500;
  private readonly significanceThreshold = 0.01;

  add(error: number): boolean {
    this.window.push(error);
    if (this.window.length > this.maxSize) {
      this.window.shift();
    }
    if (this.window.length < 50) return false;
    return this.detectDrift();
  }

  private detectDrift(): boolean {
    // Split window and compare means — simplified ADWIN
    const n = this.window.length;
    const mid = Math.floor(n / 2);
    const firstHalf = this.window.slice(0, mid);
    const secondHalf = this.window.slice(mid);

    const mean1 = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const mean2 = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    const var1 = firstHalf.reduce((s, x) => s + (x - mean1) ** 2, 0) / firstHalf.length;
    const var2 = secondHalf.reduce((s, x) => s + (x - mean2) ** 2, 0) / secondHalf.length;

    // Welch's t-test approximation
    const se = Math.sqrt(var1 / firstHalf.length + var2 / secondHalf.length);
    if (se < 1e-10) return false;

    const t = Math.abs(mean1 - mean2) / se;
    // Approximate p-value for large samples
    return t > 2.576; // p < 0.01
  }

  getRecentError(): number {
    if (this.window.length === 0) return 0;
    const recent = this.window.slice(-20);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }
}

// ── BAYESIAN CALIBRATOR ───────────────────────────────────

class BayesianCalibrator {
  // Beta-binomial posterior per probability bucket
  private buckets: Map<number, { alpha: number; beta: number }> = new Map();
  private readonly numBuckets = 10;

  constructor() {
    // Uniform prior α=1, β=1 for each bucket
    for (let i = 0; i < this.numBuckets; i++) {
      this.buckets.set(i, { alpha: 1, beta: 1 });
    }
  }

  private getBucket(prob: number): number {
    return Math.min(this.numBuckets - 1, Math.floor(prob * this.numBuckets));
  }

  update(predictedWP: number, actualOutcome: number): void {
    const bucket = this.getBucket(predictedWP);
    const params = this.buckets.get(bucket)!;
    if (actualOutcome === 1) {
      params.alpha += 1;
    } else {
      params.beta += 1;
    }
  }

  calibrate(rawProb: number): number {
    const bucket = this.getBucket(rawProb);
    const params = this.buckets.get(bucket)!;
    // Posterior mean of Beta distribution
    return params.alpha / (params.alpha + params.beta);
  }

  getCalibrationError(): number {
    let totalError = 0;
    let count = 0;
    for (let i = 0; i < this.numBuckets; i++) {
      const params = this.buckets.get(i)!;
      const total = params.alpha + params.beta - 2; // subtract prior
      if (total < 5) continue;
      const expected = (i + 0.5) / this.numBuckets;
      const actual = params.alpha / (params.alpha + params.beta);
      totalError += Math.abs(expected - actual);
      count++;
    }
    return count > 0 ? totalError / count : 0;
  }

  serialize(): Record<number, { alpha: number; beta: number }> {
    const out: Record<number, { alpha: number; beta: number }> = {};
    for (const [k, v] of this.buckets) out[k] = v;
    return out;
  }

  deserialize(data: Record<number, { alpha: number; beta: number }>): void {
    for (const [k, v] of Object.entries(data)) {
      this.buckets.set(Number(k), v);
    }
  }
}

// ── EXIT OPTIMIZER (Contextual Bandit) ────────────────────

interface ExitArm {
  stopLoss: number;
  tier1Multiple: number;
  tier1Pct: number;
  tier2Multiple: number;
  tier2Pct: number;
  trailingActivation: number;
  trailingDistance: number;
  maxHoldMs: number;
}

class ExitOptimizer {
  private arms: ExitArm[] = [];
  private rewards: Map<number, number[]> = new Map();
  private pulls: Map<number, number> = new Map();
  private readonly epsilon = 0.1; // exploration rate

  constructor() {
    // Initialize diverse exit strategy arms
    this.arms = [
      { stopLoss: 0.25, tier1Multiple: 1.5, tier1Pct: 0.4, tier2Multiple: 3.0, tier2Pct: 0.4, trailingActivation: 2.0, trailingDistance: 0.15, maxHoldMs: 180_000 },
      { stopLoss: 0.30, tier1Multiple: 2.0, tier1Pct: 0.3, tier2Multiple: 5.0, tier2Pct: 0.3, trailingActivation: 2.5, trailingDistance: 0.20, maxHoldMs: 300_000 },
      { stopLoss: 0.35, tier1Multiple: 1.3, tier1Pct: 0.5, tier2Multiple: 2.5, tier2Pct: 0.3, trailingActivation: 1.5, trailingDistance: 0.10, maxHoldMs: 240_000 },
      { stopLoss: 0.20, tier1Multiple: 1.8, tier1Pct: 0.35, tier2Multiple: 4.0, tier2Pct: 0.35, trailingActivation: 2.2, trailingDistance: 0.18, maxHoldMs: 360_000 },
      { stopLoss: 0.30, tier1Multiple: 1.5, tier1Pct: 0.3, tier2Multiple: 3.5, tier2Pct: 0.3, trailingActivation: 2.0, trailingDistance: 0.25, maxHoldMs: 450_000 },
      { stopLoss: 0.25, tier1Multiple: 2.5, tier1Pct: 0.25, tier2Multiple: 6.0, tier2Pct: 0.25, trailingActivation: 3.0, trailingDistance: 0.20, maxHoldMs: 600_000 },
      // Aggressive fast scalp
      { stopLoss: 0.15, tier1Multiple: 1.2, tier1Pct: 0.6, tier2Multiple: 1.8, tier2Pct: 0.3, trailingActivation: 1.3, trailingDistance: 0.08, maxHoldMs: 90_000 },
      // Patient moonbag
      { stopLoss: 0.40, tier1Multiple: 3.0, tier1Pct: 0.2, tier2Multiple: 8.0, tier2Pct: 0.2, trailingActivation: 4.0, trailingDistance: 0.30, maxHoldMs: 900_000 },
    ];

    for (let i = 0; i < this.arms.length; i++) {
      this.rewards.set(i, []);
      this.pulls.set(i, 0);
    }
  }

  selectArm(features: MLFeatureVector): { armIndex: number; strategy: OptimalExitStrategy } {
    let armIndex: number;

    if (Math.random() < this.epsilon) {
      // Explore: random arm
      armIndex = Math.floor(Math.random() * this.arms.length);
    } else {
      // Exploit: UCB1 selection
      armIndex = this.ucb1Select();
    }

    const arm = this.arms[armIndex];
    const remainingPct = 1 - arm.tier1Pct - arm.tier2Pct;

    return {
      armIndex,
      strategy: {
        stopLossPct: arm.stopLoss,
        tiers: [
          { multiple: arm.tier1Multiple, pct: arm.tier1Pct },
          { multiple: arm.tier2Multiple, pct: arm.tier2Pct },
          { multiple: arm.tier2Multiple * 2, pct: remainingPct }, // moonbag at 2x tier2
        ],
        trailingActivation: arm.trailingActivation,
        trailingDistance: arm.trailingDistance,
        maxHoldMs: arm.maxHoldMs,
      },
    };
  }

  recordReward(armIndex: number, reward: number): void {
    const rewards = this.rewards.get(armIndex) ?? [];
    rewards.push(reward);
    // Keep last 100 rewards per arm
    if (rewards.length > 100) rewards.shift();
    this.rewards.set(armIndex, rewards);
    this.pulls.set(armIndex, (this.pulls.get(armIndex) ?? 0) + 1);
  }

  private ucb1Select(): number {
    const totalPulls = Array.from(this.pulls.values()).reduce((a, b) => a + b, 0);
    if (totalPulls === 0) return 0;

    let bestArm = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < this.arms.length; i++) {
      const pulls = this.pulls.get(i) ?? 0;
      if (pulls === 0) return i; // explore unvisited arms first

      const rewards = this.rewards.get(i) ?? [];
      const avgReward = rewards.reduce((a, b) => a + b, 0) / rewards.length;
      const ucbBonus = Math.sqrt(2 * Math.log(totalPulls) / pulls);
      const score = avgReward + ucbBonus;

      if (score > bestScore) {
        bestScore = score;
        bestArm = i;
      }
    }

    return bestArm;
  }

  serialize(): { rewards: Record<number, number[]>; pulls: Record<number, number> } {
    const rewards: Record<number, number[]> = {};
    const pulls: Record<number, number> = {};
    for (const [k, v] of this.rewards) rewards[k] = v;
    for (const [k, v] of this.pulls) pulls[k] = v;
    return { rewards, pulls };
  }

  deserialize(data: { rewards: Record<number, number[]>; pulls: Record<number, number> }): void {
    for (const [k, v] of Object.entries(data.rewards)) this.rewards.set(Number(k), v);
    for (const [k, v] of Object.entries(data.pulls)) this.pulls.set(Number(k), v);
  }
}

// ── ONLINE LOGISTIC REGRESSION ────────────────────────────

export class OnlineLearner {
  private weights: number[];
  private bias: number;
  private learningRate: number;
  private l2Lambda: number;             // regularization
  private gradientAccumulator: number[]; // for AdaGrad
  private featureImportance: number[];   // running gradient magnitude
  private trainingSamples: number;

  private calibrator: BayesianCalibrator;
  private driftDetector: DriftDetector;
  private exitOptimizer: ExitOptimizer;

  private predictionHistory: number[] = [];
  private readonly filePath: string;
  private readonly MIN_TRAINING_SAMPLES = 20;

  constructor(filePath: string = './data/ml_model.json') {
    this.filePath = path.resolve(filePath);
    this.weights = new Array(NUM_FEATURES).fill(0);
    this.bias = 0;
    this.learningRate = 0.01;
    this.l2Lambda = 0.001;
    this.gradientAccumulator = new Array(NUM_FEATURES).fill(1e-8);
    this.featureImportance = new Array(NUM_FEATURES).fill(0);
    this.trainingSamples = 0;
    this.calibrator = new BayesianCalibrator();
    this.driftDetector = new DriftDetector();
    this.exitOptimizer = new ExitOptimizer();
  }

  async load(): Promise<void> {
    if (!fs.existsSync(this.filePath)) {
      logger.info('ML model file not found — starting fresh', { path: this.filePath });
      return;
    }

    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const data = JSON.parse(raw);
    this.weights = data.weights ?? this.weights;
    this.bias = data.bias ?? 0;
    this.gradientAccumulator = data.gradientAccumulator ?? this.gradientAccumulator;
    this.featureImportance = data.featureImportance ?? this.featureImportance;
    this.trainingSamples = data.trainingSamples ?? 0;

    if (data.calibrator) this.calibrator.deserialize(data.calibrator);
    if (data.exitOptimizer) this.exitOptimizer.deserialize(data.exitOptimizer);

    logger.info('ML model loaded', {
      samples: this.trainingSamples,
      calibrationError: this.calibrator.getCalibrationError().toFixed(4),
    });
  }

  // ── FEATURE EXTRACTION ──────────────────────────────────

  extractFeatures(
    signal: SignalVector,
    micro: MicrostructureFeatures | null,
    regimeScore: number,
    marketHeat: number,
    survivalMultiplier: number
  ): MLFeatureVector {
    return {
      // Signal (normalized 0-1)
      timingEdge: signal.timingEdge / 10,
      deployerQuality: Math.max(0, signal.deployerQuality) / 10,
      organicFlow: signal.organicFlow / 10,
      manipulationRisk: signal.manipulationRisk / 10,
      coordinationStrength: signal.coordinationStrength / 10,
      socialVelocity: signal.socialVelocity / 10,
      confidence: signal.confidence,

      // Microstructure (normalized)
      walletDiversityNorm: (micro?.walletDiversityScore ?? 5) / 10,
      volumeSlopeNorm: Math.tanh((micro?.volumeSpikeSlope ?? 0) / 2) * 0.5 + 0.5,
      exhaustionNorm: (micro?.impulseExhaustionScore ?? 5) / 10,
      buyToSellRatioNorm: Math.tanh((micro?.buyToSellRatio ?? 1) - 1) * 0.5 + 0.5,
      smartMoneyFlowNorm: Math.tanh((micro?.smartMoneyNetFlow ?? 0) / 10) * 0.5 + 0.5,
      buyClusterFreqNorm: Math.min(1, (micro?.buyClusterFrequency ?? 0) / 20),

      // Market
      regimeScore: Math.tanh(regimeScore),
      marketHeat,
      survivalMultiplier,

      // Interaction terms
      timingXcoordination: (signal.timingEdge / 10) * (signal.coordinationStrength / 10),
      deployerXorganic: (Math.max(0, signal.deployerQuality) / 10) * (signal.organicFlow / 10),
      manipulationXexhaustion: (signal.manipulationRisk / 10) * ((micro?.impulseExhaustionScore ?? 5) / 10),
    };
  }

  // ── FEATURE CLIPPING (Layer 1) ──────────────────────────

  private clipFeatures(raw: MLFeatureVector): MLFeatureVector {
    const clipped: MLFeatureVector = { ...raw };

    for (const key of FEATURE_KEYS) {
      const bounds = FEATURE_BOUNDS[key];
      const val = raw[key];
      if (val === undefined || val === null) continue;

      const clippedVal = Math.max(bounds.min, Math.min(bounds.max, val));
      if (clippedVal !== val) {
        logger.warn('[OnlineLearner] Feature clipped', {
          feature: key,
          original: val.toFixed(4),
          clipped: clippedVal.toFixed(4),
        });
      }
      clipped[key] = clippedVal;
    }

    return clipped;
  }

  // ── PREDICTION ──────────────────────────────────────────

  /**
   * Safe prediction with null return on invalid output.
   * Callers should treat null as "no signal available".
   */
  getPrediction(rawFeatures: MLFeatureVector): MLPrediction | null {
    const features = this.clipFeatures(rawFeatures);
    const x = this.featureVectorToArray(features);
    const logit = this.computeClippedLogit(x);
    const p = this.sigmoid(logit);

    // Layer 3: output sanity check
    if (!Number.isFinite(p) || p < 0 || p > 1) {
      logger.error('[OnlineLearner] Invalid prediction — returning null', { p, logit });
      return null;
    }

    // Layer 4: model health monitoring
    this.recordPrediction(p);

    return this.buildPrediction(features, p);
  }

  predict(rawFeatures: MLFeatureVector): MLPrediction {
    const features = this.clipFeatures(rawFeatures);
    const x = this.featureVectorToArray(features);

    // Raw logistic output with logit clipping (Layer 2)
    const logit = this.computeClippedLogit(x);
    const rawProb = this.sigmoid(logit);

    // Layer 3: output sanity — fallback to 0.5 if broken
    const safeProb = (!Number.isFinite(rawProb) || rawProb < 0 || rawProb > 1) ? 0.5 : rawProb;

    // Layer 4: model health monitoring
    this.recordPrediction(safeProb);

    return this.buildPrediction(features, safeProb);
  }

  private buildPrediction(features: MLFeatureVector, rawProb: number): MLPrediction {

    // Bayesian calibration
    const calibratedWP = this.trainingSamples >= this.MIN_TRAINING_SAMPLES
      ? this.calibrator.calibrate(rawProb)
      : rawProb;

    // Model confidence: based on training data and calibration
    const modelConfidence = Math.min(1,
      (this.trainingSamples / 200) * 0.5 + // more data = more confident
      (1 - this.calibrator.getCalibrationError()) * 0.3 + // well-calibrated = more confident
      (1 - this.driftDetector.getRecentError()) * 0.2  // no drift = more confident
    );

    // Feature importance
    const importance = new Map<string, number>();
    for (let i = 0; i < NUM_FEATURES; i++) {
      importance.set(FEATURE_KEYS[i], this.featureImportance[i]);
    }

    // Expected multiple: linear estimate from features
    const predictedMultiple = 1 + calibratedWP * 3.0; // rough: WP=0.6 → 2.8x

    // Expected value in R-units
    const ev = calibratedWP * (predictedMultiple - 1) - (1 - calibratedWP) * 0.3;

    // Exit strategy from contextual bandit
    const { armIndex, strategy } = this.exitOptimizer.selectArm(features);

    return {
      winProbability: calibratedWP,
      expectedValue: ev,
      predictedMultiple,
      confidence: modelConfidence,
      featureImportance: importance,
      regime: Math.random() < 0.1 ? 'EXPLORE' : 'EXPLOIT',
      optimalExitStrategy: strategy,
    };
  }

  // ── MODEL HEALTH MONITORING (Layer 4) ───────────────────

  private recordPrediction(p: number): void {
    this.predictionHistory.push(p);
    if (this.predictionHistory.length > PRED_HISTORY_SIZE) {
      this.predictionHistory.shift();
    }
    this.checkModelHealth();
  }

  private checkModelHealth(): void {
    if (this.predictionHistory.length < 20) return;

    const mean = this.predictionHistory.reduce((a, b) => a + b, 0) / this.predictionHistory.length;
    const allExtreme = this.predictionHistory.every(p => p > 0.95 || p < 0.05);

    if (allExtreme) {
      logger.error('[OnlineLearner] Model degenerate — all predictions extreme, resetting weights');
      this.resetWeights();
      return;
    }

    if (mean > 0.85) {
      logger.warn('[OnlineLearner] Mean prediction suspiciously high — possible overfit or feature overflow', {
        mean: mean.toFixed(3),
        samples: this.predictionHistory.length,
      });
    }
  }

  private resetWeights(): void {
    for (let i = 0; i < NUM_FEATURES; i++) {
      this.weights[i] = 0;
    }
    this.bias = 0;
    this.predictionHistory = [];
    this.learningRate = 0.01; // reset learning rate too
    logger.warn('[OnlineLearner] Weights reset to zero — model will re-learn from trades');
  }

  // ── ONLINE UPDATE (called after each trade closes) ──────

  update(rawFeatures: MLFeatureVector, outcome: number, realizedMultiple: number, exitArmIndex?: number): void {
    const features = this.clipFeatures(rawFeatures);
    const x = this.featureVectorToArray(features);
    const logit = this.computeClippedLogit(x);
    const predicted = this.sigmoid(logit);

    // Gradient: (predicted - actual) for logistic loss
    const error = predicted - outcome;

    // AdaGrad update with weight clipping (Layer 3: prevent weight explosion)
    for (let i = 0; i < NUM_FEATURES; i++) {
      const grad = error * x[i] + this.l2Lambda * this.weights[i];
      this.gradientAccumulator[i] += grad * grad;
      const adaptiveLR = this.learningRate / Math.sqrt(this.gradientAccumulator[i]);
      this.weights[i] -= adaptiveLR * grad;

      // Clip weight after update
      this.weights[i] = Math.max(-MAX_WEIGHT, Math.min(MAX_WEIGHT, this.weights[i]));

      // Track feature importance (exponential moving average of |gradient|)
      this.featureImportance[i] = 0.95 * this.featureImportance[i] + 0.05 * Math.abs(grad);
    }

    // Bias update + clip
    this.bias -= this.learningRate * error;
    this.bias = Math.max(-MAX_WEIGHT, Math.min(MAX_WEIGHT, this.bias));
    this.trainingSamples++;

    // Update Bayesian calibrator
    this.calibrator.update(predicted, outcome);

    // Drift detection
    const driftDetected = this.driftDetector.add(Math.abs(error));
    if (driftDetected && this.trainingSamples > 100) {
      logger.warn('CONCEPT DRIFT DETECTED — increasing learning rate', {
        recentError: this.driftDetector.getRecentError().toFixed(4),
        samples: this.trainingSamples,
      });
      // Increase learning rate temporarily to adapt faster
      this.learningRate = Math.min(0.05, this.learningRate * 1.5);
    } else if (this.trainingSamples % 50 === 0) {
      // Decay learning rate gradually
      this.learningRate = Math.max(0.001, this.learningRate * 0.95);
    }

    // Update exit optimizer
    if (exitArmIndex !== undefined) {
      const reward = realizedMultiple - 1; // positive if profitable
      this.exitOptimizer.recordReward(exitArmIndex, reward);
    }

    // Auto-save every 10 updates
    if (this.trainingSamples % 10 === 0) {
      this.save();
    }

    logger.debug('ML model updated', {
      samples: this.trainingSamples,
      error: error.toFixed(4),
      predicted: predicted.toFixed(4),
      actual: outcome,
      calibrationError: this.calibrator.getCalibrationError().toFixed(4),
      driftDetected,
      learningRate: this.learningRate.toFixed(6),
    });
  }

  // ── WEIGHT RECALIBRATION ────────────────────────────────

  getSignalWeights(): Record<string, number> {
    const raw: Record<string, number> = {};
    const signalFeatures = ['timingEdge', 'deployerQuality', 'organicFlow',
      'manipulationRisk', 'coordinationStrength', 'socialVelocity'];

    let total = 0;
    for (const key of signalFeatures) {
      const idx = FEATURE_KEYS.indexOf(key as keyof MLFeatureVector);
      const absWeight = Math.abs(this.weights[idx]);
      raw[key] = absWeight;
      total += absWeight;
    }

    // Normalize to sum to 1
    const normalized: Record<string, number> = {};
    for (const key of signalFeatures) {
      normalized[key] = total > 0 ? raw[key] / total : 1 / signalFeatures.length;
    }

    return normalized;
  }

  getModelStats(): {
    trainingSamples: number;
    calibrationError: number;
    recentError: number;
    featureImportance: Record<string, number>;
    topFeatures: string[];
  } {
    const importance: Record<string, number> = {};
    const indexed: { key: string; value: number }[] = [];

    for (let i = 0; i < NUM_FEATURES; i++) {
      importance[FEATURE_KEYS[i]] = this.featureImportance[i];
      indexed.push({ key: FEATURE_KEYS[i], value: this.featureImportance[i] });
    }

    indexed.sort((a, b) => b.value - a.value);

    return {
      trainingSamples: this.trainingSamples,
      calibrationError: this.calibrator.getCalibrationError(),
      recentError: this.driftDetector.getRecentError(),
      featureImportance: importance,
      topFeatures: indexed.slice(0, 5).map(f => f.key),
    };
  }

  // ── PERSISTENCE ─────────────────────────────────────────

  save(): void {
    const data = {
      weights: this.weights,
      bias: this.bias,
      gradientAccumulator: this.gradientAccumulator,
      featureImportance: this.featureImportance,
      trainingSamples: this.trainingSamples,
      learningRate: this.learningRate,
      calibrator: this.calibrator.serialize(),
      exitOptimizer: this.exitOptimizer.serialize(),
      savedAt: new Date().toISOString(),
    };

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // ── UTILITIES ───────────────────────────────────────────

  private featureVectorToArray(f: MLFeatureVector): number[] {
    return FEATURE_KEYS.map(k => f[k]);
  }

  private dot(x: number[]): number {
    let sum = 0;
    for (let i = 0; i < NUM_FEATURES; i++) {
      sum += this.weights[i] * x[i];
    }
    return sum;
  }

  // Layer 2: logit hard ceiling before sigmoid
  private computeClippedLogit(x: number[]): number {
    const logit = this.dot(x) + this.bias;

    if (Math.abs(logit) > LOGIT_CLIP) {
      logger.warn('[OnlineLearner] Logit clipped', {
        raw: logit.toFixed(2),
        clipped: (Math.sign(logit) * LOGIT_CLIP).toFixed(2),
      });
    }

    return Math.max(-LOGIT_CLIP, Math.min(LOGIT_CLIP, logit));
  }

  private sigmoid(z: number): number {
    if (z > LOGIT_CLIP) return 1;
    if (z < -LOGIT_CLIP) return 0;
    return 1 / (1 + Math.exp(-z));
  }
}
