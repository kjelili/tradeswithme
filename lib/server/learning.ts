import type { AgentVote, AssetClass, DriftMetric, LearningAgentId, LearningAgentStat, LearningPolicy, LearningSegment } from "../engine/types";
import { supabaseConfig, supabaseError, supabaseFetch, supabaseHeaders as headers } from "./supabase";

const AGENTS: Array<{ id: LearningAgentId; name: string; baseWeight: number }> = [
  { id: "trend", name: "Trend Agent", baseWeight: 0.30 },
  { id: "momentum", name: "Momentum Agent", baseWeight: 0.28 },
  { id: "reversion", name: "Mean Reversion", baseWeight: 0.18 },
  { id: "breakout", name: "Breakout Agent", baseWeight: 0.24 },
];

const MIN_SHADOW_SAMPLE = 15;
const MIN_ADAPTIVE_SAMPLE = 30;
const MIN_ACTIONABLE_DECISION_SAMPLE = 10;
const TARGET_AGENT_OBSERVATIONS = 50;
const SHADOW_SAMPLE_WEIGHT = 0.5;
const GUARDED_DRIFT_SCORE = 55;
const FREEZE_DRIFT_SCORE = 70;
const PERSISTENT_DRIFT_WINDOWS = 3;

type LearningRow = {
  id: number;
  kind: "ACTIONABLE" | "SHADOW";
  learningWeight: number;
  asset_class: AssetClass;
  opened_at: string;
  return_pct: number | string | null;
  outcome: string;
  confidence: number | string;
  agent_snapshot: AgentVote[] | null;
};

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }
function round(v: number, d = 3) { const p = 10 ** d; return Math.round(v * p) / p; }
function weightedMean(items: Array<{ value: number; weight: number }>) {
  const weight = items.reduce((sum, item) => sum + item.weight, 0);
  return weight ? items.reduce((sum, item) => sum + item.value * item.weight, 0) / weight : 0;
}
function weightedStd(items: Array<{ value: number; weight: number }>, mean = weightedMean(items)) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (!total) return 0;
  const variance = items.reduce((sum, item) => sum + item.weight * (item.value - mean) ** 2, 0) / total;
  return Math.sqrt(Math.max(0, variance));
}

function baselineSegment(key: LearningSegment["key"]): LearningSegment {
  return {
    key,
    sampleCount: 0,
    winRatePct: 0,
    avgReturnPct: 0,
    agents: AGENTS.map((a) => ({ ...a, learnedWeight: a.baseWeight, observations: 0, directionalAccuracyPct: 50, avgDirectionalReturnPct: 0, reliabilityScore: 50 })),
  };
}

const emptyDrift = (): DriftMetric => ({ score: 0, recentExpectancyPct: null, baselineExpectancyPct: null, baselineVolatilityPct: null });

export function baselineLearningPolicy(note = "Learning ledgers have not accumulated enough completed observations yet."): LearningPolicy {
  return {
    version: 1,
    trainedAt: new Date(0).toISOString(),
    mode: "COLD_START",
    sampleCount: 0,
    effectiveSampleCount: 0,
    actionableSamples: 0,
    shadowSamples: 0,
    minimumAdaptiveSample: MIN_ADAPTIVE_SAMPLE,
    minimumActionableForDecisionWeights: MIN_ACTIONABLE_DECISION_SAMPLE,
    decisionWeightsActive: false,
    confidenceAdjustmentPct: 0,
    driftScore: 0,
    driftStreak: 0,
    recoveryPositiveStreak: 0,
    recovery: { status: "NOT_NEEDED", positiveWindowStreak: 0, requiredPositiveWindows: 2, recentExpectancyPositive: false, driftBelowGuardedThreshold: true, actionableSamples: 0, requiredActionableSamples: MIN_ACTIONABLE_DECISION_SAMPLE, reasons: ["No recovery process is required during cold start."] },
    recentExpectancyPct: null,
    baselineExpectancyPct: null,
    segmentDrift: { EQUITY: emptyDrift(), CRYPTO: emptyDrift() },
    segments: { GLOBAL: baselineSegment("GLOBAL"), EQUITY: baselineSegment("EQUITY"), CRYPTO: baselineSegment("CRYPTO") },
    notes: [note, "V5.2 never changes the £50 hard cap, portfolio limits, stop logic, data gates or event-risk gates."],
  };
}

