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

const HEALTH_CHECK_INTERVAL_MS = 30_000; // Check every 30s
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_COOLDOWN_MS = 120_000; // Suppress health-check reconnects for 120s after a reconnect

export class LPCreationStream {
  private primaryConnection: Connection;
  private backupConnection: Connection | null;
  private activeConnection: Connection;
  private subscriptions: number[] = [];
  private subscriptionConnection: Connection | null = null; // track which connection owns subscriptions
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private lastEventTime: number = Date.now();
  private reconnectAttempts = 0;
  private isReconnecting = false;
  private reconnectCooldownUntil = 0;
  private isStopped = false;

  constructor(connection: Connection, backupConnection?: Connection) {
    this.primaryConnection = connection;
    this.backupConnection = backupConnection ?? null;
    this.activeConnection = connection;
  }

  async start(): Promise<void> {
    this.isStopped = false;
    await this.subscribe();
    this.startHealthCheck();
  }

  private async subscribe(): Promise<void> {
    // Clear any existing subscriptions on the OLD connection before subscribing on the new one
    await this.clearSubscriptions();

    const entries = Object.entries(POOL_PROGRAMS);
    for (let i = 0; i < entries.length; i++) {
      const [name, programId] = entries[i];
      try {
        const subId = this.activeConnection.onLogs(
          programId,
          (logs: Logs, ctx: Context) => {
            this.lastEventTime = Date.now();
            this.reconnectAttempts = 0;
            this.handleLogs(logs, ctx, name).catch((err) => {
              logger.warn('LP handleLogs error', {
                program: name,
                err: err instanceof Error ? err.message : String(err),
              });
            });
          },
          'confirmed'
        );
        this.subscriptions.push(subId);
        logger.info('LP stream subscribed', { program: name, programId: programId.toBase58() });
        // Stagger subscriptions slightly to avoid burst
        if (i < entries.length - 1) await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        logger.error('LP subscription failed', {
          program: name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.subscriptionConnection = this.activeConnection;
  }

  private startHealthCheck(): void {
    if (this.healthInterval) clearInterval(this.healthInterval);

    this.healthInterval = setInterval(async () => {
      if (this.isStopped || this.isReconnecting) return;

      // Skip ALL health checks during cooldown after a recent reconnect
      if (Date.now() < this.reconnectCooldownUntil) return;

      const silentMs = Date.now() - this.lastEventTime;

      // If no events for 90s, subscriptions are likely dead
      if (silentMs > 90_000) {
        logger.warn('LP stream silent — reconnecting', {
          silentSeconds: Math.round(silentMs / 1000),
          attempt: this.reconnectAttempts + 1,
        });
        await this.reconnect();
        return;
      }

      // Also verify connection is healthy via a lightweight RPC call
      try {
        await this.activeConnection.getSlot();
      } catch {
        logger.warn('LP stream RPC unreachable — reconnecting');
        await this.reconnect();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private async reconnect(): Promise<void> {
    if (this.isStopped || this.isReconnecting) return;
    this.isReconnecting = true;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error('LP stream max reconnect attempts reached — triggering HALT');
      bus.emit('system:halt', { reason: 'LP stream WebSocket unrecoverable', resumeAt: undefined });
      this.isReconnecting = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS
    );

    logger.info('LP stream reconnecting', { attempt: this.reconnectAttempts, delayMs: delay });
    await new Promise((r) => setTimeout(r, delay));

    // Failover to backup immediately on first attempt, then alternate
    if (this.backupConnection && this.reconnectAttempts % 2 === 1) {
      logger.info('LP stream failing over to backup RPC');
      this.activeConnection = this.backupConnection;
    } else if (this.reconnectAttempts > 1) {
      logger.info('LP stream returning to primary RPC');
      this.activeConnection = this.primaryConnection;
    }
    // On attempt 1 with no backup, stays on primary

    try {
      await this.subscribe();
      // Do NOT reset reconnectAttempts here — only reset when real events arrive
      // in the onLogs callback. This keeps exponential backoff intact.

      // Verify the connection actually works before declaring success
      try {
        await this.activeConnection.getSlot();
      } catch {
        logger.warn('LP stream reconnected but RPC still unreachable — will retry next cycle');
        this.reconnectCooldownUntil = Date.now() + RECONNECT_COOLDOWN_MS;
        return;
      }

      this.lastEventTime = Date.now(); // Reset timer after reconnection
      this.reconnectCooldownUntil = Date.now() + RECONNECT_COOLDOWN_MS;
      logger.info('LP stream reconnected successfully', { attempt: this.reconnectAttempts });
    } catch (err) {
      logger.error('LP stream reconnect failed', {
        attempt: this.reconnectAttempts,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isReconnecting = false;
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
    const tx = await this.activeConnection.getParsedTransaction(signature, {
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

  private async clearSubscriptions(): Promise<void> {
    // Unsubscribe on the connection that owns the subscriptions, not necessarily activeConnection
    const conn = this.subscriptionConnection ?? this.activeConnection;
    for (const subId of this.subscriptions) {
      try {
        await conn.removeOnLogsListener(subId);
      } catch {
        // Subscription may already be dead — ignore
      }
    }
    this.subscriptions = [];
    this.subscriptionConnection = null;
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    await this.clearSubscriptions();
    logger.info('LP stream stopped');
  }
}
