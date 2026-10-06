import { evaluateWinProbability, WpSample } from '../src/calibration/wpMetrics';

function bruteAuc(samples: WpSample[]): number {
  let num = 0;
  let pairs = 0;
  for (const a of samples) {
    if (a.won === false) continue;
    for (const b of samples) {
      if (b.won) continue;
      pairs++;
      num += a.predictedWP > b.predictedWP ? 1 : a.predictedWP === b.predictedWP ? 0.5 : 0;
    }
  }
  return num / pairs;
}

function many(p: number, wins: number, losses: number): WpSample[] {
  return [
    ...Array.from({ length: wins }, () => ({ predictedWP: p, won: true })),
    ...Array.from({ length: losses }, () => ({ predictedWP: p, won: false })),
  ];
}

describe('AUC', () => {
  it('is 1 when every winner outranks every loser, 0 when reversed, 0.5 when predictions are constant', () => {
    expect(evaluateWinProbability([...many(0.9, 10, 0), ...many(0.2, 0, 10)]).auc).toBe(1);
    expect(evaluateWinProbability([...many(0.2, 10, 0), ...many(0.9, 0, 10)]).auc).toBe(0);
    expect(evaluateWinProbability(many(0.5, 10, 10)).auc).toBe(0.5);
  });

  it('matches a brute-force pairwise count on pseudo-random data with ties', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const samples: WpSample[] = Array.from({ length: 300 }, () => {
      const p = Math.round(rnd() * 20) / 20; // coarse values force ties
      return { predictedWP: p, won: rnd() < p * 0.8 + 0.1 };
    });
    expect(evaluateWinProbability(samples).auc).toBeCloseTo(bruteAuc(samples), 10);
  });

  it('is null unless both outcomes are present', () => {
    expect(evaluateWinProbability(many(0.6, 10, 0)).auc).toBeNull();
    expect(evaluateWinProbability(many(0.6, 0, 10)).auc).toBeNull();
    expect(evaluateWinProbability([]).auc).toBeNull();
  });

  it('reports a standard error that shrinks as the sample grows', () => {
    const small = evaluateWinProbability([...many(0.7, 8, 2), ...many(0.3, 2, 8)]);
    const large = evaluateWinProbability([...many(0.7, 80, 20), ...many(0.3, 20, 80)]);
    expect(small.aucStdErr).not.toBeNull();
    expect(large.aucStdErr!).toBeLessThan(small.aucStdErr!);
  });
});

describe('calibration error', () => {
  it('is about zero when each bucket wins at its own rate', () => {
    const e = evaluateWinProbability([...many(0.15, 3, 17), ...many(0.55, 11, 9), ...many(0.85, 17, 3)]);
    expect(e.calibrationBuckets).toBe(3);
    expect(e.calibrationError).toBeCloseTo(0, 5);
  });

  it('measures the gap when predictions are overconfident', () => {
    // says 85% but wins 40% (gap 0.45); says 15% but wins 60% (gap 0.45)
    const e = evaluateWinProbability([...many(0.85, 8, 12), ...many(0.15, 12, 8)]);
    expect(e.calibrationError).toBeCloseTo(0.45, 5);
  });

  it('ignores buckets with fewer than 5 trades, and is null if none qualify', () => {
    const e = evaluateWinProbability([...many(0.15, 1, 3), ...many(0.55, 5, 5)]);
    expect(e.calibrationBuckets).toBe(1);
    expect(evaluateWinProbability(many(0.5, 2, 2)).calibrationError).toBeNull();
  });

  it('ignores non-finite predictions', () => {
    const e = evaluateWinProbability([...many(0.55, 5, 5), { predictedWP: NaN, won: true }, { predictedWP: Infinity, won: false }]);
    expect(e.n).toBe(10);
  });

  it('handles a prediction of exactly 1 or 0 in the end buckets', () => {
    const e = evaluateWinProbability([...many(1, 5, 0), ...many(0, 0, 5)]);
    expect(e.calibrationBuckets).toBe(2);
    expect(e.calibrationError).toBeCloseTo(0.05, 5);
  });
});

describe('95% lower bound', () => {
  it('is the AUC minus 1.96 standard errors', () => {
    const e = evaluateWinProbability([...many(0.7, 80, 20), ...many(0.3, 20, 80)]);
    expect(e.aucLower95).toBeCloseTo(e.auc! - 1.96 * e.aucStdErr!, 10);
  });

  it('is null when the AUC cannot be computed', () => {
    expect(evaluateWinProbability(many(0.6, 10, 0)).aucLower95).toBeNull();
    expect(evaluateWinProbability([]).aucLower95).toBeNull();
  });

  it('sits much further below the point estimate on a small sample than on a large one', () => {
    const small = evaluateWinProbability([...many(0.7, 8, 4), ...many(0.3, 4, 8)]);
    const large = evaluateWinProbability([...many(0.7, 80, 40), ...many(0.3, 40, 80)]);
    expect(small.auc! - small.aucLower95!).toBeGreaterThan(large.auc! - large.aucLower95!);
  });
});
