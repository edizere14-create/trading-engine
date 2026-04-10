import { config } from './core/config';
import { logger } from './core/logger';
import { bus } from './core/eventBus';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';

import { WalletRegistry } from './registry/walletRegistry';
import { DeployerRegistry } from './registry/deployerRegistry';
import { PaperTradeGate } from './calibration/paperTrader';
import { PerformanceEngine } from './performance/performanceEngine';

import { MarketStateEngine } from './marketState/marketStateEngine';
import { SlippageEngine } from './liquidity/slippageEngine';
import { RiskEngine } from './risk/riskEngine';
import { SurvivalEngine } from './risk/survivalEngine';
import { ExitEngine } from './exits/exitEngine';
import { SignalAggregator } from './signals/signalAggregator';
import { DEFAULT_WEIGHTS } from './signals/signalVector';

import { LPCreationStream } from './ingestion/lpCreationStream';
import { SmartWalletStream } from './ingestion/smartWalletStream';
import { installWsErrorSuppression } from './ingestion/wsControl';

// Suppress @solana/web3.js WS error spam before any Connection objects are created
installWsErrorSuppression();

import { TradeJournal } from './journal/tradeJournal';
import { FactorEngine } from './factors/factorEngine';
import { EquityCurveController } from './equity/equityCurveController';
import { MicrostructureFeatureExtractor } from './microstructure/featureExtractor';
import { ReplaySimulator } from './replay/replaySimulator';
import { JournalEntry } from './journal/journalTypes';
import { TradeRecord, ExitMode } from './core/types';
import { DataSync } from './core/dataSync';
import * as fs from 'fs';

// ── Trade infrastructure ──────────────────────────────────
import { PositionManager } from './position/positionManager';
import { TokenSafetyChecker } from './safety/tokenSafetyChecker';

// ── ADVANCED ENGINE IMPORTS ───────────────────────────────
import { OnlineLearner } from './ml/onlineLearner';
import { HiddenMarkovRegimeDetector } from './ml/regimeHMM';
import { PortfolioOptimizer } from './portfolio/portfolioOptimizer';
import { ExecutionEngine } from './execution/executionEngine';
import { DeployerIntelligence } from './intelligence/deployerIntelligence';
import { AntifragileEngine } from './antifragile/antifragileEngine';
import { SocialSignalEngine } from './social/socialSignalEngine';
import { OnChainSimulator } from './simulation/onChainSimulator';
import { TelegramNotifier } from './notifications/telegramNotifier';
import { StatArbEngine } from './execution/statArbEngine';
import { SmartMoneyTracker } from './intelligence/smartMoneyTracker';
import { ToxicFlowBackrunner } from './execution/toxicFlowBackrunner';
import { HybridPowerPlay } from './execution/hybridPowerPlay';
import { PoolPriceStream } from './ingestion/poolPriceStream';
import { PositionPricePoller } from './ingestion/positionPricePoller';

let lpStream: LPCreationStream | null = null;
let walletStream: SmartWalletStream | null = null;
let survivalEngine: SurvivalEngine | null = null;
let positionManager: PositionManager | null = null;
let antifragileEngine: AntifragileEngine | null = null;
let onlineLearner: OnlineLearner | null = null;
let regimeDetector: HiddenMarkovRegimeDetector | null = null;
let portfolioOptimizer: PortfolioOptimizer | null = null;
let executionEngine: ExecutionEngine | null = null;
let deployerIntel: DeployerIntelligence | null = null;
let socialEngine: SocialSignalEngine | null = null;
let simulator: OnChainSimulator | null = null;
let statArbEngine: StatArbEngine | null = null;
let smartMoneyTracker: SmartMoneyTracker | null = null;
let toxicFlowBackrunner: ToxicFlowBackrunner | null = null;
let hybridPowerPlay: HybridPowerPlay | null = null;
let poolPriceStream: PoolPriceStream | null = null;
let positionPricePoller: PositionPricePoller | null = null;
let journal: TradeJournal | null = null;
let isShuttingDown = false;

// tokenCA → poolAddress mapping (populated from pool:created events)
const tokenPoolMap: Map<string, string> = new Map();

// tokenCA → signal context at entry time (for journal/paper trade records)
interface TradeEntryContext {
  signal: { timingEdge: number; deployerQuality: number; organicFlow: number; manipulationRisk: number; coordinationStrength: number; socialVelocity: number; totalScore: number; confidence: number };
  poolAddress: string;
  deployerAddress: string;
  deployerTier: string;
  predictedWP: number;
  predictedEV: number;
  entryMarketState: string;
  entryRegime: string;
  executionMode: string;
  source: string;
}
const tradeEntryCache: Map<string, TradeEntryContext> = new Map();

// ── SOL Price State ──────────────────────────────────────
let currentSOLPrice: number | null = null;
let lastPriceUpdate = 0;
const SOL_PRICE_STALENESS_MS = 30_000;
const SOL_PRICE_HALT_MS = 60_000;
const STABLE_QUOTES = new Set(['USDC', 'USDT']);

function isPlausibleSolPrice(price: number): boolean {
  return Number.isFinite(price) && price >= 10 && price <= 1000;
}

async function fetchSOLPriceFromCoinGecko(): Promise<number> {
  const res = await axios.get(
    'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    { timeout: 5_000 }
  );
  const price = res.data?.solana?.usd;
  if (typeof price === 'number' && isPlausibleSolPrice(price)) return price;
  throw new Error('CoinGecko returned invalid price');
}

async function fetchSOLPriceFromDexScreener(): Promise<number> {
  const res = await axios.get(
    'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112',
    { timeout: 5_000 }
  );
  const pairs = Array.isArray(res.data?.pairs) ? res.data.pairs : [];
  const pair = pairs
    .filter((entry: any) => entry?.chainId === 'solana')
    .filter((entry: any) => entry?.baseToken?.address === 'So11111111111111111111111111111111111111112')
    .filter((entry: any) => STABLE_QUOTES.has(String(entry?.quoteToken?.symbol ?? '').toUpperCase()))
    .sort((a: any, b: any) => Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0))[0];

  const price = parseFloat(pair?.priceUsd);
  if (isPlausibleSolPrice(price)) return price;
  throw new Error('DexScreener returned invalid price');
}

async function fetchSOLPrice(): Promise<number> {
  try {
    return await fetchSOLPriceFromDexScreener();
  } catch {
    return fetchSOLPriceFromCoinGecko();
  }
}

async function fetchSOLPriceWithRetry(attempts = 5): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchSOLPrice();
    } catch (err) {
      logger.warn('[Price] SOL price fetch failed', {
        attempt: i + 1,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 1_000 * (i + 1)));
  }
  throw new Error('Cannot fetch SOL price after 5 attempts — refusing to start');
}

function getSolPrice(): number {
  if (currentSOLPrice === null) throw new Error('SOL price not initialized');

  const ageMs = Date.now() - lastPriceUpdate;

  if (ageMs > SOL_PRICE_HALT_MS) {
    bus.emit('system:halt', { reason: `SOL price stale ${Math.round(ageMs / 1000)}s`, resumeAt: undefined });
    throw new Error(`SOL price stale ${Math.round(ageMs / 1000)}s — halting`);
  }

  if (ageMs > SOL_PRICE_STALENESS_MS) {
    throw new Error(`SOL price stale ${Math.round(ageMs / 1000)}s — blocking sizing`);
  }

  return currentSOLPrice;
}

// Estimate payoff multiple from signal quality instead of hardcoding 2.0
// Maps score [0–10] → expected payoff [1.2x–3.5x]
// Score 5 → 2.35x (close to old 2.0 baseline), Score 10 → 3.5x, Score 3 → 1.89x
function estimatePayoffMultiple(score: number): number {
  const clamped = Math.min(Math.max(score, 0), 10);
  return 1.2 + (clamped / 10) * 2.3;
}

function startPriceRefreshLoop(): void {
  let lastSourceIndex = 0;
  const interval = setInterval(async () => {
    // Rotate through sources to reduce rate-limit pressure on any single one
    const sources = [
      async () => {
        const price = await fetchSOLPrice();
        if (price > 0) return price;
        throw new Error('Price source returned invalid price');
      },
      async () => fetchSOLPriceFromCoinGecko(),
      async () => fetchSOLPriceFromDexScreener(),
    ];

    // Try from last successful source first, then cycle through others
    for (let i = 0; i < sources.length; i++) {
      const idx = (lastSourceIndex + i) % sources.length;
      try {
        const price = await sources[idx]();
        currentSOLPrice = price;
        lastPriceUpdate = Date.now();
        lastSourceIndex = idx;
        return; // success — done
      } catch { /* try next source */ }
    }
    logger.error('[Price] All sources failed — staleness guard will block trades');
  }, 15_000);
  interval.unref();
}

function getSmartWalletSignalScore(walletTier: 'S' | 'A' | 'B', amountSOL: number): number {
  let score = walletTier === 'S' ? 7.0 : walletTier === 'A' ? 5.0 : 3.0;

  if (amountSOL >= 1.0) score += 1.0;
  else if (amountSOL >= 0.25) score += 0.5;

  return Math.max(0, Math.min(10, score));
}

