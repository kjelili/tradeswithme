import { ENGINE } from "./config";
import type {
  AgentConflict,
  AgentGovernance,
  DiscoveryGovernance,
  FailureReplayLab,
  GovernanceCandidate,
  GovernanceFamily,
  LearningAgentId,
  LearningPolicy,
  ParetoFrontier,
  QuantIntelligence,
  ReplayCase,
  StrategyDiversityArchive,
  SymbolAnalysis,
  ValidationSummary,
} from "./types";

const CORE: Array<{ id: LearningAgentId; name: string; base: number; family: GovernanceFamily }> = [
  { id: "trend", name: "Trend Agent", base: 0.30, family: "TREND" },
  { id: "momentum", name: "Momentum Agent", base: 0.28, family: "MOMENTUM" },
  { id: "reversion", name: "Mean Reversion", base: 0.18, family: "REVERSION" },
  { id: "breakout", name: "Breakout Agent", base: 0.24, family: "BREAKOUT" },
];

function clamp(value: number, min = 0, max = 100) { return Math.max(min, Math.min(max, value)); }
function round(value: number, digits = 1) { const p = 10 ** digits; return Math.round(value * p) / p; }
function mean(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }

function normalize(weights: Record<LearningAgentId, number>) {
  const sum = Object.values(weights).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, Math.max(0, v) / sum])) as Record<LearningAgentId, number>;
}

function baselineWeights() {
  return normalize(Object.fromEntries(CORE.map((x) => [x.id, x.base])) as Record<LearningAgentId, number>);
}

function learnedWeights(policy?: LearningPolicy) {
  const rows = policy?.segments?.GLOBAL?.agents ?? [];
  if (!rows.length) return baselineWeights();
  return normalize(Object.fromEntries(rows.map((row) => [row.id, row.learnedWeight])) as Record<LearningAgentId, number>);
}

function variantSet(policy?: LearningPolicy) {
  const base = baselineWeights();
  const learned = learnedWeights(policy);
  const anchor = policy?.decisionWeightsActive ? learned : base;
  const variants: Array<{ id: string; name: string; family: GovernanceFamily; weights: Record<LearningAgentId, number>; notes: string[] }> = [
    { id: "champion", name: policy?.decisionWeightsActive ? "Validated Learned Champion" : "Baseline Champion", family: "BASELINE", weights: anchor, notes: ["Current decision-policy champion; hard safety gates remain external."] },
    { id: "trend_elite", name: "Trend Elite", family: "TREND", weights: normalize({ ...anchor, trend: anchor.trend * 1.22, reversion: anchor.reversion * 0.88 }), notes: ["Bounded trend tilt; research sandbox only."] },
    { id: "momentum_elite", name: "Momentum Elite", family: "MOMENTUM", weights: normalize({ ...anchor, momentum: anchor.momentum * 1.22, breakout: anchor.breakout * 0.92 }), notes: ["Bounded momentum tilt; research sandbox only."] },
    { id: "defensive_reversion", name: "Defensive Reversion", family: "REVERSION", weights: normalize({ ...anchor, reversion: anchor.reversion * 1.28, momentum: anchor.momentum * 0.88 }), notes: ["Bounded mean-reversion tilt; research sandbox only."] },
    { id: "breakout_elite", name: "Breakout Elite", family: "BREAKOUT", weights: normalize({ ...anchor, breakout: anchor.breakout * 1.24, trend: anchor.trend * 0.94 }), notes: ["Bounded breakout tilt; research sandbox only."] },
    { id: "balanced_low_variance", name: "Balanced Low-Variance", family: "BALANCED", weights: normalize({ trend: 0.27, momentum: 0.25, reversion: 0.23, breakout: 0.25 }), notes: ["Diversified challenger designed to reduce single-agent concentration."] },
  ];
  return variants;
}

function strategyRobustness(quant: QuantIntelligence, id: LearningAgentId) {
  const cells = quant.robustness.cells.filter((cell) => cell.strategy === id && cell.observations >= 4 && [5, 10, 20].includes(cell.horizonBars));
  return cells.length ? mean(cells.map((cell) => cell.score)) : 45;
}

function tailRiskScore(quant: QuantIntelligence, weights: Record<LearningAgentId, number>) {
  const mc = quant.monteCarlo;
  if (!mc.paths) return 35;
  const risk = 100 - mc.riskOfRuin10Pct * 2.4 - Math.max(0, mc.p95MaxDrawdownPct - 10) * 1.6 - Math.max(0, -mc.expectedShortfall95Pct - 8) * 1.2;
  const concentrationPenalty = Math.max(0, Math.max(...Object.values(weights)) - 0.36) * 100;
  return clamp(risk - concentrationPenalty);
}

