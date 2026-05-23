
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

## Out-of-scope decisions

This section makes the decisions Sections 2 and 3 deferred forward. Each
decision is documented with reasoning, pre-commit verification items where
applicable, and forward references to Section 5 where sequencing is shaped.

The decisions are stable. Re-litigating them is appropriate only if a Section 5
pre-commit check produces new information — e.g., the UNKNOWN frequency
audit (Decision 6) returns non-zero and reshapes the migration sequence.

### Decision 1: ExitEngine disposition — delete

**Decision**: Delete `src/exits/exitEngine.ts` entirely. Remove the import at
`src/index.ts:17` and the unused instantiation at `src/index.ts:571`. Remove
the `'exit:triggered'` event type from `src/core/eventBus.ts:38` conditional
on a clean grep across the codebase.

**Reasoning**: The class is dead code — instantiated, never accessed by
dot-notation, emitting events with no subscriber. Its `selectExitMode()` returns
modes outside the spec's 8-mode taxonomy (`PANIC`, `HARVEST`, `DRIP`) based on
round-1 smart-money signals (`manipulationRisk`, `smartWalletsSelling`,
`volumeAccelerating`) explicitly listed as non-goals in `STRATEGY_V2.md`. Unlike
the `checkHoneypot` decision (kept for test coverage value), ExitEngine has no
test coverage of shared logic to preserve. The archaeological-value argument
for keeping the file fails: `git log` preserves the round-1 design forever;
`git show <commit>:src/exits/exitEngine.ts` retrieves any historical version.
Deletion removes a build-surface concern (one less file to typecheck) and a
confusion risk (future readers seeing instantiated-but-unused code).

**Pre-commit checklist** for the deletion commit:

1. Grep `src/` for `ExitTier` references. If ExitEngine is the only consumer,
   `ExitTier` becomes dead and is removed in the same commit. If other modules
   reference it, it stays.
2. Inspect `exitEngine.ts` module scope for top-level executable code outside
   the class definition (registrations, initializers, IIFEs, side-effecting
   imports). Confirm the file is class-definition-only before deletion.
3. Grep the entire codebase (not just `src/index.ts`) for `'exit:triggered'`.
   If grep returns zero results after ExitEngine deletion, the event type
   declaration at `eventBus.ts:38` goes in the same commit. If there is a
   stray subscriber (test infrastructure, monitoring, anything), the event
   declaration stays until that's resolved.

**Section 5 reference**: This is a single atomic commit. Sequencing: any time
in the migration phase. Recommend early (Phase 1) to clear dead code before
the taxonomy work begins.

### Decision 2: Schema for Gap 11 — hybrid (positions table + new partial_closes table)

**Decision**: The journal schema gains a new `partial_closes` table. The
existing `positions` table schema is unchanged. Each tier hit during a
position's hold generates one `partial_closes` row. The position's row writes
once at close-time, with `exitMode` set to the terminal mode (the close event
that retired the residual position).

**Schema shape**:

```
positions table (existing, unchanged):
  id, tokenCA, strategy, edgesFired, entryTimestamp,
  entryPriceLamports, exitTimestamp, exitPriceLamports,
  exitMode, realizedMultiple, realizedPnLUSD, ...

partial_closes table (new):
  position_id (FK → positions.id)
  tier_n (1..4)
  pct_closed (e.g. 0.30 for 30%)
  exit_price_lamports
  exit_timestamp
  exit_mode (TP_TIER_1..4)
  PRIMARY KEY (position_id, tier_n)
```

**Reasoning**: Validation gate metrics (win rate, average winner, expectancy)
are position-level, computed against the positions row directly. Option A
(multi-row representation) requires a GROUP BY pass before every validation
query. Option B (nested closes array as JSON column) is a known anti-pattern
for SQL — querying within the JSON is awkward and breaks the query plan. The
hybrid keeps validation queries fast and clean while preserving per-tier
detail in the partial_closes table for analytical queries that want it. Old
positions (pre-migration) have zero partial_closes rows — queries left-join
and treat NULL as "no partial closes." No data migration required.

The "two write paths" cost is appropriate because the position close and the
tier hits represent distinct events.

**Terminal mode semantics**: `TP_TIER_4` is both a `partial_closes` row (for
the final tier hit) and the `positions.exitMode` (since tier 4 closes the
residual 20%). No separate `ALL_TIERS_HIT` concept needed.

**Pre-commit checklist** for the per-tier emission + schema commit (Gap 4 +
Gap 11, structurally bound):

1. Verify the current write path for positions is once-at-close, not
   incremental. If positions are written incrementally, the "unchanged write
   path" framing breaks down and the migration scope expands.
