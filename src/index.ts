import { config } from './core/config';
import { logger } from './core/logger';
import { bus } from './core/eventBus';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

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

import { TradeJournal } from './journal/tradeJournal';
import { FactorEngine } from './factors/factorEngine';
import { EquityCurveController } from './equity/equityCurveController';
import { MicrostructureFeatureExtractor } from './microstructure/featureExtractor';
import { ReplaySimulator } from './replay/replaySimulator';
import { JournalEntry } from './journal/journalTypes';
import { TradeRecord } from './core/types';

// ── Copy trade infrastructure ─────────────────────────────
import { SwapSignalEvaluator } from './signals/swapSignalEvaluator';
import { CopyTradeManager } from './copyTrade/copyTradeManager';
import { WalletPerformanceTracker } from './copyTrade/walletPerformanceTracker';
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

let lpStream: LPCreationStream | null = null;
let walletStream: SmartWalletStream | null = null;
let survivalEngine: SurvivalEngine | null = null;
let copyTradeManager: CopyTradeManager | null = null;
let antifragileEngine: AntifragileEngine | null = null;
let onlineLearner: OnlineLearner | null = null;
let regimeDetector: HiddenMarkovRegimeDetector | null = null;
let portfolioOptimizer: PortfolioOptimizer | null = null;
let executionEngine: ExecutionEngine | null = null;
let deployerIntel: DeployerIntelligence | null = null;
let socialEngine: SocialSignalEngine | null = null;
let simulator: OnChainSimulator | null = null;

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

