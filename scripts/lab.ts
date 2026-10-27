// Local improvement lab: `npm run lab` (or `npm run lab -- AAPL QQQ`). Writes lab-report.json.
import { writeFileSync } from "node:fs";
import { normalizeSettings } from "../lib/engine/analyze";
import { CRYPTO_BENCHMARK, DEFAULT_WATCHLIST, ENGINE, EQUITY_BENCHMARK } from "../lib/engine/config";
import { affordability, analyseLab, cutoffFor, labBaseline, labSymbol, type LabSymbolResult } from "../lib/engine/lab";
import { assetClassForSymbol, getHistory } from "../lib/engine/market-data";

const DAYS = ENGINE.historyCalendarDays + 730;

async function main() {
  const symbols = process.argv.slice(2).length ? process.argv.slice(2).map((s) => s.toUpperCase()) : DEFAULT_WATCHLIST;
  const [spy, btc] = await Promise.all([getHistory(EQUITY_BENCHMARK, DAYS), getHistory(CRYPTO_BENCHMARK, DAYS)]);
  const results: LabSymbolResult[] = [];
  for (const symbol of symbols) {
    const t0 = Date.now();
    const ac = assetClassForSymbol(symbol);
    const h = await getHistory(symbol, DAYS);
    const r = labSymbol({ symbol, assetClass: ac, source: h.source, bars: h.bars, benchmarkBars: (ac === "CRYPTO" ? btc : spy).bars, settings: normalizeSettings({}) });
    results.push(r);
    console.log(`${symbol.padEnd(9)} ${String(r.days).padStart(4)} days ${String(r.trades.length).padStart(5)} variant-trades parity=${r.parityMismatches} ${r.skipped ?? ""} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  const lab = analyseLab(results);
  const cutoff = cutoffFor(results) ?? "";
  const start = results.map((r) => r.firstDate ?? "").filter(Boolean).sort()[0] ?? "";
  const baseline = spy.source !== "SIMULATED_FALLBACK" ? labBaseline(EQUITY_BENCHMARK, "EQUITY", spy.bars, start, cutoff) : null;
  const summary = { cutoff, best: lab.best, live: lab.live, verdict: lab.verdict, baseline, affordability: affordability(results.flatMap((r) => r.trades).filter((t) => t.v === lab.best.id)) };
  writeFileSync("lab-report.json", JSON.stringify({ summary, rows: lab.rows, results }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
