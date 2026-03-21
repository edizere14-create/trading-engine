import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { bus } from '../core/eventBus';
import { NewPoolEvent } from '../core/types';
import { logger } from '../core/logger';

export const POOL_PROGRAMS = {
  RAYDIUM_AMM_V4: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  METEORA_DLMM:   new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
  ORCA_WHIRLPOOL: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
} as const;

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const USDC_MINT   = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export class LPCreationStream {
  private connection: Connection;
  private subscriptions: number[] = [];

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async start(): Promise<void> {
    for (const [name, programId] of Object.entries(POOL_PROGRAMS)) {
      const subId = this.connection.onLogs(
        programId,
        (logs: Logs, ctx: Context) => this.handleLogs(logs, ctx, name),
        'confirmed'
      );
      this.subscriptions.push(subId);
      logger.info('LP stream started', { program: name, programId: programId.toBase58() });
    }
  }

  private async handleLogs(logs: Logs, ctx: Context, programName: string): Promise<void> {
    const isNewPool =
      logs.logs.some((l) => l.includes('initialize2')) ||
      logs.logs.some((l) => l.includes('InitializeLbPair'));

    if (!isNewPool || logs.err) return;

    try {
      const event = await this.parsePoolCreation(logs.signature, ctx.slot, programName);
      if (event) {
        bus.emit('pool:created', event);
        logger.info('New pool detected', {
          tokenCA: event.tokenCA,
          liqSOL: event.initialLiquiditySOL,
          deployer: event.deployer,
          program: programName,
          slot: ctx.slot,
        });
      }
    } catch (err) {
      logger.warn('Pool parse failed', {
        sig: logs.signature,
        program: programName,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async parsePoolCreation(
    signature: string,
    slot: number,
    programName: string
  ): Promise<NewPoolEvent | null> {
    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx?.meta || !tx.transaction) return null;

    // Extract token CA: the non-SOL/non-USDC mint in the pool
    const mints =
      tx.meta.postTokenBalances
        ?.map((b) => b.mint)
        .filter((m) => m !== WRAPPED_SOL && m !== USDC_MINT) ?? [];

    if (mints.length === 0) return null;

    // Deduplicate mints
    const uniqueMints = [...new Set(mints)];
    const tokenCA = uniqueMints[0];

    const deployer = tx.transaction.message.accountKeys[0].pubkey.toBase58();

    // Estimate initial SOL liquidity from SOL balance change
    const preBalance = tx.meta.preBalances[0];
    const postBalance = tx.meta.postBalances[0];
    const solChange = Math.abs((postBalance - preBalance) / 1e9);

    return {
      poolAddress: signature, // refined later with account parsing
      tokenCA,
      baseToken: 'SOL',
      initialLiquiditySOL: solChange,
      deployer,
      signature,
      slot,
      detectedAt: new Date(),
      source: 'RPC_LOGS',
    };
  }

  async stop(): Promise<void> {
    for (const subId of this.subscriptions) {
      await this.connection.removeOnLogsListener(subId);
    }
    this.subscriptions = [];
    logger.info('LP stream stopped');
  }
}
