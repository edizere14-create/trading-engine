/**
 * Unit tests for parsePoolCreation.
 *
 * Uses the real migration transaction fetched from Solana mainnet:
 *   31V8YGSQUtjGTFvd4C6axU4AU7ujPAZGZQUr95nxkWo2XPvqvPJAqgEeT1K42ERYM4NVERhUUio9QYo5AjpiqmVF
 * Saved to tests/fixtures/pumpswap-migration-31V8YGSQ.json.
 * No live RPC dependency — fully self-contained.
 */

import path from 'path';
import fs from 'fs';
import { VersionedTransactionResponse } from '@solana/web3.js';
import { parsePoolCreation, WRAPPED_SOL } from '../src/ingestion/migrationAccountStream';

// ── Fixture loader ─────────────────────────────────────────────────────────────

interface RawFixture {
  result: {
    slot: number;
    version: number;
    transaction: {
      message: {
        accountKeys: string[];
      };
    };
    meta: {
      err: unknown;
      fee: number;
      preBalances: number[];
      postBalances: number[];
      postTokenBalances: Array<{
        accountIndex: number;
        mint: string;
        owner: string;
        uiTokenAmount: { uiAmount: number | null; amount: string; decimals: number };
      }>;
    };
  };
}

/**
 * Transform the raw JSON-RPC fixture into a shape that matches
 * VersionedTransactionResponse as accessed by parsePoolCreation.
 *
 * parsePoolCreation accesses:
 *   tx.transaction.message.staticAccountKeys[n].toBase58()
 *   tx.meta.postTokenBalances[n].{mint, owner, uiTokenAmount.uiAmount}
 */
function fixtureToMock(raw: RawFixture): VersionedTransactionResponse {
  const { result } = raw;
  return {
    slot: result.slot,
    blockTime: null,
    version: result.version,
    transaction: {
      message: {
        staticAccountKeys: result.transaction.message.accountKeys.map((k) => ({
          toBase58: () => k,
        })),
      } as unknown,
    } as unknown,
    meta: {
      err: result.meta.err,
      fee: result.meta.fee,
      preBalances: result.meta.preBalances,
      postBalances: result.meta.postBalances,
      preTokenBalances: [],
      postTokenBalances: result.meta.postTokenBalances,
      innerInstructions: [],
      logMessages: [],
      rewards: [],
    } as unknown,
  } as unknown as VersionedTransactionResponse;
}

// ── Constants derived from real fixture ───────────────────────────────────────

const FIXTURE_SIG     = '31V8YGSQUtjGTFvd4C6axU4AU7ujPAZGZQUr95nxkWo2XPvqvPJAqgEeT1K42ERYM4NVERhUUio9QYo5AjpiqmVF';
const FIXTURE_SLOT    = 416647963;
const EXPECTED_TOKEN  = '6Aixvhgirbn8rHmAtFnwHNBqgxtenKDz8ycvHeQepump';
const EXPECTED_POOL   = '7ugTEN5mq5kGURByfXrK1AqTAJ76wQMauggskosVzEoK';
const EXPECTED_SIGNER = 'niggerd597QYedtvjQDVHZTCCGyJrwHNm2i49dkm5zS';
const EXPECTED_LIQ    = 98.956567797;

// ── Test setup ────────────────────────────────────────────────────────────────

let mockTx: VersionedTransactionResponse;

beforeAll(() => {
  const fixturePath = path.resolve(__dirname, 'fixtures', 'pumpswap-migration-31V8YGSQ.json');
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as RawFixture;
  mockTx = fixtureToMock(raw);
});

// ── Real-fixture tests ────────────────────────────────────────────────────────

describe('parsePoolCreation — real fixture (31V8YGSQ)', () => {
  it('returns a non-null result', () => {
    const result = parsePoolCreation(mockTx, FIXTURE_SIG, FIXTURE_SLOT);
    expect(result).not.toBeNull();
  });

  it('extracts the correct tokenCA', () => {
    const result = parsePoolCreation(mockTx, FIXTURE_SIG, FIXTURE_SLOT)!;
    expect(result.tokenCA).toBe(EXPECTED_TOKEN);
  });

  it('extracts the correct poolAddress (non-fee-payer owner with both vaults)', () => {
    const result = parsePoolCreation(mockTx, FIXTURE_SIG, FIXTURE_SLOT)!;
    expect(result.poolAddress).toBe(EXPECTED_POOL);
  });

  it('extracts deployer as fee-payer (migration signer, not original creator)', () => {
    const result = parsePoolCreation(mockTx, FIXTURE_SIG, FIXTURE_SLOT)!;
    expect(result.deployer).toBe(EXPECTED_SIGNER);
  });

  it('extracts initialLiquiditySOL from wSOL postTokenBalance (not fee-payer delta)', () => {
    const result = parsePoolCreation(mockTx, FIXTURE_SIG, FIXTURE_SLOT)!;
    expect(result.initialLiquiditySOL).toBeCloseTo(EXPECTED_LIQ, 4);
  });

  it('preserves signature and slot passthrough', () => {
    const result = parsePoolCreation(mockTx, FIXTURE_SIG, FIXTURE_SLOT)!;
    expect(result.signature).toBe(FIXTURE_SIG);
    expect(result.slot).toBe(FIXTURE_SLOT);
  });

  it('detectedAt is a recent timestamp (Date.now() at parse time)', () => {
    const before = Date.now();
    const result = parsePoolCreation(mockTx, FIXTURE_SIG, FIXTURE_SLOT)!;
    const after = Date.now();
    expect(result.detectedAt).toBeGreaterThanOrEqual(before);
    expect(result.detectedAt).toBeLessThanOrEqual(after);
  });
});

