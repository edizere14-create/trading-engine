export interface JournalEntry {
  // ── IDENTITY ────────────────────────────────────────────
  id: string;
  mode: 'PAPER' | 'LIVE';
  tokenCA: string;
  ticker: string;
  chain: 'SOLANA';
  poolAddress: string;

  // ── ENTRY CONTEXT ────────────────────────────────────────
  entryTimestamp: Date;
  entryPriceSOL: number;
  entryPriceUSD: number;
  entryLiquiditySOL: number;
  entryVolumeSOL: number;
  entryHolderCount: number;
  entrySmartWalletCount: number;
  entryBuyPressure: number;
  entrySlippage1K: number;
  entryMarketState: string;
  entryRegime: string;
  entryEMALayer: string;

  // ── SIGNAL SNAPSHOT ──────────────────────────────────────
  signalTimingEdge: number;
  signalDeployerQuality: number;
  signalOrganicFlow: number;
  signalManipulationRisk: number;
  signalCoordinationStrength: number;
  signalSocialVelocity: number;
  signalTotalScore: number;
  signalConfidence: number;

  // ── RISK + SIZING ────────────────────────────────────────
  predictedWP: number;
  predictedEV: number;
  predictedMultiple: number;
  sizeR: number;
  sizeUSD: number;
  stopPriceSOL: number;
  maxHoldMs: number;
  executionMode: string;

  // ── DEPLOYER + SECURITY ──────────────────────────────────
  deployerAddress: string;
  deployerTier: string;
  rugScore: number;
  sniperBlock0Pct: number;
  topHolderPct: number;
  lpLockDuration: number;

  // ── EXIT CONTEXT ─────────────────────────────────────────
  exitTimestamp?: Date;
  exitPriceSOL?: number;
  exitMode?: string;
  exitReason?: string;
  holdDurationMs?: number;

  // ── OUTCOME ──────────────────────────────────────────────
  realizedMultiple?: number;
  realizedPnLUSD?: number;
  realizedPnLR?: number;
  outcome?: 'WIN' | 'LOSS' | 'BREAKEVEN';
  peakMultiple?: number;

  // ── MICROSTRUCTURE FEATURES ──────────────────────────────
  buyClusterFrequency?: number;
  walletDiversityScore?: number;
  liquidityGrowthSlope?: number;
  impulseExhaustionScore?: number;
  volumeSpikeSlope?: number;

  // ── EDGES FIRED ──────────────────────────────────────────
  edgesFired: string[];
  primaryEdge: string;

  // ── LESSONS ──────────────────────────────────────────────
  notes?: string;
  whichEdgeMattered?: string;
  whichEdgeFailed?: string;
  detectionLagMs?: number;
}