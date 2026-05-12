/**
 * Honeypot check via Jupiter sell-quote.
 *
 * Calls Jupiter's quote API to verify the token is sellable (tokenCA → WSOL).
 * Classifies the response into one of four buckets defined by HoneypotClassification.
 *
 * Design decisions baked in:
 *
 * - Single attempt, no retry. Round-1 sellability data (n=26) showed Jupiter
 *   indexing latency is bimodal: ~22% fast (<200ms), ~78% slow (~2.7s), gap
 *   500ms-2s is empty. No retry within budget catches the slow class, so
 *   retries are structurally useless. attempts: 1.
 *
 * - Budget enforced via Promise.race. axios `timeout` config alone is not
 *   sufficient — DNS hangs and connection-establish hangs can blow past it.
 *   Promise.race against setTimeout sentinel gives a hard wall.
 *
 * - Circuit breaker integration is opt-in via the optional AntifragileEngine
 *   parameter. When breaker is OPEN, skip the HTTP call entirely and return
 *   INDEX_LAG (honest classification: Jupiter recently unreliable, sellability
 *   unverifiable). On 2xx success, recordJupiterSuccess. On network error or
 *   5xx, recordJupiterFailure. On 4xx, do NOT record failure — 4xx means
 *   Jupiter is healthy but doesn't have this pool yet, not a Jupiter health
 *   signal. On Promise.race timeout, do NOT record failure — timeout is
 *   ambiguous (could be Jupiter, network, or DNS).
 *
 * - UNCONFIRMED threshold = 50% priceImpactPct. Permissive starting point;
 *   soak data tunes from there. False negatives (let some through) are
 *   recoverable via downstream exit logic; aggressive false positives reject
 *   real launches.
 *
 * - Malformed response (NaN priceImpactPct) → INDEX_LAG, not CLEAN. "Can't
 *   verify" is more honest than "passes by default" when the response body
 *   is unparseable.
 *
 * v2 baseline: only CLEAN passes. INDEX_LAG and UNCONFIRMED both reject.
 * NOT_ROUTABLE is reserved in the type for day 4+ deferred-probe extension;
 * not emitted in day 3.
 */

import axios, { AxiosError } from 'axios';
import { HoneypotClassification } from '../core/types';
import { AntifragileEngine } from '../antifragile/antifragileEngine';

const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const SLIPPAGE_BPS = 100;
const UNCONFIRMED_PRICE_IMPACT_THRESHOLD_PCT = 50;

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

export async function checkHoneypot(
  tokenCA: string,
  testAmountLamports: bigint,
  budgetMs: number,
  antifragile?: AntifragileEngine,
): Promise<HoneypotResult> {
  const start = performance.now();

  // Breaker is open: skip HTTP call, return INDEX_LAG (Jupiter unverifiable).
  if (antifragile && !antifragile.canUseJupiter()) {
    return {
      passed: false,
      classification: 'INDEX_LAG',
      durationMs: performance.now() - start,
    };
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
      return {
        passed: false,
        classification: 'INDEX_LAG',
        durationMs: performance.now() - start,
      };
    }

    const priceImpactPct = parseFloat(result.data.priceImpactPct);

    antifragile?.recordJupiterSuccess();

    // Malformed response body: priceImpactPct unparseable. Treat as
    // unverifiable rather than CLEAN. False positive (reject a clean token
    // because Jupiter returned a weird body) is preferable to false negative
    // (let through a sell-tax token because we couldn't parse the impact).
    if (!Number.isFinite(priceImpactPct)) {
      return {
        passed: false,
        classification: 'INDEX_LAG',
        durationMs: performance.now() - start,
      };
    }

    if (priceImpactPct > UNCONFIRMED_PRICE_IMPACT_THRESHOLD_PCT) {
      return {
        passed: false,
        classification: 'UNCONFIRMED',
        sellQuoteSlippagePct: priceImpactPct,
        durationMs: performance.now() - start,
      };
    }

    return {
      passed: true,
      classification: 'CLEAN',
      sellQuoteSlippagePct: priceImpactPct,
      durationMs: performance.now() - start,
    };
  } catch (err) {
    const status = (err as AxiosError)?.response?.status;

    if (typeof status === 'number' && status >= 400 && status < 500) {
      // 4xx: Jupiter is healthy, just doesn't have this pool yet. Don't penalize breaker.
      return {
        passed: false,
        classification: 'INDEX_LAG',
        durationMs: performance.now() - start,
      };
    }

    // Network error or 5xx: Jupiter itself is misbehaving. Record breaker failure.
    antifragile?.recordJupiterFailure();
    return {
      passed: false,
      classification: 'INDEX_LAG',
      durationMs: performance.now() - start,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