// ── Synthetic edge-case tests ─────────────────────────────────────────────────

describe('parsePoolCreation — edge cases', () => {
  const SIG  = 'synthetic-sig-001';
  const SLOT = 999_999;

  const FEE_PAYER = 'FeePayer11111111111111111111111111111111111';
  const POOL      = 'PoolAddress1111111111111111111111111111111';
  const TOKEN     = 'TokenMint1111111111111111111111111111111111';

  function makeTx(
    postTokenBalances: Array<{
      accountIndex: number;
      mint: string;
      owner?: string;
      uiTokenAmount: { uiAmount: number | null; amount: string; decimals: number };
    }>,
    accountKey0 = FEE_PAYER
  ): VersionedTransactionResponse {
    return {
      slot: SLOT,
      blockTime: null,
      version: 0,
      transaction: {
        message: {
          staticAccountKeys: [{ toBase58: () => accountKey0 }],
        } as unknown,
      } as unknown,
      meta: {
        err: null,
        fee: 5000,
        preBalances: [1_000_000_000],
        postBalances: [900_000_000],
        preTokenBalances: [],
        postTokenBalances,
        innerInstructions: [],
        logMessages: [],
        rewards: [],
      } as unknown,
    } as unknown as VersionedTransactionResponse;
  }

  it('returns null when postTokenBalances is empty (no mints at all)', () => {
    const tx = makeTx([]);
    expect(parsePoolCreation(tx, SIG, SLOT)).toBeNull();
  });

  it('returns null when there is no non-SOL mint', () => {
    const tx = makeTx([
      { accountIndex: 0, mint: WRAPPED_SOL, owner: POOL, uiTokenAmount: { uiAmount: 10, amount: '', decimals: 9 } },
    ]);
    expect(parsePoolCreation(tx, SIG, SLOT)).toBeNull();
  });

  it('returns null when there are multiple distinct non-SOL mints (ambiguous)', () => {
    const tx = makeTx([
      { accountIndex: 0, mint: 'TokenMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', owner: POOL, uiTokenAmount: { uiAmount: 1000, amount: '', decimals: 6 } },
      { accountIndex: 1, mint: 'TokenMintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', owner: POOL, uiTokenAmount: { uiAmount: 2000, amount: '', decimals: 6 } },
    ]);
    expect(parsePoolCreation(tx, SIG, SLOT)).toBeNull();
  });

  it('returns null when the only wSOL entry is owned by the fee-payer (no pool candidate)', () => {
    // fee-payer has both, but no other owner does
    const tx = makeTx([
      { accountIndex: 0, mint: TOKEN,       owner: FEE_PAYER, uiTokenAmount: { uiAmount: 1000, amount: '', decimals: 6 } },
      { accountIndex: 1, mint: WRAPPED_SOL, owner: FEE_PAYER, uiTokenAmount: { uiAmount: 50,   amount: '', decimals: 9 } },
    ]);
    expect(parsePoolCreation(tx, SIG, SLOT)).toBeNull();
  });

  it('returns null when the pool has a token vault but no wSOL vault', () => {
    const tx = makeTx([
      { accountIndex: 0, mint: TOKEN,       owner: FEE_PAYER, uiTokenAmount: { uiAmount: 100, amount: '', decimals: 6 } },
      { accountIndex: 1, mint: WRAPPED_SOL, owner: FEE_PAYER, uiTokenAmount: { uiAmount: 5,   amount: '', decimals: 9 } },
      { accountIndex: 2, mint: TOKEN,       owner: POOL,      uiTokenAmount: { uiAmount: 500, amount: '', decimals: 6 } },
      // No wSOL entry owned by POOL
    ]);
    expect(parsePoolCreation(tx, SIG, SLOT)).toBeNull();
  });

  it('correctly identifies pool when fee-payer also holds both vaults', () => {
    // The pool has MORE SOL than the fee-payer → tiebreaker selects pool
    const tx = makeTx([
      { accountIndex: 0, mint: TOKEN,       owner: FEE_PAYER, uiTokenAmount: { uiAmount: 100,  amount: '', decimals: 6 } },
      { accountIndex: 1, mint: WRAPPED_SOL, owner: FEE_PAYER, uiTokenAmount: { uiAmount: 5,    amount: '', decimals: 9 } },
      { accountIndex: 2, mint: TOKEN,       owner: POOL,      uiTokenAmount: { uiAmount: 5000, amount: '', decimals: 6 } },
      { accountIndex: 3, mint: WRAPPED_SOL, owner: POOL,      uiTokenAmount: { uiAmount: 99,   amount: '', decimals: 9 } },
    ]);
    const result = parsePoolCreation(tx, SIG, SLOT)!;
    expect(result).not.toBeNull();
    expect(result.poolAddress).toBe(POOL);
    expect(result.initialLiquiditySOL).toBeCloseTo(99, 4);
    expect(result.tokenCA).toBe(TOKEN);
    expect(result.deployer).toBe(FEE_PAYER);
  });

  it('returns null when tx.meta is null', () => {
    const tx = {
      slot: SLOT, blockTime: null, version: 0,
      transaction: { message: { staticAccountKeys: [{ toBase58: () => FEE_PAYER }] } as unknown } as unknown,
      meta: null,
    } as unknown as VersionedTransactionResponse;
    expect(parsePoolCreation(tx, SIG, SLOT)).toBeNull();
  });
});
