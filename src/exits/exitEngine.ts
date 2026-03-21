import { OpenPosition, ExitMode, ExitTier } from '../core/types';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';

export class ExitEngine {
  selectExitMode(
    position: OpenPosition,
    currentPriceLamports: bigint,
    volumeAccelerating: boolean,
    smartWalletsSelling: number,
    lpRemovalDetected: boolean
  ): ExitMode {
    // PANIC: emergency conditions — highest priority
    if (lpRemovalDetected) return 'PANIC';
    if (smartWalletsSelling >= 3) return 'PANIC';

    const currentMultiple = this.calculateCurrentMultiple(position, currentPriceLamports);
    if (currentMultiple < 0.7) return 'PANIC'; // hit stop

    // TIME_EXIT: edge has expired
    if (Date.now() > position.edgeExpiresAt.getTime()) return 'TIME_EXIT';

    // DRIP: low liquidity — manipulationRisk < 4 means dangerous liquidity
    if (position.trade.signal.manipulationRisk < 4) return 'DRIP';

    // HARVEST: volume accelerating = crowd arriving = sell into them
    if (volumeAccelerating && currentMultiple > 1.5) return 'HARVEST';

    return 'HARVEST'; // default
  }

  calculateCurrentMultiple(position: OpenPosition, currentPriceLamports: bigint): number {
    return Number(currentPriceLamports) / Number(position.trade.entryPriceLamports);
  }

  checkTiers(position: OpenPosition, currentPriceLamports: bigint): void {
    for (const tier of position.tiers) {
      if (tier.reached) continue;

      if (currentPriceLamports >= tier.priceLamports) {
        tier.reached = true;
        tier.reachedAt = new Date();

        bus.emit('exit:triggered', {
          tokenCA: position.trade.tokenCA,
          mode: 'HARVEST',
          reason: `TIER_${tier.multiple}x reached — exit ${(tier.pct * 100).toFixed(0)}%`,
        });

        logger.info('Exit tier reached', {
          tokenCA: position.trade.tokenCA,
          multiple: tier.multiple,
          pct: tier.pct,
          currentPrice: currentPriceLamports.toString(),
          tierPrice: tier.priceLamports.toString(),
        });
      }
    }
  }

  async dripExit(
    position: OpenPosition,
    intervalMs: number = 15000,
    chunkPct: number = 0.10
  ): Promise<void> {
    let remaining = position.remainingPct;
    let chunkNum = 0;
    const totalChunks = Math.ceil(remaining / chunkPct);

    logger.info('Drip exit started', {
      tokenCA: position.trade.tokenCA,
      remainingPct: remaining,
      chunkPct,
      intervalMs,
      totalChunks,
    });

    while (remaining > 0) {
      chunkNum++;
      const exitPct = Math.min(chunkPct, remaining);
      remaining -= exitPct;

      bus.emit('exit:triggered', {
        tokenCA: position.trade.tokenCA,
        mode: 'DRIP',
        reason: `DRIP chunk ${chunkNum}/${totalChunks} — ${(exitPct * 100).toFixed(0)}%`,
      });

      logger.info('Drip chunk emitted', {
        tokenCA: position.trade.tokenCA,
        chunk: chunkNum,
        exitPct: (exitPct * 100).toFixed(0),
        remaining: (remaining * 100).toFixed(0),
      });

      if (remaining > 0) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }

    logger.info('Drip exit complete', {
      tokenCA: position.trade.tokenCA,
      totalChunks: chunkNum,
    });
  }

  buildTiers(entryPriceLamports: bigint): ExitTier[] {
    return [
      {
        pct: 0.30,
        multiple: 2.0,
        priceLamports: entryPriceLamports * 2n,
        reached: false,
      },
      {
        pct: 0.30,
        multiple: 4.0,
        priceLamports: entryPriceLamports * 4n,
        reached: false,
      },
      {
        pct: 0.40,
        multiple: 10.0,
        priceLamports: entryPriceLamports * 10n,
        reached: false,
      },
    ];
  }
}
