import { PublicKey, AccountInfo } from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PoolVaultStream } from '../src/ingestion/poolVaultStream';
import { bus } from '../src/core/eventBus';

const WSOL = 'So11111111111111111111111111111111111111112';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const OWNER = 'HEoY16En8NnfZXZ9qZDHH4B5XsKrL6wpXjScwHWFsr9X';

// Build a 165-byte SPL token account buffer (what onAccountChange delivers).
function buildAcct(mintB58: string, amount: bigint): AccountInfo<Buffer> {
  const buf = Buffer.alloc(AccountLayout.span);
  new PublicKey(mintB58).toBuffer().copy(buf, 0);
  new PublicKey(OWNER).toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(amount, 64);
  buf.writeUInt8(1, 108); // state = initialized
  return {
    data: buf,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    lamports: 2039280,
    rentEpoch: 0,
  };
}

// Mock Connection: captures the onAccountChange callback so tests can fire
// synthetic account updates, and records removeAccountChangeListener calls.
function makeMockConnection() {
  const cbs: Record<number, (ai: AccountInfo<Buffer>) => void> = {};
  let nextId = 1;
  const removed: number[] = [];
  return {
    removed,
    fire(subId: number, ai: AccountInfo<Buffer>) {
      cbs[subId]?.(ai);
    },
    conn: {
      onAccountChange(_vault: PublicKey, cb: (ai: AccountInfo<Buffer>) => void) {
        const id = nextId++;
        cbs[id] = cb;
        return id;
      },
      removeAccountChangeListener(id: number) {
        removed.push(id);
        delete cbs[id];
      },
      // isWsOpen reads connection internals; the helper tolerates this mock.
      _rpcWebSocket: { _ws: { readyState: 1 } },
    } as any,
  };
}

describe('PoolVaultStream', () => {
  let emitSpy: jest.SpyInstance;
  beforeEach(() => {
    emitSpy = jest.spyOn(bus, 'emit').mockImplementation(() => false as any);
  });
  afterEach(() => {
    emitSpy.mockRestore();
  });

  function drained() {
    return emitSpy.mock.calls.filter((c) => c[0] === 'vault:drained');
  }

  it('emits vault:drained on a >40% single-step drop (41%)', () => {
    const m = makeMockConnection();
    const s = new PoolVaultStream(m.conn);
    s.subscribe('pool', 'TKN');
    m.fire(1, buildAcct(WSOL, 100n)); // baseline
    m.fire(1, buildAcct(WSOL, 59n)); // 41% drop
    const calls = drained();
    expect(calls).toHaveLength(1);
    expect(calls[0][1].tokenCA).toBe('TKN');
    expect(calls[0][1].dropPct).toBeCloseTo(41, 0);
  });

  it('does not emit on a 39% drop', () => {
    const m = makeMockConnection();
    const s = new PoolVaultStream(m.conn);
    s.subscribe('pool', 'TKN');
    m.fire(1, buildAcct(WSOL, 100n));
    m.fire(1, buildAcct(WSOL, 61n));
    expect(drained()).toHaveLength(0);
  });

  it('does not emit on exactly a 40% drop (boundary: >40% required)', () => {
    const m = makeMockConnection();
    const s = new PoolVaultStream(m.conn);
    s.subscribe('pool', 'TKN');
    m.fire(1, buildAcct(WSOL, 100n));
    m.fire(1, buildAcct(WSOL, 60n));
    expect(drained()).toHaveLength(0);
  });

  it('unsubscribes (and never emits) when the vault mint is not wSOL', () => {
    const m = makeMockConnection();
    const s = new PoolVaultStream(m.conn);
    s.subscribe('pool', 'TKN');
    m.fire(1, buildAcct(BONK, 100n)); // wrong mint on first callback
    expect(s.isTracking('TKN')).toBe(false);
    expect(m.removed).toContain(1);
    expect(drained()).toHaveLength(0);
  });

  it('establishes a baseline on the first callback without emitting', () => {
    const m = makeMockConnection();
    const s = new PoolVaultStream(m.conn);
    s.subscribe('pool', 'TKN');
    m.fire(1, buildAcct(WSOL, 100n));
    expect(drained()).toHaveLength(0);
  });

  it('cleans up on unsubscribe', () => {
    const m = makeMockConnection();
    const s = new PoolVaultStream(m.conn);
    s.subscribe('pool', 'TKN');
    s.unsubscribe('TKN');
    expect(s.isTracking('TKN')).toBe(false);
    expect(m.removed).toContain(1);
  });

  it('guards against double-subscribe', () => {
    const m = makeMockConnection();
    const s = new PoolVaultStream(m.conn);
    s.subscribe('pool', 'TKN');
    s.subscribe('pool', 'TKN');
    // second subscribe is a no-op; unsubscribing once fully clears tracking
    s.unsubscribe('TKN');
    expect(s.isTracking('TKN')).toBe(false);
  });

  it('emits on a full drain (100%)', () => {
    const m = makeMockConnection();
    const s = new PoolVaultStream(m.conn);
    s.subscribe('pool', 'TKN');
    m.fire(1, buildAcct(WSOL, 100n));
    m.fire(1, buildAcct(WSOL, 0n));
    const calls = drained();
    expect(calls).toHaveLength(1);
    expect(calls[0][1].dropPct).toBeCloseTo(100, 0);
  });

  it('does not emit on gradual sub-threshold steps (single-step semantics)', () => {
    // Two 30% steps: cumulative >40%, but each single step <40%. RUG_TRIGGER
    // is for a single-transaction drain, not a gradual bleed (which HARD_STOP /
    // TRAILING_STOP catch on price). This boundary is intentional.
    const m = makeMockConnection();
    const s = new PoolVaultStream(m.conn);
    s.subscribe('pool', 'TKN');
    m.fire(1, buildAcct(WSOL, 100n)); // baseline
    m.fire(1, buildAcct(WSOL, 70n)); // 30% drop, baseline -> 70
    m.fire(1, buildAcct(WSOL, 49n)); // 30% drop from 70
    expect(drained()).toHaveLength(0);
  });
});
