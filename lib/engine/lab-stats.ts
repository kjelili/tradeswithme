// Improvement-lab types and aggregation (V5.6). Constants-only imports: client-safe.
//
// Honesty rules baked in:
// - Every variant is judged against holding the benchmark over the SAME dates (alpha).
// - Variants are ranked on the TRAINING period only; the winner is then judged on the
//   held-out last 365 days it never saw. Picking the best of 27 on the same data it is
//   scored on would be overfitting.

import { BROKER_ROUND_TRIP_BPS } from "./config";
import { simulatePortfolio } from "./replay-stats";
import type { AssetClass } from "./types";

export const LAB_TARGETS_R = [1, 1.5, 2] as const;
export const LAB_HORIZONS = [5, 10, 20] as const;
export const LAB_ENTRY_IDS = ["strict", "medium", "loose"] as const;
export const LIVE_VARIANT = "strict|2R|5d";
export const TEST_DAYS = 365;

export function variantId(entry: string, r: number, h: number) {
  return `${entry}|${r}R|${h}d`;
}

/** Compact trade row (results for ~48 symbols × 27 variants must fit in the browser). */
export type LabTrade = {
  v: string;        // variant id
  s: string;        // symbol
  a: AssetClass;
  d: string;        // entry date
  x: string;        // exit date
  o: "TARGET" | "STOP" | "TIME";
  b: number;        // bars held
  g: number;        // gross %
  n: number;        // net % after realistic broker costs
  m: number;        // benchmark gross % over the same dates
  p: number;        // entry price (USD)
  e: number;        // decision evidence
};

export type LabSymbolResult = {
  symbol: string;
  assetClass: AssetClass;
  source: string;
  firstDate: string | null;
  lastDate: string | null;
  days: number;
  maxScore: number;
  /** Days where the lab's re-implemented strict gate disagreed with the live decision. Must be 0. */
  parityMismatches: number;
  trades: LabTrade[];
  skipped?: string;
};

export type BaselineStats = { totalPct: number; maxDrawdownPct: number; exposurePct: number };
export type LabBaseline = {
  benchmark: string;
  start: string;
  cutoff: string;
  end: string;
  buyHold: { full: BaselineStats; test: BaselineStats };
  trend200: { full: BaselineStats; test: BaselineStats };
};

export type SampleStats = {
  n: number;
  winRatePct: number;
  avgNetPct: number;
  avgAlphaPct: number;
  tNet: number;
  tAlpha: number;
  profitFactor: number;
  alphaCi95: [number, number];
  portfolioReturnPct: number;
  portfolioMaxDdPct: number;
  targets: number;
  stops: number;
  timeExits: number;
};