function loadExecutionWallet(secret?: string): Keypair | null {
  const trimmed = (secret ?? '').trim();
  if (!trimmed) return null;

  let decoded: Uint8Array;

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as number[];
    decoded = Uint8Array.from(parsed);
  } else if (trimmed.includes(',')) {
    decoded = Uint8Array.from(
      trimmed
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => Number(v))
    );
  } else {
    decoded = bs58.decode(trimmed);
  }

  if (decoded.length !== 64) {
    throw new Error(`WALLET_PRIVATE_KEY decoded to ${decoded.length} bytes (expected 64)`);
  }

  return Keypair.fromSecretKey(decoded);
}

const dataSync = new DataSync();

async function boot(): Promise<void> {
  logger.info('═══════════════════════════════════════════');
  logger.info('  TRADING ENGINE v4.1 — BOOTING');
  logger.info('═══════════════════════════════════════════');

  // 0. Restore persisted data from cloud before anything reads from disk
  await dataSync.restore();

  // 1. Config validation — fail fast
  const cfg = config.load();
  const telegram = new TelegramNotifier(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID);
  let executionWallet: Keypair | null = null;

  if (!cfg.isPaperMode) {
    executionWallet = loadExecutionWallet(cfg.WALLET_PRIVATE_KEY);
    if (!executionWallet) {
      logger.warn('LIVE mode active but WALLET_PRIVATE_KEY is missing; autonomous live executions are disabled');
    } else {
      logger.info('Execution wallet loaded', {
        publicKey: executionWallet.publicKey.toBase58(),
      });
    }
  }

  if (cfg.isPaperMode) {
    logger.warn('══════════════════════════════════════');
    logger.warn('  ⚠  PAPER MODE ACTIVE — NO REAL CAPITAL');
    logger.warn('══════════════════════════════════════');
  } else {
    logger.warn('══════════════════════════════════════');
    logger.warn('  🔴 LIVE MODE ACTIVE');
    logger.warn('══════════════════════════════════════');
  }

  // 2. Load registries
  const walletRegistry = await WalletRegistry.load(cfg.WALLETS_FILE);
  const deployerRegistry = await DeployerRegistry.load(cfg.DEPLOYERS_FILE);
  logger.info('Registries loaded', {
    deployers: deployerRegistry.count(),
    wallets: walletRegistry.count(),
  });

  // 3. Load calibration + performance
  const paperGate = await PaperTradeGate.load(cfg.PAPER_TRADES_FILE);
  const perfEngine = await PerformanceEngine.load('./data/edgeStats.json');
  const gateStatus = paperGate.getStatus();

  // 4. Paper gate check — throws if live mode attempted before validation
  if (!cfg.isPaperMode) {
    // Also check Python-side auto-graduation proof
    const gradPath = './data/graduation.json';
    let pyGraduated = false;
    try {
      if (fs.existsSync(gradPath)) {
        const grad = JSON.parse(fs.readFileSync(gradPath, 'utf-8'));
        pyGraduated = grad.verdict === 'ACTIVE';
      }
    } catch { /* graduation.json missing or malformed — not graduated */ }

    if (!pyGraduated) {
      throw new Error('LIVE_CAPITAL_LOCKED: Python auto-graduation not earned yet. Run in PAPER mode until graduation.json is written.');
    }
    paperGate.assertLiveCapitalAllowed();
  }

  // Check graduation status for logging
  try {
    const gradPath = './data/graduation.json';
    if (fs.existsSync(gradPath)) {
      const grad = JSON.parse(fs.readFileSync(gradPath, 'utf-8'));
      if (grad.verdict === 'ACTIVE') {
        logger.info('Auto-graduation EARNED', {
          profitFactor: grad.profit_factor,
          winRate: grad.win_rate,
          maxDrawdown: grad.max_drawdown_pct,
          trades: grad.total_trades,
          graduatedAt: new Date(grad.graduated_at * 1000).toISOString(),
        });
      }
    }
  } catch { /* non-fatal */ }
  logger.info('Paper gate status', {
    trades: `${gateStatus.completedTrades}/${gateStatus.requiredTrades}`,
    wpAccuracy: gateStatus.wpCalibrationAccuracy.toFixed(3),
    actualEV: gateStatus.actualEV.toFixed(3),
    winRate: (gateStatus.actualWinRate * 100).toFixed(1) + '%',
    gateUnlocked: gateStatus.gateUnlocked,
    blockedReasons: gateStatus.blockedReasons,
  });

  // 5. Instantiate engines
  const marketEngine = new MarketStateEngine();
  const slippageEngine = new SlippageEngine();
  const riskEngine = new RiskEngine();
  const survivalThresholds = cfg.isPaperMode
    ? {
      haltDailyLossPct: 35,
      haltWeeklyLossPct: 70,
      haltConsecutiveLosses: 7,
      defensiveDailyLossPct: 25,
      defensiveConsecutiveLosses: 5,
      cautionDailyLossPct: 15,
      cautionConsecutiveLosses: 3,
    }
    : undefined;
  survivalEngine = new SurvivalEngine(cfg.INITIAL_CAPITAL_USD, survivalThresholds);
  survivalEngine.start();
  const exitEngine = new ExitEngine();
  const signalAggregator = new SignalAggregator(deployerRegistry, walletRegistry, DEFAULT_WEIGHTS, cfg.MIN_CONSENSUS);

  // 5b. Intelligence infrastructure
  journal = new TradeJournal('./data/journal.db');
  await journal.waitReady();
  const factorEngine = new FactorEngine(journal);
  const equityCtrl = new EquityCurveController(cfg.INITIAL_CAPITAL_USD, journal);
  const microExtractor = new MicrostructureFeatureExtractor();
  const replayEngine = new ReplaySimulator(journal, riskEngine);

  // 5c. Trade infrastructure
  const tokenSafety = new TokenSafetyChecker(cfg.safetyConnection, cfg.connection);

  // SOL price — fetch real price before any sizing decisions
  currentSOLPrice = await fetchSOLPriceWithRetry();
  lastPriceUpdate = Date.now();
  logger.info('[Engine] SOL price initialized', { price: currentSOLPrice });
  startPriceRefreshLoop();

  const smartWalletSignalDedupe = new Map<string, number>();
  const SMART_WALLET_MIN_SWAP_SOL = 0.05;
  const SMART_WALLET_SIGNAL_TTL_MS = 120_000;

  positionManager = new PositionManager(
    {
      mode: cfg.isPaperMode ? 'PAPER' : 'LIVE',
      capitalUSD: cfg.INITIAL_CAPITAL_USD,
      sizePct: cfg.TRADE_SIZE_PCT,
      maxConcurrent: cfg.MAX_CONCURRENT_POSITIONS,
      maxTradesPerDay: cfg.MAX_TRADES_PER_DAY,
      stopLossPct: cfg.TRADE_STOP_LOSS_PCT,
      maxHoldMs: cfg.TRADE_MAX_HOLD_MS,
      solPriceUSD: currentSOLPrice!,
    }
  );
  positionManager.start();

  logger.info('Trade infrastructure initialized', {
    sizePct: cfg.TRADE_SIZE_PCT,
    stopLossPct: cfg.TRADE_STOP_LOSS_PCT,
    maxHoldMs: cfg.TRADE_MAX_HOLD_MS,
  });

  // ═══════════════════════════════════════════════════════════
  //  ADVANCED ENGINE INITIALIZATION
  // ═══════════════════════════════════════════════════════════

  // 5d. Online ML Pipeline — self-calibrating win probability model
  onlineLearner = new OnlineLearner(cfg.ML_MODEL_FILE);
  await onlineLearner.load();
  logger.info('Online ML learner loaded', {
    modelFile: cfg.ML_MODEL_FILE,
    learningRate: cfg.ML_LEARNING_RATE,
  });

  // 5e. HMM Regime Detector — 4-state hidden Markov model
  regimeDetector = new HiddenMarkovRegimeDetector(cfg.ML_HMM_FILE);
  await regimeDetector.load();
  logger.info('HMM regime detector loaded');

  // 5f. Portfolio Optimizer — Kelly criterion + correlation-aware sizing
  portfolioOptimizer = new PortfolioOptimizer();
  logger.info('Portfolio optimizer initialized');

  // 5g. Execution Engine — unified TypeScript execution (replaces Python)
  executionEngine = new ExecutionEngine(
    cfg.connection,
    cfg.backupConnection,
    cfg.JITO_BLOCK_ENGINE_URL,
    {
      strictFillVerification: cfg.STRICT_FILL_VERIFICATION === 'true',
      minFillRatio: cfg.EXECUTION_MIN_FILL_RATIO,
      txFetchTimeoutMs: cfg.EXECUTION_TIMEOUT_MS,
    }
  );
  logger.info('Execution engine initialized', {
    mevProtection: cfg.MEV_PROTECTION_ENABLED,
    maxRetries: cfg.EXECUTION_MAX_RETRIES,
    strictFillVerification: cfg.STRICT_FILL_VERIFICATION,
    minFillRatio: cfg.EXECUTION_MIN_FILL_RATIO,
  });

  // 5h. Deployer Intelligence — on-chain analysis replaces static JSON
  deployerIntel = new DeployerIntelligence(cfg.connection, cfg.DEPLOYER_INTEL_FILE);
  await deployerIntel.load();
  logger.info('Deployer intelligence loaded', {
    profiles: deployerIntel ? 'ACTIVE' : 'N/A',
    minReputation: cfg.DEPLOYER_MIN_REPUTATION,
  });

  // 5i. Antifragile Engine — circuit breakers + black swan detection
  antifragileEngine = new AntifragileEngine(
    cfg.isPaperMode
      ? {
        correlatedDrawdownThreshold: 6,
        correlatedDrawdownFatalThreshold: 8,
        correlatedDrawdownWindowMs: 300_000,
        massRugThreshold: 6,
        massRugWindowMs: 600_000,
      }
      : undefined
  );
  antifragileEngine.start();
  logger.info('Antifragile engine started', {
    health: antifragileEngine.getSystemHealth().overallStatus,
  });

  // 5j. Social Signal Engine — Twitter/Telegram NLP pipeline
  socialEngine = new SocialSignalEngine();
  logger.info('Social signal engine initialized');

  // 5k. On-Chain Simulator — pre-trade pool analysis
  simulator = new OnChainSimulator(cfg.connection);
  logger.info('On-chain simulator initialized');

  // 5k2. Pool Price Stream — reserve-based position price tracking
  poolPriceStream = new PoolPriceStream(cfg.connection, simulator);
  logger.info('Pool price stream initialized');

  // 5k3. Position Price Poller — Jupiter API fallback for tokens without AMM pools
  positionPricePoller = new PositionPricePoller(positionManager!);
  positionPricePoller.start();
  logger.info('Position price poller started');

  // 5l. Statistical Arbitrage Engine — cross-DEX spread capture
  statArbEngine = new StatArbEngine(cfg.connection);
  statArbEngine.start();
  logger.info('StatArb engine started');

  // 5m. Smart Money Tracker — behavioral wallet clustering (10s window)
  smartMoneyTracker = new SmartMoneyTracker(walletRegistry);
  smartMoneyTracker.start();
  logger.info('Smart money tracker started', { trackedWallets: walletRegistry.count() });

  // 5n. Toxic Flow Backrunner — post-sandwich dip capture
  toxicFlowBackrunner = new ToxicFlowBackrunner(cfg.connection);
  toxicFlowBackrunner.start();
  logger.info('Toxic flow backrunner started');

  // 5o. Hybrid Power Play — three-stage PumpFun lifecycle strategy
  hybridPowerPlay = new HybridPowerPlay(cfg.connection, positionManager!);
  await hybridPowerPlay.start();
  logger.info('Hybrid Power Play started');

  // 6. Wire event bus listeners

  bus.on('pool:created', async (event) => {
   try {
    antifragileEngine?.heartbeat();

    // Always store tokenCA → poolAddress for reserve-based price tracking,
    // even if the pool is filtered out for trading. Positions opened via
    // smart wallet signals still need price feeds from the pool.
    tokenPoolMap.set(event.tokenCA, event.poolAddress);

    // Filter out micro-liquidity pools
    if (event.initialLiquiditySOL < cfg.MIN_LIQUIDITY_SOL) return;

    // Filter out pools below minimum USD depth
    const poolDepthUSD = event.initialLiquiditySOL * getSolPrice();
    if (poolDepthUSD < cfg.MIN_POOL_DEPTH_USD) {
      logger.info('Pool skipped — below min pool depth', {
        tokenCA: event.tokenCA,
        poolDepthUSD: poolDepthUSD.toFixed(0),
        minPoolDepthUSD: cfg.MIN_POOL_DEPTH_USD,
      });
      return;
    }

    // Check circuit breakers before proceeding
    if (antifragileEngine && antifragileEngine.getSystemHealth().overallStatus === 'DEAD') {
      logger.warn('Pool skipped — system DEAD', { tokenCA: event.tokenCA });
      return;
    }

    logger.info('Pool detected', {
      tokenCA: event.tokenCA,
      deployer: event.deployer,
      liqSOL: event.initialLiquiditySOL,
      source: event.source,
    });

    // ── Deployer Intelligence (replaces static registry) ──
    let deployerProfile;
    if (deployerIntel) {
      deployerProfile = await deployerIntel.analyzeDeployer(event.deployer);
      bus.emit('deployer:analyzed', deployerProfile);

      if (deployerProfile.tier === 'BLACKLIST') {
        logger.warn('Pool BLOCKED — deployer blacklisted', {
          deployer: event.deployer,
          reputationScore: deployerProfile.reputationScore,
        });
        bus.emit('deployer:blacklisted', {
          address: event.deployer,
          reason: `Reputation ${deployerProfile.reputationScore}/100`,
        });
        return;
      }

      // Gate: UNKNOWN deployers with low confidence are high-risk
      if (deployerProfile.tier === 'UNKNOWN' && deployerProfile.confidence < 0.3) {
        logger.warn('Pool BLOCKED — unknown deployer with low confidence', {
          deployer: event.deployer,
          confidence: deployerProfile.confidence.toFixed(2),
          walletAgeDays: deployerProfile.walletAgeDays.toFixed(1),
        });
        return;
      }
    }

    // ── On-Chain Simulation ──
    let simulatedEntryPriceSOL = 0.001;
    if (simulator) {
      const simResult = await simulator.simulatePool(event.poolAddress, event.tokenCA);
      if (simResult.reserveSOL > 0 && simResult.reserveToken > 0) {
        simulatedEntryPriceSOL = simResult.reserveSOL / simResult.reserveToken;
      }
      const sandwichRisk = simulator.estimateSandwichRisk(
        simResult.reserveSOL,
        cfg.INITIAL_CAPITAL_USD / getSolPrice() * (cfg.TRADE_SIZE_PCT),
        simResult.buyImpact[1]?.impactPct ?? 5
      );

      bus.emit('simulation:complete', {
        poolAddress: event.poolAddress,
        tokenCA: event.tokenCA,
        exitLiquiditySOL: simResult.exitLiquiditySOL,
        liquidityScore: simResult.liquidityScore,
        sandwichRisk: sandwichRisk.vulnerability,
        holderDistribution: simResult.holderDistribution,
        lpConcentrationRisk: simResult.lpConcentrationRisk,
        recommendation: sandwichRisk.recommendation === 'ABORT' ? 'ABORT'
          : sandwichRisk.recommendation === 'USE_JITO' ? 'USE_JITO'
          : sandwichRisk.recommendation === 'REDUCE_SIZE' ? 'REDUCE_SIZE' : 'GO',
      });

      if (sandwichRisk.recommendation === 'ABORT') {
        logger.warn('Pool BLOCKED — high sandwich risk', {
          tokenCA: event.tokenCA,
          vulnerability: sandwichRisk.vulnerability,
        });
        return;
      }
    }

    // Run signal aggregation
    const signal = signalAggregator.aggregate(event, null, [
      { name: 'RPC_LOGS', available: true, lastUpdateMs: Date.now() },
      { name: 'DEPLOYER_REGISTRY', available: true, lastUpdateMs: Date.now() },
    ]);

    if (!signal) return; // data:blind was emitted

    // Get survival snapshot for risk decision
    const survival = survivalEngine!.getSnapshot();
    const marketSnapshot = marketEngine.getSnapshot();

    if (!marketSnapshot) {
      logger.warn('No market state snapshot yet — skipping risk decision', {
        tokenCA: event.tokenCA,
      });
      return;
    }

    // ── ML Prediction ──
    let mlWinProb = signal.totalScore / 10;
    if (onlineLearner) {
      const features = onlineLearner.extractFeatures(
        signal,
        null,  // microstructure features
        marketSnapshot.score ?? 0,
        marketSnapshot.state === 'HOT' ? 1 : marketSnapshot.state === 'NORMAL' ? 0.5 : 0,
        survival.sizeMultiplier
      );
      const prediction = onlineLearner.getPrediction(features);
      if (prediction === null) {
        logger.warn('[ML] Prediction unavailable — using score-based fallback', {
          tokenCA: event.tokenCA,
          fallbackWP: mlWinProb.toFixed(3),
        });
      } else {
        mlWinProb = prediction.winProbability;
        bus.emit('ml:prediction', { tokenCA: event.tokenCA, prediction });
      }
    }

    // ── HMM Regime multiplier ──
    let regimeMultiplier = 1.0;
    if (regimeDetector) {
      const snap = regimeDetector.getLatestSnapshot();
      regimeMultiplier = snap.riskMultiplier;
    }

    // Risk decision
    const risk = riskEngine.decide(
      cfg.INITIAL_CAPITAL_USD,
      signal,
      marketSnapshot,
      survival,
      mlWinProb,
      estimatePayoffMultiple(signal.totalScore)
    );

    // ── Portfolio-level sizing ──
    if (portfolioOptimizer && risk.tradeAllowed) {
      const narrative = portfolioOptimizer.classifyNarrative(event.tokenCA, '');
      const regime = regimeDetector?.getLatestSnapshot().currentRegime ?? 'NEUTRAL';
      const sizing = portfolioOptimizer.calculateOptimalSize(
        cfg.INITIAL_CAPITAL_USD,
        mlWinProb,
        estimatePayoffMultiple(signal.totalScore),
        event.tokenCA,
        narrative,
        [],  // current positions — would need access to positionManager internal state
        regime,
        signal.confidence
      );
      bus.emit('portfolio:sizing', { tokenCA: event.tokenCA, recommendation: sizing });

      // Apply portfolio-level adjustment
      risk.sizeUSD = Math.min(risk.sizeUSD, sizing.recommendedSizeUSD);
    }

    logger.info('Trade decision', {
      tokenCA: event.tokenCA,
      allowed: risk.tradeAllowed,
      sizeUSD: risk.sizeUSD.toFixed(2),
      executionMode: risk.executionMode,
      maxHoldMs: risk.maxHoldMs,
      reason: risk.reason,
      mlWinProb: mlWinProb.toFixed(3),
      regimeMultiplier: regimeMultiplier.toFixed(2),
    });

    if (!risk.tradeAllowed) {
      return;
    }

    if (risk.sizeUSD < 1) {
      logger.info('Autonomous trade blocked: size below minimum', {
        tokenCA: event.tokenCA,
        sizeUSD: risk.sizeUSD.toFixed(2),
      });
      return;
    }

    if (positionManager!.hasPosition(event.tokenCA)) {
      return;
    }

    const autonomousSignal = {
      tokenCA: event.tokenCA,
      source: 'AUTONOMOUS' as const,
      triggerWallet: 'AUTONOMOUS_ENGINE',
      walletTier: 'S' as const,
      walletPnL30d: 0,
      convictionSOL: risk.sizeUSD / Math.max(getSolPrice(), 1),
      clusterWallets: [] as string[],
      clusterSize: 0,
      totalClusterSOL: 0,
      entryPriceSOL: Math.max(simulatedEntryPriceSOL, 0.000001),
      timestamp: new Date(),
      slot: event.slot,
      score: Math.max(0, Math.min(10, signal.totalScore)),
      confidence: signal.confidence,
      overrideSizeUSD: risk.sizeUSD,
      overrideMaxHoldMs: risk.maxHoldMs,
    };

    logger.info('Autonomous signal emitted', {
      tokenCA: event.tokenCA,
      sizeUSD: risk.sizeUSD.toFixed(2),
      executionMode: risk.executionMode,
      maxHoldMs: risk.maxHoldMs,
    });
    bus.emit('trade:signal', autonomousSignal);
   } catch (err) {
    logger.error('pool:created handler crashed', {
      tokenCA: event.tokenCA,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
   }
  });

  bus.on('swap:detected', (event) => {
    antifragileEngine?.heartbeat();

    logger.debug('Swap detected', {
      wallet: event.wallet,
      tokenCA: event.tokenCA,
      action: event.action,
      amountSOL: event.amountSOL,
      isSmartWallet: event.isSmartWallet,
    });

    // Feed into microstructure extractor (always — full data)
    microExtractor.addSwap(event);

    // Mark-to-market from swap prints — always feed prices for open positions.
    // Pool price stream provides reserve-based pricing; swap prints supplement
    // with trade-execution prices. Both sources prevent STALE_EXIT.
    if (positionManager!.hasPosition(event.tokenCA)) {
      positionManager!.updatePrice(event.tokenCA, event.priceSOL);
    }

    // If position is open but pool price stream not yet tracking, try to subscribe
    if (poolPriceStream && positionManager!.hasPosition(event.tokenCA) && !poolPriceStream.isTracking(event.tokenCA)) {
      const poolAddr = tokenPoolMap.get(event.tokenCA);
      if (poolAddr) {
        poolPriceStream.subscribe(poolAddr, event.tokenCA);
      }
    }

    if (!event.isSmartWallet || event.action !== 'BUY' || event.amountSOL < SMART_WALLET_MIN_SWAP_SOL) {
      return;
    }

    const walletStats = walletRegistry.getWalletStats(event.wallet);
    if (!walletStats) {
      return;
    }

    const now = event.timestamp.getTime();
    for (const [key, seenAt] of smartWalletSignalDedupe) {
      if (now - seenAt > SMART_WALLET_SIGNAL_TTL_MS) {
        smartWalletSignalDedupe.delete(key);
      }
    }

    const dedupeKey = `${event.wallet}:${event.tokenCA}:${event.slot}`;
    if (smartWalletSignalDedupe.has(dedupeKey)) {
      return;
    }
    smartWalletSignalDedupe.set(dedupeKey, now);

    const signal = {
      tokenCA: event.tokenCA,
      source: 'SINGLE_WALLET' as const,
      triggerWallet: event.wallet,
      walletTier: walletStats.tier,
      walletPnL30d: walletStats.pnl30d,
      convictionSOL: event.amountSOL,
      clusterWallets: [],
      clusterSize: 1,
      totalClusterSOL: event.amountSOL,
      entryPriceSOL: Math.max(event.priceSOL, 0.000001),
      timestamp: event.timestamp,
      slot: event.slot,
      score: getSmartWalletSignalScore(walletStats.tier, event.amountSOL),
      confidence: 0.6,
    };

    logger.info('Smart wallet trade signal generated', {
      tokenCA: signal.tokenCA,
      wallet: signal.triggerWallet,
      tier: signal.walletTier,
      amountSOL: signal.convictionSOL,
      score: signal.score.toFixed(2),
      source: signal.source,
      clusterSize: signal.clusterSize,
      confidence: signal.confidence.toFixed(2),
    });

    bus.emit('trade:signal', signal);
  });

  // ── POOL PRICE STREAM → POSITION PRICE UPDATE ──
  bus.on('pool:price', (event: { tokenCA: string; poolAddress: string; priceSOL: number; reserveSOL: number }) => {
    if (positionManager!.hasPosition(event.tokenCA)) {
      positionManager!.updatePrice(event.tokenCA, event.priceSOL);
    }
  });

  // ── SIGNAL → SAFETY CHECK → SIMULATION → OPEN TRADE ──
  bus.on('trade:signal', async (signal) => {
   try {
    // Block new signals during shutdown
    if (isShuttingDown) return;

    // Check antifragile health
    if (antifragileEngine) {
      const health = antifragileEngine.getSystemHealth();
      if (health.overallStatus === 'CRITICAL' || health.overallStatus === 'DEAD') {
        logger.warn('Signal BLOCKED — system health', { state: health.overallStatus });
        return;
      }
    }

    // HybridPowerPlay: suppress signals during migration cooldown
    if (hybridPowerPlay?.shouldSuppressSignal(signal.tokenCA)) {
      logger.info('Signal BLOCKED — HybridPowerPlay migration suppression', {
        tokenCA: signal.tokenCA,
      });
      return;
    }

    logger.info('Trade signal received', {
      tokenCA: signal.tokenCA,
      source: signal.source,
      score: signal.score.toFixed(1),
      convictionSOL: signal.convictionSOL,
    });

    // Token safety check (async — uses RPC)
    const safety = await tokenSafety.check(signal.tokenCA);
    if (!safety.isSafe) {
      logger.warn('Trade BLOCKED by safety', {
        tokenCA: signal.tokenCA,
        rugScore: safety.rugScore,
        reasons: safety.reasons,
      });
      return;
    }

    // Get survival state
    const survival = survivalEngine!.getSnapshot();

    // ── Portfolio optimization sizing ──
    if (portfolioOptimizer) {
      const regime = regimeDetector?.getLatestSnapshot().currentRegime ?? 'NEUTRAL';
      const narrative = portfolioOptimizer.classifyNarrative(signal.tokenCA, '');

      // Cold-start: boost win probability floor during paper calibration
      // Without historical data, ML returns ~0.5 → Kelly = 0% → no trades ever execute
      // Use minimum 0.55 so paper trades can flow and the model can learn
      const mlSamples = onlineLearner?.getModelStats().trainingSamples ?? 0;
      const coldStartWinProb = mlSamples < 20
        ? Math.max(signal.score / 10, 0.55)
        : signal.score / 10;

      const sizing = portfolioOptimizer.calculateOptimalSize(
        cfg.INITIAL_CAPITAL_USD,
        coldStartWinProb,
        estimatePayoffMultiple(signal.score),
        signal.tokenCA,
        narrative,
        [],
        regime,
        signal.confidence
      );

      if (sizing.recommendedSizeUSD < 1) {
        logger.warn('Trade BLOCKED — portfolio optimizer rejected', {
          tokenCA: signal.tokenCA,
          reason: sizing.reason,
          coldStart: mlSamples < 20,
        });
        return;
      }
    }

    if (!cfg.isPaperMode) {
      if (!executionEngine || !executionWallet) {
        logger.error('Autonomous execution blocked: execution engine or wallet unavailable', {
          tokenCA: signal.tokenCA,
        });
        void telegram.send(
          `AUTONOMOUS EXECUTION BLOCKED\nToken: ${signal.tokenCA}\nReason: wallet/execution engine unavailable`
        );
        return;
      }

      if (antifragileEngine && !antifragileEngine.canUseJupiter()) {
        logger.warn('Autonomous execution blocked: Jupiter circuit is open', {
          tokenCA: signal.tokenCA,
        });
        return;
      }

      const stats = positionManager!.getStats();
      if (survival.state === 'HALT') {
        logger.warn('Autonomous execution blocked by survival HALT', { tokenCA: signal.tokenCA });
        return;
      }
      if (positionManager!.hasPosition(signal.tokenCA)) {
        logger.debug('Autonomous execution skipped: already positioned', { tokenCA: signal.tokenCA });
        return;
      }
      if (stats.openCount >= cfg.MAX_CONCURRENT_POSITIONS) {
        logger.info('Autonomous execution blocked: max concurrent positions reached', {
          tokenCA: signal.tokenCA,
          openCount: stats.openCount,
        });
        return;
      }
      if (stats.tradesToday >= cfg.MAX_TRADES_PER_DAY) {
        logger.info('Autonomous execution blocked: max daily trades reached', {
          tokenCA: signal.tokenCA,
          tradesToday: stats.tradesToday,
        });
        return;
      }

      const amountSOL = Math.max(
        signal.overrideSizeUSD && signal.overrideSizeUSD > 0
          ? signal.overrideSizeUSD / Math.max(getSolPrice(), 1)
          : signal.convictionSOL,
        0.01
      );

      const urgency = signal.score >= 7 ? 'HIGH' : signal.score >= 5 ? 'MEDIUM' : 'LOW';
      const simulation = await executionEngine.simulate(signal.tokenCA, 'BUY', amountSOL);
      if (!simulation.passed) {
        antifragileEngine?.recordJupiterFailure();
        logger.warn('Autonomous execution blocked by pre-flight simulation', {
          tokenCA: signal.tokenCA,
          failReason: simulation.failReason,
          amountSOL: amountSOL.toFixed(4),
        });
        void telegram.send(
          `AUTONOMOUS EXECUTION BLOCKED\nToken: ${signal.tokenCA}\nReason: ${simulation.failReason ?? 'simulation failed'}`
        );
        return;
      }

      // Backrun signals (ToxicFlowBackrunner, HybridPowerPlay Stage 3) use
      // forced Jito bundles with dynamic tips sized to expected profit.
      const isBackrunSignal = signal.triggerWallet === 'TOXIC_FLOW_BACKRUNNER'
        || signal.triggerWallet === 'HYBRID_POWER_PLAY_BACKRUN';

      const plan = isBackrunSignal
        ? executionEngine.createBackrunPlan(
            signal.tokenCA,
            'BUY',
            amountSOL,
            amountSOL * (signal.score / 10) * 0.1, // estimated profit from score
            simulation
          )
        : executionEngine.createExecutionPlan(
            signal.tokenCA,
            'BUY',
            amountSOL,
            simulation,
            urgency
          );
      const result = await executionEngine.execute(plan, executionWallet);
      if (!result.success) {
        antifragileEngine?.recordJupiterFailure();
        logger.warn('Autonomous execution failed', {
          tokenCA: signal.tokenCA,
          error: result.error,
          fillRatio: result.fillRatio,
          verified: result.fillVerified,
        });
        void telegram.send(
          `AUTONOMOUS EXECUTION FAILED\nToken: ${signal.tokenCA}\nError: ${result.error ?? 'unknown'}`
        );
        return;
      }

      antifragileEngine?.recordJupiterSuccess();
      antifragileEngine?.recordRPCSuccess(true);

      logger.info('Autonomous execution confirmed', {
        tokenCA: signal.tokenCA,
        txSignature: result.txSignature,
        fillRatio: result.fillRatio?.toFixed(3),
        verified: result.fillVerified,
        strategy: result.strategy,
        amountSOL: amountSOL.toFixed(4),
      });
      void telegram.send(
        `[LIVE] AUTONOMOUS EXECUTED\n` +
        `Token: ${signal.tokenCA}\n` +
        `Size: ${amountSOL.toFixed(4)} SOL\n` +
        `Fill Ratio: ${(result.fillRatio ?? 0).toFixed(3)}\n` +
        `Tx: ${result.txSignature ?? 'n/a'}`
      );
    }

    // Open the trade
    const opened = positionManager!.openTrade(signal, survival);
    if (opened) {
      // Cache signal context for journal/paper trade records on close
      const marketSnapshot = marketEngine.getSnapshot();
      const regimeSnap = regimeDetector?.getLatestSnapshot();
      tradeEntryCache.set(signal.tokenCA, {
        signal: {
          timingEdge: signal.score ?? 0,
          deployerQuality: 0,
          organicFlow: 0,
          manipulationRisk: 0,
          coordinationStrength: 0,
          socialVelocity: 0,
          totalScore: signal.score ?? 0,
          confidence: signal.confidence ?? 0,
        },
        poolAddress: tokenPoolMap.get(signal.tokenCA) ?? '',
        deployerAddress: '',
        deployerTier: signal.walletTier ?? 'B',
        predictedWP: signal.score ? signal.score / 10 : 0,
        predictedEV: 0,
        entryMarketState: marketSnapshot?.state ?? 'NORMAL',
        entryRegime: regimeSnap?.currentRegime ?? 'NORMAL',
        executionMode: 'SAFE',
        source: signal.source ?? 'UNKNOWN',
      });

      // Record heartbeat for antifragile dead-man's switch
      if (antifragileEngine) {
        antifragileEngine.heartbeat();
      }
    } else if (!cfg.isPaperMode) {
      logger.error('Autonomous signal failed to open a local position after execution checks', {
        tokenCA: signal.tokenCA,
      });
      void telegram.send(
        `AUTONOMOUS WARNING\nToken: ${signal.tokenCA}\nReason: local position tracking failed`
      );
    }
   } catch (err) {
    logger.error('trade:signal handler crashed', {
      tokenCA: signal.tokenCA,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
   }
  });

  bus.on('cluster:alert', (alert) => {
    logger.info('Cluster alert', {
      tokenCA: alert.tokenCA,
      walletCount: alert.wallets.length,
      wallets: alert.wallets,
      totalWeightedPnL: alert.totalWeightedPnL,
      windowSeconds: alert.windowSeconds,
    });
  });

  bus.on('signal:ready', (event) => {
    logger.info('Signal ready', {
      tokenCA: event.tokenCA,
      timing: event.signal.timingEdge,
      deployer: event.signal.deployerQuality,
      organic: event.signal.organicFlow,
      manipulation: event.signal.manipulationRisk,
      coordination: event.signal.coordinationStrength,
      social: event.signal.socialVelocity,
      total: event.signal.totalScore,
      confidence: event.signal.confidence,
    });
  });

  bus.on('trade:opened', (trade) => {
    logger.info('Trade opened', {
      id: trade.id,
      tokenCA: trade.tokenCA,
      mode: trade.mode,
      sizeUSD: trade.sizeUSD,
      executionMode: trade.executionMode,
    });
  });

  bus.on('trade:closed', (trade) => {
    // Record in survival engine
    survivalEngine!.recordTrade(trade.realizedPnLUSD ?? 0, cfg.INITIAL_CAPITAL_USD);

    // Record in paper gate (only accepts PAPER trades)
    if (trade.mode === 'PAPER') {
      paperGate.addTrade(trade);
    }

    // Record in performance engine
    perfEngine.recordTrade(trade);

    // ── ML FEEDBACK LOOP: update model with trade outcome ──
    if (onlineLearner) {
      const marketSnapshot = marketEngine.getSnapshot();
      const survival = survivalEngine!.getSnapshot();
      if (marketSnapshot) {
        const outcome = trade.outcome === 'WIN' ? 1 : 0;
        const features = onlineLearner.extractFeatures(
          trade.signal,
          null,
          marketSnapshot.score ?? 0,
          marketSnapshot.state === 'HOT' ? 1 : marketSnapshot.state === 'NORMAL' ? 0.5 : 0,
          survival.sizeMultiplier
        );
        onlineLearner.update(features, outcome, trade.realizedMultiple ?? 1);
      }
    }

    // ── Update deployer intelligence with trade outcome ──
    // ── Record antifragile heartbeat ──
    if (antifragileEngine) {
      antifragileEngine.heartbeat();
      // Check for black swan pattern from trade outcomes
      if (trade.outcome === 'LOSS') {
        const pnlPct = trade.realizedPnLUSD && trade.sizeUSD > 0
          ? (trade.realizedPnLUSD / trade.sizeUSD) * 100
          : 0;
        antifragileEngine.recordTradeOutcome(trade.tokenCA, pnlPct);
      }
    }

    logger.info('Trade closed', {
      id: trade.id,
      tokenCA: trade.tokenCA,
      outcome: trade.outcome,
      multiple: trade.realizedMultiple,
      pnlUSD: trade.realizedPnLUSD,
      exitMode: trade.exitMode,
    });

    // Journal the trade
    const journalEntry: JournalEntry = {
      id: trade.id,
      mode: trade.mode,
      tokenCA: trade.tokenCA,
      ticker: trade.ticker,
      chain: 'SOLANA',
      poolAddress: trade.poolAddress,
      entryTimestamp: trade.entryTimestamp,
      entryPriceSOL: 0,
      entryPriceUSD: 0,
      entryLiquiditySOL: 0,
      entryVolumeSOL: 0,
      entryHolderCount: 0,
      entrySmartWalletCount: 0,
      entryBuyPressure: 0,
      entrySlippage1K: 0,
      entryMarketState: trade.marketState,
      entryRegime: trade.regime,
      entryEMALayer: '',
      signalTimingEdge: trade.signal.timingEdge,
      signalDeployerQuality: trade.signal.deployerQuality,
      signalOrganicFlow: trade.signal.organicFlow,
      signalManipulationRisk: trade.signal.manipulationRisk,
      signalCoordinationStrength: trade.signal.coordinationStrength,
      signalSocialVelocity: trade.signal.socialVelocity,
      signalTotalScore: trade.signal.totalScore,
      signalConfidence: trade.signal.confidence,
      predictedWP: trade.predictedWP,
      predictedEV: trade.predictedEV,
      predictedMultiple: 0,
      sizeR: trade.sizeR,
      sizeUSD: trade.sizeUSD,
      stopPriceSOL: 0,
      maxHoldMs: trade.maxHoldMs,
      executionMode: trade.executionMode,
      deployerAddress: '',
      deployerTier: trade.deployerTier,
      rugScore: 0,
      sniperBlock0Pct: 0,
      topHolderPct: 0,
      lpLockDuration: 0,
      exitTimestamp: trade.exitTimestamp,
      exitPriceSOL: 0,
      exitMode: trade.exitMode,
      exitReason: trade.exitMode,
      holdDurationMs: trade.exitTimestamp && trade.entryTimestamp
        ? trade.exitTimestamp.getTime() - trade.entryTimestamp.getTime()
        : undefined,
      realizedMultiple: trade.realizedMultiple,
      realizedPnLUSD: trade.realizedPnLUSD,
      realizedPnLR: trade.sizeR > 0 ? (trade.realizedPnLUSD ?? 0) / trade.sizeUSD : 0,
      outcome: trade.outcome,
      peakMultiple: undefined,
      edgesFired: trade.edgesFired,
      primaryEdge: trade.edgesFired[0] ?? 'UNKNOWN',
    };
    journal?.insert(journalEntry);

    // Log equity state
    const aggression = equityCtrl.getAggressionLevel();
    const sizeMulti = equityCtrl.getSizeMultiplier();
    logger.info('Equity state', { aggression, sizeMulti });
  });

  bus.on('edge:disabled', (edge) => {
    logger.warn('Edge auto-disabled', {
      edge: edge.edge,
      winRate: (edge.winRate * 100).toFixed(1) + '%',
      rollingROI: edge.rollingROI.toFixed(3),
      totalFired: edge.totalFired,
      reason: edge.disabledReason,
    });
  });

  bus.on('survival:stateChanged', (snapshot) => {
    logger.warn('Survival state changed', {
      state: snapshot.state,
      dailyPnL: snapshot.dailyPnLPct.toFixed(1) + '%',
      weeklyPnL: snapshot.weeklyPnLPct.toFixed(1) + '%',
      consecutiveLosses: snapshot.consecutiveLosses,
      sizeMultiplier: snapshot.sizeMultiplier,
      message: snapshot.message,
    });
  });

  let haltInProgress = false;
  let lastHaltReason = '';
  let lastHaltAt = 0;
  const HALT_RECOVERY_DELAY_MS = 30_000; // 30s cooldown before restarting streams
  bus.on('system:halt', (event) => {
    const now = Date.now();
    if (haltInProgress) {
      logger.warn('Duplicate SYSTEM HALT suppressed (halt already in progress)', {
        reason: event.reason,
      });
      return;
    }
    if (lastHaltReason === event.reason && now - lastHaltAt < 30_000) {
      logger.warn('Duplicate SYSTEM HALT suppressed (same reason within 30s)', {
        reason: event.reason,
      });
      return;
    }
    haltInProgress = true;
    lastHaltReason = event.reason;
    lastHaltAt = now;

    logger.error('SYSTEM HALT', {
      reason: event.reason,
      resumeAt: event.resumeAt?.toISOString(),
    });
    void telegram.send(
      `SYSTEM HALT\nReason: ${event.reason}\nResume: auto-recovery in ${HALT_RECOVERY_DELAY_MS / 1000}s`
    );

    // Close all positions in emergency
    positionManager?.emergencyCloseAll(event.reason);
    void stopAllStreams().then(() => {
      // Auto-recover: restart streams after cooldown
      logger.info(`Halt recovery scheduled in ${HALT_RECOVERY_DELAY_MS / 1000}s`);
      setTimeout(async () => {
        try {
          logger.info('Halt recovery: restarting streams...');
          lpStream = new LPCreationStream(cfg.connection, cfg.backupConnection);
          await lpStream.start();
          await new Promise((r) => setTimeout(r, 2_000));
          walletStream = new SmartWalletStream(cfg.connection, walletRegistry, cfg.backupConnection);
          await walletStream.start();
          if (antifragileEngine) {
            antifragileEngine.heartbeat();
          }
          isShuttingDown = false;
          haltInProgress = false;
          logger.info('Halt recovery: streams restarted successfully');
          void telegram.send('SYSTEM RECOVERED\nStreams restarted after halt cooldown');
        } catch (err) {
          logger.error('Halt recovery FAILED — streams still down', {
            error: err instanceof Error ? err.message : String(err),
          });
          haltInProgress = false;
          // Will be retried on next dead man switch cycle
        }
      }, HALT_RECOVERY_DELAY_MS);
    }).catch((err) => {
      logger.error('Failed to stop streams during halt', {
        error: err instanceof Error ? err.message : String(err),
      });
      haltInProgress = false;
    });
  });

  bus.on('data:blind', (event) => {
    logger.error('DATA BLINDNESS — NO TRADES', {
      source: event.source,
      message: event.message,
    });
  });

  // ── TRADE EVENT HANDLERS ─────────────────────────────────

  bus.on('position:opened', (position) => {
    logger.info('═══ TRADE OPENED ═══', {
      id: position.id,
      tokenCA: position.tokenCA,
      mode: position.mode,
      sizeSOL: position.sizeSOL.toFixed(4),
      sizeUSD: position.sizeUSD.toFixed(2),
      maxHoldMs: position.maxHoldMs,
      stopLossPct: position.stopLossPct,
    });
    void telegram.send(
      `[${position.mode}] TRADE OPEN\n` +
      `Token: ${position.tokenCA}\n` +
      `Size: ${position.sizeSOL.toFixed(4)} SOL ($${position.sizeUSD.toFixed(2)})\n` +
      `Max Hold: ${Math.round(position.maxHoldMs / 1000)}s\n` +
      `Stop: -${(position.stopLossPct * 100).toFixed(1)}%`
    );

    const stats = positionManager!.getStats();
    logger.info('Trade stats', {
      openCount: stats.openCount,
      closedCount: stats.closedCount,
      tradesToday: stats.tradesToday,
      winRate: (stats.winRate * 100).toFixed(1) + '%',
    });

    // HybridPowerPlay: track this token through bonding curve lifecycle
    if (hybridPowerPlay) {
      hybridPowerPlay.trackToken(position.tokenCA, position.sourceWallets);
    }

    // Subscribe to pool swap events for reserve-based price tracking
    if (poolPriceStream) {
      const poolAddr = tokenPoolMap.get(position.tokenCA);
      if (poolAddr) {
        poolPriceStream.subscribe(poolAddr, position.tokenCA);
      } else {
        logger.warn('[PoolPriceStream] No pool address for token — using swap-print pricing', {
          tokenCA: position.tokenCA,
        });
      }
    }
  });

  bus.on('position:closed', (position) => {
    // Unsubscribe from pool price stream
    if (poolPriceStream) {
      poolPriceStream.unsubscribe(position.tokenCA);
    }

    // Record PnL in survival engine
    const pnlUSD = (position.realizedPnLSOL ?? 0) * (currentSOLPrice ?? 0);
    survivalEngine!.recordTrade(pnlUSD, cfg.INITIAL_CAPITAL_USD);

    if (antifragileEngine) {
      antifragileEngine.heartbeat();
      if (position.outcome === 'LOSS') {
        const pnlPct = position.sizeUSD > 0
          ? ((position.realizedPnLSOL ?? 0) * (currentSOLPrice ?? 0) / position.sizeUSD) * 100
          : 0;
        antifragileEngine.recordTradeOutcome(position.tokenCA, pnlPct);
      }
    }

    // Update smart money wallet performance tracking
    if (smartMoneyTracker && position.sourceWallets.length > 0) {
      const won = position.outcome === 'WIN';
      const multiple = position.realizedMultiple ?? 1;
      for (const wallet of position.sourceWallets) {
        smartMoneyTracker.updateWalletPerformance(wallet, won, multiple);
      }
    }

    logger.info('═══ TRADE CLOSED ═══', {
      id: position.id,
      tokenCA: position.tokenCA,
      outcome: position.outcome,
      multiple: position.realizedMultiple?.toFixed(3),
      pnlSOL: position.realizedPnLSOL?.toFixed(4),
      pnlUSD: pnlUSD.toFixed(2),
      exitReason: position.exitReason,
      holdMs: Date.now() - position.entryTimestamp.getTime(),
    });
    void telegram.send(
      `[${position.mode}] TRADE CLOSED\n` +
      `Token: ${position.tokenCA}\n` +
      `Outcome: ${position.outcome ?? 'UNKNOWN'}\n` +
      `Multiple: ${(position.realizedMultiple ?? 0).toFixed(3)}x\n` +
      `PnL: ${(position.realizedPnLSOL ?? 0).toFixed(4)} SOL ($${pnlUSD.toFixed(2)})\n` +
      `Reason: ${position.exitReason ?? 'UNKNOWN'}`
    );

    // ── Persist to journal.db so dashboard can display ──
    const holdMs = Date.now() - position.entryTimestamp.getTime();
    const ctx = tradeEntryCache.get(position.tokenCA);
    const poolAddr = tokenPoolMap.get(position.tokenCA) ?? ctx?.poolAddress ?? '';
    const exitPriceSOL = position.lastPriceSOL > 0
      ? position.lastPriceSOL
      : position.entryPriceSOL * (position.realizedMultiple ?? 1);

    // Map positionManager exitReason → ExitMode
    const exitReason = position.exitReason ?? 'UNKNOWN';
    const exitModeMap: Record<string, ExitMode> = {
      'STOP_LOSS': 'STOP_LOSS',
      'RAPID_DUMP_EXIT': 'RAPID_DUMP_EXIT',
      'EARLY_STOP': 'EARLY_STOP',
      'TRAILING_STOP': 'TRAILING_STOP',
      'ALL_TIERS_HIT': 'ALL_TIERS_HIT',
      'TIME_EXIT': 'TIME_EXIT',
      'STALE_EXIT': 'STALE_EXIT',
      'EMERGENCY': 'EMERGENCY',
    };
    const exitModeKey = Object.keys(exitModeMap).find(k => exitReason.startsWith(k));
    const resolvedExitMode: ExitMode = exitModeKey ? exitModeMap[exitModeKey] : 'UNKNOWN';

    const journalEntry: JournalEntry = {
      id: position.id,
      mode: position.mode,
      tokenCA: position.tokenCA,
      ticker: position.tokenCA.slice(0, 6) + '...',
      chain: 'SOLANA',
      poolAddress: poolAddr,
      entryTimestamp: position.entryTimestamp,
      entryPriceSOL: position.entryPriceSOL,
      entryPriceUSD: position.entryPriceSOL * (currentSOLPrice ?? 0),
      entryLiquiditySOL: 0,
      entryVolumeSOL: 0,
      entryHolderCount: 0,
      entrySmartWalletCount: position.sourceWallets.length,
      entryBuyPressure: 0,
      entrySlippage1K: 0,
      entryMarketState: ctx?.entryMarketState ?? 'NORMAL',
      entryRegime: ctx?.entryRegime ?? 'NORMAL',
      entryEMALayer: '',
      signalTimingEdge: ctx?.signal.timingEdge ?? 0,
      signalDeployerQuality: ctx?.signal.deployerQuality ?? 0,
      signalOrganicFlow: ctx?.signal.organicFlow ?? 0,
      signalManipulationRisk: ctx?.signal.manipulationRisk ?? 0,
      signalCoordinationStrength: ctx?.signal.coordinationStrength ?? 0,
      signalSocialVelocity: ctx?.signal.socialVelocity ?? 0,
      signalTotalScore: ctx?.signal.totalScore ?? 0,
      signalConfidence: ctx?.signal.confidence ?? 0,
      predictedWP: ctx?.predictedWP ?? 0,
      predictedEV: ctx?.predictedEV ?? 0,
      predictedMultiple: 0,
      sizeR: 0,
      sizeUSD: position.sizeUSD,
      stopPriceSOL: position.entryPriceSOL * (1 - position.stopLossPct),
      maxHoldMs: position.maxHoldMs,
      executionMode: ctx?.executionMode ?? 'SAFE',
      deployerAddress: ctx?.deployerAddress ?? '',
      deployerTier: ctx?.deployerTier ?? 'B',
      rugScore: 0,
      sniperBlock0Pct: 0,
      topHolderPct: 0,
      lpLockDuration: 0,
      exitTimestamp: new Date(),
      exitPriceSOL,
      exitMode: resolvedExitMode,
      exitReason,
      holdDurationMs: holdMs,
      realizedMultiple: position.realizedMultiple,
      realizedPnLUSD: pnlUSD,
      realizedPnLR: position.sizeUSD > 0 ? pnlUSD / position.sizeUSD : 0,
      outcome: position.outcome,
      peakMultiple: position.peakPriceSOL && position.entryPriceSOL > 0
        ? position.peakPriceSOL / position.entryPriceSOL : undefined,
      edgesFired: [ctx?.source ?? 'AUTONOMOUS'],
      primaryEdge: ctx?.source ?? 'AUTONOMOUS',
    };
    journal?.insert(journalEntry);

    // Record in paper gate for gate progression
    if (position.mode === 'PAPER') {
      const tradeRecord: TradeRecord = {
        id: position.id,
        mode: 'PAPER',
        tokenCA: position.tokenCA,
        ticker: position.tokenCA.slice(0, 6) + '...',
        poolAddress: poolAddr,
        entryPriceLamports: BigInt(Math.round(position.entryPriceSOL * 1e9)),
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: new Date(),
        exitPriceLamports: BigInt(Math.round(exitPriceSOL * 1e9)),
        exitMode: resolvedExitMode,
        outcome: position.outcome ?? 'LOSS',
        realizedMultiple: position.realizedMultiple ?? 0,
        realizedPnLUSD: pnlUSD,
        predictedWP: ctx?.predictedWP ?? 0,
        predictedEV: ctx?.predictedEV ?? 0,
        sizeR: 0,
        sizeUSD: position.sizeUSD,
        stopPriceLamports: BigInt(Math.round(position.entryPriceSOL * (1 - position.stopLossPct) * 1e9)),
        signal: ctx?.signal ?? {
          timingEdge: 0,
          deployerQuality: 0,
          organicFlow: 0,
          manipulationRisk: 0,
          coordinationStrength: 0,
          socialVelocity: 0,
          totalScore: 0,
          confidence: 0,
        },
        rugRisk: 'LOW',
        edgesFired: ['AUTONOMOUS' as const],
        marketState: (ctx?.entryMarketState as any) ?? 'NORMAL',
        regime: (ctx?.entryRegime as any) ?? 'NORMAL',
        deployerTier: (ctx?.deployerTier as any) ?? 'B',
        maxHoldMs: position.maxHoldMs,
        executionMode: (ctx?.executionMode as any) ?? 'SAFE',
      };
      paperGate.addTrade(tradeRecord);

      // Log updated paper gate status
      const gateStatus = paperGate.getStatus();
      logger.info(`PAPER TRADES: ${gateStatus.completedTrades}/${gateStatus.requiredTrades}`, {
        winRate: (gateStatus.actualWinRate * 100).toFixed(1) + '%',
        ev: gateStatus.actualEV.toFixed(3),
      });
    }

    // Clean up entry context cache
    tradeEntryCache.delete(position.tokenCA);

    // Log running stats
    const stats = positionManager!.getStats();
    logger.info('Running trade stats', {
      totalClosed: stats.closedCount,
      wins: stats.wins,
      losses: stats.losses,
      winRate: (stats.winRate * 100).toFixed(1) + '%',
      totalPnLSOL: stats.totalPnLSOL.toFixed(4),
    });
  });

  bus.on('safety:blocked', (event) => {
    logger.warn('Token blocked by safety checker', {
      tokenCA: event.tokenCA,
      reasons: event.reasons,
    });
  });

  // ═══════════════════════════════════════════════════════════
  //  ADVANCED ENGINE EVENT HANDLERS
  // ═══════════════════════════════════════════════════════════

  bus.on('ml:prediction', ({ tokenCA, prediction }) => {
    logger.debug('ML prediction', {
      tokenCA,
      wp: prediction.winProbability.toFixed(3),
      ev: prediction.expectedValue.toFixed(3),
      confidence: prediction.confidence.toFixed(3),
      regime: prediction.regime,
    });
  });

  bus.on('regime:changed', (snapshot) => {
    logger.info('═══ REGIME CHANGE ═══', {
      regime: snapshot.currentRegime,
      riskMultiplier: snapshot.riskMultiplier.toFixed(2),
      confidence: snapshot.confidence.toFixed(3),
    });
  });

  bus.on('blackswan:detected', (event) => {
    logger.error('═══ BLACK SWAN DETECTED ═══', {
      type: event.type,
      severity: event.severity,
      affectedPositions: event.affectedPositions.length,
      action: event.recommendedAction,
    });

    // Emergency response
    if (event.severity === 'FATAL') {
      positionManager?.emergencyCloseAll(`Black swan: ${event.type}`);
    }
  });

  let lastHealthStatus = antifragileEngine?.getSystemHealth().overallStatus ?? 'HEALTHY';
  bus.on('health:changed', (health) => {
    logger.info('System health changed', {
      status: health.overallStatus,
      uptimeMs: health.uptimeMs,
    });

    if (health.overallStatus !== lastHealthStatus) {
      if (health.overallStatus === 'HEALTHY' && lastHealthStatus !== 'HEALTHY') {
        void telegram.send(`SYSTEM RECOVERED\nPrevious: ${lastHealthStatus}\nCurrent: HEALTHY`);
      } else if (health.overallStatus !== 'HEALTHY') {
        void telegram.send(
          `SYSTEM HEALTH ALERT\nStatus: ${health.overallStatus}\nUptime: ${Math.round(health.uptimeMs / 1000)}s`
        );
      }
      lastHealthStatus = health.overallStatus;
    }

    // Auto-halt on DEAD
    if (health.overallStatus === 'DEAD') {
      bus.emit('system:halt', { reason: 'System health DEAD - all circuit breakers open' });
    }
  });

  bus.on('social:signal', (signal) => {
    logger.info('Social signal', {
      tokenCA: signal.tokenCA,
      source: signal.source,
      sentiment: signal.sentiment.toFixed(2),
      kolMentions: signal.kolMentions,
      hypeCycle: signal.hypeCycle,
      socialScore: signal.socialScore,
    });
  });

  bus.on('deployer:analyzed', (profile) => {
    logger.debug('Deployer analyzed', {
      address: profile.address.slice(0, 8) + '...',
      tier: profile.tier,
      reputation: profile.reputationScore,
      totalLaunches: profile.totalLaunches,
    });
  });

  bus.on('simulation:complete', (result) => {
    logger.debug('Pool simulation', {
      tokenCA: result.tokenCA,
      exitLiquiditySOL: result.exitLiquiditySOL.toFixed(2),
      sandwichRisk: result.sandwichRisk.toFixed(1),
      holderDist: result.holderDistribution,
      recommendation: result.recommendation,
    });
  });

  // 7. Start ingestion streams (with backup connection for failover)
  // Stagger startup to avoid simultaneous WS connections triggering 429s
  lpStream = new LPCreationStream(cfg.connection, cfg.backupConnection);
  await lpStream.start();
  await new Promise((r) => setTimeout(r, 2_000)); // 2s gap before wallet stream
  walletStream = new SmartWalletStream(cfg.connection, walletRegistry, cfg.backupConnection);
  await walletStream.start();

  // 8. Final status banner
  logger.info('════════════════════════════════════════════');
  logger.info('  TRADING ENGINE v6.0 — FULLY AUTONOMOUS');
  logger.info('════════════════════════════════════════════');
  logger.info(`  STATUS: ACTIVE`);
  logger.info(`  MODE: ${cfg.isPaperMode ? 'PAPER' : 'LIVE'}`);
  logger.info(`  STRATEGY: AUTONOMOUS_ONLY`);
  logger.info(`  TELEGRAM: ${telegram.isEnabled() ? 'ENABLED' : 'DISABLED'}`);
  logger.info(`  WALLETS: ${walletRegistry.count()}`);
  logger.info(`  DEPLOYERS: ${deployerRegistry.count()}`);
  logger.info(`  DEPLOYER INTEL: ${deployerIntel ? 'ACTIVE' : 'N/A'}`);
  logger.info(`  PAPER TRADES: ${gateStatus.completedTrades}/${gateStatus.requiredTrades}`);
  logger.info(`  GATE: ${gateStatus.gateUnlocked ? 'UNLOCKED' : 'LOCKED'}`);
  logger.info(`  EDGES ENABLED: ${perfEngine.getReport().filter((e) => e.isEnabled).length}/7`);
  logger.info(`  AGGRESSION: ${equityCtrl.getAggressionLevel()}`);
  logger.info(`  EQUITY DD: ${equityCtrl.getMetrics().drawdownPct.toFixed(1)}%`);
  logger.info(`  JOURNAL: ${journal.count()} trades`);
  logger.info('  ── ADVANCED ENGINES ──');
  logger.info(`  ML MODEL: ${onlineLearner ? 'ACTIVE' : 'DISABLED'}`);
  logger.info(`  HMM REGIME: ${regimeDetector?.getLatestSnapshot().currentRegime ?? 'N/A'}`);
  logger.info(`  PORTFOLIO OPT: ${portfolioOptimizer ? 'ACTIVE' : 'DISABLED'}`);
  logger.info(`  EXECUTION: ${executionEngine ? 'ACTIVE' : 'DISABLED'}`);
  logger.info(`  EXEC WALLET: ${executionWallet ? executionWallet.publicKey.toBase58() : 'UNSET'}`);
  logger.info(`  ANTIFRAGILE: ${antifragileEngine?.getSystemHealth().overallStatus ?? 'N/A'}`);
  logger.info(`  SOCIAL: ${socialEngine ? 'ACTIVE' : 'DISABLED'}`);
  logger.info(`  SIMULATOR: ${simulator ? 'ACTIVE' : 'DISABLED'}`);
  logger.info('  ── TRADE CONFIG ──');
  logger.info(`  POSITION SIZE: ${(cfg.TRADE_SIZE_PCT * 100).toFixed(0)}% of capital`);
  logger.info(`  STOP LOSS: -${(cfg.TRADE_STOP_LOSS_PCT * 100).toFixed(0)}%`);
  logger.info(`  MAX HOLD: ${Math.round(cfg.TRADE_MAX_HOLD_MS / 1000)}s`);
  logger.info(`  MAX CONCURRENT: ${cfg.MAX_CONCURRENT_POSITIONS}`);
  logger.info(`  MAX DAILY: ${cfg.MAX_TRADES_PER_DAY}`);
  logger.info(`  KELLY FRACTION: ${cfg.KELLY_FRACTION}`);
  logger.info(`  MEV PROTECTION: ${cfg.MEV_PROTECTION_ENABLED}`);
  logger.info('════════════════════════════════════════════');

  // ── Periodic heartbeat: prevents dead man switch from killing engine during quiet periods ──
  const heartbeatInterval = setInterval(() => {
    if (antifragileEngine) {
      antifragileEngine.heartbeat();
    }
  }, 60_000); // every 60s — well within the 120s timeout
  heartbeatInterval.unref(); // don't prevent process exit
  logger.info('Heartbeat interval started (60s)');

  const opsInterval = setInterval(() => {
    if (executionEngine) {
      const quality = executionEngine.getExecutionQuality();
      logger.info('Execution quality snapshot', {
        avgSlippageBps: quality.avgSlippageBps.toFixed(1),
        avgImpactBps: quality.avgImpactBps.toFixed(1),
        totalExecutions: quality.totalExecutions,
        avgGrade: quality.avgGrade,
      });
    }
    if (antifragileEngine) {
      const health = antifragileEngine.getSystemHealth();
      logger.info('Health snapshot', {
        status: health.overallStatus,
        rpcPrimary: health.rpcPrimary.status,
        rpcBackup: health.rpcBackup.status,
        jupiter: health.jupiterAPI.status,
        helius: health.heliusWebsocket.status,
      });
    }
  }, 300_000);
  opsInterval.unref();
  logger.info('Operations snapshot interval started (300s)');

  // ── Start cloud data sync ──────────────────────────────
  dataSync.start();
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Wait for in-flight executions to settle (up to maxMs).
 */
function waitForInflightExecutions(maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxMs;
    const check = () => {
      if (!executionEngine || executionEngine.inflightCount === 0 || Date.now() >= deadline) {
        return resolve();
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function stopAllStreams(): Promise<void> {
  logger.info('Stopping all streams and engines...');

  // ── Phase 1: Stop accepting new signals ──────────────
  isShuttingDown = true;

  // ── Phase 2: Wait for in-flight executions (3s grace) ─
  if (executionEngine && executionEngine.inflightCount > 0) {
    logger.info(`Waiting for ${executionEngine.inflightCount} in-flight execution(s)...`);
    await waitForInflightExecutions(3_000);
  }

  // ── Phase 3: Persist critical state first ─────────────
  if (journal) {
    try { journal.close(); logger.info('Journal flushed & closed'); }
    catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      logger.error('Journal close failed', { error: msg });
    }
  }
  if (onlineLearner) {
    try { onlineLearner.save(); } catch { /* ignore */ }
  }
  if (regimeDetector) {
    try { regimeDetector.save(); } catch { /* ignore */ }
  }
  if (deployerIntel) {
    try { deployerIntel.save(); } catch { /* ignore */ }
  }

  // ── Phase 4: Stop subsystems (allSettled — one hung service won't block others) ─
  await Promise.allSettled([
    survivalEngine ? Promise.resolve(survivalEngine.stop()) : Promise.resolve(),
    positionManager ? Promise.resolve(positionManager.stop()) : Promise.resolve(),
    antifragileEngine ? Promise.resolve(antifragileEngine.stop()) : Promise.resolve(),
    statArbEngine ? Promise.resolve(statArbEngine.stop()) : Promise.resolve(),
    smartMoneyTracker ? Promise.resolve(smartMoneyTracker.stop()) : Promise.resolve(),
    toxicFlowBackrunner ? Promise.resolve(toxicFlowBackrunner.stop()) : Promise.resolve(),
    hybridPowerPlay ? Promise.resolve(hybridPowerPlay.stop()) : Promise.resolve(),
  ]);

  // ── Phase 5: Close connections last ───────────────────
  await Promise.allSettled([
    lpStream ? lpStream.stop() : Promise.resolve(),
    walletStream ? walletStream.stop() : Promise.resolve(),
    poolPriceStream ? poolPriceStream.stop() : Promise.resolve(),
  ]);

  if (positionPricePoller) positionPricePoller.stop();

  // ── Phase 6: Sync data to cloud ───────────────────────
  await dataSync.shutdown();

  logger.info('All streams and engines stopped');
}

async function shutdown(): Promise<void> {
  if (isShuttingDown) return; // prevent double-shutdown
  logger.info('Graceful shutdown initiated');

  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error(`Shutdown timeout after ${SHUTDOWN_TIMEOUT_MS / 1000}s`)), SHUTDOWN_TIMEOUT_MS)
  );

  try {
    await Promise.race([stopAllStreams(), timeout]);
    logger.info('Clean shutdown complete');
  } catch (err) {
    logger.error('Forced shutdown', { error: err instanceof Error ? err.message : String(err) });
    // Last-ditch journal flush even on timeout
    if (journal) {
      try { journal.close(); } catch (e) { logger.error('Last-ditch journal flush failed', { error: String(e) }); }
    }
  }

  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    logger.info(`Received ${sig}`);
    void shutdown();
  });
}

process.on('uncaughtException', async (err) => {
  logger.error('UNCAUGHT EXCEPTION', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  console.error('UNCAUGHT EXCEPTION:', err);
  // Last-ditch journal flush before crash
  if (journal) {
    try { journal.close(); } catch { /* best effort */ }
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  // logsUnsubscribe on dead sockets is benign — don't crash/shutdown for it
  if (msg.includes('logsSubscribe') || msg.includes('logsUnsubscribe') || msg.includes('readyState')) {
    logger.warn('Suppressed benign unhandled rejection', { error: msg });
    return;
  }
  logger.error('UNHANDLED REJECTION', {
    error: msg,
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  console.error('UNHANDLED REJECTION:', reason);
  // Trigger graceful shutdown — continuing after unhandled rejection risks zombie state
  void shutdown();
});

boot().catch((err) => {
  logger.error('BOOT FAILED', { error: err instanceof Error ? err.message : String(err) });
  console.error('BOOT FAILED:', err);
  process.exit(1);
});
