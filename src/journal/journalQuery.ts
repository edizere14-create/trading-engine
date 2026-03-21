import { TradeJournal } from './tradeJournal';

if (require.main === module) {
  (async () => {
    const journal = new TradeJournal('./data/journal.db');
    await journal.waitReady();

    const all = journal.getAll();
    const wins = all.filter((t) => t.outcome === 'WIN');
    const losses = all.filter((t) => t.outcome === 'LOSS');
    const total = all.length;

    console.log('\n══════════════════════════════════════');
    console.log('  TRADE JOURNAL SUMMARY');
    console.log('══════════════════════════════════════');
    console.log(`Total trades:    ${total}`);
    console.log(`Wins:            ${wins.length}`);
    console.log(`Losses:          ${losses.length}`);
    console.log(
      `Win rate:        ${total > 0 ? ((wins.length / total) * 100).toFixed(1) : '0.0'}%`,
    );

    const avgWin =
      wins.reduce((s, t) => s + (t.realizedMultiple ?? 0), 0) / (wins.length || 1);
    const avgLoss =
      losses.reduce((s, t) => s + (t.realizedMultiple ?? 0), 0) / (losses.length || 1);
    console.log(`Avg win:         ${avgWin.toFixed(2)}x`);
    console.log(`Avg loss:        ${avgLoss.toFixed(2)}x`);
    console.log('══════════════════════════════════════\n');

    journal.close();
  })();
}

export { TradeJournal };
