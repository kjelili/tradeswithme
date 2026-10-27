// Simple, rules-based allocation strategies (V5.7) — the kind of "money while you sleep"
// approach that a single investor can run monthly inside a Stocks & Shares ISA.
// Pure and look-ahead-free: a decision made at the close of day k only earns returns
// from day k+1. Results are in USD on US-listed proxies; UCITS equivalents are mapped
// for implementation (GBP investors also carry currency moves).

export type AlignedSeries = { dates: string[]; close: Record<string, number[]> };
export type Weights = Record<string, number>;
export type Schedule = "daily" | "monthly";

export type StrategyDef = {
  id: string;
  name: string;
  schedule: Schedule;
  tickers: string[];
  description: string;
  caveat?: string;
  /** Weights decided with data up to and including index k. Missing weight goes to cash. */
  decide: (k: number, s: AlignedSeries) => Weights | null;
};

export const CASH = "BIL";
export const COST_BPS_PER_SIDE = 5; // ETF spread + commission, per unit of turnover

/** Example UK-available (UCITS, LSE-listed) equivalents for implementation in an ISA. */
export const UCITS_EQUIVALENT: Record<string, string> = {
  SPY: "S&P 500 tracker — e.g. CSPX or VUSA",
  QQQ: "Nasdaq-100 tracker — e.g. EQQQ or CNDX",
  EEM: "Emerging markets tracker — e.g. EIMI",
  GLD: "Physical gold — e.g. SGLN",
  TLT: "Long US Treasuries — e.g. IDTL",
  BIL: "Cash / short Treasuries — e.g. IB01 or a money-market fund",
};

function ret(s: AlignedSeries, t: string, k: number, lookback: number, skip = 0) {
  const c = s.close[t];
  const a = k - skip, b = k - lookback;
  if (!c || b < 0 || a < 0 || !(c[b] > 0)) return null;
  return c[a] / c[b] - 1;
}

function sma(s: AlignedSeries, t: string, k: number, n: number) {
  const c = s.close[t];
  if (!c || k + 1 < n) return null;
  let sum = 0;
  for (let i = k - n + 1; i <= k; i += 1) sum += c[i];
  return sum / n;
}

const M = 21; // trading days per month

function trend200(k: number, s: AlignedSeries): Weights | null {
  const m = sma(s, "SPY", k, 200);
  if (m == null) return null;
  return s.close.SPY[k] > m ? { SPY: 1 } : { [CASH]: 1 };
}

function rotation(universe: string[], lookbackMonths: number, topN: number) {
  return (k: number, s: AlignedSeries): Weights | null => {
    const cash = ret(s, CASH, k, lookbackMonths * M);
    const ranked = universe.map((t) => ({ t, r: ret(s, t, k, lookbackMonths * M) }));
    if (cash == null || ranked.some((x) => x.r == null)) return null;
    const picks = ranked.sort((a, b) => (b.r as number) - (a.r as number)).slice(0, topN).filter((x) => (x.r as number) > cash);
    const w: Weights = {};
    for (const p of picks) w[p.t] = 1 / topN;
    const used = picks.length / topN;
    if (used < 1) w[CASH] = (w[CASH] ?? 0) + (1 - used);
    return w;
  };
}

function dualMomentum(defensive: string) {
  return (k: number, s: AlignedSeries): Weights | null => {
    const spy = ret(s, "SPY", k, 12 * M), eem = ret(s, "EEM", k, 12 * M), cash = ret(s, CASH, k, 12 * M);
    if (spy == null || eem == null || cash == null) return null;
    if (spy <= cash) return { [defensive]: 1 };
    return spy >= eem ? { SPY: 1 } : { EEM: 1 };
  };
}

// PLTR is excluded: it only listed in 2020 and would shorten the shared test window.
export const STOCK_UNIVERSE = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "AVGO", "NFLX", "JPM", "BAC", "XOM"];

function stockMomentum(topN: number) {
  return (k: number, s: AlignedSeries): Weights | null => {
    const trend = trend200(k, s);
    if (!trend) return null;
    if (!trend.SPY) return { [CASH]: 1 };
    const avail = STOCK_UNIVERSE.filter((t) => s.close[t]);
    const ranked = avail.map((t) => ({ t, r: ret(s, t, k, 12 * M, M) })).filter((x) => x.r != null) as Array<{ t: string; r: number }>;
    if (ranked.length < topN) return null;
    const w: Weights = {};
    for (const p of ranked.sort((a, b) => b.r - a.r).slice(0, topN)) w[p.t] = 1 / topN;
    return w;
  };
}

const ROT = ["SPY", "QQQ", "EEM", "GLD", "TLT"];

