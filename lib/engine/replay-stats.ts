// Pure replay types, costs and aggregation. Only imports constants, so it is safe to bundle
// into the client-side desk panels.

import { BROKER_ROUND_TRIP_BPS, ENGINE } from "./config";
import type { AssetClass, MarketSource } from "./types";

const ROUND_TRIP_LEDGER_BPS = ENGINE.roundTripCostBps;

export type ReplayCosts = { equityRoundTripBps: number; cryptoRoundTripBps: number };

/**
 * Realistic costs = the same broker costs the real-money gate uses (config.ts):
 * Kraken maker entry 0.40% + taker exit 0.80% + slippage; Alpaca ~0.10%.
 * The forward ledger itself only deducts ROUND_TRIP_LEDGER_BPS.
 */
export const REALISTIC_COSTS: ReplayCosts = { equityRoundTripBps: BROKER_ROUND_TRIP_BPS.EQUITY, cryptoRoundTripBps: BROKER_ROUND_TRIP_BPS.CRYPTO };
export const LEDGER_COSTS: ReplayCosts = { equityRoundTripBps: ROUND_TRIP_LEDGER_BPS, cryptoRoundTripBps: ROUND_TRIP_LEDGER_BPS };
/** Kraken tier-1 taker in AND out (0.80% + 0.80%) + slippage: the cost of a market entry. */
export const TAKER_ROUND_TRIP_BPS = 165;

export type ReplayTrade = {
  symbol: string;
  assetClass: AssetClass;
  signalDate: string;
  entryDate: string;
  entry: number;
  stop: number;
  target: number;
  exitDate: string;
  exit: number;
  outcome: "TARGET" | "STOP" | "TIME";
  barsHeld: number;
  grossPct: number;
  netPct: number;
  evidence: number;
  score: number;
  /** V5.5 tags (executable trades only). */
  costToRisk?: number;
  breakevenWinRate?: number;
  edgePass?: boolean;
  runUp5Pct?: number | null;
  chased?: boolean;
};

/** A crypto signal whose maker limit never filled, with its market-entry counterfactual. */
export type MissedFill = { symbol: string; signalDate: string; outcome: "TARGET" | "STOP" | "TIME"; grossPct: number; netPctAtTaker: number };

export type ReplaySymbolResult = {
  symbol: string;
  assetClass: AssetClass;
  source: MarketSource;
  bars: number;
  firstDecision: string | null;
  lastDecision: string | null;
  decisionsEvaluated: number;
  signals: number;
  trades: ReplayTrade[];
  ledgerTrades: ReplayTrade[];
  buyHoldPct: number;
  /** Highest decision score seen (BUY needs ≥ ENGINE.buyThreshold). */
  maxDecisionScore: number;
  /** Days that reached BUY_SETUP but failed the overnight confidence/evidence filter. */
  buySetupFilteredOut: number;
  /** Crypto signals that tried a maker entry, and those that never filled. */
  makerAttempts: number;
  missed: MissedFill[];
  skipped?: string;
};

