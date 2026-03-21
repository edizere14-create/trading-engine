import Database from 'better-sqlite3';
import { JournalEntry } from './journalTypes';
import { logger } from '../core/logger';
import path from 'path';

export class TradeJournal {
  private db: Database.Database;

  constructor(dbPath: string = './data/journal.db') {
    const resolved = path.resolve(dbPath);
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    logger.info('TradeJournal opened', { dbPath: resolved });
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        tokenCA TEXT NOT NULL,
        ticker TEXT,
        chain TEXT DEFAULT 'SOLANA',
        poolAddress TEXT,
        entryTimestamp TEXT NOT NULL,
        entryPriceSOL REAL,
        entryPriceUSD REAL,
        entryLiquiditySOL REAL,
        entryVolumeSOL REAL,
        entryHolderCount INTEGER,
        entrySmartWalletCount INTEGER,
        entryBuyPressure REAL,
        entrySlippage1K REAL,
        entryMarketState TEXT,
        entryRegime TEXT,
        entryEMALayer TEXT,
        signalTimingEdge REAL,
        signalDeployerQuality REAL,
        signalOrganicFlow REAL,
        signalManipulationRisk REAL,
        signalCoordinationStrength REAL,
        signalSocialVelocity REAL,
        signalTotalScore REAL,
        signalConfidence REAL,
        predictedWP REAL,
        predictedEV REAL,
        predictedMultiple REAL,
        sizeR REAL,
        sizeUSD REAL,
        stopPriceSOL REAL,
        maxHoldMs INTEGER,
        executionMode TEXT,
        deployerAddress TEXT,
        deployerTier TEXT,
        rugScore REAL,
        sniperBlock0Pct REAL,
        topHolderPct REAL,
        lpLockDuration INTEGER,
        exitTimestamp TEXT,
        exitPriceSOL REAL,
        exitMode TEXT,
        exitReason TEXT,
        holdDurationMs INTEGER,
        realizedMultiple REAL,
        realizedPnLUSD REAL,
        realizedPnLR REAL,
        outcome TEXT,
        peakMultiple REAL,
        buyClusterFrequency REAL,
        walletDiversityScore REAL,
        liquidityGrowthSlope REAL,
        impulseExhaustionScore REAL,
        volumeSpikeSlope REAL,
        edgesFired TEXT,
        primaryEdge TEXT,
        notes TEXT,
        whichEdgeMattered TEXT,
        whichEdgeFailed TEXT,
        detectionLagMs INTEGER,
        createdAt TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_outcome ON trades(outcome);
      CREATE INDEX IF NOT EXISTS idx_market_state ON trades(entryMarketState);
      CREATE INDEX IF NOT EXISTS idx_regime ON trades(entryRegime);
      CREATE INDEX IF NOT EXISTS idx_deployer_tier ON trades(deployerTier);
      CREATE INDEX IF NOT EXISTS idx_signal_score ON trades(signalTotalScore);
      CREATE INDEX IF NOT EXISTS idx_entry_time ON trades(entryTimestamp);
      CREATE INDEX IF NOT EXISTS idx_primary_edge ON trades(primaryEdge);
    `);
  }

  insert(entry: JournalEntry): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trades VALUES (
        @id, @mode, @tokenCA, @ticker, @chain, @poolAddress,
        @entryTimestamp, @entryPriceSOL, @entryPriceUSD,
        @entryLiquiditySOL, @entryVolumeSOL, @entryHolderCount,
        @entrySmartWalletCount, @entryBuyPressure, @entrySlippage1K,
        @entryMarketState, @entryRegime, @entryEMALayer,
        @signalTimingEdge, @signalDeployerQuality, @signalOrganicFlow,
        @signalManipulationRisk, @signalCoordinationStrength,
        @signalSocialVelocity, @signalTotalScore, @signalConfidence,
        @predictedWP, @predictedEV, @predictedMultiple,
        @sizeR, @sizeUSD, @stopPriceSOL, @maxHoldMs, @executionMode,
        @deployerAddress, @deployerTier, @rugScore,
        @sniperBlock0Pct, @topHolderPct, @lpLockDuration,
        @exitTimestamp, @exitPriceSOL, @exitMode, @exitReason,
        @holdDurationMs, @realizedMultiple, @realizedPnLUSD,
        @realizedPnLR, @outcome, @peakMultiple,
        @buyClusterFrequency, @walletDiversityScore,
        @liquidityGrowthSlope, @impulseExhaustionScore,
        @volumeSpikeSlope, @edgesFired, @primaryEdge,
        @notes, @whichEdgeMattered, @whichEdgeFailed,
        @detectionLagMs, datetime('now')
      )
    `);