2. `realizedMultiple` is computed from in-memory tier state, not from a DB
   query. positionManager already tracks tier hits in-memory as `triggered`
   flags (Section 2: positionManager.ts:241-253) and can record close-price
   at each tier hit in the same state. At close-time, the weighted average
   computes from this running in-memory data — no read-before-write. Write
   the positions row and all partial_closes rows in the same transaction.
3. Verify no other module computes `realizedMultiple` independently and would
   get out of sync.
4. Constrain `partial_closes.exit_mode` to TP_TIER_1..4 (or whichever subset
   of ExitMode is valid for partial close events). Application-layer
   enforcement or DB CHECK constraint — call to make during implementation.

**Section 5 reference**: Gap 4 (per-tier emission) and Gap 11 (schema) are
structurally bound. They land in the same commit or paired sequence within
the same phase. The schema decision precedes the emission code because
emission shape depends on schema target.

### Decision 3: STALE_EXIT and EMERGENCY as operational modes — single union with documented categories

**Decision**: The `ExitMode` type remains a single union containing trading
modes, operational modes, and a diagnostic sentinel. The distinction is
documented in a comment block above the type definition, not enforced by
separate types.

**Comment block to ship with the type definition**:

```typescript
/**
 * Exit modes for trade records.
 * 
 * Trading modes (per STRATEGY_V2.md): TP_TIER_1..4, TRAILING_STOP, HARD_STOP,
 * MAX_HOLD, RUG_TRIGGER. These represent strategy decisions and are included
 * in validation gate metrics.
 * 
 * Operational modes: STALE_EXIT (data feed loss), EMERGENCY (system shutdown,
 * black-swan circuit breaker). These represent expected infrastructure events
 * by design — they fire on predictable conditions.
 * 
 * Diagnostic sentinel: UNKNOWN. Indicates a position closed without a 
 * recognized exit reason — a "should never happen" canary. Non-zero frequency
 * in journal data signals a bug.
 * 
 * Validation metrics (win rate, average winner, expectancy) MUST exclude all
 * three non-trading categories via:
 *   WHERE exit_mode NOT IN ('STALE_EXIT', 'EMERGENCY', 'UNKNOWN')
 * 
 * UNKNOWN's presence in the type union is intentional for this migration but
 * represents technical debt. The bounded cleanup path: make 
 * positionManager.exitReason non-nullable, type the serialization map 
 * exhaustively as Record<PositionManagerReasonPrefix, ExitMode>, then UNKNOWN
 * can be removed from the type union entirely. Document timing of this 
 * follow-up in EXIT_SUBSYSTEM_MIGRATION.md after migration validation.
 * 
 * Adding new modes: classify as trading, operational, or diagnostic. If 
 * operational, update the exclusion list in all validation queries. If 
 * diagnostic, treat as a bug signal. If trading, this constitutes a spec 
 * deviation from STRATEGY_V2.md — document the rationale in 
 * EXIT_SUBSYSTEM_MIGRATION.md Section 4 before shipping.
 */
export type ExitMode = ...
```

**Reasoning**: Single union is simplest. Type-system enforcement via separate
`TradingExitMode` / `OperationalExitMode` types only pays off if TypeScript
code processes modes at dispatch-time and needs compile-time guarantees about
which branch handles what. The validation gate is SQL, not TypeScript
dispatch — there's no consumer where the type discrimination would catch a
real bug. A stored category field would be redundant (mode → category is
1:1) and creates the risk of mode/category drift over time. Comment block
plus disciplined exclusion filter in validation queries is the right level
of formalization.

