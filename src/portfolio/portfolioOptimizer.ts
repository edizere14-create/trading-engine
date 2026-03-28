/**
 * ═══════════════════════════════════════════════════════════════
 *  PORTFOLIO OPTIMIZER — Correlation-Aware Kelly Sizing
 * ═══════════════════════════════════════════════════════════════
 * 
 * Implements:
 * 1. Fractional Kelly criterion with uncertainty adjustment
 * 2. Cross-position correlation tracking
 * 3. Narrative/sector exposure limits
 * 4. Dynamic cash allocation based on regime
 * 5. Portfolio heat management
 * 6. Concentration risk monitoring
 */

import { logger } from '../core/logger';
import { TradePosition } from '../core/types';
import { HMMRegime } from '../ml/regimeHMM';

export interface PortfolioState {
  totalCapitalUSD: number;
  deployedCapitalUSD: number;
  cashReserveUSD: number;
  deployedPct: number;
  positions: PositionRisk[];
  narrativeExposure: Map<string, number>;  // narrative → % of capital
  correlationMatrix: number[][];
  portfolioHeat: number;          // 0-10 overall risk
  maxDrawdownRisk: number;        // estimated worst-case portfolio DD
  kellyFraction: number;          // current portfolio-level kelly
  cashTarget: number;             // recommended cash %
}

export interface PositionRisk {
  tokenCA: string;
  narrative: string;
  sizeUSD: number;
  sizePct: number;                // % of capital
  unrealizedPnLPct: number;
  correlationToPortfolio: number; // -1 to 1
  marginalRisk: number;           // risk added by this position
  holdDurationMs: number;
}

export interface SizingRecommendation {
  recommendedSizeUSD: number;
  recommendedSizePct: number;
  kellyOptimalPct: number;
  correlationAdjustment: number;  // multiplier for correlation
  regimeAdjustment: number;       // multiplier for regime
  narrativeAdjustment: number;    // multiplier for concentration
  maxAllowedUSD: number;
  reason: string;
}

export class PortfolioOptimizer {
  private positionHistory: { tokenCA: string; returns: number[] }[] = [];
  private narrativeMap: Map<string, string> = new Map(); // tokenCA → narrative
  private returnHistory: Map<string, number[]> = new Map(); // tokenCA → returns
  private portfolioReturns: number[] = [];

  private readonly MAX_NARRATIVE_EXPOSURE = 0.40;    // max 40% in one narrative
  private readonly MAX_SINGLE_POSITION = 0.05;       // max 5% per position
  private readonly KELLY_FRACTION = 0.25;             // quarter-Kelly (conservative)
  private readonly MAX_PORTFOLIO_HEAT = 7;
  private readonly CORRELATION_LOOKBACK = 50;

  classifyNarrative(tokenCA: string, ticker: string): string {
    const lower = ticker.toLowerCase();

    // Simple keyword-based classification 
    const narratives: [string, string[]][] = [
      ['DOG_META', ['dog', 'shib', 'doge', 'inu', 'woof', 'pup', 'bone', 'leash']],
      ['CAT_META', ['cat', 'kit', 'meow', 'nyan', 'paws']],
      ['AI_META', ['ai', 'gpt', 'neural', 'brain', 'bot', 'agent', 'llm']],
      ['POLITICS', ['trump', 'biden', 'elon', 'musk', 'maga', 'vote']],
      ['DEFI', ['swap', 'yield', 'lend', 'stake', 'vault', 'pool', 'farm']],
      ['GAMING', ['game', 'play', 'quest', 'guild', 'nft']],
      ['CULTURE', ['pepe', 'wojak', 'frog', 'meme', 'based', 'chad']],
    ];

    for (const [narrative, keywords] of narratives) {
      if (keywords.some(kw => lower.includes(kw))) {
        this.narrativeMap.set(tokenCA, narrative);
        return narrative;
      }
    }

    this.narrativeMap.set(tokenCA, 'OTHER');
    return 'OTHER';
  }

