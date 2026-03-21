import { TradeJournal } from '../journal/tradeJournal';
import { extractFactors, FactorVector } from './factorExtractor';
import { logger } from '../core/logger';

export interface FactorPattern {
  conditions: Partial<Record<keyof FactorVector, boolean | number>>;
  sampleSize: number;
  winRate: number;
  avgMultiple: number;
  expectedValue: number;
  confidence: number;
  recommendation: 'SCALE_UP' | 'NORMAL' | 'REDUCE' | 'AVOID';
}

export class FactorEngine {
  private journal: TradeJournal;
  private readonly MIN_SAMPLE = 10;

  constructor(journal: TradeJournal) {
    this.journal = journal;
  }

  analyzeSingleFactors(): Map<string, FactorPattern> {
    const entries = this.journal.getAll().filter((e) => e.outcome !== undefined);
    const vectors = entries.map(extractFactors);
    const results = new Map<string, FactorPattern>();

    const binaryFactors: Array<keyof FactorVector> = [
      'liqAbove60k', 'liqAbove100k', 'smartWallets3Plus',
      'smartWallets5Plus', 'deployerSOrA', 'deployerS',
      'marketHot', 'regimeAggressive', 'timingEdgeHigh',
      'manipRiskSafe', 'coordinationHigh', 'sniperClean',
      'holderVelocityFast', 'volumeSpikeStrong',
      'evAbove1R', 'evAbove2R', 'confidenceHigh',
    ];

    for (const factor of binaryFactors) {
      const matching = vectors.filter((v) => v[factor] === true);
      if (matching.length < this.MIN_SAMPLE) continue;

      const wins = matching.filter((v) => v.outcome === 'WIN');
      const winRate = wins.length / matching.length;
      const avgMultiple =
        matching.reduce((s, v) => s + v.realizedMultiple, 0) / matching.length;
      const ev = avgMultiple - 1;

      results.set(String(factor), {
        conditions: { [factor]: true },
        sampleSize: matching.length,
        winRate,
        avgMultiple,
        expectedValue: ev,
        confidence: this.calcConfidence(matching.length, winRate),
        recommendation:
          winRate > 0.55
            ? 'SCALE_UP'
            : winRate > 0.45
              ? 'NORMAL'
              : winRate > 0.35
                ? 'REDUCE'
                : 'AVOID',
      });
    }

    return results;
  }

  analyzeFactorCombinations(): FactorPattern[] {
    const entries = this.journal.getAll().filter((e) => e.outcome !== undefined);
    if (entries.length < 30) {
      logger.warn('Factor combinations need 30+ trades', { current: entries.length });
      return [];
    }

    const vectors = entries.map(extractFactors);
    const patterns: FactorPattern[] = [];

    const combos: Array<[keyof FactorVector, keyof FactorVector]> = [
      ['liqAbove60k', 'smartWallets3Plus'],
      ['liqAbove60k', 'volumeSpikeStrong'],
      ['smartWallets3Plus', 'deployerSOrA'],
      ['smartWallets3Plus', 'timingEdgeHigh'],
      ['deployerS', 'coordinationHigh'],
      ['manipRiskSafe', 'sniperClean'],
      ['evAbove2R', 'confidenceHigh'],
      ['marketHot', 'timingEdgeHigh'],
    ];

    for (const [f1, f2] of combos) {
      const matching = vectors.filter((v) => v[f1] === true && v[f2] === true);
      if (matching.length < this.MIN_SAMPLE) continue;

      const wins = matching.filter((v) => v.outcome === 'WIN');
      const winRate = wins.length / matching.length;
      const avgMultiple =
        matching.reduce((s, v) => s + v.realizedMultiple, 0) / matching.length;

      patterns.push({
        conditions: { [f1]: true, [f2]: true },
        sampleSize: matching.length,
        winRate,
        avgMultiple,
        expectedValue: avgMultiple - 1,
        confidence: this.calcConfidence(matching.length, winRate),
        recommendation:
          winRate > 0.55
            ? 'SCALE_UP'
            : winRate > 0.45
              ? 'NORMAL'
              : winRate > 0.35
                ? 'REDUCE'
                : 'AVOID',
      });
    }

    return patterns.sort((a, b) => b.expectedValue - a.expectedValue);
  }

  getSizeMultiplier(vector: FactorVector): number {
    const patterns = this.analyzeFactorCombinations();
    const matching = patterns.filter(
      (p) =>
        Object.entries(p.conditions).every(
          ([k, v]) => vector[k as keyof FactorVector] === v,
        ) && p.sampleSize >= this.MIN_SAMPLE,
    );

    if (matching.length === 0) return 1.0;
    const best = matching[0];

    if (best.recommendation === 'SCALE_UP') return 1.5;
    if (best.recommendation === 'NORMAL') return 1.0;
    if (best.recommendation === 'REDUCE') return 0.5;
    return 0.0; // AVOID
  }

  private calcConfidence(n: number, winRate: number): number {
    const z = 1.96;
    const p = winRate;
    const denominator = 1 + (z * z) / n;
    const center = p + (z * z) / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    const lower = (center - margin) / denominator;
    return Math.max(0, lower);
  }
}
