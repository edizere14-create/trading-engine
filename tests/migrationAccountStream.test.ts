/**
 * Integration-style tests for MigrationAccountStream.
 *
 * Mocks connection.onLogs + connection.getTransaction to inject synthetic
 * events and verifies bus emission behaviour.
 */

import { EventEmitter } from 'events';
import { Connection, Logs, Context, VersionedTransactionResponse } from '@solana/web3.js';
import { MigrationAccountStream } from '../src/ingestion/migrationAccountStream';
import { bus } from '../src/core/eventBus';
import { PumpSwapGraduationEvent } from '../src/core/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MIGRATE_LOG = 'Program log: Instruction: Migrate';

const TOKEN_CA    = '6Aixvhgirbn8rHmAtFnwHNBqgxtenKDz8ycvHeQepump';
const POOL_ADDR   = '7ugTEN5mq5kGURByfXrK1AqTAJ76wQMauggskosVzEoK';
const FEE_PAYER   = 'niggerd597QYedtvjQDVHZTCCGyJrwHNm2i49dkm5zS';
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

function makeMockTx(
  overrides?: Partial<{
    postTokenBalances: NonNullable<VersionedTransactionResponse['meta']>['postTokenBalances'];
    accountKey0: string;
  }>
): VersionedTransactionResponse {
  const accountKey0 = overrides?.accountKey0 ?? FEE_PAYER;
  const postTokenBalances = overrides?.postTokenBalances ?? [
    // fee-payer's token vault
    { accountIndex: 5, mint: TOKEN_CA, owner: FEE_PAYER,   uiTokenAmount: { uiAmount: 35_000_000, amount: '', decimals: 6 } },
    // fee-payer's wSOL vault
    { accountIndex: 28, mint: WRAPPED_SOL, owner: FEE_PAYER, uiTokenAmount: { uiAmount: 23.8, amount: '', decimals: 9 } },
    // pool's token vault
    { accountIndex: 10, mint: TOKEN_CA,    owner: POOL_ADDR, uiTokenAmount: { uiAmount: 177_000_000, amount: '', decimals: 6 } },
    // pool's wSOL vault
    { accountIndex: 11, mint: WRAPPED_SOL, owner: POOL_ADDR, uiTokenAmount: { uiAmount: 98.956567797, amount: '', decimals: 9 } },
  ];

  return {
    slot: 416647963,
    blockTime: 1700000000,
    version: 0,
    transaction: {
      message: {
        staticAccountKeys: [{ toBase58: () => accountKey0 }],
      } as unknown,
    } as unknown,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [25_419_559_543, 0],
      postBalances: [25_135_515_263, 0],
      preTokenBalances: [],
      postTokenBalances,
      innerInstructions: [],
      logMessages: [MIGRATE_LOG],
      rewards: [],
    } as unknown,
  } as unknown as VersionedTransactionResponse;
}

function makeLogs(sig: string, withMigrateLog = true, hasErr = false): Logs {
  return {
    signature: sig,
    err: hasErr ? new Error('tx failed') : null,
    logs: withMigrateLog ? [MIGRATE_LOG] : ['Program log: Instruction: SomethingElse'],
  };
}

const MOCK_CTX: Context = { slot: 416647963 };

// ── Connection mock factory ───────────────────────────────────────────────────

type LogsCallback = (logs: Logs, ctx: Context) => void;

