/**
 * Phase B: async parallel safety pipeline.
 *
 * Runs three checks concurrently with per-check budget enforcement:
 *   1. tokenSafetyChecker.check() — mintAuthority, freezeAuthority,
 *      holderConcentration, lpLock (4 atomic signals via TokenSafetyResult)
 *   2. checkHoneypot() — Jupiter sell-quote classification
 *   3. checkDeployerBlacklist() — stub-pass in v2 baseline
 *
 * Each check is wrapped with a per-check budget. honeypot enforces its own
 * via Promise.race internally; tokenSafetyChecker is wrapped here via
 * withTimeout; deployerBlacklist is sync-instant (no wrapping needed).
 *
 * Phase B awaits Promise.all and trusts each check to honor its budget.
 * No global Promise.race needed. Cleaner code, full trace fidelity even
 * when individual checks time out.
 *
 * failedCheck resolution: declared order. When multiple checks fail
 * simultaneously, the first in this order wins:
 *   lpLock → mintAuthority → freezeAuthority → holderConcentration →
 *   honeypot → deployerBlacklist
 *
 * The trace always populates all fields (every check returns a result,
 * even on timeout). Telemetry sees the full picture; failedCheck is just
 * the "primary reject reason" pointer for logs.
 */

import { PumpSwapGraduationEvent, SafetyCheckTrace, TokenSafetyResult } from '../core/types';
import { TokenSafetyChecker } from './tokenSafetyChecker';
import { checkHoneypot, HoneypotResult } from './honeypot';
import { checkDeployerBlacklist, DeployerBlacklistResult } from './deployerBlacklist';
import { AntifragileEngine } from '../antifragile/antifragileEngine';

const HONEYPOT_TEST_AMOUNT_LAMPORTS = 1_000_000n;

export type PhaseBFailedCheck =
  | 'lpLock'
  | 'mintAuthority'
  | 'freezeAuthority'
  | 'holderConcentration'
  | 'honeypot'
  | 'deployerBlacklist';

export type PhaseBTrace = Pick<
  SafetyCheckTrace,
  'lpLock' | 'mintAuthority' | 'freezeAuthority' | 'holderConcentration' | 'honeypot' | 'deployerBlacklist'
>;

export interface PhaseBResult {
  passed: boolean;
  failedCheck?: PhaseBFailedCheck;
  trace: PhaseBTrace;
  durationMs: number;
}

const TIMEOUT_SENTINEL = Symbol('TIMEOUT');
type TimeoutSentinel = typeof TIMEOUT_SENTINEL;

async function withTimeout<T>(
  promise: Promise<T>,
  budgetMs: number,
): Promise<T | TimeoutSentinel> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<TimeoutSentinel>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), budgetMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function isTimeout(value: unknown): value is TimeoutSentinel {
  return value === TIMEOUT_SENTINEL;
}

export async function runPhaseB(
  event: PumpSwapGraduationEvent,
  tokenSafetyChecker: TokenSafetyChecker,
  budgetMs: number,
  antifragile?: AntifragileEngine,
): Promise<PhaseBResult> {
  const start = performance.now();

  // Kick off all three checks in parallel.
  const tokenSafetyP = withTimeout(
    tokenSafetyChecker.check(event.tokenCA),
    budgetMs,
  );
  const honeypotP = checkHoneypot(
    event.tokenCA,
    HONEYPOT_TEST_AMOUNT_LAMPORTS,
    budgetMs,
    antifragile,
  );
  const deployerP = checkDeployerBlacklist(event.deployer);

  const [tokenSafetyResult, honeypotResult, deployerResult]: [
    TokenSafetyResult | TimeoutSentinel,
    HoneypotResult,
    DeployerBlacklistResult,
  ] = await Promise.all([tokenSafetyP, honeypotP, deployerP]);

  // Map tokenSafety to four atomic trace fields. On timeout, all four fail.
  const tokenSafetyTimedOut = isTimeout(tokenSafetyResult);
  const ts: TokenSafetyResult | null = tokenSafetyTimedOut ? null : tokenSafetyResult;

  const trace: PhaseBTrace = {
    lpLock: {
      passed: ts?.lpLocked ?? false,
      locked: ts?.lpLocked ?? false,
    },
    mintAuthority: {
      passed: ts?.mintAuthRevoked ?? false,
      revoked: ts?.mintAuthRevoked ?? false,
    },
    freezeAuthority: {
      passed: ts?.freezeAuthRevoked ?? false,
      revoked: ts?.freezeAuthRevoked ?? false,
    },
    holderConcentration: {
      passed: ts?.holderConcentrationOk ?? false,
      topPct: (ts?.topHolderPct ?? 0) * 100,
    },
    honeypot: {
      passed: honeypotResult.passed,
      classification: honeypotResult.classification,
      sellQuoteSlippagePct: honeypotResult.sellQuoteSlippagePct,
    },
    deployerBlacklist: {
      passed: deployerResult.passed,
    },
  };

  // failedCheck resolution: declared order.
  let failedCheck: PhaseBFailedCheck | undefined;
  if (!trace.lpLock.passed)              failedCheck = 'lpLock';
  else if (!trace.mintAuthority.passed)        failedCheck = 'mintAuthority';
  else if (!trace.freezeAuthority.passed)      failedCheck = 'freezeAuthority';
  else if (!trace.holderConcentration.passed)  failedCheck = 'holderConcentration';
  else if (!trace.honeypot.passed)             failedCheck = 'honeypot';
  else if (!trace.deployerBlacklist.passed)    failedCheck = 'deployerBlacklist';

  return {
    passed: failedCheck === undefined,
    failedCheck,
    trace,
    durationMs: performance.now() - start,
  };
}
