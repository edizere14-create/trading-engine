/**
 * Unit tests for parsePoolCreation.
 *
 * Uses the real migration transaction fetched from Solana mainnet:
 *   31V8YGSQUtjGTFvd4C6axU4AU7ujPAZGZQUr95nxkWo2XPvqvPJAqgEeT1K42ERYM4NVERhUUio9QYo5AjpiqmVF
 * Saved to tests/fixtures/pumpswap-migration-31V8YGSQ.json.
 * No live RPC dependency — Connection.getParsedTransaction is mocked with the fixture.
 */

import path from 'path';
import fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
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
 * ParsedTransactionWithMeta as accessed by parsePoolCreation.
 *
 * parsePoolCreation accesses:
 *   tx.transaction.message.accountKeys[n].pubkey.toBase58()
 *   tx.meta.postTokenBalances[n].{mint, owner, uiTokenAmount.uiAmount}
 */
function fixtureToMock(raw: RawFixture): object {
  const { result } = raw;
  return {
    slot: result.slot,
    blockTime: null,
    version: result.version,
    transaction: {
      message: {
        accountKeys: result.transaction.message.accountKeys.map((k) => ({
          pubkey: { toBase58: () => k },
          signer: false,
          writable: false,
        })),
      },
    },
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
    },
  };
}

function makeConnection(parsedTx: object | null): Connection {
  return {
    getParsedTransaction: jest.fn().mockResolvedValue(parsedTx),
  } as unknown as Connection;
}

// ── Constants derived from real fixture ───────────────────────────────────────

const FIXTURE_SIG    = '31V8YGSQUtjGTFvd4C6axU4AU7ujPAZGZQUr95nxkWo2XPvqvPJAqgEeT1K42ERYM4NVERhUUio9QYo5AjpiqmVF';
const EXPECTED_TOKEN = '6Aixvhgirbn8rHmAtFnwHNBqgxtenKDz8ycvHeQepump';
const EXPECTED_POOL  = '7ugTEN5mq5kGURByfXrK1AqTAJ76wQMauggskosVzEoK';
const EXPECTED_LIQ   = 98.956567797;

// ── Test setup ────────────────────────────────────────────────────────────────

let mockTx: object;

beforeAll(() => {
  const fixturePath = path.resolve(__dirname, 'fixtures', 'pumpswap-migration-31V8YGSQ.json');
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as RawFixture;
  mockTx = fixtureToMock(raw);
});

// ── Real-fixture tests ────────────────────────────────────────────────────────

