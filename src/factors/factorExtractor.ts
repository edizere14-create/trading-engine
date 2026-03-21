import { JournalEntry } from '../journal/journalTypes';

export interface FactorVector {
  // Binary factors
  liqAbove60k: boolean;
  liqAbove100k: boolean;
  smartWallets3Plus: boolean;
  smartWallets5Plus: boolean;
  deployerSOrA: boolean;
  deployerS: boolean;
  marketHot: boolean;
  regimeAggressive: boolean;
  timingEdgeHigh: boolean;
  manipRiskSafe: boolean;
  coordinationHigh: boolean;
  sniperClean: boolean;
  holderVelocityFast: boolean;
  volumeSpikeStrong: boolean;
  evAbove1R: boolean;
  evAbove2R: boolean;
  confidenceHigh: boolean;

  // Numeric factors
  liquiditySOL: number;
  smartWalletCount: number;
  signalTotal: number;
  deployerQuality: number;
  timingEdge: number;
  manipulationRisk: number;
  predictedEV: number;
  confidence: number;
  sniperPct: number;
  volumeSlope: number;

  // Outcome
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
  realizedMultiple: number;
}

export function extractFactors(entry: JournalEntry): FactorVector {
  return {
    liqAbove60k:         (entry.entryLiquiditySOL ?? 0) > 60,
    liqAbove100k:        (entry.entryLiquiditySOL ?? 0) > 100,
    smartWallets3Plus:   (entry.entrySmartWalletCount ?? 0) >= 3,
    smartWallets5Plus:   (entry.entrySmartWalletCount ?? 0) >= 5,
    deployerSOrA:        ['S', 'A'].includes(entry.deployerTier ?? ''),
    deployerS:           entry.deployerTier === 'S',
    marketHot:           entry.entryMarketState === 'HOT',
    regimeAggressive:    entry.entryRegime === 'AGGRESSIVE',
    timingEdgeHigh:      (entry.signalTimingEdge ?? 0) > 7,
    manipRiskSafe:       (entry.signalManipulationRisk ?? 0) > 7,
    coordinationHigh:    (entry.signalCoordinationStrength ?? 0) > 6,
    sniperClean:         (entry.sniperBlock0Pct ?? 1) < 0.05,
    holderVelocityFast:  (entry.buyClusterFrequency ?? 0) > 2,
    volumeSpikeStrong:   (entry.volumeSpikeSlope ?? 0) > 2.1,
    evAbove1R:           (entry.predictedEV ?? 0) > 1.0,
    evAbove2R:           (entry.predictedEV ?? 0) > 2.0,
    confidenceHigh:      (entry.signalConfidence ?? 0) > 0.7,

    liquiditySOL:        entry.entryLiquiditySOL ?? 0,
    smartWalletCount:    entry.entrySmartWalletCount ?? 0,
    signalTotal:         entry.signalTotalScore ?? 0,
    deployerQuality:     entry.signalDeployerQuality ?? 0,
    timingEdge:          entry.signalTimingEdge ?? 0,
    manipulationRisk:    entry.signalManipulationRisk ?? 0,
    predictedEV:         entry.predictedEV ?? 0,
    confidence:          entry.signalConfidence ?? 0,
    sniperPct:           entry.sniperBlock0Pct ?? 0,
    volumeSlope:         entry.volumeSpikeSlope ?? 0,

    outcome:             entry.outcome ?? 'LOSS',
    realizedMultiple:    entry.realizedMultiple ?? 0,
  };
}
