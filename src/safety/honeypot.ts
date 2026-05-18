/**
 * Honeypot check via Jupiter sell-quote.
 *
 * Two exported functions:
 *
 *   checkHoneypot()                       — single-pass probe, used when caller
 *                                            cannot afford deferred-probe latency
 *   checkHoneypotWithDeferredProbe()      — adds T+5s re-probe for 4xx responses
 *                                            (Jupiter's "no route yet" signal),
 *                                            resolving indexing-lag ambiguity
 *
 * Calls Jupiter's quote API to verify the token is sellable (tokenCA → WSOL).
 * Classifies the response into one of four buckets defined by HoneypotClassification.
 *
 * Design decisions baked in:
 *
 * - Single attempt within budget (no in-budget retry). Round-1 sellability data
 *   (n=26) showed Jupiter indexing latency is bimodal: ~22% fast (<200ms),
 *   ~78% slow (~2.7s), gap 500ms-2s is empty. In-budget retries are structurally
 *   useless. The deferred-probe variant addresses this with a T+5s wait that
 *   sits past the slow-index tail.
 *
 * - Budget enforced via Promise.race. axios `timeout` config alone is not
 *   sufficient — DNS hangs and connection-establish hangs can blow past it.
 *   Promise.race against setTimeout sentinel gives a hard wall.
 *
 * - Circuit breaker integration is opt-in via the optional AntifragileEngine
 *   parameter. When breaker is OPEN, skip the HTTP call entirely. On 2xx
 *   success, recordJupiterSuccess. On network error or 5xx, recordJupiterFailure.
 *   On 4xx, do NOT record failure — 4xx means Jupiter is healthy but doesn't
 *   have this pool yet, not a Jupiter health signal. On Promise.race timeout,
 *   do NOT record failure — timeout is ambiguous.
 *
 * - UNCONFIRMED threshold = 50% priceImpactPct. Permissive starting point;
 *   soak data tunes from there.
 *
 * - Malformed response (NaN priceImpactPct) → INDEX_LAG, not CLEAN.
 *
 * - NOT_ROUTABLE only emitted by checkHoneypotWithDeferredProbe. The original
 *   checkHoneypot maps 4xx to INDEX_LAG (cannot distinguish "no pool ever" from
 *   "no pool yet" without waiting past the indexing tail).
 *
 * - Re-probe scope is 4xx-only. Timeouts, 5xx, breaker-open, and malformed
 *   responses do NOT trigger re-probe — those are Jupiter health or transport
 *   signals, not indexing-lag candidates. Re-probing them would conflate
 *   "is Jupiter indexing this token?" with "is Jupiter operational?".
 */

import axios, { AxiosError } from 'axios';
import { HoneypotClassification } from '../core/types';
import { AntifragileEngine } from '../antifragile/antifragileEngine';

const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 100;
const UNCONFIRMED_PRICE_IMPACT_THRESHOLD_PCT = 50;
export const DEFERRED_PROBE_DELAY_MS = 5000;

export interface HoneypotResult {
  passed: boolean;
  classification: HoneypotClassification;
  sellQuoteSlippagePct?: number;
  durationMs: number;
}

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
}

/**
 * Discriminated outcome of a single Jupiter quote call.
 *
 * Distinguishes 4xx ("Jupiter is healthy, no route for this token") from
 * other error paths (timeout, 5xx, network, breaker-open, malformed body)
 * because only 4xx is the canonical indexing-lag signal worth re-probing.
 */
type QuoteOutcome =
  | { kind: 'ok'; priceImpactPct: number }
  | { kind: 'no-route' }      // 4xx — Jupiter healthy, no pool route
  | { kind: 'timeout' }        // Promise.race timeout sentinel
  | { kind: 'breaker-open' }   // antifragile circuit denied call
  | { kind: 'malformed' }      // 2xx but priceImpactPct unparseable
  | { kind: 'error' };         // 5xx, network, other (records breaker failure)

