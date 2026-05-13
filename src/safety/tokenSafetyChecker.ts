import { Connection, PublicKey } from '@solana/web3.js';
import { MintLayout } from '@solana/spl-token';
import { TokenSafetyResult } from '../core/types';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';

// Cache results to avoid duplicate RPC calls
const CACHE_TTL_MS = 300_000; // 5 minutes
const SAFETY_TIMEOUT_MS = 3_000;
const SAFETY_MAX_ATTEMPTS = 2;
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_ACCOUNT_SIZE = 165;

function readU64LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

export class TokenSafetyChecker {
  private connections: Connection[];
  private cache: Map<string, { result: TokenSafetyResult; cachedAt: number }> = new Map();
  private paperMode: boolean;

  constructor(connection: Connection, backupConnection?: Connection, paperMode = false) {
    const ordered = backupConnection && backupConnection !== connection
      ? [connection, backupConnection]
      : [connection];
    this.connections = ordered.slice(0, SAFETY_MAX_ATTEMPTS);
    this.paperMode = paperMode;

    // Cleanup stale cache every 5 min
    setInterval(() => this.cleanupCache(), CACHE_TTL_MS);
  }

  /**
   * Perform safety checks on a token before entering.
   * Fast-path: skip if cached and recent.
   */
  async check(tokenCA: string): Promise<TokenSafetyResult> {
    // Check cache first
    const cached = this.cache.get(tokenCA);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.result;
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < Math.min(this.connections.length, SAFETY_MAX_ATTEMPTS); attempt++) {
      const connection = this.connections[attempt];
      try {
        const result = await this.withTimeout(
          this.performChecks(connection, tokenCA),
          SAFETY_TIMEOUT_MS,
          `Safety check timed out after ${SAFETY_TIMEOUT_MS}ms`
        );
        this.cache.set(tokenCA, { result, cachedAt: Date.now() });
        bus.emit('safety:checked', result);

        if (!result.isSafe) {
          bus.emit('safety:blocked', { tokenCA, reasons: result.reasons });
          logger.warn('Token BLOCKED by safety check', {
            tokenCA,
            rugScore: result.rugScore,
            reasons: result.reasons,
          });
        } else {
          logger.info('Token passed safety check', {
            tokenCA,
            rugScore: result.rugScore,
            mintAuthRevoked: result.mintAuthRevoked,
            freezeAuthRevoked: result.freezeAuthRevoked,
            topHolderPct: (result.topHolderPct * 100).toFixed(1) + '%',
          });
        }

        return result;
      } catch (err) {
        lastError = err;
        if (attempt < this.connections.length - 1) {
          const delay = 300 * (attempt + 1);
          logger.warn('[Safety] Check attempt failed — retrying', {
            tokenCA,
            attempt: attempt + 1,
            delayMs: delay,
            error: err instanceof Error ? err.message : String(err),
          });
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    // All retries exhausted — fail OPEN in paper mode (no real capital), fail CLOSED in live
    if (this.paperMode) {
      logger.warn('[Safety] All attempts failed — failing OPEN (paper mode, no real capital)', {
        tokenCA,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });

      const passResult: TokenSafetyResult = {
        tokenCA,
        isSafe: true,
        reasons: [],
        rugScore: 5,
        topHolderPct: 0,
        holderConcentrationOk: true,
        lpLocked: false,
        mintAuthRevoked: false,
        freezeAuthRevoked: false,
        isHoneypot: false,
        checkedAt: new Date(),
      };

      this.cache.set(tokenCA, { result: passResult, cachedAt: Date.now() - CACHE_TTL_MS + 30_000 });
      bus.emit('safety:checked', passResult);
      return passResult;
    }

    logger.error('[Safety] All attempts failed — failing closed (blocking token)', {
      tokenCA,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });

    const failedResult: TokenSafetyResult = {
      tokenCA,
      isSafe: false,
      reasons: ['SAFETY_CHECK_FAILED — RPC error, all retries exhausted'],
      rugScore: 10,
      topHolderPct: 0,
      holderConcentrationOk: false,
      lpLocked: false,
      mintAuthRevoked: false,
      freezeAuthRevoked: false,
      isHoneypot: false,
      checkedAt: new Date(),
    };

    // Cache the failure briefly (30s) so we don't hammer a dead RPC
    this.cache.set(tokenCA, { result: failedResult, cachedAt: Date.now() - CACHE_TTL_MS + 30_000 });
    bus.emit('safety:checked', failedResult);
    bus.emit('safety:blocked', { tokenCA, reasons: failedResult.reasons });

    return failedResult;
  }

  private async performChecks(connection: Connection, tokenCA: string): Promise<TokenSafetyResult> {
    const reasons: string[] = [];
    let rugScore = 0;
    let topHolderPct = 0;
    let topHolderCheckUnavailable = false;
    // PumpSwap migrations create pools where LP is held by the program account
    // itself, not transferable by users. For v2 (PumpSwap-only scope), all
    // graduated pools are locked-by-construction. Revisit if the engine ever
    // subscribes to additional DEX programs (Raydium, Meteora, Orca CPMM)
    // where LP locking varies per-pool.
    const lpLocked = true;
    let mintAuthRevoked = false;
    let freezeAuthRevoked = false;
    const isHoneypot = false;

    // 1. Check mint authority — revoked is safe
    const mintInfo = await this.getMintInfo(connection, tokenCA);
    mintAuthRevoked = mintInfo.mintAuthRevoked;
    freezeAuthRevoked = mintInfo.freezeAuthRevoked;

    if (!mintAuthRevoked) {
      reasons.push('MINT_AUTHORITY_ACTIVE — deployer can inflate supply');
      rugScore += 3;
    }
    if (!freezeAuthRevoked) {
      reasons.push('FREEZE_AUTHORITY_ACTIVE — deployer can freeze accounts');
      rugScore += 4;
    }

    // 2. Check top holder concentration
    try {
      topHolderPct = await this.getTopHolderConcentration(connection, tokenCA, mintInfo.totalSupply);
      if (topHolderPct > 0.50) {
        reasons.push(`TOP_HOLDER_CONCENTRATION ${(topHolderPct * 100).toFixed(0)}% — extreme`);
        rugScore += 3;
      } else if (topHolderPct > 0.30) {
        reasons.push(`TOP_HOLDER_CONCENTRATION ${(topHolderPct * 100).toFixed(0)}% — high`);
        rugScore += 2;
      } else if (topHolderPct > 0.20) {
        rugScore += 1;
      }
    } catch (err) {
      topHolderCheckUnavailable = true;
      logger.warn('[Safety] Top-holder concentration unavailable — continuing with partial safety check', {
        tokenCA,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const holderConcentrationOk = topHolderPct <= 0.30;
    const isSafe = rugScore <= 5 && !isHoneypot;

    if (topHolderCheckUnavailable) {
      reasons.push('TOP_HOLDER_CHECK_UNAVAILABLE — provider plan/rate limit prevented concentration scan');
    }

    return {
      tokenCA,
      isSafe,
      reasons,
      rugScore: Math.min(10, rugScore),
      topHolderPct,
      holderConcentrationOk,
      lpLocked,
      mintAuthRevoked,
      freezeAuthRevoked,
      isHoneypot,
      checkedAt: new Date(),
    };
  }

  /**
   * Quick check — returns cached result if available, null otherwise.
   */
  getCached(tokenCA: string): TokenSafetyResult | null {
    const cached = this.cache.get(tokenCA);
    if (!cached) return null;
    if (Date.now() - cached.cachedAt > CACHE_TTL_MS) return null;
    return cached.result;
  }

  private async getMintInfo(connection: Connection, tokenCA: string): Promise<{
    mintAuthRevoked: boolean;
    freezeAuthRevoked: boolean;
    totalSupply: bigint;
  }> {
    const mintPubkey = new PublicKey(tokenCA);
    const accountInfo = await connection.getAccountInfo(mintPubkey);

    if (!accountInfo) {
      return { mintAuthRevoked: true, freezeAuthRevoked: true, totalSupply: 0n };
    }

    const data = accountInfo.data;
    if (!Buffer.isBuffer(data) || data.length < MintLayout.span) {
      return { mintAuthRevoked: true, freezeAuthRevoked: true, totalSupply: 0n };
    }

    const mintData = MintLayout.decode(data);

    return {
      mintAuthRevoked: mintData.mintAuthorityOption === 0,
      freezeAuthRevoked: mintData.freezeAuthorityOption === 0,
      totalSupply: BigInt(mintData.supply.toString()),
    };
  }

  private async getTopHolderConcentration(connection: Connection, tokenCA: string, totalSupply: bigint): Promise<number> {
    const mintPubkey = new PublicKey(tokenCA);
    if (totalSupply === 0n) return 0;

    const tokenAccounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [
        { dataSize: TOKEN_ACCOUNT_SIZE },
        { memcmp: { offset: 0, bytes: mintPubkey.toBase58() } },
      ],
    });

    if (tokenAccounts.length === 0) return 0;

    const top5Total = tokenAccounts
      .map(({ account }) => {
        const data = account.data;
        if (!Buffer.isBuffer(data) || data.length < 72) return 0n;
        return readU64LE(data, 64);
      })
      .filter((amount) => amount > 0n)
      .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
      .slice(0, 5)
      .reduce((sum, amount) => sum + amount, 0n);

    return Number(top5Total) / Number(totalSupply);
  }

  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.cachedAt > CACHE_TTL_MS) {
        this.cache.delete(key);
      }
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}
