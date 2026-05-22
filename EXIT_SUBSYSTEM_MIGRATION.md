
# EXIT_SUBSYSTEM_MIGRATION.md

## Background

### Why this migration exists

V2 was specified in `STRATEGY_V2.md` as a deliberate restart from `main` at commit
`45f511b`, with explicit non-goals including the round-1 smart-money copy-trade
strategy, online learner, antifragile engine, and hybrid power play. The sniper
architecture in v2 was scoped tightly: PumpSwap graduations, binary safety filter,
fixed position sizing, paper-trading validation gate.

The bulk of the v2 build covered most of the spec — schema invariants, position
manager entry-price anchoring, stream and detection (migration account subscription,
dedup layers), the full Phase A/B safety pipeline including NOT_ROUTABLE
classification, wiring with redaction, and a real-RPC soak harness.

What didn't carry over from `45f511b` is the **exit subsystem**. The position
management section of `STRATEGY_V2.md` specifies a precise exit taxonomy with 8
modes (`TP_TIER_1` through `TP_TIER_4`, `TRAILING_STOP`, `HARD_STOP`, `MAX_HOLD`,
`RUG_TRIGGER`), per-tier partial closes via a 4-tier ladder at 1.5/2.0/3.0/5.0x
with 30/30/20/20 splits, a trailing stop activating at 1.15x and trailing -25%
from peak, a hard stop at 0.40x, and a new wSOL-vault-monitored `RUG_TRIGGER`
exit that fires when pool wSOL drops >40% in a single transaction.

The actual exit code in the working tree is from round 1. Verified via primary
source:

- `src/core/types.ts:21` — `ExitMode` is a 13-value union with round-1 names
  (`HARVEST`, `PANIC`, `DRIP`, `RAPID_DUMP_EXIT`, `ALL_TIERS_HIT`, etc.), not
  the 8-value spec taxonomy.
- `src/position/positionManager.ts:417-422` — `buildExitTiers()` returns a
  4-tier ladder at 1.3/1.6/2.5/5.0x with 40/30/20/10 splits, not the spec's
  1.5/2.0/3.0/5.0x at 30/30/20/20. Tier 4's multiple (5.0x) matches; every
  other tier multiple differs, and the split distribution shape differs
  (current is steeply front-loaded, spec is balanced).
- `src/position/positionManager.ts:241-260` — tier hits are tracked
  (`triggered: true`) but no per-tier partial close is issued; only when all
  tiers have triggered does the position close via `'ALL_TIERS_HIT'`.
