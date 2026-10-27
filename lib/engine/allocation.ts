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
  /** Run as equal sleeves rebalanced on different days after month end (cuts timing luck). */
  tranches?: number[];
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
  VT: "Global all-cap tracker — e.g. VWRP / VWRL",
  EFA: "Developed markets ex-US tracker (check your platform's list)",
  IEF: "7–10 year US Treasury tracker (check your platform's list)",
  VNQ: "Property / REIT tracker — e.g. IWDP",
  DBC: "Broad commodities tracker (check your platform's list)",
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

export function rotation(universe: string[], lookbackMonths: number, topN: number) {
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

/** Annualised volatility of daily returns over the last n days up to k. */
function vol(s: AlignedSeries, t: string, k: number, n: number) {
  const c = s.close[t];
  if (!c || k - n < 0) return null;
  const rs: number[] = [];
  for (let i = k - n + 1; i <= k; i += 1) rs.push(c[i] / c[i - 1] - 1);
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, rs.length - 1));
  return sd * Math.sqrt(252);
}

/** Faber (2007) GTAA: each asset gets an equal slice if above its 10-month (≈210-day) average. */
function gtaa(assets: string[]) {
  return (k: number, s: AlignedSeries): Weights | null => {
    const w: Weights = {};
    let used = 0;
    for (const t of assets) {
      const m = sma(s, t, k, 210);
      if (m == null) return null;
      if (s.close[t][k] > m) { w[t] = 1 / assets.length; used += 1 / assets.length; }
    }
    if (used < 0.999) w[CASH] = 1 - used;
    return w;
  };
}

/**
 * Time-series momentum with inverse-volatility risk budgets (Moskowitz, Ooi & Pedersen 2012;
 * Hurst, Ooi & Pedersen 2017). Each asset's budget ∝ 1/vol; it is held only while its
 * 12-month return beats cash, otherwise its budget sits in cash. No leverage.
 */
function tsmomIvol(assets: string[]) {
  return (k: number, s: AlignedSeries): Weights | null => {
    const cash = ret(s, CASH, k, 12 * M);
    if (cash == null) return null;
    const inv: Array<{ t: string; iv: number; on: boolean }> = [];
    for (const t of assets) {
      const r = ret(s, t, k, 12 * M);
      const v = vol(s, t, k, 63);
      if (r == null || v == null || !(v > 0)) return null;
      inv.push({ t, iv: 1 / v, on: r > cash });
    }
    const total = inv.reduce((a, x) => a + x.iv, 0);
    const w: Weights = {};
    let used = 0;
    for (const x of inv) if (x.on) { w[x.t] = x.iv / total; used += x.iv / total; }
    if (used < 0.999) w[CASH] = 1 - used;
    return w;
  };
}

/** Volatility-managed S&P 500 (Moreira & Muir 2017): scale exposure to a 15% vol target, max 100%. */
function volTarget(target = 0.15) {
  return (k: number, s: AlignedSeries): Weights | null => {
    const v = vol(s, "SPY", k, 21);
    if (v == null || !(v > 0)) return null;
    const x = Math.min(1, target / v);
    return x >= 0.999 ? { SPY: 1 } : { SPY: x, [CASH]: 1 - x };
  };
}

/** Average of several strategies' weights — don't bet on one rule. */
function ensemble(parts: Array<(k: number, s: AlignedSeries) => Weights | null>) {
  return (k: number, s: AlignedSeries): Weights | null => {
    const ws = parts.map((p) => p(k, s));
    if (ws.some((w) => !w)) return null;
    const out: Weights = {};
    for (const w of ws as Weights[]) for (const [t, v] of Object.entries(w)) out[t] = (out[t] ?? 0) + v / ws.length;
    return out;
  };
}

const GTAA5 = ["SPY", "EFA", "IEF", "VNQ", "DBC"];
const TS8 = ["SPY", "EFA", "EEM", "IEF", "TLT", "GLD", "DBC", "VNQ"];

export const ROT = ["SPY", "QQQ", "EEM", "GLD", "TLT"];

