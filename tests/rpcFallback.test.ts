import { RpcFallback, isTransportError } from '../src/core/rpcFallback';

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const primary = { id: 'primary' } as any;
const backup = { id: 'backup' } as any;

describe('isTransportError', () => {
  it.each(['fetch failed', 'Request timed out', '429 Too Many Requests', 'ECONNRESET', 'HTTP 503', 'socket hang up'])(
    'treats %s as transport',
    (msg) => expect(isTransportError(new Error(msg))).toBe(true)
  );

  it.each(['Invalid param: could not find account', 'Pool not found: abc', 'Mint not parseable'])(
    'treats %s as an application error',
    (msg) => expect(isTransportError(new Error(msg))).toBe(false)
  );
});

describe('RpcFallback', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('with no backup just calls the primary and propagates errors', async () => {
    const rpc = new RpcFallback('t', primary, null);
    const fn = jest.fn(async (c: any) => c.id);
    await expect(rpc.call(fn)).resolves.toBe('primary');
    const boom = jest.fn(async () => { throw new Error('fetch failed'); });
    await expect(rpc.call(boom)).rejects.toThrow('fetch failed');
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it('uses only the primary when it succeeds', async () => {
    const rpc = new RpcFallback('t', primary, backup);
    const fn = jest.fn(async (c: any) => c.id);
    await expect(rpc.call(fn)).resolves.toBe('primary');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('falls back to the backup on a transport error', async () => {
    const rpc = new RpcFallback('t', primary, backup);
    const fn = jest.fn(async (c: any) => {
      if (c === primary) throw new Error('fetch failed');
      return c.id;
    });
    await expect(rpc.call(fn)).resolves.toBe('backup');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not fall back on an application error', async () => {
    const rpc = new RpcFallback('t', primary, backup);
    const fn = jest.fn(async () => { throw new Error('Invalid param: could not find account'); });
    await expect(rpc.call(fn)).rejects.toThrow('could not find account');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('goes to the backup first for 30s after a primary transport failure, then returns to primary', async () => {
    const rpc = new RpcFallback('t', primary, backup);
    const seen: string[] = [];
    let primaryDown = true;
    const fn = async (c: any) => {
      seen.push(c.id);
      if (c === primary && primaryDown) throw new Error('503 Service Unavailable');
      return c.id;
    };

    await rpc.call(fn); // primary fails, backup answers
    seen.length = 0;
    await rpc.call(fn); // inside cooldown: backup first, primary untouched
    expect(seen).toEqual(['backup']);

    primaryDown = false;
    jest.advanceTimersByTime(31_000);
    seen.length = 0;
    await rpc.call(fn); // cooldown over: primary again
    expect(seen).toEqual(['primary']);
  });

  it('rethrows the second error when both endpoints fail', async () => {
    const rpc = new RpcFallback('t', primary, backup);
    const fn = jest.fn(async (c: any) => {
      throw new Error(c === primary ? 'fetch failed' : 'ETIMEDOUT backup');
    });
    await expect(rpc.call(fn)).rejects.toThrow('ETIMEDOUT backup');
  });

  it('during cooldown falls back to the primary if the backup has a transport error', async () => {
    const rpc = new RpcFallback('t', primary, backup);
    let backupDown = false;
    const fn = jest.fn(async (c: any) => {
      if (c === primary && !backupDown) throw new Error('fetch failed');
      if (c === backup && backupDown) throw new Error('fetch failed');
      return c.id;
    });
    await rpc.call(fn); // trips the cooldown, backup answers
    backupDown = true;
    await expect(rpc.call(fn)).resolves.toBe('primary');
  });
});
