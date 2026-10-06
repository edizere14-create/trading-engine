/**
 * Minimum pool liquidity for copy-trades (SINGLE_WALLET signals).
 *
 * belowWalletLiquidityFloor() returns true when a wallet-path signal should be
 * blocked because the pool liquidity we know about is below the floor.
 *
 * - Off by default: a floor of 0 never blocks (MIN_WALLET_POOL_LIQUIDITY_SOL).
 * - Wallet path only. Graduation, autonomous, hybrid, toxic-flow and
 *   smart-money signals are never affected.
 * - Unknown liquidity is allowed. Only a known value below the floor blocks, so
 *   a missing figure can't turn the floor into a blanket block.
 *
 * Caveat: the figure is the pool's recorded INITIAL liquidity. For pools seen
 * through the LP stream it is estimated from the creator's balance change, so a
 * pool created empty and funded later reads as tiny (Meteora DLMM pools show
 * about 0.025 SOL, which is account rent). That is why the floor ships off and
 * the gate only counts, at the recommended value, what it would have blocked.
 */

/** Value used to measure the floor's cost while enforcement is off. */
export const RECOMMENDED_WALLET_LIQUIDITY_FLOOR_SOL = 5;

export function belowWalletLiquidityFloor(
  source: string,
  floorSOL: number,
  poolLiquiditySOL: number | undefined
): boolean {
  return (
    source === 'SINGLE_WALLET' &&
    floorSOL > 0 &&
    poolLiquiditySOL !== undefined &&
    poolLiquiditySOL < floorSOL
  );
}
