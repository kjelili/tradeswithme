import { rawVotes } from "./strategies";
import { detectQuantRegime } from "./quant-regime";
import type {
  AssetClass, ChallengerLab, ChallengerVariant, CounterfactualSummary, ExecutionQuality, LearningAgentId,
  LearningPolicy, MonteCarloSegment, MonteCarloSummary, PriceBar, QuantIntelligence, QuantRegime, QuantRegimeProfile,
  RobustnessCell, RobustnessMatrix, SymbolAnalysis, ValidationSummary,
} from "./types";

const STRATEGIES: Array<{ id: LearningAgentId; name: string; base: number }> = [
  { id: "trend", name: "Trend", base: 0.30 },
  { id: "momentum", name: "Momentum", base: 0.28 },
  { id: "reversion", name: "Mean Reversion", base: 0.18 },
  { id: "breakout", name: "Breakout", base: 0.24 },
];
const HORIZONS = [1, 3, 5, 10, 20] as const;

function clamp(v: number, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }
function round(v: number, d = 2) { const p = 10 ** d; return Math.round(v * p) / p; }
function mean(v: number[]) { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }
function std(v: number[]) { const m = mean(v); return v.length > 1 ? Math.sqrt(mean(v.map((x) => (x - m) ** 2))) : 0; }

export function executionQualityProxy(analysis: SymbolAnalysis): ExecutionQuality {
  const atr = analysis.indicators.atrPct ?? 0;
  const volume = analysis.indicators.volumeRatio20 ?? 1;
  const vol = analysis.indicators.realizedVol20Pct ?? 0;
  const volatilityPenalty = analysis.assetClass === "CRYPTO" ? Math.max(0, atr - 5) * 4 : Math.max(0, atr - 2.5) * 8;
  const volumePenalty = volume < 0.65 ? 22 : volume < 0.9 ? 10 : 0;
  const score = Math.round(clamp(86 - volatilityPenalty - volumePenalty - Math.max(0, vol - (analysis.assetClass === "CRYPTO" ? 90 : 40)) * 0.2, 20, 95));
  return {
    status: score >= 70 ? "GOOD_PROXY" : score >= 50 ? "CAUTION_PROXY" : "POOR_PROXY",
    score,
    liveSpreadVerified: false,
    rationale: `EOD proxy only: ATR ${(atr).toFixed(1)}%, volume ratio ${volume.toFixed(2)}x. Live spread/depth is not connected, so this cannot authorize execution.`,
  };
}

type HistoryInput = { symbol: string; assetClass: AssetClass; bars: PriceBar[] };

export function buildRobustnessMatrix(histories: HistoryInput[]): RobustnessMatrix {
  const buckets = new Map<string, number[]>();
  let samples = 0;
  for (const history of histories.slice(0, 16)) {
    const bars = history.bars;
    const step = Math.max(8, Math.floor((bars.length - 240) / 28));
    for (let i = 220; i < bars.length - 21; i += step) {
      const slice = bars.slice(0, i + 1);
      const profile = detectQuantRegime(slice, history.assetClass);
      if (profile.regime === "UNKNOWN") continue;
      const votes = rawVotes(slice, "MIXED");
      const entry = bars[i].close;
      if (!entry) continue;
      for (const strategy of STRATEGIES) {
        const vote = votes.find((v) => v.id === strategy.id);
        if (!vote || vote.score < 0.16) continue;
        for (const horizon of HORIZONS) {
          const exit = bars[i + horizon]?.close;
          if (!exit) continue;
          const ret = (exit / entry - 1) * 100 - 0.16;
          const key = `${strategy.id}|${history.assetClass}|${profile.regime}|${horizon}`;
          const arr = buckets.get(key) ?? [];
          arr.push(ret);
          buckets.set(key, arr);
          samples += 1;
        }
      }
    }
  }
  const cells: RobustnessCell[] = [];
  for (const [key, returns] of buckets) {
    const [strategy, assetClass, regime, horizon] = key.split("|") as [LearningAgentId, AssetClass, QuantRegime, string];
    const avg = mean(returns);
    const win = returns.filter((r) => r > 0).length / returns.length * 100;
    const dispersion = std(returns);
    const score = Math.round(clamp(35 + (win - 50) * 0.8 + Math.tanh(avg / Math.max(0.5, dispersion * 0.25)) * 30 + Math.min(15, returns.length * 0.6), 0, 100));
    cells.push({ strategy, strategyName: STRATEGIES.find((s) => s.id === strategy)?.name ?? strategy, assetClass, regime, horizonBars: Number(horizon), observations: returns.length, winRatePct: round(win, 1), avgReturnPct: round(avg, 3), score });
  }
  const qualified = cells.filter((c) => c.observations >= 4);
  const overallScore = qualified.length ? Math.round(mean(qualified.map((c) => c.score))) : 0;
  return { generatedAt: new Date().toISOString(), samples, horizons: [...HORIZONS], overallScore, cells: cells.sort((a, b) => b.score - a.score) };
}

