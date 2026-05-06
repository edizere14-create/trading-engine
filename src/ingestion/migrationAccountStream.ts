import { Connection, PublicKey, Logs, Context, VersionedTransactionResponse } from '@solana/web3.js';
import { bus } from '../core/eventBus';
import { PumpSwapGraduationEvent } from '../core/types';
import { logger } from '../core/logger';
import { isWsOpen, enableWsReconnect, disableWsReconnect, getConnectionEndpoint, resetWsReconnectCount, supportsLogsSubscribe } from './wsControl';

const MIGRATION_ACCOUNT = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');
const PUMPSWAP_PROGRAM  = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const MIGRATE_LOG       = 'Program log: Instruction: Migrate';

const SIG_DEDUP_TTL_MS   = 5_000;
const TOKEN_DEDUP_TTL_MS = 60_000;

const HEALTH_CHECK_INTERVAL_MS  = 30_000;
const RECONNECT_BASE_DELAY_MS   = 2_000;
const RECONNECT_MAX_DELAY_MS    = 60_000;
const MAX_RECONNECT_ATTEMPTS    = 10;
const RECONNECT_COOLDOWN_MS     = 120_000;
const SILENCE_THRESHOLD_MS      = 30 * 60_000; // 30 min — graduations are infrequent

export class MigrationAccountStream {
  private primaryConnection: Connection;
  private backupConnection: Connection | null;
  private activeConnection: Connection;

  private subscriptionId: number | null = null;
  private subscriptionConnection: Connection | null = null;

  private signatureSeen = new Map<string, number>(); // sig → expiry timestamp
  private tokenSeen     = new Map<string, number>(); // tokenCA → expiry timestamp

  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private lastEventTime = Date.now();
  private reconnectAttempts = 0;
  private reconnectTotal    = 0;
  private isReconnecting    = false;
  private isStopped         = false;
  private reconnectCooldownUntil = 0;

  private wsHeartbeatOk   = 0;
  private wsHeartbeatFail = 0;
  private rpcRole: 'primary' | 'backup' = 'primary';
  private failoverCount   = 0;

  constructor(connection: Connection, backupConnection?: Connection) {
    this.primaryConnection = connection;
    this.backupConnection  = backupConnection ?? null;
    this.activeConnection  = connection;
  }

  async start(): Promise<void> {
    this.isStopped = false;

    const usable = await this.pickUsableConnection();
    if (usable) this.activeConnection = usable;

    this.rpcRole = this.activeConnection === this.primaryConnection ? 'primary' : 'backup';
    logger.info('MigrationAccountStream using RPC', {
      endpoint: getConnectionEndpoint(this.activeConnection),
      role: this.rpcRole,
      account: MIGRATION_ACCOUNT.toBase58(),
    });

    enableWsReconnect(this.activeConnection, 3);
    const inactive = this.activeConnection === this.primaryConnection
      ? this.backupConnection
      : this.primaryConnection;
    if (inactive) disableWsReconnect(inactive);

    await this.subscribe();
    this.startHealthCheck();
  }

  async stop(): Promise<void> {
    this.isStopped = true;
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    await this.clearSubscription();
  }

  // ── DEDUP ──────────────────────────────────────────────────────────────────

  private isDuplicateSignature(sig: string): boolean {
    const now = Date.now();
    // Lazy evict expired entries
    for (const [k, exp] of this.signatureSeen) {
      if (now > exp) this.signatureSeen.delete(k);
    }
    if (this.signatureSeen.has(sig)) return true;
    this.signatureSeen.set(sig, now + SIG_DEDUP_TTL_MS);
    return false;
  }

  private isDuplicateToken(tokenCA: string): boolean {
    const now = Date.now();
    for (const [k, exp] of this.tokenSeen) {
      if (now > exp) this.tokenSeen.delete(k);
    }
    if (this.tokenSeen.has(tokenCA)) return true;
    this.tokenSeen.set(tokenCA, now + TOKEN_DEDUP_TTL_MS);
    return false;
  }

  // ── SUBSCRIPTION ───────────────────────────────────────────────────────────

