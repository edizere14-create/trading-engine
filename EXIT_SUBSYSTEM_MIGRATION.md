
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