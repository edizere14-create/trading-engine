import bs58 from 'bs58';
import { isValidPoolAddress } from '../src/core/poolAddress';

describe('isValidPoolAddress', () => {
  it('accepts a 32-byte public key', () => {
    expect(isValidPoolAddress('So11111111111111111111111111111111111111112')).toBe(true);
    expect(isValidPoolAddress('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')).toBe(true);
  });

  it('rejects a transaction signature (64 bytes)', () => {
    const signature = bs58.encode(new Uint8Array(64).fill(7));
    expect(signature.length).toBeGreaterThan(80);
    expect(isValidPoolAddress(signature)).toBe(false);
  });

  it('rejects values that decode to the wrong length', () => {
    expect(isValidPoolAddress(bs58.encode(new Uint8Array(31).fill(3)))).toBe(false);
    expect(isValidPoolAddress(bs58.encode(new Uint8Array(33).fill(3)))).toBe(false);
  });

  it('rejects empty, missing and non-base58 values', () => {
    expect(isValidPoolAddress('')).toBe(false);
    expect(isValidPoolAddress(undefined)).toBe(false);
    expect(isValidPoolAddress(null)).toBe(false);
    expect(isValidPoolAddress('not a base58 string!!')).toBe(false);
  });
});
