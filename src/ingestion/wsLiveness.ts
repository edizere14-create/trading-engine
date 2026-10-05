import { Connection } from '@solana/web3.js';
import { logger } from '../core/logger';
import { detachBounded, getConnectionEndpoint } from './wsControl';

/**
 * WebSocket-native liveness.
 *
 * An open socket plus a working HTTP call does not prove notifications are
 * arriving, and polling HTTP costs provider credits and can false-fail when the
 * HTTP side is rate-limited while the WebSocket is fine. Instead we hold one
 * slotSubscribe per connection (slots arrive ~2-3 times a second) and treat
 * "a slot arrived recently" as proof the WebSocket pipeline is delivering. On a
 * healthy line this makes no HTTP calls at all.
 *
 * Limits: it proves the connection delivers, not that one particular logs or
 * account subscription on it is alive (the per-stream silence timers remain the
 * backstop for that). A provider without slotSubscribe never sends a slot; we
 * detect that and fall back to an HTTP probe at most once a minute.
 */

export const SLOT_MAX_AGE_MS = 15_000;          // no slot for this long = pipeline considered dead
const SLOT_GRACE_MS = 30_000;                   // after subscribing, wait this long for a first slot
const HTTP_FALLBACK_INTERVAL_MS = 60_000;       // fallback HTTP probe rate limit (slot-less providers)

interface Watch {
  subId: number;
  refs: number;
  startedAt: number;
  lastSlotAt: number;
  httpMode: boolean;
  lastHttpAt: number;
  lastHttpOk: boolean;
}

const watches = new WeakMap<Connection, Watch>();

/**
 * Start (or share) the slot subscription for a connection. Returns an
 * idempotent release function; the subscription is removed when the last
 * holder releases. If the connection can't be watched, the release is a no-op
 * and isConnectionLive() falls back to the HTTP probe.
 */
export function acquireSlotWatch(conn: Connection): () => void {
  let watch = watches.get(conn);
  if (!watch) {
    const created: Watch = {
      subId: -1,
      refs: 0,
      startedAt: Date.now(),
      lastSlotAt: 0,
      httpMode: false,
      lastHttpAt: 0,
      lastHttpOk: false,
    };
    try {
      created.subId = conn.onSlotChange(() => {
        created.lastSlotAt = Date.now();
      });
    } catch {
      return () => {};
    }
    watches.set(conn, created);
    watch = created;
  }

  watch.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = watches.get(conn);
    if (!current) return;
    current.refs--;
    if (current.refs <= 0) {
      watches.delete(conn);
      void detachBounded(() => conn.removeSlotChangeListener(current.subId));
    }
  };
}

/**
 * Is this connection's WebSocket pipeline delivering? Callers should check the
 * socket state themselves (isWsOpen) and pass an HTTP probe used only when no
 * slot watch exists or the provider never sends slots.
 */
export async function isConnectionLive(
  conn: Connection,
  httpProbe: (conn: Connection) => Promise<boolean>
): Promise<boolean> {
  const watch = watches.get(conn);
  if (!watch) return httpProbe(conn);

  const now = Date.now();
  if (watch.lastSlotAt > 0) return now - watch.lastSlotAt < SLOT_MAX_AGE_MS;
  if (now - watch.startedAt < SLOT_GRACE_MS) return true; // still warming up

  // Grace over and no slot ever arrived: the provider lacks slotSubscribe, or
  // the socket is dead. Disambiguate over HTTP, rate-limited.
  if (!watch.httpMode) {
    watch.httpMode = true;
    logger.warn('[Liveness] No slot notifications — falling back to HTTP probe (limited to 1/min)', {
      endpoint: getConnectionEndpoint(conn),
    });
  }
  if (now - watch.lastHttpAt >= HTTP_FALLBACK_INTERVAL_MS) {
    watch.lastHttpAt = now;
    watch.lastHttpOk = await httpProbe(conn);
  }
  return watch.lastHttpOk;
}