function makeConnection(txToReturn: VersionedTransactionResponse | null = makeMockTx()): {
  conn: Connection;
  triggerLogs: (logs: Logs) => void;
} {
  let capturedCallback: LogsCallback | null = null;

  const conn = {
    onLogs: jest.fn().mockImplementation((_acct: unknown, cb: LogsCallback) => {
      capturedCallback = cb;
      return 1;
    }),
    removeOnLogsListener: jest.fn().mockResolvedValue(undefined),
    getSlot: jest.fn().mockResolvedValue(416647963),
    getTransaction: jest.fn().mockResolvedValue(txToReturn),
  } as unknown as Connection;

  return {
    conn,
    triggerLogs: (logs: Logs) => {
      if (!capturedCallback) throw new Error('No logs callback registered — did you call start()?');
      capturedCallback(logs, MOCK_CTX);
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MigrationAccountStream', () => {
  let stream: MigrationAccountStream;

  // Silence logger output during tests
  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  afterEach(async () => {
    await stream?.stop();
    // Remove all pool:graduated listeners added during tests
    bus.removeAllListeners('pool:graduated');
    jest.clearAllMocks();
  });

  it('emits pool:graduated with correct fields on a valid migration log', async () => {
    const { conn, triggerLogs } = makeConnection();
    stream = new MigrationAccountStream(conn);
    await stream.start();

    const received: PumpSwapGraduationEvent[] = [];
    bus.on('pool:graduated', (e) => received.push(e));

    triggerLogs(makeLogs('sig-001'));
    // Let the async handleLogs settle
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(received[0].signature).toBe('sig-001');
    expect(received[0].tokenCA).toBe(TOKEN_CA);
    expect(received[0].poolAddress).toBe(POOL_ADDR);
    expect(received[0].deployer).toBe(FEE_PAYER);
    expect(received[0].initialLiquiditySOL).toBeCloseTo(98.956567797, 4);
    expect(received[0].slot).toBe(416647963);
    expect(typeof received[0].detectedAt).toBe('number');
  });

  it('does NOT emit for the same signature within TTL (sig dedup)', async () => {
    const { conn, triggerLogs } = makeConnection();
    stream = new MigrationAccountStream(conn);
    await stream.start();

    const received: PumpSwapGraduationEvent[] = [];
    bus.on('pool:graduated', (e) => received.push(e));

    triggerLogs(makeLogs('sig-dup'));
    await new Promise((r) => setImmediate(r));
    triggerLogs(makeLogs('sig-dup'));
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
  });

  it('does NOT emit for the same tokenCA within 60s TTL at different signatures', async () => {
    const { conn, triggerLogs } = makeConnection();
    stream = new MigrationAccountStream(conn);
    await stream.start();

    const received: PumpSwapGraduationEvent[] = [];
    bus.on('pool:graduated', (e) => received.push(e));

    triggerLogs(makeLogs('sig-first'));
    await new Promise((r) => setImmediate(r));
    triggerLogs(makeLogs('sig-second')); // different sig, same tokenCA in tx
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(received[0].signature).toBe('sig-first');
  });

  it('does NOT emit when log does not contain Instruction: Migrate', async () => {
    const { conn, triggerLogs } = makeConnection();
    stream = new MigrationAccountStream(conn);
    await stream.start();

    const received: PumpSwapGraduationEvent[] = [];
    bus.on('pool:graduated', (e) => received.push(e));

    triggerLogs(makeLogs('sig-no-migrate', false /* no migrate log */));
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
  });

  it('does NOT emit when logs.err is set', async () => {
    const { conn, triggerLogs } = makeConnection();
    stream = new MigrationAccountStream(conn);
    await stream.start();

    const received: PumpSwapGraduationEvent[] = [];
    bus.on('pool:graduated', (e) => received.push(e));

    triggerLogs(makeLogs('sig-err', true, true /* err set */));
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
  });

  it('does NOT emit when getTransaction returns null', async () => {
    const { conn, triggerLogs } = makeConnection(null /* tx = null */);
    stream = new MigrationAccountStream(conn);
    await stream.start();

    const received: PumpSwapGraduationEvent[] = [];
    bus.on('pool:graduated', (e) => received.push(e));

    triggerLogs(makeLogs('sig-no-tx'));
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
  });

  it('does NOT emit when parsePoolCreation returns null (no wSOL in postTokenBalances)', async () => {
    // Tx with only token balances — no wSOL vault for the pool
    const badTx = makeMockTx({
      postTokenBalances: [
        { accountIndex: 10, mint: TOKEN_CA, owner: POOL_ADDR, uiTokenAmount: { uiAmount: 177_000_000, amount: '', decimals: 6 } },
      ],
    });

    const { conn, triggerLogs } = makeConnection(badTx);
    stream = new MigrationAccountStream(conn);
    await stream.start();

    const received: PumpSwapGraduationEvent[] = [];
    bus.on('pool:graduated', (e) => received.push(e));

    triggerLogs(makeLogs('sig-bad-parse'));
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
  });
});
