import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { schedule } from 'node-cron';
import { logger } from '../src/core/logger';
import { WalletRegistry, WalletEntry } from '../src/registry/walletRegistry';
import { config } from '../src/core/config';

dotenv.config();

// ── Types ──────────────────────────────────────────────────

interface DuneResultRow {
  wallet_address: string;
  pnl_usd: number;
  trade_count: number;
  max_drawdown_pct: number;
  win_rate: number;
  avg_peak_multiple: number;
  last_trade_time: string;
}

interface DuneApiResponse {
  execution_id: string;
  query_id: number;
  state: string;
  result: {
    rows: DuneResultRow[];
    metadata: {
      column_names: string[];
      result_set_bytes: number;
      total_row_count: number;
    };
  };
}

interface HeliusTransaction {
  signature: string;
  timestamp: number;
  type: string;
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  volume: { h24: number };
  txns: { h24: { buys: number; sells: number } };
  pairCreatedAt: number;
  info?: { socials?: unknown[] };
}

interface DexScreenerSearchResponse {
  pairs: DexScreenerPair[];
}

interface HeliusParsedTxn {
  signature: string;
  timestamp: number;
  type: string;
  feePayer: string;
}

// ── Constants ──────────────────────────────────────────────

const DUNE_QUERY_ID = process.env.DUNE_QUERY_ID ?? '3847291';
const WALLETS_PATH = path.resolve(process.cwd(), 'data', 'wallets.json');
const MIN_TRADES = 50;
const MAX_DRAWDOWN_PCT = 60;
const ACTIVE_WINDOW_DAYS = 7;
const SYNC_CRON = '0 3 * * 4'; // Every Thursday at 3:00 AM
const MIN_DEX_TXN_COUNT = 10;

// ── Rate Limit Helpers ─────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function heliusFetch(url: string, label: string): Promise<Response | null> {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, { method: 'GET' });

    if (response.ok) return response;

    if (response.status === 429 && attempt < maxRetries) {
      const backoffMs = 2000 * Math.pow(2, attempt);
      logger.warn('Helius 429 rate limited — retrying', { label, attempt: attempt + 1, backoffMs });
      await sleep(backoffMs);
      continue;
    }

    if (response.status === 429) {
      logger.warn('Helius 429 rate limited — max retries exhausted, skipping', { label });
      return null;
    }

    logger.warn('Helius API error', { label, status: response.status });
    return null;
  }
  return null;
}

// ── Dune Analytics Fetcher ─────────────────────────────────

async function fetchDuneResults(apiKey: string): Promise<DuneResultRow[]> {
  const url = `https://api.dune.com/api/v1/query/${encodeURIComponent(DUNE_QUERY_ID)}/results`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Dune-API-Key': apiKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Dune API returned ${response.status}: ${body}`);
  }

  const data = (await response.json()) as DuneApiResponse;

  if (data.state !== 'QUERY_STATE_COMPLETED') {
    throw new Error(`Dune query not complete — state: ${data.state}`);
  }

  return data.result.rows;
}

// ── Percentile Filter ──────────────────────────────────────

function filterTopPercentile(rows: DuneResultRow[]): DuneResultRow[] {
  if (rows.length === 0) return [];

  const sorted = [...rows].sort((a, b) => b.pnl_usd - a.pnl_usd);
  const cutoffIndex = Math.max(1, Math.ceil(sorted.length * 0.01));
  const pnlThreshold = sorted[cutoffIndex - 1].pnl_usd;

  return rows.filter(
    (row) =>
      row.pnl_usd >= pnlThreshold &&
      row.trade_count >= MIN_TRADES &&
      row.max_drawdown_pct < MAX_DRAWDOWN_PCT
  );
}

// ── DexScreener Fallback Fetcher ───────────────────────────