async function boot(): Promise<void> {
  logger.info('═══════════════════════════════════════════');
  logger.info('  TRADING ENGINE v4.1 — BOOTING');
  logger.info('═══════════════════════════════════════════');

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
    paperGate.assertLiveCapitalAllowed();
  }
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
  const signalAggregator = new SignalAggregator(deployerRegistry, walletRegistry, DEFAULT_WEIGHTS);

  // 5b. Intelligence infrastructure
  const journal = new TradeJournal('./data/journal.db');
  await journal.waitReady();
  const factorEngine = new FactorEngine(journal);
  const equityCtrl = new EquityCurveController(cfg.INITIAL_CAPITAL_USD, journal);
  const microExtractor = new MicrostructureFeatureExtractor();
  const replayEngine = new ReplaySimulator(journal, riskEngine);

  // 5c. Copy trade infrastructure
  const walletTracker = new WalletPerformanceTracker(
    walletRegistry,
    cfg.WALLET_COOLDOWN_LOSSES,
    cfg.WALLET_COOLDOWN_HOURS
  );

  const swapEvaluator = new SwapSignalEvaluator(
    walletRegistry,
    cfg.MIN_COPY_SWAP_SOL,
    cfg.MAX_COPY_SWAP_SOL,
    cfg.TOKEN_MAX_AGE_MS
  );

  const tokenSafety = new TokenSafetyChecker(cfg.connection);

  // SOL price estimate — will be updated by market engine
  let currentSOLPrice = 150; // conservative default

  copyTradeManager = new CopyTradeManager(
    {
      mode: cfg.isPaperMode ? 'PAPER' : 'LIVE',
      capitalUSD: cfg.INITIAL_CAPITAL_USD,
      copySizePct: cfg.COPY_SIZE_PCT,
      maxConcurrent: cfg.MAX_CONCURRENT_POSITIONS,
      maxTradesPerDay: cfg.MAX_TRADES_PER_DAY,
      stopLossPct: cfg.COPY_STOP_LOSS_PCT,
      maxHoldMs: cfg.COPY_MAX_HOLD_MS,
      clusterBonusPct: cfg.COPY_CLUSTER_BONUS_PCT,
      reBuyExtendMs: cfg.REBUY_CONVICTION_EXTEND_MS,
      solPriceUSD: currentSOLPrice,
    },
    walletTracker
  );
  copyTradeManager.start();

  logger.info('Copy trade infrastructure initialized', {
    minSwapSOL: cfg.MIN_COPY_SWAP_SOL,
    maxSwapSOL: cfg.MAX_COPY_SWAP_SOL,
    copySizePct: cfg.COPY_SIZE_PCT,
    stopLossPct: cfg.COPY_STOP_LOSS_PCT,
    maxHoldMs: cfg.COPY_MAX_HOLD_MS,
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

  // 6. Wire event bus listeners

  bus.on('pool:created', async (event) => {
    // Filter out micro-liquidity pools
    if (event.initialLiquiditySOL < cfg.MIN_LIQUIDITY_SOL) return;

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
        cfg.INITIAL_CAPITAL_USD / currentSOLPrice * (cfg.COPY_SIZE_PCT),
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
      const prediction = onlineLearner.predict(features);
      mlWinProb = prediction.winProbability;
      bus.emit('ml:prediction', { tokenCA: event.tokenCA, prediction });
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
      2.0 // default predicted multiple
    );

    // ── Portfolio-level sizing ──
    if (portfolioOptimizer && risk.tradeAllowed) {
      const narrative = portfolioOptimizer.classifyNarrative(event.tokenCA, '');
      const regime = regimeDetector?.getLatestSnapshot().currentRegime ?? 'NEUTRAL';
      const sizing = portfolioOptimizer.calculateOptimalSize(
        cfg.INITIAL_CAPITAL_USD,
        mlWinProb,
        2.0,
        event.tokenCA,
        narrative,
        [],  // current positions — would need access to copyTradeManager internal state
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

    if (!cfg.isAutonomousOnly || !risk.tradeAllowed) {
      return;
    }

    if (risk.sizeUSD < 1) {
      logger.info('Autonomous trade blocked: size below minimum', {
        tokenCA: event.tokenCA,
        sizeUSD: risk.sizeUSD.toFixed(2),
      });
      return;
    }

    if (copyTradeManager!.hasPosition(event.tokenCA) || swapEvaluator.hasEmitted(event.tokenCA)) {
      return;
    }

    const autonomousSignal = {
      tokenCA: event.tokenCA,
      source: 'AUTONOMOUS' as const,
      triggerWallet: 'AUTONOMOUS_ENGINE',
      walletTier: 'S' as const,
      walletPnL30d: 0,
      convictionSOL: risk.sizeUSD / Math.max(currentSOLPrice, 1),
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
    bus.emit('copy:signal', autonomousSignal);
  });

  bus.on('swap:detected', (event) => {
    logger.debug('Swap detected', {
      wallet: event.wallet,
      tokenCA: event.tokenCA,
      action: event.action,
      amountSOL: event.amountSOL,
      isSmartWallet: event.isSmartWallet,
    });

    // Feed into microstructure extractor (always — full data)
    microExtractor.addSwap(event);

    // Keep autonomous positions marked-to-market from live swap prints.
    if (copyTradeManager!.hasPosition(event.tokenCA)) {
      copyTradeManager!.updatePrice(event.tokenCA, event.priceSOL);
    }

    // Autonomous-only mode disables wallet-copy entries.
    if (cfg.isAutonomousOnly) {
      return;
    }

    // ── SELL HANDLING: mirror sells for open positions ──
    if (event.action === 'SELL' && copyTradeManager!.hasPosition(event.tokenCA)) {
      copyTradeManager!.handleMirrorSell(event);
      return;
    }

    // ── BUY HANDLING: evaluate for copy trade ──
    if (event.action === 'BUY') {
      // Check for re-buy on existing position
      if (copyTradeManager!.hasPosition(event.tokenCA)) {
        copyTradeManager!.handleReBuy(event);
        return;
      }

      // Evaluate signal quality
      const signal = swapEvaluator.evaluate(event);
      if (!signal) return;

      // Deduplicate: don't open same token twice
      if (swapEvaluator.hasEmitted(signal.tokenCA)) {
        logger.debug('Signal deduped — already traded', { tokenCA: signal.tokenCA });
        return;
      }

      // Emit the signal
      bus.emit('copy:signal', signal);
    }
  });

  // ── COPY SIGNAL → SAFETY CHECK → SIMULATION → OPEN TRADE ──
  bus.on('copy:signal', async (signal) => {
    // Check antifragile health
    if (antifragileEngine) {
      const health = antifragileEngine.getSystemHealth();
      if (health.overallStatus === 'CRITICAL' || health.overallStatus === 'DEAD') {
        logger.warn('Copy signal BLOCKED — system health', { state: health.overallStatus });
        return;
      }
    }

    logger.info('Copy signal received', {
      tokenCA: signal.tokenCA,
      source: signal.source,
      wallet: signal.triggerWallet,
      tier: signal.walletTier,
      score: signal.score.toFixed(1),
      convictionSOL: signal.convictionSOL,
      clusterSize: signal.clusterSize,
    });

    // Token safety check (async — uses RPC)
    const safety = await tokenSafety.check(signal.tokenCA);
    if (!safety.isSafe) {
      logger.warn('Copy trade BLOCKED by safety', {
        tokenCA: signal.tokenCA,
        rugScore: safety.rugScore,
        reasons: safety.reasons,
      });
      return;
    }

    // ── Deployer intelligence check ──
    if (deployerIntel && signal.source !== 'AUTONOMOUS') {
      // Try to identify deployer from the signal context
      const profile = deployerIntel.getProfile(signal.triggerWallet);
      if (profile && profile.tier === 'BLACKLIST') {
        logger.warn('Copy trade BLOCKED — trigger wallet linked to blacklisted deployer');
        return;
      }
    }

    // Get survival state
    const survival = survivalEngine!.getSnapshot();

    // ── Portfolio optimization sizing ──
    if (portfolioOptimizer && signal.source !== 'AUTONOMOUS') {
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
        2.0,
        signal.tokenCA,
        narrative,
        [],
        regime,
        signal.confidence
      );

      if (sizing.recommendedSizeUSD < 1) {
        logger.warn('Copy trade BLOCKED — portfolio optimizer rejected', {
          tokenCA: signal.tokenCA,
          reason: sizing.reason,
          coldStart: mlSamples < 20,
        });
        return;
      }
    }

    if (signal.source === 'AUTONOMOUS' && !cfg.isPaperMode) {
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

      const stats = copyTradeManager!.getStats();
      if (survival.state === 'HALT') {
        logger.warn('Autonomous execution blocked by survival HALT', { tokenCA: signal.tokenCA });
        return;
      }
      if (copyTradeManager!.hasPosition(signal.tokenCA)) {
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
          ? signal.overrideSizeUSD / Math.max(currentSOLPrice, 1)
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

      const plan = executionEngine.createExecutionPlan(
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
    const opened = copyTradeManager!.openTrade(signal, survival);
    if (opened) {
      swapEvaluator.markEmitted(signal.tokenCA);

      // Record heartbeat for antifragile dead-man's switch
      if (antifragileEngine) {
        antifragileEngine.heartbeat();
      }
    } else if (signal.source === 'AUTONOMOUS' && !cfg.isPaperMode) {
      logger.error('Autonomous signal failed to open a local position after execution checks', {
        tokenCA: signal.tokenCA,
      });
      void telegram.send(
        `AUTONOMOUS WARNING\nToken: ${signal.tokenCA}\nReason: local position tracking failed`
      );
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

    if (cfg.isAutonomousOnly) {
      return;
    }

    // ── CLUSTER = HIGHEST CONFIDENCE SIGNAL ──
    // If we already have a position, the re-buy handler covers it.
    // If not, and we haven't traded this token, generate a cluster signal.
    if (copyTradeManager!.hasPosition(alert.tokenCA)) {
      logger.info('Cluster alert on existing position — conviction reinforced', {
        tokenCA: alert.tokenCA,
      });
      return;
    }

    if (swapEvaluator.hasEmitted(alert.tokenCA)) {
      return;
    }

    // Build a high-confidence cluster signal
    const bestWallet = alert.wallets[0];
    const walletStats = walletRegistry.getWalletStats(bestWallet);
    const tier = walletStats?.tier ?? 'B';

    bus.emit('copy:signal', {
      tokenCA: alert.tokenCA,
      source: 'CLUSTER',
      triggerWallet: bestWallet,
      walletTier: tier,
      walletPnL30d: walletStats?.pnl30d ?? 0,
      convictionSOL: alert.totalWeightedPnL / 100, // rough estimate
      clusterWallets: alert.wallets,
      clusterSize: alert.wallets.length,
      totalClusterSOL: alert.totalWeightedPnL / 100,
      entryPriceSOL: 0, // will be filled from swap data
      timestamp: alert.triggeredAt,
      slot: 0,
      score: Math.min(10, 4 + alert.wallets.length * 1.5), // cluster = high score
      confidence: Math.min(1, 0.5 + alert.wallets.length * 0.1),
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
    if (deployerIntel && trade.deployerTier !== 'UNKNOWN') {
      const pnlPct = trade.realizedPnLUSD && trade.sizeUSD > 0
        ? (trade.realizedPnLUSD / trade.sizeUSD) * 100
        : 0;
      deployerIntel.recordCopyTradeOutcome(trade.tokenCA, pnlPct);
    }

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
    journal.insert(journalEntry);

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
      `SYSTEM HALT\nReason: ${event.reason}\nResume: ${event.resumeAt?.toISOString() ?? 'manual'}`
    );

    // Stop all streams on halt
    // Close all copy positions in emergency
    copyTradeManager?.emergencyCloseAll(event.reason);
    void stopAllStreams().catch((err) => {
      logger.error('Failed to stop streams during halt', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  bus.on('data:blind', (event) => {
    logger.error('DATA BLINDNESS — NO TRADES', {
      source: event.source,
      message: event.message,
    });
  });

  // ── COPY TRADE EVENT HANDLERS ───────────────────────────

  bus.on('copy:opened', (position) => {
    logger.info('═══ COPY TRADE OPENED ═══', {
      id: position.id,
      tokenCA: position.tokenCA,
      mode: position.mode,
      sizeSOL: position.sizeSOL.toFixed(4),
      sizeUSD: position.sizeUSD.toFixed(2),
      sourceWallets: position.sourceWallets.length,
      maxHoldMs: position.maxHoldMs,
      stopLossPct: position.stopLossPct,
    });
    const strategy = position.sourceWallets.includes('AUTONOMOUS_ENGINE') ? 'AUTONOMOUS' : 'COPY';
    void telegram.send(
      `[${position.mode}] ${strategy} OPEN\n` +
      `Token: ${position.tokenCA}\n` +
      `Size: ${position.sizeSOL.toFixed(4)} SOL ($${position.sizeUSD.toFixed(2)})\n` +
      `Max Hold: ${Math.round(position.maxHoldMs / 1000)}s\n` +
      `Stop: -${(position.stopLossPct * 100).toFixed(1)}%`
    );

    // Record in survival engine as a pending trade
    const stats = copyTradeManager!.getStats();
    logger.info('Copy trade stats', {
      openCount: stats.openCount,
      closedCount: stats.closedCount,
      tradesToday: stats.tradesToday,
      winRate: (stats.winRate * 100).toFixed(1) + '%',
    });
  });

  bus.on('copy:closed', (position) => {
    // Record PnL in survival engine
    const pnlUSD = (position.realizedPnLSOL ?? 0) * currentSOLPrice;
    survivalEngine!.recordTrade(pnlUSD, cfg.INITIAL_CAPITAL_USD);

    // ── ML + Intelligence Feedback ──
    if (deployerIntel) {
      const pnlPct = pnlUSD > 0 && position.sizeUSD > 0
        ? (pnlUSD / position.sizeUSD) * 100
        : 0;
      deployerIntel.recordCopyTradeOutcome(position.tokenCA, pnlPct);
    }
    if (antifragileEngine) {
      antifragileEngine.heartbeat();
      if (position.outcome === 'LOSS') {
        const pnlPct = position.sizeUSD > 0
          ? ((position.realizedPnLSOL ?? 0) * currentSOLPrice / position.sizeUSD) * 100
          : 0;
        antifragileEngine.recordTradeOutcome(position.tokenCA, pnlPct);
      }
    }

    logger.info('═══ COPY TRADE CLOSED ═══', {
      id: position.id,
      tokenCA: position.tokenCA,
      outcome: position.outcome,
      multiple: position.realizedMultiple?.toFixed(3),
      pnlSOL: position.realizedPnLSOL?.toFixed(4),
      pnlUSD: pnlUSD.toFixed(2),
      exitReason: position.exitReason,
      holdMs: Date.now() - position.entryTimestamp.getTime(),
      reBuyCount: position.reBuyCount,
    });
    const strategy = position.sourceWallets.includes('AUTONOMOUS_ENGINE') ? 'AUTONOMOUS' : 'COPY';
    void telegram.send(
      `[${position.mode}] ${strategy} CLOSED\n` +
      `Token: ${position.tokenCA}\n` +
      `Outcome: ${position.outcome ?? 'UNKNOWN'}\n` +
      `Multiple: ${(position.realizedMultiple ?? 0).toFixed(3)}x\n` +
      `PnL: ${(position.realizedPnLSOL ?? 0).toFixed(4)} SOL ($${pnlUSD.toFixed(2)})\n` +
      `Reason: ${position.exitReason ?? 'UNKNOWN'}`
    );

    // ── Persist to journal.db so dashboard can display ──
    const holdMs = Date.now() - position.entryTimestamp.getTime();
    const journalEntry: JournalEntry = {
      id: position.id,
      mode: position.mode,
      tokenCA: position.tokenCA,
      ticker: position.tokenCA.slice(0, 6) + '...',
      chain: 'SOLANA',
      poolAddress: '',
      entryTimestamp: position.entryTimestamp,
      entryPriceSOL: position.entryPriceSOL,
      entryPriceUSD: position.entryPriceSOL * currentSOLPrice,
      entryLiquiditySOL: 0,
      entryVolumeSOL: 0,
      entryHolderCount: 0,
      entrySmartWalletCount: position.sourceWallets.length,
      entryBuyPressure: 0,
      entrySlippage1K: 0,
      entryMarketState: 'NORMAL',
      entryRegime: 'NORMAL',
      entryEMALayer: '',
      signalTimingEdge: 0,
      signalDeployerQuality: 0,
      signalOrganicFlow: 0,
      signalManipulationRisk: 0,
      signalCoordinationStrength: position.sourceWallets.length > 1 ? 1 : 0,
      signalSocialVelocity: 0,
      signalTotalScore: 0,
      signalConfidence: 0,
      predictedWP: 0,
      predictedEV: 0,
      predictedMultiple: 0,
      sizeR: 0,
      sizeUSD: position.sizeUSD,
      stopPriceSOL: 0,
      maxHoldMs: position.maxHoldMs,
      executionMode: 'COPY_TRADE',
      deployerAddress: '',
      deployerTier: 'B',
      rugScore: 0,
      sniperBlock0Pct: 0,
      topHolderPct: 0,
      lpLockDuration: 0,
      exitTimestamp: new Date(),
      exitPriceSOL: position.entryPriceSOL * (position.realizedMultiple ?? 1),
      exitMode: position.exitReason ?? 'UNKNOWN',
      exitReason: position.exitReason ?? 'UNKNOWN',
      holdDurationMs: holdMs,
      realizedMultiple: position.realizedMultiple,
      realizedPnLUSD: pnlUSD,
      realizedPnLR: position.sizeUSD > 0 ? pnlUSD / position.sizeUSD : 0,
      outcome: position.outcome,
      peakMultiple: position.peakPriceSOL && position.entryPriceSOL > 0
        ? position.peakPriceSOL / position.entryPriceSOL : undefined,
      edgesFired: ['COPY_TRADE'],
      primaryEdge: 'COPY_TRADE',
      notes: `Source: COPY_TRADE, Wallets: ${position.sourceWallets.length}, ReBuys: ${position.reBuyCount}`,
    };
    journal.insert(journalEntry);

    // Record in paper gate for gate progression
    if (position.mode === 'PAPER') {
      const tradeRecord: TradeRecord = {
        id: position.id,
        mode: 'PAPER',
        tokenCA: position.tokenCA,
        ticker: position.tokenCA.slice(0, 6) + '...',
        poolAddress: '',
        entryPriceLamports: BigInt(Math.round(position.entryPriceSOL * 1e9)),
        entryTimestamp: position.entryTimestamp,
        exitTimestamp: new Date(),
        exitPriceLamports: BigInt(Math.round(position.entryPriceSOL * (position.realizedMultiple ?? 1) * 1e9)),
        exitMode: 'TIME_EXIT',
        outcome: position.outcome ?? 'LOSS',
        realizedMultiple: position.realizedMultiple ?? 0,
        realizedPnLUSD: pnlUSD,
        predictedWP: 0,
        predictedEV: 0,
        sizeR: 0,
        sizeUSD: position.sizeUSD,
        stopPriceLamports: BigInt(0),
        signal: {
          timingEdge: 0,
          deployerQuality: 0,
          organicFlow: 0,
          manipulationRisk: 0,
          coordinationStrength: position.sourceWallets.length > 1 ? 5 : 0,
          socialVelocity: 0,
          totalScore: 0,
          confidence: 0,
        },
        rugRisk: 'LOW',
        edgesFired: ['COPY_TRADE'],
        marketState: 'NORMAL',
        regime: 'NORMAL',
        deployerTier: 'B',
        maxHoldMs: position.maxHoldMs,
        executionMode: 'SAFE',
      };
      paperGate.addTrade(tradeRecord);

      // Log updated paper gate status
      const gateStatus = paperGate.getStatus();
      logger.info(`PAPER TRADES: ${gateStatus.completedTrades}/${gateStatus.requiredTrades}`, {
        winRate: (gateStatus.actualWinRate * 100).toFixed(1) + '%',
        ev: gateStatus.actualEV.toFixed(3),
      });
    }

    // Log running stats
    const stats = copyTradeManager!.getStats();
    logger.info('Running copy stats', {
      totalClosed: stats.closedCount,
      wins: stats.wins,
      losses: stats.losses,
      winRate: (stats.winRate * 100).toFixed(1) + '%',
      totalPnLSOL: stats.totalPnLSOL.toFixed(4),
    });

    // Wallet performance rankings (every 10 trades)
    if (stats.closedCount % 10 === 0) {
      const ranked = walletTracker.getRankedWallets();
      if (ranked.length > 0) {
        logger.info('Wallet performance rankings', {
          top3: ranked.slice(0, 3).map(w => ({
            wallet: w.address.slice(0, 8) + '...',
            winRate: (w.copiedWinRate * 100).toFixed(0) + '%',
            pnlSOL: w.totalPnLSOL.toFixed(3),
            trades: w.copiedTrades,
          })),
        });
      }
    }
  });

  bus.on('copy:mirrorSell', (event) => {
    logger.info('Mirror sell executed', {
      tokenCA: event.tokenCA,
      wallet: event.wallet,
      amountSOL: event.amountSOL,
    });
  });

  bus.on('copy:reBuy', (event) => {
    logger.info('Re-buy conviction boost', {
      tokenCA: event.tokenCA,
      wallet: event.wallet,
      amountSOL: event.amountSOL,
      reBuyCount: event.reBuyCount,
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
      copyTradeManager?.emergencyCloseAll(`Black swan: ${event.type}`);
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
  lpStream = new LPCreationStream(cfg.connection, cfg.backupConnection);
  walletStream = new SmartWalletStream(cfg.connection, walletRegistry, cfg.backupConnection);
  await lpStream.start();
  await walletStream.start();

  // 8. Final status banner
  logger.info('════════════════════════════════════════════');
  logger.info('  TRADING ENGINE v6.0 — FULLY AUTONOMOUS');
  logger.info('════════════════════════════════════════════');
  logger.info(`  STATUS: ACTIVE`);
  logger.info(`  MODE: ${cfg.isPaperMode ? 'PAPER' : 'LIVE'}`);
  logger.info(`  STRATEGY: ${cfg.isAutonomousOnly ? 'AUTONOMOUS_ONLY' : 'COPY_ENABLED'}`);
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
  logger.info('  ── COPY TRADE CONFIG ──');
  logger.info(`  MIN SWAP: ${cfg.MIN_COPY_SWAP_SOL} SOL`);
  logger.info(`  POSITION SIZE: ${(cfg.COPY_SIZE_PCT * 100).toFixed(0)}% of capital`);
  logger.info(`  STOP LOSS: -${(cfg.COPY_STOP_LOSS_PCT * 100).toFixed(0)}%`);
  logger.info(`  MAX HOLD: ${Math.round(cfg.COPY_MAX_HOLD_MS / 1000)}s`);
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
}

async function stopAllStreams(): Promise<void> {
  logger.info('Stopping all streams and engines...');
  if (lpStream) await lpStream.stop();
  if (walletStream) await walletStream.stop();
  if (survivalEngine) survivalEngine.stop();
  if (copyTradeManager) copyTradeManager.stop();
  if (antifragileEngine) antifragileEngine.stop();
  // Persist ML models on shutdown
  if (onlineLearner) {
    try { onlineLearner.save(); } catch { /* ignore */ }
  }
  if (regimeDetector) {
    try { regimeDetector.save(); } catch { /* ignore */ }
  }
  if (deployerIntel) {
    try { deployerIntel.save(); } catch { /* ignore */ }
  }
  logger.info('All streams and engines stopped');
}

async function shutdown(): Promise<void> {
  logger.info('Graceful shutdown initiated');
  await stopAllStreams();
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });

process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION — restarting streams', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  console.error('UNCAUGHT EXCEPTION:', err);
  // Let Railway restart the process
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('UNHANDLED REJECTION', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  console.error('UNHANDLED REJECTION:', reason);
  // Don't crash — log and continue
});

boot().catch((err) => {
  logger.error('BOOT FAILED', { error: err instanceof Error ? err.message : String(err) });
  console.error('BOOT FAILED:', err);
  process.exit(1);
});