function trainSegment(key: LearningSegment["key"], rows: LearningRow[]): LearningSegment {
  const valid = rows.filter((r) => Number.isFinite(Number(r.return_pct)));
  const sampleCount = valid.length;
  const returnItems = valid.map((r) => ({ value: Number(r.return_pct), weight: r.learningWeight }));
  const positiveWeight = valid.filter((r) => Number(r.return_pct) > 0).reduce((sum, r) => sum + r.learningWeight, 0);
  const totalWeight = valid.reduce((sum, r) => sum + r.learningWeight, 0);
  const winRatePct = totalWeight ? positiveWeight / totalWeight * 100 : 0;
  const avgReturnPct = weightedMean(returnItems);

  const rawStats = AGENTS.map((agent): LearningAgentStat => {
    let observations = 0;
    let correct = 0;
    const directional: Array<{ value: number; weight: number }> = [];
    for (const row of valid) {
      const ret = Number(row.return_pct);
      const vote = Array.isArray(row.agent_snapshot) ? row.agent_snapshot.find((v) => v.id === agent.id) : undefined;
      if (!vote || Math.abs(vote.score) < 0.05) continue;
      observations += row.learningWeight;
      const direction = vote.score >= 0 ? 1 : -1;
      const isCorrect = (direction > 0 && ret > 0) || (direction < 0 && ret <= 0);
      if (isCorrect) correct += row.learningWeight;
      directional.push({
        value: direction * ret * Math.max(0.35, Math.min(1, vote.confidence / 100)),
        weight: row.learningWeight,
      });
    }

    const posteriorAccuracy = (correct + 8) / (observations + 16);
    const avgDirectionalReturnPct = weightedMean(directional);
    const edgeScore = 50 + Math.tanh(avgDirectionalReturnPct / 1.5) * 30;
    const reliabilityScore = clamp(posteriorAccuracy * 60 + edgeScore * 0.40, 20, 82);
    const targetMultiplier = clamp(0.55 + reliabilityScore / 100 * 0.90, 0.65, 1.30);
    const shrink = Math.min(1, observations / TARGET_AGENT_OBSERVATIONS);
    const learnedWeight = agent.baseWeight * (1 - shrink) + agent.baseWeight * targetMultiplier * shrink;
    return {
      ...agent,
      learnedWeight,
      observations: round(observations, 1),
      directionalAccuracyPct: round(posteriorAccuracy * 100, 1),
      avgDirectionalReturnPct: round(avgDirectionalReturnPct, 3),
      reliabilityScore: round(reliabilityScore, 1),
    };
  });

  const sum = rawStats.reduce((s, a) => s + a.learnedWeight, 0) || 1;
  const normalized = rawStats.map((a) => ({ ...a, learnedWeight: round(a.learnedWeight / sum, 4) }));
  return { key, sampleCount, winRatePct: round(winRatePct, 1), avgReturnPct: round(avgReturnPct, 3), agents: normalized };
}

/**
 * Drift Control V2: deterioration is judged relative to the dispersion of prior returns,
 * not merely by raw percentage-point decline. This prevents volatile crypto windows from
 * triggering a hard freeze just because a still-positive recent window is below a very
 * strong earlier window.
 */
