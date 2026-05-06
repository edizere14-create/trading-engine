# STRATEGY_V2.md — Solana Sniper Bot, Second Pass

## Context and motivation

Round 1 of this project pivoted from a smart-money copy-trade strategy to a sniper architecture targeting Pump.fun graduations to PumpSwap. Round 1's code is lost (working tree only, no remote backup). What's preserved is the design knowledge from that work.

V2 is a deliberate restart from `main` (commit `45f511b`), not a port of round 1. The goal is to apply round 1's architectural lessons directly without rebuilding the dead-end paths.

## Goals

1. Build a paper-trading sniper that opens and closes positions on freshly-graduated PumpSwap tokens with correctly-priced entries, correctly-labelled persistence, and bounded latency.
2. Generate enough valid trade data (50–100 closed sniper trades minimum) to evaluate whether the strategy has positive expectancy.
3. Build measurement infrastructure that fails loud, not silent — broken data should be impossible to write, not detected after 89 records.

## Non-goals

- Smart-money copy-trading. Was disabled in round 1, not coming back.
- Autonomous LP entry path. Was structurally separate, not reused.
- Online learner / factor extractor. Was training on broken data; deferred until strategy validation.
- Antifragile engine, hybrid power play, portfolio optimizer. Round 1 vestigial complexity.
- Live trading. Paper mode only until strategy is validated.
- CPMM detection. Until a real CPMM pool creation transaction is observed and the instruction string verified from chain RPC, this stays out of scope.
- Multiple DEX detection. PumpSwap-only at start. Meteora/Raydium V4 catch dust noise; not worth the volume.
- Decision engine with weighted scoring. Tempting but adds significant new code. V2 starts with a binary filter (what round 1 ended at) and only escalates to scoring if data shows binary is insufficient.

## Architecture overview

Layered, in build order:

1. **Trade journal & invariants** — schema, write paths, fail-loud guarantees
2. **Position manager** — entry-price anchoring as a design invariant, exits unchanged from round 1 patterns
3. **Stream & detection** — PumpSwap migration account subscription only, signature + tokenCA dedup from day one
4. **Safety pipeline** — Phase A/B early exit, classification taxonomy for honeypot signal
5. **Wiring & observability** — strategy-field persistence, redaction, structured logging
6. **Soak harness** — diagnostic queries, success-criteria measurement

## Trade journal schema

A `TradeRecord` has these fields. Every field is required unless explicitly optional. Writes fail if invariants are violated.

```ts
interface TradeRecord {
  id: string;                       // uuid
  schemaVersion: 2;                 // bump on any breaking change

  // Origin
  strategy: 'SNIPER';               // hardcoded for v2; expand later
  edgesFired: ['SNIPER'];           // accumulated signal sources

  // Token & pool
  tokenCA: string;
  poolAddress: string;
  program: 'PUMPSWAP';              // hardcoded for v2
  deployer: string;

  // Entry — must all be set or write fails
  entryTimestamp: string;           // ISO8601
  entryPriceLamports: string;       // bigint as string; must be > 0
  entryPriceBasis: 'FIRST_TICK';    // how the price was determined
  initialLiquiditySOL: number;

  // Exit — populated on close
  exitTimestamp?: string;
  exitPriceLamports?: string;
  exitMode?: 'TP_TIER_1' | 'TP_TIER_2' | 'TP_TIER_3' | 'TP_TIER_4'
           | 'TRAILING_STOP' | 'HARD_STOP' | 'MAX_HOLD' | 'RUG_TRIGGER';
  realizedMultiple?: number;        // exit / entry, computed at close
  realizedPnLUSD?: number;

  // Tier tracking
  tier1Hit?: boolean;
  tier2Hit?: boolean;
  tier3Hit?: boolean;
  tier4Hit?: boolean;

  // Safety check trace (audit trail)
  safetyChecks: {
    liquidity: { passed: boolean; valueSOL: number };
    mintAuthority: { passed: boolean; revoked: boolean };
    freezeAuthority: { passed: boolean; revoked: boolean };
    lpLock: { passed: boolean; locked: boolean; lockDurationDays?: number };
    holderConcentration: { passed: boolean; topPct: number };
    scammyName: { passed: boolean };
    deployerBlacklist: { passed: boolean };
    honeypot: {
      passed: boolean;
      classification: 'CLEAN' | 'INDEX_LAG' | 'NOT_ROUTABLE' | 'UNCONFIRMED';
      sellQuoteSlippagePct?: number;
    };
  };

  // Latency trace
  evaluationLatencyMs: number;
  perCheckDurationMs: Record<string, number>;
}
```

**Invariants enforced at write time:**