function concentrationScore(weights: Record<LearningAgentId, number>) {
  const hhi = Object.values(weights).reduce((sum, value) => sum + value * value, 0);
  return clamp(100 - Math.max(0, hhi - 0.25) * 260);
}

function paretoFrontier(candidates: GovernanceCandidate[]): ParetoFrontier {
  const dominated = new Set<string>();
  for (const candidate of candidates) {
    for (const other of candidates) {
      if (candidate.id === other.id) continue;
      const atLeast = other.robustnessScore >= candidate.robustnessScore && other.tailRiskScore >= candidate.tailRiskScore && other.concentrationScore >= candidate.concentrationScore;
      const better = other.robustnessScore > candidate.robustnessScore || other.tailRiskScore > candidate.tailRiskScore || other.concentrationScore > candidate.concentrationScore;
      if (atLeast && better) { dominated.add(candidate.id); break; }
    }
  }
  return {
    candidateIds: candidates.filter((candidate) => !dominated.has(candidate.id)).map((candidate) => candidate.id),
    dominatedIds: [...dominated],
    objectives: ["maximize robustness", "maximize tail-risk resilience", "minimize strategy concentration"],
    notes: ["Pareto candidates must improve at least one objective without being strictly worse on all others.", "Raw return is intentionally not a stand-alone promotion objective."],
  };
}

function buildDiversity(candidates: GovernanceCandidate[]): StrategyDiversityArchive {
  const families = new Map<GovernanceFamily, GovernanceCandidate[]>();
  for (const candidate of candidates) families.set(candidate.family, [...(families.get(candidate.family) ?? []), candidate]);
  const cells = [...families.entries()].map(([family, rows]) => {
    const best = [...rows].sort((a, b) => b.compositeScore - a.compositeScore)[0];
    return { family, candidates: rows.length, bestCandidateId: best.id, bestScore: best.compositeScore };
  });
  const represented = cells.length;
  return {
    diversityScore: Math.round(clamp((represented / 6) * 100)),
    familiesRepresented: represented,
    duplicateRejected: 0,
    cells,
    notes: ["MAP-Elites-inspired archive keeps separate strategy families instead of allowing near-identical momentum variants to dominate discovery.", "Near-duplicate candidates are intended to be rejected before any future promotion stage."],
  };
}

function candidateDecisionScore(signal: ValidationSummary["recent"][number], weights: Record<LearningAgentId, number>) {
  const coreVotes = signal.agentSnapshot.filter((vote) => CORE.some((agent) => agent.id === vote.id));
  if (!coreVotes.length) return signal.score;
  let weighted = 0;
  let total = 0;
  for (const vote of coreVotes) {
    const id = vote.id as LearningAgentId;
    const w = weights[id] ?? 0;
    weighted += vote.score * w;
    total += w;
  }
  return total ? weighted / total : signal.score;
}

function replayCandidate(candidate: GovernanceCandidate, validation?: ValidationSummary): FailureReplayLab {
  const rows = (validation?.recent ?? []).filter((signal) => signal.outcome !== "PENDING" && signal.returnPct != null);
  const cases: ReplayCase[] = rows.slice(0, 24).map((signal) => {
    const challengerScore = candidateDecisionScore(signal, candidate.weights);
    const wouldBuy = challengerScore >= ENGINE.buyThreshold;
    const win = (signal.returnPct ?? 0) > 0;
    const result = win ? (wouldBuy ? "RETAINED_WINNER" : "MISSED_WINNER") : (wouldBuy ? "REPEATED_LOSS" : "AVOIDED_LOSS");
    return {
      signalId: signal.id,
      symbol: signal.symbol,
      outcome: signal.outcome,
      actualReturnPct: round(signal.returnPct ?? 0, 3),
      frozenDecisionScore: round(signal.score, 3),
      challengerDecisionScore: round(challengerScore, 3),
      challengerWouldBuy: wouldBuy,
      result,
      rationale: result === "RETAINED_WINNER" ? "Challenger keeps a historically profitable frozen setup." : result === "AVOIDED_LOSS" ? "Challenger would have filtered a completed losing setup." : result === "MISSED_WINNER" ? "Regression risk: challenger would reject a completed winner." : "Challenger repeats a completed loss; no regression improvement on this case.",
    };
  });
  const retained = cases.filter((x) => x.result === "RETAINED_WINNER").length;
  const avoided = cases.filter((x) => x.result === "AVOIDED_LOSS").length;
  const missed = cases.filter((x) => x.result === "MISSED_WINNER").length;
  const repeated = cases.filter((x) => x.result === "REPEATED_LOSS").length;
  const score = cases.length ? clamp(((retained + avoided) - (missed * 1.25 + repeated * 0.75)) / cases.length * 100 + 50) : 50;
  return {
    candidateId: candidate.id,
    candidateName: candidate.name,
    completedCases: cases.length,
    winnersRetained: retained,
    lossesAvoided: avoided,
    winnersMissed: missed,
    lossesRepeated: repeated,
    replayScore: round(score, 1),
    cases,
    notes: ["Replay uses the frozen agent votes that existed before each outcome was known; it does not use future bars as model inputs.", "Replay is a regression diagnostic, not proof that a challenger would have received the same fill in live trading."],
  };
}

