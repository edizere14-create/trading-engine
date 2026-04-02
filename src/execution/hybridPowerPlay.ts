/**
 * HYBRID POWER PLAY — Three-Stage Token Lifecycle Strategy
 *
 * Orchestrates a token through its full PumpFun lifecycle:
 *
 * Stage 1 (Bonding Curve): SmartMoneyTracker detects 3+ Tier-S wallets accumulating
 * within 10s → enter. Monitor bonding curve completion via virtual reserves.
 * Mandatory CURVE_SAFETY_EXIT at 85% completion before migration chaos.
 *
 * Stage 2 (Transition): Watch PumpSwap Migration Account
 * 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg for migration events.
 * Suppress ALL trade signals for 30s to let MEV toxic flow settle.
 *
 * Stage 3 (Post-Migration Backrun): Monitor PumpSwap Program
 * pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA for sandwich attacks.
 * Enter when dip exceeds 20% of natural price. Exit at 70% mean reversion.
 */

import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { bus } from '../core/eventBus';
import { SwapEvent } from '../core/types';
import { PositionManager } from '../position/positionManager';
import { logger } from '../core/logger';
import { enableWsReconnect } from '../ingestion/wsControl';

// ── PUMPFUN / PUMPSWAP CONSTANTS ──────────────────────────

const PUMPSWAP_MIGRATION_ACCOUNT = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// ── STAGE 1 CONFIG ────────────────────────────────────────

const CURVE_COMPLETION_THRESHOLD = 0.85;       // 85% → mandatory exit
const VIRTUAL_SOL_RESERVE_INITIAL = 30;        // PumpFun virtual SOL reserve
const MIGRATION_SOL_THRESHOLD = 85;            // ~85 SOL real triggers migration

// ── STAGE 2 CONFIG ────────────────────────────────────────

const MIGRATION_SUPPRESSION_MS = 30_000;       // 30s signal blackout

// ── STAGE 3 CONFIG ────────────────────────────────────────

const POST_MIGRATION_DIP_THRESHOLD = 0.20;     // 20% dip from natural price
const REBALANCE_TARGET_PCT = 0.70;             // 70% mean reversion target
const POST_MIGRATION_MAX_HOLD_MS = 30_000;     // 30s max hold for backrun
const SANDWICH_WINDOW_MS = 15_000;             // 15s sandwich detection window
const MAX_SLOT_GAP = 3;                        // max slot gap for sandwich legs
const MIN_ATTACK_SIZE_SOL = 0.5;               // min frontrun size

// ── GENERAL ───────────────────────────────────────────────

const CLEANUP_INTERVAL_MS = 60_000;
const MAX_SWAPS_PER_TOKEN = 100;
const STALE_TOKEN_MS = 600_000;                // 10 min stale cleanup

// ── TYPES ─────────────────────────────────────────────────

type TokenStage = 'BONDING_CURVE' | 'MIGRATING' | 'POST_MIGRATION' | 'COMPLETED';

interface TokenLifecycle {
  tokenCA: string;
  stage: TokenStage;
  accumulatedSOL: number;
  curveCompletionPct: number;
  enteredAt: number;
  migrationDetectedAt?: number;
  migrationCompleteAt?: number;
  suppressUntil?: number;
  smartMoneyWallets: string[];
  preMigrationPrices: number[];
  naturalPrice?: number;
  postMigrationSwaps: SwapRecord[];
  curveSafetyExitFired: boolean;
}

interface SwapRecord {
  wallet: string;
  action: 'BUY' | 'SELL';
  amountSOL: number;
  priceSOL: number;
  timestamp: number;
  slot: number;
}

// ── ENGINE ─────────────────────────────────────────────────

export class HybridPowerPlay {
  private connection: Connection;
  private positionManager: PositionManager;
  private tokens: Map<string, TokenLifecycle> = new Map();
  private knownPools: Set<string> = new Set();
  private migrationSubId: number | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private active = false;

