// Decision funnel + agent activity log (V5.5). Pure functions over a scan and the
// execution report, so the cron, the desk and the tests all see the same story.
// Idea adopted from copy-trading dashboards: show what was scanned, what was killed
// and WHY, not just the few trades that got through.

import type { ScanResult, SymbolAnalysis } from "./types";

export type FunnelStage = { key: string; label: string; count: number | null; note: string };
export type SkipReason = { reason: string; count: number; examples: string[] };
export type Funnel = { at: string; stages: FunnelStage[]; reasons: SkipReason[] };

export const GATE_LABELS: Record<string, string> = {
  DATA_GATE_FAILED: "Price data not verified or stale",
  SCORE_BELOW_BUY_THRESHOLD: "Signal too weak",
  BASE_POLICY_WATCH: "Signal too weak",
  NEGATIVE_AGENT_SCORE: "Agents bearish",
  VOLATILITY_TOO_HIGH: "Too volatile",
  RISK_OFF_SCORE_TOO_LOW: "Risk-off market, signal not strong enough",
  BENCHMARK_UNVERIFIED: "Market benchmark unverified",
  EVENT_RISK_BLOCK: "Earnings / event too close",
  EVIDENCE_BELOW_MINIMUM: "Evidence too thin",
  ALL_STRATEGIES_RETIRED: "No strategy currently works on this symbol",
  CORRELATION_TOO_HIGH: "Too correlated with a holding",
  POSITION_SIZE_ZERO: "Risk rules size it to zero",
  EXISTING_POSITION_POLICY: "Already held",
};

const SCORE_GATES = new Set(["DATA_GATE_FAILED", "SCORE_BELOW_BUY_THRESHOLD", "BASE_POLICY_WATCH", "NEGATIVE_AGENT_SCORE", "VOLATILITY_TOO_HIGH", "RISK_OFF_SCORE_TOO_LOW", "EXISTING_POSITION_POLICY"]);

/** Normalises free-text executor skip reasons into a short category. */
export function executionSkipCategory(reason: string) {
  if (/^Edge gate/i.test(reason)) return "Edge gate: costs or win rate too thin";
  if (/^Chase filter/i.test(reason)) return "Chase filter: already ran up";
  if (/not VALIDATED/i.test(reason)) return "Asset class not validated for real money";
  if (/Max open positions/i.test(reason)) return "Max open positions reached";
  if (/Already holding/i.test(reason)) return "Already holding";
  if (/hard cap/i.test(reason)) return "Hard cap reached";
  if (/cannot buy one unit/i.test(reason)) return "Too small to buy one share";
  if (/credentials/i.test(reason)) return "Broker keys not configured";
  return reason.split(/[.:]/)[0].slice(0, 60);
}

function add(map: Map<string, SkipReason>, reason: string, example: string) {
  const e = map.get(reason) ?? { reason, count: 0, examples: [] };
  e.count += 1;
  if (e.examples.length < 4 && !e.examples.includes(example)) e.examples.push(example);
  map.set(reason, e);
}

export function buildFunnel(scan: Pick<ScanResult, "at" | "analyses" | "overnightPlan">, execution?: { decision?: { mode: string; newEntriesAllowed: boolean }; submitted: string[]; skipped: Array<{ symbol: string; reason: string }> } | null): Funnel {
  const analyses: SymbolAnalysis[] = scan.analyses ?? [];
  const reasons = new Map<string, SkipReason>();
  const verified = analyses.filter((a) => !a.gateReasons.includes("DATA_GATE_FAILED"));
  const strong = verified.filter((a) => a.action === "BUY_SETUP" || !a.gateReasons.some((g) => SCORE_GATES.has(g)));
  const buy = analyses.filter((a) => a.action === "BUY_SETUP");
  const planned = new Set((scan.overnightPlan?.orders ?? []).map((o) => o.symbol));

  for (const a of analyses) {
    if (a.action === "BUY_SETUP") continue;
    const first = a.gateReasons.find((g) => g !== "ALL_GATES_PASS");
    if (first) add(reasons, GATE_LABELS[first] ?? first, a.symbol);
  }
  for (const a of buy) if (!planned.has(a.symbol)) add(reasons, "Below the overnight confidence / evidence bar, or budget used", a.symbol);
  for (const s of execution?.skipped ?? []) add(reasons, executionSkipCategory(s.reason), s.symbol);

  const executed = execution && execution.decision && execution.decision.mode !== "OFF";
  const stages: FunnelStage[] = [
    { key: "scanned", label: "Scanned", count: analyses.length, note: "Stocks and crypto on the watchlist" },
    { key: "verified", label: "Verified data", count: verified.length, note: "Fresh, real prices (fails closed)" },
    { key: "strong", label: "Strong signal", count: strong.length, note: "Agents agree strongly enough" },
    { key: "gates", label: "Passed all gates", count: buy.length, note: "Evidence, events, correlation, sizing" },
    { key: "overnight", label: "Overnight plan", count: planned.size, note: "Confidence + evidence bar, £ budget" },
    { key: "orders", label: "Orders placed", count: executed ? execution!.submitted.length : null, note: executed ? `Edge gate, chase filter, caps · ${execution!.decision!.mode}` : "Execution is off" },
  ];
  return { at: scan.at, stages, reasons: [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 12) };
}