function buildAgentGovernance(analyses: SymbolAnalysis[], quant: QuantIntelligence, validation?: ValidationSummary): AgentGovernance {
  const totalContribution: Record<string, number> = Object.fromEntries(CORE.map((x) => [x.id, 0]));
  const blockers: Record<string, number> = Object.fromEntries(CORE.map((x) => [x.id, 0]));
  const conflicts: AgentConflict[] = [];
  for (const analysis of analyses) {
    const coreVotes = analysis.decisionVotes.filter((vote) => CORE.some((agent) => agent.id === vote.id));
    const denominator = coreVotes.reduce((sum, vote) => sum + Math.abs(vote.score * (vote.weight || 1)), 0) || 1;
    for (const vote of coreVotes) {
      totalContribution[vote.id] = (totalContribution[vote.id] ?? 0) + Math.abs(vote.score * (vote.weight || 1)) / denominator;
      if (vote.score > 0.15 && analysis.action !== "BUY_SETUP" && analysis.gateReasons.some((reason) => reason !== "SCORE_BELOW_BUY_THRESHOLD")) blockers[vote.id] = (blockers[vote.id] ?? 0) + 1;
    }
    const supporters = analysis.decisionVotes.filter((vote) => vote.score >= 0.18).map((vote) => vote.name);
    const objectors = analysis.decisionVotes.filter((vote) => vote.score <= -0.18).map((vote) => vote.name);
    if (supporters.length && objectors.length) {
      const hi = Math.max(...analysis.decisionVotes.map((vote) => vote.score));
      const lo = Math.min(...analysis.decisionVotes.map((vote) => vote.score));
      conflicts.push({ symbol: analysis.symbol, supporters, objectors, dominantBlocker: analysis.gateReasons[0] ?? null, conflictScore: round(clamp((hi - lo) * 55), 0), finalAction: analysis.action });
    }
  }
  const totalAcross = Object.values(totalContribution).reduce((a, b) => a + b, 0) || 1;
  const forward = new Map((validation?.agents ?? []).map((row) => [row.id, row]));
  const base = baselineWeights();
  const rows = CORE.map((agent) => {
    const realized = (totalContribution[agent.id] ?? 0) / totalAcross * 100;
    const intended = base[agent.id] * 100;
    const stat = forward.get(agent.id);
    const delta = realized - intended;
    const status = !stat?.completedSignals ? (Math.abs(delta) > 10 ? "SUPPRESSED" : "UNPROVEN") : (stat.avgReturnPct > 0.2 && delta > -10 ? "EFFECTIVE" : stat.avgReturnPct < -0.2 ? "MIXED" : "UNPROVEN");
    return { id: agent.id, name: agent.name, intendedInfluencePct: round(intended, 1), realizedInfluencePct: round(realized, 1), actionableCompleted: stat?.completedSignals ?? 0, actionableAvgReturnPct: stat?.completedSignals ? stat.avgReturnPct : null, blockerTouches: blockers[agent.id] ?? 0, status } as const;
  });
  return {
    rows,
    conflicts: conflicts.sort((a, b) => b.conflictScore - a.conflictScore).slice(0, 8),
    gateValue: quant.counterfactual.gates.slice(0, 8).map((gate) => ({ reason: gate.reason, completed: gate.completed, avgReturnPct: gate.avgReturnPct, verdict: gate.verdict })),
    notes: ["Realized influence estimates how much of the current ensemble's absolute core-agent vote mass each specialist contributes.", "Blocker touches flag cases where an agent was positive but an external gate prevented an actionable setup; counterfactual outcomes later determine whether that gate added value."],
  };
}

