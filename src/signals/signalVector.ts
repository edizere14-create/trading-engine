import { SignalVector, DeployerTier, EdgeName } from '../core/types';

export interface CalibratedWeights {
  timing:       number;
  deployer:     number;
  organicFlow:  number;
  manipulation: number;
  coordination: number;
  social:       number;
  // Source: logisticRegression.ts — do NOT hardcode these.
  // Default values below are PLACEHOLDERS until calibration runs.
  // Replace after 200-trade backtest.
}

// PLACEHOLDER weights — will be overwritten by calibration/logisticRegression.ts
export const DEFAULT_WEIGHTS: CalibratedWeights = {
  timing:       0.20, // PLACEHOLDER — backtest will likely push this higher
  deployer:     0.20, // PLACEHOLDER
  organicFlow:  0.15, // PLACEHOLDER
  manipulation: 0.20, // PLACEHOLDER — defensive dimension, weight heavily
  coordination: 0.15, // PLACEHOLDER
  social:       0.10, // PLACEHOLDER — noisy signal, start low
};

export class SignalVectorBuilder {
  private scores: Record<EdgeName, number> = {
    TIMING: 0,
    DEPLOYER: 0,
    ORGANIC_FLOW: 0,
    MANIPULATION: 0,
    COORDINATION: 0,
    KOL: 0,
    TELEGRAM: 0,
    AUTONOMOUS: 0,
  };

  setTimingEdge(detectionLagMs: number, dexScreenerLagMs: number): this {
    const advantage = dexScreenerLagMs - detectionLagMs;
    this.scores.TIMING = advantage > 30000 ? 10
                       : advantage > 10000 ? 8
                       : advantage > 3000  ? 5
                       : advantage > 0     ? 2
                       : 0;
    return this;
  }

  setDeployerQuality(tier: DeployerTier): this {
    this.scores.DEPLOYER = tier === 'S'         ? 10
                         : tier === 'A'         ? 7
                         : tier === 'B'         ? 4
                         : tier === 'BLACKLIST'  ? -20
                         : 3; // UNKNOWN
    return this;
  }

  setOrganicFlow(
    holderVelocityPerMin: number,
    botFarmDetected: boolean,
    walletAgeScore: number // 0–1, higher = older wallets
  ): this {
    let score = Math.min(8, holderVelocityPerMin * 0.4);
    if (botFarmDetected) score -= 5;
    score += walletAgeScore * 2;
    this.scores.ORGANIC_FLOW = Math.max(0, Math.min(10, score));
    return this;
  }

  setManipulationRisk(
    sniperBlock0Pct: number,     // % of supply bought in block 0
    bundleSellDetected: boolean, // coordinated sell bundle
    washTradeScore: number,      // 0–10 (10 = definitely wash)
    topHolderPct: number         // top 10 holders %
  ): this {
    // INVERTED: 10 = safe, 0 = dangerous
    let risk = 0;
    if (sniperBlock0Pct > 0.10) risk += 4;
    else if (sniperBlock0Pct > 0.05) risk += 2;
    if (bundleSellDetected) risk += 6;
    if (washTradeScore > 7) risk += 3;
    if (topHolderPct > 0.15) risk += 2;
    this.scores.MANIPULATION = Math.max(0, 10 - risk);
    return this;
  }

  setCoordinationStrength(
    clusteringWallets: number,
    totalWeightedPnL: number,
    jitoBuyBundleDetected: boolean
  ): this {
    let score = Math.min(7, clusteringWallets * 1.5);
    if (totalWeightedPnL > 5000) score += 1;
    if (jitoBuyBundleDetected) score += 2;
    this.scores.COORDINATION = Math.min(10, score);
    return this;
  }

  setSocialVelocity(
    kolTierBonus: number,         // 0–4 from KOL tier
    telegramChannelCount: number, // unique channels mentioning CA
    crossConfirmWindowMs: number  // both KOL + TG within N ms
  ): this {
    let score = kolTierBonus;
    score += Math.min(4, telegramChannelCount * 1.5);
    if (crossConfirmWindowMs < 300000) score += 2; // within 5 min = bonus
    this.scores.KOL = Math.min(10, score);
    return this;
  }

  build(weights: CalibratedWeights, dataConfidence: number): SignalVector {
    const total =
      this.scores.TIMING         * weights.timing        +
      this.scores.DEPLOYER       * weights.deployer      +
      this.scores.ORGANIC_FLOW   * weights.organicFlow   +
      this.scores.MANIPULATION   * weights.manipulation  +
      this.scores.COORDINATION   * weights.coordination  +
      this.scores.KOL            * weights.social;

    return {
      timingEdge:           this.scores.TIMING,
      deployerQuality:      this.scores.DEPLOYER,
      organicFlow:          this.scores.ORGANIC_FLOW,
      manipulationRisk:     this.scores.MANIPULATION,
      coordinationStrength: this.scores.COORDINATION,
      socialVelocity:       this.scores.KOL,
      totalScore:           Math.max(0, total),
      confidence:           dataConfidence,
    };
  }
}