async function fetchDexScreenerWallets(heliusApiKey: string): Promise<string[]> {
  logger.info('DexScreener fallback: fetching recent Solana pairs');

  const response = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana', {
    method: 'GET',
  });

  if (!response.ok) {
    throw new Error(`DexScreener API returned ${response.status}`);
  }

  const data = (await response.json()) as DexScreenerSearchResponse;
  const solanaPairs = (data.pairs ?? []).filter(
    (p) => p.chainId === 'solana' && (p.volume?.h24 ?? 0) > 10000
  );

  logger.info('DexScreener high-volume pairs found', { count: solanaPairs.length });

  // Extract unique traders from recent pair transactions via Helius
  const walletSet = new Set<string>();
  const tokenAddresses = solanaPairs.slice(0, 20).map((p) => p.baseToken.address);

  for (const tokenCA of tokenAddresses) {
    await sleep(500);
    const url = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(tokenCA)}/transactions?api-key=${encodeURIComponent(heliusApiKey)}&limit=50`;
    const resp = await heliusFetch(url, `dex-traders:${tokenCA}`);
    if (!resp) continue;

    const txns = (await resp.json()) as HeliusParsedTxn[];
    for (const txn of txns) {
      if (txn.feePayer && txn.feePayer.length >= 32) {
        walletSet.add(txn.feePayer);
      }
    }
  }

  logger.info('DexScreener unique trader wallets extracted', { count: walletSet.size });
  return [...walletSet];
}

// ── Helius Activity Checker ────────────────────────────────

async function isWalletActiveRecently(
  address: string,
  heliusApiKey: string
): Promise<boolean> {
  const url = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(address)}/transactions?api-key=${encodeURIComponent(heliusApiKey)}&limit=10`;

  await sleep(500);
  const response = await heliusFetch(url, `activity:${address}`);

  if (!response) return false;

  const txns = (await response.json()) as HeliusTransaction[];

  if (txns.length === 0) return false;

  const lastTxTime = txns[0].timestamp * 1000;
  const cutoff = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  return lastTxTime >= cutoff;
}

