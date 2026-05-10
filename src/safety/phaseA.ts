/**
 * Phase A: synchronous hard-gate checks.
 *
 * Sub-millisecond, no I/O, fast-fail order. If any check fails, return
 * immediately without running the rest. This protects the Phase B RPC
 * budget from being consumed on candidates that can be rejected for free.
 *
 * v2 scope: PumpSwap graduations only. Phase A here covers:
 *   - liquidity (≥3 SOL initial liquidity)
 *   - scammyName (regex against obvious scam markers)
 *
 * lpLock lives in Phase B because it's conceptually an on-chain check,
 * even though for PumpSwap it's currently locked-by-construction. Keeping
 * the architecture honest now avoids refactoring when v2 extends to DEXes
 * where LP locking varies per-pool.
 */

import { PumpSwapGraduationEvent, SafetyCheckTrace } from '../core/types';
import { checkScammyName } from './scammyName';

const MIN_LIQUIDITY_SOL = 3;

export type PhaseAFailedCheck = 'liquidity' | 'scammyName';

export type PhaseATrace = Pick<SafetyCheckTrace, 'liquidity' | 'scammyName'>;

export interface PhaseAResult {
  passed: boolean;
  failedCheck?: PhaseAFailedCheck;
  trace: Partial<PhaseATrace>;
  durationMs: number;
}

export function runPhaseA(
  event: PumpSwapGraduationEvent,
  tokenName?: string | null,
): PhaseAResult {
  const start = performance.now();
  const trace: Partial<PhaseATrace> = {};

  // Check 1: liquidity (cheapest, runs first)
  const liquidityPassed = event.initialLiquiditySOL >= MIN_LIQUIDITY_SOL;
  trace.liquidity = {
    passed: liquidityPassed,
    valueSOL: event.initialLiquiditySOL,
  };
  if (!liquidityPassed) {
    return {
      passed: false,
      failedCheck: 'liquidity',
      trace,
      durationMs: performance.now() - start,
    };
  }

  // Check 2: scammyName
  const nameResult = checkScammyName(tokenName);
  trace.scammyName = { passed: nameResult.passed };
  if (!nameResult.passed) {
    return {
      passed: false,
      failedCheck: 'scammyName',
      trace,
      durationMs: performance.now() - start,
    };
  }

  return {
    passed: true,
    trace,
    durationMs: performance.now() - start,
  };
}