function seeded(seed: number) {
  let x = seed >>> 0;
  return () => { x = (1664525 * x + 1013904223) >>> 0; return x / 4294967296; };
}

function simulateMonteCarloPool(returnPool: number[], label: string, assetClass: AssetClass | "ALL", regime: QuantRegime | "ALL", paths = 2500): MonteCarloSegment {
  if (returnPool.length < 25) return { key: `${assetClass}|${regime}`, label, assetClass, regime, observations: returnPool.length, paths: 0, probabilityProfitPct: 0, medianReturnPct: 0, p05ReturnPct: 0, expectedShortfall95Pct: 0, medianMaxDrawdownPct: 0, p95MaxDrawdownPct: 0, riskOfRuin10Pct: 0, status: "UNAVAILABLE" };
  const seedText = `${new Date().toISOString().slice(0,10)}|${assetClass}|${regime}`;
  const seed = [...seedText].reduce((acc, ch) => ((acc * 31) + ch.charCodeAt(0)) >>> 0, 2166136261);
  const rand = seeded(seed);
  const finals: number[] = [];
  const drawdowns: number[] = [];
  for (let p = 0; p < paths; p += 1) {
    let equity = 1, peak = 1, maxDd = 0;
    for (let d = 0; d < 30; d += 1) {
      const r = returnPool[Math.floor(rand() * returnPool.length)] ?? 0;
      equity *= 1 + r;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, peak ? (peak - equity) / peak : 0);
    }
    finals.push((equity - 1) * 100);
    drawdowns.push(maxDd * 100);
  }
  finals.sort((a,b)=>a-b); drawdowns.sort((a,b)=>a-b);
  const idx=(q:number,arr:number[])=>arr[Math.min(arr.length-1,Math.max(0,Math.floor(q*arr.length)))]??0;
  const tail=finals.slice(0,Math.max(1,Math.floor(paths*0.05)));
  const probabilityProfitPct=finals.filter((v)=>v>0).length/paths*100;
  const p95Dd=idx(0.95,drawdowns);
  const riskOfRuin=finals.filter((v)=>v<=-10).length/paths*100;
  const status = riskOfRuin > 15 || p95Dd > 25 ? "BLOCK" : riskOfRuin > 6 || p95Dd > 15 ? "CAUTION" : "PASS";
  return { key: `${assetClass}|${regime}`, label, assetClass, regime, observations: returnPool.length, paths, probabilityProfitPct: round(probabilityProfitPct,1), medianReturnPct: round(idx(0.5,finals),2), p05ReturnPct: round(idx(0.05,finals),2), expectedShortfall95Pct: round(mean(tail),2), medianMaxDrawdownPct: round(idx(0.5,drawdowns),2), p95MaxDrawdownPct: round(p95Dd,2), riskOfRuin10Pct: round(riskOfRuin,1), status };
}

