import { ENGINE } from "./config";
import type {
  AgentGovernance,
  AgentInfluenceCap,
  CounterfactualGateStat,
  EdgeDiagnostics,
  ForwardSignal,
  LearningAgentId,
  LossCluster,
  NearMissCohort,
  StopHorizonCalibration,
  SymbolAnalysis,
  ValidationSummary,
  WinnerLoserDifferential,
} from "./types";

const CORE: Array<{ id: LearningAgentId; name: string; intendedPct: number }> = [
  { id: "trend", name: "Trend Agent", intendedPct: 30 },
  { id: "momentum", name: "Momentum Agent", intendedPct: 28 },
  { id: "reversion", name: "Mean Reversion", intendedPct: 18 },
  { id: "breakout", name: "Breakout Agent", intendedPct: 24 },
];

function round(value: number, digits = 2) { const p = 10 ** digits; return Math.round(value * p) / p; }
function mean(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function nullableMean(values: Array<number | null | undefined>) {
  const clean = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return clean.length ? round(mean(clean), 2) : null;
}

function completed(validation?: ValidationSummary) {
  return (validation?.recent ?? []).filter((row) => row.outcome !== "PENDING" && row.returnPct != null);
}

export function evidenceCapPct(intendedPct: number, actionableCompleted: number) {
  if (actionableCompleted < 5) return intendedPct + 3;
  if (actionableCompleted < 10) return intendedPct + 5;
  if (actionableCompleted < 30) return intendedPct + 8;
  return 100;
}

export function capResearchWeights(weights: Record<LearningAgentId, number>, validation?: ValidationSummary) {
  const completedByAgent = new Map((validation?.agents ?? []).map((row) => [row.id, row.completedSignals]));
  const raw = { ...weights };
  for (const agent of CORE) {
    const n = completedByAgent.get(agent.id) ?? 0;
    const cap = evidenceCapPct(agent.intendedPct, n) / 100;
    raw[agent.id] = Math.min(raw[agent.id], cap);
  }
  const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v / sum])) as Record<LearningAgentId, number>;
}

function buildInfluenceCaps(governance: AgentGovernance, validation?: ValidationSummary): AgentInfluenceCap[] {
  const completedByAgent = new Map((validation?.agents ?? []).map((row) => [row.id, row.completedSignals]));
  return CORE.map((agent) => {
    const row = governance.rows.find((r) => r.id === agent.id);
    const completedSignals = completedByAgent.get(agent.id) ?? 0;
    const cap = evidenceCapPct(agent.intendedPct, completedSignals);
    const raw = row?.realizedInfluencePct ?? agent.intendedPct;
    const capped = Math.min(raw, cap);
    const mature = completedSignals >= 30;
    return {
      id: agent.id,
      name: agent.name,
      intendedInfluencePct: agent.intendedPct,
      rawRealizedInfluencePct: round(raw, 1),
      evidenceCapPct: round(cap, 1),
      cappedInfluencePct: round(capped, 1),
      actionableCompleted: completedSignals,
      status: mature ? "EVIDENCE_MATURE" : raw > cap ? "CAPPED" : "WITHIN_CAP",
      reason: mature
        ? "30+ completed actionable participations; diagnostic cap no longer constrains this specialist."
        : `${completedSignals} actionable completions; research influence is shrinkage-capped near intended weight until evidence matures.`,
    };
  });
}

