import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { bus } from '../core/eventBus';
import { SwapEvent, ClusterAlert } from '../core/types';
import { WalletRegistry } from '../registry/walletRegistry';
import { logger } from '../core/logger';

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const USDC_MINT   = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Known DEX program IDs for swap detection
const SWAP_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM V4
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   // Orca Whirlpool
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',   // Meteora DLMM
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',   // Jupiter v6
]);

interface ClusterEntry {
  wallet: string;
  timestamp: number;
  pnl30d: number;
}

class ClusterDetector {
  private buyMap: Map<string, ClusterEntry[]> = new Map();
  private readonly WINDOW_MS = 600_000; // 600 seconds
  private readonly MIN_WALLETS = 3;

  recordBuy(tokenCA: string, wallet: string, walletRegistry: WalletRegistry): void {
    const now = Date.now();
    const stats = walletRegistry.getWalletStats(wallet);
    const entry: ClusterEntry = {
      wallet,
      timestamp: now,
      pnl30d: stats?.pnl30d ?? 0,
    };

    const existing = this.buyMap.get(tokenCA) ?? [];
    existing.push(entry);

    // Prune expired entries
    const pruned = existing.filter((e) => now - e.timestamp < this.WINDOW_MS);
    this.buyMap.set(tokenCA, pruned);

    // Deduplicate wallets in window
    const uniqueWallets = new Set(pruned.map((e) => e.wallet));

    if (uniqueWallets.size >= this.MIN_WALLETS) {
      const totalWeightedPnL = pruned.reduce((sum, e) => sum + e.pnl30d, 0);
      const alert: ClusterAlert = {
        tokenCA,
        wallets: Array.from(uniqueWallets),
        totalWeightedPnL,
        windowSeconds: this.WINDOW_MS / 1000,
        triggeredAt: new Date(),
      };
      bus.emit('cluster:alert', alert);
      logger.info('Cluster alert triggered', {
        tokenCA,
        walletCount: uniqueWallets.size,
        totalWeightedPnL,
      });
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [tokenCA, entries] of this.buyMap) {
      const pruned = entries.filter((e) => now - e.timestamp < this.WINDOW_MS);
      if (pruned.length === 0) {
        this.buyMap.delete(tokenCA);
      } else {
        this.buyMap.set(tokenCA, pruned);
      }
    }
  }
}

export class SmartWalletStream {
  private connection: Connection;
  private walletRegistry: WalletRegistry;
  private subscriptions: number[] = [];
  private clusterDetector: ClusterDetector;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(connection: Connection, walletRegistry: WalletRegistry) {
    this.connection = connection;
    this.walletRegistry = walletRegistry;
    this.clusterDetector = new ClusterDetector();
  }

  async start(): Promise<void> {
    const wallets = this.walletRegistry.getAll();

    if (wallets.length === 0) {
      logger.warn('SmartWalletStream: no wallets to monitor');
      return;
    }

    for (const wallet of wallets) {
      const pubkey = new PublicKey(wallet.address);
      const subId = this.connection.onLogs(
        pubkey,
        (logs: Logs, ctx: Context) => this.handleLogs(logs, ctx, wallet.address),
        'confirmed'
      );
      this.subscriptions.push(subId);
    }

    // Periodic cleanup of stale cluster entries every 60s
    this.cleanupInterval = setInterval(() => this.clusterDetector.cleanup(), 60_000);

    logger.info('SmartWalletStream started', { walletCount: wallets.length });
  }

  private async handleLogs(logs: Logs, ctx: Context, walletAddress: string): Promise<void> {
    if (logs.err) return;

    // Check if this is a swap — look for known DEX program invocations
    const isSwap = logs.logs.some((l) => {
      for (const prog of SWAP_PROGRAMS) {
        if (l.includes(prog)) return true;
      }
      return false;
    });

    if (!isSwap) return;

    try {
      const event = await this.parseSwap(logs.signature, ctx.slot, walletAddress);
      if (event) {
        bus.emit('swap:detected', event);

        if (event.action === 'BUY') {
          this.clusterDetector.recordBuy(event.tokenCA, walletAddress, this.walletRegistry);
        }

        logger.info('Smart wallet swap detected', {
          wallet: walletAddress,
          tokenCA: event.tokenCA,
          action: event.action,
          amountSOL: event.amountSOL,
          slot: ctx.slot,
        });
      }
    } catch (err) {
      logger.warn('Swap parse failed', {
        sig: logs.signature,
        wallet: walletAddress,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async parseSwap(
    signature: string,
    slot: number,
    walletAddress: string
  ): Promise<SwapEvent | null> {
    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    if (!tx?.meta || !tx.transaction) return null;

    // Find the wallet's account index
    const accountKeys = tx.transaction.message.accountKeys;
    const walletIndex = accountKeys.findIndex(
      (k) => k.pubkey.toBase58() === walletAddress
    );
    if (walletIndex === -1) return null;

    // SOL balance change for this wallet
    const preSol = tx.meta.preBalances[walletIndex];
    const postSol = tx.meta.postBalances[walletIndex];
    const solDelta = (postSol - preSol) / 1e9;

    // Extract token mints involved (excluding SOL and USDC)
    const preTokens = tx.meta.preTokenBalances ?? [];
    const postTokens = tx.meta.postTokenBalances ?? [];

    // Find token balances belonging to this wallet
    const walletPostTokens = postTokens.filter(
      (b) => b.owner === walletAddress && b.mint !== WRAPPED_SOL && b.mint !== USDC_MINT
    );
    const walletPreTokens = preTokens.filter(
      (b) => b.owner === walletAddress && b.mint !== WRAPPED_SOL && b.mint !== USDC_MINT
    );

    if (walletPostTokens.length === 0 && walletPreTokens.length === 0) return null;

    // Determine the token CA and amount change
    const tokenMint = walletPostTokens[0]?.mint ?? walletPreTokens[0]?.mint;
    if (!tokenMint) return null;

    const preAmount = BigInt(
      walletPreTokens.find((b) => b.mint === tokenMint)?.uiTokenAmount.amount ?? '0'
    );
    const postAmount = BigInt(
      walletPostTokens.find((b) => b.mint === tokenMint)?.uiTokenAmount.amount ?? '0'
    );
    const tokenDelta = postAmount - preAmount;

    // BUY = SOL decreased, tokens increased
    // SELL = SOL increased, tokens decreased
    const action: 'BUY' | 'SELL' = tokenDelta > 0n ? 'BUY' : 'SELL';
    const amountSOL = Math.abs(solDelta);
    const amountTokens = tokenDelta < 0n ? -tokenDelta : tokenDelta;

    if (amountSOL === 0 || amountTokens === 0n) return null;

    const priceSOL = amountSOL / Number(amountTokens);

    return {
      tokenCA: tokenMint,
      wallet: walletAddress,
      action,
      amountSOL,
      amountTokens,
      priceSOL,
      slot,
      timestamp: new Date(),
      isSmartWallet: true,
    };
  }

  async stop(): Promise<void> {
    for (const subId of this.subscriptions) {
      await this.connection.removeOnLogsListener(subId);
    }
    this.subscriptions = [];

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    logger.info('SmartWalletStream stopped');
  }
}