export function buildMonteCarlo(analyses: SymbolAnalysis[], historyMap: Map<string, PriceBar[]>): MonteCarloSummary {
  const selected = analyses.filter((a) => a.source !== "SIMULATED_FALLBACK" && a.dataQuality.score >= 70 && a.action !== "AVOID").slice(0, 12);
  const pools = new Map<string, { label: string; assetClass: AssetClass | "ALL"; regime: QuantRegime | "ALL"; returns: number[] }>();
  const ensure = (key: string, label: string, assetClass: AssetClass | "ALL", regime: QuantRegime | "ALL") => {
    const existing = pools.get(key) ?? { label, assetClass, regime, returns: [] as number[] };
    pools.set(key, existing);
    return existing.returns;
  };
  const aggregate = ensure("ALL|ALL", "All verified candidates", "ALL", "ALL");
  for (const a of selected) {
    const bars = historyMap.get(a.symbol) ?? [];
    const closes = bars.slice(-160).map((b) => b.close);
    const regime = a.quantRegime?.regime ?? "UNKNOWN";
    const assetPool = ensure(`${a.assetClass}|ALL`, `${a.assetClass === "CRYPTO" ? "Crypto" : "Equity"} aggregate`, a.assetClass, "ALL");
    const regimePool = ensure(`${a.assetClass}|${regime}`, `${a.assetClass === "CRYPTO" ? "Crypto" : "Equity"} · ${regime.replaceAll("_"," ")}`, a.assetClass, regime);
    for (let i=1;i<closes.length;i+=1) {
      const r=closes[i-1] ? closes[i]/closes[i-1]-1 : 0;
      const cap=a.assetClass==="CRYPTO"?0.20:0.10;
      const clipped=Math.max(-cap,Math.min(cap,r));
      aggregate.push(clipped); assetPool.push(clipped); regimePool.push(clipped);
    }
  }
  const overall = simulateMonteCarloPool(aggregate, "All verified candidates", "ALL", "ALL", 4000);
  const segments = [...pools.entries()]
    .filter(([key]) => key !== "ALL|ALL")
    .map(([,p]) => simulateMonteCarloPool(p.returns,p.label,p.assetClass,p.regime,2200))
    .filter((s)=>s.paths>0)
    .sort((a,b)=>b.observations-a.observations)
    .slice(0,8);
  if (!overall.paths) return { paths: 0, horizonDays: 30, probabilityProfitPct: 0, medianReturnPct: 0, p05ReturnPct: 0, expectedShortfall95Pct: 0, medianMaxDrawdownPct: 0, p95MaxDrawdownPct: 0, riskOfRuin10Pct: 0, status: "UNAVAILABLE", segments, notes: ["Not enough verified return history for Monte Carlo simulation."] };
  return { paths: overall.paths, horizonDays: 30, probabilityProfitPct: overall.probabilityProfitPct, medianReturnPct: overall.medianReturnPct, p05ReturnPct: overall.p05ReturnPct, expectedShortfall95Pct: overall.expectedShortfall95Pct, medianMaxDrawdownPct: overall.medianMaxDrawdownPct, p95MaxDrawdownPct: overall.p95MaxDrawdownPct, riskOfRuin10Pct: overall.riskOfRuin10Pct, status: overall.status, segments, notes: [`Bootstrap uses ${aggregate.length} recent verified daily returns from ${selected.length} high-quality candidates.`, "V5.2 also segments stress tests by asset class and current Regime V2 state so crypto tail risk cannot hide inside an equity average.", "This is a research stress test, not a forecast and not a live execution model."] };
}

function normalized(weights: Record<LearningAgentId, number>) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, v / sum])) as Record<LearningAgentId, number>;
}

export function buildChallengerLab(policy: LearningPolicy | undefined, robustness: RobustnessMatrix): ChallengerLab {
  const base = normalized({ trend: 0.30, momentum: 0.28, reversion: 0.18, breakout: 0.24 });
  const learned = policy?.segments?.GLOBAL?.agents?.length ? normalized(Object.fromEntries(policy.segments.GLOBAL.agents.map((a) => [a.id, a.learnedWeight])) as Record<LearningAgentId, number>) : base;
  const championWeights = policy?.decisionWeightsActive ? learned : base;
  const variants: Array<{ id: string; name: string; weights: Record<LearningAgentId, number> }> = [
    { id: "trend_tilt", name: "Trend Tilt", weights: normalized({ ...championWeights, trend: championWeights.trend * 1.18, reversion: championWeights.reversion * 0.88 }) },
    { id: "momentum_tilt", name: "Momentum Tilt", weights: normalized({ ...championWeights, momentum: championWeights.momentum * 1.18, breakout: championWeights.breakout * 0.94 }) },
    { id: "defensive", name: "Defensive Reversion", weights: normalized({ ...championWeights, reversion: championWeights.reversion * 1.22, momentum: championWeights.momentum * 0.90 }) },
    { id: "breakout_tilt", name: "Breakout Tilt", weights: normalized({ ...championWeights, breakout: championWeights.breakout * 1.18, trend: championWeights.trend * 0.94 }) },
  ];
  const strategyScore = (weights: Record<LearningAgentId, number>) => {
    let total = 0, weight = 0;
    for (const s of STRATEGIES) {
      const cells = robustness.cells.filter((c) => c.strategy === s.id && c.observations >= 4 && [5, 10, 20].includes(c.horizonBars));
      const avg = cells.length ? mean(cells.map((c) => c.score)) : 50;
      total += avg * weights[s.id]; weight += weights[s.id];
    }
    return weight ? total / weight : 0;
  };
  const championScore = round(strategyScore(championWeights), 1);
  const challengers: ChallengerVariant[] = variants.map((v) => ({ ...v, robustnessScore: round(strategyScore(v.weights), 1), status: "SHADOW_ONLY" }));
  const leader = [...challengers].sort((a, b) => b.robustnessScore - a.robustnessScore)[0];
  return { champion: { name: policy?.decisionWeightsActive ? "Validated Learned Policy" : "Baseline Policy", weights: championWeights, robustnessScore: championScore }, challengers, shadowLeader: leader?.robustnessScore > championScore + 3 ? leader.id : null, notes: ["Challengers are bounded parameter tilts and remain shadow-only. V5 never auto-promotes a challenger into live decision authority.", "A challenger must first beat the champion across robustness and future forward evidence."] };
}

