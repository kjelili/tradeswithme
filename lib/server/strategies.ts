// Loads long histories and runs the allocation strategies (V5.7). Cached per instance.
import { alignSeries, CASH, ETF_TICKERS, runAll, STOCK_UNIVERSE, type StrategyResult } from "@/lib/engine/allocation";
import { getHistory } from "@/lib/engine/market-data";

const DAYS = 3650 + 400; // ~10 years of decisions after a 12-month lookback
export type StrategyReport = { asOf: string; start: string; cutoff: string; results: StrategyResult[]; warnings: string[]; generatedAt: string };

let cached: { at: number; value: StrategyReport } | null = null;

async function load(tickers: string[], warnings: string[]) {
  const out: Record<string, Array<{ date: string; close: number }>> = {};
  const histories = await Promise.all(tickers.map(async (t) => [t, await getHistory(t, DAYS)] as const));
  for (const [t, h] of histories) {
    if (h.source === "SIMULATED_FALLBACK" || h.bars.length < 600) { warnings.push(`${t}: no verified long history (${h.source}, ${h.bars.length} bars) — excluded.`); continue; }
    out[t] = h.bars.map((b) => ({ date: b.date, close: b.close }));
  }
  return out;
}

export async function loadStrategyReport(force = false): Promise<StrategyReport> {
  if (!force && cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.value;
  const warnings: string[] = [];
  const etfRaw = await load(ETF_TICKERS, warnings);
  if (!etfRaw.SPY || !etfRaw[CASH]) throw new Error("S&P 500 or cash proxy history unavailable; strategies refused rather than guessed.");
  const stockRaw = await load([...STOCK_UNIVERSE], warnings);
  const etf = alignSeries(etfRaw);
  const stocks = Object.keys(stockRaw).length >= 8 ? alignSeries({ ...stockRaw, SPY: etfRaw.SPY, [CASH]: etfRaw[CASH] }) : null;
  const { results, cutoff, start } = runAll(etf, stocks);
  const value: StrategyReport = { asOf: etf.dates.at(-1) ?? "", start, cutoff, results, warnings, generatedAt: new Date().toISOString() };
  cached = { at: Date.now(), value };
  return value;
}
