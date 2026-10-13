import { ExitMode } from '../core/types';

/**
 * Exit-reason prefix -> exit mode.
 *
 * Every reason string a position can close with must start with one of these keys. A reason that
 * matches none is journaled as UNKNOWN, which the validation metrics exclude, so a missing prefix
 * silently drops trades from the statistics. That happened to EARLY_STOP: five $1 probe closes on
 * Oct 5 sit in the journal as UNKNOWN from before it was mapped. CURVE_SAFETY_EXIT, the exit
 * HybridPowerPlay makes through forceClose, had the same gap, found by reading the code; no such
 * close has been recorded yet. A new way to close a position needs its prefix added here;
 * tests/exitMode.test.ts drives the PositionManager close paths to catch a miss.
 */
export const EXIT_REASON_PREFIXES: Record<string, ExitMode> = {
  HARD_STOP: 'HARD_STOP',
  EARLY_STOP: 'EARLY_STOP',
  TRAILING_STOP: 'TRAILING_STOP',
  TP_TIER_4: 'TP_TIER_4',
  MAX_HOLD: 'MAX_HOLD',
  STALE_EXIT: 'STALE_EXIT',
  EMERGENCY: 'EMERGENCY',
  RUG_TRIGGER: 'RUG_TRIGGER',
  CURVE_SAFETY_EXIT: 'CURVE_SAFETY_EXIT',
};

/** The exit mode for a PositionManager exit reason, or UNKNOWN when nothing matches. */
export function resolveExitMode(exitReason: string | undefined): ExitMode {
  if (!exitReason) return 'UNKNOWN';
  const prefix = Object.keys(EXIT_REASON_PREFIXES).find((k) => exitReason.startsWith(k));
  return prefix === undefined ? 'UNKNOWN' : EXIT_REASON_PREFIXES[prefix];
}