function driftMetric(rows: LearningRow[]): DriftMetric {
  const completed = rows.filter((r) => r.return_pct != null).sort((a, b) => a.opened_at.localeCompare(b.opened_at));
  if (completed.length < 20) return emptyDrift();
  const recentRows = completed.slice(-20);
  const baselineRows = completed.slice(Math.max(0, completed.length - 80), -20);
  const items = (subset: LearningRow[]) => subset.map((r) => ({ value: Number(r.return_pct), weight: r.learningWeight }));
  const recent = weightedMean(items(recentRows));
  if (baselineRows.length < 10) return { score: 0, recentExpectancyPct: round(recent, 3), baselineExpectancyPct: null, baselineVolatilityPct: null };
  const baselineItems = items(baselineRows);
  const recentItems = items(recentRows);
  const baseline = weightedMean(baselineItems);
  const baselineVol = weightedStd(baselineItems, baseline);
  const recentVol = weightedStd(recentItems, recent);
  const scale = Math.max(1.0, baselineVol, recentVol * 0.6);
  const deterioration = Math.max(0, baseline - recent);
  const normalizedDeterioration = deterioration / scale;
  const negativeSeverity = recent < 0 ? Math.abs(recent) / scale : 0;
  const score = clamp(normalizedDeterioration * 45 + negativeSeverity * 35, 0, 100);
  return {
    score: round(score, 1),
    recentExpectancyPct: round(recent, 3),
    baselineExpectancyPct: round(baseline, 3),
    baselineVolatilityPct: round(baselineVol, 3),
  };
}

function confidenceAdjustment(rows: LearningRow[], effectiveSampleCount: number) {
  if (effectiveSampleCount < MIN_ADAPTIVE_SAMPLE) return 0;
  const valid = rows.filter((r) => Number.isFinite(Number(r.return_pct)) && Number.isFinite(Number(r.confidence)));
  const avgConfidence = weightedMean(valid.map((r) => ({ value: Number(r.confidence), weight: r.learningWeight })));
  const wins = valid.filter((r) => Number(r.return_pct) > 0).reduce((sum, r) => sum + r.learningWeight, 0);
  const total = valid.reduce((sum, r) => sum + r.learningWeight, 0);
  const winRate = total ? wins / total * 100 : 0;
  const gap = winRate - avgConfidence;
  return round(clamp(gap * 0.35, -12, 5), 1);
}

async function loadTableRows(config: { url: string; key: string }, table: "twm_forward_signals" | "twm_shadow_signals", kind: LearningRow["kind"], weight: number, limit: number) {
  const response = await supabaseFetch(`${config.url}/rest/v1/${table}?select=id,asset_class,opened_at,return_pct,outcome,confidence,agent_snapshot&outcome=neq.PENDING&return_pct=not.is.null&order=opened_at.asc&limit=${limit}`, {
    headers: headers(config), cache: "no-store",
  });
  if (!response.ok) throw new Error(await supabaseError(response, `Learning ledger read failed for ${table}`));
  const rows = await response.json() as Array<Omit<LearningRow, "kind" | "learningWeight">>;
  return rows.map((row) => ({ ...row, kind, learningWeight: weight }));
}

async function loadCompletedRows(limit = 1000): Promise<LearningRow[]> {
  const config = supabaseConfig();
  if (!config) return [];
  const [actionable, shadow] = await Promise.all([
    loadTableRows(config, "twm_forward_signals", "ACTIONABLE", 1, limit),
    loadTableRows(config, "twm_shadow_signals", "SHADOW", SHADOW_SAMPLE_WEIGHT, limit),
  ]);
  return [...actionable, ...shadow].sort((a, b) => a.opened_at.localeCompare(b.opened_at));
}

