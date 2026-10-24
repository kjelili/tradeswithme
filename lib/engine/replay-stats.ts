// Pure replay types, costs and aggregation. No engine imports, so it is safe to bundle
// into the client-side replay panel.

import type { AssetClass, MarketSource } from "./types";

const ROUND_TRIP_LEDGER_BPS = 16; // keep in sync with ENGINE.roundTripCostBps (asserted in tests)

export type ReplayCosts = { equityRoundTripBps: number; cryptoRoundTripBps: number };

/**
 * Realistic default costs. Kraken Pro tier-1 taker is 0.80% per side (market buy,
 * market/stop sell) plus ~10 bps slippage; Alpaca US equities are commission-free with
 * a few bps of spread. The forward ledger itself only deducts ROUND_TRIP_LEDGER_BPS.
 */
export const REALISTIC_COSTS: ReplayCosts = { equityRoundTripBps: 10, cryptoRoundTripBps: 170 };
export const LEDGER_COSTS: ReplayCosts = { equityRoundTripBps: ROUND_TRIP_LEDGER_BPS, cryptoRoundTripBps: ROUND_TRIP_LEDGER_BPS };

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
};

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
