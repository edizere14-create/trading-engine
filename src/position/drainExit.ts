/**
 * Paper exit price for a vault-drain RUG_TRIGGER.
 *
 * The vault stream detects that one transaction took `dropPct` percent of the pool's SOL, but it
 * has no price, and closing at the last known price books the position as breakeven however big the
 * drain was. For a constant-product pool (PumpSwap is one) the spot price is SOL reserve squared over
 * k, so a sale that leaves a fraction `r` of the SOL side puts the price at about r^2 of what it was.
 * That assumes one sale did the drain and that the last price was current; it is an estimate, and
 * deliberately not a flattering one.
 */

/** Never estimate a price of exactly zero: a 100% drain is capped at 0.1% of the SOL left. */
const MIN_REMAINING_FRACTION = 0.001;

export function estimateDrainExitPrice(lastPriceSOL: number, dropPct: number): number | undefined {
  if (!Number.isFinite(lastPriceSOL) || lastPriceSOL <= 0) return undefined;
  if (!Number.isFinite(dropPct) || dropPct <= 0) return undefined;
  const remaining = Math.max(1 - dropPct / 100, MIN_REMAINING_FRACTION);
  return lastPriceSOL * remaining * remaining;
}
