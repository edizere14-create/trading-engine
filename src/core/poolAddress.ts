import { PublicKey } from '@solana/web3.js';

/**
 * True only for a real pool address: a base58 string that decodes to exactly
 * 32 bytes (a Solana public key).
 *
 * Exists because "a pool is known" checks must not be satisfied by a
 * placeholder. The LP stream used to carry the creation transaction's
 * signature (64 bytes, ~88 characters) in this field, which satisfied the
 * trade gate for tokens that had no pool address at all.
 */
export function isValidPoolAddress(addr: string | undefined | null): addr is string {
  if (!addr) return false;
  try {
    return new PublicKey(addr).toBytes().length === 32;
  } catch {
    return false;
  }
}
