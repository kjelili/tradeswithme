import test from "node:test";
import assert from "node:assert/strict";
import { replaySymbol, simulateExecutable, simulateLedger, statsFor, simulatePortfolio, verdictFor, type ReplayTrade } from "../lib/engine/replay";
import { normalizeSettings } from "../lib/engine/analyze";
import type { PriceBar } from "../lib/engine/types";

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
function walk(n: number, seed: number, drift = 0.0015): PriceBar[] {
  const r = rng(seed); const out: PriceBar[] = []; let p = 100; const d0 = Date.UTC(2023, 0, 1);
  for (let i = 0; i < n; i += 1) {
    const o = p; p = p * (1 + (r() - 0.5) * 0.05 + drift);
    out.push({ date: new Date(d0 + i * 864e5).toISOString().slice(0, 10), open: o, high: Math.max(o, p) * (1 + r() * 0.01), low: Math.min(o, p) * (1 - r() * 0.01), close: p, volume: 1e6 * (0.8 + r() * 0.4) });
  }
  return out;
}
const bar = (date: string, open: number, high: number, low: number, close: number): PriceBar => ({ date, open, high, low, close, volume: 1 });

test("gap below stop fills at the open, not the stop", () => {
  const bars = [bar("d0", 100, 100, 100, 100), bar("d1", 100, 101, 99, 100), bar("d2", 90, 91, 89, 90)];
  const r = simulateExecutable(bars, 0, { entry: 100, stop: 95, target: 110 }, "CRYPTO", 5)!;
  assert.equal(r.outcome, "STOP");
  assert.equal(r.exit, 90);
});
test("Kraken target is only taken at a daily open; Alpaca target intraday", () => {
  const bars = [bar("d0", 100, 100, 100, 100), bar("d1", 100, 112, 99, 105), bar("d2", 111, 113, 110, 112)];
  const k = simulateExecutable(bars, 0, { entry: 100, stop: 95, target: 110 }, "CRYPTO", 5)!;
  assert.equal(k.exitDate, "d2"); assert.equal(k.exit, 111);
  const a = simulateExecutable(bars, 0, { entry: 100, stop: 95, target: 110 }, "EQUITY", 5)!;
  assert.equal(a.exitDate, "d1"); assert.equal(a.exit, 110);
});
test("equity limit not reached → no trade; same-bar stop+target → stop", () => {
  const gapUp = [bar("d0", 100, 100, 100, 100), bar("d1", 105, 108, 104, 107)];
  assert.equal(simulateExecutable(gapUp, 0, { entry: 100, stop: 95, target: 110 }, "EQUITY", 5), null);
  const both = [bar("d0", 100, 100, 100, 100), bar("d1", 100, 111, 94, 100)];
  assert.equal(simulateExecutable(both, 0, { entry: 100, stop: 95, target: 110 }, "EQUITY", 5)!.outcome, "STOP");
});
test("time exit at the open after the horizon", () => {
  const flat = [bar("d0", 100, 100, 100, 100), ...[1, 2, 3, 4, 5, 6].map((i) => bar(`d${i}`, 100 + i / 10, 101, 99, 100))];
  const r = simulateExecutable(flat, 0, { entry: 100, stop: 95, target: 110 }, "CRYPTO", 5)!;
  assert.equal(r.outcome, "TIME"); assert.equal(r.exitDate, "d6"); assert.equal(r.barsHeld, 5);
  const l = simulateLedger(flat, 0, { entry: 100, stop: 95, target: 110 }, 5)!;
  assert.equal(l.outcome, "TIME"); assert.equal(l.exitDate, "d5");
});
test("replay never uses future bars (decisions identical when the future changes)", () => {
  const settings = normalizeSettings({});
  const a = walk(330, 7); const bench = walk(330, 11, 0.002);
  const cut = 300;
  const altered = [...a.slice(0, cut), ...walk(30, 99, -0.03).map((b, i) => ({ ...b, date: a[cut + i].date }))];
  const run = (bars: PriceBar[]) => {
    const log: string[] = [];
    replaySymbol({ symbol: "TEST-USD", assetClass: "CRYPTO", source: "KRAKEN_CRYPTO_DAILY", bars, benchmarkBars: bench, settings,
      onDecision: (e) => { if (e.date < a[cut].date) log.push(`${e.date}:${e.score}:${e.action}:${e.evidence}:${e.confidence}`); } });
    return log;
  };
  const l1 = run(a); const l2 = run(altered);
  assert.ok(l1.length >= 40, `only ${l1.length} decisions compared`);
  assert.deepEqual(l1, l2);
});
test("stats, portfolio and verdict", () => {
  const t = (netPct: number, i: number): ReplayTrade => ({ symbol: `S${i % 5}`, assetClass: "CRYPTO", signalDate: `2025-01-${String(i + 1).padStart(2, "0")}`, entryDate: `2025-01-${String(i + 1).padStart(2, "0")}`, exitDate: `2025-02-${String(i + 1).padStart(2, "0")}`, entry: 1, stop: 0.9, target: 1.2, exit: 1, outcome: netPct > 0 ? "TARGET" : "STOP", barsHeld: 3, grossPct: netPct, netPct, evidence: 60, score: 0.5 });
  const trades = Array.from({ length: 40 }, (_, i) => t(i % 2 ? 4 : -2, i));
  const s = statsFor(trades);
  assert.equal(s.trades, 40); assert.equal(s.winRatePct, 50); assert.equal(s.profitFactor, 2);
  assert.equal(verdictFor(s).verdict, "INCONCLUSIVE");
  assert.equal(verdictFor(statsFor(trades.map((x) => ({ ...x, netPct: x.netPct - 2 })))).verdict, "NO_EDGE");
  const p = simulatePortfolio(trades);
  assert.ok(p.taken <= 40 && p.taken > 0);
});
test("ledger cost constant matches ENGINE", async () => {
  const { ENGINE } = await import("../lib/engine/config");
  const { LEDGER_COSTS } = await import("../lib/engine/replay-stats");
  assert.equal(LEDGER_COSTS.cryptoRoundTripBps, ENGINE.roundTripCostBps);
});
