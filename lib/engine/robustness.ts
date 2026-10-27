// Robustness analytics for allocation strategies (V5.8). Pure, deterministic (seeded).
//
// The question is never "which line went up most" — with enough rules one always does.
// These tools ask: is the result consistent year to year, does it survive resampling,
// and is the Sharpe ratio still meaningful after counting how many rules were tried?
//
// References: Bailey & López de Prado (2012, 2014) Probabilistic & Deflated Sharpe Ratio;
// Politis & Romano (1994) block bootstrap; Hoffstein (Newfound) rebalance timing luck.

export function normCdf(x: number) {
  // Abramowitz–Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Acklam's inverse normal CDF (|error| < 1.2e-9). */
export function normInv(p: number) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function moments(x: number[]) {
  const n = x.length;
  const m = x.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const v of x) { const d = v - m; m2 += d * d; m3 += d ** 3; m4 += d ** 4; }
  m2 /= n; m3 /= n; m4 /= n;
  const sd = Math.sqrt(m2);
  return { n, mean: m, sd, skew: sd > 0 ? m3 / sd ** 3 : 0, kurt: sd > 0 ? m4 / sd ** 4 : 3 };
}

/** Per-period Sharpe ratio (no risk-free adjustment). */
export function sharpe(x: number[]) {
  const { mean, sd } = moments(x);
  return sd > 0 ? mean / sd : 0;
}

/**
 * Probabilistic Sharpe Ratio: probability that the true (per-period) Sharpe exceeds `srStar`,
 * given sample length, skewness and fat tails. PSR > 0.95 ≈ significant at 5%.
 */
export function psr(x: number[], srStar: number) {
  const { n, skew, kurt } = moments(x);
  if (n < 30) return 0;
  const sr = sharpe(x);
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return normCdf(((sr - srStar) * Math.sqrt(n - 1)) / denom);
}

const EULER = 0.5772156649015329;

/**
 * Deflated Sharpe Ratio: PSR against the Sharpe you'd expect from the BEST of `trials`
 * worthless rules, given how dispersed the tried rules' Sharpes were. Answers "is this
 * still good after accounting for how many things we tried?"
 */
export function deflatedSharpe(x: number[], trialSharpesPerPeriod: number[]) {
  const N = Math.max(2, trialSharpesPerPeriod.length);
  const m = trialSharpesPerPeriod.reduce((a, b) => a + b, 0) / N;
  const v = trialSharpesPerPeriod.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, N - 1);
  const sr0 = Math.sqrt(v) * ((1 - EULER) * normInv(1 - 1 / N) + EULER * normInv(1 - 1 / (N * Math.E)));
  return { dsr: psr(x, sr0), sr0PerPeriod: sr0 };
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paired stationary-style block bootstrap: resample the SAME 1-month blocks of strategy and
 * benchmark returns together (keeps their correlation and crash timing), build many
 * alternative 10-year histories, and count how often the strategy beat the benchmark.
 */
export function pairedBootstrap(strategy: number[], bench: number[], opts: { years?: number; block?: number; paths?: number; seed?: number; ddThresholdPct?: number } = {}) {
  const n = Math.min(strategy.length, bench.length);
  const len = Math.round((opts.years ?? 10) * 252);
  const block = opts.block ?? 21;
  const paths = opts.paths ?? 1000;
  const dd = (opts.ddThresholdPct ?? 30) / 100;
  const rand = mulberry32(opts.seed ?? 11);
  if (n < block * 4) return null;
  let beat = 0, deep = 0, benchDeep = 0;
  const diffs: number[] = [];
  for (let p = 0; p < paths; p += 1) {
    let es = 1, eb = 1, ps = 1, pb = 1, mds = 0, mdb = 0;
    for (let i = 0; i < len; ) {
      const start = Math.floor(rand() * (n - block));
      for (let j = 0; j < block && i < len; j += 1, i += 1) {
        es *= 1 + strategy[start + j]; eb *= 1 + bench[start + j];
        ps = Math.max(ps, es); pb = Math.max(pb, eb);
        mds = Math.max(mds, (ps - es) / ps); mdb = Math.max(mdb, (pb - eb) / pb);
      }
    }
    if (es > eb) beat += 1;
    if (mds > dd) deep += 1;
    if (mdb > dd) benchDeep += 1;
    const yrs = len / 252;
    diffs.push((es ** (1 / yrs) - eb ** (1 / yrs)) * 100);
  }
  diffs.sort((a, b) => a - b);
  return {
    paths, years: len / 252,
    pBeatPct: Math.round(beat / paths * 1000) / 10,
    pDrawdownOverPct: Math.round(deep / paths * 1000) / 10,
    pBenchDrawdownOverPct: Math.round(benchDeep / paths * 1000) / 10,
    medianCagrDiffPct: Math.round(diffs[Math.floor(paths / 2)] * 100) / 100,
    cagrDiff5Pct: Math.round(diffs[Math.floor(paths * 0.05)] * 100) / 100,
    cagrDiff95Pct: Math.round(diffs[Math.floor(paths * 0.95)] * 100) / 100,
    ddThresholdPct: dd * 100,
  };
}

/** Calendar-year returns from a daily series. */
export function calendarYears(dates: string[], daily: number[], from: number, to: number) {
  const years = new Map<string, number>();
  for (let k = from; k <= to; k += 1) {
    const y = dates[k].slice(0, 4);
    years.set(y, (years.get(y) ?? 1) * (1 + daily[k]));
  }
  return [...years.entries()].map(([year, g]) => ({ year, pct: Math.round((g - 1) * 1000) / 10 }));
}
