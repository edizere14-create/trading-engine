/**
 * ═══════════════════════════════════════════════════════════════
 *  ANTI-FRAGILITY ENGINE — Black Swan Detection & Circuit Breakers
 * ═══════════════════════════════════════════════════════════════
 * 
 * Implements:
 * 1. Correlated drawdown detection (portfolio-level stop)
 * 2. Cascade failure protection
 * 3. RPC/Jupiter health monitoring with circuit breakers
 * 4. Automatic strategy rotation based on performance
 * 5. Regime-aware parameter tuning
 * 6. Adversarial scenario detection
 * 7. Dead man's switch (auto-shutdown if no heartbeat)
 */

import { bus } from '../core/eventBus';
import { logger } from '../core/logger';
import { HMMRegime } from '../ml/regimeHMM';

// ── TYPES ─────────────────────────────────────────────────

export interface CircuitBreakerState {
  name: string;
  status: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failureCount: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
  openedAt: Date | null;
  halfOpenAt: Date | null;
  cooldownMs: number;
}

export interface SystemHealth {
  rpcPrimary: CircuitBreakerState;
  rpcBackup: CircuitBreakerState;
  jupiterAPI: CircuitBreakerState;
  heliusWebsocket: CircuitBreakerState;
  overallStatus: 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'DEAD';
  lastHeartbeat: Date;
  uptimeMs: number;
}

export interface BlackSwanEvent {
  type: 'CORRELATED_DRAWDOWN' | 'FLASH_CRASH' | 'LIQUIDITY_CRISIS' | 'RPC_OUTAGE' | 'MASS_RUG';
  severity: 'WARNING' | 'CRITICAL' | 'FATAL';
  description: string;
  affectedPositions: string[];
  recommendedAction: 'REDUCE_SIZE' | 'CLOSE_ALL' | 'HALT' | 'MONITOR';
  detectedAt: Date;
}

export interface RegimeParameters {
  maxConcurrent: number;
  maxTradesPerDay: number;
  stopLossPct: number;
  maxHoldMs: number;
  copySizePct: number;
  minSignalScore: number;
  minConfidence: number;
}

export interface AntifragileOptions {
  correlatedDrawdownThreshold: number;
  correlatedDrawdownFatalThreshold: number;
  correlatedDrawdownWindowMs: number;
  massRugThreshold: number;
  massRugWindowMs: number;
}

// ── CIRCUIT BREAKER ───────────────────────────────────────

class CircuitBreaker {
  state: CircuitBreakerState;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(name: string, failureThreshold = 5, cooldownMs = 60_000) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.state = {
      name,
      status: 'CLOSED',
      failureCount: 0,
      lastFailure: null,
      lastSuccess: null,
      openedAt: null,
      halfOpenAt: null,
      cooldownMs,
    };
  }

  recordSuccess(): void {
    this.state.failureCount = 0;
    this.state.lastSuccess = new Date();
    if (this.state.status === 'HALF_OPEN') {
      this.state.status = 'CLOSED';
      logger.info(`Circuit breaker CLOSED: ${this.state.name}`);
    }
  }

  recordFailure(): void {
    this.state.failureCount++;
    this.state.lastFailure = new Date();

    if (this.state.failureCount >= this.failureThreshold && this.state.status === 'CLOSED') {
      this.state.status = 'OPEN';
      this.state.openedAt = new Date();
      logger.error(`Circuit breaker OPENED: ${this.state.name}`, {
        failures: this.state.failureCount,
      });
    }
  }

  canExecute(): boolean {
    if (this.state.status === 'CLOSED') return true;

    if (this.state.status === 'OPEN') {
      const elapsed = Date.now() - (this.state.openedAt?.getTime() ?? 0);
      if (elapsed > this.cooldownMs) {
        this.state.status = 'HALF_OPEN';
        this.state.halfOpenAt = new Date();
        return true; // allow one test request
      }
      return false;
    }

    return true; // HALF_OPEN allows one request
  }

  getState(): CircuitBreakerState {
    return { ...this.state };
  }
}

// ── ANTI-FRAGILITY ENGINE ─────────────────────────────────