function round(v: number, d = 4) {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

// ---------------- Aggregation ----------------

export type ReplayStats = {
  trades: number;
  wins: number;
  winRatePct: number;
  avgNetPct: number;
  medianNetPct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  totalCompoundedPct: number;
  targets: number;
  stops: number;
  timeExits: number;
};

export function statsFor(trades: Array<Pick<ReplayTrade, "netPct" | "outcome" | "exitDate">>): ReplayStats {
  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  const r = sorted.map((t) => t.netPct);
  const wins = r.filter((x) => x > 0);
  const losses = r.filter((x) => x <= 0);
  const gp = wins.reduce((s, x) => s + x, 0);
  const gl = Math.abs(losses.reduce((s, x) => s + x, 0));
  let eq = 1, peak = 1, dd = 0;
  for (const x of r) { eq *= 1 + x / 100; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  const med = [...r].sort((a, b) => a - b);
  return {
    trades: r.length,
    wins: wins.length,
    winRatePct: r.length ? round(wins.length / r.length * 100, 1) : 0,
    avgNetPct: r.length ? round(r.reduce((s, x) => s + x, 0) / r.length, 3) : 0,
    medianNetPct: med.length ? round(med[Math.floor(med.length / 2)], 3) : 0,
    profitFactor: gl ? round(gp / gl, 2) : gp ? 99 : 0,
    maxDrawdownPct: round(dd * 100, 2),
    totalCompoundedPct: round((eq - 1) * 100, 2),
    targets: sorted.filter((t) => t.outcome === "TARGET").length,
    stops: sorted.filter((t) => t.outcome === "STOP").length,
    timeExits: sorted.filter((t) => t.outcome === "TIME").length,
  };
}

/**
 * Portfolio simulation of the executor: max 3 concurrent positions, each a third of
 * capital, candidates on the same day taken in evidence order. Returns the equity curve.
 */
export function simulatePortfolio(trades: ReplayTrade[], slots = 3) {
  const byDay = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || b.evidence - a.evidence);
  const open: ReplayTrade[] = [];
  const taken: ReplayTrade[] = [];
  let equity = 1;
  const curve: Array<{ date: string; equity: number }> = [];
  for (const t of byDay) {
    for (let j = open.length - 1; j >= 0; j -= 1) {
      if (open[j].exitDate < t.entryDate) {
        equity += (1 / slots) * (open[j].netPct / 100) * 1; // fixed-fraction slot sizing
        curve.push({ date: open[j].exitDate, equity: round(equity, 5) });
        open.splice(j, 1);
      }
    }
    if (open.length >= slots || open.some((o) => o.symbol === t.symbol)) continue;
    open.push(t);
    taken.push(t);
  }
  for (const o of open.sort((a, b) => a.exitDate.localeCompare(b.exitDate))) {
    equity += (1 / slots) * (o.netPct / 100);
    curve.push({ date: o.exitDate, equity: round(equity, 5) });
  }
  let peak = 1, dd = 0;
  for (const p of curve) { peak = Math.max(peak, p.equity); dd = Math.max(dd, (peak - p.equity) / peak); }
  return { taken: taken.length, finalReturnPct: round((equity - 1) * 100, 2), maxDrawdownPct: round(dd * 100, 2), curve };
}

export type ReplayVerdict = { verdict: "NO_EDGE" | "INCONCLUSIVE" | "PROMISING"; reasons: string[] };

/** Same bars as the live gate, applied to replayed executable trades. */
export function verdictFor(s: ReplayStats): ReplayVerdict {
  const reasons: string[] = [];
  if (s.trades < 30) return { verdict: "INCONCLUSIVE", reasons: [`Only ${s.trades} executable trades; need 30+ to judge.`] };
  if (s.avgNetPct <= 0) reasons.push(`Average trade after costs is ${s.avgNetPct}% (must be > 0).`);
  if (s.profitFactor < 1.2) reasons.push(`Profit factor ${s.profitFactor} (< 1.2).`);
  if (s.maxDrawdownPct > 25) reasons.push(`Sequential drawdown ${s.maxDrawdownPct}% (> 25%).`);
  if (reasons.length) return { verdict: "NO_EDGE", reasons };
  return { verdict: s.trades >= 100 && s.profitFactor >= 1.3 && s.avgNetPct >= 0.2 ? "PROMISING" : "INCONCLUSIVE", reasons: ["Positive after costs. Still requires forward (paper) confirmation — history can be overfit."] };
}


// ---------------- V5.5: filters, fill quality, chance of profit ----------------

export type ReplayFilters = { edgeGate: boolean; chaseFilter: boolean };

/** Drops trades the V5.5 executor filters would have refused. Approximate: a refused trade
 *  would also have freed that symbol for an earlier re-entry, which is not re-simulated. */
export function applyFilters<T extends Pick<ReplayTrade, "edgePass" | "chased">>(trades: T[], f: ReplayFilters) {
  return trades.filter((t) => (!f.edgeGate || t.edgePass !== false) && (!f.chaseFilter || !t.chased));
}

export function fillQuality(results: Array<Pick<ReplaySymbolResult, "makerAttempts" | "missed">>) {
  const attempts = results.reduce((s, r) => s + (r.makerAttempts ?? 0), 0);
  const missed = results.flatMap((r) => r.missed ?? []);
  const avgMissedNet = missed.length ? missed.reduce((s, m) => s + m.netPctAtTaker, 0) / missed.length : 0;
  return {
    attempts,
    missed: missed.length,
    fillRatePct: attempts ? round((1 - missed.length / attempts) * 100, 1) : 0,
    avgMissedNetAtTakerPct: round(avgMissedNet, 3),
    missedWinners: missed.filter((m) => m.netPctAtTaker > 0).length,
  };
}

export type FanStep = { i: number; p5: number; p25: number; p50: number; p75: number; p95: number };
export type ChanceOfProfit = { paths: number; horizon: number; pProfitPct: number; medianFinalPct: number; p5FinalPct: number; p95FinalPct: number; steps: FanStep[]; sample: number };

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap "chance of being in profit after the next N trades" from observed per-trade
 * net returns. Each trade risks one slot (1/3 of capital by default). Seeded, so the same
 * inputs always draw the same fan.
 */
export function chanceOfProfit(returnsPct: number[], opts: { horizon?: number; paths?: number; slotFraction?: number; seed?: number } = {}): ChanceOfProfit | null {
  const clean = returnsPct.filter((x) => Number.isFinite(x));
  if (clean.length < 10) return null;
  const horizon = opts.horizon ?? 100;
  const paths = opts.paths ?? 2000;
  const slot = opts.slotFraction ?? 1 / 3;
  const rand = mulberry32(opts.seed ?? 42);
  const byStep: number[][] = Array.from({ length: horizon + 1 }, () => new Array(paths));
  for (let p = 0; p < paths; p += 1) {
    let eq = 1;
    byStep[0][p] = 0;
    for (let i = 1; i <= horizon; i += 1) {
      eq *= 1 + slot * clean[Math.floor(rand() * clean.length)] / 100;
      byStep[i][p] = (eq - 1) * 100;
    }
  }
  const q = (sorted: number[], f: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(f * (sorted.length - 1))))];
  const stride = Math.max(1, Math.floor(horizon / 50));
  const steps: FanStep[] = [];
  for (let i = 0; i <= horizon; i += 1) {
    if (i % stride !== 0 && i !== horizon) continue;
    const sorted = [...byStep[i]].sort((a, b) => a - b);
    steps.push({ i, p5: round(q(sorted, 0.05), 2), p25: round(q(sorted, 0.25), 2), p50: round(q(sorted, 0.5), 2), p75: round(q(sorted, 0.75), 2), p95: round(q(sorted, 0.95), 2) });
  }
  const final = [...byStep[horizon]].sort((a, b) => a - b);
  return {
    paths, horizon, sample: clean.length,
    pProfitPct: round(final.filter((x) => x > 0).length / paths * 100, 1),
    medianFinalPct: round(q(final, 0.5), 2), p5FinalPct: round(q(final, 0.05), 2), p95FinalPct: round(q(final, 0.95), 2),
    steps,
  };
}
