import { CRYPTO_BENCHMARK, DEFAULT_RISK_SETTINGS, DEFAULT_WATCHLIST, ENGINE, EQUITY_BENCHMARK } from "./config";
import { runStrategyLab, strategyHealthFromLab, strategyStatesFromLab } from "./backtest";
import { correlationStatus, returnCorrelation } from "./correlation";
import { eventRiskFor, loadEarningsCalendar } from "./events";
import { assetClassForSymbol, getHistory } from "./market-data";
import { snapshot } from "./indicators";
import { buildOvernightPlan } from "./overnight";
import { assessDataQuality } from "./quality";
import { actionFor, buildTradePlan, portfolioExposure } from "./risk";
import { detectRegime, rawVotes, scoreWithCritic } from "./strategies";
import type { AgentVote, AssetClass, EvidenceProfile, LearningAgentId, LearningPolicy, MarketDataHealth, MarketDataHealthItem, PositionInput, RiskSettings, ScanRequest, ScanResult, SymbolAnalysis } from "./types";

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function round(v: number, d = 2) {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

async function mapWithConcurrency<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}


function adaptiveWeights(policy: LearningPolicy | undefined, assetClass: AssetClass) {
  if (!policy || policy.mode !== "ADAPTIVE") return undefined;
  const specific = policy.segments[assetClass];
  const segment = specific && specific.sampleCount >= 10 ? specific : policy.segments.GLOBAL;
  return Object.fromEntries(segment.agents.map((agent) => [agent.id, agent.learnedWeight])) as Partial<Record<LearningAgentId, number>>;
}

export function normalizeSettings(input?: Partial<RiskSettings>): RiskSettings {
  return {
    accountSize: clamp(Number(input?.accountSize ?? DEFAULT_RISK_SETTINGS.accountSize), 1000, 100_000_000),
    riskPerTradePct: clamp(Number(input?.riskPerTradePct ?? DEFAULT_RISK_SETTINGS.riskPerTradePct), 0.05, 2),
    maxPositionPct: clamp(Number(input?.maxPositionPct ?? DEFAULT_RISK_SETTINGS.maxPositionPct), 1, 30),
    maxPortfolioExposurePct: clamp(Number(input?.maxPortfolioExposurePct ?? DEFAULT_RISK_SETTINGS.maxPortfolioExposurePct), 5, 100),
    rewardRiskTarget: clamp(Number(input?.rewardRiskTarget ?? DEFAULT_RISK_SETTINGS.rewardRiskTarget), 1, 5),
    atrStopMultiple: clamp(Number(input?.atrStopMultiple ?? DEFAULT_RISK_SETTINGS.atrStopMultiple), 0.5, 5),
    overnightPaperBudgetGbp: clamp(Number(input?.overnightPaperBudgetGbp ?? DEFAULT_RISK_SETTINGS.overnightPaperBudgetGbp), 0, 50),
  };
}

export function normalizeSymbols(input?: string[]) {
  const source = input?.length ? input : DEFAULT_WATCHLIST;
  const clean = source.map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.-]{1,12}$/.test(s));
  return [...new Set(clean)].slice(0, ENGINE.maxSymbolsPerScan);
}

export function normalizePositions(input?: PositionInput[]) {
  const clean = (input ?? [])
    .map((p) => ({ symbol: String(p.symbol ?? "").trim().toUpperCase(), qty: Number(p.qty), avgPrice: Number(p.avgPrice) }))
    .filter((p) => /^[A-Z0-9.-]{1,12}$/.test(p.symbol) && Number.isFinite(p.qty) && p.qty > 0 && Number.isFinite(p.avgPrice) && p.avgPrice > 0)
    .map((p) => ({ ...p, qty: Math.min(p.qty, 1_000_000_000), avgPrice: Math.min(p.avgPrice, 100_000_000) }));
  return [...new Map(clean.map((p) => [p.symbol, p])).values()].slice(0, ENGINE.maxSymbolsPerScan);
}

function bandForEvidence(score: number): EvidenceProfile["band"] {
  if (score >= 82) return "VERY_STRONG";
  if (score >= 68) return "STRONG";
  if (score >= 54) return "DEVELOPING";
  return "WEAK";
}