function buildLossClusters(rows: ForwardSignal[]): LossCluster[] {
  const groups = new Map<string, ForwardSignal[]>();
  for (const row of rows) {
    const regime = row.autopsy?.quantRegime ?? "UNKNOWN";
    const key = `${row.assetClass}:${regime}:${row.outcome}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, items]) => {
    const wins = items.filter((x) => (x.returnPct ?? 0) > 0).length;
    const assetClass = items.every((x) => x.assetClass === items[0].assetClass) ? items[0].assetClass : "MIXED";
    const regimes = items.map((x) => x.autopsy?.quantRegime ?? "UNKNOWN");
    const regime = regimes.every((x) => x === regimes[0]) ? regimes[0] : "MIXED";
    const outcomes = items.map((x) => x.outcome);
    const outcome = outcomes.every((x) => x === outcomes[0]) ? outcomes[0] : "MIXED";
    return {
      key,
      label: `${assetClass} · ${regime.replaceAll("_", " ")} · ${outcome.replaceAll("_", " ")}`,
      trades: items.length,
      winRatePct: round((wins / items.length) * 100, 1),
      avgReturnPct: round(mean(items.map((x) => x.returnPct ?? 0)), 2),
      avgMfePct: nullableMean(items.map((x) => x.autopsy?.mfePct)),
      avgMaePct: nullableMean(items.map((x) => x.autopsy?.maePct)),
      assetClass,
      regime,
      outcome,
    } as LossCluster;
  }).sort((a, b) => a.avgReturnPct - b.avgReturnPct || b.trades - a.trades).slice(0, 12);
}

function differential(rows: ForwardSignal[]): WinnerLoserDifferential {
  const winners = rows.filter((x) => (x.returnPct ?? 0) > 0);
  const losers = rows.filter((x) => (x.returnPct ?? 0) <= 0);
  const result: WinnerLoserDifferential = {
    winners: winners.length,
    losers: losers.length,
    winnerAvgEvidence: nullableMean(winners.map((x) => x.evidenceScore)),
    loserAvgEvidence: nullableMean(losers.map((x) => x.evidenceScore)),
    winnerAvgConfidence: nullableMean(winners.map((x) => x.confidence)),
    loserAvgConfidence: nullableMean(losers.map((x) => x.confidence)),
    winnerAvgMfePct: nullableMean(winners.map((x) => x.autopsy?.mfePct)),
    loserAvgMfePct: nullableMean(losers.map((x) => x.autopsy?.mfePct)),
    winnerAvgMaePct: nullableMean(winners.map((x) => x.autopsy?.maePct)),
    loserAvgMaePct: nullableMean(losers.map((x) => x.autopsy?.maePct)),
    winnerAvgMicrostructure: nullableMean(winners.map((x) => x.autopsy?.microstructureScore)),
    loserAvgMicrostructure: nullableMean(losers.map((x) => x.autopsy?.microstructureScore)),
    observations: [],
  };
  if (rows.length < 6) result.observations.push("Actionable sample is still small; differentials are descriptive only.");
  if (result.loserAvgMfePct != null && result.loserAvgMfePct < 1) result.observations.push("Losing trades showed little favorable excursion, pointing more toward entry/direction quality than profit-taking.");
  if (result.loserAvgMaePct != null && result.loserAvgMaePct <= -5) result.observations.push("Losers experienced material adverse excursion; regime/entry filtering deserves priority before wider stops.");
  if (result.winnerAvgMicrostructure != null && result.loserAvgMicrostructure != null && result.winnerAvgMicrostructure - result.loserAvgMicrostructure >= 10) result.observations.push("Execution-quality context separated winners from losers in this sample; keep collecting live-book evidence.");
  return result;
}

function calibration(rows: ForwardSignal[]): StopHorizonCalibration {
  const stops = rows.filter((x) => x.outcome === "STOP");
  const targets = rows.filter((x) => x.outcome === "TARGET");
  const time = rows.filter((x) => x.outcome === "TIME_EXIT");
  const stopMfe = nullableMean(stops.map((x) => x.autopsy?.mfePct));
  const stopMae = nullableMean(stops.map((x) => x.autopsy?.maePct));
  const timeMfe = nullableMean(time.map((x) => x.autopsy?.mfePct));
  const timeMae = nullableMean(time.map((x) => x.autopsy?.maePct));
  let diagnosis: StopHorizonCalibration["diagnosis"] = "INSUFFICIENT";
  const notes: string[] = [];
  if (rows.length >= 3) {
    if (stops.length >= 2 && (stopMfe ?? 0) < 1.5 && (stopMae ?? 0) <= -4) {
      diagnosis = "DIRECTION_QUALITY";
      notes.push("Stopped trades had little favorable excursion before large adverse movement; widening stops would likely hide weak entries rather than fix them.");
    } else if (stops.length >= 2 && (stopMfe ?? 0) >= 3) {
      diagnosis = "STOP_GEOMETRY";
      notes.push("Stopped trades first achieved meaningful favorable excursion; stop placement/volatility scaling merits shadow-only testing.");
    } else if (time.length >= 2 && (timeMfe ?? 0) >= 3 && (nullableMean(time.map((x) => x.returnPct)) ?? 0) < 1) {
      diagnosis = "HORIZON_CAPTURE";
      notes.push("Time-exit trades gave back meaningful favorable excursion; alternate exit horizons deserve sandbox testing.");
    } else {
      diagnosis = "MIXED";
      notes.push("No single stop/horizon failure mode dominates the current actionable sample.");
    }
  } else notes.push("Need at least 3 completed actionable trades before stop/horizon diagnostics become minimally useful.");
  return {
    stopTrades: stops.length,
    targetTrades: targets.length,
    timeExitTrades: time.length,
    stopAvgReturnPct: nullableMean(stops.map((x) => x.returnPct)),
    timeExitAvgReturnPct: nullableMean(time.map((x) => x.returnPct)),
    stopAvgMfePct: stopMfe,
    stopAvgMaePct: stopMae,
    timeExitAvgMfePct: timeMfe,
    timeExitAvgMaePct: timeMae,
    diagnosis,
    notes,
  };
}

function buildNearMisses(analyses: SymbolAnalysis[], historical: CounterfactualGateStat[]): NearMissCohort[] {
  const groups = new Map<string, SymbolAnalysis[]>();
  for (const analysis of analyses) {
    if (analysis.action !== "WATCH") continue;
    const gate = analysis.gateReasons.find((reason) => reason !== "ALL_GATES_PASS") ?? "WATCH_UNCLASSIFIED";
    groups.set(gate, [...(groups.get(gate) ?? []), analysis]);
  }
  const hist = new Map(historical.map((x) => [x.reason, x]));
  return [...groups.entries()].map(([gate, rows]) => {
    const h = hist.get(gate);
    const sorted = [...rows].sort((a, b) => b.decisionScore - a.decisionScore);
    return {
      gate,
      count: rows.length,
      avgDecisionScore: round(mean(rows.map((x) => x.decisionScore)), 3),
      avgEvidenceScore: round(mean(rows.map((x) => x.decisionEvidenceScore)), 1),
      avgConfidence: round(mean(rows.map((x) => x.decisionConfidence)), 1),
      avgGapToBuyThreshold: round(mean(rows.map((x) => Math.max(0, ENGINE.buyThreshold - x.decisionScore))), 3),
      topSymbols: sorted.slice(0, 5).map((x) => x.symbol),
      historicalCompleted: h?.completed ?? 0,
      historicalAvgReturnPct: h?.completed ? h.avgReturnPct : null,
      verdict: (h?.verdict ?? "UNSEEN") as NearMissCohort["verdict"],
    };
  }).sort((a, b) => a.avgGapToBuyThreshold - b.avgGapToBuyThreshold || b.count - a.count).slice(0, 10);
}

export function buildEdgeDiagnostics(args: { analyses: SymbolAnalysis[]; governance: AgentGovernance; validation?: ValidationSummary; counterfactual: CounterfactualGateStat[] }): EdgeDiagnostics {
  const rows = completed(args.validation);
  return {
    generatedAt: new Date().toISOString(),
    authority: "RESEARCH_ONLY",
    influenceCaps: buildInfluenceCaps(args.governance, args.validation),
    lossClusters: buildLossClusters(rows),
    differential: differential(rows),
    calibration: calibration(rows),
    nearMisses: buildNearMisses(args.analyses, args.counterfactual),
    notes: [
      "V5.2.1 Edge Diagnostics is observational: it does not lower BUY thresholds, widen stops, change the £50 cap or place orders.",
      "Near-miss cohorts accelerate learning by observation only. Historical counterfactual outcomes determine whether a gate protected capital.",
      "Influence caps apply to research challengers until actionable participation matures; production decision authority remains governed by the existing validated policy rules.",
    ],
  };
}
