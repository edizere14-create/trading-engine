import { Connection, PublicKey } from '@solana/web3.js';
import { TokenSafetyResult } from '../core/types';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';

// Cache results to avoid duplicate RPC calls
const CACHE_TTL_MS = 300_000; // 5 minutes
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_ACCOUNT_SIZE = 165;

function readU32LE(data: Buffer, offset: number): number {
  return data.readUInt32LE(offset);
}

function readU64LE(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

export class TokenSafetyChecker {
  private connections: Connection[];
  private cache: Map<string, { result: TokenSafetyResult; cachedAt: number }> = new Map();

  constructor(connection: Connection, backupConnection?: Connection) {
    this.connections = backupConnection && backupConnection !== connection
      ? [backupConnection, connection]
      : [connection];

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

    for (let attempt = 0; attempt < this.connections.length; attempt++) {
      const connection = this.connections[attempt];
      try {
        const result = await this.performChecks(connection, tokenCA);
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

    // All retries exhausted — fail CLOSED
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
    const lpLocked = false;
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

    const isSafe = rugScore <= 5 && !isHoneypot;

    return {
      tokenCA,
      isSafe,
      reasons,
      rugScore: Math.min(10, rugScore),
      topHolderPct,
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
    if (!Buffer.isBuffer(data) || data.length < 82) {
      return { mintAuthRevoked: true, freezeAuthRevoked: true, totalSupply: 0n };
    }

    return {
      mintAuthRevoked: readU32LE(data, 0) === 0,
      freezeAuthRevoked: readU32LE(data, 46) === 0,
      totalSupply: readU64LE(data, 36),
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
}