export const STRATEGIES: StrategyDef[] = [
  { id: "hold_spy", name: "Hold the S&P 500", schedule: "monthly", tickers: ["SPY"], description: "Buy and hold. The benchmark everything must beat.", decide: () => ({ SPY: 1 }) },
  { id: "trend200_monthly", name: "S&P 500 above its 200-day average (checked monthly)", schedule: "monthly", tickers: ["SPY", CASH], description: "At each month end: hold the S&P 500 if it is above its 200-day average, otherwise cash.", decide: trend200 },
  { id: "trend200_daily", name: "S&P 500 above its 200-day average (checked daily)", schedule: "daily", tickers: ["SPY", CASH], description: "Same rule checked every day — reacts faster, trades more.", decide: trend200 },
  { id: "dual_mom_cash", name: "Dual momentum (US vs emerging, else cash)", schedule: "monthly", tickers: ["SPY", "EEM", CASH], description: "If the S&P 500 beat cash over 12 months, hold whichever of US / emerging markets did better; otherwise cash.", decide: dualMomentum(CASH) },
  { id: "dual_mom_bonds", name: "Dual momentum (US vs emerging, else long bonds)", schedule: "monthly", tickers: ["SPY", "EEM", "TLT", CASH], description: "As above, but hides in long US Treasuries instead of cash.", decide: dualMomentum("TLT") },
  { id: "rot_top1_12", name: "Rotation: best of 5 ETFs (12-month)", schedule: "monthly", tickers: [...ROT, CASH], description: "Hold the single best 12-month performer of S&P 500, Nasdaq-100, emerging, gold, long bonds — if it beat cash.", decide: rotation(ROT, 12, 1) },
  { id: "rot_top2_12", name: "Rotation: best 2 of 5 ETFs (12-month)", schedule: "monthly", tickers: [...ROT, CASH], description: "Hold the top two 12-month performers, half each; any that didn't beat cash go to cash.", decide: rotation(ROT, 12, 2) },
  { id: "rot_top2_6", name: "Rotation: best 2 of 5 ETFs (6-month)", schedule: "monthly", tickers: [...ROT, CASH], description: "Same with a 6-month lookback — faster, more trading.", decide: rotation(ROT, 6, 2) },
  { id: "stock_mom_top5", name: "Stock momentum: top 5 watchlist stocks (12-1 month)", schedule: "monthly", tickers: [...STOCK_UNIVERSE, "SPY", CASH], description: "Hold the 5 watchlist stocks with the strongest 12-month return (skipping the last month), only while the S&P 500 is above its 200-day average.", caveat: "Optimistic: the watchlist was chosen today, so it already contains past winners (survivorship bias). Treat this row with suspicion.", decide: stockMomentum(5) },
];

export type PeriodStats = { from: string; to: string; cagrPct: number; totalPct: number; maxDrawdownPct: number; sharpe: number; volPct: number; worstYearPct: number; switchesPerYear: number; riskOnPct: number };
export type StrategyResult = {
  id: string; name: string; description: string; caveat?: string; schedule: Schedule;
  full: PeriodStats; train: PeriodStats; test: PeriodStats;
  holding: Weights; holdingSince: string; ifCheckedToday: Weights;
  curve: Array<{ date: string; equity: number }>;
};

function isMonthEnd(dates: string[], k: number) {
  return k === dates.length - 1 ? false : dates[k].slice(0, 7) !== dates[k + 1].slice(0, 7);
}

function r2(v: number, d = 2) { const p = 10 ** d; return Number.isFinite(v) ? Math.round(v * p) / p : 0; }

function stats(dates: string[], daily: number[], switches: number[], riskOn: number[], from: number, to: number): PeriodStats {
  const rs = daily.slice(from, to + 1);
  let eq = 1, peak = 1, dd = 0;
  const years = new Map<string, number>();
  rs.forEach((x, i) => {
    eq *= 1 + x; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak);
    const y = dates[from + i].slice(0, 4);
    years.set(y, (years.get(y) ?? 1) * (1 + x));
  });
  const n = rs.length;
  const mean = n ? rs.reduce((s, x) => s + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const yearsSpan = n / 252;
  return {
    from: dates[from] ?? "", to: dates[to] ?? "",
    cagrPct: r2(yearsSpan > 0 ? (eq ** (1 / yearsSpan) - 1) * 100 : 0),
    totalPct: r2((eq - 1) * 100),
    maxDrawdownPct: r2(dd * 100),
    sharpe: r2(sd > 0 ? (mean / sd) * Math.sqrt(252) : 0),
    volPct: r2(sd * Math.sqrt(252) * 100),
    worstYearPct: r2(years.size ? (Math.min(...years.values()) - 1) * 100 : 0),
    switchesPerYear: r2(yearsSpan > 0 ? switches.slice(from, to + 1).reduce((s, x) => s + x, 0) / yearsSpan : 0, 1),
    riskOnPct: r2(n ? riskOn.slice(from, to + 1).reduce((s, x) => s + x, 0) / n * 100 : 0, 1),
  };
}

