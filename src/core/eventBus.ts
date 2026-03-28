import { EventEmitter } from 'events';
import {
  NewPoolEvent,
  SwapEvent,
  ClusterAlert,
  LiquiditySnapshot,
  MarketStateSnapshot,
  SignalVector,
  ExitMode,
  OpenPosition,
  TradeRecord,
  EdgePerformance,
  SurvivalSnapshot,
  TradeSignal,
  TradePosition,
  TokenSafetyResult,
  SimulationResult,
} from './types';
import type { MLPrediction } from '../ml/onlineLearner';
import type { RegimeSnapshot } from '../ml/regimeHMM';
import type { PortfolioState, SizingRecommendation } from '../portfolio/portfolioOptimizer';
import type { SystemHealth, BlackSwanEvent } from '../antifragile/antifragileEngine';
import type { DeployerProfile } from '../intelligence/deployerIntelligence';

// Typed event map — no string event names anywhere in the codebase
export interface EngineEvents {
  'pool:created':          NewPoolEvent;
  'swap:detected':         SwapEvent;
  'cluster:alert':         ClusterAlert;
  'liquidity:updated':     LiquiditySnapshot;
  'market:stateChanged':   MarketStateSnapshot;
  'signal:ready':          { tokenCA: string; signal: SignalVector };
  'trade:opened':          TradeRecord;
  'trade:closed':          TradeRecord;
  'position:updated':      OpenPosition;
  'exit:triggered':        { tokenCA: string; mode: ExitMode; reason: string };
  'edge:disabled':         EdgePerformance;
  'survival:stateChanged': SurvivalSnapshot;
  'system:halt':           { reason: string; resumeAt?: Date };
  'data:blind':            { source: string; message: string };
  // Trade signal events
  'copy:signal':           TradeSignal;
  'copy:opened':           TradePosition;
  'copy:closed':           TradePosition;
  'safety:checked':        TokenSafetyResult;
  'safety:blocked':        { tokenCA: string; reasons: string[] };
  // ── ADVANCED ENGINE EVENTS ──────────────────────────────
  'ml:prediction':         { tokenCA: string; prediction: MLPrediction };
  'ml:driftDetected':      { feature: string; oldMean: number; newMean: number };
  'regime:changed':        RegimeSnapshot;
  'portfolio:updated':     PortfolioState;
  'portfolio:sizing':      { tokenCA: string; recommendation: SizingRecommendation };
  'deployer:analyzed':     DeployerProfile;
  'deployer:blacklisted':  { address: string; reason: string };
  'blackswan:detected':    BlackSwanEvent;
  'health:changed':        SystemHealth;
  'circuit:opened':        { name: string; failures: number };
  'circuit:closed':        { name: string };
  'social:signal':         { tokenCA: string; source: string; sentiment: number; kolMentions: number; hypeCycle: string; socialScore: number };
  'social:kolAlert':       { tokenCA: string; kolHandle: string; followers: number; sentiment: number };
  'simulation:complete':   SimulationResult;
}

type EventKey = keyof EngineEvents;

class TypedEventBus extends EventEmitter {
  emit<K extends EventKey>(event: K, payload: EngineEvents[K]): boolean {
    return super.emit(event, payload);
  }
  on<K extends EventKey>(event: K, listener: (payload: EngineEvents[K]) => void): this {
    return super.on(event, listener);
  }
  once<K extends EventKey>(event: K, listener: (payload: EngineEvents[K]) => void): this {
    return super.once(event, listener);
  }
  off<K extends EventKey>(event: K, listener: (payload: EngineEvents[K]) => void): this {
    return super.off(event, listener);
  }
}

// Singleton — import this everywhere
export const bus = new TypedEventBus();
bus.setMaxListeners(100);
