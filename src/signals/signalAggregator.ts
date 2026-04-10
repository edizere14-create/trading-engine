import { SignalVectorBuilder, CalibratedWeights } from './signalVector';
import { NewPoolEvent, ClusterAlert, SignalVector } from '../core/types';
import { DeployerRegistry } from '../registry/deployerRegistry';
import { WalletRegistry } from '../registry/walletRegistry';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';

interface DataSourceStatus {
  name: string;
  available: boolean;
  lastUpdateMs: number; // timestamp of last data
}

export class SignalAggregator {
  private deployerRegistry: DeployerRegistry;
  private walletRegistry: WalletRegistry;
  private weights: CalibratedWeights;
  private minConsensus: number;

  constructor(
    deployerRegistry: DeployerRegistry,
    walletRegistry: WalletRegistry,
    weights: CalibratedWeights,
    minConsensus: number = 0.65
  ) {
    this.deployerRegistry = deployerRegistry;
    this.walletRegistry = walletRegistry;
    this.weights = weights;
    this.minConsensus = minConsensus;
  }

  updateWeights(weights: CalibratedWeights): void {
    this.weights = weights;
  }

  aggregate(
    event: NewPoolEvent,
    clusterAlert: ClusterAlert | null,
    sources: DataSourceStatus[]
  ): SignalVector | null {
    // ── HARD PRE-FILTERS (before any scoring) ─────────────

    // 1. Absolute minimum liquidity gate
    if (event.initialLiquiditySOL < 100) {
      logger.warn('PRE-FILTER REJECTED: liquidity below 100 SOL', {
        tokenCA: event.tokenCA,
        initialLiquiditySOL: event.initialLiquiditySOL,
        reason: 'MIN_LIQUIDITY',
      });
      return null;
    }

    // 2. Pump.fun tokens need at least 100 SOL liquidity
    if (event.tokenCA.endsWith('pump') && event.initialLiquiditySOL < 100) {
      logger.warn('PRE-FILTER REJECTED: pump.fun token below 100 SOL liquidity', {
        tokenCA: event.tokenCA,
        initialLiquiditySOL: event.initialLiquiditySOL,
        reason: 'PUMP_LOW_LIQ',
      });
      return null;
    }

    // 3. Unknown deployers need at least 50 SOL liquidity
    const preFilterDeployerTier = this.deployerRegistry.getTier(event.deployer);
    if (preFilterDeployerTier === 'UNKNOWN' && event.initialLiquiditySOL < 50) {
      logger.warn('PRE-FILTER REJECTED: unknown deployer with sub-50 SOL liquidity', {
        tokenCA: event.tokenCA,
        deployer: event.deployer,
        initialLiquiditySOL: event.initialLiquiditySOL,
        reason: 'UNKNOWN_DEPLOYER_LOW_LIQ',
      });
      return null;
    }

    const confidence = this.calcDataConfidence(sources);

    if (confidence < this.minConsensus) {
      bus.emit('data:blind', {
        source: 'signalAggregator',
        message: `Consensus ${confidence.toFixed(4)} below ${this.minConsensus} threshold for ${event.tokenCA}`,
      });
      logger.error('LOW_CONSENSUS — skipping signal', {
        tokenCA: event.tokenCA,
        confidence,
        minConsensus: this.minConsensus,
        sourcesDown: sources.filter((s) => !s.available).map((s) => s.name),
      });
      return null;
    }

    const deployerTier = this.deployerRegistry.getTier(event.deployer);
    const detectionLagMs = Date.now() - event.detectedAt.getTime();
    const dexScreenerLagMs = event.dexScreenerLagMs ?? 30000; // assume 30s if unknown

    const builder = new SignalVectorBuilder()
      .setTimingEdge(detectionLagMs, dexScreenerLagMs)
      .setDeployerQuality(deployerTier);

    // Organic flow — defaults when no holder data yet (early detection)
    builder.setOrganicFlow(
      0,     // no holder velocity data at pool creation time
      false, // no bot detection yet
      0.5    // neutral wallet age
    );

    // Manipulation risk — defaults at detection time
    builder.setManipulationRisk(
      0,     // no sniper data yet
      false, // no bundle sell yet
      0,     // no wash trade data yet
      0      // no holder concentration data yet
    );

    // Coordination from cluster alert
    if (clusterAlert) {
      builder.setCoordinationStrength(
        clusterAlert.wallets.length,
        clusterAlert.totalWeightedPnL,
        false // Jito buy bundle detected separately
      );
    } else {
      builder.setCoordinationStrength(0, 0, false);
    }

    // Social — defaults until KOL/Telegram streams fire
    builder.setSocialVelocity(0, 0, Infinity);

    const signal = builder.build(this.weights, confidence);

    logger.info('Signal aggregated', {
      tokenCA: event.tokenCA,
      deployer: event.deployer,
      deployerTier,
      timingEdge: signal.timingEdge,
      deployerQuality: signal.deployerQuality,
      organicFlow: signal.organicFlow,
      manipulationRisk: signal.manipulationRisk,
      coordinationStrength: signal.coordinationStrength,
      socialVelocity: signal.socialVelocity,
      totalScore: signal.totalScore,
      confidence: signal.confidence,
    });

    bus.emit('signal:ready', { tokenCA: event.tokenCA, signal });

    return signal;
  }

  private calcDataConfidence(sources: DataSourceStatus[]): number {
    if (sources.length === 0) return 0.1;

    const now = Date.now();
    const availableCount = sources.filter((s) => s.available).length;
    const availabilityRatio = availableCount / sources.length;

    // Staleness penalty: -1.5% per 30s of lag on the most recent data
    const stalestSource = sources
      .filter((s) => s.available)
      .reduce((max, s) => Math.max(max, now - s.lastUpdateMs), 0);
    const stalenessPenalty = Math.floor(stalestSource / 30000) * 0.015;

    const confidence = Math.max(0.1, availabilityRatio - stalenessPenalty);
    return Math.min(1, confidence);
  }
}
