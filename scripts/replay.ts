// Local historical replay: `npm run replay` (or `npm run replay -- BTC-USD SPY`).
// Uses the same data feeds and decision code as production. Writes replay-report.json.
import { writeFileSync } from "node:fs";
import { normalizeSettings } from "../lib/engine/analyze";
import { CRYPTO_BENCHMARK, DEFAULT_WATCHLIST, ENGINE, EQUITY_BENCHMARK } from "../lib/engine/config";
import { assetClassForSymbol, getHistory } from "../lib/engine/market-data";
import { LEDGER_COSTS, replaySymbol, simulatePortfolio, statsFor, verdictFor, type ReplaySymbolResult } from "../lib/engine/replay";

const DAYS = ENGINE.historyCalendarDays + 730;

async function main() {
  const symbols = process.argv.slice(2).length ? process.argv.slice(2).map((s) => s.toUpperCase()) : DEFAULT_WATCHLIST;
  const [eqBench, crBench] = await Promise.all([getHistory(EQUITY_BENCHMARK, DAYS), getHistory(CRYPTO_BENCHMARK, DAYS)]);
  const results: ReplaySymbolResult[] = [];
  for (const symbol of symbols) {
    const t0 = Date.now();
    const assetClass = assetClassForSymbol(symbol);
    const bench = assetClass === "CRYPTO" ? crBench : eqBench;
    const history = await getHistory(symbol, DAYS);
    const r = replaySymbol({ symbol, assetClass, source: history.source, bars: history.bars, benchmarkBars: bench.bars, settings: normalizeSettings({}) });
    results.push(r);
    console.log(`${symbol.padEnd(9)} ${String(r.decisionsEvaluated).padStart(4)} days  ${String(r.signals).padStart(3)} signals  ${String(r.trades.length).padStart(3)} trades  max score ${r.maxDecisionScore.toFixed(2)}  ${r.skipped ?? ""} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  const trades = results.flatMap((r) => r.trades);
  const realistic = statsFor(trades);
  const ledgerCost = statsFor(trades.map((t) => ({ ...t, netPct: t.grossPct - (t.assetClass === "CRYPTO" ? LEDGER_COSTS.cryptoRoundTripBps : LEDGER_COSTS.equityRoundTripBps) / 100 })));
  const summary = {
    generatedAt: new Date().toISOString(),
    realistic, ledgerCost,
    equities: statsFor(trades.filter((t) => t.assetClass === "EQUITY")),
    crypto: statsFor(trades.filter((t) => t.assetClass === "CRYPTO")),
    ledgerRule: statsFor(results.flatMap((r) => r.ledgerTrades)),
    portfolio: (({ curve, ...rest }) => rest)(simulatePortfolio(trades)),
    verdict: verdictFor(realistic),
  };
  writeFileSync("replay-report.json", JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
