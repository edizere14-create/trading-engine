import axios from 'axios';
import { GraduationHandler } from '../src/safety/graduationHandler';
import { bus } from '../src/core/eventBus';
import {
  PumpSwapGraduationEvent,
  TradeSignal,
  TokenSafetyResult,
} from '../src/core/types';
import { TokenSafetyChecker } from '../src/safety/tokenSafetyChecker';
import { TokenMetadataResolver } from '../src/safety/tokenMetadataResolver';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Full TokenSafetyResult shape — partial would let holderConcentrationOk
// default to undefined and silently collapse to false in the trace.
function cleanTokenSafetyResult(tokenCA: string): TokenSafetyResult {
  return {
    tokenCA,
    isSafe: true,
    reasons: [],
    rugScore: 0,
    topHolderPct: 0.15,
    holderConcentrationOk: true,
    lpLocked: true,
    mintAuthRevoked: true,
    freezeAuthRevoked: true,
    isHoneypot: false,
    checkedAt: new Date(),
  };
}

function makeAxiosResponse(priceImpactPct: string) {
  return {
    data: {
      inputMint: 'token',
      outputMint: 'So11111111111111111111111111111111111111112',
      inAmount: '1000000',
      outAmount: '950000',
      priceImpactPct,
    },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as never,
  };
}

function makeEvent(overrides: Partial<PumpSwapGraduationEvent> & { tokenCA: string }): PumpSwapGraduationEvent {
  return {
    signature: `sig-${overrides.tokenCA}`,
    slot: 1000,
    poolAddress: `pool-${overrides.tokenCA}`,
    deployer: 'DeployerWa11et1111111111111111111111111111111',
    initialLiquiditySOL: 99,
    detectedAt: Date.now(),
    ...overrides,
  };
}

const SCENARIOS = {
  clean1:    { tokenCA: 'clean1', initialLiquiditySOL: 99 },
  clean2:    { tokenCA: 'clean2', initialLiquiditySOL: 50 },
  clean3:    { tokenCA: 'clean3', initialLiquiditySOL: 10 },
  boundary:  { tokenCA: 'boundary', initialLiquiditySOL: 3.0 }, // exactly at threshold
  highLiq:   { tokenCA: 'highliq', initialLiquiditySOL: 500 },
  cleanX2:   { tokenCA: 'cleanX2', initialLiquiditySOL: 25 },
  cleanX3:   { tokenCA: 'cleanX3', initialLiquiditySOL: 40 },
  lowLiq:    { tokenCA: 'lowliq', initialLiquiditySOL: 1.5 }, // FAIL: < 3
  belowEdge: { tokenCA: 'belowedge', initialLiquiditySOL: 2.99 }, // FAIL: just below
  honeypot:  { tokenCA: 'honeypot1', initialLiquiditySOL: 50 }, // FAIL: Jupiter returns UNCONFIRMED
  mintFail:  { tokenCA: 'mintfail1', initialLiquiditySOL: 99 }, // FAIL: mintAuth not revoked
  scammyName: { tokenCA: 'honeypotname1', initialLiquiditySOL: 99 }, // FAIL: name matches scam pattern
};

