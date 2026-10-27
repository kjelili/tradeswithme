import test from "node:test";
import assert from "node:assert/strict";
import { calendarYears, deflatedSharpe, normCdf, normInv, pairedBootstrap, psr, sharpe } from "../lib/engine/robustness";

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

test("normal CDF / inverse are consistent", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-4);
  for (const p of [0.01, 0.2, 0.5, 0.8, 0.99]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-4, `p=${p}`);
});

test("PSR: a strong long series is significant, pure noise is not", () => {
  const r = rng(3);
  const good = Array.from({ length: 2500 }, () => 0.0008 + 0.01 * gauss(r));
  const noise = Array.from({ length: 2500 }, () => 0.01 * gauss(r));
  assert.ok(psr(good, 0) > 0.95);
  assert.ok(psr(noise, 0) < 0.95);
  assert.equal(psr(good.slice(0, 10), 0), 0, "too short → 0");
});

test("Deflated Sharpe falls as more trials are counted", () => {
  const r = rng(5);
  const x = Array.from({ length: 2500 }, () => 0.0004 + 0.01 * gauss(r));
  const trials = (n: number) => Array.from({ length: n }, () => sharpe(Array.from({ length: 2500 }, () => 0.01 * gauss(r))));
  const few = deflatedSharpe(x, trials(3)).dsr;
  const many = deflatedSharpe(x, trials(60)).dsr;
  assert.ok(many <= few, `${many} <= ${few}`);
  assert.ok(deflatedSharpe(x, trials(60)).sr0PerPeriod > 0);
});

test("paired bootstrap: identical series never 'beat'; a clearly better one usually does; seeded", () => {
  const r = rng(9);
  const bench = Array.from({ length: 2520 }, () => 0.0003 + 0.01 * gauss(r));
  const same = pairedBootstrap(bench, bench, { paths: 200 })!;
  assert.equal(same.pBeatPct, 0);
  assert.equal(same.medianCagrDiffPct, 0);
  const better = bench.map((x) => x + 0.0003);
  const b1 = pairedBootstrap(better, bench, { paths: 200 })!;
  assert.ok(b1.pBeatPct > 95);
  assert.deepEqual(b1, pairedBootstrap(better, bench, { paths: 200 }), "deterministic");
  assert.equal(pairedBootstrap(bench.slice(0, 50), bench.slice(0, 50)), null);
});

test("calendar years compound within each year", () => {
  const dates = ["2020-12-30", "2020-12-31", "2021-01-04", "2021-01-05"];
  const ys = calendarYears(dates, [0, 0.1, 0.1, 0.1], 1, 3);
  assert.deepEqual(ys, [{ year: "2020", pct: 10 }, { year: "2021", pct: 21 }]);
});
