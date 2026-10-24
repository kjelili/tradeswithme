// The single source of truth for a symbol's BUY_SETUP decision. Used by the live
// nightly scan (analyze.ts) AND the historical trade replay (replay.ts), so the
// replay can never drift from what the bot actually does.

import { ENGINE } from "./config";
import { runStrategyLab, strategyHealthFromLab, strategyStatesFromLab } from "./backtest";
import type { correlationStatus } from "./correlation";
import { actionFor, buildTradePlan } from "./risk";
import { rawVotes, scoreWithCritic } from "./strategies";
import type { AssetClass, DataQuality, EventRisk, IndicatorSnapshot, LearningAgentId, LearningPolicy, MarketSource, PriceBar, Regime, RiskSettings, SignalAction } from "./types";

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export function adaptiveWeights(policy: LearningPolicy | undefined, assetClass: AssetClass) {
  if (!policy || (policy.mode !== "ADAPTIVE" && policy.mode !== "GUARDED")) return undefined;
  const specific = policy.segments[assetClass];
  const segment = specific && specific.sampleCount >= 10 ? specific : policy.segments.GLOBAL;
  return Object.fromEntries(segment.agents.map((agent) => [agent.id, agent.learnedWeight])) as Partial<Record<LearningAgentId, number>>;
}

export function decisionWeightsActive(policy: LearningPolicy | undefined) {
  return Boolean(policy?.decisionWeightsActive && policy.mode === "ADAPTIVE");
}

export function diversificationScore(status: ReturnType<typeof correlationStatus>) {
  if (status === "LOW") return 90;
  if (status === "MODERATE") return 66;
  if (status === "HIGH") return 38;
  return 72;
}

export function historyPassesDataGate(source: MarketSource, quality: DataQuality, assetClass: AssetClass) {
  const freshnessPass = assetClass === "EQUITY"
    ? quality.freshnessSessions === 0
    : quality.freshnessDays <= 2;
  return source !== "SIMULATED_FALLBACK" && quality.score >= 60 && freshnessPass && quality.bars >= ENGINE.minimumBars;
}

export type DecisionInput = {
  symbol: string;
  assetClass: AssetClass;
  source: MarketSource;
  bars: PriceBar[];
  indicators: IndicatorSnapshot;
  regime: Regime;
  benchmarkVerified: boolean;
  quality: DataQuality;
  eventRisk: EventRisk;
  corrStatus: ReturnType<typeof correlationStatus>;
  heldSymbolCount: number;
  held: boolean;
  settings: RiskSettings;
  exposure: number;
  learning?: LearningPolicy;
};

