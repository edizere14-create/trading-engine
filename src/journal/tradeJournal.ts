// @ts-ignore sql.js has no bundled types
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { JournalEntry } from './journalTypes';
import { logger } from '../core/logger';
import path from 'path';
import fs from 'fs';

const COLUMNS = [
  'id', 'mode', 'tokenCA', 'ticker', 'chain', 'poolAddress',
  'entryTimestamp', 'entryPriceSOL', 'entryPriceUSD',
  'entryLiquiditySOL', 'entryVolumeSOL', 'entryHolderCount',
  'entrySmartWalletCount', 'entryBuyPressure', 'entrySlippage1K',
  'entryMarketState', 'entryRegime', 'entryEMALayer',
  'signalTimingEdge', 'signalDeployerQuality', 'signalOrganicFlow',
  'signalManipulationRisk', 'signalCoordinationStrength',
  'signalSocialVelocity', 'signalTotalScore', 'signalConfidence',
  'predictedWP', 'predictedEV', 'predictedMultiple',
  'sizeR', 'sizeUSD', 'stopPriceSOL', 'maxHoldMs', 'executionMode',
  'deployerAddress', 'deployerTier', 'rugScore',
  'sniperBlock0Pct', 'topHolderPct', 'lpLockDuration',
  'exitTimestamp', 'exitPriceSOL', 'exitMode', 'exitReason',
  'holdDurationMs', 'realizedMultiple', 'realizedPnLUSD',
  'realizedPnLR', 'outcome', 'peakMultiple',
  'buyClusterFrequency', 'walletDiversityScore',
  'liquidityGrowthSlope', 'impulseExhaustionScore',
  'volumeSpikeSlope', 'edgesFired', 'primaryEdge',
  'notes', 'whichEdgeMattered', 'whichEdgeFailed',
  'detectionLagMs', 'createdAt',
];

export class TradeJournal {
  private db!: SqlJsDatabase;
  private dbPath: string;
  private ready: Promise<void>;
  private closed = false;

  constructor(dbPath: string = './data/journal.db') {
    this.dbPath = path.resolve(dbPath);
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const SQL = await initSqlJs();
    try {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
    } catch {
      this.db = new SQL.Database();
    }
    this.initSchema();
    logger.info('TradeJournal opened', { dbPath: this.dbPath });
  }

  private initSchema(): void {
    this.db.run(`
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
      )
    `);

    this.db.run('CREATE INDEX IF NOT EXISTS idx_outcome ON trades(outcome)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_market_state ON trades(entryMarketState)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_regime ON trades(entryRegime)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_deployer_tier ON trades(deployerTier)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_signal_score ON trades(signalTotalScore)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_entry_time ON trades(entryTimestamp)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_primary_edge ON trades(primaryEdge)');
  }

  private save(): void {
    const data = this.db.export();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  private queryAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }
    stmt.free();
    return rows;
  }

  async waitReady(): Promise<void> {
    await this.ready;
  }

  insert(entry: JournalEntry): void {
    const placeholders = COLUMNS.map((_, i) => i === COLUMNS.length - 1 ? "datetime('now')" : '?').join(', ');
    const values = COLUMNS.slice(0, -1).map((col) => {
      if (col === 'entryTimestamp') return entry.entryTimestamp.toISOString();
      if (col === 'exitTimestamp') return entry.exitTimestamp?.toISOString() ?? null;
      if (col === 'edgesFired') return JSON.stringify(entry.edgesFired);
      const val = (entry as unknown as Record<string, unknown>)[col];
      return val ?? null;
    });

    this.db.run(
      `INSERT OR REPLACE INTO trades (${COLUMNS.join(', ')}) VALUES (${placeholders})`,
      values,
    );
    this.save();

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

    const keys = Object.keys(sanitized);
    if (!keys.length) return;
    const setClause = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => sanitized[k]);
    values.push(id);

    this.db.run(`UPDATE trades SET ${setClause} WHERE id = ?`, values);
    this.save();
  }

  getAll(): JournalEntry[] {
    const rows = this.queryAll('SELECT * FROM trades ORDER BY entryTimestamp DESC');
    return rows.map((r) => this.deserialize(r));
  }

  getById(id: string): JournalEntry | null {
    const rows = this.queryAll('SELECT * FROM trades WHERE id = ?', [id]);
    return rows.length ? this.deserialize(rows[0]) : null;
  }

  getByOutcome(outcome: 'WIN' | 'LOSS' | 'BREAKEVEN'): JournalEntry[] {
    return this.queryAll('SELECT * FROM trades WHERE outcome = ?', [outcome])
      .map((r) => this.deserialize(r));
  }

  count(): number {
    const rows = this.queryAll('SELECT COUNT(*) as n FROM trades');
    return (rows[0]?.n as number) ?? 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.save();
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