export const STRATEGIES: StrategyDef[] = [
  { id: "hold_spy", name: "Hold the S&P 500", schedule: "monthly", tickers: ["SPY"], description: "Buy and hold. The benchmark everything must beat.", decide: () => ({ SPY: 1 }) },
  { id: "trend200_monthly", name: "S&P 500 above its 200-day average (checked monthly)", schedule: "monthly", tickers: ["SPY", CASH], description: "At each month end: hold the S&P 500 if it is above its 200-day average, otherwise cash.", decide: trend200 },
  { id: "trend200_daily", name: "S&P 500 above its 200-day average (checked daily)", schedule: "daily", tickers: ["SPY", CASH], description: "Same rule checked every day — reacts faster, trades more.", decide: trend200 },
  { id: "dual_mom_cash", name: "Dual momentum (US vs emerging, else cash)", schedule: "monthly", tickers: ["SPY", "EEM", CASH], description: "If the S&P 500 beat cash over 12 months, hold whichever of US / emerging markets did better; otherwise cash.", decide: dualMomentum(CASH) },
  { id: "dual_mom_bonds", name: "Dual momentum (US vs emerging, else long bonds)", schedule: "monthly", tickers: ["SPY", "EEM", "TLT", CASH], description: "As above, but hides in long US Treasuries instead of cash.", decide: dualMomentum("TLT") },
  { id: "rot_top1_12", name: "Rotation: best of 5 ETFs (12-month)", schedule: "monthly", tickers: [...ROT, CASH], description: "Hold the single best 12-month performer of S&P 500, Nasdaq-100, emerging, gold, long bonds — if it beat cash.", decide: rotation(ROT, 12, 1) },
  { id: "rot_top2_12", name: "Rotation: best 2 of 5 ETFs (12-month)", schedule: "monthly", tickers: [...ROT, CASH], description: "Hold the top two 12-month performers, half each; any that didn't beat cash go to cash.", decide: rotation(ROT, 12, 2) },
  { id: "rot_top2_6", name: "Rotation: best 2 of 5 ETFs (6-month)", schedule: "monthly", tickers: [...ROT, CASH], description: "Same with a 6-month lookback — faster, more trading.", decide: rotation(ROT, 6, 2) },
  { id: "hold_global", name: "Hold a global tracker", schedule: "monthly", tickers: ["VT"], description: "Buy and hold the whole world's shares (US ≈ 60%). The diversified benchmark.", decide: () => ({ VT: 1 }) },
  { id: "blend_spy_rot", name: "50/50: S&P 500 + best-2-of-5 rotation", schedule: "monthly", tickers: [...ROT, CASH], description: "Half held in the S&P 500 permanently, half in the best-2-of-5 rotation; re-balanced monthly.", decide: ensemble([() => ({ SPY: 1 }), rotation(ROT, 12, 2)]) },
  { id: "gtaa5", name: "Faber GTAA: 5 assets above their 10-month average", schedule: "monthly", tickers: [...GTAA5, CASH], description: "US shares, international shares, 7–10y Treasuries, property, commodities — 20% each while above its 10-month average, else cash (Faber 2007).", decide: gtaa(GTAA5) },
  { id: "tsmom_ivol", name: "Multi-asset trend, risk-balanced (8 assets)", schedule: "monthly", tickers: [...TS8, CASH], description: "Each of 8 asset classes gets a risk-balanced slice (smaller for volatile ones) while its 12-month return beats cash, else cash (time-series momentum).", decide: tsmomIvol(TS8) },
  { id: "voltarget_spy", name: "S&P 500, volatility-managed (15% target)", schedule: "monthly", tickers: ["SPY", CASH], description: "Hold less S&P 500 when it has been jumpy (exposure = 15% ÷ last month's volatility, max 100%) (Moreira & Muir 2017).", decide: volTarget(0.15) },
  { id: "ensemble", name: "Ensemble of 5 rules (equal blend)", schedule: "monthly", tickers: [...new Set([...ROT, ...GTAA5, ...TS8, CASH])], description: "Average of 200-day trend, best-2-of-5 rotation, Faber GTAA, multi-asset trend and the volatility-managed S&P 500. No single rule to get wrong.", decide: ensemble([trend200, rotation(ROT, 12, 2), gtaa(GTAA5), tsmomIvol(TS8), volTarget(0.15)]) },
  { id: "ensemble_tranched", name: "Ensemble, rebalanced in 4 weekly tranches", schedule: "monthly", tickers: [...new Set([...ROT, ...GTAA5, ...TS8, CASH])], tranches: [0, 5, 10, 15], description: "The ensemble split into 4 quarters, each rebalanced on a different week after month end — removes the luck of one rebalance date.", decide: ensemble([trend200, rotation(ROT, 12, 2), gtaa(GTAA5), tsmomIvol(TS8), volTarget(0.15)]) },
  { id: "stock_mom_top5", name: "Stock momentum: top 5 watchlist stocks (12-1 month)", schedule: "monthly", tickers: [...STOCK_UNIVERSE, "SPY", CASH], description: "Hold the 5 watchlist stocks with the strongest 12-month return (skipping the last month), only while the S&P 500 is above its 200-day average.", caveat: "Optimistic: the watchlist was chosen today, so it already contains past winners (survivorship bias). Treat this row with suspicion.", decide: stockMomentum(5) },
];