- `entryPriceLamports !== '0'` (no phantom cascades)
- `strategy === 'SNIPER'` and `edgesFired === ['SNIPER']`
- All `safetyChecks.*.passed === true` (cannot persist a trade that should have been rejected)
- On close: if `tier1Hit || tier2Hit || tier3Hit || tier4Hit`, then `realizedMultiple` must be computed (not null)

A `TradeRecordValidator` runs before every write. Validation failures throw, surfacing in logs immediately.

## Position manager invariants

Round 1 lost weeks because `entryPriceLamports` could be 0 at write time. V2 prevents this by design:

- `Position.evaluateExits()` cannot run if `entryPriceSOL === 0`. It returns early with no-op.
- `Position.updatePrice(p)` checks: if `entryPriceSOL === 0` and `p > 0`, anchor `entryPriceSOL = p` and set `entryPriceBasis = 'FIRST_TICK'`. If `entryPriceSOL > 0`, normal price update.
- `Position.close()` recomputes `realizedMultiple` from `exit / entry` at close time. If either is 0 or non-finite, throws.

This kills the entry-price-zero bug class structurally, not reactively.

## Stream & detection

Subscribe to the **PumpSwap migration account**, not the AMM program. The AMM program receives every subsequent swap and produces overwhelming traffic. The migration account fires only on graduation events.

```
PUMPSWAP_MIGRATION_ACCOUNT = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg'
PUMPSWAP_PROGRAM            = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
```

Detect pool creation by exact log match on the migration account subscription:

```ts
logs.logs.some(l => l === 'Program log: Instruction: Migrate')
```

Verified from chain RPC in round 1 (transaction `31V8YGSQ...`, slot 416647963).

Two dedup layers:
- `isDuplicateSignature(sig)` — 5s TTL, catches confirmed+finalized double-delivery from WS
- `isDuplicateToken(tokenCA)` — 60s TTL, catches multi-program emission and stream-failover duplicates

Both run *before* `parsePoolCreation` to keep the fast path cheap.

## Safety pipeline (Phase A / B)

**Phase A — Synchronous, ~0ms, hard gates:**
- `liquidity` (≥3 SOL)
- `scammyName` (regex against known scam patterns)
- `lpLock` (LP burned or locked >7 days)

Any Phase A failure → reject immediately.

**Phase B — Parallel RPC-bound checks, budget 500ms:**
- `mintAuthority` (revoked)
- `freezeAuthority` (revoked)
- `holderConcentration` (top 10 ≤25%)
- `deployerBlacklist` (deployer not in known-rugger list)
- `honeypot` (Jupiter SELL quote, classified)

Each Phase B check has its own timeout. Honeypot specifically uses `attempts: 1` (no retry). All checks run via `Promise.all` with a global 500ms cap.

**Honeypot classification:**

```ts
type HoneypotClassification =
  | 'CLEAN'         // Sell quote returned 200 with reasonable price impact
  | 'INDEX_LAG'     // 400 within budget, but Jupiter eventually indexes (per round 1 sellability data, 0/26 of these were real honeypots in PumpSwap migration cohort)
  | 'NOT_ROUTABLE'  // 400 still after T+5s deferred probe — token genuinely cannot be sold
  | 'UNCONFIRMED';  // 200 with abnormally bad round-trip — possible sell tax
```

V2 starts with `CLEAN` allowed, all others reject. After 50+ trades validate the binary filter, optionally extend to "soft-pass on `INDEX_LAG` with deferred sellability probe + emergency exit" (this is the path round 1 was about to ship when the disk loss happened).

## Decision engine

V2 uses a binary filter, intentionally:

- All Phase A checks pass
- All Phase B checks pass with `classification === 'CLEAN'`
- → Enter

Position size is fixed (`SNIPER_POSITION_SIZE_SOL` config). No scoring, no Kelly fractioning, no signal weighting.

Rationale: round 1 spent significant effort on the binary version. V2's first goal is to validate whether sniper has edge under any configuration. Adding a scoring layer before answering that question is premature optimization. If 50–100 binary-filter trades produce non-edge, then build scoring. If they produce edge, stop and ship.

## Position management

TP ladder: 1.5x / 2.0x / 3.0x / 5.0x with 30/30/20/20 splits.
Trailing stop: activates at 1.15x, trails at −25% from peak.
Hard stop: 0.40x (drawdown).
Max hold: 180 seconds.

**New in v2: rug-trigger exit.** Subscribe to the pool's wSOL vault account during the hold window. If `postBalance` drops >40% in a single transaction, fire emergency exit at any slippage. This was a Layer 6 gap in round 1 and is not present in the current codebase.

**Deferred: momentum-based time exit.** "If price hasn't moved >1.05x by T+30s, exit." Tune from real data.

