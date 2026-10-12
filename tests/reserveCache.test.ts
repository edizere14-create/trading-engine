import { OnChainSimulator } from '../src/simulation/onChainSimulator';
import { Connection } from '@solana/web3.js';

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const POOL = 'HEoY16En8NnfZXZ9qZDHH4B5XsKrL6wpXjScwHWFsr9X';

describe('OnChainSimulator.getReserves cache', () => {
  let sim: OnChainSimulator;
  let fetchSpy: jest.SpyInstance;
  let n: number;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-09T23:59:08.000Z'));
    sim = new OnChainSimulator({} as unknown as Connection);
    n = 0;
    // each real read returns a different reserve, stamped with the time it was read
    fetchSpy = jest.spyOn(sim as any, 'fetchReserves').mockImplementation(async () => ({
      reserveA: 1_000_000n,
      reserveB: BigInt(++n) * 1_000_000_000n,
      decimalsA: 6,
      decimalsB: 9,
      ammType: 'pumpswap',
      fetchedAt: Date.now(),
    }));
  });
  afterEach(() => jest.useRealTimers());

  it('serves a cached copy for 2s by default (unchanged behaviour for other callers)', async () => {
    const a = await sim.getReserves(POOL);
    jest.advanceTimersByTime(1_999);
    const b = await sim.getReserves(POOL);
    expect(b).toBe(a);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2);
    await sim.getReserves(POOL);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('maxAgeMs: 0 always reads fresh, even straight after a cached read', async () => {
    const a = await sim.getReserves(POOL);
    const b = await sim.getReserves(POOL, { maxAgeMs: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(b.reserveB).not.toBe(a.reserveB);
    expect(b.fetchedAt).toBe(Date.now());
  });

  it('a fresh read refreshes the cache for later default callers', async () => {
    await sim.getReserves(POOL);
    const fresh = await sim.getReserves(POOL, { maxAgeMs: 0 });
    const later = await sim.getReserves(POOL);
    expect(later).toBe(fresh);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('honours a longer maxAgeMs', async () => {
    const a = await sim.getReserves(POOL);
    jest.advanceTimersByTime(4_000);
    expect(await sim.getReserves(POOL, { maxAgeMs: 5_000 })).toBe(a);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
