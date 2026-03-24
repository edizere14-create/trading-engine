import { config } from './core/config';
import { logger } from './core/logger';
import { bus } from './core/eventBus';

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

// ── NEW: Copy trade infrastructure ────────────────────────
import { SwapSignalEvaluator } from './signals/swapSignalEvaluator';
import { CopyTradeManager } from './copyTrade/copyTradeManager';
import { WalletPerformanceTracker } from './copyTrade/walletPerformanceTracker';
import { TokenSafetyChecker } from './safety/tokenSafetyChecker';

let lpStream: LPCreationStream | null = null;
let walletStream: SmartWalletStream | null = null;
let survivalEngine: SurvivalEngine | null = null;
let copyTradeManager: CopyTradeManager | null = null;

async function boot(): Promise<void> {
  logger.info('═══════════════════════════════════════════');
  logger.info('  TRADING ENGINE v4.1 — BOOTING');
  logger.info('═══════════════════════════════════════════');

  // 1. Config validation — fail fast
  const cfg = config.load();

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
  survivalEngine = new SurvivalEngine(cfg.INITIAL_CAPITAL_USD);
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

  // 6. Wire event bus listeners

  bus.on('pool:created', (event) => {
    // Filter out micro-liquidity pools
    if (event.initialLiquiditySOL < cfg.MIN_LIQUIDITY_SOL) return;

    logger.info('Pool detected', {
      tokenCA: event.tokenCA,
      deployer: event.deployer,
      liqSOL: event.initialLiquiditySOL,
      source: event.source,
    });

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

    // Risk decision
    const risk = riskEngine.decide(
      cfg.INITIAL_CAPITAL_USD,
      signal,
      marketSnapshot,
      survival,
      signal.totalScore / 10, // normalize to 0–1 for WP
      2.0 // default predicted multiple
    );

    logger.info('Trade decision', {
      tokenCA: event.tokenCA,
      allowed: risk.tradeAllowed,
      sizeUSD: risk.sizeUSD.toFixed(2),
      executionMode: risk.executionMode,
      maxHoldMs: risk.maxHoldMs,
      reason: risk.reason,
    });
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

  // ── COPY SIGNAL → SAFETY CHECK → OPEN TRADE ──
  bus.on('copy:signal', async (signal) => {
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

    // Get survival state
    const survival = survivalEngine!.getSnapshot();

    // Open the trade
    const opened = copyTradeManager!.openTrade(signal, survival);
    if (opened) {
      swapEvaluator.markEmitted(signal.tokenCA);
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

  bus.on('system:halt', (event) => {
    logger.error('SYSTEM HALT', {
      reason: event.reason,
      resumeAt: event.resumeAt?.toISOString(),
    });

    // Stop all streams on halt
    // Close all copy positions in emergency
    copyTradeManager?.emergencyCloseAll(event.reason);
    stopAllStreams();
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

  // 7. Start ingestion streams (with backup connection for failover)
  lpStream = new LPCreationStream(cfg.connection, cfg.backupConnection);
  walletStream = new SmartWalletStream(cfg.connection, walletRegistry, cfg.backupConnection);
  await lpStream.start();
  await walletStream.start();

  // 8. Final status banner
  logger.info('════════════════════════════════════════════');
  logger.info('  TRADING ENGINE v5.0 — COPY TRADE ACTIVE');
  logger.info('════════════════════════════════════════════');
  logger.info(`  STATUS: ACTIVE`);
  logger.info(`  MODE: ${cfg.isPaperMode ? 'PAPER' : 'LIVE'}`);
  logger.info(`  WALLETS: ${walletRegistry.count()}`);
  logger.info(`  DEPLOYERS: ${deployerRegistry.count()}`);
  logger.info(`  PAPER TRADES: ${gateStatus.completedTrades}/${gateStatus.requiredTrades}`);
  logger.info(`  GATE: ${gateStatus.gateUnlocked ? 'UNLOCKED' : 'LOCKED'}`);
  logger.info(`  EDGES ENABLED: ${perfEngine.getReport().filter((e) => e.isEnabled).length}/7`);
  logger.info(`  AGGRESSION: ${equityCtrl.getAggressionLevel()}`);
  logger.info(`  EQUITY DD: ${equityCtrl.getMetrics().drawdownPct.toFixed(1)}%`);
  logger.info(`  JOURNAL: ${journal.count()} trades`);
  logger.info('  ── COPY TRADE CONFIG ──');
  logger.info(`  MIN SWAP: ${cfg.MIN_COPY_SWAP_SOL} SOL`);
  logger.info(`  POSITION SIZE: ${(cfg.COPY_SIZE_PCT * 100).toFixed(0)}% of capital`);
  logger.info(`  STOP LOSS: -${(cfg.COPY_STOP_LOSS_PCT * 100).toFixed(0)}%`);
  logger.info(`  MAX HOLD: ${Math.round(cfg.COPY_MAX_HOLD_MS / 1000)}s`);
  logger.info(`  MAX CONCURRENT: ${cfg.MAX_CONCURRENT_POSITIONS}`);
  logger.info(`  MAX DAILY: ${cfg.MAX_TRADES_PER_DAY}`);
  logger.info('════════════════════════════════════════════');
}

async function stopAllStreams(): Promise<void> {
  logger.info('Stopping all streams...');
  if (lpStream) await lpStream.stop();
  if (walletStream) await walletStream.stop();
  if (survivalEngine) survivalEngine.stop();
  if (copyTradeManager) copyTradeManager.stop();
  logger.info('All streams stopped');
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