// ---------------- Agent activity log ----------------

export type AgentName = "SCOUT" | "FILTER" | "ANALYST" | "RISK" | "EXECUTOR" | "SYSTEM";
export type ActivityLine = { agent: AgentName; level: "info" | "good" | "warn" | "bad"; message: string };

export function buildActivity(scan: Pick<ScanResult, "analyses" | "overnightPlan" | "regime" | "cryptoRegime" | "dataHealth" | "warnings">, funnel: Funnel, execution?: { decision: { mode: string; newEntriesAllowed: boolean; reasons: string[] }; submitted: string[]; closed: string[]; skipped: Array<{ symbol: string; reason: string }>; errors: string[] } | null): ActivityLine[] {
  const lines: ActivityLine[] = [];
  const analyses = scan.analyses ?? [];
  const eq = scan.dataHealth?.equity;
  const cr = scan.dataHealth?.crypto;
  lines.push({ agent: "SCOUT", level: "info", message: `Scanned ${analyses.length} symbols · equity data ${eq ? `${eq.verified}/${eq.total}` : "?"} · crypto data ${cr ? `${cr.verified}/${cr.total}` : "?"} · regime ${scan.regime} / crypto ${scan.cryptoRegime}.` });
  for (const r of funnel.reasons.slice(0, 5)) lines.push({ agent: "FILTER", level: "warn", message: `Rejected ${r.count} · ${r.reason}${r.examples.length ? ` (e.g. ${r.examples.join(", ")})` : ""}` });

  const nearMisses = analyses.filter((a) => a.action !== "BUY_SETUP" && !a.gateReasons.includes("DATA_GATE_FAILED")).sort((a, b) => b.decisionScore - a.decisionScore).slice(0, 3);
  for (const a of nearMisses) lines.push({ agent: "ANALYST", level: "info", message: `${a.symbol} near miss · score ${a.decisionScore.toFixed(2)} (buy ≥ 0.46) · evidence ${a.decisionEvidenceScore} · ${GATE_LABELS[a.gateReasons[0]] ?? a.gateReasons[0] ?? ""}` });
  const planned = new Set((scan.overnightPlan?.orders ?? []).map((o) => o.symbol));
  for (const a of analyses.filter((x) => x.action === "BUY_SETUP")) {
    lines.push({ agent: "ANALYST", level: planned.has(a.symbol) ? "good" : "info", message: `${a.symbol} BUY_SETUP · score ${a.decisionScore.toFixed(2)} · evidence ${a.decisionEvidenceScore} · confidence ${a.decisionConfidence}% → ${planned.has(a.symbol) ? "passed to risk" : "held back by overnight bar"}` });
  }
  for (const o of scan.overnightPlan?.orders ?? []) lines.push({ agent: "RISK", level: "info", message: `${o.symbol} sized £${o.notionalGbp.toFixed(2)} · stop $${o.stopUsd} · target $${o.targetUsd}` });

  if (!execution || execution.decision.mode === "OFF") {
    lines.push({ agent: "EXECUTOR", level: "info", message: "Execution is off — research only, no orders sent." });
  } else {
    lines.push({ agent: "RISK", level: execution.decision.newEntriesAllowed ? "info" : "warn", message: `Mode ${execution.decision.mode} · new entries ${execution.decision.newEntriesAllowed ? "allowed" : "blocked"} · ${execution.decision.reasons[0] ?? ""}` });
    for (const s of execution.skipped) lines.push({ agent: "RISK", level: "warn", message: `${s.symbol} not traded · ${s.reason}` });
    for (const s of execution.submitted) lines.push({ agent: "EXECUTOR", level: "good", message: `Placed ${s}` });
    for (const c of execution.closed) lines.push({ agent: "EXECUTOR", level: /STOP/.test(c) ? "bad" : "good", message: `Closed ${c}` });
    for (const e of execution.errors) lines.push({ agent: "EXECUTOR", level: "bad", message: e });
  }
  for (const w of (scan.warnings ?? []).slice(0, 3)) lines.push({ agent: "SYSTEM", level: "warn", message: w });
  return lines.map((l) => ({ ...l, message: l.message.slice(0, 400) }));
}