  private async subscribe(): Promise<void> {
    await this.clearSubscription();

    try {
      const subId = this.activeConnection.onLogs(
        MIGRATION_ACCOUNT,
        (logs: Logs, ctx: Context) => {
          this.lastEventTime    = Date.now();
          this.reconnectAttempts = 0;
          this.handleLogs(logs, ctx).catch((err) => {
            logger.warn('MigrationAccountStream handleLogs error', {
              sig: logs.signature,
              err: err instanceof Error ? err.message : String(err),
            });
          });
        },
        'confirmed'
      );
      this.subscriptionId         = subId;
      this.subscriptionConnection = this.activeConnection;
      logger.info('MigrationAccountStream subscribed', {
        account: MIGRATION_ACCOUNT.toBase58(),
        subId,
      });
    } catch (err) {
      logger.error('MigrationAccountStream subscription failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async clearSubscription(): Promise<void> {
    if (this.subscriptionId === null) return;
    const conn  = this.subscriptionConnection ?? this.activeConnection;
    const subId = this.subscriptionId;
    this.subscriptionId         = null;
    this.subscriptionConnection = null;
    try {
      if (isWsOpen(conn)) {
        await conn.removeOnLogsListener(subId);
      }
    } catch {
      // Socket may be CLOSING/CLOSED — safe to ignore
    }
  }

  // ── LOG HANDLER ────────────────────────────────────────────────────────────

  private async handleLogs(logs: Logs, ctx: Context): Promise<void> {
    if (this.isDuplicateSignature(logs.signature)) return;
    if (logs.err) return;
    if (!logs.logs.some((l) => l === MIGRATE_LOG)) return;

    let tx: VersionedTransactionResponse | null = null;
    try {
      tx = await this.activeConnection.getTransaction(logs.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
    } catch (err) {
      logger.warn('MigrationAccountStream getTransaction failed', {
        sig: logs.signature,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!tx) return;

    const parsed = parsePoolCreation(tx, logs.signature, ctx.slot);
    if (!parsed) return;

    if (this.isDuplicateToken(parsed.tokenCA)) return;

    bus.emit('pool:graduated', parsed);
    logger.info('PumpSwap graduation detected', {
      tokenCA:            parsed.tokenCA,
      poolAddress:        parsed.poolAddress,
      deployer:           parsed.deployer,
      initialLiquiditySOL: parsed.initialLiquiditySOL,
      slot:               parsed.slot,
    });
  }

  // ── HEALTH CHECK & RECONNECT ───────────────────────────────────────────────

  private startHealthCheck(): void {
    if (this.healthInterval) clearInterval(this.healthInterval);
    this.healthInterval = setInterval(async () => {
      if (this.isStopped || this.isReconnecting) return;
      if (Date.now() < this.reconnectCooldownUntil) return;

      const silentMs = Date.now() - this.lastEventTime;
      if (silentMs > SILENCE_THRESHOLD_MS) {
        this.wsHeartbeatFail++;
        logger.warn('MigrationAccountStream silent — reconnecting', {
          silentMinutes: Math.round(silentMs / 60_000),
          attempt: this.reconnectAttempts + 1,
          rpcRole: this.rpcRole,
        });
        await this.reconnect();
      } else {
        this.wsHeartbeatOk++;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private async reconnect(): Promise<void> {
    if (this.isStopped || this.isReconnecting) return;
    this.isReconnecting = true;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error('MigrationAccountStream max reconnect attempts reached — triggering HALT', {
        reconnectAttempts: this.reconnectAttempts,
      });
      bus.emit('system:halt', { reason: 'Migration stream WebSocket unrecoverable', resumeAt: undefined });
      this.isReconnecting = false;
      return;
    }

    this.reconnectAttempts++;
    this.reconnectTotal++;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS
    );

    logger.info('MigrationAccountStream reconnecting', {
      attempt: this.reconnectAttempts,
      delayMs: delay,
      budget: `${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
      rpcRole: this.rpcRole,
    });
    await new Promise((r) => setTimeout(r, delay));

    // Alternate primary/backup on each attempt
    if (this.backupConnection && this.reconnectAttempts % 2 === 1) {
      if (supportsLogsSubscribe(this.backupConnection)) {
        disableWsReconnect(this.activeConnection);
        this.activeConnection = this.backupConnection;
        this.rpcRole = 'backup';
        this.failoverCount++;
        enableWsReconnect(this.activeConnection, 3);
        logger.info('MigrationAccountStream failed over to backup RPC');
      }
    } else if (this.reconnectAttempts > 1) {
      disableWsReconnect(this.activeConnection);
      this.activeConnection = this.primaryConnection;
      this.rpcRole = 'primary';
      enableWsReconnect(this.activeConnection, 3);
      logger.info('MigrationAccountStream failed back to primary RPC');
    }

    try {
      await this.subscribe();

      const reachable = await Promise.race([
        this.activeConnection.getSlot().then(() => true, () => false),
        new Promise<false>((r) => setTimeout(() => r(false), 5_000)),
      ]);
      if (!reachable) {
        logger.warn('MigrationAccountStream reconnected but RPC still unreachable — will retry next cycle');
        this.reconnectCooldownUntil = Date.now() + RECONNECT_COOLDOWN_MS;
        return;
      }

      this.lastEventTime = Date.now();
      this.reconnectCooldownUntil = Date.now() + RECONNECT_COOLDOWN_MS;
      resetWsReconnectCount(this.activeConnection);
      logger.info('MigrationAccountStream reconnected successfully', {
        attempt: this.reconnectAttempts,
        rpcRole: this.rpcRole,
      });
    } catch (err) {
      logger.error('MigrationAccountStream reconnect failed', {
        attempt: this.reconnectAttempts,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isReconnecting = false;
    }
  }

  // ── TELEMETRY ──────────────────────────────────────────────────────────────

  public getTelemetry(): {
    reconnectAttempts: number;
    reconnectTotal: number;
    rpcRole: 'primary' | 'backup';
    failoverCount: number;
    wsHeartbeatOk: number;
    wsHeartbeatFail: number;
    sigDedupSize: number;
    tokenDedupSize: number;
  } {
    return {
      reconnectAttempts: this.reconnectAttempts,
      reconnectTotal:    this.reconnectTotal,
      rpcRole:           this.rpcRole,
      failoverCount:     this.failoverCount,
      wsHeartbeatOk:     this.wsHeartbeatOk,
      wsHeartbeatFail:   this.wsHeartbeatFail,
      sigDedupSize:      this.signatureSeen.size,
      tokenDedupSize:    this.tokenSeen.size,
    };
  }

  // ── USABLE CONNECTION PICKER ───────────────────────────────────────────────

  private async pickUsableConnection(): Promise<Connection | null> {
    const candidates = [this.primaryConnection, this.backupConnection].filter(Boolean) as Connection[];
    for (const conn of candidates) {
      if (!supportsLogsSubscribe(conn)) {
        logger.warn('MigrationAccountStream RPC skipped — logsSubscribe unsupported', {
          endpoint: getConnectionEndpoint(conn),
        });
        disableWsReconnect(conn);
        continue;
      }
      try {
        await conn.getSlot();
        return conn;
      } catch {
        logger.warn('MigrationAccountStream RPC unreachable at startup — trying next', {
          endpoint: getConnectionEndpoint(conn),
        });
        disableWsReconnect(conn);
      }
    }
    logger.warn('MigrationAccountStream all RPCs unreachable at startup — using primary as fallback');
    return null;
  }
}

// ── PARSE HELPER ────────────────────────────────────────────────────────────

export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const USDC_MINT           = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Parse a PumpSwap graduation (migration) transaction.
 *
 * Key design decisions (informed by round-1 findings + real-tx analysis of
 * 31V8YGSQUtjGTFvd4C6axU4AU7ujPAZGZQUr95nxkWo2XPvqvPJAqgEeT1K42ERYM4NVERhUUio9QYo5AjpiqmVF):
 *
 * tokenCA: the unique non-SOL mint in postTokenBalances. Zero or >1 → null.
 *
 * poolAddress: find the owner that holds BOTH a token vault (mint === tokenCA)
 *   AND a wSOL vault (mint === WRAPPED_SOL), excluding the fee-payer (who also
 *   holds both as the migration relayer). If multiple candidates remain, use
 *   the largest wSOL balance as tiebreaker and warn.
 *
 * initialLiquiditySOL: wSOL uiTokenAmount.uiAmount for the pool owner's vault.
 *   Round 1 used fee-payer SOL delta which is ~0 for Pump.fun migrations (the
 *   bonding curve funds the pool, not the fee-payer). postTokenBalances is canonical.
 *
 * deployer: accountKeys[0], the fee-payer / migration relayer. NOT the original
 *   token creator on Pump.fun. Field kept as `deployer` to match PumpSwapGraduationEvent.
 */
export function parsePoolCreation(
  tx: VersionedTransactionResponse,
  signature: string,
  slot: number
): PumpSwapGraduationEvent | null {
  if (!tx.meta || !tx.transaction) return null;

  // ── Static account keys (works for both legacy and versioned messages) ──
  const msg = tx.transaction.message;
  const accountKeys: { toBase58(): string }[] =
    'staticAccountKeys' in msg
      ? (msg as { staticAccountKeys: { toBase58(): string }[] }).staticAccountKeys
      : (msg as unknown as { accountKeys: { toBase58(): string }[] }).accountKeys;

  const postBalances = tx.meta.postTokenBalances ?? [];
  const feePayerAddress = accountKeys[0]?.toBase58() ?? '';

  // ── tokenCA: exactly one unique non-SOL/non-USDC mint ────────────────────
  const uniqueNonSolMints = [
    ...new Set(
      postBalances
        .map((b) => b.mint)
        .filter((m) => m !== WRAPPED_SOL && m !== USDC_MINT)
    ),
  ];

  if (uniqueNonSolMints.length === 0) {
    logger.warn('parsePoolCreation: no non-SOL mint in postTokenBalances', { signature });
    return null;
  }
  if (uniqueNonSolMints.length > 1) {
    logger.warn('parsePoolCreation: multiple non-SOL mints — ambiguous, skipping', {
      signature,
      mints: uniqueNonSolMints,
    });
    return null;
  }
  const tokenCA = uniqueNonSolMints[0];

  // ── Pool identification ───────────────────────────────────────────────────
  // The pool owns both a token vault and a wSOL vault.
  // The fee-payer (migration relayer) also holds both — exclude them.
  const tokenVaultOwners = new Set(
    postBalances
      .filter((b) => b.mint === tokenCA && b.owner)
      .map((b) => b.owner as string)
  );

  const wsolByOwner = new Map<string, number>();
  for (const b of postBalances) {
    if (b.mint === WRAPPED_SOL && b.owner) {
      wsolByOwner.set(b.owner, b.uiTokenAmount.uiAmount ?? 0);
    }
  }

  const poolCandidates = [...tokenVaultOwners].filter(
    (owner) => wsolByOwner.has(owner) && owner !== feePayerAddress
  );

  if (poolCandidates.length === 0) {
    logger.warn('parsePoolCreation: no pool candidate — no non-fee-payer owner with both vaults', { signature });
    return null;
  }
  if (poolCandidates.length > 1) {
    logger.warn('parsePoolCreation: multiple pool candidates — using largest wSOL balance as tiebreaker', {
      signature,
      candidates: poolCandidates,
    });
  }

  // Tiebreaker: largest wSOL balance
  const poolAddress = poolCandidates.reduce((best, c) =>
    (wsolByOwner.get(c) ?? 0) > (wsolByOwner.get(best) ?? 0) ? c : best
  );
  const initialLiquiditySOL = wsolByOwner.get(poolAddress) ?? 0;

  return {
    signature,
    slot,
    tokenCA,
    poolAddress,
    deployer: feePayerAddress || 'unknown',
    initialLiquiditySOL,
    detectedAt: Date.now(),
  };
}
