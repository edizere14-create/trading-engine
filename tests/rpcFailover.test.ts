import { RpcFailover } from '../src/ingestion/rpcFailover';

interface MockConn {
  rpcEndpoint: string;
  healthy: boolean;
  getSlot: jest.Mock;
  _rpcWebSocket: { reconnect: boolean; max_reconnects: number; current_reconnects: number };
}

function makeConn(label: string): MockConn {
  const c: MockConn = {
    rpcEndpoint: `https://${label}.example.com`,
    healthy: true,
    getSlot: jest.fn(async () => {
      if (!c.healthy) throw new Error('down');
      return 1;
    }),
    _rpcWebSocket: { reconnect: false, max_reconnects: 0, current_reconnects: 0 },
  };
  return c;
}

const TICK = 10_000;

describe('RpcFailover', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(opts: { backup?: boolean; subs?: boolean } = {}) {
    const primary = makeConn('primary');
    const backup = makeConn('backup');
    const state = { subs: opts.subs ?? true, socketsOpen: true };
    const moveTo = jest.fn(async () => {});
    const fo = new RpcFailover({
      name: 'Test',
      primary: primary as any,
      backup: opts.backup === false ? null : (backup as any),
      hasSubscriptions: () => state.subs,
      socketsOpen: () => state.socketsOpen,
      moveTo,
    });
    return { primary, backup, state, moveTo, fo };
  }

  it('is inert without a backup (no timer started)', () => {
    const { fo } = setup({ backup: false });
    fo.start();
    expect(jest.getTimerCount()).toBe(0);
    fo.stop();
  });

  it('does not fail over after only 2 failed probes', async () => {
    const { primary, moveTo, fo } = setup();
    fo.start();
    primary.healthy = false;
    await jest.advanceTimersByTimeAsync(TICK * 2);
    expect(moveTo).not.toHaveBeenCalled();
    fo.stop();
  });

  it('fails over to the backup after 3 consecutive failed probes', async () => {
    const { primary, backup, moveTo, fo } = setup();
    fo.start();
    primary.healthy = false;
    await jest.advanceTimersByTimeAsync(TICK * 3);
    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(moveTo).toHaveBeenCalledWith(backup, 'liveness');
    expect(fo.activeConnection).toBe(backup);
    expect(fo.rpcRole).toBe('backup');
    fo.stop();
  });

  it('fails over when the socket is closed even though getSlot answers', async () => {
    const { backup, state, moveTo, fo } = setup();
    fo.start();
    state.socketsOpen = false;
    await jest.advanceTimersByTimeAsync(TICK * 3);
    expect(moveTo).toHaveBeenCalledWith(backup, 'liveness');
    fo.stop();
  });

  it('a healthy probe resets the failure count', async () => {
    const { primary, moveTo, fo } = setup();
    fo.start();
    primary.healthy = false;
    await jest.advanceTimersByTimeAsync(TICK * 2);
    primary.healthy = true;
    await jest.advanceTimersByTimeAsync(TICK);
    primary.healthy = false;
    await jest.advanceTimersByTimeAsync(TICK * 2);
    expect(moveTo).not.toHaveBeenCalled();
    fo.stop();
  });

  it('does nothing while there are no subscriptions to protect', async () => {
    const { primary, moveTo, state, fo } = setup({ subs: false });
    fo.start();
    primary.healthy = false;
    state.socketsOpen = false;
    await jest.advanceTimersByTimeAsync(TICK * 5);
    expect(moveTo).not.toHaveBeenCalled();
    fo.stop();
  });

  it('aborts the switch when the backup is also down', async () => {
    const { primary, backup, moveTo, fo } = setup();
    fo.start();
    primary.healthy = false;
    backup.healthy = false;
    await jest.advanceTimersByTimeAsync(TICK * 3);
    expect(moveTo).not.toHaveBeenCalled();
    expect(fo.activeConnection).toBe(primary);
    fo.stop();
  });

  it('fails back to the primary only after the dwell and 6 healthy probes', async () => {
    const { primary, backup, moveTo, fo } = setup();
    fo.start();
    primary.healthy = false;
    await jest.advanceTimersByTimeAsync(TICK * 3); // fails over at ~30s
    expect(moveTo).toHaveBeenCalledTimes(1);

    primary.healthy = true; // primary recovers immediately
    await jest.advanceTimersByTimeAsync(60_000); // inside the 90s dwell
    expect(moveTo).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(TICK * 10); // dwell over + 6 healthy probes
    expect(moveTo).toHaveBeenCalledTimes(2);
    expect(moveTo).toHaveBeenLastCalledWith(primary, 'failback');
    expect(fo.activeConnection).toBe(primary);
    expect(backup.getSlot).toHaveBeenCalled();
    fo.stop();
  });

  it('does not fail back while the primary keeps failing probes', async () => {
    const { primary, moveTo, fo } = setup();
    fo.start();
    primary.healthy = false;
    await jest.advanceTimersByTimeAsync(TICK * 3);
    await jest.advanceTimersByTimeAsync(TICK * 30);
    expect(moveTo).toHaveBeenCalledTimes(1); // only the initial failover
    fo.stop();
  });
});
