import { Connection, PublicKey } from '@solana/web3.js';
import { TokenSafetyResult } from '../core/types';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';

// Cache results to avoid duplicate RPC calls
const CACHE_TTL_MS = 300_000; // 5 minutes

export class TokenSafetyChecker {
  private connection: Connection;
  private cache: Map<string, { result: TokenSafetyResult; cachedAt: number }> = new Map();

  constructor(connection: Connection) {
    this.connection = connection;

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

    const reasons: string[] = [];
    let rugScore = 0;
    let topHolderPct = 0;
    let lpLocked = false;
    let mintAuthRevoked = false;
    let freezeAuthRevoked = false;
    let isHoneypot = false;

    try {
      // 1. Check mint authority — revoked is safe
      const mintInfo = await this.getMintInfo(tokenCA);
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
      topHolderPct = await this.getTopHolderConcentration(tokenCA);
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
      // If safety checks fail, allow trade but note it
      logger.warn('Token safety check failed — proceeding with caution', {
        tokenCA,
        error: err instanceof Error ? err.message : String(err),
      });
      reasons.push('SAFETY_CHECK_FAILED — RPC error');
      rugScore += 1;
    }

    // Determine overall safety
    const isSafe = rugScore <= 5 && !isHoneypot;

    const result: TokenSafetyResult = {
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

    // Cache result
    this.cache.set(tokenCA, { result, cachedAt: Date.now() });

    bus.emit('safety:checked', result);

    if (!isSafe) {
      bus.emit('safety:blocked', { tokenCA, reasons });
      logger.warn('Token BLOCKED by safety check', {
        tokenCA,
        rugScore,
        reasons,
      });
    } else {
      logger.info('Token passed safety check', {
        tokenCA,
        rugScore,
        mintAuthRevoked,
        freezeAuthRevoked,
        topHolderPct: (topHolderPct * 100).toFixed(1) + '%',
      });
    }

    return result;
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

  private async getMintInfo(tokenCA: string): Promise<{
    mintAuthRevoked: boolean;
    freezeAuthRevoked: boolean;
  }> {
    const mintPubkey = new PublicKey(tokenCA);
    const accountInfo = await this.connection.getParsedAccountInfo(mintPubkey);

    if (!accountInfo.value) {
      return { mintAuthRevoked: true, freezeAuthRevoked: true };
    }

    const data = accountInfo.value.data;
    if (!('parsed' in data)) {
      return { mintAuthRevoked: true, freezeAuthRevoked: true };
    }

    const info = data.parsed?.info;
    return {
      mintAuthRevoked: info?.mintAuthority === null || info?.mintAuthority === undefined,
      freezeAuthRevoked: info?.freezeAuthority === null || info?.freezeAuthority === undefined,
    };
  }

  private async getTopHolderConcentration(tokenCA: string): Promise<number> {
    try {
      const mintPubkey = new PublicKey(tokenCA);
      const largestAccounts = await this.connection.getTokenLargestAccounts(mintPubkey);

      if (!largestAccounts.value || largestAccounts.value.length === 0) return 0;

      // Get total supply
      const supply = await this.connection.getTokenSupply(mintPubkey);
      const totalSupply = Number(supply.value.amount);
      if (totalSupply === 0) return 0;

      // Sum top 5 holders
      const top5 = largestAccounts.value.slice(0, 5);
      const top5Total = top5.reduce((sum, acct) => sum + Number(acct.amount), 0);

      return top5Total / totalSupply;
    } catch {
      return 0; // fail open — can't determine concentration
    }
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
