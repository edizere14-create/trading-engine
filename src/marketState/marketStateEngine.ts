import { MarketState, MarketStateSnapshot, Regime, EMALayer } from '../core/types';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';

interface RegimeInputs {
  solMomentum4h: number;    // -1 to +1
  dexVolumeChange24h: number; // -1 to +1
  memeActivity: number;     // 0 to 1
  btcDominance: number;     // 0 to 1
}

export class MarketStateEngine {
  private currentSnapshot: MarketStateSnapshot | null = {
    state: 'NORMAL',
    regime: 'NORMAL',
    emaLayer: 'ALPHA',
    newTokensPerHour: 40,
    avgPeakMultiple24h: 2.5,
    dexVolumeChange24h: 0,
    solMomentum4h: 0,
    atr14: 0,
    atrBaseline: 0,
    score: 0,
    timestamp: new Date(),
  };
  private regimeInputs: RegimeInputs = {
    solMomentum4h: 0,
    dexVolumeChange24h: 0,
    memeActivity: 0.5,
    btcDominance: 0.5,
  };

  setRegimeInputs(inputs: RegimeInputs): void {
    this.regimeInputs = inputs;
  }

  classifyMarketState(
    newTokensPerHour: number,
    avgPeakMultiple24h: number,
    dexVolumeChange24h: number
  ): MarketState {
    // HOT: all three conditions must be met
    if (
      newTokensPerHour > 80 &&
      avgPeakMultiple24h > 3.5 &&
      dexVolumeChange24h > 0.2
    ) {
      return 'HOT';
    }

    // DEAD: any one condition triggers
    if (
      newTokensPerHour < 20 ||
      avgPeakMultiple24h < 1.5 ||
      dexVolumeChange24h < -0.3
    ) {
      return 'DEAD';
    }

    return 'NORMAL';
  }

  classifyRegime(
    solCloses1H: number[],
    solHighs1H: number[],
    solLows1H: number[]
  ): { regime: Regime; emaLayer: EMALayer; atr14: number; atrBaseline: number; solMomentum4h: number } {
    if (solCloses1H.length < 20) {
      throw new Error(`Need at least 20 closes for EMA, got ${solCloses1H.length}`);
    }

    const currentPrice = solCloses1H[solCloses1H.length - 1];
    const ema20 = this.calcEMA20(solCloses1H);

    // ATR14 from last 14 candles
    const atr14 = this.calcATR14(
      solHighs1H.slice(-14),
      solLows1H.slice(-14),
      solCloses1H.slice(-15)
    );

    // ATR baseline: rolling 30-day average of ATR14
    const atrBaseline = this.calcATRBaseline(solHighs1H, solLows1H, solCloses1H);

    // EMA Layer classification
    const deviation = Math.abs(currentPrice - ema20) / ema20;
    const isSigma = atr14 > atrBaseline * 2.2;

    let emaLayer: EMALayer;
    if (isSigma) {
      emaLayer = 'SIGMA';
    } else if (currentPrice > ema20 && deviation > 0.01) {
      emaLayer = 'ALPHA';
    } else if (deviation <= 0.01) {
      emaLayer = 'BETA';
    } else {
      emaLayer = 'SIGMA';
    }

    // SOL 4h momentum: price change over last 4 candles
    const fourHAgo = solCloses1H.length >= 4
      ? solCloses1H[solCloses1H.length - 4]
      : solCloses1H[0];
    const solMomentum4h = (currentPrice - fourHAgo) / fourHAgo;

    // Regime score: composite of four factors
    const score = this.calcRegimeScore();

    let regime: Regime;
    if (isSigma) {
      regime = 'EXTREME';
    } else if (score > 0.6) {
      regime = 'AGGRESSIVE';
    } else if (score >= 0.2) {
      regime = 'NORMAL';
    } else if (score >= -0.2) {
      regime = 'DEFENSIVE';
    } else {
      regime = 'EXTREME';
    }

    return { regime, emaLayer, atr14, atrBaseline, solMomentum4h };
  }

