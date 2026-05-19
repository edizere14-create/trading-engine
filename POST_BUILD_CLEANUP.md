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

- **Token name resolution**: ✅ Completed Day 5. `TokenMetadataResolver` fetches names
  via Helius DAS `getAsset`, with 1h cache and 2s timeout. `GraduationHandler` pre-resolves
  before invoking the pipeline; Phase A `scammyName` gate now operates on real names.
  Factory (`createTokenMetadataResolver`) isolates helius-sdk CJS require() to one module.
- **NOT_ROUTABLE honeypot classification**: ✅ Completed Day 7/8. `checkHoneypotWithDeferredProbe`
  adds a T+5s re-probe path for 4xx responses only. 4xx at T0 = INDEX_LAG (uncertain);
  4xx at T+5s = NOT_ROUTABLE (resolved — past the bimodal slow-index tail). Other
  first-probe outcomes (timeout, 5xx, breaker-open, malformed) bypass re-probe.
  `fetchJupiterQuote` private helper discriminates 4xx from all other error paths via
  a `QuoteOutcome` union. `mapOutcome` unifies result mapping with a `noRouteAs`
  parameter — the only divergence between the two exported functions. `deferredProbeDelayMs`
  injectable for unit tests; soak test uses `jest.useFakeTimers()` + `advanceTimersByTimeAsync`.
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

## Process discipline notes (Day 7/8 retrospective)

Day 7 was a full design session (no code written). Day 8 implemented. Four lessons:

- **Probe window is the operational definition**: The key framing for NOT_ROUTABLE was
  "loose at T0, strict at T+5s." A 4xx response at T0 is INDEX_LAG (ambiguous — could be
  permanent or indexing-lagged). A 4xx at T+5s, after waiting past the bimodal slow-index
  tail (~2.7s), is NOT_ROUTABLE (resolved). The probe window itself resolves the ambiguity.
  This framing told us where NOT_ROUTABLE belongs in the classification tree: it's a
  resolved-by-time state, not a first-look state.

- **Black-box wrappers can't see sub-reason**: The original plan was `checkHoneypotWithDeferredProbe`
  calling `checkHoneypot` as a black box and re-probing on INDEX_LAG. This failed because
  `HoneypotResult` collapses four error paths (4xx, 5xx, timeout, breaker-open) into one
  classification. The wrapper couldn't distinguish "4xx INDEX_LAG" from "5xx INDEX_LAG."
  Fix: extract `fetchJupiterQuote` as a shared private helper returning a discriminated
  `QuoteOutcome` union. Both functions call the helper; the wrapper branches on `kind: 'no-route'`
  directly. General lesson: when a function collapses distinctions you later need, extract
  a finer-grained intermediate rather than wrapping the coarse one.