    stmt.run({
      ...entry,
      entryTimestamp: entry.entryTimestamp.toISOString(),
      exitTimestamp: entry.exitTimestamp?.toISOString() ?? null,
      edgesFired: JSON.stringify(entry.edgesFired),
      // Ensure nulls for undefined optional fields
      exitPriceSOL: entry.exitPriceSOL ?? null,
      exitMode: entry.exitMode ?? null,
      exitReason: entry.exitReason ?? null,
      holdDurationMs: entry.holdDurationMs ?? null,
      realizedMultiple: entry.realizedMultiple ?? null,
      realizedPnLUSD: entry.realizedPnLUSD ?? null,
      realizedPnLR: entry.realizedPnLR ?? null,
      outcome: entry.outcome ?? null,
      peakMultiple: entry.peakMultiple ?? null,
      buyClusterFrequency: entry.buyClusterFrequency ?? null,
      walletDiversityScore: entry.walletDiversityScore ?? null,
      liquidityGrowthSlope: entry.liquidityGrowthSlope ?? null,
      impulseExhaustionScore: entry.impulseExhaustionScore ?? null,
      volumeSpikeSlope: entry.volumeSpikeSlope ?? null,
      notes: entry.notes ?? null,
      whichEdgeMattered: entry.whichEdgeMattered ?? null,
      whichEdgeFailed: entry.whichEdgeFailed ?? null,
      detectionLagMs: entry.detectionLagMs ?? null,
    });

    logger.info('Trade journaled', {
      id: entry.id,
      outcome: entry.outcome,
      multiple: entry.realizedMultiple,
      primaryEdge: entry.primaryEdge,
    });
  }

  update(id: string, updates: Partial<JournalEntry>): void {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updates)) {
      if (k === 'id') continue;
      if (k === 'entryTimestamp' && v instanceof Date) {
        sanitized[k] = v.toISOString();
      } else if (k === 'exitTimestamp' && v instanceof Date) {
        sanitized[k] = v.toISOString();
      } else if (k === 'edgesFired' && Array.isArray(v)) {
        sanitized[k] = JSON.stringify(v);
      } else {
        sanitized[k] = v ?? null;
      }
    }

    const fields = Object.keys(sanitized)
      .map((k) => `${k} = @${k}`)
      .join(', ');

    if (!fields) return;
    const stmt = this.db.prepare(`UPDATE trades SET ${fields} WHERE id = @id`);
    stmt.run({ ...sanitized, id });
  }

  getAll(): JournalEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM trades ORDER BY entryTimestamp DESC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.deserialize(r));
  }

  getById(id: string): JournalEntry | null {
    const row = this.db
      .prepare('SELECT * FROM trades WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.deserialize(row) : null;
  }

  getByOutcome(outcome: 'WIN' | 'LOSS' | 'BREAKEVEN'): JournalEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM trades WHERE outcome = ?')
        .all(outcome) as Record<string, unknown>[]
    ).map((r) => this.deserialize(r));
  }

  count(): number {
    return (
      this.db.prepare('SELECT COUNT(*) as n FROM trades').get() as { n: number }
    ).n;
  }

  close(): void {
    this.db.close();
  }

  private deserialize(row: Record<string, unknown>): JournalEntry {
    return {
      ...(row as unknown as JournalEntry),
      entryTimestamp: new Date(row.entryTimestamp as string),
      exitTimestamp: row.exitTimestamp
        ? new Date(row.exitTimestamp as string)
        : undefined,
      edgesFired: JSON.parse((row.edgesFired as string) ?? '[]'),
    };
  }
}
