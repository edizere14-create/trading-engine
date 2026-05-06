// ── ENUMS ──────────────────────────────────────────────────

export type MarketState   = 'HOT' | 'NORMAL' | 'DEAD';
export type Regime        = 'AGGRESSIVE' | 'NORMAL' | 'DEFENSIVE' | 'EXTREME';
export type EMALayer      = 'ALPHA' | 'BETA' | 'SIGMA';
export type RugRisk       = 'LOW' | 'MEDIUM' | 'HIGH';
export type TradeDecision = 'FULL_SIZE' | 'HALF_SIZE' | 'SKIP';
export type DataStatus    = 'LIVE' | 'STALE' | 'BLIND';
export type DeployerTier  = 'S' | 'A' | 'B' | 'BLACKLIST' | 'UNKNOWN';
export type EdgeName      =
  | 'TIMING'
  | 'DEPLOYER'
  | 'ORGANIC_FLOW'
  | 'MANIPULATION'
  | 'COORDINATION'
  | 'KOL'
  | 'TELEGRAM'
  | 'AUTONOMOUS';

export type ExecutionMode = 'SAFE' | 'FAST' | 'WAR';
export type ExitMode      = 'HARVEST' | 'PANIC' | 'DRIP' | 'TIME_EXIT' | 'STALE_EXIT' | 'STOP_LOSS' | 'RAPID_DUMP_EXIT' | 'EARLY_STOP' | 'TRAILING_STOP' | 'ALL_TIERS_HIT' | 'EMERGENCY' | 'RUG_TRIGGER' | 'UNKNOWN';
export type SystemMode    = 'PAPER' | 'LIVE';
export type SurvivalState = 'NORMAL' | 'CAUTION' | 'DEFENSIVE' | 'HALT';

// ── SIGNAL VECTOR ──────────────────────────────────────────
// Every signal source maps to exactly one of these dimensions.
// Orthogonal design: upgrading one dimension doesn't affect others.

export interface SignalVector {
  timingEdge: number;           // 0–10: how early vs public (pre-LP advantage)
  deployerQuality: number;      // 0–10: deployer tier + historical success
  organicFlow: number;          // 0–10: real holders vs bots
  manipulationRisk: number;     // 0–10: snipers, wash trades, bundle sells (INVERTED: 10=safe)
  coordinationStrength: number; // 0–10: smart wallet clustering + Jito buy bundles
  socialVelocity: number;       // 0–10: KOL + Telegram cross-confirmation
  totalScore: number;           // weighted sum — computed by signalAggregator
  confidence: number;           // 0–1: data freshness × source count
}

// ── V2 SNIPER TYPES ────────────────────────────────────────

export type HoneypotClassification = 'CLEAN' | 'INDEX_LAG' | 'NOT_ROUTABLE' | 'UNCONFIRMED';

export interface SafetyCheckTrace {
  liquidity:            { passed: boolean; valueSOL: number };
  mintAuthority:        { passed: boolean; revoked: boolean };
  freezeAuthority:      { passed: boolean; revoked: boolean };
  lpLock:               { passed: boolean; locked: boolean; lockDurationDays?: number };
  holderConcentration:  { passed: boolean; topPct: number };
  scammyName:           { passed: boolean };
  deployerBlacklist:    { passed: boolean };
  honeypot:             { passed: boolean; classification: HoneypotClassification; sellQuoteSlippagePct?: number };
}

// ── NEW POOL EVENT (from ingestion layer) ──────────────────

export interface NewPoolEvent {
  poolAddress: string;
  tokenCA: string;
  baseToken: 'SOL' | 'USDC';
  initialLiquiditySOL: number;
  deployer: string;
  signature: string;
  slot: number;
  detectedAt: Date;
  dexScreenerLagMs?: number;    // measured post-hoc
  source: 'HELIUS_WS' | 'RPC_LOGS' | 'DEXSCREENER';
}

// ── SWAP EVENT ─────────────────────────────────────────────

export interface SwapEvent {
  tokenCA: string;
  wallet: string;
  action: 'BUY' | 'SELL';
  amountSOL: number;
  amountTokens: bigint;         // lamports
  priceSOL: number;
  slot: number;
  timestamp: Date;
  isSmartWallet: boolean;
  bundleId?: string;
}

// ── WALLET CLUSTER ALERT ───────────────────────────────────

