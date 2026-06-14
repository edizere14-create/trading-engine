import { PublicKey } from '@solana/web3.js';
import { deriveWsolVault } from '../src/ingestion/wsolVault';

describe('deriveWsolVault', () => {
  // Oracle: a real canonical (index 0) wSOL-quote PumpSwap pool, fetched via
  // Shyft's decoded pump_fun_amm_Pool table (pubkey -> pool_quote_token_account).
  // The derivation was verified to produce REAL_VAULT for this POOL against
  // on-chain data before this test was written; this test guards the result.
  const POOL = 'HEoY16En8NnfZXZ9qZDHH4B5XsKrL6wpXjScwHWFsr9X';
  const REAL_VAULT = 'B2XRLzwk3bAd4Gt6UD998PEzp6qJDBRGamKWkUJCTFGP';

  it('derives the real on-chain wSOL vault for a known pool (string input)', () => {
    expect(deriveWsolVault(POOL).toBase58()).toBe(REAL_VAULT);
  });

  it('accepts a PublicKey input and derives the same vault', () => {
    expect(deriveWsolVault(new PublicKey(POOL)).toBase58()).toBe(REAL_VAULT);
  });

  it('is deterministic', () => {
    expect(deriveWsolVault(POOL).toBase58()).toBe(deriveWsolVault(POOL).toBase58());
  });
});