export type PeriodStats = { from: string; to: string; cagrPct: number; totalPct: number; maxDrawdownPct: number; sharpe: number; volPct: number; worstYearPct: number; switchesPerYear: number; riskOnPct: number };
export type StrategyResult = {
  id: string; name: string; description: string; caveat?: string; schedule: Schedule;
  full: PeriodStats; train: PeriodStats; test: PeriodStats;
  holding: Weights; holdingSince: string; ifCheckedToday: Weights;
  curve: Array<{ date: string; equity: number }>;
  /** Daily net returns aligned to `dates` (server-side analytics only; stripped before JSON). */
  daily?: number[];
  dates?: string[];
  startIndex?: number;
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
export function runStrategy(def: StrategyDef, s: AlignedSeries, start: number, cutoffDate: string, offset = 0, pricing: AlignedSeries = s): StrategyResult | null {
  const { dates } = s;
  if (pricing.dates.length !== dates.length) throw new Error("Pricing series must share the decision series' dates.");
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
      const c = pricing.close[t];
      if (c) r += wt * (c[k] / c[k - 1] - 1);
    }
    daily[k] = r;
    riskOn[k] = Object.entries(w).reduce((acc, [t, wt]) => acc + (t === CASH ? 0 : wt), 0);
    // Decide at today's close for tomorrow.
    if (def.schedule === "daily" || (k - offset >= start && isMonthEnd(dates, k - offset))) {
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
    daily, dates, startIndex: start,
  };
}

/** Builds a result from a daily-return array (used for tranched sleeves). */
export function resultFromDaily(base: StrategyResult, daily: number[], s: AlignedSeries, start: number, cutoffDate: string, switches: number[], riskOn: number[]): StrategyResult {
  const { dates } = s;
  const cut = dates.findIndex((d) => d >= cutoffDate);
  const end = dates.length - 1;
  const full = stats(dates, daily, switches, riskOn, start + 1, end);
  const train = cut > start + 1 ? stats(dates, daily, switches, riskOn, start + 1, cut - 1) : full;
  const test = cut > 0 ? stats(dates, daily, switches, riskOn, cut, end) : full;
  let eq = 1;
  const curve: Array<{ date: string; equity: number }> = [];
  for (let k = start + 1; k <= end; k += 1) { eq *= 1 + daily[k]; if ((k - start) % 5 === 0 || k === end) curve.push({ date: dates[k], equity: r2(eq, 4) }); }
  return { ...base, full, train, test, curve, daily, dates, startIndex: start };
}