function turnover(a: Weights, b: Weights) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let t = 0;
  for (const k of keys) t += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return t;
}

/**
 * Runs one strategy. `start` is the first index where every strategy has its lookback
 * (so all strategies are compared over identical dates). `cutoff` splits train / held-out.
 */
export function runStrategy(def: StrategyDef, s: AlignedSeries, start: number, cutoffDate: string): StrategyResult | null {
  const { dates } = s;
  if (dates.length - start < 60) return null;
  const daily: number[] = new Array(dates.length).fill(0);
  const switches: number[] = new Array(dates.length).fill(0);
  const riskOn: number[] = new Array(dates.length).fill(0);
  let w: Weights = def.decide(start, s) ?? { [CASH]: 1 };
  let since = dates[start];
  for (let k = start + 1; k < dates.length; k += 1) {
    // Earn day k's return on the weights decided at the close of k-1 (or earlier).
    let r = 0;
    for (const [t, wt] of Object.entries(w)) {
      const c = s.close[t];
      if (c) r += wt * (c[k] / c[k - 1] - 1);
    }
    daily[k] = r;
    riskOn[k] = Object.entries(w).reduce((acc, [t, wt]) => acc + (t === CASH ? 0 : wt), 0);
    // Decide at today's close for tomorrow.
    if (def.schedule === "daily" || isMonthEnd(dates, k)) {
      const next = def.decide(k, s);
      if (next) {
        const to = turnover(w, next);
        if (to > 0.01) {
          daily[k] -= to * COST_BPS_PER_SIDE / 10_000;
          switches[k] = 1;
          since = dates[k];
        }
        w = next;
      }
    }
  }
  const cut = dates.findIndex((d) => d >= cutoffDate);
  const end = dates.length - 1;
  const full = stats(dates, daily, switches, riskOn, start + 1, end);
  const train = cut > start + 1 ? stats(dates, daily, switches, riskOn, start + 1, cut - 1) : full;
  const test = cut > 0 ? stats(dates, daily, switches, riskOn, cut, end) : full;
  let eq = 1;
  const curve: Array<{ date: string; equity: number }> = [];
  for (let k = start + 1; k <= end; k += 1) { eq *= 1 + daily[k]; if ((k - start) % 5 === 0 || k === end) curve.push({ date: dates[k], equity: r2(eq, 4) }); }
  return {
    id: def.id, name: def.name, description: def.description, caveat: def.caveat, schedule: def.schedule,
    full, train, test,
    holding: w, holdingSince: since,
    ifCheckedToday: def.decide(end, s) ?? w,
    curve,
  };
}

/** Intersects price histories on common dates (all US-listed, same calendar). */
export function alignSeries(histories: Record<string, Array<{ date: string; close: number }>>): AlignedSeries {
  const tickers = Object.keys(histories).filter((t) => histories[t].length > 0);
  const maps = tickers.map((t) => new Map(histories[t].map((b) => [b.date, b.close])));
  const dates = [...maps[0]?.keys() ?? []].filter((d) => maps.every((m) => m.has(d))).sort();
  const close: Record<string, number[]> = {};
  tickers.forEach((t, i) => { close[t] = dates.map((d) => maps[i].get(d) as number); });
  return { dates, close };
}

export const ETF_TICKERS = ["SPY", "QQQ", "EEM", "GLD", "TLT", CASH];

/**
 * ETF strategies run on the ETF series; the stock-momentum strategy runs on its own
 * series (aligned separately so one short stock history can't shrink every test).
 * Both use the same held-out cutoff (last `testDays` calendar days).
 */
export function runAll(etf: AlignedSeries, stocks?: AlignedSeries | null, testDays = 730) {
  const start = 12 * M + 2;
  const last = etf.dates.at(-1);
  if (!last || etf.dates.length < start + 300) return { results: [] as StrategyResult[], cutoff: "", start: "" };
  const cutoff = new Date(new Date(last).getTime() - testDays * 86_400_000).toISOString().slice(0, 10);
  const results: StrategyResult[] = [];
  for (const d of STRATEGIES) {
    const series = d.id === "stock_mom_top5" ? stocks : etf;
    if (!series || !d.tickers.every((t) => series.close[t])) continue;
    const r = runStrategy(d, series, start, cutoff);
    if (r) results.push(r);
  }
  return { results, cutoff, start: etf.dates[start] };
}

export function describeWeights(w: Weights) {
  return Object.entries(w).filter(([, v]) => v > 0.001).sort((a, b) => b[1] - a[1]).map(([t, v]) => `${Math.round(v * 100)}% ${t}`).join(" + ") || "100% cash";
}
