/**
 * Real-RPC soak for TokenMetadataResolver.
 *
 * Hits live Helius DAS getAsset for fixture mints, verifies the resolver
 * behaves as modeled by Day 5's structural type and caching design.
 *
 * Run: npm run soak:rpc
 *
 * Fixture: scripts/realRpcSoak.fixtures.json (operator-extendable)
 *   - category1: stable mints with on-chain metadata (must resolve to non-empty string)
 *   - category2: mints with any metadata (must resolve to a string)
 *   - category3: mints with no metadata (must resolve to null)
 *
 * Hard assertions exit non-zero. Categories 2 and 3 skip cleanly if empty.
 * The script does NOT retry on Helius outages — operator re-runs after recovery.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { createTokenMetadataResolver, TokenMetadataResolver } from '../src/safety/tokenMetadataResolver';

dotenv.config();

interface FixtureEntry {
  mint: string;
  label: string;
}

interface Fixtures {
  category1: FixtureEntry[];
  category2: FixtureEntry[];
  category3: FixtureEntry[];
}

const FIXTURE_PATH = path.join(__dirname, 'realRpcSoak.fixtures.json');
const CACHE_HIT_MAX_MS = 5;

let passCount = 0;
let failCount = 0;
let skipCount = 0;

function logPass(msg: string): void {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

function logFail(msg: string): void {
  console.log(`[FAIL] ${msg}`);
  failCount++;
}

function logInfo(msg: string): void {
  console.log(`[INFO] ${msg}`);
}

function logSkip(msg: string): void {
  console.log(`[SKIP] ${msg}`);
  skipCount++;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}

async function runCategory1(resolver: TokenMetadataResolver, entries: FixtureEntry[]): Promise<void> {
  if (entries.length === 0) {
    logSkip('Category 1 (stable mints): no fixture entries');
    return;
  }

  for (const { mint, label } of entries) {
    const first = await timed(() => resolver.resolveName(mint));
    logInfo(`[${label}] first call: name=${JSON.stringify(first.result)}, ${first.durationMs.toFixed(0)}ms`);

    if (typeof first.result !== 'string' || first.result.length === 0) {
      logFail(`[${label}] expected non-empty string, got ${JSON.stringify(first.result)}`);
      continue;
    }
    logPass(`[${label}] first call resolved to non-empty string`);

    const second = await timed(() => resolver.resolveName(mint));
    logInfo(`[${label}] second call: name=${JSON.stringify(second.result)}, ${second.durationMs.toFixed(2)}ms`);

    if (second.result !== first.result) {
      logFail(`[${label}] cache returned different value: first=${JSON.stringify(first.result)}, second=${JSON.stringify(second.result)}`);
      continue;
    }
    logPass(`[${label}] cache returned same value`);

    if (second.durationMs >= CACHE_HIT_MAX_MS) {
      logFail(`[${label}] second call took ${second.durationMs.toFixed(2)}ms, expected < ${CACHE_HIT_MAX_MS}ms (cache miss?)`);
      continue;
    }
    logPass(`[${label}] cache hit under ${CACHE_HIT_MAX_MS}ms threshold`);
  }
}

async function runCategory2(resolver: TokenMetadataResolver, entries: FixtureEntry[]): Promise<void> {
  if (entries.length === 0) {
    logSkip('Category 2 (mints with metadata): no fixture entries');
    return;
  }

  for (const { mint, label } of entries) {
    const { result, durationMs } = await timed(() => resolver.resolveName(mint));
    logInfo(`[${label}] resolved: name=${JSON.stringify(result)}, ${durationMs.toFixed(0)}ms`);

    if (typeof result !== 'string') {
      logFail(`[${label}] expected string, got ${JSON.stringify(result)}`);
      continue;
    }
    logPass(`[${label}] resolved to string`);
  }
}

async function runCategory3(resolver: TokenMetadataResolver, entries: FixtureEntry[]): Promise<void> {
  if (entries.length === 0) {
    logSkip('Category 3 (mints without metadata): no fixture entries');
    return;
  }

  for (const { mint, label } of entries) {
    const { result, durationMs } = await timed(() => resolver.resolveName(mint));
    logInfo(`[${label}] resolved: name=${JSON.stringify(result)}, ${durationMs.toFixed(0)}ms`);

    if (result !== null) {
      logFail(`[${label}] expected null, got ${JSON.stringify(result)}`);
      continue;
    }
    logPass(`[${label}] resolved to null (no metadata, as expected)`);
  }
}

async function main(): Promise<void> {
  logInfo('Loading fixture');
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const fixtures: Fixtures = JSON.parse(raw);

  logInfo('Reading HELIUS_API_KEY from env');
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    console.error('[FAIL] HELIUS_API_KEY not set in .env');
    process.exit(1);
  }

  logInfo('Constructing resolver');
  const resolver = createTokenMetadataResolver(apiKey);

  logInfo('Running Category 1 (stable mints, hard assertions)');
  await runCategory1(resolver, fixtures.category1);

  logInfo('Running Category 2 (mints with metadata, hard string assertion)');
  await runCategory2(resolver, fixtures.category2);

  logInfo('Running Category 3 (mints without metadata, hard null assertion)');
  await runCategory3(resolver, fixtures.category3);

  console.log('');
  console.log(`Summary: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[FAIL] script crashed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