  // Stats
  private totalStage1Entries = 0;
  private totalCurveSafetyExits = 0;
  private totalMigrationsDetected = 0;
  private totalStage3Backruns = 0;
  private totalSuppressedSignals = 0;

  constructor(connection: Connection, positionManager: PositionManager) {
    this.connection = connection;
    this.positionManager = positionManager;
  }

  async start(): Promise<void> {
    this.active = true;
    // Limit WS auto-reconnects (default is Infinity)
    enableWsReconnect(this.connection, 3);

    // Track which tokens already have DEX pools (post-migration)
    bus.on('pool:created', (event) => {
      this.knownPools.add(event.tokenCA);
      // If we're tracking this token in BONDING_CURVE, migration just happened
      const lifecycle = this.tokens.get(event.tokenCA);
      if (lifecycle && lifecycle.stage === 'BONDING_CURVE') {
        this.transitionToMigrating(lifecycle);
      }
    });

    // Process swaps for bonding curve tracking + post-migration sandwich detection
    bus.on('swap:detected', (event) => this.onSwap(event));

    // Monitor PumpSwap Migration Account
    await this.subscribeMigrationAccount();

    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);

    logger.info('HybridPowerPlay started', {
      migrationAccount: PUMPSWAP_MIGRATION_ACCOUNT,
      pumpswapProgram: PUMPSWAP_PROGRAM,
      curveThreshold: `${CURVE_COMPLETION_THRESHOLD * 100}%`,
      suppressionMs: MIGRATION_SUPPRESSION_MS,
      dipThreshold: `${POST_MIGRATION_DIP_THRESHOLD * 100}%`,
      rebalanceTarget: `${REBALANCE_TARGET_PCT * 100}%`,
    });
  }

  stop(): void {
    this.active = false;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.removeMigrationSubscription();
  }

  getStats() {
    const stages = { bonding: 0, migrating: 0, postMigration: 0, completed: 0 };
    for (const t of this.tokens.values()) {
      if (t.stage === 'BONDING_CURVE') stages.bonding++;
      else if (t.stage === 'MIGRATING') stages.migrating++;
      else if (t.stage === 'POST_MIGRATION') stages.postMigration++;
      else stages.completed++;
    }
    return {
      trackedTokens: this.tokens.size,
      ...stages,
      totalStage1Entries: this.totalStage1Entries,
      totalCurveSafetyExits: this.totalCurveSafetyExits,
      totalMigrationsDetected: this.totalMigrationsDetected,
      totalStage3Backruns: this.totalStage3Backruns,
      totalSuppressedSignals: this.totalSuppressedSignals,
    };
  }

  // ── PUBLIC API ───────────────────────────────────────────

  /**
   * Begin tracking a token through its lifecycle.
   * Called when SmartMoneyTracker fires a convergence signal.
   */
  trackToken(tokenCA: string, sourceWallets: string[] = []): void {
    if (this.tokens.has(tokenCA)) return;

    // If a pool already exists, this token has already migrated
    const stage: TokenStage = this.knownPools.has(tokenCA) ? 'POST_MIGRATION' : 'BONDING_CURVE';

    this.tokens.set(tokenCA, {
      tokenCA,
      stage,
      accumulatedSOL: 0,
      curveCompletionPct: 0,
      enteredAt: Date.now(),
      smartMoneyWallets: sourceWallets,
      preMigrationPrices: [],
      postMigrationSwaps: [],
      curveSafetyExitFired: false,
      ...(stage === 'POST_MIGRATION' ? { migrationCompleteAt: Date.now() } : {}),
    });

    this.totalStage1Entries++;

    logger.info('HybridPowerPlay: tracking token', {
      tokenCA,
      stage,
      sourceWallets: sourceWallets.length,
    });
  }

  /**
   * Check if trade signals for this token should be suppressed.
   * Called by the trade:signal handler in index.ts BEFORE opening trades.
   */
  shouldSuppressSignal(tokenCA: string): boolean {
    const lifecycle = this.tokens.get(tokenCA);
    if (!lifecycle) return false;

    if (lifecycle.suppressUntil && Date.now() < lifecycle.suppressUntil) {
      this.totalSuppressedSignals++;
      logger.info('HybridPowerPlay: signal SUPPRESSED (migration cooldown)', {
        tokenCA,
        remainingMs: lifecycle.suppressUntil - Date.now(),
      });
      return true;
    }

    return false;
  }

  // ── STAGE 1: BONDING CURVE ──────────────────────────────

  private onSwap(event: SwapEvent): void {
    if (!this.active) return;

    const lifecycle = this.tokens.get(event.tokenCA);
    if (!lifecycle) return;

    switch (lifecycle.stage) {
      case 'BONDING_CURVE':
        this.handleBondingCurveSwap(lifecycle, event);
        break;
      case 'POST_MIGRATION':
        this.handlePostMigrationSwap(lifecycle, event);
        break;
    }
  }

  private handleBondingCurveSwap(lifecycle: TokenLifecycle, event: SwapEvent): void {
    // Track net SOL flowing into the bonding curve
    if (event.action === 'BUY') {
      lifecycle.accumulatedSOL += event.amountSOL;
    } else {
      lifecycle.accumulatedSOL = Math.max(0, lifecycle.accumulatedSOL - event.amountSOL);
    }

    // Track price history for natural price estimation
    lifecycle.preMigrationPrices.push(event.priceSOL);
    if (lifecycle.preMigrationPrices.length > 200) {
      lifecycle.preMigrationPrices = lifecycle.preMigrationPrices.slice(-100);
    }

    // Bonding curve completion = accumulated real SOL / migration threshold
    lifecycle.curveCompletionPct = Math.min(1, lifecycle.accumulatedSOL / MIGRATION_SOL_THRESHOLD);

    // CURVE_SAFETY_EXIT at 85% — close before migration chaos
    if (lifecycle.curveCompletionPct >= CURVE_COMPLETION_THRESHOLD && !lifecycle.curveSafetyExitFired) {
      this.triggerCurveSafetyExit(lifecycle, event.priceSOL);
    }
  }

  private triggerCurveSafetyExit(lifecycle: TokenLifecycle, currentPriceSOL: number): void {
    lifecycle.curveSafetyExitFired = true;
    this.totalCurveSafetyExits++;

    // Calculate natural price from recent price history (median)
    const sorted = [...lifecycle.preMigrationPrices].sort((a, b) => a - b);
    lifecycle.naturalPrice = sorted[Math.floor(sorted.length / 2)] || currentPriceSOL;

    const reason = `CURVE_SAFETY_EXIT (${(lifecycle.curveCompletionPct * 100).toFixed(1)}% bonding curve, ${lifecycle.accumulatedSOL.toFixed(2)} SOL accumulated)`;

    logger.info('HybridPowerPlay: CURVE_SAFETY_EXIT', {
      tokenCA: lifecycle.tokenCA,
      curveCompletionPct: (lifecycle.curveCompletionPct * 100).toFixed(1),
      accumulatedSOL: lifecycle.accumulatedSOL.toFixed(2),
      naturalPrice: lifecycle.naturalPrice.toFixed(10),
    });

    // Force close the position via PositionManager
    this.positionManager.forceClose(lifecycle.tokenCA, reason, currentPriceSOL);

    // Transition: now waiting for migration
    lifecycle.stage = 'MIGRATING';
  }

  // ── STAGE 2: MIGRATION DETECTION + SIGNAL SUPPRESSION ───

  private async subscribeMigrationAccount(): Promise<void> {
    try {
      const migrationPubkey = new PublicKey(PUMPSWAP_MIGRATION_ACCOUNT);

      this.migrationSubId = this.connection.onLogs(
        migrationPubkey,
        (logs: Logs, _ctx: Context) => {
          if (logs.err) return;
          this.handleMigrationLogs(logs, _ctx);
        },
        'confirmed',
      );

      logger.info('HybridPowerPlay: subscribed to PumpSwap Migration Account', {
        account: PUMPSWAP_MIGRATION_ACCOUNT,
      });
    } catch (err) {
      logger.error('HybridPowerPlay: migration subscription failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleMigrationLogs(logs: Logs, ctx: Context): void {
    const tokenCA = this.extractTokenFromMigrationLogs(logs);
    if (!tokenCA) return;

    const lifecycle = this.tokens.get(tokenCA);
    if (!lifecycle) {
      // Migration for a token we're not tracking — record pool and move on
      this.knownPools.add(tokenCA);
      logger.debug('HybridPowerPlay: migration for untracked token', {
        tokenCA,
        slot: ctx.slot,
      });
      return;
    }

    this.knownPools.add(tokenCA);
    this.transitionToMigrating(lifecycle);
  }

  private transitionToMigrating(lifecycle: TokenLifecycle): void {
    if (lifecycle.stage !== 'BONDING_CURVE' && lifecycle.stage !== 'MIGRATING') return;

    this.totalMigrationsDetected++;

    const now = Date.now();
    lifecycle.migrationDetectedAt = now;
    lifecycle.suppressUntil = now + MIGRATION_SUPPRESSION_MS;
    lifecycle.stage = 'MIGRATING';

    // Calculate natural price before migration turbulence
    if (!lifecycle.naturalPrice && lifecycle.preMigrationPrices.length > 0) {
      const sorted = [...lifecycle.preMigrationPrices].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median && median > 0) {
        lifecycle.naturalPrice = median;
      } else {
        logger.warn('HybridPowerPlay: invalid median price during migration — naturalPrice unset', {
          tokenCA: lifecycle.tokenCA,
          pricesSampled: sorted.length,
        });
      }
    }

    logger.info('HybridPowerPlay: MIGRATION DETECTED — 30s signal suppression', {
      tokenCA: lifecycle.tokenCA,
      naturalPrice: lifecycle.naturalPrice?.toFixed(10),
      suppressUntilMs: MIGRATION_SUPPRESSION_MS,
    });

    // After suppression window: transition to Stage 3
    setTimeout(() => {
      if (lifecycle.stage === 'MIGRATING') {
        lifecycle.stage = 'POST_MIGRATION';
        lifecycle.migrationCompleteAt = Date.now();
        lifecycle.postMigrationSwaps = [];

        logger.info('HybridPowerPlay: Stage 3 ACTIVE — monitoring toxic flow', {
          tokenCA: lifecycle.tokenCA,
          naturalPrice: lifecycle.naturalPrice?.toFixed(10),
        });
      }
    }, MIGRATION_SUPPRESSION_MS);
  }

  private extractTokenFromMigrationLogs(logs: Logs): string | null {
    // PumpSwap migration logs reference the token mint as a base58 address.
    // We scan log lines for potential mint addresses, skipping known programs.
    const skipAddresses = new Set([
      PUMPSWAP_MIGRATION_ACCOUNT,
      PUMPSWAP_PROGRAM,
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',       // SPL Token
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',      // ATA
      '11111111111111111111111111111111',                     // System
      'So11111111111111111111111111111111111111112',           // Wrapped SOL
    ]);

    for (const line of logs.logs) {
      if (!line.includes('Program log:') && !line.toLowerCase().includes('migrat')) continue;

      const matches = line.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
      if (!matches) continue;

      for (const match of matches) {
        if (skipAddresses.has(match)) continue;
        // First non-system address is likely the token mint
        return match;
      }
    }
    return null;
  }

  // ── STAGE 3: POST-MIGRATION SANDWICH BACKRUN ────────────

  private handlePostMigrationSwap(lifecycle: TokenLifecycle, event: SwapEvent): void {
    const record: SwapRecord = {
      wallet: event.wallet,
      action: event.action,
      amountSOL: event.amountSOL,
      priceSOL: event.priceSOL,
      timestamp: Date.now(),
      slot: event.slot,
    };

    lifecycle.postMigrationSwaps.push(record);
    if (lifecycle.postMigrationSwaps.length > MAX_SWAPS_PER_TOKEN) {
      lifecycle.postMigrationSwaps = lifecycle.postMigrationSwaps.slice(-MAX_SWAPS_PER_TOKEN);
    }

    // Only check for sandwich pattern after a SELL (the attacker's backrun leg)
    if (event.action === 'SELL') {
      this.detectPostMigrationSandwich(lifecycle, record);
    }
  }

  private detectPostMigrationSandwich(lifecycle: TokenLifecycle, latestSell: SwapRecord): void {
    const swaps = lifecycle.postMigrationSwaps;
    if (swaps.length < 3) return;

    const now = Date.now();
    const recentSwaps = swaps.filter(s => now - s.timestamp < SANDWICH_WINDOW_MS);
    if (recentSwaps.length < 3) return;

    const sellerWallet = latestSell.wallet;

    // Leg 1: Find frontrun BUY from same wallet
    const attackerBuy = recentSwaps.find(
      s => s.wallet === sellerWallet
        && s.action === 'BUY'
        && s.amountSOL >= MIN_ATTACK_SIZE_SOL
        && s.timestamp < latestSell.timestamp
        && Math.abs(s.slot - latestSell.slot) <= MAX_SLOT_GAP,
    );
    if (!attackerBuy) return;

    // Leg 2: Find victim BUY from a DIFFERENT wallet between frontrun and backrun
    const victimBuy = recentSwaps.find(
      s => s.wallet !== sellerWallet
        && s.action === 'BUY'
        && s.timestamp > attackerBuy.timestamp
        && s.timestamp < latestSell.timestamp,
    );
    if (!victimBuy) return;

    // Natural price: use pre-migration estimate or pre-attack median
    const naturalPrice = lifecycle.naturalPrice ?? this.estimateNaturalPrice(lifecycle, attackerBuy.timestamp);
    // Guard: null, undefined, zero, NaN all produce garbage division
    if (!naturalPrice || !Number.isFinite(naturalPrice) || naturalPrice <= 0) {
      logger.warn('HybridPowerPlay: Stage 3 skipped — invalid naturalPrice', {
        tokenCA: lifecycle.tokenCA,
        naturalPrice,
      });
      return;
    }

    const postAttackPrice = latestSell.priceSOL;
    if (!postAttackPrice || postAttackPrice <= 0) return;

    const dipPct = (naturalPrice - postAttackPrice) / naturalPrice;

    // Stage 3 gate: dip must be 20-50% of natural price
    if (dipPct < POST_MIGRATION_DIP_THRESHOLD || dipPct > 0.50) return;

    this.emitBackrunSignal(lifecycle, naturalPrice, postAttackPrice, dipPct, latestSell.slot, attackerBuy.amountSOL);
  }

  private estimateNaturalPrice(lifecycle: TokenLifecycle, beforeTimestamp: number): number {
    // Prefer pre-migration prices if available
    if (lifecycle.preMigrationPrices.length > 0) {
      const sorted = [...lifecycle.preMigrationPrices].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }

    // Fall back to pre-attack swap prices
    const preAttack = lifecycle.postMigrationSwaps
      .filter(s => s.timestamp < beforeTimestamp && s.timestamp > beforeTimestamp - 10_000)
      .map(s => s.priceSOL);

    if (preAttack.length === 0) return 0;

    const sorted = preAttack.sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private emitBackrunSignal(
    lifecycle: TokenLifecycle,
    naturalPrice: number,
    postAttackPrice: number,
    dipPct: number,
    slot: number,
    attackSize: number,
  ): void {
    const recoveryTarget = postAttackPrice + (naturalPrice - postAttackPrice) * REBALANCE_TARGET_PCT;
    const expectedProfitPct = ((recoveryTarget - postAttackPrice) / postAttackPrice) * 100;

    // NaN firewall — catch any upstream arithmetic corruption before it reaches trade:signal
    if (!Number.isFinite(expectedProfitPct) || !Number.isFinite(recoveryTarget)) {
      logger.error('[HybridPowerPlay] Non-finite backrun calc — dropping signal', {
        tokenCA: lifecycle.tokenCA,
        naturalPrice,
        postAttackPrice,
        recoveryTarget,
        expectedProfitPct,
      });
      return;
    }

    if (expectedProfitPct < 1.0) return;

    // Confidence: higher for PumpSwap-specific context than generic backrunner
    let confidence = 0.6;
    if (dipPct >= 0.25) confidence += 0.1;
    if (dipPct >= 0.30) confidence += 0.05;
    if (lifecycle.naturalPrice) confidence += 0.1; // have pre-migration baseline
    confidence = Math.min(1, confidence);

    this.totalStage3Backruns++;

    logger.info('HybridPowerPlay: Stage 3 BACKRUN signal', {
      tokenCA: lifecycle.tokenCA,
      dipPct: (dipPct * 100).toFixed(2),
      naturalPrice: naturalPrice.toFixed(10),
      postAttackPrice: postAttackPrice.toFixed(10),
      recoveryTarget: recoveryTarget.toFixed(10),
      expectedProfitPct: expectedProfitPct.toFixed(2),
      confidence: confidence.toFixed(2),
    });

    bus.emit('trade:signal', {
      tokenCA: lifecycle.tokenCA,
      source: 'AUTONOMOUS' as const,
      triggerWallet: 'HYBRID_POWER_PLAY_BACKRUN',
      walletTier: 'S' as const,
      walletPnL30d: 0,
      convictionSOL: Math.min(0.5, attackSize * 0.3),
      clusterWallets: lifecycle.smartMoneyWallets,
      clusterSize: lifecycle.smartMoneyWallets.length,
      totalClusterSOL: 0,
      entryPriceSOL: Math.max(postAttackPrice, 0.000001),
      timestamp: new Date(),
      slot,
      score: Math.min(10, 6 + expectedProfitPct * 0.4),
      confidence,
      overrideSizeUSD: undefined,
      overrideMaxHoldMs: POST_MIGRATION_MAX_HOLD_MS,
    });

    lifecycle.stage = 'COMPLETED';
  }

  // ── CLEANUP ──────────────────────────────────────────────

  private readonly MAX_TRACKED_TOKENS = 300;

  private cleanup(): void {
    const now = Date.now();
    for (const [tokenCA, lifecycle] of this.tokens) {
      // Remove completed tokens after 5 minutes
      if (lifecycle.stage === 'COMPLETED' && now - lifecycle.enteredAt > 300_000) {
        this.tokens.delete(tokenCA);
        continue;
      }
      // Remove stale tokens with no activity (any stage)
      if (now - lifecycle.enteredAt > STALE_TOKEN_MS) {
        this.tokens.delete(tokenCA);
      }
    }

    // Hard cap — evict oldest entries (Map preserves insertion order)
    while (this.tokens.size > this.MAX_TRACKED_TOKENS) {
      const oldestKey = this.tokens.keys().next().value;
      if (oldestKey) this.tokens.delete(oldestKey);
      else break;
    }
  }

  private removeMigrationSubscription(): void {
    if (this.migrationSubId !== null) {
      this.connection.removeOnLogsListener(this.migrationSubId).catch(() => {});
      this.migrationSubId = null;
    }
  }
}