async function verifyWalletTxnCount(
  address: string,
  heliusApiKey: string
): Promise<boolean> {
  const url = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(address)}/transactions?api-key=${encodeURIComponent(heliusApiKey)}&limit=${MIN_DEX_TXN_COUNT}`;

  await sleep(500);
  const response = await heliusFetch(url, `txn-count:${address}`);

  if (!response) return false;

  const txns = (await response.json()) as HeliusTransaction[];

  if (txns.length < MIN_DEX_TXN_COUNT) return false;

  // Check all 10 txns are within the last 7 days
  const cutoff = Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentCount = txns.filter((t) => t.timestamp * 1000 >= cutoff).length;
  return recentCount >= MIN_DEX_TXN_COUNT;
}

// ── Tier Assignment ────────────────────────────────────────

function assignTier(row: DuneResultRow): 'S' | 'A' | 'B' {
  if (row.pnl_usd > 500_000 && row.win_rate > 0.65 && row.avg_peak_multiple > 10) {
    return 'S';
  }
  if (row.pnl_usd > 100_000 && row.win_rate > 0.50 && row.avg_peak_multiple > 5) {
    return 'A';
  }
  return 'B';
}

// ── Core Sync Logic ────────────────────────────────────────

async function syncWalletsDune(
  duneApiKey: string,
  heliusApiKey: string,
  registry: WalletRegistry
): Promise<{ scanned: number; qualified: number; active: number; added: number; updated: number }> {
  // 1) Fetch from Dune
  logger.info('Fetching Dune Analytics results', { queryId: DUNE_QUERY_ID });
  const allRows = await fetchDuneResults(duneApiKey);
  logger.info('Dune results received', { totalScanned: allRows.length });

  // 2) Filter top 1% PnL, min 50 trades, max 60% drawdown
  const qualified = filterTopPercentile(allRows);
  logger.info('Qualified wallets after filtering', {
    qualified: qualified.length,
    criteria: `top 1% PnL, >=${MIN_TRADES} trades, <${MAX_DRAWDOWN_PCT}% drawdown`,
  });

  // 3) Confirm recent activity via Helius — sequential with rate limiting
  const activeWallets: DuneResultRow[] = [];

  for (const row of qualified) {
    const active = await isWalletActiveRecently(row.wallet_address, heliusApiKey);
    if (active) {
      activeWallets.push(row);
    } else {
      logger.debug('Wallet inactive — skipping', { address: row.wallet_address });
    }
  }

  logger.info('Active wallet verification complete', {
    activeCount: activeWallets.length,
    inactiveFiltered: qualified.length - activeWallets.length,
  });

  // 4) Merge into registry
  const existingAddresses = new Set(registry.getAll().map((w) => w.address));
  let newAdded = 0;
  let updated = 0;

  for (const row of activeWallets) {
    const entry: WalletEntry = {
      address: row.wallet_address,
      pnl30d: row.pnl_usd,
      tier: assignTier(row),
      tradeCount: row.trade_count,
      lastActive: new Date(),
    };

    if (existingAddresses.has(row.wallet_address)) {
      registry.removeWallet(row.wallet_address);
      registry.addWallet(entry);
      updated++;
    } else {
      registry.addWallet(entry);
      newAdded++;
    }
  }

  return { scanned: allRows.length, qualified: qualified.length, active: activeWallets.length, added: newAdded, updated };
}

async function syncWalletsDexScreener(
  heliusApiKey: string,
  registry: WalletRegistry
): Promise<{ scanned: number; qualified: number; added: number }> {
  // 1) Get wallet addresses from DexScreener + Helius
  const candidates = await fetchDexScreenerWallets(heliusApiKey);
  logger.info('DexScreener candidate wallets', { count: candidates.length });

  const existingAddresses = new Set(registry.getAll().map((w) => w.address));
  let newAdded = 0;
  let qualified = 0;

  // 2) Verify each wallet has 10+ txns in last 7 days — sequential
  for (const address of candidates) {
    if (existingAddresses.has(address)) continue;

    const hasEnoughTxns = await verifyWalletTxnCount(address, heliusApiKey);
    if (!hasEnoughTxns) continue;

    qualified++;

    const entry: WalletEntry = {
      address,
      pnl30d: 0,
      tier: 'B',
      tradeCount: MIN_DEX_TXN_COUNT,
      lastActive: new Date(),
    };

    registry.addWallet(entry);
    newAdded++;
  }

  return { scanned: candidates.length, qualified, added: newAdded };
}

async function syncWallets(): Promise<void> {
  logger.info('=== Wallet Sync Started ===');

  const appConfig = config.load();
  const duneApiKey = appConfig.DUNE_API_KEY;
  const heliusApiKey = appConfig.HELIUS_API_KEY;

  const registry = await WalletRegistry.load(WALLETS_PATH);
  let source = 'NONE';

  // Try Dune first, fall back to DexScreener
  if (duneApiKey) {
    try {
      const result = await syncWalletsDune(duneApiKey, heliusApiKey, registry);
      source = 'DUNE';
      logger.info('Dune sync results', result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const is401 = message.includes('401');
      logger.warn('Dune API failed — falling back to DexScreener', {
        error: message,
        reason: is401 ? 'invalid API key' : 'API error',
      });

      const result = await syncWalletsDexScreener(heliusApiKey, registry);
      source = 'DEXSCREENER';
      logger.info('DexScreener fallback results', result);
    }
  } else {
    logger.warn('DUNE_API_KEY not set — using DexScreener fallback');
    const result = await syncWalletsDexScreener(heliusApiKey, registry);
    source = 'DEXSCREENER';
    logger.info('DexScreener fallback results', result);
  }

  // Save
  await registry.save(WALLETS_PATH);

  // Summary
  logger.info('=== Wallet Sync Complete ===', {
    source,
    finalRegistryCount: registry.count(),
  });
}

// ── Entry Point ────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('syncWallets script starting');

  // Run immediately on first launch
  try {
    await syncWallets();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Initial wallet sync failed', { error: message });
  }

  // Schedule every 7 days (Thursday 3 AM)
  schedule(SYNC_CRON, async () => {
    try {
      await syncWallets();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Scheduled wallet sync failed', { error: message });
    }
  });

  logger.info('Wallet sync scheduler active', { cron: SYNC_CRON, schedule: 'Every Thursday 3:00 AM' });
}

main();