describe('graduation pipeline soak (mocked external deps)', () => {
  let handler: GraduationHandler;
  let mockTokenSafetyChecker: TokenSafetyChecker;
  let mockMetadataResolver: TokenMetadataResolver;
  let tradeSignals: TradeSignal[];
  let blockedEvents: Array<{ tokenCA: string; reasons: string[] }>;
  let onTradeSignal: (s: TradeSignal) => void;
  let onSafetyBlocked: (b: { tokenCA: string; reasons: string[] }) => void;

  beforeEach(() => {
    jest.clearAllMocks();
    tradeSignals = [];
    blockedEvents = [];
    onTradeSignal = (s) => tradeSignals.push(s);
    onSafetyBlocked = (b) => blockedEvents.push(b);
    bus.on('trade:signal', onTradeSignal);
    bus.on('safety:blocked', onSafetyBlocked);

    mockTokenSafetyChecker = {
      check: jest.fn().mockImplementation(async (tokenCA: string) =>
        cleanTokenSafetyResult(tokenCA),
      ),
    } as unknown as TokenSafetyChecker;

    // Default honeypot mock: clean response.
    mockedAxios.get.mockResolvedValue(makeAxiosResponse('5'));

    // Default resolver returns null (no metadata) so existing scenarios
    // continue to auto-pass scammyName. Tests that need a specific name
    // override this with mockResolvedValueOnce.
    mockMetadataResolver = {
      resolveName: jest.fn().mockResolvedValue(null),
    } as unknown as TokenMetadataResolver;

    handler = new GraduationHandler(mockTokenSafetyChecker, undefined, mockMetadataResolver);
  });

  afterEach(() => {
    bus.off('trade:signal', onTradeSignal);
    bus.off('safety:blocked', onSafetyBlocked);
  });

  it('processes 7 clean events through pipeline -> 7 trade:signal emissions', async () => {
    const cleanCases = [
      SCENARIOS.clean1, SCENARIOS.clean2, SCENARIOS.clean3,
      SCENARIOS.boundary, SCENARIOS.highLiq,
      SCENARIOS.cleanX2, SCENARIOS.cleanX3,
    ];

    for (const scenario of cleanCases) {
      await handler.handle(makeEvent(scenario));
    }

    expect(tradeSignals).toHaveLength(7);
    expect(blockedEvents).toHaveLength(0);
  });

  it('boundary case (exactly 3.0 SOL liquidity) passes', async () => {
    await handler.handle(makeEvent(SCENARIOS.boundary));
    expect(tradeSignals).toHaveLength(1);
    expect(tradeSignals[0].convictionSOL).toBe(3.0);
  });

  it('low liquidity events rejected with LIQUIDITY_INSUFFICIENT', async () => {
    await handler.handle(makeEvent(SCENARIOS.lowLiq));
    await handler.handle(makeEvent(SCENARIOS.belowEdge));

    expect(blockedEvents).toHaveLength(2);
    expect(tradeSignals).toHaveLength(0);
    expect(blockedEvents[0].reasons[0]).toContain('LIQUIDITY_INSUFFICIENT');
    expect(blockedEvents[1].reasons[0]).toContain('LIQUIDITY_INSUFFICIENT');
  });

  it('honeypot rejection: Jupiter UNCONFIRMED -> HONEYPOT_UNCONFIRMED reason', async () => {
    // High priceImpactPct triggers UNCONFIRMED classification
    mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('75'));

    await handler.handle(makeEvent(SCENARIOS.honeypot));

    expect(tradeSignals).toHaveLength(0);
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0].reasons[0]).toContain('HONEYPOT_UNCONFIRMED');
  });

  it('Phase B mintAuthority fail -> MINT_AUTHORITY_ACTIVE reason', async () => {
    (mockTokenSafetyChecker.check as jest.Mock).mockResolvedValueOnce({
      ...cleanTokenSafetyResult('mintfail1'),
      mintAuthRevoked: false,
      isSafe: false,
    });

    await handler.handle(makeEvent(SCENARIOS.mintFail));

    expect(tradeSignals).toHaveLength(0);
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0].reasons[0]).toBe('MINT_AUTHORITY_ACTIVE — deployer can inflate supply');
  });

  it('Phase A scammyName fail -> SCAMMY_NAME reason', async () => {
    // Override default null resolution: this token has a scammy name
    (mockMetadataResolver.resolveName as jest.Mock).mockResolvedValueOnce(
      'honeypot coin'
    );

    await handler.handle(makeEvent(SCENARIOS.scammyName));

    expect(tradeSignals).toHaveLength(0);
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0].reasons[0]).toContain('SCAMMY_NAME');
  });

  it('full mixed batch: 7 pass, 3 fail with correct attribution', async () => {
    const all = [
      { scenario: SCENARIOS.clean1, expect: 'pass' as const },
      { scenario: SCENARIOS.clean2, expect: 'pass' as const },
      { scenario: SCENARIOS.lowLiq, expect: 'block' as const },
      { scenario: SCENARIOS.clean3, expect: 'pass' as const },
      { scenario: SCENARIOS.boundary, expect: 'pass' as const },
      { scenario: SCENARIOS.honeypot, expect: 'block' as const, honeypotImpact: '75' },
      { scenario: SCENARIOS.highLiq, expect: 'pass' as const },
      { scenario: SCENARIOS.cleanX2, expect: 'pass' as const },
      { scenario: SCENARIOS.belowEdge, expect: 'block' as const },
      { scenario: SCENARIOS.cleanX3, expect: 'pass' as const },
    ];

    for (const { scenario, expect: outcome, honeypotImpact } of all) {
      if (honeypotImpact) {
        mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse(honeypotImpact));
      }
      await handler.handle(makeEvent(scenario));
    }

    const expectedPass = all.filter(e => e.expect === 'pass').length;
    const expectedBlock = all.filter(e => e.expect === 'block').length;

    expect(tradeSignals).toHaveLength(expectedPass);
    expect(blockedEvents).toHaveLength(expectedBlock);
  });
});