/** Equal sleeves rebalanced at different offsets after month end; returns are averaged. */
export function runTranched(def: StrategyDef, s: AlignedSeries, start: number, cutoffDate: string, pricing: AlignedSeries = s): StrategyResult | null {
  const offsets = def.tranches ?? [0];
  const runs = offsets.map((o) => runStrategy(def, s, start, cutoffDate, o, pricing)).filter((x): x is StrategyResult => !!x);
  if (!runs.length) return null;
  const n = s.dates.length;
  const daily = new Array(n).fill(0);
  for (const r of runs) r.daily!.forEach((x, k) => { daily[k] += x / runs.length; });
  // Switch counts and exposure: average across sleeves (each sleeve trades a quarter of the money).
  const switches = new Array(n).fill(0);
  const riskOn = new Array(n).fill(0);
  const base = runs[0];
  const merged = resultFromDaily(base, daily, s, start, cutoffDate, switches, riskOn);
  const avg = (f: (r: StrategyResult) => number) => r2(runs.reduce((a, r) => a + f(r), 0) / runs.length, 1);
  merged.full = { ...merged.full, switchesPerYear: avg((r) => r.full.switchesPerYear), riskOnPct: avg((r) => r.full.riskOnPct) };
  merged.train = { ...merged.train, switchesPerYear: avg((r) => r.train.switchesPerYear), riskOnPct: avg((r) => r.train.riskOnPct) };
  merged.test = { ...merged.test, switchesPerYear: avg((r) => r.test.switchesPerYear), riskOnPct: avg((r) => r.test.riskOnPct) };
  return merged;
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

export const ETF_TICKERS = ["SPY", "QQQ", "EEM", "GLD", "TLT", "VT", "EFA", "IEF", "VNQ", "DBC", CASH];

/**
 * ETF strategies run on the ETF series; the stock-momentum strategy runs on its own
 * series (aligned separately so one short stock history can't shrink every test).
 * Both use the same held-out cutoff (last `testDays` calendar days).
 */
export function runAll(etf: AlignedSeries, stocks?: AlignedSeries | null, testDays = 730, pricing?: { etf: AlignedSeries; stocks?: AlignedSeries | null }) {
  const start = 12 * M + 2;
  const last = etf.dates.at(-1);
  if (!last || etf.dates.length < start + 300) return { results: [] as StrategyResult[], cutoff: "", start: "" };
  const cutoff = new Date(new Date(last).getTime() - testDays * 86_400_000).toISOString().slice(0, 10);
  const results: StrategyResult[] = [];
  for (const d of STRATEGIES) {
    const isStock = d.id === "stock_mom_top5";
    const series = isStock ? stocks : etf;
    const px = pricing ? (isStock ? pricing.stocks : pricing.etf) : series;
    if (!series || !px || !d.tickers.every((t) => series.close[t] && px.close[t])) continue;
    const r = d.tranches ? runTranched(d, series, start, cutoff, px) : runStrategy(d, series, start, cutoff, 0, px);
    if (r) results.push(r);
  }
  return { results, cutoff, start: etf.dates[start] };
}

/**
 * Re-prices every risk asset in GBP using a USD-per-GBP rate series (forward-filled).
 * Cash keeps its USD T-bill return as a stand-in for GBP cash interest (both are short
 * rates; the gap is small next to FX moves). Tells a UK investor what they'd really have.
 */
export function toGbp(s: AlignedSeries, usdPerGbp: Array<{ date: string; rate: number }>): AlignedSeries | null {
  if (!usdPerGbp.length) return null;
  const fx = [...usdPerGbp].sort((a, b) => a.date.localeCompare(b.date));
  const rates: number[] = [];
  let j = 0, last = NaN;
  for (const d of s.dates) {
    while (j < fx.length && fx[j].date <= d) { last = fx[j].rate; j += 1; }
    rates.push(last);
  }
  const firstOk = rates.findIndex((x) => Number.isFinite(x) && x > 0);
  if (firstOk < 0) return null;
  // Keep the same dates as the USD series (decisions are made on USD prices). If FX history
  // starts late, hold the first known rate flat before it (zero FX return) and say so upstream.
  for (let i = 0; i < firstOk; i += 1) rates[i] = rates[firstOk];
  const close: Record<string, number[]> = {};
  for (const [t, c] of Object.entries(s.close)) close[t] = t === CASH ? [...c] : c.map((p, i) => p / rates[i]);
  return { dates: [...s.dates], close };
}

export function describeWeights(w: Weights) {
  return Object.entries(w).filter(([, v]) => v > 0.001).sort((a, b) => b[1] - a[1]).map(([t, v]) => `${Math.round(v * 100)}% ${t}`).join(" + ") || "100% cash";
}
