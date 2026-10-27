import test from "node:test";
import assert from "node:assert/strict";
import { alignSeries, runAll, runStrategy, STRATEGIES, type AlignedSeries } from "../lib/engine/allocation";
import { planStrategyAlert } from "../lib/engine/strategy-alert";

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
function bizDays(n: number, from = Date.UTC(2016, 0, 4)) {
  const out: string[] = []; let t = from;
  while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10)); t += 864e5; }
  return out;
}
function path(n: number, seed: number, drift: number, vol: number, shock?: { at: number; daily: number; len: number }) {
  const r = rng(seed); const out: number[] = []; let p = 100;
  for (let i = 0; i < n; i += 1) {
    let x = drift + (r() - 0.5) * vol;
    if (shock && i >= shock.at && i < shock.at + shock.len) x = shock.daily;
    p *= 1 + x; out.push(p);
  }
  return out;
}
const N = 1400;
const dates = bizDays(N);
function series(over: Partial<Record<string, number[]>> = {}): AlignedSeries {
  return { dates, close: {
    SPY: over.SPY ?? path(N, 1, 0.0005, 0.02, { at: 900, daily: -0.01, len: 120 }),
    QQQ: over.QQQ ?? path(N, 2, 0.0007, 0.025), EEM: over.EEM ?? path(N, 3, 0.0002, 0.02),
    GLD: over.GLD ?? path(N, 4, 0.0003, 0.012), TLT: over.TLT ?? path(N, 5, 0.0001, 0.01), BIL: over.BIL ?? path(N, 6, 0.00012, 0.0002),
  } };
}
const def = (id: string) => STRATEGIES.find((s) => s.id === id)!;

test("no look-ahead: changing prices after a date cannot change anything before it", () => {
  const a = series();
  const cutoffIdx = 1100;
  const alteredSpy = [...a.close.SPY.slice(0, cutoffIdx), ...path(N - cutoffIdx, 99, -0.01, 0.03).map((x) => x * a.close.SPY[cutoffIdx - 1] / 100)];
  const b = series({ SPY: alteredSpy });
  for (const id of ["trend200_monthly", "trend200_daily", "dual_mom_cash", "rot_top2_12"]) {
    const s = def(id);
    for (let k = 300; k < cutoffIdx; k += 37) assert.deepEqual(s.decide(k, a), s.decide(k, b), `${id} at ${k}`);
  }
  const ra = runStrategy(def("trend200_daily"), a, 254, dates[1300])!;
  const rb = runStrategy(def("trend200_daily"), b, 254, dates[1300])!;
  const ia = ra.curve.findIndex((p) => p.date >= dates[cutoffIdx - 1]);
  assert.deepEqual(ra.curve.slice(0, ia), rb.curve.slice(0, ia));
});

test("200-day rule goes to cash in a long slide, pays switch costs, and cuts the drawdown", () => {
  const s = series();
  const hold = runStrategy(def("hold_spy"), s, 254, dates[1300])!;
  const trend = runStrategy(def("trend200_daily"), s, 254, dates[1300])!;
  assert.ok(trend.full.maxDrawdownPct < hold.full.maxDrawdownPct, `${trend.full.maxDrawdownPct} < ${hold.full.maxDrawdownPct}`);
  assert.ok(trend.full.switchesPerYear > 0);
  assert.ok(trend.full.riskOnPct < 100);
  assert.deepEqual(def("trend200_daily").decide(1015, s), { BIL: 1 }, "deep into the slide it holds cash");
});

test("rotation and dual momentum pick by trailing return and respect the cash filter", () => {
  const up = (seed: number, d: number) => path(N, seed, d, 0.001);
  const s = series({ SPY: up(1, 0.0004), QQQ: up(2, 0.0012), EEM: up(3, 0.0002), GLD: up(4, 0.0008), TLT: up(5, -0.0003), BIL: up(6, 0.0001) });
  assert.deepEqual(def("rot_top2_12").decide(1000, s), { QQQ: 0.5, GLD: 0.5 });
  assert.deepEqual(def("rot_top1_12").decide(1000, s), { QQQ: 1 });
  assert.deepEqual(def("dual_mom_cash").decide(1000, s), { SPY: 1 });
  const bear = series({ SPY: up(1, -0.001), QQQ: up(2, -0.001), EEM: up(3, -0.002), GLD: up(4, -0.0005), TLT: up(5, -0.0004), BIL: up(6, 0.0001) });
  assert.deepEqual(def("rot_top2_12").decide(1000, bear), { BIL: 1 });
  assert.deepEqual(def("dual_mom_bonds").decide(1000, bear), { TLT: 1 });
});

test("buy-and-hold result equals the index itself; alignment intersects dates", () => {
  const s = series();
  const r = runStrategy(def("hold_spy"), s, 254, dates[1300])!;
  const direct = (s.close.SPY[N - 1] / s.close.SPY[254] - 1) * 100;
  assert.ok(Math.abs(r.full.totalPct - direct) < 0.05, `${r.full.totalPct} vs ${direct}`);
  const al = alignSeries({ A: [{ date: "2020-01-01", close: 1 }, { date: "2020-01-02", close: 2 }], B: [{ date: "2020-01-02", close: 3 }] });
  assert.deepEqual(al.dates, ["2020-01-02"]);
  const all = runAll(s);
  assert.ok(all.results.length >= 8);
  assert.ok(all.cutoff > dates[0]);
});

test("monthly alert: starting positions once, then once per new month, plus daily flips", () => {
  const all = runAll(series());
  const report = { asOf: "2026-09-30", results: all.results };
  const first = planStrategyAlert({ month: null, holdings: {}, dailyTrend: null }, { ...report, asOf: "2026-10-15" }, new Date("2026-10-16T02:20:00Z"));
  assert.equal(first.send, true); assert.match(first.subject, /starting positions/);
  const sameMonth = planStrategyAlert(first.next, { ...report, asOf: "2026-10-20" }, new Date("2026-10-21T02:20:00Z"));
  assert.equal(sameMonth.send, false);
  const newMonth = planStrategyAlert(first.next, { ...report, asOf: "2026-10-30" }, new Date("2026-11-02T02:20:00Z"));
  assert.equal(newMonth.send, true); assert.match(newMonth.subject, /Monthly allocation signal — 2026-11/);
  assert.ok(newMonth.lines.some((l) => /ISA:/.test(l)));
  const again = planStrategyAlert(newMonth.next, { ...report, asOf: "2026-10-30" }, new Date("2026-11-03T02:20:00Z"));
  assert.equal(again.send, false, "never twice in a month");
  const flipped = planStrategyAlert({ ...newMonth.next, dailyTrend: { QQQ: 1 } }, { ...report, asOf: "2026-10-30" }, new Date("2026-11-04T02:20:00Z"));
  assert.equal(flipped.send, true); assert.ok(flipped.lines.some((l) => /flipped/.test(l)));
});
