import { TradeJournal } from '../journal/tradeJournal';
import { FactorEngine } from './factorEngine';

const journal = new TradeJournal('./data/journal.db');
const engine = new FactorEngine(journal);

if (require.main === module) {
  console.log('\n══════════════════════════════════════════════');
  console.log('  FACTOR ANALYSIS REPORT');
  console.log(`  Based on ${journal.count()} trades`);
  console.log('══════════════════════════════════════════════');

  console.log('\n── SINGLE FACTORS ──');
  const single = engine.analyzeSingleFactors();
  for (const [name, pattern] of single) {
    const bar = '\u2588'.repeat(Math.round(pattern.winRate * 20));
    console.log(
      `${name.padEnd(25)} ${bar.padEnd(20)} ` +
      `WR:${(pattern.winRate * 100).toFixed(0)}% ` +
      `n:${pattern.sampleSize} ` +
      `EV:${pattern.expectedValue.toFixed(2)}x ` +
      `[${pattern.recommendation}]`,
    );
  }

  console.log('\n── FACTOR COMBINATIONS (Top 10) ──');
  const combos = engine.analyzeFactorCombinations().slice(0, 10);
  combos.forEach((p, i) => {
    console.log(`\n#${i + 1} ${JSON.stringify(p.conditions)}`);
    console.log(
      `   Win rate: ${(p.winRate * 100).toFixed(1)}% | ` +
      `n: ${p.sampleSize} | ` +
      `EV: ${p.expectedValue.toFixed(2)}x | ` +
      `${p.recommendation}`,
    );
  });

  console.log('\n══════════════════════════════════════════════\n');

  journal.close();
}
