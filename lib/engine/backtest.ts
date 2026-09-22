import { ENGINE } from "./config";
import { snapshot } from "./indicators";
import { detectRegime, rawVotes } from "./strategies";
import type { PriceBar, Regime, StrategyLabResult, StrategyMetrics, StrategyState, StrategyValidation, WalkForwardFold } from "./types";

type StrategyId = StrategyMetrics["id"];

const STRATEGIES: Array<{ id: StrategyId; name: string }> = [
  { id: "trend", name: "Trend" },
  { id: "momentum", name: "Momentum" },
  { id: "reversion", name: "Mean Reversion" },
  { id: "breakout", name: "Breakout" },
  { id: "ensemble", name: "Agent Ensemble" },
];

function clamp(v: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}

function round(v: number, d = 2) {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function signalFor(id: StrategyId, bars: PriceBar[], regime: Regime): 0 | 1 {
  const s = snapshot(bars);
  if (!s.sma20 || !s.sma50 || !s.rsi14) return 0;
  if (id === "trend") return s.close > s.sma50 && s.sma20 > s.sma50 && (s.return20Pct ?? 0) > -1 ? 1 : 0;
  if (id === "momentum") return (s.return20Pct ?? 0) > 2 && s.rsi14 >= 50 && s.rsi14 <= 76 ? 1 : 0;
  if (id === "reversion") return (s.z20 ?? 0) < -1.05 && s.rsi14 < 44 && (!s.sma200 || s.close > s.sma200 * 0.96) ? 1 : 0;
  if (id === "breakout") {
    const prior = bars.slice(0, -1);
    const priorHigh = prior.length >= 20 ? Math.max(...prior.slice(-20).map((b) => b.high)) : Infinity;
    return s.close >= priorHigh * 0.995 && (s.volumeRatio20 ?? 1) >= 0.8 ? 1 : 0;
  }
  const votes = rawVotes(bars, bars.length >= 200 ? detectRegime(bars) : regime);
  const weighted = votes.reduce((sum, v) => sum + v.score * v.weight, 0) / Math.max(0.0001, votes.reduce((sum, v) => sum + v.weight, 0));
  return weighted >= 0.24 ? 1 : 0;
}

function computeSignals(id: StrategyId, bars: PriceBar[], regime: Regime) {
  const signals: Array<0 | 1> = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (i < 55) signals.push(0);
    else signals.push(signalFor(id, bars.slice(0, i + 1), regime));
  }
  return signals;
}

function metrics(id: StrategyId, name: string, bars: PriceBar[], signals: Array<0 | 1>, startIndex: number, periodsPerYear = 252): StrategyMetrics {
  const dailyReturns: number[] = [];
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let trades = 0;
  let investedDays = 0;
  let positiveInvestedDays = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  const cost = ENGINE.transactionCostBps / 10_000;
  const first = Math.max(1, startIndex);

  for (let i = first; i < bars.length; i += 1) {
    const position = signals[i - 1] ?? 0;
    const previousPosition = signals[i - 2] ?? 0;
    const assetReturn = bars[i - 1].close ? bars[i].close / bars[i - 1].close - 1 : 0;
    const turnoverCost = position !== previousPosition ? cost : 0;
    if (position === 1 && previousPosition === 0) trades += 1;
    const strategyReturn = position * assetReturn - turnoverCost;
    if (position) {
      investedDays += 1;
      if (strategyReturn > 0) positiveInvestedDays += 1;
    }
    if (strategyReturn > 0) grossProfit += strategyReturn;
    else grossLoss += Math.abs(strategyReturn);
    dailyReturns.push(strategyReturn);
    equity *= 1 + strategyReturn;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak ? (peak - equity) / peak : 0);
  }

  const benchmarkStart = bars[Math.max(0, first - 1)]?.close ?? bars[0]?.close ?? 1;
  const benchmarkEnd = bars.at(-1)?.close ?? benchmarkStart;
  const total = equity - 1;
  const years = Math.max(1 / periodsPerYear, dailyReturns.length / periodsPerYear);
  const avg = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const variance = dailyReturns.length ? dailyReturns.reduce((s, r) => s + (r - avg) ** 2, 0) / dailyReturns.length : 0;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(periodsPerYear) : 0;

  return {
    id,
    name,
    totalReturnPct: round(total * 100),
    annualizedReturnPct: round((Math.pow(Math.max(equity, 0.0001), 1 / years) - 1) * 100),
    benchmarkReturnPct: round((benchmarkEnd / benchmarkStart - 1) * 100),
    maxDrawdownPct: round(maxDrawdown * 100),
    sharpe: round(sharpe),
    winRatePct: round(investedDays ? (positiveInvestedDays / investedDays) * 100 : 0),
    profitFactor: round(grossLoss > 0 ? Math.min(99, grossProfit / grossLoss) : grossProfit > 0 ? 99 : 0),
    trades,
    exposurePct: round(dailyReturns.length ? (investedDays / dailyReturns.length) * 100 : 0),
  };
}