export function buildCounterfactualSummary(analyses: SymbolAnalysis[], historical?: CounterfactualSummary): CounterfactualSummary {
  const current = new Map<string, number>();
  for (const a of analyses.filter((x) => x.action !== "BUY_SETUP")) for (const reason of a.gateReasons) current.set(reason, (current.get(reason) ?? 0) + 1);
  return { completed: historical?.completed ?? 0, pending: historical?.pending ?? 0, gates: historical?.gates ?? [], currentBlockers: [...current.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8), notes: historical?.notes ?? ["Historical counterfactual outcomes start accumulating after the V5 Supabase migration."] };
}

export function buildQuantIntelligence(args: { analyses: SymbolAnalysis[]; histories: HistoryInput[]; equityRegime: QuantRegimeProfile; cryptoRegime: QuantRegimeProfile; learning?: LearningPolicy; validation?: ValidationSummary; counterfactual?: CounterfactualSummary }): QuantIntelligence {
  const historyMap = new Map(args.histories.map((h) => [h.symbol, h.bars]));
  const robustness = buildRobustnessMatrix(args.histories);
  const monteCarlo = buildMonteCarlo(args.analyses, historyMap);
  const challengers = buildChallengerLab(args.learning, robustness);
  const counterfactual = buildCounterfactualSummary(args.analyses, args.counterfactual);
  const executionScores = args.analyses.slice(0, 8).map(executionQualityProxy).map((e) => e.score);
  const executionProxyScore = executionScores.length ? Math.round(mean(executionScores)) : 0;
  const regimeConfidence = Math.round((args.equityRegime.confidence + args.cryptoRegime.confidence) / 2);
  const dataIntegrity = Math.round(mean(args.analyses.slice(0, 20).map((a) => a.dataQuality.score)));
  const mcScore = monteCarlo.status === "PASS" ? 85 : monteCarlo.status === "CAUTION" ? 58 : monteCarlo.status === "BLOCK" ? 25 : 35;
  const forwardTrust = args.validation?.trustScore ?? 0;
  const score = Math.round(dataIntegrity * 0.20 + regimeConfidence * 0.15 + robustness.overallScore * 0.25 + mcScore * 0.20 + forwardTrust * 0.20);
  const blockers: string[] = [];
  if (forwardTrust < 30) blockers.push(`Forward Trust ${forwardTrust}/100 is below the minimum research-confidence threshold.`);
  if (robustness.overallScore < 60) blockers.push(`Robustness ${robustness.overallScore}/100 is below 60.`);
  if (monteCarlo.status === "BLOCK") blockers.push(`Aggregate Monte Carlo is BLOCK; ${monteCarlo.riskOfRuin10Pct.toFixed(1)}% of paths lose at least 10%.`);
  for (const seg of monteCarlo.segments.filter((x) => x.status === "BLOCK").slice(0,3)) blockers.push(`${seg.label} Monte Carlo is BLOCK (${seg.riskOfRuin10Pct.toFixed(1)}% risk of >10% loss).`);
  if (args.learning?.mode === "FROZEN") blockers.push("Adaptive learner is FROZEN by drift control; baseline decision weights remain in force.");
  else if (args.learning?.mode === "GUARDED") blockers.push("Adaptive learner is GUARDED; learned weights remain research-only.");
  if ((args.validation?.completed ?? 0) < 10) blockers.push(`Only ${args.validation?.completed ?? 0} actionable outcomes are complete; decision adaptation requires 10.`);
  return {
    regimeV2: { equity: args.equityRegime, crypto: args.cryptoRegime }, robustness, monteCarlo, challengers, counterfactual,
    readiness: { score, dataIntegrity, regimeConfidence, robustness: robustness.overallScore, monteCarloRisk: mcScore, forwardTrust, executionProxy: executionProxyScore, status: forwardTrust >= 60 && args.validation?.liveReadiness.status !== "NOT_READY" ? "PILOT_RESEARCH" : "RESEARCH_ONLY", rationale: blockers[0] ?? "Quant research is maturing, but broker execution remains human-gated.", blockers },
  };
}
