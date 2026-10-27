import test from "node:test";
import assert from "node:assert/strict";
import { buildActivity, buildFunnel, buildRationale, executionSkipCategory } from "../lib/engine/funnel";
import { applyFilters, chanceOfProfit, fillQuality } from "../lib/engine/replay-stats";
import { simulateExecutable } from "../lib/engine/replay";
import type { PriceBar } from "../lib/engine/types";

const A = (symbol: string, action: string, gateReasons: string[], score = 0.3) => ({
  symbol, action, gateReasons, decisionScore: score, decisionEvidenceScore: 60, decisionConfidence: 65, regime: "RISK_ON",
  indicators: { return5Pct: 3 }, decisionVotes: [
    { id: "trend", name: "Trend Agent", score: 0.6, confidence: 80, rationale: "above 50D", weight: 0.3 },
    { id: "reversion", name: "Reversion Agent", score: -0.3, confidence: 60, rationale: "stretched", weight: 0.2 },
  ],
}) as any;

const scan = {
  at: "2026-10-26T02:20:00Z",
  analyses: [
    A("AAA", "AVOID", ["DATA_GATE_FAILED"]), A("BBB", "WATCH", ["SCORE_BELOW_BUY_THRESHOLD"], 0.41), A("CCC", "WATCH", ["SCORE_BELOW_BUY_THRESHOLD"]),
    A("DDD", "WATCH", ["EVIDENCE_BELOW_MINIMUM"], 0.5), A("EEE", "BUY_SETUP", ["ALL_GATES_PASS"], 0.6), A("FFF", "BUY_SETUP", ["ALL_GATES_PASS"], 0.55),
  ],
  overnightPlan: { orders: [{ symbol: "EEE", notionalGbp: 16, stopUsd: 9, targetUsd: 11 }] },
  regime: "RISK_ON", cryptoRegime: "MIXED", dataHealth: { equity: { verified: 5, total: 6 }, crypto: { verified: 0, total: 0 } }, warnings: [],
} as any;

test("funnel counts each stage and ranks skip reasons", () => {
  const f = buildFunnel(scan, { decision: { mode: "PAPER", newEntriesAllowed: true }, submitted: [], skipped: [{ symbol: "EEE", reason: "Edge gate: Costs 1.25% eat 40% of the 3% stop distance" }] });
  assert.deepEqual(f.stages.map((s) => s.count), [6, 5, 3, 2, 1, 0]);
  const reasons = Object.fromEntries(f.reasons.map((r) => [r.reason, r.count]));
  assert.equal(reasons["Signal too weak"], 2);
  assert.equal(reasons["Price data not verified or stale"], 1);
  assert.equal(reasons["Evidence too thin"], 1);
  assert.equal(reasons["Edge gate: costs or win rate too thin"], 1);
  assert.equal(f.reasons[0].reason, "Signal too weak");
  assert.equal(buildFunnel(scan, null).stages.at(-1)!.count, null);
});

test("activity log narrates the run per agent", () => {
  const f = buildFunnel(scan, null);
  const lines = buildActivity(scan, f, null);
  const agents = new Set(lines.map((l) => l.agent));
  for (const a of ["SCOUT", "FILTER", "ANALYST", "RISK", "EXECUTOR"]) assert.ok(agents.has(a as any), a);
  assert.ok(lines.some((l) => /EEE BUY_SETUP.*passed to risk/.test(l.message)));
  assert.ok(lines.some((l) => /FFF BUY_SETUP.*held back/.test(l.message)));
  assert.ok(lines.some((l) => /BBB near miss/.test(l.message)), "highest-scoring rejection is a near miss");
});

test("skip categories and rationale", () => {
  assert.equal(executionSkipCategory("Chase filter: already up 25.0% in 5 bars."), "Chase filter: already ran up");
  assert.equal(executionSkipCategory("CRYPTO is not VALIDATED at realistic broker costs."), "Asset class not validated for real money");
  const r = buildRationale(scan.analyses[4], { symbol: "EEE", limitUsd: 10, stopUsd: 9.4, targetUsd: 11.2, edge: { costPct: 1.25, costToRisk: 0.2, breakevenWinRate: 0.4, posteriorWinRate: null, expectedEdgePct: null } });
  assert.equal(r.supporters[0].name, "Trend Agent");
  assert.equal(r.objectors[0].name, "Reversion Agent");
  assert.equal(r.plan.riskPct, 6);
  assert.match(r.summary, /Trend agreed/);
});

test("chance of profit is deterministic and sensible", () => {
  const good = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? -2 : 3));
  const bad = good.map((x) => x - 3);
  const a = chanceOfProfit(good)!; const b = chanceOfProfit(good)!;
  assert.deepEqual(a, b);
  assert.ok(a.pProfitPct > 95, String(a.pProfitPct));
  assert.ok(chanceOfProfit(bad)!.pProfitPct < 5);
  assert.equal(chanceOfProfit([1, 2, 3]), null);
  const last = a.steps.at(-1)!;
  assert.ok(last.p5 <= last.p25 && last.p25 <= last.p50 && last.p50 <= last.p75 && last.p75 <= last.p95);
});

test("filters and fill quality", () => {
  const t = [{ edgePass: true, chased: false }, { edgePass: false, chased: false }, { edgePass: true, chased: true }, { chased: false }] as any[];
  assert.equal(applyFilters(t, { edgeGate: true, chaseFilter: true }).length, 2);
  assert.equal(applyFilters(t, { edgeGate: false, chaseFilter: false }).length, 4);
  const q = fillQuality([{ makerAttempts: 10, missed: [{ netPctAtTaker: 2 }, { netPctAtTaker: -1 }] as any }, { makerAttempts: 0, missed: [] }]);
  assert.equal(q.fillRatePct, 80); assert.equal(q.missedWinners, 1); assert.equal(q.avgMissedNetAtTakerPct, 0.5);
});

test("missed maker fill has a market-entry counterfactual", () => {
  const bar = (date: string, open: number, high: number, low: number, close: number): PriceBar => ({ date, open, high, low, close, volume: 1 });
  const bars = [bar("d0", 100, 100, 100, 100), bar("d1", 100, 105, 99.9, 104), bar("d2", 104, 113, 103, 112), bar("d3", 112, 114, 111, 113)];
  assert.equal(simulateExecutable(bars, 0, { entry: 100, stop: 94, target: 112 }, "CRYPTO", 5), null, "maker limit 99.8 never touched");
  const cf = simulateExecutable(bars, 0, { entry: 100, stop: 94, target: 112 }, "CRYPTO", 5, "market")!;
  assert.equal(cf.entry, 100); assert.equal(cf.outcome, "TARGET"); assert.equal(cf.exit, 112);
});