function scoreMetric(m: StrategyMetrics) {
  const relative = m.totalReturnPct - m.benchmarkReturnPct;
  return m.sharpe * 0.45 + relative / 25 - m.maxDrawdownPct / 35 + Math.min(m.trades, 15) / 100;
}

function strategyState(stability: number, medianRelative: number, positiveFoldPct: number): StrategyState {
  if (stability < 28 || medianRelative < -4 || positiveFoldPct < 25) return "RETIRED";
  if (stability < 52 || medianRelative < 0 || positiveFoldPct < 50) return "PROBATION";
  return "ACTIVE";
}

function buildWalkForward(bars: PriceBar[], periodsPerYear: number, signalsByStrategy: Map<StrategyId, Array<0 | 1>>): WalkForwardFold[] {
  const testBars = ENGINE.walkForwardTestBars;
  const folds = ENGINE.walkForwardFolds;
  const minimumTrainingBars = 120;
  const available = Math.floor((bars.length - minimumTrainingBars) / testBars);
  const count = Math.max(1, Math.min(folds, available));
  const output: WalkForwardFold[] = [];
  const firstStart = bars.length - count * testBars;

  for (let fold = 0; fold < count; fold += 1) {
    const start = firstStart + fold * testBars;
    const endExclusive = Math.min(bars.length, start + testBars);
    const foldBars = bars.slice(0, endExclusive);
    const metricsForFold = STRATEGIES.map((strategy) => {
      const signals = signalsByStrategy.get(strategy.id)?.slice(0, endExclusive) ?? [];
      return metrics(strategy.id, strategy.name, foldBars, signals, start, periodsPerYear);
    });
    output.push({
      fold: fold + 1,
      start: bars[start]?.date ?? "",
      end: bars[endExclusive - 1]?.date ?? "",
      metrics: metricsForFold,
    });
  }
  return output;
}

function summarizeValidation(walkForward: WalkForwardFold[]): StrategyValidation[] {
  return STRATEGIES.map((strategy) => {
    const rows = walkForward.map((fold) => fold.metrics.find((m) => m.id === strategy.id)).filter((m): m is StrategyMetrics => Boolean(m));
    const returns = rows.map((m) => m.totalReturnPct);
    const sharpes = rows.map((m) => m.sharpe);
    const drawdowns = rows.map((m) => m.maxDrawdownPct);
    const relative = rows.map((m) => m.totalReturnPct - m.benchmarkReturnPct);
    const positiveFolds = relative.filter((r) => r > 0).length;
    const positiveFoldPct = rows.length ? (positiveFolds / rows.length) * 100 : 0;
    const medReturn = median(returns);
    const medSharpe = median(sharpes);
    const medRelative = median(relative);
    const worstDd = Math.max(0, ...drawdowns);
    const consistencyComponent = positiveFoldPct * 0.5;
    const sharpeComponent = Math.max(0, Math.min(20, (medSharpe + 0.25) * 8));
    const relativeComponent = Math.max(0, Math.min(20, 10 + medRelative * 2));
    const drawdownComponent = Math.max(0, Math.min(10, 10 - worstDd * 0.5));
    let stabilityScore = round(Math.max(0, Math.min(100, consistencyComponent + sharpeComponent + relativeComponent + drawdownComponent)), 0);
    // Consistency is non-negotiable: a strategy cannot earn a high stability score
    // solely from one high-Sharpe period while failing the relative-return test in most folds.
    if (positiveFoldPct === 0) stabilityScore = Math.min(stabilityScore, 20);
    else if (positiveFoldPct < 50) stabilityScore = Math.min(stabilityScore, 45);
    if (medRelative < 0) stabilityScore = Math.min(stabilityScore, 55);
    return {
      id: strategy.id,
      name: strategy.name,
      folds: rows.length,
      positiveFolds,
      positiveFoldPct: round(positiveFoldPct),
      medianReturnPct: round(medReturn),
      medianSharpe: round(medSharpe),
      worstDrawdownPct: round(worstDd),
      medianRelativeReturnPct: round(medRelative),
      stabilityScore,
      state: strategyState(stabilityScore, medRelative, positiveFoldPct),
    };
  });
}

