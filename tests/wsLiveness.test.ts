import { acquireSlotWatch, isConnectionLive, SLOT_MAX_AGE_MS } from '../src/ingestion/wsLiveness';

jest.mock('../src/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function makeConn() {
  const c: any = { rpcEndpoint: 'https://x.example.com', cbs: [] as Array<(s: unknown) => void>, nextId: 1 };
  c.onSlotChange = jest.fn((cb: (s: unknown) => void) => {
    c.cbs.push(cb);
    return c.nextId++;
  });
  c.removeSlotChangeListener = jest.fn(async () => {});
  c.slot = () => c.cbs.forEach((cb: (s: unknown) => void) => cb({ slot: 1 }));
  return c;
}

describe('wsLiveness', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shares one slot subscription per connection and removes it when the last holder releases', () => {
    const conn = makeConn();
    const r1 = acquireSlotWatch(conn);
    const r2 = acquireSlotWatch(conn);
    expect(conn.onSlotChange).toHaveBeenCalledTimes(1);
    r1();
    expect(conn.removeSlotChangeListener).not.toHaveBeenCalled();
    r2();
    expect(conn.removeSlotChangeListener).toHaveBeenCalledTimes(1);
  });

  it('release is idempotent', () => {
    const conn = makeConn();
    const r1 = acquireSlotWatch(conn);
    const r2 = acquireSlotWatch(conn);
    r1();
    r1();
    expect(conn.removeSlotChangeListener).not.toHaveBeenCalled(); // r2 still holds it
    r2();
    expect(conn.removeSlotChangeListener).toHaveBeenCalledTimes(1);
  });

  it('is live while slots arrive, with no HTTP calls', async () => {
    const conn = makeConn();
    const http = jest.fn(async () => true);
    const release = acquireSlotWatch(conn);
    conn.slot();
    await expect(isConnectionLive(conn, http)).resolves.toBe(true);
    jest.advanceTimersByTime(SLOT_MAX_AGE_MS - 1_000);
    await expect(isConnectionLive(conn, http)).resolves.toBe(true);
    expect(http).not.toHaveBeenCalled();
    release();
  });

  it('is dead once slots stop, even though HTTP would answer, and never calls HTTP', async () => {
    const conn = makeConn();
    const http = jest.fn(async () => true);
    const release = acquireSlotWatch(conn);
    conn.slot();
    jest.advanceTimersByTime(SLOT_MAX_AGE_MS + 1_000);
    await expect(isConnectionLive(conn, http)).resolves.toBe(false);
    expect(http).not.toHaveBeenCalled();
    conn.slot(); // pipeline recovers
    await expect(isConnectionLive(conn, http)).resolves.toBe(true);
    release();
  });

  it('waits out a grace period for the first slot without calling HTTP', async () => {
    const conn = makeConn();
    const http = jest.fn(async () => false);
    const release = acquireSlotWatch(conn);
    jest.advanceTimersByTime(20_000);
    await expect(isConnectionLive(conn, http)).resolves.toBe(true);
    expect(http).not.toHaveBeenCalled();
    release();
  });

  it('falls back to a rate-limited HTTP probe when no slot ever arrives', async () => {
    const conn = makeConn();
    const http = jest.fn(async () => true);
    const release = acquireSlotWatch(conn);

    jest.advanceTimersByTime(31_000);
    await expect(isConnectionLive(conn, http)).resolves.toBe(true);
    expect(http).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(10_000);
    await isConnectionLive(conn, http);
    await isConnectionLive(conn, http);
    expect(http).toHaveBeenCalledTimes(1); // cached inside the minute

    jest.advanceTimersByTime(61_000);
    await isConnectionLive(conn, http);
    expect(http).toHaveBeenCalledTimes(2);
    release();
  });

  it('reports dead via the fallback when no slots arrive and HTTP fails too', async () => {
    const conn = makeConn();
    const http = jest.fn(async () => false);
    const release = acquireSlotWatch(conn);
    jest.advanceTimersByTime(31_000);
    await expect(isConnectionLive(conn, http)).resolves.toBe(false);
    release();
  });

  it('uses the HTTP probe directly for a connection that cannot be watched', async () => {
    const conn: any = { rpcEndpoint: 'https://y.example.com' }; // no onSlotChange
    const http = jest.fn(async () => true);
    const release = acquireSlotWatch(conn);
    await expect(isConnectionLive(conn, http)).resolves.toBe(true);
    expect(http).toHaveBeenCalledTimes(1);
    release(); // no-op, must not throw
  });
});
