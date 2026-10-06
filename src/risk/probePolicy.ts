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

/** Records at or below this size (USD) are $1 paper probes. Covers records written before TradeRecord.isProbe existed. */
export const PROBE_RECORD_MAX_USD = 1.01;

/**
 * True for a $1 paper probe. Probes carry no real capital risk and come from
 * signals the optimizer rejected, so they are kept out of the risk counters, the
 * learner, the paper-gate statistics and the edge statistics.
 */
export function isProbeTrade(t: { isProbe?: boolean; sizeUSD?: number }): boolean {
  return (
    t.isProbe === true ||
    (typeof t.sizeUSD === 'number' && t.sizeUSD > 0 && t.sizeUSD <= PROBE_RECORD_MAX_USD)
  );
}
