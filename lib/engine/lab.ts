// Improvement lab engine (V5.6). For each symbol: make the live decision once per past
// day (expensive), then cheaply simulate 27 entry/exit variants on top of those cached
// decisions, scoring every trade against holding the benchmark over the same dates.

import { ENGINE, KRAKEN_MAKER_ENTRY_DISCOUNT } from "./config";
import { classifyEntry, decideSymbol, historyPassesDataGate, LOOSE_ENTRY, MEDIUM_ENTRY, passesOvernightGate, STRICT_ENTRY, type EntryThresholds } from "./decision";
import { chased, tradeEdge } from "./edge";
import { eventRiskFor } from "./events";
import { snapshot } from "./indicators";
import { BENCH_SWITCH_COST_BPS, LAB_HORIZONS, LAB_TARGETS_R, TEST_DAYS, variantId, type BaselineStats, type LabBaseline, type LabSymbolResult, type LabTrade } from "./lab-stats";
import { REALISTIC_COSTS, simulateExecutable, syntheticQuality } from "./replay";
import { buildTradePlan } from "./risk";
import { detectRegime } from "./strategies";
import type { AssetClass, EventRisk, MarketSource, PriceBar, Regime, RiskSettings } from "./types";

export * from "./lab-stats";

const ENTRIES: EntryThresholds[] = [STRICT_ENTRY, MEDIUM_ENTRY, LOOSE_ENTRY];

type DayRecord = {
  i: number;
  date: string;
  score: number;
  confidence: number;
  evidence: number;
  regime: Regime;
  vol: number | null;
  dataGateOk: boolean;
  benchmarkVerified: boolean;
  eventLevel: EventRisk["level"];
  allRetired: boolean;
  entry: number;
  stop: number | null;
  sizeOk: boolean;
  return5: number | null;
};

function round(v: number, d = 4) {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

export function eligible(rec: DayRecord, t: EntryThresholds, source: MarketSource, assetClass: AssetClass) {
  const { action } = classifyEntry({
    score: rec.score, held: false, regime: rec.regime, volatilityPct: rec.vol, assetClass,
    dataGateOk: rec.dataGateOk, benchmarkVerified: rec.benchmarkVerified, eventLevel: rec.eventLevel,
    evidence: rec.evidence, allStrategiesRetired: rec.allRetired, correlationBlocks: false,
  }, t);
  const gated = action === "BUY_SETUP" && rec.sizeOk ? "BUY_SETUP" : action === "BUY_SETUP" ? "WATCH" : action;
  return passesOvernightGate({ action: gated, source, decisionScore: rec.score, decisionConfidence: rec.confidence, decisionEvidenceScore: rec.evidence, eventLevel: rec.eventLevel, corrStatus: "UNKNOWN", suggestedNotional: rec.sizeOk ? 1 : 0 }, t);
}

function benchIndex(bench: PriceBar[]) {
  const dates = bench.map((b) => b.date);
  return (date: string) => {
    // first bar on or after date
    let lo = 0, hi = dates.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (dates[mid] < date) lo = mid + 1; else hi = mid; }
    return lo < dates.length ? bench[lo] : null;
  };
}

