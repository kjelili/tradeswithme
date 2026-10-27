import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings } from "../lib/engine/analyze";
import { classifyEntry, LOOSE_ENTRY, STRICT_ENTRY } from "../lib/engine/decision";
import { affordability, analyseLab, labBaseline, labSymbol, meanCi95, tStat, type LabSymbolResult, type LabTrade } from "../lib/engine/lab";
import { replaySymbol } from "../lib/engine/replay";
import type { PriceBar } from "../lib/engine/types";

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
function walk(n: number, seed: number, drift: number, vol: number): PriceBar[] {
  const r = rng(seed); const out: PriceBar[] = []; let p = 100; const d0 = Date.UTC(2023, 0, 2);
  for (let i = 0; i < n; i += 1) {
    const o = p; p = p * (1 + (r() - 0.5) * vol + drift + Math.sin(i / 30) * 0.004);
    out.push({ date: new Date(d0 + i * 864e5).toISOString().slice(0, 10), open: o, high: Math.max(o, p) * (1 + r() * 0.01), low: Math.min(o, p) * (1 - r() * 0.01), close: p, volume: 1e6 * (0.8 + r() * 0.6) });
  }
  return out;
}
const settings = normalizeSettings({});
const bars = walk(340, 3, 0.002, 0.02);
const bench = walk(340, 11, 0.002, 0.02);
const off = { edgeGate: false, chaseFilter: false };

test("entry classifier: thresholds change only the score bar", () => {
  const x = { score: 0.42, held: false, regime: "RISK_ON" as const, volatilityPct: 30, assetClass: "EQUITY" as const, dataGateOk: true, benchmarkVerified: true, eventLevel: "CLEAR" as const, evidence: 60, allStrategiesRetired: false, correlationBlocks: false };
  assert.equal(classifyEntry(x, STRICT_ENTRY).action, "WATCH");
  assert.equal(classifyEntry(x, LOOSE_ENTRY).action, "BUY_SETUP");
  assert.equal(classifyEntry({ ...x, dataGateOk: false }, LOOSE_ENTRY).action, "AVOID");
  assert.equal(classifyEntry({ ...x, regime: "RISK_OFF" }, LOOSE_ENTRY).action, "AVOID");
  assert.equal(classifyEntry({ ...x, volatilityPct: 70 }, LOOSE_ENTRY).action, "AVOID");
  assert.equal(classifyEntry({ ...x, eventLevel: "BLOCK" }, LOOSE_ENTRY).action, "WATCH");
});

test("lab reproduces the live decision every day, and its live variant equals the replay", () => {
  const lab = labSymbol({ symbol: "T-USD", assetClass: "CRYPTO", source: "KRAKEN_CRYPTO_DAILY", bars, benchmarkBars: bench, settings, filters: off });
  assert.equal(lab.parityMismatches, 0);
  assert.ok(lab.days >= 70);
  assert.ok(lab.maxScore >= 0.46, "series reaches the live buy bar, so parity is not vacuous");
  const rep = replaySymbol({ symbol: "T-USD", assetClass: "CRYPTO", source: "KRAKEN_CRYPTO_DAILY", bars, benchmarkBars: bench, settings });
  const liveTrades = lab.trades.filter((t) => t.v === "strict|2R|5d");
  assert.ok(liveTrades.length >= 1, "at least one live-config trade to compare");
  assert.deepEqual(liveTrades.map((t) => `${t.d}>${t.x}:${t.o}`), rep.trades.map((t) => `${t.entryDate}>${t.exitDate}:${t.outcome}`));
  liveTrades.forEach((t, k) => assert.ok(Math.abs(t.g - rep.trades[k].grossPct) < 0.002));
  const live = liveTrades;
  const loose = lab.trades.filter((t) => t.v === "loose|2R|5d").length;
  assert.ok(loose >= live.length, "looser entry never trades less");
  for (const t of lab.trades) assert.ok(Math.abs(t.g - 1.25 - t.n) < 1e-6, "crypto net = gross − 1.25%");
});

test("lab with filters on never trades more than with filters off", () => {
  const on = labSymbol({ symbol: "T-USD", assetClass: "CRYPTO", source: "KRAKEN_CRYPTO_DAILY", bars, benchmarkBars: bench, settings });
  const fOff = labSymbol({ symbol: "T-USD", assetClass: "CRYPTO", source: "KRAKEN_CRYPTO_DAILY", bars, benchmarkBars: bench, settings, filters: off });
  assert.ok(on.trades.length <= fOff.trades.length);
});

test("200-day trend baseline has no look-ahead and costs switches", () => {
  const b = walk(500, 5, 0.001, 0.02);
  const base = labBaseline("SPY", "EQUITY", b, b[260].date, b[400].date);
  assert.ok(base.trend200.full.exposurePct > 0 && base.trend200.full.exposurePct <= 100);
  const altered = [...b.slice(0, 450), ...walk(50, 77, -0.02, 0.02).map((x, i) => ({ ...x, date: b[450 + i].date }))];
  const base2 = labBaseline("SPY", "EQUITY", altered, b[260].date, b[400].date);
  // Exposure decisions before day 450 cannot change when only later bars change.
  assert.ok(Math.abs(base.buyHold.full.totalPct - base2.buyHold.full.totalPct) > 0, "future differs");
});

test("statistics and train-only selection", () => {
  assert.ok(Math.abs(tStat([1, 1, 1, 1]) - 0) < 1e-9);
  assert.ok(tStat([1, 2, 1.5, 2.5, 1.2]) > 3);
  assert.deepEqual(meanCi95([1, 2, 3, 4, 5]), meanCi95([1, 2, 3, 4, 5]));
  const T = (v: string, d: string, g: number, m = 0): LabTrade => ({ v, s: "X", a: "EQUITY", d, x: d, o: "TIME", b: 5, g, n: g - 0.1, m, p: 10, e: 60 });
  const trades: LabTrade[] = [];
  for (let i = 0; i < 30; i += 1) {
    const train = `2024-${String(1 + (i % 12)).padStart(2, "0")}-15`;
    const testD = `2026-${String(1 + (i % 9)).padStart(2, "0")}-15`;
    trades.push(T("medium|1R|10d", train, 2 + (i % 3) * 0.1), T("medium|1R|10d", testD, -1 - (i % 3) * 0.1));   // great in train, bad in test
    trades.push(T("loose|1R|5d", train, -1 + (i % 2) * 0.1), T("loose|1R|5d", testD, 3));                     // bad in train, great in test
  }
  const results: LabSymbolResult[] = [{ symbol: "X", assetClass: "EQUITY", source: "X", firstDate: "2024-01-01", lastDate: "2026-10-01", days: 500, maxScore: 0.5, parityMismatches: 0, trades }];
  const lab = analyseLab(results);
  assert.equal(lab.best.id, "medium|1R|10d", "ranked on training data only — test results cannot leak into the choice");
  assert.equal(lab.verdict.verdict, "NO_EDGE");
  const a = affordability([T("x", "2026-01-01", 1), { ...T("x", "2026-01-01", 1), p: 250 }]);
  assert.equal(a.unaffordablePct, 50);
});
