import path from 'path';
import {
  GateView,
  ModeSummary,
  gateView,
  isAutonomousOnly,
  overallSummary,
  restateTrades,
  summarizeByExitMode,
  writeRestated,
} from '../src/calibration/restate';

/**
 * Re-price the paper trades that were closed by a vault drain (RUG_TRIGGER), which were booked at the
 * last price seen before the drain, and write the result to a NEW file. Read-only on the trades file
 * and the journal.
 *
 *   npm run trades:restate -- --trades /var/data/paperTrades.json --journal /var/data/journal.db
 *   npm run trades:restate -- --trades ... --journal ... --write          (also writes the restated copy)
 *
 * The result is an estimate (see src/calibration/restate.ts). Nothing is written without --write.
 */

const USAGE = `Usage: trades:restate [options]

  --trades <path>    paper trades file (default data/paperTrades.json)
  --journal <path>   trade journal database (default data/journal.db)
  --out <path>       restated copy to write (default: paperTrades.restated.json next to the trades file)
  --write            write the restated copy (default is a report only)
  --details          list every restated trade`;

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let trades = 'data/paperTrades.json';
  let journal = 'data/journal.db';
  let out: string | undefined;
  let write = false;
  let details = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] ?? fail(`${arg} needs a value`);
    if (arg === '--trades') trades = next();
    else if (arg === '--journal') journal = next();
    else if (arg === '--out') out = next();
    else if (arg === '--write') write = true;
    else if (arg === '--details') details = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else fail(`unknown option ${arg}`);
  }
  out ??= path.join(path.dirname(path.resolve(trades)), 'paperTrades.restated.json');
  return { trades, journal, out, write, details };
}

const usd = (n: number) => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`;

function printModes(before: ModeSummary[], after: ModeSummary[]): void {
  const afterBy = new Map(after.map((m) => [m.exitMode, m]));
  console.log('\nBy exit type (before -> after)');
  console.log('exitMode        trades   avg multiple          total PnL');
  for (const b of before) {
    const a = afterBy.get(b.exitMode) ?? b;
    const changed = Math.abs(a.totalPnLUSD - b.totalPnLUSD) > 0.005;
    console.log(
      `${b.exitMode.padEnd(14)} ${String(b.trades).padStart(6)}   ` +
        `${b.avgMultiple.toFixed(3)} -> ${a.avgMultiple.toFixed(3)}`.padEnd(22) +
        (changed ? `${usd(b.totalPnLUSD)} -> ${usd(a.totalPnLUSD)}` : usd(b.totalPnLUSD))
    );
  }
}

function printGate(label: string, before: GateView, after: GateView): void {
  const f = (n: number | null, d = 3) => (n === null ? 'n/a' : n.toFixed(d));
  console.log(`\nPaper gate, ${label} (non-probe trades; before -> after)`);
  console.log(`  completed trades   ${before.completedTrades} -> ${after.completedTrades}`);
  console.log(`  win rate           ${(before.actualWinRate * 100).toFixed(1)}% -> ${(after.actualWinRate * 100).toFixed(1)}%`);
  console.log(`  EV per trade       ${f(before.actualEV)} -> ${f(after.actualEV)}`);
  console.log(`  AUC                ${f(before.wpAuc)} -> ${f(after.wpAuc)}`);
  console.log(`  calibration gap    ${f(before.wpCalibrationError)} -> ${f(after.wpCalibrationError)}`);
  console.log(`  gate unlocked      ${before.gateUnlocked} -> ${after.gateUnlocked}`);
}

async function main() {
  const { trades, journal, out, write, details } = parseArgs(process.argv.slice(2));
  const run = await restateTrades(trades, journal);

  console.log(`\nTrades: ${trades}   Journal: ${journal}`);
  console.log(`Records: ${run.original.length}`);
  console.log('RUG_TRIGGER trades:');
  const rug = run.counts.restated + run.counts['already-restated'] + run.counts['no-journal-row'] + run.counts['no-drain-pct'] + run.counts['no-prices'];
  console.log(`  total                    ${rug}`);
  console.log(`  restated                 ${run.counts.restated}`);
  const tierAware = run.details.filter((d) => d.basis === 'tier-aware').length;
  console.log(`    tier-aware             ${tierAware}`);
  console.log(`    unverified (repriced whole position)  ${run.details.length - tierAware}`);
  console.log(`  already restated         ${run.counts['already-restated']}`);
  console.log(`  not restated: no journal row ${run.counts['no-journal-row']}, no drain % ${run.counts['no-drain-pct']}, no prices ${run.counts['no-prices']}`);

  const overallBefore = overallSummary(run.original);
  const overallAfter = overallSummary(run.restated);
  printModes(summarizeByExitMode(run.original), summarizeByExitMode(run.restated));
  console.log('\nAll records (before -> after)');
  console.log(`  win rate      ${overallBefore.winRatePct.toFixed(1)}% -> ${overallAfter.winRatePct.toFixed(1)}%`);
  console.log(`  avg multiple  ${overallBefore.avgMultiple.toFixed(3)} -> ${overallAfter.avgMultiple.toFixed(3)}`);
  console.log(`  total PnL     ${usd(overallBefore.totalPnLUSD)} -> ${usd(overallAfter.totalPnLUSD)}`);

  printGate('all trades', await gateView(run.original), await gateView(run.restated));
  printGate(
    'autonomous (graduation) only',
    await gateView(run.original.filter(isAutonomousOnly)),
    await gateView(run.restated.filter(isAutonomousOnly))
  );

  if (details) {
    console.log('\nRestated trades');
    for (const d of run.details) {
      console.log(
        `  ${d.id.slice(0, 8)} ${d.tokenCA.slice(0, 6)} drain ${d.drainPct.toFixed(1)}%  ` +
          `${d.bookedMultiple.toFixed(3)} -> ${d.restatedMultiple.toFixed(3)}  ` +
          `${usd(d.bookedPnLUSD)} -> ${usd(d.restatedPnLUSD)}  [${d.basis}]`
      );
    }
  }

  console.log(
    '\nNote: restated results are an estimate (constant-product pool, one sale draining the vault, last price ' +
      'current). Take-profit tiers already sold are kept; "unverified" rows reprice the whole position.'
  );

  if (!write) {
    console.log('\nReport only: nothing written. Re-run with --write to save the restated copy.');
    return;
  }
  writeRestated(out, trades, run.restatedJson);
  console.log(`\nWrote ${out}. The original file and the journal were not modified.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