function diversificationScore(status: ReturnType<typeof correlationStatus>) {
  if (status === "LOW") return 90;
  if (status === "MODERATE") return 66;
  if (status === "HIGH") return 38;
  return 72;
}

function historyPassesDataGate(source: import("./types").MarketSource, quality: ReturnType<typeof assessDataQuality>, assetClass: "EQUITY" | "CRYPTO") {
  const maxFreshnessDays = assetClass === "CRYPTO" ? 2 : 5;
  return source !== "SIMULATED_FALLBACK" && quality.score >= 60 && quality.freshnessDays <= maxFreshnessDays && quality.bars >= ENGINE.minimumBars;
}

function sourceLabel(source: string) {
  if (source === "YAHOO_CHART_DAILY") return "Yahoo chart daily";
  if (source === "STOOQ_EOD") return "Stooq backup";
  if (source === "KRAKEN_CRYPTO_DAILY") return "Kraken daily";
  return "fallback";
}

function marketHealthItem(
  histories: Array<{ symbol: string; source: string; bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> }>,
  assetClass: "EQUITY" | "CRYPTO",
  benchmark: string,
): MarketDataHealthItem {
  const scored = histories.map((history) => ({
    history,
    quality: assessDataQuality(history.source as import("./types").MarketSource, history.bars, assetClass),
  }));
  const verifiedRows = scored.filter(({ history, quality }) => historyPassesDataGate(history.source as import("./types").MarketSource, quality, assetClass));
  const benchmarkRow = scored.find(({ history }) => history.symbol === benchmark);
  const benchmarkVerified = Boolean(benchmarkRow && historyPassesDataGate(benchmarkRow.history.source as import("./types").MarketSource, benchmarkRow.quality, assetClass));
  const status = verifiedRows.length === scored.length && benchmarkVerified ? "HEALTHY" : verifiedRows.length && benchmarkVerified ? "DEGRADED" : "UNAVAILABLE";
  const sourceCounts = new Map<string, number>();
  for (const { history } of verifiedRows) sourceCounts.set(sourceLabel(history.source), (sourceCounts.get(sourceLabel(history.source)) ?? 0) + 1);
  const primary = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";
  const dates = verifiedRows.map(({ history }) => history.bars.at(-1)?.date).filter((v): v is string => Boolean(v)).sort();
  const asOf = dates.at(-1) ?? null;
  return {
    status,
    verified: verifiedRows.length,
    total: scored.length,
    primary,
    detail: benchmarkVerified
      ? `${verifiedRows.length}/${scored.length} symbols passed the data gate; ${benchmark} verified.`
      : `${benchmark} failed the benchmark data gate; ${assetClass.toLowerCase()} regime and new entries are disabled.`,
    asOf,
  };
}