**Why STALE_EXIT and EMERGENCY survive as operational modes**: Both fire on
infrastructure conditions, not strategy decisions. STALE_EXIT fires when the
price feed goes silent for a threshold time (data quality, not "we held long
enough"). EMERGENCY fires from `emergencyCloseAll` called externally
(`src/index.ts:1590` bot-shutdown, `src/index.ts:1911` black-swan FATAL
severity). Conflating either with strategy modes (e.g. mapping STALE_EXIT to
MAX_HOLD) would attribute infrastructure failures to deliberate strategy
decisions and contaminate validation metrics. The success criteria need to
be computable on strategy executions only.

**Spec deviation acknowledgment**: STRATEGY_V2.md specifies 8 trading modes.
This migration ships 10 ExitMode values (8 trading + 2 operational). The
deviation is principled and documented in the type's comment block. Future
modes that don't fit the existing categories require a Section 4 update with
rationale before shipping.

### Decision 4: Drop RAPID_DUMP_EXIT and EARLY_STOP — explicit behavior change

**Decision**: Both round-1 time-windowed early-tenure protections are removed.
HARD_STOP at 0.40x becomes the sole loss-side floor for normal volatility.
RUG_TRIGGER (Gap 7) handles the catastrophic case (wSOL vault drain >40% in
single tx).

**Behavioral walkthrough**:

- Position drops 20% in first minute: was closed under EARLY_STOP at 0.80x;
  now held, awaiting either HARD_STOP at 0.40x or recovery to a TP tier.
- Position drops 30% over 2 minutes: was closed under EARLY_STOP at 0.70x;
  now held.
- Position drops 50% in first 30 seconds: was closed under RAPID_DUMP_EXIT
  at 0.50x; now held until HARD_STOP at 0.40x triggers or RUG_TRIGGER fires
  on the underlying vault drain.

**Maximum unrealized loss before forced close**: 60% (HARD_STOP at 0.40x),
versus 15-20% under round-1 logic.

**The replacement framing**: The spec replaces the time-windowed approximation
with two purpose-built mechanisms. Rugs are caught by RUG_TRIGGER (deterministic
signal: pool wSOL vault postBalance drop >40% in a single transaction). Normal
volatility is caught by HARD_STOP (pure drawdown threshold). The round-1
time-windowed stops were crudely approximating both — exiting fast on
catastrophic drops (which RUG_TRIGGER now catches better) and also exiting on
normal volatility (which HARD_STOP now catches with a wider floor).

**The bet**: Spec accepts wider drawdowns in exchange for not getting shaken
out of recoverable positions early. The validation gate (50+ trades) measures
whether this tradeoff produces edge.

**Validation-data boundary** (sequencing constraint for Section 5):

Validation data collection cannot begin until **both** of the following are
shipped:

1. RUG_TRIGGER emission (Gap 7 closed) — positionManager subscribes to pool
   wSOL vault, detects postBalance drop >40% in single tx, emits 
   `'RUG_TRIGGER'` reason string; map adds matching key.
2. RAPID_DUMP_EXIT and EARLY_STOP removal — both close branches deleted from
   positionManager (lines 221-225 and 228-232); both keys removed from
   exitModeMap; both values removed from ExitMode union.

The commits can land at any interval. The hard constraint is the validation
gate boundary: data collected in an interim window where RAPID_DUMP/EARLY_STOP
are gone but RUG_TRIGGER isn't live yet would attribute rugged tokens to
HARD_STOP rather than RUG_TRIGGER, contaminating the exit-mode distribution
which is one of the success criteria. Section 5 marks this boundary
explicitly.

**Section 5 reference**: Recommend grouping the two changes in the same
migration phase, with RAPID_DUMP/EARLY_STOP removal landing after RUG_TRIGGER
emission within the phase. This minimizes the window where the interim state
even exists. The hard constraint is the phase boundary, not the commit order
within the phase.

### Decision 5: ml/ and replay/ coupling — tolerate, update same-commit, classify as dormant

**Decision**: When the taxonomy rename commits land, string literals in 
`src/replay/replaySimulator.ts:72` (and any other locations surfaced by 
pre-commit grep) are updated in the same commit. The mlTypes.ts import 
remains untouched unless exhaustive ExitMode patterns are found there
(pre-commit verification item).

**Reasoning**: These modules are non-goals per `STRATEGY_V2.md`. Engineering
effort to decouple them from ExitMode (Option B) is scope creep — real work
on modules the spec explicitly defers. Forcing build-breakage as a forcing
function (Option C) creates friction during commits that are already
coupled, and risks the kind of "compiles in TypeScript but fails at runtime"
issue that the inventory caught with the replaySimulator literal in the
first place. Same-commit string updates are minimal cost — a one-line edit
per discovered reference.

**Pre-commit verification** before the taxonomy rename commit lands:

1. Grep `src/ml/` and `src/replay/` for all `ExitMode` references, all
   `exitMode` field accesses, and all string literals matching current
   ExitMode values. The two surfaced during inventory (mlTypes.ts:11
   import, replaySimulator.ts:72 literal) may not be exhaustive.
2. For mlTypes.ts specifically: check for exhaustive patterns
   (`Record<ExitMode, ...>` or `switch` on a value of type `ExitMode`).
   Either would produce type errors when union values change, with errors
   that don't look like string-literal mismatches.
3. Confirm complete reference list before drafting the rename commit. The
   "same-commit update" framing assumes you know the complete surface.

**Dormant vs dead distinction**: ml/ and replay/ are *dormant*, not dead.
ExitEngine (Decision 1) is dead — instantiated, never called, operating on
non-goal signals. ml/ and replay/ compile, contain logic, are just not
wired into v2's live path. Different categories. The dormant modules don't
get retired in this migration. Their fate is a decision for when they 
become active goals (decouple properly then) or explicit retirement 
candidates (coupling disappears with them). Neither path is a current 
migration decision. Section 4 tolerates the coupling for now.

### Decision 6: UNKNOWN fallback — keep as diagnostic sentinel

**Decision**: `UNKNOWN` remains in the `ExitMode` type union as a "should
never happen" canary. The serialization boundary's two fallback paths
(null `position.exitReason` → `'UNKNOWN'`; unrecognized reason → `'UNKNOWN'`)
are preserved. Validation queries exclude UNKNOWN alongside the operational
modes via the same WHERE clause filter.

**Reasoning**: Removing UNKNOWN entirely (Option B) requires making
`position.exitReason` non-nullable across positionManager's full close-path
audit, and typing the exitModeMap exhaustively as
`Record<PositionManagerReasonPrefix, ExitMode>`. That's bounded but
non-trivial work for a "should never happen" guarantee. The defensive value
of keeping the canary is real — if something goes wrong and a position
closes without a recognized exit reason, the record persists with diagnostic
value rather than throwing or producing silent garbage. Option C (drop from
type, runtime sentinel only) creates type/runtime divergence, which produces
"but the type says X, why does the data have Y" questions later.

**Categorization distinction**: UNKNOWN is documented as a diagnostic
sentinel, not as an operational mode. STALE_EXIT and EMERGENCY are *expected*
infrastructure events that fire by design on predictable conditions. UNKNOWN
means the close path produced no recognized reason — that's a bug signal,
not an expected operational event. Same WHERE filter for validation queries,
different conceptual meaning.

**Future cleanup path** (deferred technical debt):

After migration validation stabilizes, the bounded cleanup is: make
`positionManager.exitReason` non-nullable, type the serialization map
exhaustively, then UNKNOWN can be removed from the type union entirely.
This is Option B from Decision 6's deliberation — correct as a long-term
state, not appropriate for this migration. Documenting it here prevents
UNKNOWN from becoming permanent technical debt dressed up as intentional
design.

**Pre-Section-5 verification** (gates Section 5 drafting):

Query the existing trade journal for UNKNOWN frequency. If 0%, the
"should never happen" canary framing holds and Section 5 sequences the
migration without UNKNOWN-related work. If non-zero, the current code
has a bug producing UNKNOWN values — Section 5 must add a "diagnose and
fix UNKNOWN source" commit before the taxonomy rename, because a rename
won't fix logic that's currently producing UNKNOWNs.

This verification must complete before Section 5 is drafted, because the
result changes Section 5's shape.

### Summary of Section 4 decisions

| # | Decision | Migration impact |
|---|----------|-----------------|
| 1 | Delete ExitEngine | One atomic commit, early in migration phase. Removes dead code surface. |
| 2 | Hybrid schema (positions + partial_closes) | Schema commit lands with or before per-tier emission (Gap 4). Shapes how positionManager writes records at close-time. |
| 3 | Single ExitMode union, documented categories | Comment block ships with the taxonomy type change. Validation queries filter via documented WHERE clause. |
| 4 | Drop RAPID_DUMP_EXIT and EARLY_STOP | Behavioral change with documented walkthrough. Validation data collection cannot start until both this change and RUG_TRIGGER emission are live. |
| 5 | Same-commit string literal updates for ml/replay | Pre-commit grep mandatory to confirm complete reference surface. Modules classified as dormant — fate deferred to when they become active. |
| 6 | Keep UNKNOWN as diagnostic sentinel | Documented as technical debt with bounded cleanup path. Pre-Section-5 verification: query journal for UNKNOWN frequency; non-zero changes Section 5 shape. |

### Inputs to Section 5

Section 5 (migration plan with commit sequencing) draws from these decisions
plus the gap analysis in Section 3. Before Section 5 is drafted, the
following pre-Section-5 verifications must complete:

1. **UNKNOWN frequency audit** (Decision 6). Query existing journal. Non-zero
   result adds a "fix UNKNOWN source" commit to Section 5's sequence.

2. **Validation-data boundary marker placement** (Decision 4). Section 5 must
   explicitly mark the phase boundary past which validation data collection
   is allowed. The marker requires RUG_TRIGGER emission and RAPID_DUMP/
   EARLY_STOP removal both shipped.

3. **Pre-commit checklists from Decisions 1, 2, and 5** are reference
   material for Section 5's commits. Section 5 doesn't re-execute the
   checklists; it sequences the commits that consume them.

Section 5 sequences the migration. Section 6 defines the success gate for
considering the migration complete enough to begin validation data
collection.