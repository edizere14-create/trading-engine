# Post-Build Cleanup

Tasks deferred until after v2 ships. Do not touch until the strategy is live and stable.

## hybridPowerPlay cleanup

`HybridPowerPlay` is imported and instantiated in `index.ts` but the class itself may have
dead weight accumulated from the v1 era. Once v2 is confirmed profitable in live trading,
audit and trim the class: remove unused methods, simplify the entry-price anchor logic if
superseded by sniper-v2 entry flow, and evaluate whether the module can be collapsed into
`executionEngine`.

~~Specific to graduation flow (added Day 4): HPP still has its own `pool:graduated`
subscription, now duplicated by `GraduationHandler`.~~ Resolved Day 11 by verification:
HPP does NOT subscribe to `pool:graduated`. Grep across `src/` confirms only
`graduationHandler.ts` subscribes, `migrationAccountStream.ts` emits, `eventBus.ts`
declares the type, and `index.ts` references it in a comment. HPP's only bus subscriptions
are `pool:created` and `swap:detected` (see `src/execution/hybridPowerPlay.ts:128,131`).
The Day 4 note was based on an unverified assumption, not a grep of the code. HPP's
migration cooldown suppression role (`shouldSuppressSignal()` called from
`bus.on('trade:signal')` in `index.ts`) is unchanged and still correct — suppression
applies to graduation-derived signals because they flow through the same `trade:signal`
event after `GraduationHandler` processes them.

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
- **Real-RPC soak**: ✅ Completed Day 6. `scripts/realRpcSoak.ts` validates the resolver
  against live Helius DAS for fixture mints, complementing the mock-based jest suite.
  Three fixture categories (`scripts/realRpcSoak.fixtures.json`): stable mints with
  metadata (hard-assert non-empty string + cache hit < 5ms), mints with any metadata
  (hard-assert string), mints without metadata (hard-assert null). Default fixture
  (USDC, BONK) runs without operator setup; operator extends fixtures for categories 2
  and 3. Hermetic CI is preserved — script is manual-only, run via `npm run soak:rpc`
  before structural changes to the resolver or SDK integration. Initial validation:
  USDC 465ms / cache 0.04ms, BONK 79ms / cache 0.01ms, structural type confirmed
  against real `getAsset` response shape.

## Day 5+ work (exit-side capability gaps)

Position sizing and exit logic are immature for graduation-sourced trades:

- **Rug-trigger exit monitoring**: No detector for pool wSOL vault dropping >40% in a
  short window. This is the canonical "deployer pulled liquidity" signal and should
  trigger immediate exit on open positions.
- **TP ladder / trailing stop**: `positionManager` currently exits on stop-loss, max-hold,
  or emergency only. No partial take-profit at multiples (e.g., sell 25% at 2x, 25% at
  3x, trail the rest). Strategy doc specifies the ladder; implementation is pending.

## Process discipline notes (Day 7/8 retrospective)

Day 7 was a full design session (no code written). Day 8 implemented. Five lessons:

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

- **Riskiest test in its own commit**: Day 8 commit 2 (`86a8d9a`) bundled the phaseB.ts
  wiring (1-line import + 1-line call change — low-risk rename) with the new fake-timer
  soak test (highest-risk new code in the work). When CI #33 failed, the commit alone
  couldn't tell us whether the wiring or the soak test broke things. We had to read the
  CI summary and grep test files to localize. If commit 2 had been split into "phaseB.ts
  rename" + "soak test addition," the wiring would have landed green and the soak test's
  failure would have been isolated, revertable on its own. Sequencing principle: when a
  multi-file commit mixes low-risk and high-risk pieces, split them. The high-risk piece
  gets its own commit so revert/diagnostic surface stays narrow.

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

## Process discipline notes (Day 6 retrospective)

Day 6 was a short, focused session: design, build, validate, ship — one commit
(`e7d3f90`). The real-RPC soak script landed clean. Four lessons captured for
future reference:

- **Don't load full app config for scripts that use one field**: First instinct
  was to call `config.load()` in the soak script to get `HELIUS_API_KEY`.
  Reading `config.ts` revealed `config.load()` validates `PRIMARY_RPC`,
  `BACKUP_RPC`, `INITIAL_CAPITAL_USD` and instantiates three unused Solana
  Connection objects. A soak script that fails with `PRIMARY_RPC must be a
  valid URL` before touching the resolver is a bad operator experience.
  Correct call: read `process.env.HELIUS_API_KEY` directly with an explicit
  truthy guard. Lesson: when a script needs one config field, read that
  field — don't drag the whole validation surface in.

- **Hybrid assertion strategy beats pure hard or pure observational**: The
  initial design considered "hard-assert exact value (e.g., USDC name ===
  'USD Coin')" vs "log everything, human inspects." Both have failure modes:
  hard-asserting an upstream-controlled string is brittle to non-bug changes
  (Helius could surface "USDC" instead of "USD Coin" and the test would
  fail on a non-regression); pure observational requires human attention
  every run. Final design: hard-assert the contract that matters (`typeof name
  === 'string' && name.length > 0`), observationally print the actual value
  for human review. Hard assertions catch real regressions; observational
  output catches subtle issues humans notice but contracts don't express.

- **Cache hit threshold needs a binary signal, not precise latency**: The
  Day 6 design discussed whether 5ms was the right cache-hit threshold.
  The right framing: the assertion is testing whether the cache was hit at
  all, not measuring how fast it is. Network call is ~150ms-500ms (Helius
  p50). Map.get() is microseconds. Anything < 5ms is definitely a cache
  hit; anything >50ms is definitely a miss; the gap between is empty in
  practice. The threshold isn't an SLO, it's a discriminator. 5ms shipped
  and ran at 0.01-0.04ms — plenty of headroom.

- **Manual-only scripts are the right pattern for live-RPC validation**:
  Three options were considered for soak placement — CI step (continuous
  validation), manual script (developer-run), scheduled job (cron-style).
  CI was wrong because it requires `HELIUS_API_KEY` as a CI secret, costs
  Helius quota per push, and makes CI flake on provider outages — none
  acceptable trade-offs for a test gate. Scheduled job adds infrastructure
  without proportional value at this stage. Manual script wins: CI stays
  hermetic (only mocks), the script becomes the pre-change gate operators
  invoke before pushing changes to the resolver or SDK integration.
  Portable principle: hermetic CI + manual live-RPC scripts is the right
  pattern for validating SDK integrations. The script is the discipline
  gate, not the automation gate.
  ## Process discipline notes (Day 11 retrospective)

Day 11 was planned as HPP-B feature work. First diagnostic (grep for `pool:graduated`
in HPP) returned empty. Second diagnostic (broader grep across `src/`) confirmed HPP
has never subscribed to `pool:graduated`. The HPP-B task didn't exist — POST_BUILD_CLEANUP
had carried a phantom todo for a week, based on an unverified assumption in the Day 4
note.

One lesson:

- **Retrospective entries are claims that need verification before becoming tasks**:
  POST_BUILD_CLEANUP.md is a working doc, not a verified record. Entries get added
  during retrospectives based on the writer's mental model at the time, which can be
  wrong. Before acting on any cleanup item, verify the claim against the current
  codebase with a primary-source check (grep, file inspection). The Day 11 verification
  was a 30-second grep that we could have run any time in the previous week to discover
  the HPP-B item didn't exist. The check should have been the first step of HPP-B, not
  the third.

  General pattern: doc claims about code state are stale by default. Re-verify before
  acting. This is the same lesson as "read CI summary before stack trace" (Day 8) and
  "don't load full app config when one field will do" (Day 6) — primary source over
  mental model, every time.