import { shouldUseProbeFallback } from '../src/risk/probePolicy';

describe('shouldUseProbeFallback', () => {
  it('blocks (no probe) for wallet copy-trades even in paper mode with probes on', () => {
    expect(shouldUseProbeFallback(true, true, 'SINGLE_WALLET')).toBe(false);
  });

  it('keeps the probe for every other source in paper mode', () => {
    for (const source of ['AUTONOMOUS', 'CLUSTER', 'KOL', 'TELEGRAM', 'UNKNOWN']) {
      expect(shouldUseProbeFallback(true, true, source)).toBe(true);
    }
  });

  it('never probes when probes are disabled', () => {
    expect(shouldUseProbeFallback(true, false, 'AUTONOMOUS')).toBe(false);
    expect(shouldUseProbeFallback(true, false, 'SINGLE_WALLET')).toBe(false);
  });

  it('never probes outside paper mode', () => {
    expect(shouldUseProbeFallback(false, true, 'AUTONOMOUS')).toBe(false);
    expect(shouldUseProbeFallback(false, true, 'SINGLE_WALLET')).toBe(false);
  });
});
