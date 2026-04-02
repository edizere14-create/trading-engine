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

// ── SUPPRESS @solana/web3.js WS ERROR SPAM ──────────────────

/**
 * @solana/web3.js calls console.error('ws error:', err.message) on every
 * WebSocket failure — including 429 retries. With multiple Connection objects
 * retrying, this floods Railway's log pipeline (500 logs/sec limit).
 *
 * We patch Connection._wsOnError to rate-limit + downgrade the logging.
 */
const wsErrorCounts = new Map<string, { count: number; lastLoggedAt: number }>();
const WS_ERROR_LOG_INTERVAL_MS = 30_000; // Log at most once per 30s per error type

const _originalConsoleError = console.error;

let wsErrorSuppressionInstalled = false;

/**
 * Install a global console.error filter that suppresses repeated
 * "ws error:" messages from @solana/web3.js _wsOnError.
 * Call once at startup.
 */
export function installWsErrorSuppression(): void {
  if (wsErrorSuppressionInstalled) return;
  wsErrorSuppressionInstalled = true;

  console.error = (...args: any[]) => {
    // Check if this is the @solana/web3.js ws error pattern
    if (
      args.length >= 1 &&
      typeof args[0] === 'string' &&
      (args[0].startsWith('ws error:') || args[0].includes('Server responded with'))
    ) {
      const errorMsg = String(args[0]);
      const now = Date.now();
      const entry = wsErrorCounts.get(errorMsg);

      if (entry) {
        entry.count++;
        // Only log periodically
        if (now - entry.lastLoggedAt >= WS_ERROR_LOG_INTERVAL_MS) {
          logger.warn(`WS errors suppressed`, {
            error: errorMsg,
            count: entry.count,
            windowSeconds: Math.round((now - entry.lastLoggedAt) / 1000),
          });
          entry.count = 0;
          entry.lastLoggedAt = now;
        }
      } else {
        // First occurrence — log it once then suppress
        wsErrorCounts.set(errorMsg, { count: 0, lastLoggedAt: now });
        logger.warn(`WS error (will suppress repeats for 30s)`, { error: errorMsg });
      }
      return; // suppress the console.error
    }

    // Pass through all other console.error calls
    _originalConsoleError.apply(console, args);
  };

  logger.info('[wsControl] WS error suppression installed');
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
