import { SmartWalletStream } from '../src/ingestion/smartWalletStream';
import { logger } from '../src/core/logger';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const WALLET = 'HEoY16En8NnfZXZ9qZDHH4B5XsKrL6wpXjScwHWFsr9X';
const OTHER_WALLET = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const DEX_LOG = 'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]';

function makeStream(getParsedTransaction: jest.Mock) {
  const connection: any = { rpcEndpoint: 'https://x.example.com', getParsedTransaction };
  const registry: any = { getWalletStats: () => ({ pnl30d: 0 }), getAll: () => [] };
  return new SmartWalletStream(connection, registry);
}

function logsFor(signature: string, opts: { err?: boolean; dex?: boolean } = {}): any {
  return {
    err: opts.err ? { InstructionError: [0, 'x'] } : null,
    signature,
    logs: opts.dex === false ? ['Program log: transfer'] : [DEX_LOG],
  };
}

/** A parsed transaction in which WALLET's native SOL moved by solDeltaSOL and a token balance moved. */
function tx(opts: { solDeltaSOL: number; preToken?: number; tokenDelta: number; noTokenBalance?: boolean }): any {
  const pre = opts.preToken ?? 0;
  const bal = (amount: number) => ({
    owner: WALLET,
    mint: 'MINT111111111111111111111111111111111111111',
    uiTokenAmount: { amount: String(amount), decimals: 6 },
  });
  return {
    meta: {
      preBalances: [5_000_000_000],
      postBalances: [5_000_000_000 + Math.round(opts.solDeltaSOL * 1e9)],
      preTokenBalances: opts.noTokenBalance || pre === 0 ? [] : [bal(pre)],
      postTokenBalances: opts.noTokenBalance ? [] : [bal(pre + opts.tokenDelta)],
    },
    transaction: { message: { accountKeys: [{ pubkey: { toBase58: () => WALLET } }] } },
  };
}

const ctx: any = { slot: 123 };
const call = (s: SmartWalletStream, l: any, wallet = WALLET) => (s as any).handleLogs(l, ctx, wallet);
const stats = (s: SmartWalletStream) => s.getTelemetry().fetchStats;

describe('SmartWalletStream fetch accounting', () => {
  it('counts skipped notifications without fetching', async () => {
    const fetch = jest.fn();
    const s = makeStream(fetch);
    await call(s, logsFor('a', { err: true }));
    await call(s, logsFor('b', { dex: false }));
    expect(fetch).not.toHaveBeenCalled();
    expect(stats(s)).toMatchObject({ logs: 2, logsErr: 1, notSwap: 1, fetches: 0 });
  });

  it('counts a fetch that returns nothing, with the reason', async () => {
    const fetch = jest.fn().mockResolvedValue(null);
    const s = makeStream(fetch);
    await call(s, logsFor('a'));
    expect(stats(s)).toMatchObject({ fetches: 1, fetchNull: 1, events: 0 });
    expect(stats(s).nullReasons).toEqual({ tx_unavailable: 1 });
  });

  it('separates the null reasons that matter', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(tx({ solDeltaSOL: 0, tokenDelta: 500 }))                       // paid in wrapped SOL
      .mockResolvedValueOnce(tx({ solDeltaSOL: -0.2, preToken: 1000, tokenDelta: 0 }))      // round trip
      .mockResolvedValueOnce(tx({ solDeltaSOL: -0.2, tokenDelta: 0, noTokenBalance: true })); // no token at all
    const s = makeStream(fetch);
    await call(s, logsFor('a'));
    await call(s, logsFor('b'));
    await call(s, logsFor('c'));
    expect(stats(s).nullReasons).toEqual({ zero_sol_delta: 1, zero_token_delta: 1, no_token_balance: 1 });
    expect(stats(s)).toMatchObject({ fetches: 3, fetchNull: 3, events: 0 });
  });

  it('counts parsed events and which could become a signal', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(tx({ solDeltaSOL: -0.2, tokenDelta: 1_000_000 }))     // BUY 0.2 SOL: candidate
      .mockResolvedValueOnce(tx({ solDeltaSOL: -0.002, tokenDelta: 1_000_000 }))   // BUY dust: not a candidate
      .mockResolvedValueOnce(tx({ solDeltaSOL: 0.3, preToken: 2_000_000, tokenDelta: -1_000_000 })); // SELL
    const s = makeStream(fetch);
    await call(s, logsFor('a'));
    await call(s, logsFor('b'));
    await call(s, logsFor('c'));
    expect(stats(s)).toMatchObject({ fetches: 3, events: 3, buys: 2, sells: 1, signalCandidates: 1, fetchNull: 0 });
  });

  it('does not refetch the same wallet+signature', async () => {
    const fetch = jest.fn().mockResolvedValue(tx({ solDeltaSOL: -0.2, tokenDelta: 1_000_000 }));
    const s = makeStream(fetch);
    await call(s, logsFor('same'));
    await call(s, logsFor('same'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stats(s)).toMatchObject({ fetches: 1, deduped: 1 });
  });

  it('counts a fetch that throws', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('429'));
    const s = makeStream(fetch);
    await call(s, logsFor('a'));
    expect(stats(s)).toMatchObject({ fetches: 1, fetchError: 1 });
  });

  it('hourly log reports the window, ranks wallets by fetches, and resets the window but not the totals', async () => {
    const fetch = jest.fn().mockResolvedValue(null);
    const s = makeStream(fetch);
    await call(s, logsFor('a1'), WALLET);
    await call(s, logsFor('a2'), WALLET);
    await call(s, logsFor('a3'), WALLET);
    await call(s, logsFor('b1'), OTHER_WALLET);

    (s as any).logWindowStats();

    const infoCalls = (logger.info as jest.Mock).mock.calls.filter((c) => c[0] === '[WalletStream] Hourly fetch stats');
    expect(infoCalls).toHaveLength(1);
    const payload = infoCalls[0][1];
    expect(payload).toMatchObject({ fetches: 4, fetchNull: 4, fetchNullPct: 100, activeWallets: 2 });
    expect(payload.topWalletsByFetches[0]).toMatchObject({ wallet: WALLET, fetches: 3, nulls: 3 });

    // a second flush starts from zero, while the since-boot totals are kept
    (logger.info as jest.Mock).mockClear();
    (s as any).logWindowStats();
    const second = (logger.info as jest.Mock).mock.calls.find((c) => c[0] === '[WalletStream] Hourly fetch stats')![1];
    expect(second).toMatchObject({ fetches: 0, fetchNullPct: 0, activeWallets: 0 });
    expect(stats(s).fetches).toBe(4);
  });
});
