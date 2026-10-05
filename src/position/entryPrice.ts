/**
 * Entry price for a new position.
 *
 * Returns the price unchanged when it is a finite number above zero, otherwise
 * 0. A 0 entry price is the "unknown" marker PositionManager understands: it
 * anchors the entry on the first valid price tick and evaluates no exits on
 * that tick (see PositionManager.updatePrice).
 *
 * Never clamp a real price upward. Pump-style tokens commonly trade below
 * 1e-6 SOL per token, so a floor such as Math.max(price, 0.000001) silently
 * replaces a genuine entry with a made-up one (1000 lamports), and every later
 * multiple measured against it is meaningless.
 */
export function usableEntryPrice(priceSOL: number): number {
  return Number.isFinite(priceSOL) && priceSOL > 0 ? priceSOL : 0;
}
