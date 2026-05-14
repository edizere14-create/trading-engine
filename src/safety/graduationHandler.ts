/**
 * Graduation handler: bridges pool:graduated events to the existing
 * trade:signal execution path, gated by the safety pipeline.
 *
 * Flow:
 *   1. Subscribe to bus 'pool:graduated' on start()
 *   2. For each event, run runSafetyPipeline(event, ...)
 *   3. On pass: synthesize a TradeSignal (source: AUTONOMOUS) and emit
 *      'trade:signal'. The existing handler at index.ts:1075 then takes
 *      over (hpp suppression, execution, sizing, positionManager).
 *   4. On reject: emit 'safety:blocked' with a reason matching the
 *      existing convention from tokenSafetyChecker.ts (UPPER_SNAKE_CASE
 *      — human-readable explanation).
 *
 * The handler does NOT call positionManager.openTrade directly. It emits
 * trade:signal and relies on the existing execution path. This means:
 *   - HybridPowerPlay's migration cooldown suppression still applies.
 *   - Gate metrics in index.ts still tick.
 *   - Single source of truth for "what does it mean to enter a position."
 *
 * Synthesized signal field choices (see synthesizeSignalFromGraduation):
 *   - source: 'AUTONOMOUS' (graduation is system-driven, not wallet-triggered)
 *   - convictionSOL: event.initialLiquiditySOL (honest analogue; no
 *     trigger wallet to copy)
 *   - entryPriceSOL: 0 (positionManager anchors on first valid tick
 *     via priceBasisInvalid flag; round-1 cascade bug is mitigated)
 *   - score: 10, confidence: 1 (already passed safety; treat as max)
 */

import { bus } from '../core/eventBus';
import { logger } from '../core/logger';
import {
  PumpSwapGraduationEvent,
  TradeSignal,
} from '../core/types';
import { TokenSafetyChecker } from './tokenSafetyChecker';
import { AntifragileEngine } from '../antifragile/antifragileEngine';
import { runSafetyPipeline, SafetyPipelineResult } from './orchestrator';

export class GraduationHandler {
  private listener?: (event: PumpSwapGraduationEvent) => void;

  constructor(
    private tokenSafetyChecker: TokenSafetyChecker,
    private antifragile?: AntifragileEngine,
  ) {}

  start(): void {
    if (this.listener) return; // idempotent
    this.listener = (event) => {
      void this.handle(event);
    };
    bus.on('pool:graduated', this.listener);
    logger.info('GraduationHandler started');
  }

  stop(): void {
    if (this.listener) {
      bus.off('pool:graduated', this.listener);
      this.listener = undefined;
      logger.info('GraduationHandler stopped');
    }
  }

  /**
   * Called by the bus subscription for each pool:graduated event.
   * PUBLIC for test access only — production callers should rely on
   * the bus subscription set up by start(). Tests await this directly
   * to avoid EventEmitter async-listener timing fragility.
   */
  async handle(event: PumpSwapGraduationEvent): Promise<void> {
    try {
      const result = await runSafetyPipeline(
        event,
        this.tokenSafetyChecker,
        undefined, // tokenName: v2 baseline, name resolution deferred
        this.antifragile,
      );

      if (!result.passed) {
        const reason = formatReason(result);
        bus.emit('safety:blocked', {
          tokenCA: event.tokenCA,
          reasons: [reason],
        });
        logger.info('Graduation safety check FAILED', {
          tokenCA: event.tokenCA,
          failedPhase: result.failedPhase,
          failedCheck: result.failedPhase === 'A'
            ? result.phaseA.failedCheck
            : result.phaseB?.failedCheck,
          reason,
          durationMs: result.durationMs,
        });
        return;
      }

      const signal = synthesizeSignalFromGraduation(event);
      bus.emit('trade:signal', signal);
      logger.info('Graduation safety check PASSED -> trade:signal', {
        tokenCA: event.tokenCA,
        durationMs: result.durationMs,
      });
    } catch (err) {
      // Defensive: pipeline shouldn't throw, but if it does, drop the
      // event and log. Bus listeners must not crash the bot.
      logger.error('GraduationHandler error', {
        tokenCA: event.tokenCA,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function synthesizeSignalFromGraduation(event: PumpSwapGraduationEvent): TradeSignal {
  return {
    tokenCA:         event.tokenCA,
    source:          'AUTONOMOUS',
    triggerWallet:   event.deployer,
    walletTier:      'B',
    walletPnL30d:    0,
    convictionSOL:   event.initialLiquiditySOL,
    clusterWallets:  [],
    clusterSize:     1,
    totalClusterSOL: event.initialLiquiditySOL,
    entryPriceSOL:   0, // positionManager anchors on first tick
    timestamp:       new Date(event.detectedAt),
    slot:            event.slot,
    score:           10,
    confidence:      1,
  };
}

function formatReason(result: SafetyPipelineResult): string {
  if (result.failedPhase === 'A') {
    const check = result.phaseA.failedCheck;
    if (check === 'liquidity') {
      const sol = result.phaseA.trace.liquidity?.valueSOL ?? 0;
      return `LIQUIDITY_INSUFFICIENT — ${sol.toFixed(2)} SOL below 3.0 SOL minimum`;
    }
    if (check === 'scammyName') {
      return 'SCAMMY_NAME — token name matches scam pattern';
    }
  }
  if (result.failedPhase === 'B' && result.phaseB) {
    const check = result.phaseB.failedCheck;
    const trace = result.phaseB.trace;
    switch (check) {
      case 'mintAuthority':
        return 'MINT_AUTHORITY_ACTIVE — deployer can inflate supply';
      case 'freezeAuthority':
        return 'FREEZE_AUTHORITY_ACTIVE — deployer can freeze accounts';
      case 'holderConcentration':
        return `TOP_HOLDER_CONCENTRATION ${trace.holderConcentration.topPct.toFixed(0)}% — above 30% threshold`;
      case 'lpLock':
        return 'LP_NOT_LOCKED — liquidity provider can withdraw';
      case 'honeypot':
        return `HONEYPOT_${trace.honeypot.classification} — sellability check failed`;
      case 'deployerBlacklist':
        return 'DEPLOYER_BLACKLISTED — known scam deployer';
    }
  }
  return 'SAFETY_CHECK_FAILED — unknown failure';
}