export interface ClusterAlert {
  tokenCA: string;
  wallets: string[];
  totalWeightedPnL: number;
  windowSeconds: number;
  triggeredAt: Date;
}

// ── LIQUIDITY SNAPSHOT ─────────────────────────────────────

export interface LiquiditySnapshot {
  tokenCA: string;
  poolAddress: string;
  reserveSOL: number;
  reserveTokens: bigint;
  priceSOL: number;
  slippage1KSOL: number;        // price impact of $1K buy
  slippage5KSOL: number;        // price impact of $5K buy
  exitLiquidityRisk: number;    // 0–10 (10 = highly illiquid exit)
  timestamp: Date;
}

// ── MARKET STATE SNAPSHOT ─────────────────────────────────

export interface MarketStateSnapshot {
  state: MarketState;
  regime: Regime;
  emaLayer: EMALayer;
  newTokensPerHour: number;
  avgPeakMultiple24h: number;
  dexVolumeChange24h: number;
  solMomentum4h: number;
  atr14: number;
  atrBaseline: number;
  score: number;
  timestamp: Date;
}

// ── RISK DECISION ─────────────────────────────────────────

export interface RiskDecision {
  tradeAllowed: boolean;
  sizeR: number;
  sizeUSD: number;
  maxHoldMs: number;            // edge decay window in milliseconds
  executionMode: ExecutionMode;
  stopPriceLamports: bigint;
  reason: string;
}

// ── TRADE RECORD ──────────────────────────────────────────

export interface TradeRecord {
  id: string;
  mode: SystemMode;
  tokenCA: string;
  ticker: string;
  poolAddress: string;
  entryPriceLamports: bigint;
  entryTimestamp: Date;
  sizeR: number;
  sizeUSD: number;
  stopPriceLamports: bigint;
  maxHoldMs: number;
  signal: SignalVector;
  rugRisk: RugRisk;
  deployerTier: DeployerTier;
  executionMode: ExecutionMode;
  edgesFired: EdgeName[];
  marketState: MarketState;
  regime: Regime;

  // filled on close
  exitPriceLamports?: bigint;
  exitTimestamp?: Date;
  exitMode?: ExitMode;
  realizedMultiple?: number;
  realizedPnLUSD?: number;
  outcome?: 'WIN' | 'LOSS' | 'BREAKEVEN';

  // calibration fields
  predictedWP: number;
  predictedEV: number;
  actualWP?: number;            // 1 if won, 0 if lost

  // v2 sniper fields
  schemaVersion?: 2;
  strategy?: 'SNIPER' | 'AUTONOMOUS';
  priceBasisInvalid?: boolean;
  entryPriceBasis?: 'OPEN_PRICE' | 'FIRST_TICK';
  safetyChecks?: SafetyCheckTrace;
}

// ── EXIT TIER ─────────────────────────────────────────────

export interface ExitTier {
  pct: number;                  // % of position to exit
  multiple: number;             // e.g. 2.0 = 2x
  priceLamports: bigint;
  reached: boolean;
  reachedAt?: Date;
}

// ── OPEN POSITION ─────────────────────────────────────────

export interface OpenPosition {
  trade: TradeRecord;
  tiers: ExitTier[];
  remainingPct: number;         // % of original position still held
  unrealizedPnL: number;
  edgeExpiresAt: Date;          // entry + maxHoldMs
  narrativeCluster: string;     // e.g. 'dog_meta', 'ai_meta'
  exitMode: ExitMode;
}

// ── PERFORMANCE METRICS PER EDGE ──────────────────────────

export interface EdgePerformance {
  edge: EdgeName;
  totalFired: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinMultiple: number;
  avgLossMultiple: number;
  rollingROI: number;           // last 20 trades
  isEnabled: boolean;
  disabledReason?: string;
  lastUpdated: Date;
}

// ── PAPER GATE STATUS ─────────────────────────────────────

export interface PaperGateStatus {
  completedTrades: number;
  requiredTrades: number;
  wpCalibrationAccuracy: number; // |predicted - actual| mean
  actualEV: number;
  actualWinRate: number;
  predictedWinRate: number;
  gateUnlocked: boolean;
  blockedReasons: string[];
}

// ── SURVIVAL STATE ────────────────────────────────────────

export interface SurvivalSnapshot {
  state: SurvivalState;
  dailyPnLPct: number;
  weeklyPnLPct: number;
  consecutiveLosses: number;
  sizeMultiplier: number;       // 1.0 = normal, 0.25 = survival mode
  highVarianceEnabled: boolean;
  message: string;
}

