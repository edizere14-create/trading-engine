import { Connection, AccountInfo, PublicKey } from '@solana/web3.js';
import { unpackAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';
import { isWsOpen } from './wsControl';
import { deriveWsolVault } from './wsolVault';

// Wrapped SOL mint. Defined locally to match the codebase's per-module
// convention (WRAPPED_SOL / SOL_MINT are defined independently across
// ingestion/execution modules rather than centralized).
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

interface VaultSubscription {
  poolAddress: string;
  tokenCA: string;
  vaultAddress: string;
  subId: number;
  lastAmount: bigint | null; // null until the first callback establishes a baseline
}

/**
 * Watches a PumpSwap pool's wSOL vault (pool_quote_token_account) for a
 * single-transaction balance drop of >40% — the RUG_TRIGGER signal. On
 * detection, emits 'vault:drained'; the index.ts handler then force-closes
 * the position as RUG_TRIGGER.
 *
 * Subscription: onAccountChange on the derived vault address. Each callback
 * delivers the vault's post-write balance, so comparing consecutive callbacks
 * detects a single-transaction drop.
 *
 * wSOL-quote guard: the vault address is derived assuming a wSOL quote. On the
 * first account callback the actual SPL-token mint is checked via unpackAccount;
 * if it is not wSOL (e.g. a BONK-quote pool), the subscription is dropped — a
 * non-wSOL-quote pool has no wSOL vault to watch, and the derived address would
 * not be its real quote vault.
 */
export class PoolVaultStream {
  private connection: Connection;
  private subscriptions: Map<string, VaultSubscription> = new Map(); // tokenCA -> sub
  private vaultToToken: Map<string, string> = new Map(); // vaultAddress -> tokenCA
  private isStopped = false;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Subscribe to a pool's wSOL vault for rug detection. Call when a position
   * is opened. Safe to call only for wSOL-quote pools; the first-callback mint
   * guard drops the subscription if the pool turns out not to be wSOL-quote.
   */
  subscribe(poolAddress: string, tokenCA: string): void {
    if (this.subscriptions.has(tokenCA)) {
      logger.debug('[PoolVaultStream] Already subscribed', { tokenCA, poolAddress });
      return;
    }
    try {
      const vault = deriveWsolVault(poolAddress);
      const vaultAddress = vault.toBase58();
      const subId = this.connection.onAccountChange(
        vault,
        (accountInfo) => this.onVaultChange(tokenCA, vault, accountInfo),
        'confirmed',
      );
      this.subscriptions.set(tokenCA, {
        poolAddress,
        tokenCA,
        vaultAddress,
        subId,
        lastAmount: null,
      });
      this.vaultToToken.set(vaultAddress, tokenCA);
      logger.info('[PoolVaultStream] Subscribed to wSOL vault', {
        tokenCA,
        poolAddress,
        vaultAddress,
      });
    } catch (err) {
      logger.error('[PoolVaultStream] Failed to subscribe', {
        tokenCA,
        poolAddress,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private onVaultChange(
    tokenCA: string,
    vault: PublicKey,
    accountInfo: AccountInfo<Buffer>,
  ): void {
    if (this.isStopped) return;

    const sub = this.subscriptions.get(tokenCA);
    if (!sub) return;

    let amount: bigint;
    let mint: PublicKey;
    try {
      const acct = unpackAccount(vault, accountInfo, TOKEN_PROGRAM_ID);
      amount = acct.amount;
      mint = acct.mint;
    } catch (err) {
      logger.warn('[PoolVaultStream] Failed to unpack vault account', {
        tokenCA,
        vaultAddress: sub.vaultAddress,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // wSOL-quote guard: if this is not a wSOL vault, stop watching it.
    if (!mint.equals(WSOL_MINT)) {
      logger.info('[PoolVaultStream] Vault mint is not wSOL — unsubscribing', {
        tokenCA,
        vaultAddress: sub.vaultAddress,
        mint: mint.toBase58(),
      });
      this.unsubscribe(tokenCA);
      return;
    }

    // First callback establishes the baseline; no prior balance to compare.
    if (sub.lastAmount === null) {
      sub.lastAmount = amount;
      return;
    }

    // >40% single-step drop: new balance < 60% of last. Bigint math, no float.
    if (sub.lastAmount > 0n && amount * 100n < sub.lastAmount * 60n) {
      const dropPct = Number((sub.lastAmount - amount) * 10000n / sub.lastAmount) / 100;
      logger.warn('[PoolVaultStream] Vault drain detected — RUG_TRIGGER', {
        tokenCA,
        vaultAddress: sub.vaultAddress,
        lastAmount: sub.lastAmount.toString(),
        amount: amount.toString(),
        dropPct: dropPct.toFixed(1),
      });
      bus.emit('vault:drained', { tokenCA, dropPct, exitPriceSOL: undefined });
    }

    sub.lastAmount = amount;
  }

  /**
   * Unsubscribe from a pool's wSOL vault. Call when a position is closed.
   */
  unsubscribe(tokenCA: string): void {
    const sub = this.subscriptions.get(tokenCA);
    if (!sub) return;

    try {
      if (isWsOpen(this.connection)) {
        this.connection.removeAccountChangeListener(sub.subId);
      }
    } catch {
      // Socket may be closing — safe to ignore
    }

    this.subscriptions.delete(tokenCA);
    this.vaultToToken.delete(sub.vaultAddress);
    logger.info('[PoolVaultStream] Unsubscribed from wSOL vault', {
      tokenCA,
      vaultAddress: sub.vaultAddress,
    });
  }

  isTracking(tokenCA: string): boolean {
    return this.subscriptions.has(tokenCA);
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    for (const [tokenCA] of this.subscriptions) {
      this.unsubscribe(tokenCA);
    }
    logger.info('[PoolVaultStream] Stopped');
  }
}