export function runStrategyLab(symbol: string, source: StrategyLabResult["source"], bars: PriceBar[], regime: Regime): StrategyLabResult {
  const periodsPerYear = source === "KRAKEN_CRYPTO_DAILY" ? 365 : 252;
  const split = Math.max(60, Math.floor(bars.length * 0.75));
  const signalsByStrategy = new Map<StrategyId, Array<0 | 1>>();
  for (const strategy of STRATEGIES) signalsByStrategy.set(strategy.id, computeSignals(strategy.id, bars, regime));
  const full = STRATEGIES.map((strategy) => metrics(strategy.id, strategy.name, bars, signalsByStrategy.get(strategy.id) ?? [], 55, periodsPerYear));
  const outOfSample = STRATEGIES.map((strategy) => metrics(strategy.id, strategy.name, bars, signalsByStrategy.get(strategy.id) ?? [], split, periodsPerYear));
  const winner = [...outOfSample].sort((a, b) => scoreMetric(b) - scoreMetric(a))[0];
  const walkForward = buildWalkForward(bars, periodsPerYear, signalsByStrategy);
  const validation = summarizeValidation(walkForward);
  const activeValidation = validation.filter((v) => v.state !== "RETIRED");
  const validationWinner = [...(activeValidation.length ? activeValidation : validation)].sort((a, b) => b.stabilityScore - a.stabilityScore)[0];

  return {
    symbol,
    source,
    asOf: bars.at(-1)?.date ?? new Date().toISOString().slice(0, 10),
    bars: bars.length,
    trainPct: 75,
    outOfSamplePct: 25,
    full,
    outOfSample,
    winner,
    walkForward,
    validation,
    validationWinner,
    notes: [
      "Signals use only information available at each historical bar; positions are applied on the following bar to reduce look-ahead bias.",
      `V4.1 also evaluates the same rules across ${walkForward.length} rolling forward windows. Stability is rewarded only when performance repeats across windows rather than depending on one lucky period.`,
      `${ENGINE.transactionCostBps} bps is charged whenever strategy position state changes. Taxes, borrow costs, market impact and broker-specific fills remain outside this model.`,
      "A RETIRED strategy receives minimal influence for that symbol; PROBATION strategies are down-weighted; ACTIVE strategies can earn normal influence.",
      source === "SIMULATED_FALLBACK" ? "Market-data fallback is simulated; these metrics are for UI testing only." : source === "KRAKEN_CRYPTO_DAILY" ? "Kraken completed daily crypto candles are used; this is not an intraday execution model." : "Stooq end-of-day equity data is used; this is not an intraday execution model.",
    ],
  };
}

export function strategyHealthFromLab(lab: StrategyLabResult): Record<string, number> {
  const result: Record<string, number> = {};
  for (const validation of lab.validation) {
    if (validation.id === "ensemble") continue;
    const stateMultiplier = validation.state === "ACTIVE" ? 1 : validation.state === "PROBATION" ? 0.58 : 0.12;
    result[validation.id] = clamp((0.15 + validation.stabilityScore / 100 * 0.85) * stateMultiplier, 0.03, 0.98);
  }
  return result;
}

export function strategyStatesFromLab(lab: StrategyLabResult): Record<string, StrategyState> {
  const result: Record<string, StrategyState> = {};
  for (const validation of lab.validation) {
    if (validation.id !== "ensemble") result[validation.id] = validation.state;
  }
  return result;
}