async function fetchJupiterQuote(
  tokenCA: string,
  testAmountLamports: bigint,
  budgetMs: number,
  antifragile?: AntifragileEngine,
): Promise<QuoteOutcome> {
  if (antifragile && !antifragile.canUseJupiter()) {
    return { kind: 'breaker-open' };
  }

  const url = `${JUPITER_API}/quote`;
  const params = {
    inputMint: tokenCA,
    outputMint: WSOL_MINT,
    amount: testAmountLamports.toString(),
    slippageBps: SLIPPAGE_BPS,
  };

  let timeoutHandle: NodeJS.Timeout | undefined;
  const budgetPromise = new Promise<'TIMEOUT'>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('TIMEOUT'), budgetMs);
  });

  try {
    const result = await Promise.race([
      axios.get<JupiterQuoteResponse>(url, { params, timeout: budgetMs }),
      budgetPromise,
    ]);

    if (result === 'TIMEOUT') {
      return { kind: 'timeout' };
    }

    const priceImpactPct = parseFloat(result.data.priceImpactPct);
    antifragile?.recordJupiterSuccess();

    if (!Number.isFinite(priceImpactPct)) {
      return { kind: 'malformed' };
    }

    return { kind: 'ok', priceImpactPct };
  } catch (err) {
    const status = (err as AxiosError)?.response?.status;

    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Jupiter is healthy, just has no route. Don't penalize breaker.
      return { kind: 'no-route' };
    }

    // Network error or 5xx: Jupiter itself is misbehaving.
    antifragile?.recordJupiterFailure();
    return { kind: 'error' };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Map a QuoteOutcome to a HoneypotResult.
 *
 * The `noRouteAs` parameter is the only divergence between callers:
 *   - checkHoneypot maps 'no-route' to INDEX_LAG (no waiting; we can't tell
 *     "no pool ever" from "no pool yet" without the deferred probe).
 *   - checkHoneypotWithDeferredProbe's deferred call maps 'no-route' to
 *     NOT_ROUTABLE (we've waited past the indexing-lag tail; this is the
 *     resolved state).
 *
 * All other variants map identically across callers.
 */
function mapOutcome(
  outcome: QuoteOutcome,
  start: number,
  noRouteAs: HoneypotClassification,
): HoneypotResult {
  const durationMs = performance.now() - start;
  switch (outcome.kind) {
    case 'ok':
      return outcome.priceImpactPct > UNCONFIRMED_PRICE_IMPACT_THRESHOLD_PCT
        ? { passed: false, classification: 'UNCONFIRMED', sellQuoteSlippagePct: outcome.priceImpactPct, durationMs }
        : { passed: true,  classification: 'CLEAN',       sellQuoteSlippagePct: outcome.priceImpactPct, durationMs };
    case 'no-route':
      return { passed: false, classification: noRouteAs, durationMs };
    default:
      // timeout, breaker-open, malformed, error all map to INDEX_LAG
      return { passed: false, classification: 'INDEX_LAG', durationMs };
  }
}

/**
 * Single-pass honeypot check. 4xx responses classified as INDEX_LAG.
 */
export async function checkHoneypot(
  tokenCA: string,
  testAmountLamports: bigint,
  budgetMs: number,
  antifragile?: AntifragileEngine,
): Promise<HoneypotResult> {
  const start = performance.now();
  const outcome = await fetchJupiterQuote(tokenCA, testAmountLamports, budgetMs, antifragile);
  return mapOutcome(outcome, start, 'INDEX_LAG');
}

/**
 * Honeypot check with deferred re-probe on 4xx responses.
 *
 * If the first probe returns 'no-route' (4xx — Jupiter healthy, no pool yet),
 * waits deferredProbeDelayMs (default 5s, past the bimodal slow-index tail),
 * then re-probes. The re-probe's outcome determines the final classification:
 *
 *   - 4xx again (no-route)    → NOT_ROUTABLE (resolved: pool genuinely absent)
 *   - 2xx ok (CLEAN/UNCONF)   → CLEAN or UNCONFIRMED (indexing caught up)
 *   - timeout/error/etc.      → INDEX_LAG (degraded; re-probe inconclusive)
 *
 * Non-4xx first-probe outcomes pass through immediately — no waiting.
 *
 * deferredProbeDelayMs is parameterized for test injection (small values
 * in unit tests, default 5000ms in production). Threading this through
 * upper layers is intentionally avoided; integration tests use fake timers.
 */
export async function checkHoneypotWithDeferredProbe(
  tokenCA: string,
  testAmountLamports: bigint,
  budgetMs: number,
  antifragile?: AntifragileEngine,
  deferredProbeDelayMs: number = DEFERRED_PROBE_DELAY_MS,
): Promise<HoneypotResult> {
  const start = performance.now();

  const firstOutcome = await fetchJupiterQuote(tokenCA, testAmountLamports, budgetMs, antifragile);

  if (firstOutcome.kind !== 'no-route') {
    return mapOutcome(firstOutcome, start, 'INDEX_LAG');
  }

  // 4xx at T0 — wait past the indexing tail, then re-probe.
  await new Promise((resolve) => setTimeout(resolve, deferredProbeDelayMs));

  const secondOutcome = await fetchJupiterQuote(tokenCA, testAmountLamports, budgetMs, antifragile);

  return mapOutcome(secondOutcome, start, 'NOT_ROUTABLE');
}
