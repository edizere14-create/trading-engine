import { TradeJournal } from '../journal/tradeJournal';
import { SignalVectorBuilder, DEFAULT_WEIGHTS } from '../signals/signalVector';
import { RiskEngine } from '../risk/riskEngine';
import { logger } from '../core/logger';
import { DeployerTier } from '../core/types';

export interface ReplayResult {
  tokenCA: string;
  ticker: string;
  replayDurationMs: number;
  signalAtMinute: Record<number, number>;
  riskDecisionAtMinute: Record<number, string>;
  optimalEntryMinute: number;
  optimalExitMinute: number;
  theoreticalROI: number;
  systemROI: number;
  lessons: string[];
}

const VALID_TIERS: DeployerTier[] = ['S', 'A', 'B', 'BLACKLIST', 'UNKNOWN'];

export class ReplaySimulator {
  private journal: TradeJournal;
  private riskEngine: RiskEngine;

  constructor(journal: TradeJournal, riskEngine: RiskEngine) {
    this.journal = journal;
    this.riskEngine = riskEngine;
  }

  async replayToken(tokenCA: string): Promise<ReplayResult | null> {
    const entry = this.journal.getAll().find((e) => e.tokenCA === tokenCA);
    if (!entry) {
      logger.warn('Token not found in journal', { tokenCA });
      return null;
    }

    const lessons: string[] = [];

    const tier: DeployerTier = VALID_TIERS.includes(entry.deployerTier as DeployerTier)
      ? (entry.deployerTier as DeployerTier)
      : 'UNKNOWN';

    const builder = new SignalVectorBuilder();
    const signal = builder
      .setTimingEdge(entry.detectionLagMs ?? 5000, 30000)
      .setDeployerQuality(tier)
      .setOrganicFlow(entry.buyClusterFrequency ?? 0, false, 0.5)
      .setManipulationRisk(
        entry.sniperBlock0Pct ?? 0,
        false,
        0,
        entry.topHolderPct ?? 0,
      )
      .setCoordinationStrength(entry.entrySmartWalletCount ?? 0, 0, false)
      .setSocialVelocity(0, 0, 999999)
      .build(DEFAULT_WEIGHTS, entry.signalConfidence ?? 0.5);

    // Generate lessons based on outcome vs signal
    if (entry.outcome === 'LOSS' && signal.manipulationRisk < 5) {
      lessons.push(
        'Manipulation risk was high — sniper/rug signal was present at entry',
      );
    }

    if (entry.outcome === 'WIN' && (entry.entrySmartWalletCount ?? 0) >= 3) {
      lessons.push(
        'Smart wallet clustering was the primary driver — weight this edge higher',
      );
    }

    if (entry.outcome === 'LOSS' && entry.exitMode === 'TIME_EXIT') {
      lessons.push(
        'Edge expired before price moved — maxHoldMs may be too short for this setup',
      );
    }

    if (
      entry.peakMultiple &&
      entry.realizedMultiple &&
      entry.peakMultiple > entry.realizedMultiple * 2
    ) {
      lessons.push(
        `Left ${(entry.peakMultiple / entry.realizedMultiple).toFixed(1)}x on table — exit tiers too aggressive`,
      );
    }

    return {
      tokenCA,
      ticker: entry.ticker,
      replayDurationMs: entry.holdDurationMs ?? 0,
      signalAtMinute: { 0: signal.totalScore },
      riskDecisionAtMinute: {},
      optimalEntryMinute: 0,
      optimalExitMinute: Math.round((entry.holdDurationMs ?? 0) / 60000),
      theoreticalROI: entry.peakMultiple ?? 1,
      systemROI: entry.realizedMultiple ?? 1,
      lessons,
    };
  }

  async replayAll(): Promise<void> {
    const trades = this.journal.getAll().filter((t) => t.outcome !== undefined);
    logger.info(`Replaying ${trades.length} trades...`);

    const allLessons: string[] = [];
    for (const trade of trades) {
      const result = await this.replayToken(trade.tokenCA);
      if (result) allLessons.push(...result.lessons);
    }

    // Count lesson frequency
    const freq = new Map<string, number>();
    for (const l of allLessons) freq.set(l, (freq.get(l) ?? 0) + 1);

    console.log('\n\u2550\u2550 REPLAY SYSTEMATIC LESSONS \u2550\u2550');
    [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([lesson, count]) => {
        console.log(`  [${count}x] ${lesson}`);
      });
    console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');
  }
}

// ── CLI Entry Point ────────────────────────────────────────
if (require.main === module) {
  const journal = new TradeJournal();
  const riskEngine = new RiskEngine();
  const sim = new ReplaySimulator(journal, riskEngine);
  sim.replayAll().then(() => {
    journal.close();
    process.exit(0);
  }).catch((err) => {
    logger.error('Replay failed', { error: String(err) });
    journal.close();
    process.exit(1);
  });
}