// ---------------- Why it traded ----------------

export type TradeRationale = {
  symbol: string;
  score: number;
  evidence: number;
  confidence: number;
  regime: string;
  supporters: Array<{ name: string; score: number; why: string }>;
  objectors: Array<{ name: string; score: number; why: string }>;
  gates: string[];
  runUp5Pct: number | null;
  plan: { entry: number; stop: number; target: number; riskPct: number; rewardPct: number };
  edge: { costPct: number; costToRisk: number; breakevenWinRatePct: number; posteriorWinRatePct: number | null; expectedEdgePct: number | null };
  summary: string;
};

export function buildRationale(a: SymbolAnalysis | undefined, intent: { symbol: string; limitUsd: number; stopUsd: number; targetUsd: number; edge: { costPct: number; costToRisk: number; breakevenWinRate: number; posteriorWinRate: number | null; expectedEdgePct: number | null } }): TradeRationale {
  const votes = (a?.decisionVotes ?? []).filter((v) => ["trend", "momentum", "reversion", "breakout"].includes(v.id));
  const supporters = votes.filter((v) => v.score > 0.1).sort((x, y) => y.score - x.score).map((v) => ({ name: v.name, score: Number(v.score.toFixed(2)), why: v.rationale }));
  const objectors = votes.filter((v) => v.score < -0.1).sort((x, y) => x.score - y.score).map((v) => ({ name: v.name, score: Number(v.score.toFixed(2)), why: v.rationale }));
  const riskPct = (intent.limitUsd - intent.stopUsd) / intent.limitUsd * 100;
  const rewardPct = (intent.targetUsd - intent.limitUsd) / intent.limitUsd * 100;
  const names = supporters.map((s) => s.name.replace(" Agent", "")).join(" + ") || "the ensemble";
  return {
    symbol: intent.symbol,
    score: Number((a?.decisionScore ?? 0).toFixed(3)),
    evidence: a?.decisionEvidenceScore ?? 0,
    confidence: a?.decisionConfidence ?? 0,
    regime: a?.regime ?? "UNKNOWN",
    supporters, objectors,
    gates: a?.gateReasons ?? [],
    runUp5Pct: a?.indicators.return5Pct ?? null,
    plan: { entry: intent.limitUsd, stop: intent.stopUsd, target: intent.targetUsd, riskPct: Number(riskPct.toFixed(2)), rewardPct: Number(rewardPct.toFixed(2)) },
    edge: {
      costPct: intent.edge.costPct,
      costToRisk: intent.edge.costToRisk,
      breakevenWinRatePct: Number((intent.edge.breakevenWinRate * 100).toFixed(1)),
      posteriorWinRatePct: intent.edge.posteriorWinRate == null ? null : Number((intent.edge.posteriorWinRate * 100).toFixed(1)),
      expectedEdgePct: intent.edge.expectedEdgePct,
    },
    summary: `${names} agreed (score ${(a?.decisionScore ?? 0).toFixed(2)}, evidence ${a?.decisionEvidenceScore ?? "?"}) in a ${(a?.regime ?? "unknown").toLowerCase().replace("_", "-")} market. Risking ${riskPct.toFixed(1)}% to make ${rewardPct.toFixed(1)}%; costs ${intent.edge.costPct.toFixed(2)}% need ${(intent.edge.breakevenWinRate * 100).toFixed(0)}% wins to break even.`,
  };
}
