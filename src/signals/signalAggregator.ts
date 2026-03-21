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

  constructor(
    deployerRegistry: DeployerRegistry,
    walletRegistry: WalletRegistry,
    weights: CalibratedWeights
  ) {
    this.deployerRegistry = deployerRegistry;
    this.walletRegistry = walletRegistry;
    this.weights = weights;
  }

  updateWeights(weights: CalibratedWeights): void {
    this.weights = weights;
  }

  aggregate(
    event: NewPoolEvent,
    clusterAlert: ClusterAlert | null,
    sources: DataSourceStatus[]
  ): SignalVector | null {
    const confidence = this.calcDataConfidence(sources);

    if (confidence < 0.3) {
      bus.emit('data:blind', {
        source: 'signalAggregator',
        message: `Confidence ${confidence.toFixed(2)} below 0.3 threshold for ${event.tokenCA}`,
      });
      logger.error('DATA_BLIND — skipping signal', {
        tokenCA: event.tokenCA,
        confidence,
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