  update(
    newTokensPerHour: number,
    avgPeakMultiple24h: number,
    dexVolumeChange24h: number,
    solCloses1H: number[],
    solHighs1H: number[],
    solLows1H: number[]
  ): MarketStateSnapshot {
    const state = this.classifyMarketState(newTokensPerHour, avgPeakMultiple24h, dexVolumeChange24h);
    const { regime, emaLayer, atr14, atrBaseline, solMomentum4h } = this.classifyRegime(
      solCloses1H,
      solHighs1H,
      solLows1H
    );

    const score = this.calcRegimeScore();

    const snapshot: MarketStateSnapshot = {
      state,
      regime,
      emaLayer,
      newTokensPerHour,
      avgPeakMultiple24h,
      dexVolumeChange24h,
      solMomentum4h,
      atr14,
      atrBaseline,
      score,
      timestamp: new Date(),
    };

    // Emit on regime change
    const prevRegime = this.currentSnapshot?.regime;
    const prevState = this.currentSnapshot?.state;
    if (prevRegime !== regime || prevState !== state) {
      bus.emit('market:stateChanged', snapshot);
      logger.info('Market state changed', {
        prevState,
        newState: state,
        prevRegime,
        newRegime: regime,
        emaLayer,
        atr14: atr14.toFixed(4),
        atrBaseline: atrBaseline.toFixed(4),
        score: score.toFixed(3),
      });
    }

    this.currentSnapshot = snapshot;
    return snapshot;
  }

  getSnapshot(): MarketStateSnapshot | null {
    return this.currentSnapshot;
  }

  private calcEMA20(closes: number[]): number {
    const period = 20;
    const k = 2 / (period + 1);
    // Seed with SMA of first 20 values
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
  }

  private calcATR14(highs: number[], lows: number[], closes: number[]): number {
    // Wilder smoothing of True Range over 14 periods
    // closes needs 15 elements (closes[i-1] for TR calc), highs/lows need 14
    if (highs.length < 14 || lows.length < 14 || closes.length < 15) {
      return 0;
    }

    // First TR
    let atr = Math.max(
      highs[0] - lows[0],
      Math.abs(highs[0] - closes[0]),
      Math.abs(lows[0] - closes[0])
    );

    // Wilder smoothing for remaining 13
    for (let i = 1; i < 14; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i]),
        Math.abs(lows[i] - closes[i])
      );
      atr = atr * (13 / 14) + tr * (1 / 14);
    }

    return atr;
  }

  private calcATRBaseline(highs: number[], lows: number[], closes: number[]): number {
    // Rolling 30-day average of ATR14 (needs enough data)
    if (closes.length < 28) {
      // Not enough data — return current ATR as baseline
      return this.calcATR14(highs.slice(-14), lows.slice(-14), closes.slice(-15));
    }

    const atrs: number[] = [];
    for (let i = 14; i < closes.length; i++) {
      const atr = this.calcATR14(
        highs.slice(i - 14, i),
        lows.slice(i - 14, i),
        closes.slice(i - 15, i)
      );
      if (atr > 0) atrs.push(atr);
    }

    if (atrs.length === 0) return 0;
    return atrs.reduce((a, b) => a + b, 0) / atrs.length;
  }

  private calcRegimeScore(): number {
    // (SOL_MOM × 0.4) + (DEX_VOL × 0.3) + (MEME_ACT × 0.2) + (1 - BTC_DOM × 0.1)
    const { solMomentum4h, dexVolumeChange24h, memeActivity, btcDominance } = this.regimeInputs;
    return (
      solMomentum4h * 0.4 +
      dexVolumeChange24h * 0.3 +
      memeActivity * 0.2 +
      (1 - btcDominance) * 0.1
    );
  }
}
