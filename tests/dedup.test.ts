/**
 * Dedup layer tests for MigrationAccountStream.
 *
 * Tests the signature (5s TTL) and tokenCA (60s TTL) dedup maps via
 * white-box access to the private methods.
 */

import { MigrationAccountStream } from '../src/ingestion/migrationAccountStream';
import { Connection } from '@solana/web3.js';

// Minimal Connection stub — we don't subscribe in these tests
function makeConn(): Connection {
  return {
    onLogs: jest.fn().mockReturnValue(1),
    removeOnLogsListener: jest.fn().mockResolvedValue(undefined),
    getSlot: jest.fn().mockResolvedValue(100),
  } as unknown as Connection;
}

// Access private methods via type cast
type StreamAny = {
  isDuplicateSignature(sig: string): boolean;
  isDuplicateToken(tokenCA: string): boolean;
  signatureSeen: Map<string, number>;
  tokenSeen: Map<string, number>;
};

const SIG_DEDUP_TTL_MS   = 5_000;
const TOKEN_DEDUP_TTL_MS = 60_000;

describe('MigrationAccountStream — dedup', () => {
  let stream: StreamAny;

  beforeEach(() => {
    const raw = new MigrationAccountStream(makeConn());
    stream = raw as unknown as StreamAny;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Signature dedup ────────────────────────────────────────────────────────

  describe('isDuplicateSignature', () => {
    it('returns false on first call — not a duplicate', () => {
      expect(stream.isDuplicateSignature('sig-aaa')).toBe(false);
    });

    it('returns true on second call within TTL — duplicate', () => {
      stream.isDuplicateSignature('sig-bbb');
      expect(stream.isDuplicateSignature('sig-bbb')).toBe(true);
    });

    it('returns false after TTL expires — no longer duplicate', () => {
      stream.isDuplicateSignature('sig-ccc');
      jest.advanceTimersByTime(SIG_DEDUP_TTL_MS + 1);
      expect(stream.isDuplicateSignature('sig-ccc')).toBe(false);
    });

    it('different signatures are independent — both return false on first call', () => {
      expect(stream.isDuplicateSignature('sig-x')).toBe(false);
      expect(stream.isDuplicateSignature('sig-y')).toBe(false);
    });

    it('map does not retain expired entries past the next call', () => {
      // Insert N entries
      for (let i = 0; i < 50; i++) stream.isDuplicateSignature(`old-sig-${i}`);
      expect(stream.signatureSeen.size).toBe(50);

      // Expire all
      jest.advanceTimersByTime(SIG_DEDUP_TTL_MS + 1);

      // Trigger lazy eviction via a new call
      stream.isDuplicateSignature('trigger');

      // All old entries evicted, only 'trigger' remains
      expect(stream.signatureSeen.size).toBe(1);
    });
  });

  // ── Token dedup ─────────────────────────────────────────────────────────────

  describe('isDuplicateToken', () => {
    it('returns false on first call — not a duplicate', () => {
      expect(stream.isDuplicateToken('TokenAAAAAA')).toBe(false);
    });

    it('returns true on second call within TTL — duplicate', () => {
      stream.isDuplicateToken('TokenBBBBBB');
      expect(stream.isDuplicateToken('TokenBBBBBB')).toBe(true);
    });

    it('returns false after TOKEN_DEDUP_TTL_MS — no longer duplicate', () => {
      stream.isDuplicateToken('TokenCCCCCC');
      jest.advanceTimersByTime(TOKEN_DEDUP_TTL_MS + 1);
      expect(stream.isDuplicateToken('TokenCCCCCC')).toBe(false);
    });

    it('sig dedup TTL expiry does not expire token dedup', () => {
      stream.isDuplicateToken('TokenDDDDDD');
      // Advance past sig TTL but not token TTL
      jest.advanceTimersByTime(SIG_DEDUP_TTL_MS + 1);
      expect(stream.isDuplicateToken('TokenDDDDDD')).toBe(true);
    });

    it('map does not retain expired entries past the next call', () => {
      for (let i = 0; i < 50; i++) stream.isDuplicateToken(`OldToken${i}`);
      expect(stream.tokenSeen.size).toBe(50);

      jest.advanceTimersByTime(TOKEN_DEDUP_TTL_MS + 1);
      stream.isDuplicateToken('trigger');

      expect(stream.tokenSeen.size).toBe(1);
    });
  });

  // ── Cross-dedup independence ─────────────────────────────────────────────────

  it('sig dedup and token dedup are independent maps', () => {
    const id = 'same-string-used-as-both';
    // First sig call → not dup
    expect(stream.isDuplicateSignature(id)).toBe(false);
    // First token call with same string → still not dup (different map)
    expect(stream.isDuplicateToken(id)).toBe(false);

    // Both maps now contain the entry
    expect(stream.signatureSeen.has(id)).toBe(true);
    expect(stream.tokenSeen.has(id)).toBe(true);
  });
});
