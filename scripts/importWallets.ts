import fs from 'fs';
import path from 'path';
import { WalletRegistry } from '../src/registry/walletRegistry';
import {
  DEFAULT_IMPORT_OPTIONS,
  ImportMode,
  ImportOptions,
  buildEntries,
  planImport,
  writeWalletsFile,
} from '../src/registry/walletImport';

/**
 * Import a CSV of wallets into the registry.
 *
 *   npm run wallets:import -- leaderboard.csv --mode replace            (dry run)
 *   npm run wallets:import -- leaderboard.csv --mode replace --write    (writes data/wallets.json)
 *
 * CSV columns (header names are matched loosely): address, pnl30d, trade_count (required);
 * win_rate, tier, last_active (optional). Nothing is written unless --write is given.
 */

const USAGE = `Usage: wallets:import <file.csv> --mode replace|merge [options]

  --mode replace|merge   required. replace = the CSV becomes the whole registry; merge = add/update, remove nothing
  --write                actually write the file (default is a dry run that only prints the report)
  --out <path>           registry file (default data/wallets.json)
  --pnl-multiplier <n>   multiply the CSV's PnL to get USD (default 1)
  --min-trades <n>       skip wallets with fewer trades (default ${DEFAULT_IMPORT_OPTIONS.minTrades})
  --max-trades <n>       skip wallets with more trades, as bot-like (default: no limit)
  --max <n>              keep at most n wallets, best PnL first (default ${DEFAULT_IMPORT_OPTIONS.max})
  --exclude a,b,c        addresses to leave out (with merge, also removes them from the registry)`;

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function numberFlag(name: string, raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || Number.isFinite(n) === false) fail(`${name} needs a number`);
  return n;
}

function parseArgs(argv: string[]) {
  const options: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS, exclude: new Set<string>(), now: new Date() };
  let file: string | undefined;
  let mode: ImportMode | undefined;
  let write = false;
  let out = 'data/wallets.json';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--mode': {
        const m = next();
        if (m !== 'replace' && m !== 'merge') fail('--mode must be replace or merge');
        mode = m;
        break;
      }
      case '--write':
        write = true;
        break;
      case '--out':
        out = next() ?? fail('--out needs a path');
        break;
      case '--pnl-multiplier':
        options.pnlMultiplier = numberFlag(arg, next());
        break;
      case '--min-trades':
        options.minTrades = numberFlag(arg, next());
        break;
      case '--max-trades':
        options.maxTrades = numberFlag(arg, next());
        break;
      case '--max':
        options.max = numberFlag(arg, next());
        break;
      case '--exclude':
        for (const a of (next() ?? '').split(',')) if (a.trim() !== '') options.exclude.add(a.trim());
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
      // falls through (exit above)
      default:
        if (arg.startsWith('--')) fail(`unknown option ${arg}`);
        if (file !== undefined) fail('only one CSV file can be given');
        file = arg;
    }
  }

  if (file === undefined) fail('missing the CSV file');
  if (mode === undefined) fail('--mode is required (replace or merge): there is no default on purpose');
  return { file, mode, write, out, options };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function main() {
  const { file, mode, write, out, options } = parseArgs(process.argv.slice(2));

  if (fs.existsSync(file) === false) fail(`file not found: ${file}`);
  const result = buildEntries(fs.readFileSync(file, 'utf-8'), options);

  const existing = fs.existsSync(path.resolve(out)) ? (await WalletRegistry.load(out)).getAll() : [];
  const plan = planImport(existing, result.entries, mode, options.exclude);

  const tiers = { S: 0, A: 0, B: 0 };
  for (const w of plan.final) tiers[w.tier]++;

  console.log(`\nSource: ${file}   Target: ${out}   Mode: ${mode}`);
  console.log(`Accepted ${result.entries.length} wallet(s); skipped ${result.skipped.length} row(s)`);
  console.log(`Registry after import: ${plan.final.length} wallet(s)  (S ${tiers.S} / A ${tiers.A} / B ${tiers.B})`);
  console.log(
    `Versus current ${existing.length}: +${plan.added.length} added, ${plan.updated.length} updated, ` +
      `${plan.unchanged.length} untouched, -${plan.removed.length} removed`
  );

  if (result.skipped.length > 0) {
    console.log('\nSkipped:');
    for (const s of result.skipped.slice(0, 30)) {
      console.log(`  ${s.line > 0 ? `line ${s.line}` : 'cap'}: ${s.address === '' ? '(blank)' : short(s.address)} — ${s.reason}`);
    }
    if (result.skipped.length > 30) console.log(`  … and ${result.skipped.length - 30} more`);
  }
  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of result.warnings.slice(0, 30)) console.log(`  ${w}`);
  }

  if (plan.final.length === 0) fail('nothing to import: the registry would be empty, so nothing was written');

  if (write === false) {
    console.log('\nDry run: nothing written. Re-run with --write to apply.');
    return;
  }

  const written = await writeWalletsFile(plan.final, out, options.now);
  console.log(`\nWrote ${written.count} wallet(s) to ${out}`);
  if (written.backupPath !== null) console.log(`Previous file kept at ${written.backupPath}`);
  console.log('Restart the service so the new registry is loaded.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
