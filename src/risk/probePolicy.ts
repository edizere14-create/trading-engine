/**
 * When the portfolio optimizer rejects a signal (recommended size under $1),
 * paper mode can open a $1 probe instead of blocking, to keep collecting data
 * (PAPER_PROBE_ON_OPT_REJECT). Copy-trades are excluded: a wallet signal the
 * optimizer rejects is blocked, so the optimizer acts as a second screen for
 * the path with no other quality check. Graduation, autonomous, hybrid,
 * toxic-flow and smart-money signals keep the probe fallback.
 *
 * Never applies outside paper mode: a live trade the optimizer rejects is
 * always blocked.
 */
export function shouldUseProbeFallback(
  isPaperMode: boolean,
  probeEnabled: boolean,
  source: string
): boolean {
  return isPaperMode && probeEnabled && source !== 'SINGLE_WALLET';
}
