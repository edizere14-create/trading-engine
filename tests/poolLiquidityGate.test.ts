import { belowWalletLiquidityFloor, RECOMMENDED_WALLET_LIQUIDITY_FLOOR_SOL } from '../src/risk/poolLiquidityGate';

describe('belowWalletLiquidityFloor', () => {
  it('never blocks when the floor is 0 (default, off)', () => {
    expect(belowWalletLiquidityFloor('SINGLE_WALLET', 0, 0.025)).toBe(false);
    expect(belowWalletLiquidityFloor('SINGLE_WALLET', 0, 0)).toBe(false);
  });

  it('blocks a wallet signal whose known pool liquidity is below the floor', () => {
    expect(belowWalletLiquidityFloor('SINGLE_WALLET', 5, 0.025)).toBe(true);
    expect(belowWalletLiquidityFloor('SINGLE_WALLET', 5, 4.99)).toBe(true);
  });

  it('allows a wallet signal at or above the floor', () => {
    expect(belowWalletLiquidityFloor('SINGLE_WALLET', 5, 5)).toBe(false);
    expect(belowWalletLiquidityFloor('SINGLE_WALLET', 5, 67.4)).toBe(false);
  });

  it('allows a wallet signal when liquidity is unknown', () => {
    expect(belowWalletLiquidityFloor('SINGLE_WALLET', 5, undefined)).toBe(false);
  });

  it('never affects non-wallet sources, even with tiny liquidity', () => {
    expect(belowWalletLiquidityFloor('AUTONOMOUS', 5, 0.025)).toBe(false);
    expect(belowWalletLiquidityFloor('CLUSTER', 5, 0.025)).toBe(false);
    expect(belowWalletLiquidityFloor('UNKNOWN', 5, 0)).toBe(false);
  });

  it('does not block on a NaN figure', () => {
    expect(belowWalletLiquidityFloor('SINGLE_WALLET', 5, NaN)).toBe(false);
  });

  it('the recommended measurement floor is 5 SOL', () => {
    expect(RECOMMENDED_WALLET_LIQUIDITY_FLOOR_SOL).toBe(5);
    expect(belowWalletLiquidityFloor('SINGLE_WALLET', RECOMMENDED_WALLET_LIQUIDITY_FLOOR_SOL, 0.025)).toBe(true);
  });
});
