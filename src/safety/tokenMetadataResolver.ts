import { logger } from '../core/logger';

export type HeliusClient = {
  getAsset: (args: { id: string }) => Promise<{
    content?: { metadata: { name: string } };
  }>;
};

interface CachedName {
  name: string | null;  // null = resolved, no metadata exists
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;  // 1 hour
const CACHE_MAX_ENTRIES = 5000;
const RESOLVE_TIMEOUT_MS = 2000;

/**
 * Resolves token display names from on-chain metadata via Helius DAS.
 *
 * Three return states for resolveName():
 *   - string:    metadata resolved, name available
 *   - null:      metadata account doesn't exist (legit for some pump.fun launches)
 *   - undefined: resolution failed (timeout, Helius error)
 *
 * The Phase A scammyName check auto-passes on undefined/null/empty
 * (see scammyName.ts:28). We preserve the null/undefined distinction
 * for observability — operationally these are different events:
 *   - null  → "token has no metadata" (expected for some launches)
 *   - undefined → "we couldn't determine" (Helius issue, retry-worthy)
 *
 * Cached for 1h: names don't change after deployment. TTL is defensive,
 * not optimization-critical. Cache is bounded to 5k entries (oldest-first
 * eviction via Map insertion order semantics). Failures are NOT cached —
 * each retry gets a fresh attempt, which is the right behavior during
 * sustained Helius outages.
 */
export class TokenMetadataResolver {
  private cache: Map<string, CachedName> = new Map();

  constructor(private helius: HeliusClient) {}

  async resolveName(mint: string): Promise<string | null | undefined> {
    const cached = this.cache.get(mint);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.name;
    }

    try {
      const result = await Promise.race([
        this.helius.getAsset({ id: mint }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('resolve timeout')), RESOLVE_TIMEOUT_MS)
        ),
      ]);

      const name = result?.content?.metadata.name ?? null;
      this.cacheSet(mint, name);
      return name;
    } catch (err) {
      logger.warn('TokenMetadataResolver failed', {
        mint,
        err: err instanceof Error ? err.message : String(err),
      });
      return undefined;  // failure != "no name", retry-worthy
    }
  }

  private cacheSet(mint: string, name: string | null): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(mint, { name, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

/**
 * Factory for constructing a TokenMetadataResolver with a live Helius client.
 *
 * Uses CommonJS require() to load helius-sdk because the package uses a
 * modern exports map that TypeScript's classic moduleResolution ("node")
 * cannot read (verified: import { createHelius } from 'helius-sdk' fails
 * with TS2307 under the current tsconfig). The require call works at
 * runtime via Node's CJS resolver, which reads exports maps correctly.
 *
 * Migrating tsconfig to moduleResolution:"bundler" would require switching
 * module emit to es2015+ (TS5095), which is a project-wide change. Until
 * that migration, this factory is the only place in src/ that touches
 * helius-sdk -- all other code consumes TokenMetadataResolver via this
 * factory or its instance methods.
 *
 * The structural HeliusClient type defined above captures exactly the
 * surface we depend on (getAsset only). The cast bridges between
 * createHelius's full SDK return type and our minimal contract.
 */
export function createTokenMetadataResolver(apiKey: string): TokenMetadataResolver {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHelius } = require('helius-sdk') as {
    createHelius: (opts: { apiKey: string }) => HeliusClient;
  };
  return new TokenMetadataResolver(createHelius({ apiKey }));
}