export class AntifragileEngine {
  // Circuit breakers
  private rpcPrimary: CircuitBreaker;
  private rpcBackup: CircuitBreaker;
  private jupiterAPI: CircuitBreaker;
  private heliusWS: CircuitBreaker;

  // Black swan detection
  private positionPnLs: Map<string, number[]> = new Map(); // tokenCA → recent PnLs
  private recentLosses: { timestamp: Date; pnlPct: number; tokenCA: string }[] = [];
  private blackSwanEvents: BlackSwanEvent[] = [];

  // Strategy rotation
  private edgePerformanceWindow: Map<string, { wins: number; losses: number; roi: number }> = new Map();
  private readonly ROTATION_WINDOW = 20; // trades

  // Dead man's switch
  private lastHeartbeat: Date = new Date();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private readonly MAX_HEARTBEAT_GAP_MS = 120_000; // 2 minutes
  private options: AntifragileOptions;

  // System start time
  private startTime: Date = new Date();
  private lastOverallStatus: SystemHealth['overallStatus'] = 'HEALTHY';

  constructor(options?: Partial<AntifragileOptions>) {
    this.rpcPrimary = new CircuitBreaker('RPC_PRIMARY', 5, 30_000);
    this.rpcBackup = new CircuitBreaker('RPC_BACKUP', 5, 30_000);
    this.jupiterAPI = new CircuitBreaker('JUPITER_API', 3, 45_000);
    this.heliusWS = new CircuitBreaker('HELIUS_WS', 3, 60_000);
    this.options = {
      correlatedDrawdownThreshold: 3,
      correlatedDrawdownFatalThreshold: 5,
      correlatedDrawdownWindowMs: 300_000,
      massRugThreshold: 2,
      massRugWindowMs: 600_000,
      ...(options ?? {}),
    };
  }

