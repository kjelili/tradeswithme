// Loads long histories and builds the allocation + robustness report (V5.8). Cached per instance.
import { buildCurrencyReport, type CurrencyReport, type PublicResult } from "@/lib/engine/allocation-report";
import { alignSeries, CASH, ETF_TICKERS, STOCK_UNIVERSE, toGbp } from "@/lib/engine/allocation";
import { getHistory } from "@/lib/engine/market-data";

const DAYS = 3650 + 400; // ~10 years of decisions after a 12-month lookback
export type StrategyReport = {
  asOf: string; start: string; cutoff: string;
  /** USD results (decisions are always made on USD prices). */
  results: PublicResult[];
  usd: CurrencyReport;
  gbp: CurrencyReport | null;
  warnings: string[];
  generatedAt: string;
};

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

/** Daily USD-per-GBP from the ECB reference rates (Frankfurter), fetched a year at a time. */
async function loadUsdPerGbp(fromYear: number, warnings: string[]) {
  const out: Array<{ date: string; rate: number }> = [];
  const thisYear = new Date().getUTCFullYear();
  for (let y = fromYear; y <= thisYear; y += 1) {
    const url = `https://api.frankfurter.dev/v1/${y}-01-01..${y === thisYear ? "" : `${y}-12-31`}?symbols=USD,GBP`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, { signal: controller.signal, cache: "no-store", headers: { "User-Agent": "TradesWithMe/5.8" } }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json() as { rates?: Record<string, { USD?: number; GBP?: number }> };
      for (const [date, r] of Object.entries(json.rates ?? {})) if (r.USD && r.GBP) out.push({ date, rate: r.USD / r.GBP });
    } catch (e) {
      warnings.push(`GBP/USD history for ${y} unavailable (${e instanceof Error ? e.message : "error"}) — GBP view may be incomplete.`);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export async function loadStrategyReport(force = false): Promise<StrategyReport> {
  if (!force && cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.value;
  const warnings: string[] = [];
  const etfRaw = await load(ETF_TICKERS, warnings);
  if (!etfRaw.SPY || !etfRaw[CASH]) throw new Error("S&P 500 or cash proxy history unavailable; strategies refused rather than guessed.");
  const stockRaw = await load([...STOCK_UNIVERSE], warnings);
  const etf = alignSeries(etfRaw);
  const stocks = Object.keys(stockRaw).length >= 8 ? alignSeries({ ...stockRaw, SPY: etfRaw.SPY, [CASH]: etfRaw[CASH] }) : null;
  const usd = buildCurrencyReport("USD", etf, stocks);
  if (!usd) throw new Error("Not enough aligned history to evaluate strategies.");

  let gbp: CurrencyReport | null = null;
  const fx = await loadUsdPerGbp(Number(etf.dates[0]?.slice(0, 4) ?? "2016"), warnings);
  if (fx.length > 200) {
    const etfG = toGbp(etf, fx);
    const stocksG = stocks ? toGbp(stocks, fx) : null;
    gbp = etfG ? buildCurrencyReport("GBP", etf, stocks, { pricing: { etf: etfG, stocks: stocksG } }) : null;
    if (fx[0].date > etf.dates[0]) warnings.push(`GBP view: exchange rates start ${fx[0].date}; earlier days use that first rate.`);
  } else {
    warnings.push("GBP view unavailable: exchange-rate history could not be loaded.");
  }

  const value: StrategyReport = { asOf: usd.asOf, start: usd.start, cutoff: usd.cutoff, results: usd.results, usd, gbp, warnings, generatedAt: new Date().toISOString() };
  cached = { at: Date.now(), value };
  return value;
}