- `src/position/positionManager.ts:262-267` — trailing stop activates only
  above 1.5x peak (no protection for positions that don't reach 1.5x) and
  triggers on an absolute 1.1x threshold (not peak-relative). Spec activates
  at 1.15x and trails 25% from peak — different protection model, not
  different tuning.
- Grep across `src/` for `rug|RUG_TRIGGER` in `positionManager.ts`: zero
  hits in the exit-firing logic. `RUG_TRIGGER` is a type slot but nothing
  emits it.
- `src/exits/exitEngine.ts:5` — exists as a class but inspection of
  `src/index.ts` shows it is instantiated (line 571) and never called by
  dot-access anywhere in the file. Its `bus.emit('exit:triggered', ...)`
  at lines 35-39 fires events that nothing subscribes to. Confirmed dead
  code in the live path.

This isn't a feature gap. It's a structural inconsistency between the v2 spec
and v2 code. The rest of the v2 build doesn't depend on exit logic and shipped
without surfacing this gap. But the validation gate from `STRATEGY_V2.md`
success criteria — "realistic exit-mode distribution... win rate ≥25%, average
winner ≥1.8x, expectancy positive" — can't be measured meaningfully against
round-1 exit logic.

### What this migration is, and isn't

This migration is the work to bring the exit subsystem into compliance with
`STRATEGY_V2.md`, so that paper-trading data produced after the migration
measures what the spec defines.

It is **not** an attempt to optimize exit logic, prove the strategy works, or
implement features beyond the spec. The spec defines what v2's exits should
be; this migration makes the code match.

It is also not a rewrite of unrelated round-1 code. `ExitEngine`, ML, and
replay modules consume the same `ExitMode` type but are non-goals per
`STRATEGY_V2.md`. The migration will touch them only where necessary to
preserve typecheck/build, not to bring them into spec.

### Why this is multi-day work, not a single commit

Two reasons the scope is shaped this way:

1. **Coupling**: Each piece (taxonomy, ladder, trailing stop, rug-trigger)
   touches the same module (`positionManager.ts`) and the same serialization
   boundary (`src/index.ts:1737-1750`, where `position.exitReason` strings
   are mapped to typed `ExitMode` values via a `Record<string, ExitMode>`
   and `startsWith` matcher). Independent commits for each piece would
   require the serialization map to handle both old and new mode names
   during transition, which the current implementation doesn't gracefully
   accommodate.

2. **Test surface**: A single test file (`tests/positionManager.test.ts`)
   exercises the existing exit logic. Migrating the taxonomy requires
   updating every assertion that names a current exit mode. Bundling that
   with implementation changes risks confusing the "what broke?" question
   when CI fails.

Sequencing the work into smaller, individually-verifiable commits is what
makes the migration tractable. This document defines that sequencing.

## Current state inventory

This section enumerates every code site that participates in exit logic today.
The goal is that any sequencing decision in Section 5 (the migration plan) can
be checked against this section: if a planned commit changes something not
listed here, either the inventory is incomplete or the commit is touching code
that isn't exit-related.

Every claim is anchored to a file:line citation. Where the citation refers to
a range, the range is inclusive.

### Type definitions

**`src/core/types.ts:21`** — `ExitMode` type union:

```typescript
export type ExitMode = 'HARVEST' | 'PANIC' | 'DRIP' | 'TIME_EXIT' | 'STALE_EXIT'
                     | 'STOP_LOSS' | 'RAPID_DUMP_EXIT' | 'EARLY_STOP'
                     | 'TRAILING_STOP' | 'ALL_TIERS_HIT' | 'EMERGENCY'
                     | 'RUG_TRIGGER' | 'UNKNOWN';
```

13 values. Spec calls for 8 trading modes (`TP_TIER_1`, `TP_TIER_2`,
`TP_TIER_3`, `TP_TIER_4`, `TRAILING_STOP`, `HARD_STOP`, `MAX_HOLD`,
`RUG_TRIGGER`). The migration retains 2 additional non-spec operational
modes (`STALE_EXIT`, `EMERGENCY`) by design — see Section 4 for the
deviation rationale.

Two current values overlap by name with spec: `TRAILING_STOP` and
`RUG_TRIGGER`. The behavior behind `TRAILING_STOP` differs (see exit
logic inventory below). `RUG_TRIGGER` is a type slot only — no firing
logic.

**`src/core/types.ts:175`** and **`src/core/types.ts:212`** — `exitMode?:
ExitMode` and `exitMode: ExitMode` field declarations on the
position/trade record types. Two declarations exist on different types
(one optional, one required); the relationship between them is a
pre-commit verification item before any taxonomy commit, since both
declarations are affected when `ExitMode` values are added or removed.

### positionManager: exit logic

positionManager.ts contains all live exit-firing logic for sniper
positions. It interacts with the type system in exactly one place: a
single string assignment at line 319. The file does not reference
`ExitMode` anywhere — it emits free-form reason strings, and the
serialization boundary (next subsection) converts those strings to
typed values.

**`src/position/positionManager.ts:130-131`** — exit tiers built at
position open time via `buildExitTiers()`, stored on the position record.

**`src/position/positionManager.ts:221-225`** — `RAPID_DUMP_EXIT` fires
when `holdMs < 60_000 && multiple <= 0.85`. Time-windowed early-tenure
protection: >15% drop in first 60s. No spec equivalent — spec's
loss-side protection is HARD_STOP at 0.40x with no time component.

**`src/position/positionManager.ts:228-232`** — `EARLY_STOP` fires when
`holdMs < 180_000 && multiple <= 0.80`. Time-windowed early-tenure
protection: >20% drop in first 3 minutes. No spec equivalent — same
reason as RAPID_DUMP_EXIT.

**`src/position/positionManager.ts:234-238`** — `STOP_LOSS` fires when
`multiple <= (1 - position.stopLossPct)`. Pure drawdown gate, no time
component. Threshold value is config-driven (`position.stopLossPct`).
Spec equivalent: `HARD_STOP` at 0.40x (which translates to
`stopLossPct: 0.60`). The mechanism matches spec; the rename to
`HARD_STOP` is a taxonomy change. Threshold value match is a Section 4
verification item.

**`src/position/positionManager.ts:241-253`** — TP ladder hit tracking.
Each tier with `triggered: false` becomes `triggered: true` when
`multiple >= tier.multiple`. Logs the hit. **Does not issue a partial
close.** The partial-close logic that the spec's 30/30/20/20 splits
require is not implemented anywhere.

**`src/position/positionManager.ts:255-260`** — `ALL_TIERS_HIT` fires
only when every tier in the ladder has `triggered === true`. This is
the only place tier logic causes a close, and it's all-or-nothing. This
logic is replaced atomically by per-tier emission in the migration.

**`src/position/positionManager.ts:262-267`** — Trailing stop. Activates
when `peakMultiple > 1.5` AND current `multiple < 1.1`. Both thresholds
absolute (not peak-relative trail). Spec: activates at 1.15x peak,
trails -25% from peak. Different protection model — a position peaking
at 3x and retracing to 1.4x would NOT trigger current logic (1.4 > 1.1)
but WOULD trigger spec logic (3x − 25% = 2.25x, 1.4 well below).

**`src/position/positionManager.ts:273-276`** — `emergencyCloseAll(reason:
string)`. Iterates all open positions and calls `closePosition(tokenCA,
'EMERGENCY: ' + reason)`. Invoked externally from `src/index.ts:1590`
(bot-shutdown event with `event.reason`) and `src/index.ts:1911`
(black swan event with `severity === 'FATAL'`). Both call sites are
operational circuit breakers — not strategy decisions. EMERGENCY
survives the migration as an operational mode (see Section 4).

**`src/position/positionManager.ts:314`** — `private closePosition(
tokenCA: string, reason: string, exitPriceSOL?: number)`. The single
exit channel from positionManager. Note: takes `reason: string`, not
`ExitMode`.

**`src/position/positionManager.ts:319`** — `position.exitReason =
reason`. The sole point where positionManager touches anything
mode-related on the position record.

**`src/position/positionManager.ts:373-377`** — `TIME_EXIT` fires when
`holdMs >= maxHoldMs`. Pure hold-duration exit, strategy decision.
Spec equivalent: `MAX_HOLD`. Clean rename.

**`src/position/positionManager.ts:381-385`** — `STALE_EXIT` fires when
no price update for `staleSince` time threshold. Operational exit (data
feed loss), not a strategy decision. Survives the migration as an
operational mode (see Section 4).

**`src/position/positionManager.ts:417-422`** — `buildExitTiers()`:

```typescript
return [
  { multiple: 1.3, pct: 0.40, triggered: false },
  { multiple: 1.6, pct: 0.30, triggered: false },
  { multiple: 2.5, pct: 0.20, triggered: false },
  { multiple: 5.0, pct: 0.10, triggered: false },
];
```

Current: 1.3/1.6/2.5/5.0x with 40/30/20/10. Spec: 1.5/2.0/3.0/5.0x
with 30/30/20/20.

### Serialization boundary

**`src/index.ts:1737-1750`** — the bridge from positionManager's reason
strings to typed `ExitMode` values:

```typescript
// Map positionManager exitReason → ExitMode
const exitReason = position.exitReason ?? 'UNKNOWN';
const exitModeMap: Record<string, ExitMode> = {
  'STOP_LOSS': 'STOP_LOSS',
  'RAPID_DUMP_EXIT': 'RAPID_DUMP_EXIT',
  'EARLY_STOP': 'EARLY_STOP',
  'TRAILING_STOP': 'TRAILING_STOP',
  'ALL_TIERS_HIT': 'ALL_TIERS_HIT',
  'TIME_EXIT': 'TIME_EXIT',
  'STALE_EXIT': 'STALE_EXIT',
  'EMERGENCY': 'EMERGENCY',
};
const exitModeKey = Object.keys(exitModeMap).find(k => exitReason.startsWith(k));
const resolvedExitMode: ExitMode = exitModeKey ? exitModeMap[exitModeKey] : 'UNKNOWN';
```

The map is identity-mapping today: every key maps to the same string as
its value. Eight entries cover every reason string positionManager
emits. Three ExitMode values are unreachable from this map (`HARVEST`,
`PANIC`, `DRIP` — all ExitEngine-only) and two more are special cases
(`RUG_TRIGGER` has no firing logic; `UNKNOWN` is the fallback when
nothing matches).

This boundary cleanly accommodates taxonomy renames: identity-mapping
values can be swapped to spec mode names while keys (positionManager
reason prefixes) remain unchanged. positionManager does not reference
`ExitMode` at all (verified: a single match for any of `ExitMode`,
`exitMode`, `exitReason` in `positionManager.ts`, at line 319,
assigning a string to `position.exitReason`). Taxonomy renames are
therefore two-file changes touching `src/core/types.ts` and
`src/index.ts` only.

New emission shapes — per-tier partial closes and RUG_TRIGGER firing —
require coupled changes: positionManager must emit new reason strings,
and the map must recognize them. These cannot be split across commits
without the interim state falling back to `'UNKNOWN'`.

The atomic replacement of `ALL_TIERS_HIT` by per-tier `TP_TIER_1..4`
emission is the largest single coupled change: the all-tiers close at
positionManager:255-260 is removed, per-tier emit is added (replacing
the tier-hit logging at lines 241-253 with actual closePosition calls),
and the map's `ALL_TIERS_HIT` entry is deleted while four new tier
entries are added — all in one commit.

**`src/index.ts:1795`** and **`src/index.ts:1821`** — `exitMode:
resolvedExitMode` writes the resolved mode to two destinations (trade
record persistence and an event payload, judging by surrounding context).

### Event bus

**`src/core/eventBus.ts:38`** — `'exit:triggered': { tokenCA: string;
mode: ExitMode; reason: string }` — event type declared.

**`src/exits/exitEngine.ts:35-39`** — the only emitter of
`exit:triggered` in the codebase. Emitted from `ExitEngine.checkTiers()`
with `mode: 'HARVEST'`. **No subscriber exists in `src/index.ts`.**
The event fires into the void.

### Dead/inert code

**`src/exits/exitEngine.ts`** — the entire `ExitEngine` class.

- Imports `OpenPosition`, `ExitMode`, `ExitTier` types
- `selectExitMode()` returns `'PANIC' | 'TIME_EXIT' | 'DRIP' | 'HARVEST'`
  based on `lpRemovalDetected`, `smartWalletsSelling`,
  `position.trade.signal.manipulationRisk`, `volumeAccelerating` —
  round-1 smart-money signals
- `checkTiers()` emits `'exit:triggered'` events with `mode: 'HARVEST'`
- Instantiated at `src/index.ts:571` (`const exitEngine = new
  ExitEngine();`)
- **Never accessed by dot-notation anywhere in `src/index.ts`**. The
  variable is declared, assigned, and never referenced again.

`STRATEGY_V2.md` non-goals explicitly include "Smart-money copy-trading"
and the modes ExitEngine returns are not in the spec's 8-mode taxonomy.
ExitEngine is dead code for v2 purposes.

### Non-sniper consumers of `ExitMode`

These modules import `ExitMode` and operate on it, but are out of v2
scope per `STRATEGY_V2.md` non-goals ("Online learner / factor
extractor... Antifragile engine, hybrid power play, portfolio
optimizer. Round 1 vestigial complexity"):

**`src/ml/mlTypes.ts:11`** — imports `ExitMode`. Purpose: feature
extraction for online learner. Per spec, deferred until strategy
validation.

**`src/replay/replaySimulator.ts:72`** — uses `entry.outcome === 'LOSS'
&& entry.exitMode === 'TIME_EXIT'` as a condition. Replay/simulation
infrastructure. Per spec, not part of v2. This site references
`'TIME_EXIT'` by name; if the rename to `'MAX_HOLD'` lands, this site
needs updating to compile, or the replay module needs decoupling from
ExitMode.

### Journal/persistence

**`src/journal/journalTypes.ts:55`** — `exitMode?: string` (typed as
`string`, not `ExitMode`). Weak typing at the persistence boundary.

**`src/journal/tradeJournal.ts:21`** — `'exitTimestamp', 'exitPriceSOL',
'exitMode', 'exitReason'` in a column or field list.

**`src/journal/tradeJournal.ts:99`** — `exitMode TEXT` in what appears
to be a SQL schema definition. Persistence layer stores exit mode as
text, type-agnostic at the database level.

### Test coverage

**`tests/positionManager.test.ts`** — the only test file with
`positionManager` in the name. Test surface bounded to this one file
(and possibly indirect coverage via integration tests; not audited at
this stage).

Coverage of specific exit modes by name is not enumerated here. That
audit happens immediately before Section 5 (migration plan), since
test surface dictates commit shapes.

### What's NOT in the codebase

For completeness, the spec items with **no corresponding code**:

- **`TP_TIER_1` through `TP_TIER_4`** as `ExitMode` values, and
  per-tier partial close logic. Tier tracking exists; per-tier emission
  does not.
- **`HARD_STOP`** as an `ExitMode` value (current uses `STOP_LOSS`).
- **`MAX_HOLD`** as an `ExitMode` value (current uses `TIME_EXIT`;
  `STALE_EXIT` is separately preserved as an operational mode).
- **`RUG_TRIGGER`** firing logic. The type value exists; no wSOL vault
  subscription, no postBalance-drop detection, nothing emits the mode.

### Summary of migration touchpoints

For Section 5's sequencing, the categorization of changes:

**Clean renames (two-file changes: type + map)**: positionManager
unchanged.

- `STOP_LOSS` → `HARD_STOP` (mechanism matches spec; threshold value is
  a Section 4 verification item)
- `TIME_EXIT` → `MAX_HOLD`

**Atomic replacement (coupled change: type + map + positionManager)**:

- `ALL_TIERS_HIT` removed; `TP_TIER_1`, `TP_TIER_2`, `TP_TIER_3`,
  `TP_TIER_4` added; positionManager:241-260 rewritten to issue
  per-tier partial closes instead of tracking-without-closing. Single
  commit, atomic.

**Drops (type removal + map entry removal + positionManager logic
removal)**:

- `HARVEST`, `PANIC`, `DRIP` — ExitEngine-only; drop with ExitEngine
  retirement (Section 4 decision)
- `RAPID_DUMP_EXIT` — time-windowed early-tenure protection, dropped
  per spec; behavior change documented in Section 4
- `EARLY_STOP` — same as RAPID_DUMP_EXIT
- `UNKNOWN` — investigate whether strict typing removes the fallback
  need (Section 4)

**Kept as operational modes (deviation from spec's 8 trading modes;
rationale in Section 4)**:

- `STALE_EXIT` — data feed loss; excluded from strategy validation
  metrics
- `EMERGENCY` — operational circuit breaker called from
  `src/index.ts:1590` and `src/index.ts:1911`; excluded from strategy
  validation metrics

**New emission shapes (coupled: type + map + positionManager + possibly
new modules)**:

- Per-tier emission (covered by `ALL_TIERS_HIT` atomic replacement
  above)
- `RUG_TRIGGER` emission: positionManager subscribes to pool wSOL
  vault, detects postBalance drop >40% in single tx, emits
  `'RUG_TRIGGER'` reason string; map adds matching key with value
  `RUG_TRIGGER`. May require new module for wSOL vault subscription.

**Threshold-only changes (single-file: positionManager only)**:

- Trailing stop activation 1.5x → 1.15x and trigger absolute 1.1x →
  peak-relative -25%. Logic change in `positionManager.ts:262-267`.
  Map and type unchanged.

**Side-effect of taxonomy changes**:

- `src/replay/replaySimulator.ts:72` references `'TIME_EXIT'` by string
  literal. The `TIME_EXIT` → `MAX_HOLD` rename will fail to compile
  this site. Either update the literal in the same commit (preferred,
  keeps the rename atomic) or decouple replay/ from ExitMode entirely
  (larger scope, defer).
- `src/ml/mlTypes.ts:11` imports `ExitMode` as a type but doesn't
  appear to reference specific mode values by string literal. Two
  patterns would change that: `Record<ExitMode, ...>` (forces
  exhaustive key coverage) or an exhaustive `switch` on a value of
  type `ExitMode`. Either would produce type errors when union values
  are added or removed, with errors that don't look like string-literal
  mismatches. Pre-commit verification item: grep mlTypes.ts for
  `Record<ExitMode` and `switch.*exitMode` patterns before any
  taxonomy commit lands.

**Test migration**: each of the above commits requires updating
`tests/positionManager.test.ts` assertions that reference current mode
names. Test changes interleave with implementation changes; precise
sequencing in Section 5.

## Gap analysis

### What this section is for

Section 2 enumerated everything that exists in the code today. Section 3
enumerates what's missing or wrong relative to the spec, organized by
impact on the v2 validation gate.

The format is paired: each gap states (a) what the spec requires, (b)
what the code currently does, (c) what the gap means for the v2 success
criteria from `STRATEGY_V2.md`.

### Gaps in the exit taxonomy

**Gap 1: 5 spec mode names absent from `ExitMode` union.**

- Spec requires (`STRATEGY_V2.md` position management section):
  `TP_TIER_1`, `TP_TIER_2`, `TP_TIER_3`, `TP_TIER_4`, `HARD_STOP`,
  `MAX_HOLD` as `ExitMode` values.
- Code has (`src/core/types.ts:21`): none of these names. Current modes
  serve overlapping roles under different names (`STOP_LOSS` for
  HARD_STOP, `TIME_EXIT` for MAX_HOLD, `ALL_TIERS_HIT` for the terminal
  tier).
- Validation impact: the success criteria ("realistic exit-mode
  distribution, not >50% MAX_HOLD") explicitly references spec mode
  names. Records persisted with `STOP_LOSS` or `TIME_EXIT` cannot be
  measured against this criterion without translation logic that doesn't
  exist.
- Pre-commit verification carried from Section 2: the dual `exitMode`
  declarations at `src/core/types.ts:175` (optional) and `:212`
  (required) on different types are unaudited. Their relationship
  surfaces during the taxonomy commit, since both are affected when
  ExitMode values change.

**Gap 2: 7 round-1 mode names present in `ExitMode` union that the
spec doesn't include.**

- Code has (`src/core/types.ts:21`): `HARVEST`, `PANIC`, `DRIP`,
  `RAPID_DUMP_EXIT`, `EARLY_STOP`, `ALL_TIERS_HIT`, `UNKNOWN`.
- Spec requires: only 8 trading modes total. None of these 7 are in
  spec.
- Validation impact: any record with these values is outside the spec
  taxonomy and would need to be either translated, excluded, or counted
  as anomaly during validation.

### Gaps in exit logic

**Gap 3: TP ladder splits don't match spec.**

- Spec requires: 30/30/20/20 splits at 1.5/2.0/3.0/5.0x.
- Code has (`src/position/positionManager.ts:417-422`): 40/30/20/10
  splits at 1.3/1.6/2.5/5.0x.
- Validation impact: the spec's multiples define what counts as "tier 1
  hit" in records. Trades that hit 1.3x but not 1.5x under current
  logic register tier 1; under spec logic they would not. The
  realized-multiple distribution in 50+ recorded trades would shift
  meaningfully.

**Gap 4: Per-tier partial closes not implemented.**

- Spec requires: each tier hit triggers a partial sell at that tier's
  pct. Position size decreases progressively.
- Code has (`positionManager.ts:241-260`): tier hits set
  `triggered: true` and log; no actual partial sell is issued. Only
  when all 4 tiers triggered does a full close fire under
  `ALL_TIERS_HIT`.
- Validation impact: average winner metric (≥1.8x per spec) is
  calculated against realized multiples. Without partial closes, a
  position hitting 1.6x then retracing to 1.0x records 1.0x as the
  realized multiple. With partial closes, the same trajectory records a
  weighted average of 1.6x and 1.0x (likely ~1.4x). The metric measures
  different things in the two implementations. See Gap 11 — addressing
  this gap is also blocked on schema changes the current journal layer
  doesn't support.

**Gap 5: Trailing stop activation and trigger model wrong.**

- Spec requires: activate when peak ≥1.15x; close when current price
  falls 25% below peak.
- Code has (`positionManager.ts:262-267`): activate when peak >1.5x;
  close when current <1.1x absolute.
- Validation impact: protection model is different in shape, not just
  thresholds. Positions peaking at 1.4x get zero protection under
  current logic; spec would protect them above 1.15x.
  Realized-multiple distribution for moderate winners is significantly
  different.

**Gap 6: HARD_STOP threshold unverified.**

- Spec requires: hard stop at 0.40x (60% drawdown).
- Code has (`positionManager.ts:234-238`): pure drawdown gate using
  `position.stopLossPct`, value config-driven. Value not surfaced in
  Day 12 diagnostics.
- Validation impact: if `stopLossPct === 0.60`, the rename to HARD_STOP
  is taxonomy-only. If it differs, threshold migration is also required.
  Cannot decide without verifying config.

**Gap 7: RUG_TRIGGER firing logic absent.**

- Spec requires: subscribe to pool wSOL vault account during hold
  window; emergency exit at any slippage when `postBalance` drops >40%
  in a single transaction.
- Code has: type slot only (`ExitMode` includes `RUG_TRIGGER`). No wSOL
  vault subscription, no postBalance-drop detection, nothing emits the
  mode.
- Validation impact: rugged tokens currently exit via whatever catches
  the price drop (RAPID_DUMP_EXIT, EARLY_STOP, STOP_LOSS, or
  TIME_EXIT). Without rug-trigger, rugged trades distort win/loss
  attribution — they look like "strategy got out at the wrong time"
  rather than "system caught a rug and exited cleanly."

### Gaps in surrounding infrastructure

**Gap 8: Exit-event subscription path broken.**

- Code has (`src/exits/exitEngine.ts:35-39`):
  `bus.emit('exit:triggered')` fires from `ExitEngine.checkTiers()`.
  No `bus.on('exit:triggered')` exists anywhere in `src/index.ts`.
- Spec requires: events emitted should drive position closes; the
  actual close path runs via positionManager directly, not via the
  event bus.
- Validation impact: none for sniper today (the dead code path doesn't
  fire for sniper positions). But it's confusing tech debt — the event
  type is declared, the emitter exists, no consumer. Worth retiring
  with ExitEngine.

**Gap 9: ExitEngine class is instantiated dead code.**

- Code has (`src/index.ts:571`): `const exitEngine = new ExitEngine();`.
  The variable is declared, assigned, and never referenced again.
- Spec requires: nothing about ExitEngine. The class operates on
  round-1 smart-money signals (`manipulationRisk`,
  `smartWalletsSelling`, `volumeAccelerating`) which are explicit
  non-goals.
- Validation impact: none directly. But the class's existence in the
  build adds confusion and risk — future readers might wire it back in
  thinking it's active.

**Gap 10: Type coupling in non-goal modules.**

- Code has: `src/ml/mlTypes.ts:11` imports `ExitMode`.
  `src/replay/replaySimulator.ts:72` uses
  `entry.exitMode === 'TIME_EXIT'` by literal.
- Spec requires: nothing about these modules. They are non-goals per
  `STRATEGY_V2.md`.
- Validation impact: changing `ExitMode` values forces decisions on
  these modules. The taxonomy rename will break the replaySimulator
  literal check; if mlTypes uses exhaustive `Record<ExitMode>` or
  `switch`, it will also break.

**Gap 11: Journal schema cannot represent per-tier partial closes.**

- Spec requires per-tier exit data sufficient to compute "average
  winner ≥1.8x" against realized multiples weighted by
  partial-close pcts.
- Code has (`src/journal/journalTypes.ts:55`,
  `src/journal/tradeJournal.ts:99`): single `exitMode?: string` field,
  single `exitMode TEXT` column per trade record. Per-tier emission
  (Gap 4) produces 4 close events per position; the current schema can
  store only one.
- Validation impact: even with Gap 4 fully addressed (per-tier emission
  logic shipped), the validation gate's "average winner" metric is
  unmeasurable without schema changes to represent multiple closes per
  position. Two schema-direction options exist (multi-row
  representation, or a nested closes array per record); the decision
  shapes how positionManager emits records during partial closes.
- Coupling: this gap is structurally bound to Gap 4. The schema
  decision is not independent — it has to be made before per-tier
  emission can land.

### Gaps that aren't actually gaps

To avoid Section 5 over-scoping, here are spec items marked as ALREADY
MET, with citations:

**Not-a-gap 1: TRAILING_STOP exists in the ExitMode union.**

- Spec requires `TRAILING_STOP`. Code (`src/core/types.ts:21`) has it.
  The name and slot survive the migration; only the firing logic (Gap 5)
  needs change.

**Not-a-gap 2: RUG_TRIGGER exists in the ExitMode union.**

- Spec requires `RUG_TRIGGER`. Code (`src/core/types.ts:21`) has it.
  Only the firing logic (Gap 7) needs change.

**Not-a-gap 3: STOP_LOSS mechanism (pure drawdown) matches spec's
HARD_STOP design.**

- Spec requires hard stop on drawdown threshold, no time component.
  Code (`positionManager.ts:234-238`) implements exactly that. Rename +
  threshold-value verification (Gap 6) are the only changes needed; the
  mechanism is correct.

**Not-a-gap 4: TIME_EXIT mechanism (hold-duration exit) matches spec's
MAX_HOLD design.**

- Spec requires exit when held longer than maxHoldMs. Code
  (`positionManager.ts:373-377`) implements exactly that. Pure rename
  needed.

**Not-a-gap 5: Tier-tracking data structure is present.**

- Spec requires 4-tier ladder with `triggered` state per tier. Code
  (`positionManager.ts:417-422` + `241-253`) has this structural pattern
  already in place. The multiples (Gap 3), splits (Gap 3), and per-tier
  emission (Gap 4) are wrong, but the underlying tracking shape doesn't
  need to be invented from scratch — the migration modifies what's
  already there rather than building new structure.

### Summary

11 gaps total. Distributed as:

- 2 in the type taxonomy (modes missing, modes extraneous)
- 5 in the exit logic (TP splits, per-tier closes, trailing stop model,
  HARD_STOP threshold, RUG_TRIGGER firing)
- 3 in surrounding infrastructure (event bus dead path, ExitEngine
  class dead, type coupling in non-goal modules)
- 1 in journal/persistence (schema cannot represent per-tier closes;
  structurally coupled to per-tier emission work)

5 not-actually-gaps: TRAILING_STOP and RUG_TRIGGER slots present,
STOP_LOSS and TIME_EXIT mechanisms correct, tier-tracking structure
present.

The migration plan in Section 5 will address gaps 1-11 in a sequenced
commit order, with not-a-gap items providing the framework on which the
migration builds (existing slots, existing mechanisms, existing
structure).