  /**
   * Calculate optimal position size accounting for:
   * - Kelly criterion (win prob & payoff ratio)
   * - Correlation to existing portfolio
   * - Narrative concentration limits
   * - Regime-based adjustment
   * - Portfolio heat
   */
  calculateOptimalSize(
    capitalUSD: number,
    winProbability: number,
    expectedMultiple: number,
    tokenCA: string,
    narrative: string,
    currentPositions: TradePosition[],
    regime: HMMRegime,
    signal_confidence: number
  ): SizingRecommendation {
    // 1. Kelly criterion
    const b = expectedMultiple - 1;   // net payoff odds
    const q = 1 - winProbability;
    const kellyFull = b > 0 ? (winProbability * b - q) / b : 0;
    const kellyPct = Math.max(0, kellyFull * this.KELLY_FRACTION);

    // 2. Adjust for confidence uncertainty
    // Lower confidence → more conservative Kelly
    const confidenceAdjusted = kellyPct * (0.5 + 0.5 * signal_confidence);

    // 3. Correlation adjustment
    const corrAdj = this.getCorrelationAdjustment(tokenCA, currentPositions);

    // 4. Regime adjustment
    const regimeAdj = this.getRegimeMultiplier(regime);

    // 5. Narrative concentration check
    const narrativeAdj = this.getNarrativeAdjustment(narrative, capitalUSD, currentPositions);

    // 6. Portfolio heat check
    const heatAdj = this.getHeatAdjustment(currentPositions, capitalUSD);

    // Combine all adjustments
    let sizePct = confidenceAdjusted * corrAdj * regimeAdj * narrativeAdj * heatAdj;

    // Hard caps
    sizePct = Math.min(sizePct, this.MAX_SINGLE_POSITION);
    sizePct = Math.max(sizePct, 0);

    const sizeUSD = sizePct * capitalUSD;
    const cashAfter = this.getCashReserve(capitalUSD, currentPositions) - sizeUSD;
    const minCash = capitalUSD * this.getCashTarget(regime);

    // Don't trade if it would breach cash target
    if (cashAfter < minCash && currentPositions.length > 0) {
      return {
        recommendedSizeUSD: 0,
        recommendedSizePct: 0,
        kellyOptimalPct: kellyPct,
        correlationAdjustment: corrAdj,
        regimeAdjustment: regimeAdj,
        narrativeAdjustment: narrativeAdj,
        maxAllowedUSD: 0,
        reason: `CASH_RESERVE: would breach ${(this.getCashTarget(regime) * 100).toFixed(0)}% target`,
      };
    }

    return {
      recommendedSizeUSD: sizeUSD,
      recommendedSizePct: sizePct,
      kellyOptimalPct: kellyPct,
      correlationAdjustment: corrAdj,
      regimeAdjustment: regimeAdj,
      narrativeAdjustment: narrativeAdj,
      maxAllowedUSD: this.MAX_SINGLE_POSITION * capitalUSD,
      reason: `Kelly:${(kellyPct * 100).toFixed(1)}% × corr:${corrAdj.toFixed(2)} × regime:${regimeAdj.toFixed(2)} × narr:${narrativeAdj.toFixed(2)} × heat:${heatAdj.toFixed(2)}`,
    };
  }

