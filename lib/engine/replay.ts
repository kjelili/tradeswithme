// Historical trade replay. Walks each past day, makes the EXACT decision the live bot
// would have made using only bars available that day (shared decideSymbol core), then
// simulates the trade the executor would actually place and how it would exit.

import { ENGINE, KRAKEN_MAKER_ENTRY_DISCOUNT } from "./config";
import { decideSymbol, passesOvernightGate } from "./decision";
import { eventRiskFor } from "./events";
import { snapshot } from "./indicators";
import { detectRegime } from "./strategies";
import { chased, tradeEdge } from "./edge";
import type { AssetClass, DataQuality, MarketSource, PriceBar, RiskSettings } from "./types";
import { REALISTIC_COSTS, TAKER_ROUND_TRIP_BPS, type ReplayCosts, type ReplaySymbolResult } from "./replay-stats";

export * from "./replay-stats";

function round(v: number, d = 4) {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function syntheticQuality(bars: PriceBar[], assetClass: AssetClass): DataQuality {
  // Historical bars were fresh on the day they were the latest bar. Score with the same
  // formula as assessDataQuality, with freshness at its best value.
  const barScore = Math.min(25, Math.max(0, (bars.length - 160) / 8));
  const score = Math.round(Math.min(100, 50 + barScore + 25));
  return { score, grade: score >= 85 ? "A" : score >= 70 ? "B" : "C", freshnessDays: 0, freshnessSessions: assetClass === "EQUITY" ? 0 : null, expectedAsOf: null, bars: bars.length, sourceReliable: true, notes: [] } as DataQuality;
}

/**
 * Executable simulation of one entry (what the V5.4 executor does):
 * - Alpaca: limit buy at entry×1.003 on the next bar; bracket stop + target held intraday.
 * - Kraken: post-only limit at min(plan, open)×0.998 placed at the next bar's open; fills
 *   only if that bar trades down to it (else expires); stop held intraday; target and time exit
 *   are only checked at each daily open (the bot runs once a day).
 * Gaps through a stop fill at the open (worse than the stop). Same-bar stop/target → stop.
 */
export function simulateExecutable(bars: PriceBar[], signalIndex: number, plan: { entry: number; stop: number; target: number }, assetClass: AssetClass, horizonBars: number, fill: "executor" | "market" = "executor") {
  const entryBar = bars[signalIndex + 1];
  if (!entryBar) return null;
  let entry: number;
  if (fill === "market") {
    entry = entryBar.open; // counterfactual: what a taker (market) entry would have done
  } else if (assetClass === "EQUITY") {
    const limit = plan.entry * 1.003;
    if (entryBar.low > limit) return null; // limit never filled; executor cancels next cycle
    entry = Math.min(entryBar.open, limit);
  } else {
    const limit = Math.min(plan.entry, entryBar.open) * KRAKEN_MAKER_ENTRY_DISCOUNT;
    if (entryBar.low > limit) return null; // maker limit never touched; expires unfilled
    entry = limit;
  }
  const { stop, target } = plan;
  if (!(entry > stop)) return null; // gapped below stop before entry; the order would be unprotected → skip

  for (let k = signalIndex + 1; k < bars.length; k += 1) {
    const bar = bars[k];
    const held = k - signalIndex; // 1 on entry bar
    const isEntryBar = k === signalIndex + 1;
    // Time exit at the open once the horizon has elapsed.
    if (held > horizonBars) return { entryDate: entryBar.date, entry, exitDate: bar.date, exit: bar.open, outcome: "TIME" as const, barsHeld: held - 1 };
    if (!isEntryBar) {
      if (bar.open <= stop) return { entryDate: entryBar.date, entry, exitDate: bar.date, exit: bar.open, outcome: "STOP" as const, barsHeld: held };
      if (bar.open >= target) return { entryDate: entryBar.date, entry, exitDate: bar.date, exit: bar.open, outcome: "TARGET" as const, barsHeld: held };
    }
    const stopHit = bar.low <= stop;
    const targetHit = assetClass === "EQUITY" && bar.high >= target; // Kraken target is not broker-held
    if (stopHit) return { entryDate: entryBar.date, entry, exitDate: bar.date, exit: stop, outcome: "STOP" as const, barsHeld: held };
    if (targetHit) return { entryDate: entryBar.date, entry, exitDate: bar.date, exit: target, outcome: "TARGET" as const, barsHeld: held };
  }
  return null; // not enough future bars yet
}

/** The forward ledger's own settlement rule (validation.ts resolveOutcome), for comparison. */
export function simulateLedger(bars: PriceBar[], signalIndex: number, plan: { entry: number; stop: number; target: number }, horizonBars: number) {
  const future = bars.slice(signalIndex + 1, signalIndex + 1 + horizonBars);
  if (future.length < horizonBars) return null;
  for (let i = 0; i < future.length; i += 1) {
    const bar = future[i];
    if (bar.low <= plan.stop) return { entryDate: bars[signalIndex].date, entry: plan.entry, exitDate: bar.date, exit: plan.stop, outcome: "STOP" as const, barsHeld: i + 1 };
    if (bar.high >= plan.target) return { entryDate: bars[signalIndex].date, entry: plan.entry, exitDate: bar.date, exit: plan.target, outcome: "TARGET" as const, barsHeld: i + 1 };
  }
  const last = future[horizonBars - 1];
  return { entryDate: bars[signalIndex].date, entry: plan.entry, exitDate: last.date, exit: last.close, outcome: "TIME" as const, barsHeld: horizonBars };
}

export function replaySymbol(input: {
  symbol: string;
  assetClass: AssetClass;
  source: MarketSource;
  bars: PriceBar[];
  benchmarkBars: PriceBar[];
  settings: RiskSettings;
  costs?: ReplayCosts;
  windowCalendarDays?: number;
  maxDecisions?: number;
  onDecision?: (entry: { date: string; score: number; action: string; evidence: number; confidence: number }) => void;
}): ReplaySymbolResult {
  const { symbol, assetClass, source, bars, benchmarkBars, settings } = input;
  const costs = input.costs ?? REALISTIC_COSTS;
  const windowMs = (input.windowCalendarDays ?? ENGINE.historyCalendarDays) * 86_400_000;
  const horizon = ENGINE.forwardSignalHorizonBars;
  const costBps = assetClass === "CRYPTO" ? costs.cryptoRoundTripBps : costs.equityRoundTripBps;
  const base: ReplaySymbolResult = { symbol, assetClass, source, bars: bars.length, firstDecision: null, lastDecision: null, decisionsEvaluated: 0, signals: 0, trades: [], ledgerTrades: [], buyHoldPct: 0, maxDecisionScore: -1, buySetupFilteredOut: 0, makerAttempts: 0, missed: [] };
  if (source === "SIMULATED_FALLBACK") return { ...base, skipped: "Simulated data; replay refused." };
  if (bars.length < ENGINE.minimumBars + horizon + 2) return { ...base, skipped: `Only ${bars.length} bars.` };

  const noEarnings = { configured: false, calendar: new Map<string, string>() };
  let openUntilIndex = -1; // one position per symbol at a time, like the executor
  const startIndex = ENGINE.minimumBars - 1;
  const lastIndex = bars.length - 2; // need at least one future bar to enter
  let evaluated = 0;

  for (let i = startIndex; i <= lastIndex; i += 1) {
    if (input.maxDecisions && evaluated >= input.maxDecisions) break;
    const date = bars[i].date;
    const fromMs = new Date(date).getTime() - windowMs;
    let lo = 0;
    while (lo < i && new Date(bars[lo].date).getTime() < fromMs) lo += 1;
    const slice = bars.slice(lo, i + 1);
    if (slice.length < ENGINE.minimumBars) continue;
    if (i <= openUntilIndex) continue;

    const benchSlice = benchmarkBars.filter((b) => b.date <= date && new Date(b.date).getTime() >= fromMs);
    const benchmarkVerified = benchSlice.length >= ENGINE.minimumBars && benchSlice.at(-1)!.date >= bars[Math.max(0, i - 3)].date;
    const regime = benchmarkVerified ? detectRegime(benchSlice) : "UNKNOWN";
    const indicators = snapshot(slice);
    const eventRisk = eventRiskFor(symbol, assetClass, indicators, noEarnings);
    evaluated += 1;
    base.firstDecision ??= date;
    base.lastDecision = date;

    const d = decideSymbol({
      symbol, assetClass, source, bars: slice, indicators, regime, benchmarkVerified,
      quality: syntheticQuality(slice, assetClass), eventRisk, corrStatus: "UNKNOWN",
      heldSymbolCount: 0, held: false, settings, exposure: 0,
    });
    const decisionScore = round(d.decisionScored.score, 3);
    base.maxDecisionScore = Math.max(base.maxDecisionScore, decisionScore);
    input.onDecision?.({ date, score: decisionScore, action: d.action, evidence: d.decisionEvidenceScore, confidence: d.decisionConfidence });
    const pass = passesOvernightGate({
      action: d.action, source, decisionScore: round(d.decisionScored.score, 3), decisionConfidence: d.decisionConfidence,
      decisionEvidenceScore: d.decisionEvidenceScore, eventLevel: eventRisk.level, corrStatus: "UNKNOWN", suggestedNotional: d.plan.suggestedNotional,
    });
    if (!pass && d.action === "BUY_SETUP") base.buySetupFilteredOut += 1;
    if (!pass || d.plan.stop == null || d.plan.target == null) continue;
    base.signals += 1;
    const plan = { entry: d.plan.entry, stop: d.plan.stop, target: d.plan.target };

    const meta = { symbol, assetClass, signalDate: date, stop: plan.stop, target: plan.target, evidence: d.decisionEvidenceScore, score: round(d.decisionScored.score, 3) };
    const ledger = simulateLedger(bars, i, plan, horizon);
    if (ledger) {
      const gross = (ledger.exit / ledger.entry - 1) * 100;
      base.ledgerTrades.push({ ...meta, ...ledger, grossPct: round(gross), netPct: round(gross - ENGINE.roundTripCostBps / 100) });
    }
    const exec = simulateExecutable(bars, i, plan, assetClass, horizon);
    if (assetClass === "CRYPTO" && bars[i + 1]) base.makerAttempts += 1;
    if (!exec && assetClass === "CRYPTO" && bars[i + 1]) {
      // Maker limit never filled. Record what a market (taker) entry would have returned.
      const cf = simulateExecutable(bars, i, plan, assetClass, horizon, "market");
      if (cf) {
        const gross = (cf.exit / cf.entry - 1) * 100;
        base.missed.push({ symbol, signalDate: date, outcome: cf.outcome, grossPct: round(gross), netPctAtTaker: round(gross - TAKER_ROUND_TRIP_BPS / 100) });
      }
    }
    if (exec) {
      const gross = (exec.exit / exec.entry - 1) * 100;
      const edge = tradeEdge({ entry: exec.entry, stop: plan.stop, target: plan.target, assetClass, costBps });
      base.trades.push({
        ...meta, ...exec, entry: round(exec.entry, 8), exit: round(exec.exit, 8), grossPct: round(gross), netPct: round(gross - costBps / 100),
        costToRisk: edge.costToRisk, breakevenWinRate: edge.breakevenWinRate, edgePass: edge.pass,
        runUp5Pct: indicators.return5Pct == null ? null : round(indicators.return5Pct, 2), chased: chased(assetClass, indicators.return5Pct),
      });
      const exitIdx = bars.findIndex((b) => b.date === exec.exitDate);
      openUntilIndex = exitIdx > 0 ? exitIdx - 1 : i + horizon + 1; // re-entry possible from the exit day's close
    }
  }

  base.decisionsEvaluated = evaluated;
  const first = bars[startIndex]?.close;
  const last = bars.at(-1)?.close;
  base.buyHoldPct = first && last ? round((last / first - 1) * 100, 2) : 0;
  return base;
}