export function decideSymbol(input: DecisionInput) {
  const { symbol, assetClass, source, bars, indicators, regime, quality, eventRisk, corrStatus, held, settings, exposure, learning } = input;
  const lab = runStrategyLab(symbol, source, bars, regime);
  const health = strategyHealthFromLab(lab);
  const strategyStates = strategyStatesFromLab(lab);
  const baseVotes = rawVotes(bars, regime);
  const learnedWeights = adaptiveWeights(learning, assetClass);
  const researchScored = scoreWithCritic(baseVotes, bars, regime, health, learnedWeights);
  const baselineScored = learnedWeights ? scoreWithCritic(baseVotes, bars, regime, health) : researchScored;
  const useLearnedForDecisions = decisionWeightsActive(learning);
  const decisionScored = useLearnedForDecisions ? researchScored : baselineScored;

  const divScore = diversificationScore(corrStatus);
  const eventPenalty = eventRisk.level === "BLOCK" ? 42 : eventRisk.level === "CAUTION" ? 16 : eventRisk.level === "UNVERIFIED" ? 7 : 0;
  const strategyStability = lab.validationWinner?.stabilityScore ?? 0;
  const scoreComponent = clamp(50 + researchScored.score * 50, 0, 100);
  const evidenceScore = Math.round(clamp(
    scoreComponent * 0.24 + researchScored.confidence * 0.16 + strategyStability * 0.27 + quality.score * 0.23 + divScore * 0.10 - eventPenalty,
    0,
    100,
  ));
  const decisionScoreComponent = clamp(50 + decisionScored.score * 50, 0, 100);
  const decisionEvidenceScore = Math.round(clamp(
    decisionScoreComponent * 0.24 + decisionScored.confidence * 0.16 + strategyStability * 0.27 + quality.score * 0.23 + divScore * 0.10 - eventPenalty,
    0,
    100,
  ));

  const researchConfidenceAdjustment = learning?.mode === "ADAPTIVE" ? learning.confidenceAdjustmentPct : 0;
  const researchConfidence = Math.round(clamp(researchScored.confidence * 0.48 + strategyStability * 0.27 + quality.score * 0.25 - eventPenalty * 0.35 + researchConfidenceAdjustment, 25, 92));
  const decisionConfidence = Math.round(clamp(decisionScored.confidence * 0.48 + strategyStability * 0.27 + quality.score * 0.25 - eventPenalty * 0.35 + (useLearnedForDecisions ? researchConfidenceAdjustment : 0), 25, 92));

  const gateReasons: string[] = [];
  const baseAction = actionFor(decisionScored.score, held, regime, indicators.realizedVol20Pct, assetClass);
  let action: SignalAction = baseAction;
  if (!held && baseAction === "WATCH") gateReasons.push(decisionScored.score < ENGINE.buyThreshold ? "SCORE_BELOW_BUY_THRESHOLD" : "BASE_POLICY_WATCH");
  if (!held && baseAction === "AVOID") {
    if ((indicators.realizedVol20Pct ?? 0) >= (assetClass === "CRYPTO" ? 120 : ENGINE.avoidVolatilityPct)) gateReasons.push("VOLATILITY_TOO_HIGH");
    else if (regime === "RISK_OFF" && decisionScored.score < 0.64) gateReasons.push("RISK_OFF_SCORE_TOO_LOW");
    else gateReasons.push("NEGATIVE_AGENT_SCORE");
  }
  if (held && baseAction !== "BUY_SETUP") gateReasons.push("EXISTING_POSITION_POLICY");

  if (!historyPassesDataGate(source, quality, assetClass)) { action = "AVOID"; gateReasons.push("DATA_GATE_FAILED"); }
  if (action === "BUY_SETUP" && !input.benchmarkVerified) { action = "WATCH"; gateReasons.push("BENCHMARK_UNVERIFIED"); }
  if (eventRisk.level === "BLOCK" && action === "BUY_SETUP") { action = "WATCH"; gateReasons.push("EVENT_RISK_BLOCK"); }
  if (decisionEvidenceScore < 54 && action === "BUY_SETUP") { action = "WATCH"; gateReasons.push("EVIDENCE_BELOW_MINIMUM"); }
  if (Object.values(strategyStates).every((state) => state === "RETIRED") && action === "BUY_SETUP") { action = "WATCH"; gateReasons.push("ALL_STRATEGIES_RETIRED"); }
  if (corrStatus === "HIGH" && action === "BUY_SETUP" && input.heldSymbolCount) { action = "WATCH"; gateReasons.push("CORRELATION_TOO_HIGH"); }

  let plan = buildTradePlan(action, indicators, settings, exposure, assetClass);
  if (action === "BUY_SETUP" && plan.suggestedShares <= 0) {
    action = "WATCH";
    gateReasons.push("POSITION_SIZE_ZERO");
    plan = buildTradePlan(action, indicators, settings, exposure, assetClass);
  }
  if (action === "BUY_SETUP" && gateReasons.length === 0) gateReasons.push("ALL_GATES_PASS");

  return {
    lab, health, strategyStates, researchScored, decisionScored, useLearnedForDecisions,
    divScore, eventPenalty, strategyStability, evidenceScore, decisionEvidenceScore,
    researchConfidence, decisionConfidence, action, gateReasons, plan,
  };
}

/** The overnight planner's extra entry filter (mirrors overnight.ts eligibility). */
export function passesOvernightGate(d: { action: SignalAction; source: MarketSource; decisionScore: number; decisionConfidence: number; decisionEvidenceScore: number; eventLevel: EventRisk["level"]; corrStatus: string; suggestedNotional: number }) {
  return d.action === "BUY_SETUP" &&
    d.source !== "SIMULATED_FALLBACK" &&
    d.decisionScore >= ENGINE.overnightMinScore &&
    d.decisionConfidence >= ENGINE.overnightMinConfidence &&
    d.decisionEvidenceScore >= ENGINE.overnightMinEvidenceScore &&
    d.eventLevel !== "BLOCK" &&
    d.corrStatus !== "HIGH" &&
    d.suggestedNotional > 0;
}
