import type { AgentVote, AssetClass, LearningAgentId, LearningAgentStat, LearningPolicy, LearningSegment } from "../engine/types";
import { supabaseConfig, supabaseError, supabaseFetch, supabaseHeaders as headers } from "./supabase";

const AGENTS: Array<{ id: LearningAgentId; name: string; baseWeight: number }> = [
  { id: "trend", name: "Trend Agent", baseWeight: 0.30 },
  { id: "momentum", name: "Momentum Agent", baseWeight: 0.28 },
  { id: "reversion", name: "Mean Reversion", baseWeight: 0.18 },
  { id: "breakout", name: "Breakout Agent", baseWeight: 0.24 },
];

const MIN_SHADOW_SAMPLE = 15;
const MIN_ADAPTIVE_SAMPLE = 30;
const TARGET_AGENT_OBSERVATIONS = 50;
const SHADOW_SAMPLE_WEIGHT = 0.5;

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

function baselineSegment(key: LearningSegment["key"]): LearningSegment {
  return {
    key,
    sampleCount: 0,
    winRatePct: 0,
    avgReturnPct: 0,
    agents: AGENTS.map((a) => ({ ...a, learnedWeight: a.baseWeight, observations: 0, directionalAccuracyPct: 50, avgDirectionalReturnPct: 0, reliabilityScore: 50 })),
  };
}

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
    confidenceAdjustmentPct: 0,
    driftScore: 0,
    recentExpectancyPct: null,
    baselineExpectancyPct: null,
    segments: { GLOBAL: baselineSegment("GLOBAL"), EQUITY: baselineSegment("EQUITY"), CRYPTO: baselineSegment("CRYPTO") },
    notes: [note, "V4.1 never changes the £50 hard cap, portfolio limits, stop logic, data gates or event-risk gates."],
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

    // Beta(8,8) prior keeps tiny/effective samples close to 50%.
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

function driftMetrics(rows: LearningRow[]) {
  const completed = rows.filter((r) => r.return_pct != null).sort((a, b) => a.opened_at.localeCompare(b.opened_at));
  if (completed.length < 20) return { driftScore: 0, recent: null as number | null, baseline: null as number | null };
  const recentRows = completed.slice(-20);
  const baselineRows = completed.slice(Math.max(0, completed.length - 80), -20);
  const wm = (subset: LearningRow[]) => weightedMean(subset.map((r) => ({ value: Number(r.return_pct), weight: r.learningWeight })));
  if (baselineRows.length < 10) return { driftScore: 0, recent: round(wm(recentRows), 3), baseline: null as number | null };
  const recent = wm(recentRows);
  const baseline = wm(baselineRows);
  const deterioration = Math.max(0, baseline - recent);
  const negativePenalty = recent < 0 ? Math.min(25, Math.abs(recent) * 18) : 0;
  const driftScore = clamp(deterioration * 35 + negativePenalty, 0, 100);
  return { driftScore: round(driftScore, 1), recent: round(recent, 3), baseline: round(baseline, 3) };
}