// ── TRADE SIGNAL TYPES ───────────────────────────────────────

export type TradeSource = 'AUTONOMOUS' | 'SINGLE_WALLET' | 'CLUSTER';
export type WalletTier = 'S' | 'A' | 'B';

export interface TradeSignal {
  tokenCA: string;
  source: TradeSource;
  triggerWallet: string;
  walletTier: WalletTier;
  walletPnL30d: number;
  convictionSOL: number;        // how much SOL the wallet put in
  clusterWallets: string[];     // other wallets that also bought (if cluster)
  clusterSize: number;
  totalClusterSOL: number;      // total SOL across all cluster wallets
  entryPriceSOL: number;
  timestamp: Date;
  slot: number;
  score: number;                // computed signal quality 0–10
  confidence: number;           // 0–1
  overrideSizeUSD?: number;     // optional model/risk-driven size override
  overrideMaxHoldMs?: number;   // optional risk-engine hold override
}

export interface TradePosition {
  id: string;
  tokenCA: string;
  mode: SystemMode;
  entryPriceSOL: number;
  entryTimestamp: Date;
  sizeSOL: number;
  sizeUSD: number;
  sourceWallets: string[];      // wallets that triggered this entry
  reBuyCount: number;           // how many re-buys from tracked wallets
  maxHoldMs: number;
  stopLossPct: number;          // e.g. 0.30 = -30%
  takeProfitTiers: TakeProfitTier[];
  peakPriceSOL: number;
  lastPriceSOL: number;            // most recent price we saw (for stale/time exits)
  lastCheckedAt: Date;
  status: 'OPEN' | 'CLOSED';
  exitReason?: string;
  realizedPnLSOL?: number;
  realizedMultiple?: number;
  outcome?: 'WIN' | 'LOSS' | 'BREAKEVEN';

  // v2 sniper fields
  priceBasisInvalid?: boolean;
  entryPriceBasis?: 'OPEN_PRICE' | 'FIRST_TICK';
}

export interface TakeProfitTier {
  multiple: number;
  pct: number;                  // fraction of position to exit
  triggered: boolean;
  triggeredAt?: Date;
}

export interface TokenSafetyResult {
  tokenCA: string;
  isSafe: boolean;
  reasons: string[];
  rugScore: number;             // 0–10 (10 = definitely rug)
  topHolderPct: number;
  lpLocked: boolean;
  mintAuthRevoked: boolean;
  freezeAuthRevoked: boolean;
  isHoneypot: boolean;
  checkedAt: Date;
}



// ══════════════════════════════════════════════════════════════
//  ADVANCED ENGINE TYPES
//  Note: canonical types are defined in each module. Below are
//  the shared interfaces used across modules via the event bus.
// ══════════════════════════════════════════════════════════════

// ── REGIME TYPES ──────────────────────────────────────────

export type HMMRegimeState = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF' | 'CRISIS';

// ── PORTFOLIO TYPES ───────────────────────────────────────

export type NarrativeType =
  | 'DOG_META' | 'CAT_META' | 'AI_META' | 'POLITICS'
  | 'DEFI' | 'GAMING' | 'CULTURE' | 'UNKNOWN';

// ── EXECUTION TYPES ───────────────────────────────────────

export type ExecutionStrategy = 'IMMEDIATE' | 'TWAP' | 'ICEBERG' | 'VWAP';
export type TransactionStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'TIMEOUT';

// ── ANTIFRAGILE TYPES ─────────────────────────────────────

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type SystemHealthState = 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'DEAD';

// ── SOCIAL SIGNAL TYPES ───────────────────────────────────

export type HypeCyclePhase =
  | 'DISCOVERY' | 'EARLY_MOMENTUM' | 'PEAK_HYPE'
  | 'PLATEAU' | 'DECLINE';

// ── SIMULATION TYPES ──────────────────────────────────────

export interface SimulationResult {
  poolAddress: string;
  tokenCA: string;
  exitLiquiditySOL: number;
  liquidityScore: number;
  sandwichRisk: number;
  holderDistribution: 'HEALTHY' | 'CONCENTRATED' | 'WHALE_DOMINATED';
  lpConcentrationRisk: number;
  recommendation: 'GO' | 'REDUCE_SIZE' | 'USE_JITO' | 'ABORT';
}
