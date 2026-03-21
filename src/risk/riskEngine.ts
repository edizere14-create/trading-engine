import {
  SignalVector,
  MarketStateSnapshot,
  RiskDecision,
  ExecutionMode,
  SurvivalSnapshot,
} from '../core/types';
import { logger } from '../core/logger';

const NO_TRADE: Omit<RiskDecision, 'reason'> = {
  tradeAllowed: false,
  sizeR: 0,
  sizeUSD: 0,
  maxHoldMs: 0,
  executionMode: 'SAFE',
  stopPriceLamports: 0n,
};

export class RiskEngine {
  private getBaseR(capitalUSD: number): number {
    if (capitalUSD < 300)  return 6;
    if (capitalUSD < 1000) return 20;
    if (capitalUSD < 3000) return capitalUSD * 0.02;
    if (capitalUSD < 7000) return capitalUSD * 0.015;
    return capitalUSD * 0.01;
  }

  decide(
    capitalUSD: number,
    signal: SignalVector,
    marketState: MarketStateSnapshot,
    survival: SurvivalSnapshot,
    predictedWP: number,
    predictedMultiple: number
  ): RiskDecision {
    // Gate 1: Survival HALT
    if (survival.state === 'HALT') {
      const decision: RiskDecision = { ...NO_TRADE, reason: 'SYSTEM_HALT' };
      logger.warn('RISK_GATE: SYSTEM_HALT', { state: survival.state });
      return decision;
    }

    // Gate 2: Regime EXTREME or EMA SIGMA — only pass if predictedWP > 9.5
    if (marketState.regime === 'EXTREME' || marketState.emaLayer === 'SIGMA') {
      if (predictedWP < 9.5) {
        const decision: RiskDecision = { ...NO_TRADE, reason: 'REGIME_SIGMA_LOCK' };
        logger.warn('RISK_GATE: REGIME_SIGMA_LOCK', {
          regime: marketState.regime,
          emaLayer: marketState.emaLayer,
          predictedWP,
        });
        return decision;
      }
    }

    // Gate 3: EV check
    const ev = (predictedWP * predictedMultiple) - ((1 - predictedWP) * 0.3);
    if (ev < 0.30) {
      const decision: RiskDecision = { ...NO_TRADE, reason: `EV_TOO_LOW: ${ev.toFixed(2)}R` };
      logger.info('RISK_GATE: EV_TOO_LOW', { ev: ev.toFixed(4), predictedWP, predictedMultiple });
      return decision;
    }

    // Size calculation
    const baseR = this.getBaseR(capitalUSD);

    const regimeMult = marketState.regime === 'AGGRESSIVE' ? 1.0
                     : marketState.regime === 'NORMAL'     ? 0.6
                     : marketState.regime === 'DEFENSIVE'  ? 0.25
                     : 0; // EXTREME — shouldn't reach here unless predictedWP > 9.5

    const betaMult = marketState.emaLayer === 'BETA' ? 0.5 : 1.0;
    const survivalMult = survival.sizeMultiplier;
    const sizeMultiplier = regimeMult * betaMult * survivalMult;

    // Full size if EV >= 0.45R, half size if EV >= 0.30R
    const sizeR = ev >= 0.45
      ? baseR * sizeMultiplier
      : baseR * sizeMultiplier * 0.5;

    // Execution mode
    const executionMode: ExecutionMode =
      marketState.state === 'HOT' && signal.timingEdge > 7 ? 'WAR'  :
      marketState.state === 'HOT'                          ? 'FAST' :
      'SAFE';

    // Max hold duration based on primary edge
    const maxHoldMs = signal.timingEdge > 7      ? 90_000   // 90s — copy wave window
                    : signal.deployerQuality > 8 ? 600_000  // 10min — deployer play
                    : 300_000;                               // 5min default

    const decision: RiskDecision = {
      tradeAllowed: true,
      sizeR,
      sizeUSD: sizeR,
      maxHoldMs,
      executionMode,
      stopPriceLamports: 0n, // calculated by caller with actual entry price
      reason: `EV:${ev.toFixed(2)}R | STATE:${marketState.state} | MODE:${executionMode}`,
    };

    logger.info('RISK_DECISION', {
      capitalUSD,
      baseR,
      ev: ev.toFixed(4),
      regime: marketState.regime,
      emaLayer: marketState.emaLayer,
      regimeMult,
      betaMult,
      survivalMult,
      sizeR: sizeR.toFixed(2),
      executionMode,
      maxHoldMs,
    });

    return decision;
  }
}