function confidenceAdjustment(rows: LearningRow[], effectiveSampleCount: number) {
  if (effectiveSampleCount < MIN_ADAPTIVE_SAMPLE) return 0;
  const valid = rows.filter((r) => Number.isFinite(Number(r.return_pct)) && Number.isFinite(Number(r.confidence)));
  const avgConfidence = weightedMean(valid.map((r) => ({ value: Number(r.confidence), weight: r.learningWeight })));
  const wins = valid.filter((r) => Number(r.return_pct) > 0).reduce((sum, r) => sum + r.learningWeight, 0);
  const total = valid.reduce((sum, r) => sum + r.learningWeight, 0);
  const winRate = total ? wins / total * 100 : 0;
  const gap = winRate - avgConfidence;
  // Downward corrections can be larger than upward corrections; avoid confidence inflation.
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

async function loadStoredPolicy(): Promise<LearningPolicy | null> {
  const config = supabaseConfig();
  if (!config) return null;
  const response = await supabaseFetch(`${config.url}/rest/v1/twm_learning_state?select=payload&id=eq.owner&limit=1`, { headers: headers(config), cache: "no-store" });
  if (!response.ok) return null;
  const rows = await response.json() as Array<{ payload?: LearningPolicy }>;
  return rows[0]?.payload ?? null;
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
  return (await loadStoredPolicy()) ?? baselineLearningPolicy("No trained policy exists yet. V4.1 is using baseline strategy weights.");
}

export async function trainLearningPolicy(): Promise<{ policy: LearningPolicy; persisted: boolean }> {
  if (!supabaseConfig()) return { policy: baselineLearningPolicy("Supabase is not configured, so self-training cannot persist."), persisted: false };
  const rows = await loadCompletedRows();
  const previous = await loadStoredPolicy();
  const actionableSamples = rows.filter((r) => r.kind === "ACTIONABLE").length;
  const shadowSamples = rows.filter((r) => r.kind === "SHADOW").length;
  const sampleCount = rows.length;
  const effectiveSampleCount = round(actionableSamples + shadowSamples * SHADOW_SAMPLE_WEIGHT, 1);
  if (previous && previous.sampleCount === sampleCount && previous.actionableSamples === actionableSamples && previous.shadowSamples === shadowSamples) {
    return { policy: previous, persisted: false };
  }

  const global = trainSegment("GLOBAL", rows);
  const equity = trainSegment("EQUITY", rows.filter((r) => r.asset_class === "EQUITY"));
  const crypto = trainSegment("CRYPTO", rows.filter((r) => r.asset_class === "CRYPTO"));
  const drift = driftMetrics(rows);
  let mode: LearningPolicy["mode"] = effectiveSampleCount < MIN_SHADOW_SAMPLE ? "COLD_START" : effectiveSampleCount < MIN_ADAPTIVE_SAMPLE ? "SHADOW" : "ADAPTIVE";
  if (effectiveSampleCount >= MIN_ADAPTIVE_SAMPLE && drift.driftScore >= 70) mode = "FROZEN";
  const policy: LearningPolicy = {
    version: (previous?.version ?? 0) + 1,
    trainedAt: new Date().toISOString(),
    mode,
    sampleCount,
    effectiveSampleCount,
    actionableSamples,
    shadowSamples,
    minimumAdaptiveSample: MIN_ADAPTIVE_SAMPLE,
    confidenceAdjustmentPct: mode === "ADAPTIVE" ? confidenceAdjustment(rows, effectiveSampleCount) : 0,
    driftScore: drift.driftScore,
    recentExpectancyPct: drift.recent,
    baselineExpectancyPct: drift.baseline,
    segments: { GLOBAL: global, EQUITY: equity, CRYPTO: crypto },
    notes: [
      mode === "COLD_START"
        ? `Need ${(MIN_SHADOW_SAMPLE - effectiveSampleCount).toFixed(1)} more effective learning samples before learned weights enter shadow mode.`
        : mode === "SHADOW"
          ? `Learned weights are visible but not applied until ${MIN_ADAPTIVE_SAMPLE} effective samples.`
          : mode === "FROZEN"
            ? "Recent forward performance deteriorated materially; V4.1 froze adaptive weights and reverted scoring to baseline weights."
            : "Adaptive weights are active, but remain shrinkage-limited and bounded around the original strategy mix.",
      `${actionableSamples} actionable and ${shadowSamples} shadow outcomes are complete. Shadow observations count at ${SHADOW_SAMPLE_WEIGHT.toFixed(1)}× weight and never inflate the Forward Trust score.`,
      "Learning uses only signals frozen before outcomes were known; it does not train on today's candidate outcome.",
      "The learner can reweight strategy votes and calibrate confidence. It cannot alter risk caps, execution rules, event gates, data gates or place live orders.",
    ],
  };
  const persisted = await persistPolicy(policy);
  return { policy, persisted };
}

export function weightsForPolicy(policy: LearningPolicy | undefined, assetClass: AssetClass) {
  if (!policy || policy.mode !== "ADAPTIVE") return undefined;
  const segment = policy.segments[assetClass] ?? policy.segments.GLOBAL;
  const selected = segment.sampleCount >= 10 ? segment : policy.segments.GLOBAL;
  return Object.fromEntries(selected.agents.map((a) => [a.id, a.learnedWeight])) as Partial<Record<LearningAgentId, number>>;
}

export const LEARNING_LIMITS = {
  MIN_SHADOW_SAMPLE,
  MIN_ADAPTIVE_SAMPLE,
  TARGET_AGENT_OBSERVATIONS,
  SHADOW_SAMPLE_WEIGHT,
  maxWeightChangePct: 30,
  riskRulesMutable: false,
} as const;
