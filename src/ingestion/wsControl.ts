import { Connection } from '@solana/web3.js';
import { logger } from '../core/logger';

/**
 * Access the internal rpc-websockets client on a @solana/web3.js Connection.
 * The library sets max_reconnects=Infinity by default, which creates infinite
 * 429 retry loops when the RPC rate-limits WebSocket connections.
 */
function getInternalWs(conn: Connection): any | null {
  try {
    // @ts-expect-error — _rpcWebSocket is private but required for WS lifecycle control
    return conn._rpcWebSocket ?? null;
  } catch {
    return null;
  }
}

/** Stop a Connection's internal WS from auto-reconnecting (kills retry loop). */
export function disableWsReconnect(conn: Connection): void {
  const ws = getInternalWs(conn);
  if (!ws) return;
  try {
    ws.reconnect = false;
    if (typeof ws.close === 'function') {
      ws.close();
    }
    logger.debug('[wsControl] Disabled WS reconnect and closed socket');
  } catch (err) {
    logger.debug('[wsControl] Failed to disable reconnect', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Re-enable a Connection's WS auto-reconnect (before subscribing). */
export function enableWsReconnect(conn: Connection, maxReconnects = 5): void {
  const ws = getInternalWs(conn);
  if (!ws) return;
  try {
    ws.reconnect = true;
    ws.max_reconnects = maxReconnects;
    ws.current_reconnects = 0;
    logger.debug('[wsControl] Enabled WS reconnect', { maxReconnects });
  } catch (err) {
    logger.debug('[wsControl] Failed to enable reconnect', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Reset reconnect counter (call after a successful connection). */
export function resetWsReconnectCount(conn: Connection): void {
  const ws = getInternalWs(conn);
  if (!ws) return;
  try {
    ws.current_reconnects = 0;
  } catch {
    // ignore
  }
}
