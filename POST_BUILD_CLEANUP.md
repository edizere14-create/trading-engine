# Post-Build Cleanup

Tasks deferred until after v2 ships. Do not touch until the strategy is live and stable.

## hybridPowerPlay cleanup

`HybridPowerPlay` is imported and instantiated in `index.ts` but the class itself may have
dead weight accumulated from the v1 era. Once v2 is confirmed profitable in live trading,
audit and trim the class: remove unused methods, simplify the entry-price anchor logic if
superseded by sniper-v2 entry flow, and evaluate whether the module can be collapsed into
`executionEngine`.

Specific to graduation flow (added Day 4): HPP still has its own `pool:graduated`
subscription, now duplicated by `GraduationHandler`. Target disposition (HPP-B): keep
HPP's migration cooldown suppression role (`shouldSuppressSignal()` is called from
`bus.on('trade:signal')` at index.ts:1075), remove its duplicate subscription. Suppression
still applies to graduation-derived signals because they flow through the same
`trade:signal` event.

## CI hardening

`npm test` runs jest but does not run `tsc --noEmit`. Strict TypeScript in `tsconfig.json`
is therefore documentation, not enforcement. This has bitten twice:

- Day 3 Block 4: Phase B trace type missing `locked` / `revoked` fields, shipped green,
  fixed in `f8a8ddd`.
- Day 4 commit 3: `graduationHandler!.start()` referenced an undeclared variable. Caught
  manually via `git diff` review before push, but would have shipped green if pushed as-is.

Add a `tsc --noEmit` step to `.github/workflows/ci.yml` before the jest step. Cheap,
fast, catches the entire class of type-contract bugs that test-only CI misses.

## Day 5+ work (functional gaps in graduation flow)

`runSafetyPipeline` is wired but several gates are stubbed or inert:

- **Token name resolution**: `GraduationHandler.handle()` currently passes `undefined`
  for `tokenName` to `runSafetyPipeline`. Phase A's `scammyName` check therefore
  short-circuits to passing for every graduation. Need a name resolver (Helius metadata
  fetch on the mint, or Jupiter token list lookup) before the check is meaningful.
- **NOT_ROUTABLE honeypot classification**: The honeypot module classifies fast-fail
  Jupiter errors as `INDEX_LAG` and high-price-impact responses as `UNCONFIRMED`, but
  the T+5s re-probe path that distinguishes genuinely-unroutable tokens from
  indexing-lagged ones is not yet implemented. Currently borderline tokens get the
  pessimistic `UNCONFIRMED` label.
- **Real-RPC soak**: Day 4 soak harness mocks `axios` and `TokenSafetyChecker.check`.
  Useful for pipeline correctness, not for catching real Jupiter / Helius behaviors.
  Next step is a manual run against testnet or recorded devnet graduation events with
  real RPC.

## Day 5+ work (exit-side capability gaps)

Position sizing and exit logic are immature for graduation-sourced trades:

- **Rug-trigger exit monitoring**: No detector for pool wSOL vault dropping >40% in a
  short window. This is the canonical "deployer pulled liquidity" signal and should
  trigger immediate exit on open positions.
- **TP ladder / trailing stop**: `positionManager` currently exits on stop-loss, max-hold,
  or emergency only. No partial take-profit at multiples (e.g., sell 25% at 2x, 25% at
  3x, trail the rest). Strategy doc specifies the ladder; implementation is pending.

## Process discipline notes (Day 4 retrospective)

These are not code tasks but learnings to apply in every future commit session:

- **Working tree hygiene at session start**: Run `git status` before opening files in
  VS Code. If anything is already modified, decide explicitly: commit it, stash it,
  or revert it. Day 4 commit 3 bundled two Copilot-drift edits to `src/index.ts`
  (live Telegram message + trade ticker) because the file was already dirty when we
  started staging — neither was in the planned scope, both shipped before being noticed.
  Reverted in `eab9fd8`. Cost: one extra commit, lost trust in the staged diff.
- **Diff scope verification before staging**: `git diff --stat` line counts must match
  expected scope. If a planned 5-line edit shows 12 insertions / 4 deletions, stop and
  read the full diff before staging. Day 4 commit 3 showed `12 insertions(+), 4 deletions(-)`
  for what should have been ~7 lines of GraduationHandler integration — the extra 5 lines
  were Copilot drift.
- **Close files in VS Code when not actively editing**: Copilot autocomplete inserted
  drift into both `src/index.ts` and `tests/honeypot.test.ts` while the files sat open
  during Day 4. Files open = drift surface. Especially for files unrelated to the
  current task.