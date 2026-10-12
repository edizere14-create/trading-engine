import { PoolPriceStream } from '../src/ingestion/poolPriceStream';
import { bus } from '../src/core/eventBus';

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const POOL = 'HEoY16En8NnfZXZ9qZDHH4B5XsKrL6wpXjScwHWFsr9X';
const TOKEN = 'tok-1';
const PUMPSWAP_LOG = ['Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]'];

function setup() {
  const callbacks: Array<(logs: unknown) => void> = [];
  const conn: any = {
    onLogs: jest.fn((_pk: unknown, cb: (logs: unknown) => void) => {
      callbacks.push(cb);
      return callbacks.length;
    }),
    removeOnLogsListener: jest.fn().mockResolvedValue(undefined),
    _rpcWebSocket: { _ws: { readyState: 1 } },
  };
  // the price the "chain" currently has; tests change it between swaps
  const chain = { price: 1e-7 };
  const simulator: any = {
    getReserves: jest.fn(async () => ({
      reserveA: 1_000_000n,
      reserveB: 50_000_000_000n,
      decimalsA: 6,
      decimalsB: 9,
      ammType: 'pumpswap',
      fetchedAt: Date.now(),
    })),
    getSpotPrice: jest.fn(() => chain.price),
  };
  const stream = new PoolPriceStream(conn, simulator);
  const swap = () => callbacks[callbacks.length - 1]({ err: null, logs: PUMPSWAP_LOG, signature: 's' });
  return { stream, simulator, conn, chain, swap };
}

describe('PoolPriceStream: prices after a swap are read fresh and never dropped', () => {
  let emitSpy: jest.SpyInstance;
  const emitted = () => emitSpy.mock.calls.filter((c) => c[0] === 'pool:price').map((c) => c[1]);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-09T23:59:08.000Z'));
    emitSpy = jest.spyOn(bus, 'emit').mockImplementation(() => false as any);
  });
  afterEach(() => {
    emitSpy.mockRestore();
    jest.useRealTimers();
  });

  it('reads the initial price on subscribe, bypassing the reserve cache', async () => {
    const { stream, simulator } = setup();
    stream.subscribe(POOL, TOKEN);
    await jest.advanceTimersByTimeAsync(0);

    expect(simulator.getReserves).toHaveBeenCalledTimes(1);
    expect(simulator.getReserves).toHaveBeenCalledWith(POOL, { maxAgeMs: 0 });
    await stream.stop();
  });

  it('stamps each price with when the reserves were read', async () => {
    const { stream } = setup();
    stream.subscribe(POOL, TOKEN);
    await jest.advanceTimersByTimeAsync(0);

    const [first] = emitted();
    expect(first).toMatchObject({ tokenCA: TOKEN, priceSOL: 1e-7 });
    expect(first.observedAt).toBe(Date.now());
    await stream.stop();
  });

  it('a swap after the cooldown reads fresh reserves and emits the new price (the cached-price bug)', async () => {
    const { stream, simulator, chain, swap } = setup();
    stream.subscribe(POOL, TOKEN);
    await jest.advanceTimersByTimeAsync(0);

    await jest.advanceTimersByTimeAsync(600);
    chain.price = 3e-8; // the swap moved the price
    swap();
    await jest.advanceTimersByTimeAsync(0);

    expect(simulator.getReserves).toHaveBeenCalledTimes(2);
    expect(simulator.getReserves).toHaveBeenLastCalledWith(POOL, { maxAgeMs: 0 });
    expect(emitted().map((e) => e.priceSOL)).toEqual([1e-7, 3e-8]);
    await stream.stop();
  });

  it('a swap inside the cooldown is not dropped: one follow-up fetch runs when the cooldown ends', async () => {
    const { stream, simulator, chain, swap } = setup();
    stream.subscribe(POOL, TOKEN);
    await jest.advanceTimersByTimeAsync(0); // fetch #1 at t=0

    await jest.advanceTimersByTimeAsync(100);
    chain.price = 2e-8; // a dump lands 100ms after the last read
    swap();
    await jest.advanceTimersByTimeAsync(0);
    expect(simulator.getReserves).toHaveBeenCalledTimes(1); // still cooling down

    await jest.advanceTimersByTimeAsync(400); // t=500: not yet
    expect(simulator.getReserves).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2); // cooldown over
    expect(simulator.getReserves).toHaveBeenCalledTimes(2);
    expect(emitted().map((e) => e.priceSOL)).toEqual([1e-7, 2e-8]);
    await stream.stop();
  });

  it('a burst of swaps inside one cooldown schedules a single follow-up, not one per swap', async () => {
    const { stream, simulator, swap } = setup();
    stream.subscribe(POOL, TOKEN);
    await jest.advanceTimersByTimeAsync(0);

    await jest.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 6; i++) swap();
    await jest.advanceTimersByTimeAsync(1000);

    expect(simulator.getReserves).toHaveBeenCalledTimes(2); // the initial read + one follow-up
    await stream.stop();
  });

  it('the follow-up does not run once the position is gone', async () => {
    const { stream, simulator, swap } = setup();
    stream.subscribe(POOL, TOKEN);
    await jest.advanceTimersByTimeAsync(0);

    await jest.advanceTimersByTimeAsync(100);
    swap();
    stream.unsubscribe(TOKEN);
    await jest.advanceTimersByTimeAsync(2000);

    expect(simulator.getReserves).toHaveBeenCalledTimes(1);
    expect(emitted()).toHaveLength(1);
  });

  it('ignores failed transactions and logs that are not from a swap program', async () => {
    const { stream, simulator, conn } = setup();
    stream.subscribe(POOL, TOKEN);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(600);

    const cb = conn.onLogs.mock.calls[0][1] as (logs: unknown) => void;
    cb({ err: { InstructionError: [0, 'x'] }, logs: PUMPSWAP_LOG, signature: 's' });
    cb({ err: null, logs: ['Program 11111111111111111111111111111111 invoke [1]'], signature: 's' });
    await jest.advanceTimersByTimeAsync(1000);

    expect(simulator.getReserves).toHaveBeenCalledTimes(1);
    await stream.stop();
  });
});
