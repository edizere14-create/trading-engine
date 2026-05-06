# Post-Build Cleanup

Tasks deferred until after v2 ships. Do not touch until the strategy is live and stable.

## hybridPowerPlay cleanup

`HybridPowerPlay` is imported and instantiated in `index.ts` but the class itself may have
dead weight accumulated from the v1 era. Once v2 is confirmed profitable in live trading,
audit and trim the class: remove unused methods, simplify the entry-price anchor logic if
superseded by sniper-v2 entry flow, and evaluate whether the module can be collapsed into
`executionEngine`.
