import { SwapEvent } from '../core/types';

export interface MicrostructureFeatures {
  tokenCA: string;
  windowMs: number;

  buyClusterCount: number;
  buyClusterFrequency: number;

  uniqueBuyers: number;
  uniqueSellers: number;
  walletDiversityScore: number;

  liquidityGrowthSlope: number;

  volumeSpikeSlope: number;
  volumeAccelerating: boolean;

  impulseExhaustionScore: number;
  buyToSellRatio: number;
  averageBuySizeSOL: number;
  buySizeDecelerating: boolean;

  smartWalletBuyCount: number;
  smartWalletSellCount: number;
  smartMoneyNetFlow: number;

  capturedAt: Date;
}

export class MicrostructureFeatureExtractor {
  private swapBuffer = new Map<string, SwapEvent[]>();

  addSwap(event: SwapEvent): void {
    const buf = this.swapBuffer.get(event.tokenCA) ?? [];
    buf.push(event);
    const cutoff = Date.now() - 600_000;
    const filtered = buf.filter((e) => e.timestamp.getTime() > cutoff);
    this.swapBuffer.set(event.tokenCA, filtered);
  }

  extract(tokenCA: string, windowMs: number = 300_000): MicrostructureFeatures | null {
    const swaps = this.swapBuffer.get(tokenCA) ?? [];
    const cutoff = Date.now() - windowMs;
    const window = swaps.filter((s) => s.timestamp.getTime() > cutoff);

    if (window.length < 3) return null;

    const buys = window.filter((s) => s.action === 'BUY');
    const sells = window.filter((s) => s.action === 'SELL');

    // Wallet diversity
    const uniqueBuyerSet = new Set(buys.map((s) => s.wallet));
    const uniqueSellerSet = new Set(sells.map((s) => s.wallet));
    const diversityRatio = uniqueBuyerSet.size / Math.max(buys.length, 1);
    const walletDiversityScore = Math.min(10, diversityRatio * 10);

    // Buy cluster detection — buys within 10s of each other
    let clusterCount = 0;
    for (let i = 1; i < buys.length; i++) {
      if (buys[i].timestamp.getTime() - buys[i - 1].timestamp.getTime() < 10_000) {
        clusterCount++;
      }
    }

    // Volume slope — compare first half vs second half
    const mid = cutoff + windowMs / 2;
    const firstHalf = buys.filter((s) => s.timestamp.getTime() < mid);
    const secondHalf = buys.filter((s) => s.timestamp.getTime() >= mid);
    const firstVol = firstHalf.reduce((s, b) => s + b.amountSOL, 0);
    const secondVol = secondHalf.reduce((s, b) => s + b.amountSOL, 0);
    const volumeSpikeSlope = firstVol > 0 ? (secondVol - firstVol) / firstVol : 0;

    // Impulse exhaustion — buy size trend
    const buySizes = buys.map((b) => b.amountSOL);
    const avgBuySize =
      buySizes.reduce((a, b) => a + b, 0) / (buySizes.length || 1);
    const recentAvgBuy =
      buySizes.slice(-5).reduce((a, b) => a + b, 0) /
      Math.min(5, buySizes.length || 1);
    const buySizeDecelerating = recentAvgBuy < avgBuySize * 0.7;
    const exhaustionScore = buySizeDecelerating
      ? 7
      : volumeSpikeSlope < -0.3
        ? 5
        : 2;

    // Smart money flow
    const smartBuys = buys.filter((s) => s.isSmartWallet);
    const smartSells = sells.filter((s) => s.isSmartWallet);
    const smartNetFlow =
      smartBuys.reduce((s, b) => s + b.amountSOL, 0) -
      smartSells.reduce((s, b) => s + b.amountSOL, 0);

    return {
      tokenCA,
      windowMs,
      buyClusterCount: clusterCount,
      buyClusterFrequency: clusterCount / (windowMs / 60000),
      uniqueBuyers: uniqueBuyerSet.size,
      uniqueSellers: uniqueSellerSet.size,
      walletDiversityScore,
      liquidityGrowthSlope: 0,
      volumeSpikeSlope,
      volumeAccelerating: volumeSpikeSlope > 0.2,
      impulseExhaustionScore: exhaustionScore,
      buyToSellRatio: buys.length / Math.max(sells.length, 1),
      averageBuySizeSOL: avgBuySize,
      buySizeDecelerating,
      smartWalletBuyCount: smartBuys.length,
      smartWalletSellCount: smartSells.length,
      smartMoneyNetFlow: smartNetFlow,
      capturedAt: new Date(),
    };
  }
}