function r(v: number, d = 3) {
  const p = 10 ** d;
  return Number.isFinite(v) ? Math.round(v * p) / p : 0;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tStat(xs: number[]) {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? mean / (sd / Math.sqrt(xs.length)) : 0;
}

/** Seeded bootstrap 95% interval of the mean. */
export function meanCi95(xs: number[], draws = 1000, seed = 7): [number, number] {
  if (xs.length < 2) return [0, 0];
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let k = 0; k < draws; k += 1) {
    let s = 0;
    for (let i = 0; i < xs.length; i += 1) s += xs[Math.floor(rand() * xs.length)];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  return [r(means[Math.floor(draws * 0.025)]), r(means[Math.floor(draws * 0.975)])];
}

export function sampleStats(trades: LabTrade[]): SampleStats {
  const net = trades.map((t) => t.n);
  const alpha = trades.map((t) => t.g - t.m);
  const wins = net.filter((x) => x > 0);
  const gp = wins.reduce((s, x) => s + x, 0);
  const gl = Math.abs(net.filter((x) => x <= 0).reduce((s, x) => s + x, 0));
  const p = simulatePortfolio(trades.map((t) => ({ symbol: t.s, assetClass: t.a, signalDate: t.d, entryDate: t.d, exitDate: t.x, entry: t.p, stop: 0, target: 0, exit: 0, outcome: t.o, barsHeld: t.b, grossPct: t.g, netPct: t.n, evidence: t.e, score: 0 })));
  return {
    n: trades.length,
    winRatePct: trades.length ? r(wins.length / trades.length * 100, 1) : 0,
    avgNetPct: trades.length ? r(net.reduce((s, x) => s + x, 0) / net.length) : 0,
    avgAlphaPct: trades.length ? r(alpha.reduce((s, x) => s + x, 0) / alpha.length) : 0,
    tNet: r(tStat(net), 2),
    tAlpha: r(tStat(alpha), 2),
    profitFactor: gl ? r(gp / gl, 2) : gp ? 99 : 0,
    alphaCi95: meanCi95(alpha),
    portfolioReturnPct: p.finalReturnPct,
    portfolioMaxDdPct: p.maxDrawdownPct,
    targets: trades.filter((t) => t.o === "TARGET").length,
    stops: trades.filter((t) => t.o === "STOP").length,
    timeExits: trades.filter((t) => t.o === "TIME").length,
  };
}

export type VariantRow = { id: string; entry: string; targetR: number; horizon: number; train: SampleStats; test: SampleStats; all: SampleStats };

export type LabVerdict = { verdict: "EDGE_HOLDS_OUT_OF_SAMPLE" | "PROMISING_NOT_PROVEN" | "NO_EDGE"; reasons: string[] };

export function cutoffFor(results: Array<Pick<LabSymbolResult, "lastDate">>) {
  const last = results.map((x) => x.lastDate ?? "").filter(Boolean).sort().at(-1);
  if (!last) return null;
  return new Date(new Date(last).getTime() - TEST_DAYS * 86_400_000).toISOString().slice(0, 10);
}

export function analyseLab(results: LabSymbolResult[], opts: { assetClass?: AssetClass | "ALL"; minTrainTrades?: number } = {}) {
  const cutoff = cutoffFor(results);
  const want = opts.assetClass ?? "ALL";
  const all = results.flatMap((x) => x.trades).filter((t) => want === "ALL" || t.a === want);
  const rows: VariantRow[] = [];
  for (const entry of LAB_ENTRY_IDS) for (const R of LAB_TARGETS_R) for (const H of LAB_HORIZONS) {
    const id = variantId(entry, R, H);
    const ts = all.filter((t) => t.v === id);
    const train = cutoff ? ts.filter((t) => t.d < cutoff) : ts;
    const test = cutoff ? ts.filter((t) => t.d >= cutoff) : [];
    rows.push({ id, entry, targetR: R, horizon: H, train: sampleStats(train), test: sampleStats(test), all: sampleStats(ts) });
  }
  const minTrain = opts.minTrainTrades ?? 20;
  // Rank on the training period only, by t-stat of net returns (rewards consistency AND sample size).
  const eligible = rows.filter((x) => x.train.n >= minTrain);
  const best = [...(eligible.length ? eligible : rows)].sort((a, b) => b.train.tNet - a.train.tNet)[0];
  const live = rows.find((x) => x.id === LIVE_VARIANT)!;
  return { cutoff, rows, best, live, verdict: verdictFor(best) };
}

export function verdictFor(best: VariantRow): LabVerdict {
  const t = best.test;
  const reasons: string[] = [];
  if (t.n < 10) return { verdict: "PROMISING_NOT_PROVEN", reasons: [`Only ${t.n} held-out trades for ${best.id}; too few to judge.`] };
  if (t.avgNetPct <= 0) reasons.push(`Held-out average after costs is ${t.avgNetPct}% (must be > 0).`);
  if (t.avgAlphaPct <= 0) reasons.push(`Held-out trades did ${t.avgAlphaPct}% vs simply holding the benchmark on the same dates (must be > 0).`);
  if (reasons.length) return { verdict: "NO_EDGE", reasons };
  if (t.n >= 30 && t.tAlpha >= 2 && t.alphaCi95[0] > 0) return { verdict: "EDGE_HOLDS_OUT_OF_SAMPLE", reasons: [`${best.id} beat the benchmark out of sample: +${t.avgAlphaPct}% per trade, 95% range ${t.alphaCi95[0]}% to ${t.alphaCi95[1]}%, t=${t.tAlpha}.`] };
  return { verdict: "PROMISING_NOT_PROVEN", reasons: [`Positive out of sample (+${t.avgNetPct}% net, +${t.avgAlphaPct}% vs benchmark) but the 95% range ${t.alphaCi95[0]}% to ${t.alphaCi95[1]}% still includes zero (t=${t.tAlpha}, n=${t.n}).`] };
}

/** Whole-share affordability at the live cap: share of equity trades costing more than one slot. */
export function affordability(trades: LabTrade[], capGbp = 50, slots = 3, usdPerGbp = 1.27) {
  const eq = trades.filter((t) => t.a === "EQUITY");
  const slotUsd = (capGbp / slots) * usdPerGbp;
  const unaffordable = eq.filter((t) => t.p > slotUsd).length;
  const prices = eq.map((t) => t.p).sort((a, b) => a - b);
  const p90 = prices.length ? prices[Math.min(prices.length - 1, Math.floor(prices.length * 0.9))] : 0;
  // Cap that would let 90% of these trades buy at least one whole share per slot.
  return { slotUsd: r(slotUsd, 2), equityTrades: eq.length, unaffordable, unaffordablePct: eq.length ? r(unaffordable / eq.length * 100, 1) : 0, capFor90PctGbp: r(p90 * slots / usdPerGbp, 0) };
}

export const BENCH_SWITCH_COST_BPS = { EQUITY: BROKER_ROUND_TRIP_BPS.EQUITY / 2, CRYPTO: BROKER_ROUND_TRIP_BPS.CRYPTO / 2 } as const;
