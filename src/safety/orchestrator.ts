/**
 * Safety pipeline orchestrator: Phase A → Phase B composition.
 *
 * Phase A runs synchronously (liquidity, scammyName). If it fails, the
 * pipeline short-circuits without invoking Phase B. This is the whole
 * point of the two-phase split: protect Phase B's RPC and HTTP budget
 * from being burned on candidates we can already reject for free.
 *
 * If Phase A passes, Phase B runs (mintAuthority, freezeAuthority,
 * holderConcentration, lpLock, honeypot, deployerBlacklist) with a
 * 500ms parallel budget enforced internally.
 *
 * Policy decisions live here, not in the phases:
 *   - PHASE_B_BUDGET_MS = 500: tunable from soak data without touching
 *     Phase B's mechanism.
 *   - Phase A failure short-circuits unconditionally. There is no
 *     "force-run Phase B anyway" mode in v2.
 *
 * Return shape: nested phase results preserve attribution. The outer
 * `passed` is the verdict; `failedPhase` says which phase rejected;
 * inner phase results carry their own `failedCheck` for the specific
 * gate. trace is `Partial<SafetyCheckTrace>` — on Phase A short-circuit
 * the Phase B fields are absent, not placeholder-filled. Absence is
 * honest; placeholders create read-time ambiguity.
 */

import { PumpSwapGraduationEvent, SafetyCheckTrace } from '../core/types';
import { TokenSafetyChecker } from './tokenSafetyChecker';
import { AntifragileEngine } from '../antifragile/antifragileEngine';
import { runPhaseA, PhaseAResult } from './phaseA';
import { runPhaseB, PhaseBResult } from './phaseB';

const PHASE_B_BUDGET_MS = 500;

export interface SafetyPipelineResult {
  passed: boolean;
  failedPhase?: 'A' | 'B';
  phaseA: PhaseAResult;
  phaseB?: PhaseBResult;
  trace: Partial<SafetyCheckTrace>;
  durationMs: number;
}

export async function runSafetyPipeline(
  event: PumpSwapGraduationEvent,
  tokenSafetyChecker: TokenSafetyChecker,
  tokenName?: string | null,
  antifragile?: AntifragileEngine,
): Promise<SafetyPipelineResult> {
  const start = performance.now();

  const phaseA = runPhaseA(event, tokenName);

  if (!phaseA.passed) {
    return {
      passed: false,
      failedPhase: 'A',
      phaseA,
      trace: { ...phaseA.trace },
      durationMs: performance.now() - start,
    };
  }

  const phaseB = await runPhaseB(
    event,
    tokenSafetyChecker,
    PHASE_B_BUDGET_MS,
    antifragile,
  );

  return {
    passed: phaseB.passed,
    failedPhase: phaseB.passed ? undefined : 'B',
    phaseA,
    phaseB,
    trace: { ...phaseA.trace, ...phaseB.trace },
    durationMs: performance.now() - start,
  };
}