// Turns raw strategy runs into a robustness report (V5.8). Pure.
import { CASH, ROT, rotation, runAll, runStrategy, type AlignedSeries, type StrategyResult } from "./allocation";
import { calendarYears, deflatedSharpe, pairedBootstrap, psr, sharpe } from "./robustness";

export type Robustness = {
  yearsBeatSpyPct: number;
  years: Array<{ year: string; pct: number; spyPct: number }>;
  psrVsSpy: number;
  dsr: number;
  bootstrap: ReturnType<typeof pairedBootstrap>;
};
export type PublicResult = Omit<StrategyResult, "daily" | "dates" | "startIndex"> & { robustness: Robustness | null };
export type GridCell = { lookbackMonths: number; topN: number; cagrPct: number; sharpe: number; maxDrawdownPct: number; testCagrPct: number };
export type CurrencyReport = { currency: "USD" | "GBP"; asOf: string; start: string; cutoff: string; results: PublicResult[]; grid: GridCell[]; plateauPct: number; trials: number };

const LOOKBACKS = [3, 6, 9, 12];
const TOPS = [1, 2, 3];

/**
 * `etf`/`stocks` are the USD decision series. `pricing` (optional) holds the same dates priced in
 * another currency: decisions stay on USD prices, returns are earned in that currency.
 */
export function buildCurrencyReport(currency: "USD" | "GBP", etf: AlignedSeries, stocks: AlignedSeries | null, opts: { bootstrapPaths?: number; pricing?: { etf: AlignedSeries; stocks?: AlignedSeries | null } } = {}): CurrencyReport | null {
  const { results, cutoff, start } = runAll(etf, stocks, 730, opts.pricing);
  if (!results.length) return null;
  const spy = results.find((r) => r.id === "hold_spy");
  // Parameter grid for the rotation family: is the chosen setting on a plateau or a lucky peak?
  const startIdx = results[0].startIndex ?? 0;
  const grid: GridCell[] = [];
  const gridRuns: StrategyResult[] = [];
  for (const L of LOOKBACKS) for (const T of TOPS) {
    const r = runStrategy({ id: `rot_${T}_${L}`, name: "", schedule: "monthly", tickers: [...ROT, CASH], description: "", decide: rotation(ROT, L, T) }, etf, startIdx, cutoff, 0, opts.pricing?.etf ?? etf);
    if (!r) continue;
    gridRuns.push(r);
    grid.push({ lookbackMonths: L, topN: T, cagrPct: r.full.cagrPct, sharpe: r.full.sharpe, maxDrawdownPct: r.full.maxDrawdownPct, testCagrPct: r.test.cagrPct });
  }
  const best = Math.max(...grid.map((g) => g.sharpe));
  const plateauPct = grid.length ? Math.round(grid.filter((g) => g.sharpe >= best * 0.8).length / grid.length * 100) : 0;

  // Every configuration we evaluated counts as a "trial" for the Deflated Sharpe Ratio.
  const slice = (r: StrategyResult) => (r.daily ?? []).slice((r.startIndex ?? 0) + 1);
  const trialSr = [...results, ...gridRuns].map((r) => sharpe(slice(r)));
  const spyDaily = spy ? slice(spy) : [];
  const spySr = sharpe(spyDaily);

  const pub: PublicResult[] = results.map((r) => {
    const d = slice(r);
    let robustness: Robustness | null = null;
    if (spy && r.dates && d.length === spyDaily.length) {
      const from = (r.startIndex ?? 0) + 1, to = r.dates.length - 1;
      const ys = calendarYears(r.dates, r.daily!, from, to);
      const sy = calendarYears(spy.dates!, spy.daily!, from, to);
      const years = ys.map((y, i) => ({ ...y, spyPct: sy[i]?.pct ?? 0 }));
      const full = years.slice(1, -1); // ignore partial first/last years
      robustness = {
        years,
        yearsBeatSpyPct: full.length ? Math.round(full.filter((y) => y.pct > y.spyPct).length / full.length * 100) : 0,
        psrVsSpy: Math.round(psr(d, spySr) * 1000) / 1000,
        dsr: Math.round(deflatedSharpe(d, trialSr).dsr * 1000) / 1000,
        bootstrap: r.id === "hold_spy" ? null : pairedBootstrap(d, spyDaily, { paths: opts.bootstrapPaths ?? 1000 }),
      };
    }
    const { daily, dates, startIndex, ...rest } = r;
    void daily; void dates; void startIndex;
    return { ...rest, robustness };
  });
  return { currency, asOf: etf.dates.at(-1) ?? "", start, cutoff, results: pub, grid, plateauPct, trials: trialSr.length };
}
