import { GraduationHandler } from '../src/safety/graduationHandler';
import { runSafetyPipeline } from '../src/safety/orchestrator';
import { bus } from '../src/core/eventBus';
import { PumpSwapGraduationEvent, TradeSignal } from '../src/core/types';
import { TokenSafetyChecker } from '../src/safety/tokenSafetyChecker';

jest.mock('../src/safety/orchestrator');
const mockedRunSafetyPipeline = runSafetyPipeline as jest.MockedFunction<typeof runSafetyPipeline>;

const baseEvent: PumpSwapGraduationEvent = {
  signature: 'test-sig',
  slot: 416647963,
  tokenCA: '6Aixvhgirbn8rHmAtFnwHNBqgxtenKDz8ycvHeQepump',
  poolAddress: '7ugTEN5mq5kGURByfXrK1AqTAJ76wQMauggskosVzEoK',
  deployer: 'DeployerWa11et1111111111111111111111111111111',
  initialLiquiditySOL: 99,
  detectedAt: Date.now(),
};

const mockTokenSafetyChecker = {} as unknown as TokenSafetyChecker;

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
});

afterEach(() => {
  bus.off('trade:signal', onTradeSignal);
  bus.off('safety:blocked', onSafetyBlocked);
});

describe('GraduationHandler', () => {
  describe('start/stop lifecycle', () => {
    it('registers listener on start, removes on stop', () => {
      const handler = new GraduationHandler(mockTokenSafetyChecker);
      const before = bus.listenerCount('pool:graduated');
      handler.start();
      expect(bus.listenerCount('pool:graduated')).toBe(before + 1);
      handler.stop();
      expect(bus.listenerCount('pool:graduated')).toBe(before);
    });

    it('start is idempotent (second start does not add listener)', () => {
      const handler = new GraduationHandler(mockTokenSafetyChecker);
      handler.start();
      const after1 = bus.listenerCount('pool:graduated');
      handler.start();
      expect(bus.listenerCount('pool:graduated')).toBe(after1);
      handler.stop();
    });
  });

  describe('pipeline pass path', () => {
    it('emits trade:signal when pipeline passes', async () => {
      mockedRunSafetyPipeline.mockResolvedValueOnce({
        passed: true,
        phaseA: { passed: true, trace: {}, durationMs: 1 },
        trace: {},
        durationMs: 10,
      });
      const handler = new GraduationHandler(mockTokenSafetyChecker);

      await handler.handle(baseEvent);

      expect(tradeSignals).toHaveLength(1);
      expect(blockedEvents).toHaveLength(0);
    });

    it('synthesized signal has correct source and entryPriceSOL=0', async () => {
      mockedRunSafetyPipeline.mockResolvedValueOnce({
        passed: true,
        phaseA: { passed: true, trace: {}, durationMs: 1 },
        trace: {},
        durationMs: 10,
      });
      const handler = new GraduationHandler(mockTokenSafetyChecker);

      await handler.handle(baseEvent);

      const signal = tradeSignals[0];
      expect(signal.source).toBe('AUTONOMOUS');
      expect(signal.entryPriceSOL).toBe(0);
      expect(signal.tokenCA).toBe(baseEvent.tokenCA);
      expect(signal.triggerWallet).toBe(baseEvent.deployer);
      expect(signal.convictionSOL).toBe(baseEvent.initialLiquiditySOL);
      expect(signal.score).toBe(10);
    });
  });

  describe('pipeline fail path', () => {
    it('emits safety:blocked when Phase A liquidity fails', async () => {
      mockedRunSafetyPipeline.mockResolvedValueOnce({
        passed: false,
        failedPhase: 'A',
        phaseA: {
          passed: false,
          failedCheck: 'liquidity',
          trace: { liquidity: { passed: false, valueSOL: 1.5 } },
          durationMs: 1,
        },
        trace: { liquidity: { passed: false, valueSOL: 1.5 } },
        durationMs: 5,
      });
      const handler = new GraduationHandler(mockTokenSafetyChecker);

      await handler.handle(baseEvent);

      expect(tradeSignals).toHaveLength(0);
      expect(blockedEvents).toHaveLength(1);
      expect(blockedEvents[0].tokenCA).toBe(baseEvent.tokenCA);
      expect(blockedEvents[0].reasons[0]).toContain('LIQUIDITY_INSUFFICIENT');
      expect(blockedEvents[0].reasons[0]).toContain('1.50 SOL');
    });

    it('emits safety:blocked with HONEYPOT_ reason on Phase B honeypot fail', async () => {
      mockedRunSafetyPipeline.mockResolvedValueOnce({
        passed: false,
        failedPhase: 'B',
        phaseA: { passed: true, trace: {}, durationMs: 1 },
        phaseB: {
          passed: false,
          failedCheck: 'honeypot',
          trace: {
            lpLock: { passed: true, locked: true },
            mintAuthority: { passed: true, revoked: true },
            freezeAuthority: { passed: true, revoked: true },
            holderConcentration: { passed: true, topPct: 15 },
            honeypot: { passed: false, classification: 'INDEX_LAG' },
            deployerBlacklist: { passed: true },
          },
          durationMs: 250,
        },
        trace: {},
        durationMs: 260,
      });
      const handler = new GraduationHandler(mockTokenSafetyChecker);

      await handler.handle(baseEvent);

      expect(blockedEvents[0].reasons[0]).toBe('HONEYPOT_INDEX_LAG — sellability check failed');
    });

    it('emits SCAMMY_NAME reason on scammyName fail', async () => {
      mockedRunSafetyPipeline.mockResolvedValueOnce({
        passed: false,
        failedPhase: 'A',
        phaseA: {
          passed: false,
          failedCheck: 'scammyName',
          trace: {},
          durationMs: 1,
        },
        trace: {},
        durationMs: 1,
      });
      const handler = new GraduationHandler(mockTokenSafetyChecker);

      await handler.handle(baseEvent);

      expect(blockedEvents[0].reasons[0]).toContain('SCAMMY_NAME');
    });
  });

  describe('error handling', () => {
    it('catches pipeline exceptions and does not emit any event', async () => {
      mockedRunSafetyPipeline.mockRejectedValueOnce(new Error('pipeline boom'));
      const handler = new GraduationHandler(mockTokenSafetyChecker);

      await handler.handle(baseEvent); // must not throw

      expect(tradeSignals).toHaveLength(0);
      expect(blockedEvents).toHaveLength(0);
    });
  });
});