function normalizeStoredPolicy(policy: LearningPolicy | undefined): LearningPolicy | null {
  if (!policy) return null;
  const recoveryPositiveStreak = Number.isFinite(policy.recoveryPositiveStreak) ? policy.recoveryPositiveStreak : 0;
  const recentPositive = (policy.recentExpectancyPct ?? 0) > 0;
  const driftRecovered = (policy.driftScore ?? 0) < GUARDED_DRIFT_SCORE;
  const legacyReasons: string[] = [];
  if (!recentPositive) legacyReasons.push("Recent learning expectancy must return above 0%.");
  if (!driftRecovered) legacyReasons.push(`Drift must fall below ${GUARDED_DRIFT_SCORE}/100.`);
  if (recoveryPositiveStreak < 2) legacyReasons.push(`Need ${2 - recoveryPositiveStreak} more consecutive positive/low-drift training window(s).`);
  if ((policy.actionableSamples ?? 0) < MIN_ACTIONABLE_DECISION_SAMPLE) legacyReasons.push(`Need ${MIN_ACTIONABLE_DECISION_SAMPLE - (policy.actionableSamples ?? 0)} more completed actionable outcomes before learned BUY_SETUP weights can activate.`);
  const fallbackRecovery = {
    status: policy.mode === "FROZEN" || policy.mode === "GUARDED" ? (recentPositive && driftRecovered ? "RECOVERING" as const : "BLOCKED" as const) : "NOT_NEEDED" as const,
    positiveWindowStreak: recoveryPositiveStreak, requiredPositiveWindows: 2, recentExpectancyPositive: recentPositive, driftBelowGuardedThreshold: driftRecovered, actionableSamples: policy.actionableSamples ?? 0, requiredActionableSamples: MIN_ACTIONABLE_DECISION_SAMPLE, reasons: legacyReasons,
  };
  return {
    ...policy,
    minimumActionableForDecisionWeights: Number.isFinite(policy.minimumActionableForDecisionWeights) ? policy.minimumActionableForDecisionWeights : MIN_ACTIONABLE_DECISION_SAMPLE,
    decisionWeightsActive: Boolean(policy.decisionWeightsActive && policy.actionableSamples >= MIN_ACTIONABLE_DECISION_SAMPLE && policy.mode === "ADAPTIVE"),
    driftStreak: Number.isFinite(policy.driftStreak) ? policy.driftStreak : 0,
    recoveryPositiveStreak,
    recovery: policy.recovery ?? fallbackRecovery,
    segmentDrift: policy.segmentDrift ?? { EQUITY: emptyDrift(), CRYPTO: emptyDrift() },
  };
}

async function loadStoredPolicy(): Promise<LearningPolicy | null> {
  const config = supabaseConfig();
  if (!config) return null;
  const response = await supabaseFetch(`${config.url}/rest/v1/twm_learning_state?select=payload&id=eq.owner&limit=1`, { headers: headers(config), cache: "no-store" });
  if (!response.ok) return null;
  const rows = await response.json() as Array<{ payload?: LearningPolicy }>;
  return normalizeStoredPolicy(rows[0]?.payload);
}

async function persistPolicy(policy: LearningPolicy) {
  const config = supabaseConfig();
  if (!config) return false;
  const state = await supabaseFetch(`${config.url}/rest/v1/twm_learning_state?on_conflict=id`, {
    method: "POST",
    headers: headers(config, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ id: "owner", version: policy.version, trained_at: policy.trainedAt, payload: policy, updated_at: policy.trainedAt }),
  });
  if (!state.ok) throw new Error(await supabaseError(state, "Learning-state persistence failed"));
  const log = await supabaseFetch(`${config.url}/rest/v1/twm_learning_runs`, {
    method: "POST", headers: headers(config, { Prefer: "return=minimal" }),
    body: JSON.stringify({ trained_at: policy.trainedAt, version: policy.version, sample_count: policy.sampleCount, mode: policy.mode, payload: policy }),
  });
  if (!log.ok) throw new Error(await supabaseError(log, "Learning-run persistence failed"));
  return true;
}

export async function loadLearningPolicy(): Promise<LearningPolicy> {
  if (!supabaseConfig()) return baselineLearningPolicy("Supabase is not configured, so the adaptive learner is running its baseline policy only.");
  return (await loadStoredPolicy()) ?? baselineLearningPolicy("No trained policy exists yet. V5.2 is using baseline strategy weights.");
}