export function buildDiscoveryGovernance(args: { analyses: SymbolAnalysis[]; quant: QuantIntelligence; learning?: LearningPolicy; validation?: ValidationSummary }): DiscoveryGovernance {
  const variants = variantSet(args.learning);
  const candidates: GovernanceCandidate[] = variants.map((variant) => {
    const robustnessScore = round(CORE.reduce((sum, agent) => sum + strategyRobustness(args.quant, agent.id) * variant.weights[agent.id], 0), 1);
    const tail = round(tailRiskScore(args.quant, variant.weights), 1);
    const concentration = round(concentrationScore(variant.weights), 1);
    return { id: variant.id, name: variant.name, family: variant.family, weights: variant.weights, robustnessScore, tailRiskScore: tail, concentrationScore: concentration, replayScore: null, compositeScore: round(robustnessScore * 0.5 + tail * 0.3 + concentration * 0.2, 1), paretoEfficient: false, status: variant.id === "champion" ? "CHAMPION" : "DOMINATED", notes: variant.notes };
  });
  const pareto = paretoFrontier(candidates);
  for (const candidate of candidates) {
    candidate.paretoEfficient = pareto.candidateIds.includes(candidate.id);
    if (candidate.id !== "champion") candidate.status = candidate.paretoEfficient ? "PARETO" : "DOMINATED";
  }
  const diversity = buildDiversity(candidates);
  const challenger = [...candidates].filter((x) => x.id !== "champion" && x.paretoEfficient).sort((a, b) => b.compositeScore - a.compositeScore)[0] ?? candidates[0];
  const replay = replayCandidate(challenger, args.validation);
  const agentGovernance = buildAgentGovernance(args.analyses, args.quant, args.validation);
  const champion = candidates.find((x) => x.id === "champion")!;
  const replayEligible = replay.completedCases < 5 || replay.replayScore >= 55;
  const leader = challenger.id !== "champion" && challenger.compositeScore >= champion.compositeScore + 2 && replayEligible ? challenger : null;
  return {
    generatedAt: new Date().toISOString(), authority: "RESEARCH_ONLY", candidates, diversity, pareto, replay, agentGovernance,
    promotionStatus: leader ? "SHADOW_LEADER" : "NO_PROMOTION", shadowLeaderId: leader?.id ?? null,
    notes: ["Discovery candidates are bounded and isolated from risk caps, live execution, event gates and data gates.", "A Pareto/shadow leader never auto-promotes. Promotion requires future actionable evidence plus replay/regression safety checks.", "V5.2 governance is scientific research infrastructure, not a promise that a strategy has an edge."],
  };
}

export function refreshDiscoveryGovernance(governance: DiscoveryGovernance | undefined, analyses: SymbolAnalysis[], quant: QuantIntelligence | undefined, validation: ValidationSummary | undefined) {
  if (!governance || !quant) return governance;
  const candidates = governance.candidates.map((candidate) => {
    const replay = replayCandidate(candidate, validation);
    const composite = round(candidate.robustnessScore * 0.42 + candidate.tailRiskScore * 0.23 + candidate.concentrationScore * 0.15 + replay.replayScore * 0.20, 1);
    return { ...candidate, replayScore: replay.replayScore, compositeScore: composite, status: replay.completedCases >= 5 && replay.replayScore < 45 ? "REPLAY_RISK" as const : candidate.status };
  });
  const pareto = paretoFrontier(candidates.filter((candidate) => candidate.status !== "REPLAY_RISK"));
  for (const candidate of candidates) candidate.paretoEfficient = pareto.candidateIds.includes(candidate.id);
  const diversity = buildDiversity(candidates);
  const champion = candidates.find((x) => x.id === "champion") ?? candidates[0];
  const leader = candidates.filter((x) => x.id !== "champion" && x.status !== "REPLAY_RISK" && x.paretoEfficient).sort((a, b) => b.compositeScore - a.compositeScore)[0] ?? null;
  const replay = replayCandidate(leader ?? champion, validation);
  const promotion = leader && leader.compositeScore >= champion.compositeScore + 2.5 && replay.completedCases >= 10 && replay.replayScore >= 60 ? "SHADOW_LEADER" as const : "NO_PROMOTION" as const;
  return { ...governance, candidates, diversity, pareto, replay, agentGovernance: buildAgentGovernance(analyses, quant, validation), promotionStatus: promotion, shadowLeaderId: promotion === "SHADOW_LEADER" ? leader?.id ?? null : null };
}
