import { snapshot } from "./indicators";
import type { AgentVote, LearningAgentId, PriceBar, Regime } from "./types";

function clamp(value: number, min = -1, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function n(value: number | null) {
  return value ?? 0;
}

export function detectRegime(benchmarkBars: PriceBar[]): Regime {
  if (benchmarkBars.length < 200) return "UNKNOWN";
  const s = snapshot(benchmarkBars);
  if (!s.sma50 || !s.sma200) return "UNKNOWN";
  if (s.close > s.sma50 && s.sma50 > s.sma200 && n(s.return20Pct) > -2) return "RISK_ON";
  if (s.close < s.sma50 && s.sma50 < s.sma200 && n(s.return20Pct) < 0) return "RISK_OFF";
  return "MIXED";
}

export function rawVotes(bars: PriceBar[], regime: Regime): AgentVote[] {
  const s = snapshot(bars);
  const close = s.close;
  const trendScore = clamp(
    (s.sma20 && close > s.sma20 ? 0.25 : -0.25) +
      (s.sma50 && close > s.sma50 ? 0.3 : -0.3) +
      (s.sma20 && s.sma50 && s.sma20 > s.sma50 ? 0.25 : -0.2) +
      clamp(n(s.return60Pct) / 18) * 0.2,
  );

  const rsi = n(s.rsi14);
  const momentumScore = clamp(
    clamp(n(s.return20Pct) / 10) * 0.52 + clamp(n(s.return5Pct) / 5) * 0.28 + (rsi >= 50 && rsi <= 72 ? 0.2 : rsi > 78 ? -0.2 : 0),
  );

  const z = n(s.z20);
  const longTrend = s.sma200 ? close > s.sma200 : true;
  const reversionScore = clamp((z <= -1.25 ? 0.75 : z <= -0.6 ? 0.35 : z >= 1.8 ? -0.65 : -z * 0.12) + (longTrend ? 0.12 : -0.12));

  const high20 = s.high20 ?? close;
  const breakoutDistance = high20 ? (close / high20 - 1) * 100 : 0;
  const volumeBonus = s.volumeRatio20 && s.volumeRatio20 >= 1.15 ? 0.2 : 0;
  const breakoutScore = clamp((breakoutDistance >= -0.6 ? 0.65 : breakoutDistance >= -2 ? 0.25 : -0.15) + volumeBonus + clamp(n(s.return20Pct) / 20) * 0.2);

  const regimeMultiplier = regime === "RISK_ON" ? 1 : regime === "RISK_OFF" ? 0.7 : 0.88;
  return [
    { id: "trend", name: "Trend Agent", score: trendScore * regimeMultiplier, confidence: Math.round(55 + Math.abs(trendScore) * 40), rationale: `Price ${s.sma50 && close >= s.sma50 ? "above" : "below"} 50D; 60D return ${n(s.return60Pct).toFixed(1)}%.`, weight: 0.3 },
    { id: "momentum", name: "Momentum Agent", score: momentumScore * regimeMultiplier, confidence: Math.round(52 + Math.abs(momentumScore) * 42), rationale: `20D ${n(s.return20Pct).toFixed(1)}%, RSI ${n(s.rsi14).toFixed(0)}.`, weight: 0.28 },
    { id: "reversion", name: "Mean Reversion", score: reversionScore, confidence: Math.round(48 + Math.abs(reversionScore) * 42), rationale: `20D z-score ${z.toFixed(2)}; long-term trend ${longTrend ? "supportive" : "weak"}.`, weight: 0.18 },
    { id: "breakout", name: "Breakout Agent", score: breakoutScore * regimeMultiplier, confidence: Math.round(50 + Math.abs(breakoutScore) * 42), rationale: `${Math.abs(breakoutDistance).toFixed(1)}% from 20D high; volume ratio ${(s.volumeRatio20 ?? 0).toFixed(2)}x.`, weight: 0.24 },
  ];
}

export function scoreWithCritic(votes: AgentVote[], bars: PriceBar[], regime: Regime, health: Record<string, number>, adaptiveWeights?: Partial<Record<LearningAgentId, number>>) {
  const s = snapshot(bars);
  const adjusted = votes.map((vote) => {
    const healthMultiplier = 0.65 + 0.7 * Math.max(0, Math.min(1, health[vote.id] ?? 0.5));
    const learnedWeight = adaptiveWeights?.[vote.id as LearningAgentId];
    const baseWeight = typeof learnedWeight === "number" && Number.isFinite(learnedWeight) ? learnedWeight : vote.weight;
    return { ...vote, weight: baseWeight * healthMultiplier };
  });
  const weightSum = adjusted.reduce((sum, vote) => sum + vote.weight, 0) || 1;
  const base = adjusted.reduce((sum, vote) => sum + vote.score * vote.weight, 0) / weightSum;
  const disagreement = Math.max(...adjusted.map((v) => v.score)) - Math.min(...adjusted.map((v) => v.score));
  const overextended = (s.z20 ?? 0) > 2.1 || (s.rsi14 ?? 50) > 79;
  const highVol = (s.realizedVol20Pct ?? 0) > 55 || (s.atrPct ?? 0) > 5.5;
  const criticPenalty = Math.min(0.34, disagreement * 0.14 + (overextended ? 0.12 : 0) + (highVol ? 0.12 : 0) + (regime === "RISK_OFF" ? 0.08 : 0));
  const score = clamp(base - Math.sign(Math.max(base, 0.001)) * criticPenalty);
  const critic: AgentVote = {
    id: "critic",
    name: "Devil's Advocate",
    score: -criticPenalty,
    confidence: Math.round(55 + criticPenalty * 100),
    rationale: `${disagreement.toFixed(2)} vote spread${overextended ? "; overextension detected" : ""}${highVol ? "; volatility elevated" : ""}.`,
    weight: 1,
  };
  const confidence = Math.round(Math.max(35, Math.min(92, 52 + Math.abs(score) * 36 - disagreement * 12)));
  return { score, confidence, votes: [...adjusted, critic] };
}
