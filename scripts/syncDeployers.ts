import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { schedule } from 'node-cron';
import { Connection } from '@solana/web3.js';
import { logger } from '../src/core/logger';
import { config } from '../src/core/config';
import type { DeployerTier } from '../src/core/types';

dotenv.config();

// ── Types ──────────────────────────────────────────────────

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string };
  pairCreatedAt: number;
  liquidity: { usd: number };
  txns: { h24: { buys: number; sells: number } };
}

interface DexScreenerResponse {
  pairs: DexScreenerPair[];
}

interface HeliusParsedTx {
  description: string;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    tokenAmount: number;
  }>;
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
  }>;
}

interface LaunchRecord {
  tokenCA: string;
  peakMultiple: number;
  outcome: 'SUCCESS' | 'RUG' | 'NEUTRAL';
  timestamp: string;
}

interface DeployerRecord {
  address: string;
  tier: DeployerTier;
  launches: LaunchRecord[];
  successRate: number;
  rugRate: number;
  avgPeakMultiple: number;
  lastActive: string | null;
}

interface DeployersFile {
  deployers: DeployerRecord[];
  lastSync: string | null;
  version: string;
}

interface TokenHistory {
  tokenCA: string;
  deployer: string;
  createdAt: number;
  initialPriceSOL: number;
  peakPriceSOL: number;
  peakMultiple: number;
  lpRemovedWithin1h: boolean;
  reached2xWithin24h: boolean;
}
// ── Helpers ─────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function heliusFetch(url: string, label: string): Promise<Response | null> {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, { method: 'GET' });

    if (response.ok) return response;

    if (response.status === 429 && attempt < maxRetries) {
      const backoffMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
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
// ── Constants ──────────────────────────────────────────────

const DEPLOYERS_PATH = path.resolve(process.cwd(), 'data', 'deployers.json');
const SYNC_CRON = '0 4 * * *'; // Every day at 4:00 AM
const VALID_DEX_IDS = new Set(['raydium', 'meteora', 'orca']);

// ── DexScreener: Fetch Recent Migrations ───────────────────

async function fetchRecentMigrations(): Promise<DexScreenerPair[]> {
  const cutoff = Date.now() - 86_400_000; // last 24h
  const allPairs: DexScreenerPair[] = [];

  // Primary: search endpoint for recent Solana pairs
  const searchUrl = 'https://api.dexscreener.com/latest/dex/search?q=solana';
  const searchResponse = await fetch(searchUrl, { method: 'GET' });

  if (searchResponse.ok) {
    const data = (await searchResponse.json()) as DexScreenerResponse;
    if (data.pairs) {
      allPairs.push(...data.pairs);
    }
  } else {
    logger.warn('DexScreener search endpoint failed', { status: searchResponse.status });
  }

  // Fallback: token profiles endpoint for new listings
  const profilesUrl = 'https://api.dexscreener.com/token-profiles/latest/v1';
  const profilesResponse = await fetch(profilesUrl, { method: 'GET' });

  if (profilesResponse.ok) {
    const profiles = (await profilesResponse.json()) as Array<{
      chainId: string;
      tokenAddress: string;
    }>;

    // For each Solana token profile, fetch its pair data
    const solanaTokens = profiles
      .filter((p) => p.chainId === 'solana')
      .slice(0, 50); // cap to avoid rate limits

    for (let i = 0; i < solanaTokens.length; i += 5) {
      const batch = solanaTokens.slice(i, i + 5);
      const results = await Promise.all(
        batch.map(async (token) => {
          const pairUrl = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token.tokenAddress)}`;
          const resp = await fetch(pairUrl, { method: 'GET' });
          if (!resp.ok) return [];
          const pairData = (await resp.json()) as DexScreenerResponse;
          return pairData.pairs ?? [];
        })
      );
      allPairs.push(...results.flat());
    }
  } else {
    logger.warn('DexScreener profiles endpoint failed', { status: profilesResponse.status });
  }

  // Filter: last 24h, Solana chain, valid DEXes
  const filtered = allPairs.filter(
    (p) =>
      p.chainId === 'solana' &&
      p.pairCreatedAt >= cutoff &&
      VALID_DEX_IDS.has(p.dexId)
  );

  // Deduplicate by base token address
  const seen = new Set<string>();
  return filtered.filter((p) => {
    if (seen.has(p.baseToken.address)) return false;
    seen.add(p.baseToken.address);
    return true;
  });
}

// ── Helius: Extract Deployer from LP Transaction ───────────

async function extractDeployer(
  tokenCA: string,
  heliusApiKey: string
): Promise<string | null> {
  const url = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(tokenCA)}/transactions?api-key=${encodeURIComponent(heliusApiKey)}&limit=50&type=SWAP`;

  const response = await heliusFetch(url, `extractDeployer:${tokenCA}`);

  if (!response) return null;

  const txns = (await response.json()) as HeliusParsedTx[];

  if (txns.length === 0) return null;

  // The earliest transaction's fee payer is typically the deployer/LP adder
  const earliest = txns[txns.length - 1];
  return earliest.feePayer;
}

// ── Helius: Fetch Deployer Launch History ──────────────────

async function fetchDeployerHistory(
  deployerAddress: string,
  heliusApiKey: string
): Promise<TokenHistory[]> {
  const url = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(deployerAddress)}/transactions?api-key=${encodeURIComponent(heliusApiKey)}&limit=100`;

  const response = await heliusFetch(url, `fetchHistory:${deployerAddress}`);

  if (!response) return [];

  const txns = (await response.json()) as HeliusParsedTx[];

  // Group by token mints the deployer interacted with
  const tokenMap = new Map<string, { firstSeen: number; transfers: HeliusParsedTx[] }>();

  for (const tx of txns) {
    for (const transfer of tx.tokenTransfers) {
      if (transfer.fromUserAccount === deployerAddress && transfer.mint) {
        const existing = tokenMap.get(transfer.mint);
        if (existing) {
          existing.transfers.push(tx);
          existing.firstSeen = Math.min(existing.firstSeen, tx.timestamp);
        } else {
          tokenMap.set(transfer.mint, {
            firstSeen: tx.timestamp,
            transfers: [tx],
          });
        }
      }
    }
  }

  const histories: TokenHistory[] = [];

  for (const [mint, data] of tokenMap.entries()) {
    // Check if LP was removed within 1 hour of creation
    const oneHourAfter = data.firstSeen + 3600;
    const lpRemovedWithin1h = data.transfers.some(
      (tx) =>
        tx.timestamp <= oneHourAfter &&
        tx.timestamp > data.firstSeen &&
        tx.tokenTransfers.some(
          (t) => t.toUserAccount === deployerAddress && t.mint === mint && t.tokenAmount > 0
        )
    );

    // Estimate peak multiple from transaction flow
    const outflows = data.transfers
      .flatMap((tx) => tx.tokenTransfers)
      .filter((t) => t.fromUserAccount === deployerAddress && t.mint === mint);

    const inflows = data.transfers
      .flatMap((tx) => tx.tokenTransfers)
      .filter((t) => t.toUserAccount === deployerAddress && t.mint === mint);

    const totalOut = outflows.reduce((s, t) => s + t.tokenAmount, 0);
    const totalIn = inflows.reduce((s, t) => s + t.tokenAmount, 0);

    const peakMultiple = totalOut > 0 ? totalIn / totalOut : 0;

    // Check 2x within 24h — approximate from SOL native transfers
    const twentyFourHoursAfter = data.firstSeen + 86400;
    const solInflows = data.transfers
      .filter((tx) => tx.timestamp <= twentyFourHoursAfter)
      .flatMap((tx) => tx.nativeTransfers)
      .filter((nt) => nt.toUserAccount === deployerAddress);

    const solOutflows = data.transfers
      .filter((tx) => tx.timestamp <= twentyFourHoursAfter)
      .flatMap((tx) => tx.nativeTransfers)
      .filter((nt) => nt.fromUserAccount === deployerAddress);

    const totalSolIn = solInflows.reduce((s, t) => s + t.amount, 0);
    const totalSolOut = solOutflows.reduce((s, t) => s + t.amount, 0);
    const reached2x = totalSolOut > 0 && totalSolIn / totalSolOut >= 2;

    histories.push({
      tokenCA: mint,
      deployer: deployerAddress,
      createdAt: data.firstSeen,
      initialPriceSOL: 0,
      peakPriceSOL: 0,
      lpRemovedWithin1h,
      reached2xWithin24h: reached2x,
      peakMultiple,
    });
  }

  return histories;
}

// ── Tier Assignment ────────────────────────────────────────

function computeTier(
  successRate: number,
  rugRate: number,
  launches: number
): DeployerTier {
  if (rugRate > 0.7) return 'BLACKLIST';
  if (successRate > 0.6 && rugRate < 0.1 && launches >= 5) return 'S';
  if (successRate > 0.4 && rugRate < 0.25 && launches >= 3) return 'A';
  return 'B';
}

// ── File I/O ───────────────────────────────────────────────

function loadDeployersFile(): DeployersFile {
  if (!fs.existsSync(DEPLOYERS_PATH)) {
    return { deployers: [], lastSync: null, version: '1.0' };
  }

  const raw = fs.readFileSync(DEPLOYERS_PATH, 'utf-8');
  return JSON.parse(raw) as DeployersFile;
}

function saveDeployersFile(data: DeployersFile): void {
  const dir = path.dirname(DEPLOYERS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DEPLOYERS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Core Sync Logic ────────────────────────────────────────

async function syncDeployers(): Promise<void> {
  logger.info('=== Deployer Sync Started ===');

  const appConfig = config.load();
  const heliusApiKey = appConfig.HELIUS_API_KEY;

  // 1) Fetch recent token migrations from DexScreener
  logger.info('Scanning DexScreener for recent Raydium/Meteora migrations');
  const migrations = await fetchRecentMigrations();
  logger.info('Migrations found', { totalTokens: migrations.length });

  if (migrations.length === 0) {
    logger.info('No recent migrations — skipping sync');
    return;
  }

  // 2) Extract deployer from each token's LP transaction (sequential with rate limit protection)
  const deployerTokenMap = new Map<string, string[]>();

  for (const pair of migrations) {
    const deployer = await extractDeployer(pair.baseToken.address, heliusApiKey);
    if (deployer) {
      const existing = deployerTokenMap.get(deployer) ?? [];
      existing.push(pair.baseToken.address);
      deployerTokenMap.set(deployer, existing);
    }
    await sleep(500);
  }

  logger.info('Deployers extracted', { uniqueDeployers: deployerTokenMap.size });

  // 3) Load existing deployers — preserve manual entries
  const file = loadDeployersFile();
  const existingMap = new Map(file.deployers.map((d) => [d.address, d]));
  const manualAddresses = new Set(file.deployers.map((d) => d.address));

  let newAdded = 0;
  let updated = 0;
  let blacklisted = 0;
  const tierCounts: Record<string, number> = { S: 0, A: 0, B: 0, BLACKLIST: 0, UNKNOWN: 0 };

  // 4) For each deployer, fetch full launch history and compute stats (sequential with rate limit protection)
  const deployerAddresses = Array.from(deployerTokenMap.keys());

  for (const address of deployerAddresses) {
    await sleep(500);
    const history = await fetchDeployerHistory(address, heliusApiKey);
    {

      const totalLaunches = history.length;

      if (totalLaunches === 0) continue;

      const successCount = history.filter((h) => h.reached2xWithin24h).length;
      const rugCount = history.filter((h) => h.lpRemovedWithin1h).length;

      const successRate = successCount / totalLaunches;
      const rugRate = rugCount / totalLaunches;
      const avgPeakMultiple =
        history.reduce((sum, h) => sum + h.peakMultiple, 0) / totalLaunches;

      const tier = computeTier(successRate, rugRate, totalLaunches);

      const launches: LaunchRecord[] = history.map((h) => ({
        tokenCA: h.tokenCA,
        peakMultiple: h.peakMultiple,
        outcome: h.lpRemovedWithin1h ? 'RUG' as const : h.reached2xWithin24h ? 'SUCCESS' as const : 'NEUTRAL' as const,
        timestamp: new Date(h.createdAt * 1000).toISOString(),
      }));

      const record: DeployerRecord = {
        address,
        tier,
        launches,
        successRate: Math.round(successRate * 1000) / 1000,
        rugRate: Math.round(rugRate * 1000) / 1000,
        avgPeakMultiple: Math.round(avgPeakMultiple * 100) / 100,
        lastActive: new Date().toISOString(),
      };

      if (existingMap.has(address)) {
        // Merge: keep existing launches, append new ones
        const existing = existingMap.get(address)!;
        const existingTokens = new Set(existing.launches.map((l) => l.tokenCA));
        const newLaunches = launches.filter((l) => !existingTokens.has(l.tokenCA));

        existing.launches.push(...newLaunches);
        existing.successRate = record.successRate;
        existing.rugRate = record.rugRate;
        existing.avgPeakMultiple = record.avgPeakMultiple;
        existing.tier = tier;
        existing.lastActive = record.lastActive;

        existingMap.set(address, existing);
        updated++;
      } else {
        existingMap.set(address, record);
        newAdded++;
      }

      tierCounts[tier]++;
      if (tier === 'BLACKLIST') blacklisted++;
    }
  }

  // 5) Write merged results
  const mergedDeployers = Array.from(existingMap.values());
  const output: DeployersFile = {
    deployers: mergedDeployers,
    lastSync: new Date().toISOString(),
    version: '1.0',
  };

  saveDeployersFile(output);

  // 6) Summary
  logger.info('=== Deployer Sync Complete ===', {
    totalScanned: migrations.length,
    uniqueDeployers: deployerTokenMap.size,
    newDeployersAdded: newAdded,
    deployersUpdated: updated,
    tiersAssigned: tierCounts,
    blacklistedCount: blacklisted,
    finalRegistryCount: mergedDeployers.length,
  });
}

// ── Entry Point ────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('syncDeployers script starting');

  // Run immediately on first launch
  try {
    await syncDeployers();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Initial deployer sync failed', { error: message });
  }

  // Schedule every 24 hours (daily at 4 AM)
  schedule(SYNC_CRON, async () => {
    try {
      await syncDeployers();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Scheduled deployer sync failed', { error: message });
    }
  });

  logger.info('Deployer sync scheduler active', { cron: SYNC_CRON, schedule: 'Every day 4:00 AM' });
}

main();