export function labSymbol(input: {
  symbol: string; assetClass: AssetClass; source: MarketSource; bars: PriceBar[]; benchmarkBars: PriceBar[]; settings: RiskSettings;
  filters?: { edgeGate: boolean; chaseFilter: boolean }; maxDecisions?: number;
}): LabSymbolResult {
  const { symbol, assetClass, source, bars, benchmarkBars, settings } = input;
  const filters = input.filters ?? { edgeGate: true, chaseFilter: true };
  const base: LabSymbolResult = { symbol, assetClass, source, firstDate: null, lastDate: null, days: 0, maxScore: -1, parityMismatches: 0, trades: [] };
  if (source === "SIMULATED_FALLBACK") return { ...base, skipped: "Simulated data; lab refused." };
  if (bars.length < ENGINE.minimumBars + 7) return { ...base, skipped: `Only ${bars.length} bars.` };

  // 1) One expensive live decision per day, using only bars available that day.
  const windowMs = ENGINE.historyCalendarDays * 86_400_000;
  const noEarnings = { configured: false, calendar: new Map<string, string>() };
  const records: DayRecord[] = [];
  for (let i = ENGINE.minimumBars - 1; i <= bars.length - 2; i += 1) {
    if (input.maxDecisions && records.length >= input.maxDecisions) break;
    const date = bars[i].date;
    const fromMs = new Date(date).getTime() - windowMs;
    let lo = 0;
    while (lo < i && new Date(bars[lo].date).getTime() < fromMs) lo += 1;
    const slice = bars.slice(lo, i + 1);
    if (slice.length < ENGINE.minimumBars) continue;
    const benchSlice = benchmarkBars.filter((b) => b.date <= date && new Date(b.date).getTime() >= fromMs);
    const benchmarkVerified = benchSlice.length >= ENGINE.minimumBars && benchSlice.at(-1)!.date >= bars[Math.max(0, i - 3)].date;
    const regime = benchmarkVerified ? detectRegime(benchSlice) : "UNKNOWN";
    const indicators = snapshot(slice);
    const eventRisk = eventRiskFor(symbol, assetClass, indicators, noEarnings);
    const quality = syntheticQuality(slice, assetClass);
    const d = decideSymbol({ symbol, assetClass, source, bars: slice, indicators, regime, benchmarkVerified, quality, eventRisk, corrStatus: "UNKNOWN", heldSymbolCount: 0, held: false, settings, exposure: 0 });
    const plan = buildTradePlan("BUY_SETUP", indicators, settings, 0, assetClass);
    const rec: DayRecord = {
      i, date, score: round(d.decisionScored.score, 3), confidence: d.decisionConfidence, evidence: d.decisionEvidenceScore,
      regime, vol: indicators.realizedVol20Pct, dataGateOk: historyPassesDataGate(source, quality, assetClass), benchmarkVerified,
      eventLevel: eventRisk.level, allRetired: Object.values(d.strategyStates).every((s) => s === "RETIRED"),
      entry: plan.entry, stop: plan.stop, sizeOk: plan.suggestedShares > 0, return5: indicators.return5Pct,
    };
    // Parity check: the lab's strict gate must reproduce the live decision exactly.
    const live = passesOvernightGate({ action: d.action, source, decisionScore: rec.score, decisionConfidence: d.decisionConfidence, decisionEvidenceScore: d.decisionEvidenceScore, eventLevel: eventRisk.level, corrStatus: "UNKNOWN", suggestedNotional: d.plan.suggestedNotional });
    if (live !== eligible(rec, STRICT_ENTRY, source, assetClass)) base.parityMismatches += 1;
    base.maxScore = Math.max(base.maxScore, rec.score);
    records.push(rec);
  }
  base.days = records.length;
  base.firstDate = records[0]?.date ?? null;
  base.lastDate = records.at(-1)?.date ?? null;

  // 2) Cheap: simulate every entry × target × horizon variant over the cached decisions.
  const costBps = assetClass === "CRYPTO" ? REALISTIC_COSTS.cryptoRoundTripBps : REALISTIC_COSTS.equityRoundTripBps;
  const benchAt = benchIndex(benchmarkBars);
  const dateIndex = new Map(bars.map((b, k) => [b.date, k]));
  for (const t of ENTRIES) for (const R of LAB_TARGETS_R) for (const H of LAB_HORIZONS) {
    const v = variantId(t.id, R, H);
    let openUntil = -1;
    for (const rec of records) {
      if (rec.i <= openUntil || rec.stop == null || !(rec.stop < rec.entry)) continue;
      if (!eligible(rec, t, source, assetClass)) continue;
      if (filters.chaseFilter && chased(assetClass, rec.return5)) continue;
      const limit = rec.entry * (assetClass === "EQUITY" ? 1.003 : KRAKEN_MAKER_ENTRY_DISCOUNT);
      const target = rec.entry + R * (rec.entry - rec.stop);
      if (filters.edgeGate && !tradeEdge({ entry: limit, stop: rec.stop, target, assetClass }).pass) continue;
      const sim = simulateExecutable(bars, rec.i, { entry: rec.entry, stop: rec.stop, target }, assetClass, H);
      if (!sim) continue;
      const exitIdx = dateIndex.get(sim.exitDate) ?? rec.i + H + 1;
      openUntil = exitIdx - 1;
      const bIn = benchAt(sim.entryDate);
      const bOutBar = benchAt(sim.exitDate);
      const bOut = bOutBar ? (sim.outcome === "TIME" ? bOutBar.open : bOutBar.close) : null;
      const benchGross = bIn && bOut ? (bOut / bIn.open - 1) * 100 : 0;
      const gross = (sim.exit / sim.entry - 1) * 100;
      const trade: LabTrade = { v, s: symbol, a: assetClass, d: sim.entryDate, x: sim.exitDate, o: sim.outcome, b: sim.barsHeld, g: round(gross, 3), n: round(gross - costBps / 100, 3), m: round(benchGross, 3), p: round(sim.entry, 6), e: rec.evidence };
      base.trades.push(trade);
    }
  }
  return base;
}

// ---------------- Baselines: buy-and-hold and a 200-day trend filter ----------------

function curveStats(daily: number[], exposed: number[]): BaselineStats {
  let eq = 1, peak = 1, dd = 0;
  for (const x of daily) { eq *= 1 + x; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  return { totalPct: round((eq - 1) * 100, 2), maxDrawdownPct: round(dd * 100, 2), exposurePct: exposed.length ? round(exposed.reduce((s, x) => s + x, 0) / exposed.length * 100, 1) : 0 };
}

export function labBaseline(benchmark: string, assetClass: AssetClass, bars: PriceBar[], start: string, cutoff: string): LabBaseline {
  const switchCost = BENCH_SWITCH_COST_BPS[assetClass] / 10_000;
  const run = (from: string) => {
    const hold: number[] = [], trend: number[] = [], exposed: number[] = [];
    let inMarket = false;
    for (let k = 200; k < bars.length; k += 1) {
      if (bars[k].date < from) continue;
      const ret = bars[k].close / bars[k - 1].close - 1;
      hold.push(ret);
      // Decide on yesterday's close vs its 200-day average (no look-ahead).
      const sma = bars.slice(k - 200, k).reduce((s, b) => s + b.close, 0) / 200;
      const want = bars[k - 1].close > sma;
      let day = want ? ret : 0;
      if (want !== inMarket) { day -= switchCost; inMarket = want; }
      trend.push(day);
      exposed.push(want ? 1 : 0);
    }
    return { hold: curveStats(hold, hold.map(() => 1)), trend: curveStats(trend, exposed) };
  };
  const full = run(start);
  const test = run(cutoff);
  return { benchmark, start, cutoff, end: bars.at(-1)?.date ?? "", buyHold: { full: full.hold, test: test.hold }, trend200: { full: full.trend, test: test.trend } };
}

export function defaultCutoff(lastDate: string) {
  return new Date(new Date(lastDate).getTime() - TEST_DAYS * 86_400_000).toISOString().slice(0, 10);
}
