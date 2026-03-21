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
} from './types';

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
bus.setMaxListeners(50);