  /**
   * Get full portfolio risk snapshot
   */
  getPortfolioState(capitalUSD: number, positions: TradePosition[], regime: HMMRegime): PortfolioState {
    const deployed = positions.reduce((s, p) => s + p.sizeUSD, 0);
    const cash = capitalUSD - deployed;

    // Build narrative exposure
    const narrativeExposure = new Map<string, number>();
    for (const pos of positions) {
      const narrative = this.narrativeMap.get(pos.tokenCA) ?? 'OTHER';
      const current = narrativeExposure.get(narrative) ?? 0;
      narrativeExposure.set(narrative, current + pos.sizeUSD / capitalUSD);
    }

    // Correlation matrix
    const corrMatrix = this.buildCorrelationMatrix(positions);

    // Portfolio heat: combination of deployment %, concentration, correlation
    const deployedPct = deployed / capitalUSD;
    const avgCorr = this.getAverageCorrelation(corrMatrix);
    const concentrationRisk = this.getConcentrationRisk(positions, capitalUSD);
    const heat = Math.min(10,
      deployedPct * 4 +  // 100% deployed = 4 heat
      avgCorr * 3 +      // high correlation = 3 heat
      concentrationRisk * 3 // concentration = 3 heat
    );

    // Max drawdown risk estimate
    const worstCase = positions.reduce((max, p) => {
      const possibleLoss = p.sizeUSD * (p.stopLossPct ?? 0.30);
      return max + possibleLoss;
    }, 0);

    return {
      totalCapitalUSD: capitalUSD,
      deployedCapitalUSD: deployed,
      cashReserveUSD: cash,
      deployedPct,
      positions: positions.map(p => ({
        tokenCA: p.tokenCA,
        narrative: this.narrativeMap.get(p.tokenCA) ?? 'OTHER',
        sizeUSD: p.sizeUSD,
        sizePct: p.sizeUSD / capitalUSD,
        unrealizedPnLPct: p.entryPriceSOL > 0
          ? ((p.peakPriceSOL / p.entryPriceSOL) - 1) * 100 : 0,
        correlationToPortfolio: 0, // simplified
        marginalRisk: p.sizeUSD * (p.stopLossPct ?? 0.30),
        holdDurationMs: Date.now() - p.entryTimestamp.getTime(),
      })),
      narrativeExposure,
      correlationMatrix: corrMatrix,
      portfolioHeat: heat,
      maxDrawdownRisk: worstCase / capitalUSD,
      kellyFraction: this.KELLY_FRACTION,
      cashTarget: this.getCashTarget(regime),
    };
  }

  /**
   * Record position returns for correlation tracking
   */
  recordReturn(tokenCA: string, returnPct: number): void {
    const returns = this.returnHistory.get(tokenCA) ?? [];
    returns.push(returnPct);
    if (returns.length > this.CORRELATION_LOOKBACK) returns.shift();
    this.returnHistory.set(tokenCA, returns);

    // Also track aggregate portfolio returns
    this.portfolioReturns.push(returnPct);
    if (this.portfolioReturns.length > this.CORRELATION_LOOKBACK) {
      this.portfolioReturns.shift();
    }
  }

  // ── PRIVATE METHODS ─────────────────────────────────────

  private getCorrelationAdjustment(tokenCA: string, positions: TradePosition[]): number {
    if (positions.length === 0) return 1.0;

    // Check narrative overlap
    const newNarrative = this.narrativeMap.get(tokenCA) ?? 'OTHER';
    let matchCount = 0;

    for (const pos of positions) {
      const posNarrative = this.narrativeMap.get(pos.tokenCA) ?? 'OTHER';
      if (posNarrative === newNarrative && newNarrative !== 'OTHER') {
        matchCount++;
      }
    }

    // Each same-narrative position reduces size by 30%
    return Math.max(0.2, 1.0 - matchCount * 0.30);
  }

  private getRegimeMultiplier(regime: HMMRegime): number {
    switch (regime) {
      case 'RISK_ON':  return 1.0;
      case 'NEUTRAL':  return 0.7;
      case 'RISK_OFF': return 0.35;
      case 'CRISIS':   return 0.0;
    }
  }