- **Checkpoint discipline and fatigue**: Day 7 ended with a stop call after the local test
  gate produced an environmental failure (Windows ts-jest preset resolution — the known
  issue from Day 4, documented here). Instead of stopping at the failure and reporting it,
  several more commands ran, a wrong diagnosis formed ("ts-jest v30 doesn't exist / pairing
  incompatible"), and permission was requested to npm install. The verifiable-fact error
  (ts-jest v30 does exist; the pairing has been green in CI all week) was caught before
  pushing. Pattern: fatigue produces confident wrong diagnoses. The stop call was correct;
  it should have come earlier.

- **Read the CI summary line before the stack trace**: Day 8 had two CI failures
  (CI #33, CI #34). The actual failing file was `tests/phaseB.test.ts` — visible in
  the CI summary as "FAIL tests/phaseB.test.ts." The root cause was that commit 86a8d9a
  changed phaseB.ts to call `checkHoneypotWithDeferredProbe` but the test file's
  `jest.mock` handle still referenced `checkHoneypot` (old name). Jest auto-mocked
  `checkHoneypotWithDeferredProbe` but returned `undefined` (no configured return value),
  causing `honeypotResult.passed` → `TypeError` in every phaseB test.
  Instead of reading the summary line, diagnostic work focused on resolver test stack
  traces in the failure screenshot — wasting one CI cycle on a timer-leak hypothesis
  (commit 7ed3f9e) that was genuine hygiene but not the root cause. Lesson: CI summary
  lists the failing file. Read that first, before any stack trace.

## Known future cleanup (from Day 7/8)

- **`advanceTimersByTime` → `advanceTimersByTimeAsync` in resolver test**: Line 52 of
  `tests/tokenMetadataResolver.test.ts` uses the synchronous version. Works today because
  the resolver's await sequence is shallow enough that one post-clock-advance microtask
  flush is sufficient. Fragile to internal changes. Upgrade in a future pass.

- **`checkHoneypot` dead export**: `src/safety/honeypot.ts` still exports `checkHoneypot`
  after the Day 7/8 refactor. Nothing in production calls it; its 14 tests exercise the
  shared private helpers (`fetchJupiterQuote`, `mapOutcome`) that `checkHoneypotWithDeferredProbe`
  also uses. Kept for coverage value. Remove in a future cleanup commit when the coverage
  is verified redundant.

- **Resolver afterEach is hygiene, not a root cause fix**: CI #33 and #34 failed because
  of the stale phaseB.test.ts mock (see above), not timer leaks. The `afterEach` added to
  `tokenMetadataResolver.test.ts` (commit 7ed3f9e) is real hygiene — the timeout test's
  cleanup was assertion-dependent — but it was not the cause of the CI failures.

## TypeScript moduleResolution migration (deferred)

The project uses `moduleResolution: "node"` (the default for `module: "commonjs"`).
This cannot read modern `package.json` exports maps. helius-sdk@2.2.2 uses an exports
map, so `import { createHelius } from 'helius-sdk'` fails with TS2307 under the current
config.

Workaround in place: `createTokenMetadataResolver` uses `require('helius-sdk')` with an
explicit cast, bypassing tsc's resolver. This is documented and isolated to one function.

The real fix is `moduleResolution: "bundler"`, which requires `module: "es2015"` or later
(TS5095 if you try to mix with `module: "commonjs"`). That's a project-wide emit change
affecting ts-node scripts, PM2 runtime, and ts-jest config. Sequence when ready:
  1. Switch `module` and `moduleResolution` together in tsconfig.json
  2. Add `.js` extensions to local relative imports (required by node16/nodenext)
  3. Verify ts-node, ts-jest, and PM2 runtime all handle ESM emit correctly
  4. Remove the `require()` workaround in tokenMetadataResolver.ts

Until then, keep helius-sdk contact in `tokenMetadataResolver.ts` only.

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

## Process discipline notes (Day 5 retrospective)

- **Empirical verification beats argued assumptions on TypeScript config**: Day 5 spent
  two CI runs (TS2307, TS5095) and significant time arguing about whether `moduleResolution:
  "bundler"` was compatible with `module: "commonjs"`. The answer was obtainable in 30
  seconds with `npm run typecheck` locally. When a config claim feels uncertain, probe it
  before designing around it. The probe that confirmed TS2307 on a value import took 60
  seconds and settled the factory-vs-direct-import debate definitively.
- **Local typecheck is available and fast — use it**: `npm run typecheck` runs `tsc --noEmit`
  directly and exits in ~3s. It doesn't require ts-jest (which was broken locally on Windows).
  Any design involving src/ type changes should be validated locally before pushing to CI.
  CI is not the first line of defence; it's the last.
- **PowerShell `git commit -m` breaks on `--` in message body**: git treats `--` as its
  argument separator, splitting the message into pathspecs. Use `-F <file>` with a temp file
  for long commit messages on Windows. The `@'...'@` here-string approach does not protect
  against this.
- **Don't carry stale CI state across screenshots**: Day 5 had a red CI screenshot followed
  by a green one for the same commit. The diagnostic work (phaseB.ts analysis) was based on
  the red screenshot after the green one had already arrived. Read each CI result fresh;
  don't carry the previous run's failure into the current analysis.
- **Structural type as SDK contract is correct pattern for narrow surfaces**: `HeliusClient`
  with only `getAsset` is more honest than importing the full SDK type. It documents exactly
  what we depend on, survives SDK major-version restructuring better, and sidesteps the
  moduleResolution issue entirely for the type surface. Apply this pattern to other narrow
  external SDK dependencies.