## Wiring & observability

**Strategy field persistence:** SniperEntry exposes `onOpened` callback. Wired in eventWiring to `tradeEntryCache.set()` with full sniper context. Close-side reads `ctxEntry?.source` and writes correct `edgesFired`.

**Logging hygiene:** All RPC URLs go through `redactApiKey()` helper before being logged. Centralized in `wsControl.ts`. Tests (`tests/wsControl.test.ts`) verify redaction across `api-key=`, `api_key=`, malformed URLs, and null/undefined inputs.

**Per-check timing:** Every Phase B check logs its individual duration. `latencyExceeded` rejection is distinct from `<check>_failed` — never collapse them.

## Soak harness

Three queries are first-class operational tools, not ad hoc greps:

```ts
// Sniper trades over time
async function getSniperTrades(opts: { sinceTimestamp?: string; onlyValid?: boolean }): Promise<TradeRecord[]>

// Latency distribution
async function getLatencyHistogram(windowMinutes: number): Promise<Histogram>

// Rejection breakdown
async function getRejectionReasons(windowMinutes: number): Promise<Record<string, number>>
```

These are exposed via a CLI entrypoint so a developer can run them without writing inline Node scripts every time.

## Success criteria

V2 is "validated" when:

- ≥50 closed sniper trades with `priceBasisInvalid !== true`
- All trades correctly labelled `strategy: 'SNIPER'`, `edgesFired: ['SNIPER']`
- Realistic exit-mode distribution (not >50% `MAX_HOLD`, not >50% `ALL_TIERS_HIT`)
- Computed metrics:
  - Win rate (trades with `realizedMultiple` ≥ 1.05) ≥ 25%
  - Average winner ≥ 1.8x
  - Expectancy positive after slippage and fees

If those thresholds are met, decide whether to extend (CPMM, scoring engine, infrastructure for live) or stop.

If not met, the question becomes whether the binary filter is too restrictive (extend to scoring) or whether sniper-on-PumpSwap-graduations is structurally non-edge (different strategy entirely).

## Migration plan

The round-1 codebase exists at `C:\Users\User\Downloads\trading-engine-main\trading-engine` (commit `45f511b` on main, plus older sniper attempts at `08b45e5`, `fa3b5ac`, `8f6c456`). V2 starts from `45f511b` clean — older sniper commits may contain useful patterns to reference but are not the same architecture as v2.

V2 builds in a new branch: `sniper-v2`. Cut from `main` at `45f511b`.

Rough order:

1. Day 1: Schema, validators, position manager invariants. Tests for each.
2. Day 2: Stream subscription, dedup layers, `parsePoolCreation`. Tests for dedup layers specifically.
3. Day 3: Safety pipeline (Phase A/B with classification). Tests for honeypot classification logic.
4. Day 4: Wiring, redaction, soak harness. End-to-end test with mocked stream.
5. Day 5: Deploy in paper mode. Begin first soak.

**Each day's work is committed and pushed to remote at end-of-day. No working-tree-only state. Round 1's loss was an avoidable disaster.**

## Knowledge preserved from round 1

These findings inform v2 design and don't need to be rediscovered:

- PumpSwap graduation events arrive on the migration account `39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg`. Subscribe there, not the AMM program — the AMM receives every swap.
- PumpSwap migration instruction string is `Program log: Instruction: Migrate` (chain-RPC verified, tx `31V8YGSQ...`, slot 416647963).
- Of 26 tokens rejected as `HONEYPOT_SELL_QUOTE_FAILED` in PumpSwap migration cohort, 0 were actual honeypots; all became routable within 5s.
- Jupiter indexing latency for new PumpSwap pools is bimodal: ~22% fast (<200ms), ~78% slow (~2.7s), gap between 500ms–2s is empty.
- Per-pool dedup must be at *both* signature (5s) AND tokenCA (60s) layers — neither alone is sufficient given WS double-delivery and multi-program emission patterns.
- The signature-only dedup has a known sync-callback race: both confirmed and finalized callbacks pass an empty-map check before the first await suspends. TokenCA dedup catches the second one downstream.
- RAYDIUM_V4 produces overwhelming dust pool noise (mean 0.062 SOL liquidity). Not worth subscribing to.
- The `realizedMultiple: undefined` artifact in round 1 was caused by `entryPriceLamports: 0`, which produced 369/0 → Infinity → JSON null. Schema validators in v2 prevent this class of bug entirely.

## v2 cleanup, post-build

- [ ] Decide hybridPowerPlay disposition: disable per v2 non-goal, or repurpose to consume `pool:graduated`
- [ ] Same for antifragileEngine, portfolioOptimizer
- [ ] Audit which round-1 modules are actually wired vs orphaned