  private getNarrativeAdjustment(
    narrative: string,
    capitalUSD: number,
    positions: TradePosition[]
  ): number {
    let narrativeExposure = 0;
    for (const pos of positions) {
      if ((this.narrativeMap.get(pos.tokenCA) ?? 'OTHER') === narrative) {
        narrativeExposure += pos.sizeUSD;
      }
    }

    const currentPct = narrativeExposure / capitalUSD;
    const headroom = this.MAX_NARRATIVE_EXPOSURE - currentPct;

    if (headroom <= 0) return 0;
    if (headroom < 0.10) return 0.5;
    return 1.0;
  }

  private getHeatAdjustment(positions: TradePosition[], capitalUSD: number): number {
    const deployed = positions.reduce((s, p) => s + p.sizeUSD, 0);
    const deployedPct = deployed / capitalUSD;

    if (deployedPct > 0.8) return 0;       // 80%+ deployed: no new trades
    if (deployedPct > 0.6) return 0.3;     // 60-80%: heavily reduced
    if (deployedPct > 0.4) return 0.6;     // 40-60%: moderately reduced
    return 1.0;
  }

  private getCashReserve(capitalUSD: number, positions: TradePosition[]): number {
    const deployed = positions.reduce((s, p) => s + p.sizeUSD, 0);
    return capitalUSD - deployed;
  }

  private getCashTarget(regime: HMMRegime): number {
    switch (regime) {
      case 'RISK_ON':  return 0.20;   // 20% cash minimum
      case 'NEUTRAL':  return 0.40;   // 40%
      case 'RISK_OFF': return 0.65;   // 65%
      case 'CRISIS':   return 1.00;   // 100% cash
    }
  }

  private buildCorrelationMatrix(positions: TradePosition[]): number[][] {
    const n = positions.length;
    if (n < 2) return [[1]];

    const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1;
      for (let j = i + 1; j < n; j++) {
        const corr = this.pairwiseCorrelation(positions[i].tokenCA, positions[j].tokenCA);
        matrix[i][j] = corr;
        matrix[j][i] = corr;
      }
    }

    return matrix;
  }

  private pairwiseCorrelation(tokenA: string, tokenB: string): number {
    const returnsA = this.returnHistory.get(tokenA);
    const returnsB = this.returnHistory.get(tokenB);

    if (!returnsA || !returnsB || returnsA.length < 5 || returnsB.length < 5) {
      // Default: assume moderate positive correlation for memecoins
      const narrA = this.narrativeMap.get(tokenA) ?? 'OTHER';
      const narrB = this.narrativeMap.get(tokenB) ?? 'OTHER';
      return narrA === narrB ? 0.6 : 0.3;
    }

    const n = Math.min(returnsA.length, returnsB.length);
    const a = returnsA.slice(-n);
    const b = returnsB.slice(-n);

    const meanA = a.reduce((s, x) => s + x, 0) / n;
    const meanB = b.reduce((s, x) => s + x, 0) / n;

    let cov = 0, varA = 0, varB = 0;
    for (let i = 0; i < n; i++) {
      const dA = a[i] - meanA;
      const dB = b[i] - meanB;
      cov += dA * dB;
      varA += dA * dA;
      varB += dB * dB;
    }

    const denom = Math.sqrt(varA * varB);
    return denom > 0 ? cov / denom : 0;
  }

  private getAverageCorrelation(matrix: number[][]): number {
    const n = matrix.length;
    if (n < 2) return 0;

    let sum = 0, count = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        sum += Math.abs(matrix[i][j]);
        count++;
      }
    }

    return count > 0 ? sum / count : 0;
  }

  private getConcentrationRisk(positions: TradePosition[], capitalUSD: number): number {
    if (positions.length === 0) return 0;

    // Herfindahl index of position sizes
    const weights = positions.map(p => p.sizeUSD / capitalUSD);
    const hhi = weights.reduce((s, w) => s + w * w, 0);

    // Normalize: 1/n = perfectly diversified, 1 = fully concentrated
    const minHHI = 1 / Math.max(positions.length, 1);
    return (hhi - minHHI) / (1 - minHHI + 0.001);
  }
}