export async function runPersonalScan(input: ScanRequest = {}, learning?: LearningPolicy): Promise<ScanResult> {
  const settings = normalizeSettings(input.settings);
  const symbols = normalizeSymbols(input.symbols);
  const positions = normalizePositions(input.positions);
  const heldSymbols = positions.filter((p) => p.qty > 0).map((p) => p.symbol);
  const requested = [...new Set([EQUITY_BENCHMARK, CRYPTO_BENCHMARK, ...symbols, ...heldSymbols])];
  const [histories, earnings] = await Promise.all([
    mapWithConcurrency(requested, ENGINE.marketDataConcurrency, (symbol) => getHistory(symbol)),
    loadEarningsCalendar(),
  ]);
  const bySymbol = new Map(histories.map((h) => [h.symbol, h]));
  const equityBenchmarkHistory = bySymbol.get(EQUITY_BENCHMARK);
  const cryptoBenchmarkHistory = bySymbol.get(CRYPTO_BENCHMARK);
  const equityBenchmarkQuality = equityBenchmarkHistory ? assessDataQuality(equityBenchmarkHistory.source, equityBenchmarkHistory.bars, "EQUITY") : null;
  const cryptoBenchmarkQuality = cryptoBenchmarkHistory ? assessDataQuality(cryptoBenchmarkHistory.source, cryptoBenchmarkHistory.bars, "CRYPTO") : null;
  const equityBenchmarkVerified = Boolean(equityBenchmarkHistory && equityBenchmarkQuality && historyPassesDataGate(equityBenchmarkHistory.source, equityBenchmarkQuality, "EQUITY"));
  const cryptoBenchmarkVerified = Boolean(cryptoBenchmarkHistory && cryptoBenchmarkQuality && historyPassesDataGate(cryptoBenchmarkHistory.source, cryptoBenchmarkQuality, "CRYPTO"));
  const equityRegime = equityBenchmarkVerified && equityBenchmarkHistory ? detectRegime(equityBenchmarkHistory.bars) : "UNKNOWN";
  const cryptoRegime = cryptoBenchmarkVerified && cryptoBenchmarkHistory ? detectRegime(cryptoBenchmarkHistory.bars) : "UNKNOWN";
  const prices = new Map(histories.map((h) => [h.symbol, h.bars.at(-1)?.close ?? 0]));
  const exposure = portfolioExposure(positions, prices);
  const warnings = histories.map((h) => h.warning).filter((v): v is string => Boolean(v));
  const stooqBackups = histories.filter((h) => h.source === "STOOQ_EOD").length;
  if (stooqBackups) warnings.push(`Equity primary feed degraded for ${stooqBackups} requested symbol${stooqBackups === 1 ? "" : "s"}; verified Stooq backup data was used instead.`);
  if (!earnings.configured) warnings.push("ALPHAVANTAGE_API_KEY is not configured, so equity earnings dates remain unverified. Price/volume anomaly checks still run.");
  if (earnings.warning) warnings.push(earnings.warning);
  if (!equityBenchmarkVerified) warnings.push("Equity regime unavailable: SPY failed the verified-data gate. V4.1 will not open a new equity setup until the benchmark is real and fresh.");
  if (!cryptoBenchmarkVerified) warnings.push("Crypto regime unavailable: BTC-USD failed the verified-data gate. V4.1 will not open a new crypto setup until the benchmark is real and fresh.");

  if (learning?.mode === "ADAPTIVE") warnings.push(`V4.1 adaptive learner active: policy v${learning.version}, ${learning.sampleCount} completed signals, confidence calibration ${learning.confidenceAdjustmentPct >= 0 ? "+" : ""}${learning.confidenceAdjustmentPct.toFixed(1)} points.`);
  else if (learning?.mode === "SHADOW") warnings.push(`V4.1 learner is in SHADOW mode with ${learning.sampleCount} completed signals. Learned weights are tracked but baseline weights still drive decisions.`);
  else if (learning?.mode === "FROZEN") warnings.push(`V4.1 adaptive learning is FROZEN by drift control (drift ${learning.driftScore.toFixed(0)}/100); baseline weights are being used.`);

  const analyses: SymbolAnalysis[] = [];
  for (const symbol of symbols) {
    const history = bySymbol.get(symbol);
    if (!history) continue;
    const assetClass = assetClassForSymbol(symbol);
    const regime = assetClass === "CRYPTO" ? cryptoRegime : equityRegime;
    const indicators = snapshot(history.bars);
    const lab = runStrategyLab(symbol, history.source, history.bars, regime);
    const health = strategyHealthFromLab(lab);
    const strategyStates = strategyStatesFromLab(lab);
    const baseVotes = rawVotes(history.bars, regime);
    const scored = scoreWithCritic(baseVotes, history.bars, regime, health, adaptiveWeights(learning, assetClass));
    const quality = assessDataQuality(history.source, history.bars, assetClass);
    const eventRisk = eventRiskFor(symbol, assetClass, indicators, earnings);

    const pairCorrelations: Record<string, number> = {};
    for (const peer of symbols) {
      if (peer === symbol) continue;
      const peerHistory = bySymbol.get(peer);
      if (!peerHistory || assetClassForSymbol(peer) !== assetClass) continue;
      const corr = returnCorrelation(history.bars, peerHistory.bars);
      if (corr != null) pairCorrelations[peer] = round(corr, 3);
    }

    let maxCorrelation: number | null = null;
    let correlatedWith: string | null = null;
    for (const heldSymbol of heldSymbols) {
      if (heldSymbol === symbol || assetClassForSymbol(heldSymbol) !== assetClass) continue;
      const corr = pairCorrelations[heldSymbol] ?? (() => {
        const heldHistory = bySymbol.get(heldSymbol);
        return heldHistory ? returnCorrelation(history.bars, heldHistory.bars) : null;
      })();
      if (corr != null && (maxCorrelation == null || Math.abs(corr) > Math.abs(maxCorrelation))) {
        maxCorrelation = corr;
        correlatedWith = heldSymbol;
      }
    }
    const corrStatus = correlationStatus(maxCorrelation);
    const divScore = diversificationScore(corrStatus);
    const eventPenalty = eventRisk.level === "BLOCK" ? 42 : eventRisk.level === "CAUTION" ? 16 : eventRisk.level === "UNVERIFIED" ? 7 : 0;
    const strategyStability = lab.validationWinner?.stabilityScore ?? 0;
    const scoreComponent = clamp(50 + scored.score * 50, 0, 100);
    const evidenceScore = Math.round(clamp(
      scoreComponent * 0.24 + scored.confidence * 0.16 + strategyStability * 0.27 + quality.score * 0.23 + divScore * 0.10 - eventPenalty,
      0,
      100,
    ));
    const evidence: EvidenceProfile = {
      score: evidenceScore,
      band: bandForEvidence(evidenceScore),
      walkForwardStability: strategyStability,
      dataQualityScore: quality.score,
      diversificationScore: divScore,
      eventRiskPenalty: eventPenalty,
      rationale: `Evidence combines agent score, rolling forward stability, source quality, portfolio overlap and event risk. ${lab.validationWinner?.name ?? "No strategy"} has ${strategyStability}/100 walk-forward stability.`,
    };

    const held = positions.some((p) => p.symbol === symbol && p.qty > 0);
    const learningConfidenceAdjustment = learning?.mode === "ADAPTIVE" ? learning.confidenceAdjustmentPct : 0;
    const adjustedConfidence = Math.round(clamp(scored.confidence * 0.48 + strategyStability * 0.27 + quality.score * 0.25 - eventPenalty * 0.35 + learningConfidenceAdjustment, 25, 92));
    let action = actionFor(scored.score, held, regime, indicators.realizedVol20Pct, assetClass);
    if (!historyPassesDataGate(history.source, quality, assetClass)) action = "AVOID";
    if (action === "BUY_SETUP" && ((assetClass === "EQUITY" && !equityBenchmarkVerified) || (assetClass === "CRYPTO" && !cryptoBenchmarkVerified))) action = "WATCH";
    if (eventRisk.level === "BLOCK" && action === "BUY_SETUP") action = "WATCH";
    if (evidenceScore < 54 && action === "BUY_SETUP") action = "WATCH";
    if (Object.values(strategyStates).every((state) => state === "RETIRED") && action === "BUY_SETUP") action = "WATCH";
    if (corrStatus === "HIGH" && action === "BUY_SETUP" && heldSymbols.length) action = "WATCH";

    let plan = buildTradePlan(action, indicators, settings, exposure, assetClass);
    if (action === "BUY_SETUP" && plan.suggestedShares <= 0) {
      action = "WATCH";
      plan = buildTradePlan(action, indicators, settings, exposure, assetClass);
    }
    const remainingExposurePct = Math.max(0, settings.maxPortfolioExposurePct - (exposure / settings.accountSize) * 100);
    const riskVote: AgentVote = {
      id: "risk",
      name: "Risk Sentinel",
      score: remainingExposurePct > 5 ? 0.2 : -0.6,
      confidence: 100,
      rationale: `${Math.max(0, (exposure / settings.accountSize) * 100).toFixed(1)}% portfolio exposure vs ${settings.maxPortfolioExposurePct.toFixed(1)}% cap. Per-trade risk ${settings.riskPerTradePct.toFixed(2)}%.`,
      weight: 1,
    };
    const eventVote: AgentVote = {
      id: "event",
      name: "Event Risk Guard",
      score: eventRisk.level === "CLEAR" ? 0.18 : eventRisk.level === "BLOCK" ? -0.9 : eventRisk.level === "CAUTION" ? -0.45 : -0.12,
      confidence: eventRisk.level === "UNVERIFIED" ? 45 : 88,
      rationale: eventRisk.reason,
      weight: 1,
    };
    const correlationVote: AgentVote = {
      id: "correlation",
      name: "Correlation Guard",
      score: corrStatus === "HIGH" ? -0.65 : corrStatus === "MODERATE" ? -0.2 : 0.15,
      confidence: maxCorrelation == null ? 50 : 88,
      rationale: maxCorrelation == null ? "No comparable held-position correlation was available." : `${correlatedWith} has ${maxCorrelation.toFixed(2)} trailing return correlation with this candidate.`,
      weight: 1,
    };
    const qualityVote: AgentVote = {
      id: "quality",
      name: "Data Quality Gate",
      score: quality.score >= 85 ? 0.2 : quality.score >= 65 ? 0 : -0.7,
      confidence: 100,
      rationale: `${quality.grade}-grade data quality (${quality.score}/100), ${quality.bars} bars, latest bar ${quality.freshnessDays} day(s) old.`,
      weight: 1,
    };

    analyses.push({
      symbol,
      assetClass,
      source: history.source,
      asOf: history.bars.at(-1)?.date ?? new Date().toISOString().slice(0, 10),
      indicators,
      regime,
      score: round(scored.score, 3),
      confidence: adjustedConfidence,
      evidence,
      action,
      votes: [...scored.votes, riskVote, eventVote, correlationVote, qualityVote],
      strategyHealth: health,
      strategyStates,
      tradePlan: plan,
      eventRisk,
      dataQuality: quality,
      correlationRisk: {
        maxCorrelation: maxCorrelation == null ? null : round(maxCorrelation, 3),
        correlatedWith,
        threshold: ENGINE.correlationHighThreshold,
        status: corrStatus,
      },
      pairCorrelations,
      warnings: history.warning ? [history.warning] : [],
    });
  }

  analyses.sort((a, b) => (b.evidence.score - a.evidence.score) || (b.score - a.score));
  const overnightPlan = await buildOvernightPlan(analyses, settings.overnightPaperBudgetGbp);
  if (overnightPlan.fx.source === "FALLBACK") warnings.push("Daily GBP/USD FX lookup failed; the overnight paper planner used its fallback conversion rate.");

  const equityHistories = histories.filter((h) => assetClassForSymbol(h.symbol) === "EQUITY");
  const cryptoHistories = histories.filter((h) => assetClassForSymbol(h.symbol) === "CRYPTO");
  const dataHealth: MarketDataHealth = {
    equity: marketHealthItem(equityHistories, "EQUITY", EQUITY_BENCHMARK),
    crypto: marketHealthItem(cryptoHistories, "CRYPTO", CRYPTO_BENCHMARK),
    fx: {
      status: overnightPlan.fx.source === "FRANKFURTER_DAILY" ? "HEALTHY" : "DEGRADED",
      verified: overnightPlan.fx.source === "FRANKFURTER_DAILY" ? 1 : 0,
      total: 1,
      primary: overnightPlan.fx.source === "FRANKFURTER_DAILY" ? "Frankfurter daily" : "fallback",
      detail: overnightPlan.fx.source === "FRANKFURTER_DAILY" ? "GBP/USD reference loaded from the daily provider." : "GBP/USD provider failed; paper conversion is using a fallback rate.",
      asOf: overnightPlan.fx.asOf,
    },
    events: {
      status: earnings.configured && !earnings.warning ? "HEALTHY" : earnings.configured ? "DEGRADED" : "UNCONFIGURED",
      verified: earnings.configured && !earnings.warning ? 1 : 0,
      total: 1,
      primary: earnings.configured ? "Alpha Vantage earnings" : "none",
      detail: earnings.configured ? (earnings.warning ?? "Earnings calendar is configured for equity event checks.") : "Add ALPHAVANTAGE_API_KEY to verify near-term equity earnings dates.",
      asOf: new Date().toISOString().slice(0, 10),
    },
  };
  return {
    at: new Date().toISOString(),
    mode: "PERSONAL_RESEARCH",
    dataMode: "END_OF_DAY",
    benchmark: EQUITY_BENCHMARK,
    cryptoBenchmark: CRYPTO_BENCHMARK,
    regime: equityRegime,
    cryptoRegime,
    dataHealth,
    analyses,
    settings,
    overnightPlan,
    learning,
    warnings,
  };
}
