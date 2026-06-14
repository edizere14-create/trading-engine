import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Wrapped SOL mint. Defined locally to match the codebase's per-module
// convention (WRAPPED_SOL / SOL_MINT are defined independently in several
// ingestion/execution modules rather than centralized).
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * Derive the wSOL vault (the pool's pool_quote_token_account) for a PumpSwap
 * pool. The vault is the standard associated token account of
 * (owner = pool, mint = wSOL) under the SPL Token program.
 *
 * Confirmed against the pump_amm IDL: the migrate / create_pool instruction
 * derives pool_quote_token_account as exactly this ATA
 * (seeds [pool, token_program, wsol_mint] under the associated token program),
 * and the PumpSwap Pool account stores that same address. See
 * EXIT_SUBSYSTEM_MIGRATION.md (Commit 4.1 vault-address resolution note).
 *
 * Only valid for wSOL-quote pools. The caller (the RUG_TRIGGER watcher in
 * Commit 4.1b) must confirm the pool's quote_mint == wSOL before using this;
 * a non-wSOL-quote pool has no wSOL vault to watch.
 */
export function deriveWsolVault(poolAddress: string | PublicKey): PublicKey {
  const pool =
    typeof poolAddress === 'string' ? new PublicKey(poolAddress) : poolAddress;
  return getAssociatedTokenAddressSync(
    WSOL_MINT,
    pool,
    true, // allowOwnerOffCurve — the pool is a PDA (off-curve)
    TOKEN_PROGRAM_ID, // wSOL is classic SPL Token, not Token-2022
  );
}
