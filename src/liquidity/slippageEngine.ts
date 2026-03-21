import { LiquiditySnapshot } from '../core/types';
import { logger } from '../core/logger';

const SWAP_FEE = 0.0025; // 0.25%

export class SlippageEngine {
  // AMM constant product: x * y = k
  // x = SOL reserve, y = token reserve, k = constant
  estimateSlippage(
    reserveSOL: number,
    reserveTokens: bigint,
    buySizeSOL: number
  ): { executionPrice: number; priceImpactPct: number; tokensReceived: bigint } {
    const reserveTokensNum = Number(reserveTokens);
    const k = reserveSOL * reserveTokensNum;
    const effectiveBuy = buySizeSOL * (1 - SWAP_FEE);
    const newReserveSOL = reserveSOL + effectiveBuy;
    const newReserveTokens = k / newReserveSOL;
    const tokensReceivedNum = reserveTokensNum - newReserveTokens;
    const tokensReceived = BigInt(Math.floor(tokensReceivedNum));

    const spotPrice = reserveSOL / reserveTokensNum;
    const executionPrice = buySizeSOL / tokensReceivedNum;
    const priceImpactPct = ((executionPrice - spotPrice) / spotPrice) * 100;

    return { executionPrice, priceImpactPct, tokensReceived };
  }

  estimateExitLiquidityRisk(
    reserveSOL: number,
    positionSizeUSD: number,
    solPriceUSD: number
  ): number {
    // Risk 0–10: how difficult is it to exit this position?
    const positionSOL = positionSizeUSD / solPriceUSD;
    const liquidityRatio = positionSOL / reserveSOL;

    if (liquidityRatio > 0.20) return 10; // you ARE the liquidity
    if (liquidityRatio > 0.10) return 8;
    if (liquidityRatio > 0.05) return 5;
    if (liquidityRatio > 0.02) return 3;
    return 1;
  }

  getLiquiditySnapshot(
    tokenCA: string,
    poolAddress: string,
    reserveSOL: number,
    reserveTokens: bigint,
    solPriceUSD: number
  ): LiquiditySnapshot {
    const priceSOL = reserveSOL / Number(reserveTokens);

    // Slippage for $1K buy
    const buy1KSOL = 1000 / solPriceUSD;
    const slip1K = this.estimateSlippage(reserveSOL, reserveTokens, buy1KSOL);

    // Slippage for $5K buy
    const buy5KSOL = 5000 / solPriceUSD;
    const slip5K = this.estimateSlippage(reserveSOL, reserveTokens, buy5KSOL);

    // Exit liquidity risk at $1K position size
    const exitRisk = this.estimateExitLiquidityRisk(reserveSOL, 1000, solPriceUSD);

    const snapshot: LiquiditySnapshot = {
      tokenCA,
      poolAddress,
      reserveSOL,
      reserveTokens,
      priceSOL,
      slippage1KSOL: slip1K.priceImpactPct,
      slippage5KSOL: slip5K.priceImpactPct,
      exitLiquidityRisk: exitRisk,
      timestamp: new Date(),
    };

    logger.info('Liquidity snapshot', {
      tokenCA,
      reserveSOL: reserveSOL.toFixed(2),
      priceSOL: priceSOL.toFixed(12),
      slippage1K: `${slip1K.priceImpactPct.toFixed(2)}%`,
      slippage5K: `${slip5K.priceImpactPct.toFixed(2)}%`,
      exitRisk,
    });

    return snapshot;
  }

  isEntryViable(priceImpactPct: number, maxAllowedImpactPct: number): boolean {
    return priceImpactPct <= maxAllowedImpactPct;
  }
}