  start(): void {
    // Heartbeat monitor
    this.heartbeatInterval = setInterval(() => this.checkHeartbeat(), 30_000);
    this.heartbeat();
    this.lastOverallStatus = this.getSystemHealth().overallStatus;
    logger.info('AntifragileEngine started', { options: this.options });
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  heartbeat(): void {
    this.lastHeartbeat = new Date();
  }

  // ── CIRCUIT BREAKER API ─────────────────────────────────

  canUseRPC(): boolean { return this.rpcPrimary.canExecute() || this.rpcBackup.canExecute(); }
  canUseJupiter(): boolean { return this.jupiterAPI.canExecute(); }
  canUseHelius(): boolean { return this.heliusWS.canExecute(); }

  recordRPCSuccess(primary: boolean): void {
    (primary ? this.rpcPrimary : this.rpcBackup).recordSuccess();
    this.checkSystemHealth();
  }
  recordRPCFailure(primary: boolean): void {
    (primary ? this.rpcPrimary : this.rpcBackup).recordFailure();
    this.checkSystemHealth();
  }
  recordJupiterSuccess(): void {
    this.jupiterAPI.recordSuccess();
    this.checkSystemHealth();
  }
  recordJupiterFailure(): void {
    this.jupiterAPI.recordFailure();
    this.checkSystemHealth();
  }
  recordHeliusSuccess(): void {
    this.heliusWS.recordSuccess();
    this.checkSystemHealth();
  }
  recordHeliusFailure(): void {
    this.heliusWS.recordFailure();
    this.checkSystemHealth();
  }

  // ── BLACK SWAN DETECTION ────────────────────────────────

  /**
   * Record trade outcome and check for correlated drawdowns
   */
  recordTradeOutcome(tokenCA: string, pnlPct: number): BlackSwanEvent | null {
    this.recentLosses.push({ timestamp: new Date(), pnlPct, tokenCA });

    // Keep last 1 hour of data
    const cutoff = Date.now() - 3_600_000;
    this.recentLosses = this.recentLosses.filter(l => l.timestamp.getTime() > cutoff);

    // Check 1: Correlated drawdown — 3+ positions losing simultaneously
    const recentLossPositions = this.recentLosses
      .filter(
        (l) => l.pnlPct < -10 &&
          l.timestamp.getTime() > Date.now() - this.options.correlatedDrawdownWindowMs
      );

    if (recentLossPositions.length >= this.options.correlatedDrawdownThreshold) {
      const event: BlackSwanEvent = {
        type: 'CORRELATED_DRAWDOWN',
        severity: recentLossPositions.length >= this.options.correlatedDrawdownFatalThreshold ? 'FATAL' : 'CRITICAL',
        description: `${recentLossPositions.length} positions lost >10% in ${Math.round(this.options.correlatedDrawdownWindowMs / 60_000)} minutes`,
        affectedPositions: recentLossPositions.map(l => l.tokenCA),
        recommendedAction: recentLossPositions.length >= this.options.correlatedDrawdownFatalThreshold ? 'HALT' : 'CLOSE_ALL',
        detectedAt: new Date(),
      };

      this.blackSwanEvents.push(event);
      logger.error('BLACK SWAN: CORRELATED DRAWDOWN', event);

      bus.emit('system:halt', {
        reason: `BLACK_SWAN: ${event.description}`,
      });

      return event;
    }

    // Check 2: Flash crash — single position drops >50% in under 60s
    if (pnlPct < -50) {
      const event: BlackSwanEvent = {
        type: 'FLASH_CRASH',
        severity: 'CRITICAL',
        description: `Position ${tokenCA} dropped ${pnlPct.toFixed(0)}%`,
        affectedPositions: [tokenCA],
        recommendedAction: 'REDUCE_SIZE',
        detectedAt: new Date(),
      };

      this.blackSwanEvents.push(event);
      logger.error('BLACK SWAN: FLASH CRASH', event);
      return event;
    }

    // Check 3: Mass rug — multiple positions hit stop loss within 10 min
    const stoppedOut = this.recentLosses
      .filter(
        (l) => l.pnlPct <= -25 &&
          l.timestamp.getTime() > Date.now() - this.options.massRugWindowMs
      );

    if (stoppedOut.length >= this.options.massRugThreshold) {
      const event: BlackSwanEvent = {
        type: 'MASS_RUG',
        severity: 'CRITICAL',
        description: `${stoppedOut.length} positions hit stop loss in ${Math.round(this.options.massRugWindowMs / 60_000)} minutes`,
        affectedPositions: stoppedOut.map(l => l.tokenCA),
        recommendedAction: 'HALT',
        detectedAt: new Date(),
      };

      this.blackSwanEvents.push(event);
      logger.error('BLACK SWAN: MASS RUG', event);

      bus.emit('system:halt', {
        reason: `MASS_RUG: ${stoppedOut.length} concurrent stop-losses triggered`,
      });

      return event;
    }

    return null;
  }

  // ── STRATEGY ROTATION ───────────────────────────────────

  /**
   * Track edge performance and return recommended weight adjustments
   */
  recordEdgeOutcome(edge: string, won: boolean, roi: number): void {
    const stats = this.edgePerformanceWindow.get(edge) ?? { wins: 0, losses: 0, roi: 0 };

    if (won) stats.wins++;
    else stats.losses++;

    const n = stats.wins + stats.losses;
    stats.roi = ((stats.roi * (n - 1)) + roi) / n;

    this.edgePerformanceWindow.set(edge, stats);
  }

  getEdgeWeightRecommendations(): Map<string, number> {
    const weights = new Map<string, number>();
    const allEdges = Array.from(this.edgePerformanceWindow.entries());

    if (allEdges.length === 0) return weights;

    // Score each edge: win_rate × (1 + roi)
    const scores: { edge: string; score: number }[] = allEdges.map(([edge, stats]) => {
      const total = stats.wins + stats.losses;
      const winRate = total > 0 ? stats.wins / total : 0.5;
      return { edge, score: winRate * (1 + Math.max(0, stats.roi)) };
    });

    const totalScore = scores.reduce((s, e) => s + e.score, 0);

    for (const { edge, score } of scores) {
      weights.set(edge, totalScore > 0 ? score / totalScore : 1 / scores.length);
    }

    return weights;
  }

  // ── REGIME-AWARE PARAMETERS ─────────────────────────────

  /**
   * Returns dynamically tuned parameters based on regime
   */
  getRegimeParameters(
    regime: HMMRegime,
    baseParams: RegimeParameters
  ): RegimeParameters {
    switch (regime) {
      case 'RISK_ON':
        return {
          ...baseParams,
          maxConcurrent: baseParams.maxConcurrent + 1,
          maxTradesPerDay: baseParams.maxTradesPerDay + 2,
          copySizePct: baseParams.copySizePct * 1.2,
          stopLossPct: baseParams.stopLossPct * 0.9, // tighter stops in risk-on (protect gains)
          maxHoldMs: Math.round(baseParams.maxHoldMs * 1.5), // let winners run
          minSignalScore: baseParams.minSignalScore * 0.8, // lower bar
          minConfidence: baseParams.minConfidence * 0.9,
        };

      case 'NEUTRAL':
        return baseParams;

      case 'RISK_OFF':
        return {
          ...baseParams,
          maxConcurrent: Math.max(1, baseParams.maxConcurrent - 1),
          maxTradesPerDay: Math.max(1, baseParams.maxTradesPerDay - 1),
          copySizePct: baseParams.copySizePct * 0.5,
          stopLossPct: baseParams.stopLossPct * 0.7, // tighter stops
          maxHoldMs: Math.round(baseParams.maxHoldMs * 0.6), // shorter holds
          minSignalScore: baseParams.minSignalScore * 1.3, // higher bar
          minConfidence: Math.min(0.9, baseParams.minConfidence * 1.3),
        };

      case 'CRISIS':
        return {
          ...baseParams,
          maxConcurrent: 0,
          maxTradesPerDay: 0,
          copySizePct: 0,
          stopLossPct: 0.15, // ultra-tight
          maxHoldMs: 60_000, // 1 minute max
          minSignalScore: 9.5,
          minConfidence: 0.95,
        };
    }
  }

  // ── SYSTEM HEALTH ───────────────────────────────────────

  getSystemHealth(): SystemHealth {
    const breakers = [
      this.rpcPrimary.getState(),
      this.rpcBackup.getState(),
      this.jupiterAPI.getState(),
      this.heliusWS.getState(),
    ];

    const openCount = breakers.filter(b => b.status === 'OPEN').length;

    let overallStatus: SystemHealth['overallStatus'];
    if (openCount === 0) overallStatus = 'HEALTHY';
    else if (openCount === 1) overallStatus = 'DEGRADED';
    else if (openCount <= 2) overallStatus = 'CRITICAL';
    else overallStatus = 'DEAD';

    return {
      rpcPrimary: this.rpcPrimary.getState(),
      rpcBackup: this.rpcBackup.getState(),
      jupiterAPI: this.jupiterAPI.getState(),
      heliusWebsocket: this.heliusWS.getState(),
      overallStatus,
      lastHeartbeat: this.lastHeartbeat,
      uptimeMs: Date.now() - this.startTime.getTime(),
    };
  }

  getBlackSwanHistory(): BlackSwanEvent[] {
    return [...this.blackSwanEvents];
  }

  // ── PRIVATE ─────────────────────────────────────────────

  private checkHeartbeat(): void {
    const gap = Date.now() - this.lastHeartbeat.getTime();
    if (gap > this.MAX_HEARTBEAT_GAP_MS) {
      logger.error('DEAD MAN SWITCH: No heartbeat detected', {
        lastHeartbeat: this.lastHeartbeat.toISOString(),
        gapMs: gap,
      });

      bus.emit('system:halt', {
        reason: `DEAD_MAN_SWITCH: No heartbeat for ${(gap / 1000).toFixed(0)}s`,
      });
    }
  }

  private checkSystemHealth(): void {
    const health = this.getSystemHealth();

    if (health.overallStatus !== this.lastOverallStatus) {
      this.lastOverallStatus = health.overallStatus;
      bus.emit('health:changed', health);
    }

    if (health.overallStatus === 'DEAD') {
      logger.error('SYSTEM DEAD — all circuit breakers open');
      bus.emit('system:halt', { reason: 'ALL_CIRCUITS_OPEN' });
    } else if (health.overallStatus === 'CRITICAL') {
      logger.error('SYSTEM CRITICAL — multiple circuit breakers open');
      bus.emit('data:blind', {
        source: 'AntifragileEngine',
        message: 'Multiple infrastructure failures detected',
      });
    }
  }
}
