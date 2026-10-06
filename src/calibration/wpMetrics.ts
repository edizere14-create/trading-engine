/**
 * Win-probability quality metrics for the paper gate.
 *
 * The gate used to compare each trade's predicted win probability to its 0/1
 * outcome with a mean absolute error. For binary outcomes that cannot drop much
 * below 2p(1-p) even for a perfectly calibrated model (0.5 at p = 0.5), so a
 * 15% limit was unreachable. Two separate questions replace it:
 *
 *  - Calibration: when the model says 70%, do about 70% of those trades win?
 *    (reliability gap, below)
 *  - Discrimination: does it give winners higher probabilities than losers?
 *    (AUC, below)
 *
 * Neither is enough alone: a model that always predicts the base rate is
 * perfectly calibrated and useless; a model that ranks well can be badly
 * calibrated. The gate requires both.
 */

export const CALIBRATION_BUCKETS = 10;
/** z for a two-sided 95% interval. */
export const Z_95 = 1.96;
/** A probability bucket needs this many trades before it is used (same rule as the online learner). */
export const MIN_BUCKET_TRADES = 5;

export interface WpSample {
  predictedWP: number;
  won: boolean;
}

export interface WpEvaluation {
  n: number;
  wins: number;
  losses: number;
  /** Mean |bucket centre - observed win rate| over buckets with enough trades; null if none qualify. */
  calibrationError: number | null;
  /** How many of the CALIBRATION_BUCKETS buckets had enough trades. */
  calibrationBuckets: number;
  /** Probability a random winner was given a higher prediction than a random loser (ties count half); null unless both classes exist. */
  auc: number | null;
  /** Hanley-McNeil standard error of the AUC; null with it. */
  aucStdErr: number | null;
  /** auc - 1.96 * aucStdErr: the lower end of a 95% interval. Above 0.5 means better than random with confidence. */
  aucLower95: number | null;
}

function aucOf(samples: WpSample[], pos: number, neg: number): number {
  const sorted = [...samples].sort((a, b) => a.predictedWP - b.predictedWP);
  let rankSumPos = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].predictedWP === sorted[i].predictedWP) j++;
    const avgRank = (i + j) / 2 + 1; // tied predictions share their average rank
    for (let k = i; k <= j; k++) if (sorted[k].won) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

function aucStdErrOf(auc: number, pos: number, neg: number): number {
  const q1 = auc / (2 - auc);
  const q2 = (2 * auc * auc) / (1 + auc);
  const variance =
    (auc * (1 - auc) + (pos - 1) * (q1 - auc * auc) + (neg - 1) * (q2 - auc * auc)) / (pos * neg);
  return Math.sqrt(Math.max(0, variance));
}

export function evaluateWinProbability(input: WpSample[]): WpEvaluation {
  const samples = input.filter((s) => Number.isFinite(s.predictedWP));
  const n = samples.length;
  const wins = samples.filter((s) => s.won).length;
  const losses = n - wins;

  // Calibration: reliability gap across probability buckets
  const bucketTotal = new Array<number>(CALIBRATION_BUCKETS).fill(0);
  const bucketWins = new Array<number>(CALIBRATION_BUCKETS).fill(0);
  for (const s of samples) {
    const b = Math.min(CALIBRATION_BUCKETS - 1, Math.max(0, Math.floor(s.predictedWP * CALIBRATION_BUCKETS)));
    bucketTotal[b]++;
    if (s.won) bucketWins[b]++;
  }
  let gap = 0;
  let used = 0;
  for (let b = 0; b < CALIBRATION_BUCKETS; b++) {
    if (bucketTotal[b] < MIN_BUCKET_TRADES) continue;
    const centre = (b + 0.5) / CALIBRATION_BUCKETS;
    gap += Math.abs(centre - bucketWins[b] / bucketTotal[b]);
    used++;
  }

  // Discrimination: AUC (needs both classes)
  let auc: number | null = null;
  let aucStdErr: number | null = null;
  if (wins > 0 && losses > 0) {
    auc = aucOf(samples, wins, losses);
    aucStdErr = aucStdErrOf(auc, wins, losses);
  }

  return {
    n,
    wins,
    losses,
    calibrationError: used > 0 ? gap / used : null,
    calibrationBuckets: used,
    auc,
    aucStdErr,
    aucLower95: auc !== null && aucStdErr !== null ? auc - Z_95 * aucStdErr : null,
  };
}
