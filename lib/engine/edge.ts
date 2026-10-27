// Edge-after-costs gate and chase filter (V5.5). Pure functions shared by the live
// executor, the historical replay and the desk UI, so all three judge trades identically.
//
// Idea adopted from the "posterior gate" in high-frequency prediction-market bots:
// only act when the expected edge clears costs PLUS a margin for uncertainty.

import { BROKER_ROUND_TRIP_BPS } from "./config";
import type { AssetClass } from "./types";

export const EDGE_GATE = {
  /** Round-trip cost may use at most this share of the stop distance. */
  maxCostToRisk: 0.25,
  /** Below this many settled trades, only the cost-to-risk rule applies. */
  minSamplesForPosterior: 30,
  /** Beta prior on the win rate: mean 1/3 (what a 2R target implies with no edge), weight 12. */
  priorWins: 4,
  priorLosses: 8,
  /** How many posterior standard deviations to subtract (uncertainty margin). */
  z: 1,
} as const;

/** Skip entries that already ran up this much over the last 5 bars (don't chase). */
export const CHASE_FILTER = { EQUITY: 10, CRYPTO: 20 } as const;

export type WinStats = { wins: number; n: number };

export type TradeEdge = {
  riskPct: number;
  rewardPct: number;
  costPct: number;
  costToRisk: number;
  breakevenWinRate: number;
  posteriorWinRate: number | null;
  posteriorWinRateLow: number | null;
  expectedEdgePct: number | null;
  expectedEdgeLowPct: number | null;
  pass: boolean;
  reasons: string[];
};

function r(v: number, d = 4) {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

export function tradeEdge(input: { entry: number; stop: number; target: number; assetClass: AssetClass; costBps?: number; stats?: WinStats | null }): TradeEdge {
  const costBps = input.costBps ?? BROKER_ROUND_TRIP_BPS[input.assetClass];
  const riskPct = ((input.entry - input.stop) / input.entry) * 100;
  const rewardPct = ((input.target - input.entry) / input.entry) * 100;
  const costPct = costBps / 100;
  const reasons: string[] = [];
  if (!(riskPct > 0) || !(rewardPct > 0)) {
    return { riskPct: r(riskPct), rewardPct: r(rewardPct), costPct, costToRisk: Infinity, breakevenWinRate: 1, posteriorWinRate: null, posteriorWinRateLow: null, expectedEdgePct: null, expectedEdgeLowPct: null, pass: false, reasons: ["Invalid stop/target geometry."] };
  }
  const costToRisk = costPct / riskPct;
  // Win when the target is hit (+reward − cost), lose at the stop (−risk − cost):
  // p·R − (1−p)·S − C = 0  →  p* = (S + C) / (R + S)
  const breakevenWinRate = (riskPct + costPct) / (rewardPct + riskPct);
  let pass = true;
  if (costToRisk > EDGE_GATE.maxCostToRisk) {
    pass = false;
    reasons.push(`Costs ${costPct.toFixed(2)}% eat ${(costToRisk * 100).toFixed(0)}% of the ${riskPct.toFixed(2)}% stop distance (max ${(EDGE_GATE.maxCostToRisk * 100).toFixed(0)}%).`);
  }

  let posteriorWinRate: number | null = null;
  let posteriorWinRateLow: number | null = null;
  let expectedEdgePct: number | null = null;
  let expectedEdgeLowPct: number | null = null;
  const stats = input.stats;
  if (stats && stats.n > 0) {
    const a = EDGE_GATE.priorWins + stats.wins;
    const b = EDGE_GATE.priorLosses + (stats.n - stats.wins);
    const mean = a / (a + b);
    const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
    posteriorWinRate = mean;
    posteriorWinRateLow = Math.max(0, mean - EDGE_GATE.z * sd);
    const ev = (p: number) => p * rewardPct - (1 - p) * riskPct - costPct;
    expectedEdgePct = ev(mean);
    expectedEdgeLowPct = ev(posteriorWinRateLow);
    if (stats.n >= EDGE_GATE.minSamplesForPosterior && expectedEdgeLowPct <= 0) {
      pass = false;
      reasons.push(`Win rate lower bound ${(posteriorWinRateLow * 100).toFixed(1)}% is below the ${(breakevenWinRate * 100).toFixed(1)}% this trade needs after costs.`);
    }
  }
  if (pass) reasons.push(`Edge clears costs: needs ${(breakevenWinRate * 100).toFixed(1)}% wins; costs are ${(costToRisk * 100).toFixed(0)}% of risk.`);
  return {
    riskPct: r(riskPct), rewardPct: r(rewardPct), costPct, costToRisk: r(costToRisk), breakevenWinRate: r(breakevenWinRate),
    posteriorWinRate: posteriorWinRate == null ? null : r(posteriorWinRate),
    posteriorWinRateLow: posteriorWinRateLow == null ? null : r(posteriorWinRateLow),
    expectedEdgePct: expectedEdgePct == null ? null : r(expectedEdgePct),
    expectedEdgeLowPct: expectedEdgeLowPct == null ? null : r(expectedEdgeLowPct),
    pass, reasons,
  };
}

export function chased(assetClass: AssetClass, return5Pct: number | null | undefined, threshold: number = CHASE_FILTER[assetClass]) {
  return return5Pct != null && return5Pct >= threshold;
}

export function readFilterFlags(env: Record<string, string | undefined> = process.env) {
  const off = (v: string | undefined) => ["0", "off", "false", "no"].includes((v ?? "").trim().toLowerCase());
  return { edgeGate: !off(env.EDGE_GATE), chaseFilter: !off(env.CHASE_FILTER) };
}