export async function trainLearningPolicy(): Promise<{ policy: LearningPolicy; persisted: boolean }> {
  if (!supabaseConfig()) return { policy: baselineLearningPolicy("Supabase is not configured, so self-training cannot persist."), persisted: false };
  const rows = await loadCompletedRows();
  const previous = await loadStoredPolicy();
  const actionableSamples = rows.filter((r) => r.kind === "ACTIONABLE").length;
  const shadowSamples = rows.filter((r) => r.kind === "SHADOW").length;
  const sampleCount = rows.length;
  const effectiveSampleCount = round(actionableSamples + shadowSamples * SHADOW_SAMPLE_WEIGHT, 1);
  const previousIsV415 = Boolean(previous?.segmentDrift && Number.isFinite(previous?.minimumActionableForDecisionWeights) && Number.isFinite(previous?.driftStreak));
  if (previous && previousIsV415 && previous.sampleCount === sampleCount && previous.actionableSamples === actionableSamples && previous.shadowSamples === shadowSamples) {
    return { policy: previous, persisted: false };
  }

  const global = trainSegment("GLOBAL", rows);
  const equityRows = rows.filter((r) => r.asset_class === "EQUITY");
  const cryptoRows = rows.filter((r) => r.asset_class === "CRYPTO");
  const equity = trainSegment("EQUITY", equityRows);
  const crypto = trainSegment("CRYPTO", cryptoRows);
  const globalDrift = driftMetric(rows);
  const equityDrift = driftMetric(equityRows);
  const cryptoDrift = driftMetric(cryptoRows);
  const driftScore = Math.max(globalDrift.score, equityDrift.score * 0.85, cryptoDrift.score * 0.85);
  const previousStreak = previous?.driftStreak ?? 0;
  const driftStreak = driftScore >= GUARDED_DRIFT_SCORE ? previousStreak + 1 : 0;
  const recentPositive = (globalDrift.recentExpectancyPct ?? 0) > 0;
  const driftRecovered = driftScore < GUARDED_DRIFT_SCORE;
  const previousRecoveryStreak = previous?.recoveryPositiveStreak ?? 0;
  const recoveryPositiveStreak = recentPositive && driftRecovered ? previousRecoveryStreak + 1 : 0;
  const requiredPositiveWindows = 2;

  let mode: LearningPolicy["mode"] = effectiveSampleCount < MIN_SHADOW_SAMPLE ? "COLD_START" : effectiveSampleCount < MIN_ADAPTIVE_SAMPLE ? "SHADOW" : "ADAPTIVE";
  if (effectiveSampleCount >= MIN_ADAPTIVE_SAMPLE) {
    const recentNegative = (globalDrift.recentExpectancyPct ?? 0) < 0;
    const hardFreeze = (recentNegative && driftScore >= FREEZE_DRIFT_SCORE) || (driftScore >= FREEZE_DRIFT_SCORE && driftStreak >= PERSISTENT_DRIFT_WINDOWS);
    if (previous?.mode === "FROZEN" && recoveryPositiveStreak < requiredPositiveWindows) mode = "FROZEN";
    else if (hardFreeze) mode = "FROZEN";
    else if (driftScore >= GUARDED_DRIFT_SCORE) mode = "GUARDED";
  }

  const recoveryReasons: string[] = [];
  if (!recentPositive) recoveryReasons.push("Recent learning expectancy must return above 0%.");
  if (!driftRecovered) recoveryReasons.push(`Drift must fall below ${GUARDED_DRIFT_SCORE}/100.`);
  if (recoveryPositiveStreak < requiredPositiveWindows) recoveryReasons.push(`Need ${requiredPositiveWindows - recoveryPositiveStreak} more consecutive positive/low-drift training window(s).`);
  if (actionableSamples < MIN_ACTIONABLE_DECISION_SAMPLE) recoveryReasons.push(`Need ${MIN_ACTIONABLE_DECISION_SAMPLE - actionableSamples} more completed actionable outcomes before learned BUY_SETUP weights can activate.`);
  const recoveryStatus = mode !== "FROZEN" && mode !== "GUARDED" ? "NOT_NEEDED" as const
    : recoveryPositiveStreak >= requiredPositiveWindows && recentPositive && driftRecovered ? "READY_TO_UNFREEZE" as const
      : recentPositive || recoveryPositiveStreak > 0 ? "RECOVERING" as const : "BLOCKED" as const;
  const recovery = { status: recoveryStatus, positiveWindowStreak: recoveryPositiveStreak, requiredPositiveWindows, recentExpectancyPositive: recentPositive, driftBelowGuardedThreshold: driftRecovered, actionableSamples, requiredActionableSamples: MIN_ACTIONABLE_DECISION_SAMPLE, reasons: recoveryReasons };

  const decisionWeightsActive = mode === "ADAPTIVE" && actionableSamples >= MIN_ACTIONABLE_DECISION_SAMPLE;
  const policy: LearningPolicy = {
    version: (previous?.version ?? 0) + 1,
    trainedAt: new Date().toISOString(),
    mode,
    sampleCount,
    effectiveSampleCount,
    actionableSamples,
    shadowSamples,
    minimumAdaptiveSample: MIN_ADAPTIVE_SAMPLE,
    minimumActionableForDecisionWeights: MIN_ACTIONABLE_DECISION_SAMPLE,
    decisionWeightsActive,
    confidenceAdjustmentPct: mode === "ADAPTIVE" || mode === "GUARDED" ? confidenceAdjustment(rows, effectiveSampleCount) : 0,
    driftScore: round(driftScore, 1),
    driftStreak,
    recoveryPositiveStreak,
    recovery,
    recentExpectancyPct: globalDrift.recentExpectancyPct,
    baselineExpectancyPct: globalDrift.baselineExpectancyPct,
    segmentDrift: { EQUITY: equityDrift, CRYPTO: cryptoDrift },
    segments: { GLOBAL: global, EQUITY: equity, CRYPTO: crypto },
    notes: [
      mode === "COLD_START"
        ? `Need ${(MIN_SHADOW_SAMPLE - effectiveSampleCount).toFixed(1)} more effective learning samples before learned weights enter shadow mode.`
        : mode === "SHADOW"
          ? `Learned weights are visible but not applied until ${MIN_ADAPTIVE_SAMPLE} effective samples.`
          : mode === "GUARDED"
            ? `Drift Control V2 detected a material but not yet persistent deterioration. Learned weights remain research-only while BUY_SETUP decisions stay on baseline weights.`
            : mode === "FROZEN"
              ? `Persistent or negative-expectancy drift triggered the hard freeze after ${driftStreak} guarded window(s). Baseline weights drive all decisions.`
              : `Adaptive research weights are active. BUY_SETUP decision weights ${decisionWeightsActive ? "are also validated for use" : `remain baseline until ${MIN_ACTIONABLE_DECISION_SAMPLE} actionable outcomes complete`}.`,
      `${actionableSamples} actionable and ${shadowSamples} shadow outcomes are complete. Shadow observations count at ${SHADOW_SAMPLE_WEIGHT.toFixed(1)}× weight and never inflate the Forward Trust score.`,
      `Global drift ${round(driftScore, 1)}/100 · equity ${equityDrift.score.toFixed(1)}/100 · crypto ${cryptoDrift.score.toFixed(1)}/100. Drift is volatility-normalized and requires persistence or negative recent expectancy before a hard freeze.`,
      mode === "FROZEN" || mode === "GUARDED" ? `Recovery ${recovery.status}: ${recoveryPositiveStreak}/${requiredPositiveWindows} positive low-drift windows; recent expectancy ${recentPositive ? "positive" : "not positive"}; drift ${driftRecovered ? "below" : "above"} guarded threshold.` : "No recovery lock is active.",
      "Learning uses only signals frozen before outcomes were known; it does not train on today's candidate outcome.",
      "Research adaptation and BUY_SETUP decision adaptation are separated. The learner cannot alter risk caps, execution rules, event gates, data gates or place live orders.",
    ],
  };
  const persisted = await persistPolicy(policy);
  return { policy, persisted };
}

export function weightsForPolicy(policy: LearningPolicy | undefined, assetClass: AssetClass) {
  if (!policy || (policy.mode !== "ADAPTIVE" && policy.mode !== "GUARDED")) return undefined;
  const segment = policy.segments[assetClass] ?? policy.segments.GLOBAL;
  const selected = segment.sampleCount >= 10 ? segment : policy.segments.GLOBAL;
  return Object.fromEntries(selected.agents.map((a) => [a.id, a.learnedWeight])) as Partial<Record<LearningAgentId, number>>;
}

export const LEARNING_LIMITS = {
  MIN_SHADOW_SAMPLE,
  MIN_ADAPTIVE_SAMPLE,
  MIN_ACTIONABLE_DECISION_SAMPLE,
  TARGET_AGENT_OBSERVATIONS,
  SHADOW_SAMPLE_WEIGHT,
  GUARDED_DRIFT_SCORE,
  FREEZE_DRIFT_SCORE,
  PERSISTENT_DRIFT_WINDOWS,
  maxWeightChangePct: 30,
  riskRulesMutable: false,
} as const;