describe('parsePoolCreation — real fixture (31V8YGSQ)', () => {
  it('returns a result (does not throw)', async () => {
    const result = await parsePoolCreation(makeConnection(mockTx), FIXTURE_SIG);
    expect(result).toBeDefined();
  });

  it('extracts the correct tokenCA', async () => {
    const result = await parsePoolCreation(makeConnection(mockTx), FIXTURE_SIG);
    expect(result.tokenCA).toBe(EXPECTED_TOKEN);
  });

  it('extracts the correct poolAddress (non-fee-payer owner with both vaults)', async () => {
    const result = await parsePoolCreation(makeConnection(mockTx), FIXTURE_SIG);
    expect(result.poolAddress).toBe(EXPECTED_POOL);
  });

  it('extracts initialLiquiditySOL from wSOL postTokenBalance', async () => {
    const result = await parsePoolCreation(makeConnection(mockTx), FIXTURE_SIG);
    expect(result.initialLiquiditySOL).toBeCloseTo(EXPECTED_LIQ, 4);
  });

  it('sets deployer to UNKNOWN with deployerResolved=false (bonding-curve lookup deferred)', async () => {
    const result = await parsePoolCreation(makeConnection(mockTx), FIXTURE_SIG);
    expect(result.deployer).toBe('UNKNOWN');
    expect(result.deployerResolved).toBe(false);
  });

  it('derives wsolVault as ATA of WSOL owned by pool PDA', async () => {
    const result = await parsePoolCreation(makeConnection(mockTx), FIXTURE_SIG);
    const expected = getAssociatedTokenAddressSync(
      new PublicKey(WRAPPED_SOL),
      new PublicKey(EXPECTED_POOL),
      true, // pool PDA is off-curve
    ).toBase58();
    expect(result.wsolVault).toBe(expected);
  });

  it('parseLatencyMs is a non-negative number', async () => {
    const result = await parsePoolCreation(makeConnection(mockTx), FIXTURE_SIG);
    expect(typeof result.parseLatencyMs).toBe('number');
    expect(result.parseLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('preserves signature passthrough', async () => {
    const result = await parsePoolCreation(makeConnection(mockTx), FIXTURE_SIG);
    expect(result.signature).toBe(FIXTURE_SIG);
  });
});

// ── Synthetic edge-case tests ─────────────────────────────────────────────────

describe('parsePoolCreation — edge cases', () => {
  const SIG      = 'synthetic-sig-001';
  // Valid 32-byte base58 Solana public keys (required by PublicKey constructor)
  const FEE_PAYER = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
  const POOL      = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
  const TOKEN     = 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq';

  function makeParsedTx(
    postTokenBalances: Array<{
      accountIndex: number;
      mint: string;
      owner?: string;
      uiTokenAmount: { uiAmount: number | null; amount: string; decimals: number };
    }>,
    accountKey0 = FEE_PAYER
  ): object {
    return {
      slot: 999_999,
      blockTime: null,
      version: 0,
      transaction: {
        message: {
          accountKeys: [{ pubkey: { toBase58: () => accountKey0 }, signer: true, writable: true }],
        },
      },
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
      },
    };
  }

  it('throws when getParsedTransaction returns null', async () => {
    await expect(parsePoolCreation(makeConnection(null), SIG)).rejects.toThrow(
      'tx not found or incomplete'
    );
  });

  it('throws when postTokenBalances is empty (no mints at all)', async () => {
    const tx = makeParsedTx([]);
    await expect(parsePoolCreation(makeConnection(tx), SIG)).rejects.toThrow(
      'no non-SOL mint'
    );
  });

  it('throws when there is no non-SOL mint', async () => {
    const tx = makeParsedTx([
      { accountIndex: 0, mint: WRAPPED_SOL, owner: POOL, uiTokenAmount: { uiAmount: 10, amount: '', decimals: 9 } },
    ]);
    await expect(parsePoolCreation(makeConnection(tx), SIG)).rejects.toThrow(
      'no non-SOL mint'
    );
  });

  it('throws when there are multiple distinct non-SOL mints (ambiguous)', async () => {
    const tx = makeParsedTx([
      { accountIndex: 0, mint: 'TokenMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', owner: POOL, uiTokenAmount: { uiAmount: 1000, amount: '', decimals: 6 } },
      { accountIndex: 1, mint: 'TokenMintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', owner: POOL, uiTokenAmount: { uiAmount: 2000, amount: '', decimals: 6 } },
    ]);
    await expect(parsePoolCreation(makeConnection(tx), SIG)).rejects.toThrow(
      'multiple non-SOL mints'
    );
  });

  it('throws when the only wSOL entry is owned by the fee-payer (no pool candidate)', async () => {
    const tx = makeParsedTx([
      { accountIndex: 0, mint: TOKEN,       owner: FEE_PAYER, uiTokenAmount: { uiAmount: 1000, amount: '', decimals: 6 } },
      { accountIndex: 1, mint: WRAPPED_SOL, owner: FEE_PAYER, uiTokenAmount: { uiAmount: 50,   amount: '', decimals: 9 } },
    ]);
    await expect(parsePoolCreation(makeConnection(tx), SIG)).rejects.toThrow(
      'no pool candidate'
    );
  });

  it('throws when the pool has a token vault but no wSOL vault', async () => {
    const tx = makeParsedTx([
      { accountIndex: 0, mint: TOKEN,       owner: FEE_PAYER, uiTokenAmount: { uiAmount: 100, amount: '', decimals: 6 } },
      { accountIndex: 1, mint: WRAPPED_SOL, owner: FEE_PAYER, uiTokenAmount: { uiAmount: 5,   amount: '', decimals: 9 } },
      { accountIndex: 2, mint: TOKEN,       owner: POOL,      uiTokenAmount: { uiAmount: 500, amount: '', decimals: 6 } },
    ]);
    await expect(parsePoolCreation(makeConnection(tx), SIG)).rejects.toThrow(
      'no pool candidate'
    );
  });

  it('correctly identifies pool when fee-payer also holds both vaults', async () => {
    const tx = makeParsedTx([
      { accountIndex: 0, mint: TOKEN,       owner: FEE_PAYER, uiTokenAmount: { uiAmount: 100,  amount: '', decimals: 6 } },
      { accountIndex: 1, mint: WRAPPED_SOL, owner: FEE_PAYER, uiTokenAmount: { uiAmount: 5,    amount: '', decimals: 9 } },
      { accountIndex: 2, mint: TOKEN,       owner: POOL,      uiTokenAmount: { uiAmount: 5000, amount: '', decimals: 6 } },
      { accountIndex: 3, mint: WRAPPED_SOL, owner: POOL,      uiTokenAmount: { uiAmount: 99,   amount: '', decimals: 9 } },
    ]);
    const result = await parsePoolCreation(makeConnection(tx), SIG);
    expect(result.poolAddress).toBe(POOL);
    expect(result.initialLiquiditySOL).toBeCloseTo(99, 4);
    expect(result.tokenCA).toBe(TOKEN);
    expect(result.deployer).toBe('UNKNOWN');
    expect(result.deployerResolved).toBe(false);
  });
});
