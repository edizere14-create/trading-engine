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

import { isProbeTrade, PROBE_RECORD_MAX_USD } from '../src/risk/probePolicy';

describe('isProbeTrade', () => {
  it('trusts the flag', () => {
    expect(isProbeTrade({ isProbe: true, sizeUSD: 50 })).toBe(true);
  });

  it('detects legacy probe records by size', () => {
    expect(isProbeTrade({ sizeUSD: 1 })).toBe(true);
    expect(isProbeTrade({ sizeUSD: PROBE_RECORD_MAX_USD })).toBe(true);
  });

  it('does not treat real-sized or unsized trades as probes', () => {
    expect(isProbeTrade({ sizeUSD: 15 })).toBe(false);
    expect(isProbeTrade({ sizeUSD: 50 })).toBe(false);
    expect(isProbeTrade({})).toBe(false);
    expect(isProbeTrade({ sizeUSD: 0 })).toBe(false);
  });
});
