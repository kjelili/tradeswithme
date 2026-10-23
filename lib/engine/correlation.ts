import { ENGINE } from "./config";
import type { PriceBar } from "./types";

function dailyReturns(bars: PriceBar[], lookback = ENGINE.correlationLookback) {
  const slice = bars.slice(-(lookback + 1));
  const returns: Array<{ date: string; value: number }> = [];
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1].close;
    if (prev > 0) returns.push({ date: slice[i].date, value: slice[i].close / prev - 1 });
  }
  return returns;
}

export function returnCorrelation(a: PriceBar[], b: PriceBar[], lookback = ENGINE.correlationLookback): number | null {
  const ar = dailyReturns(a, lookback);
  const br = dailyReturns(b, lookback);
  const bMap = new Map(br.map((r) => [r.date, r.value]));
  const pairs = ar.map((r) => [r.value, bMap.get(r.date)] as const).filter((p): p is readonly [number, number] => typeof p[1] === "number");
  if (pairs.length < Math.min(20, Math.floor(lookback / 2))) return null;
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let covariance = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    covariance += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return null;
  return covariance / Math.sqrt(vx * vy);
}

export function correlationStatus(value: number | null) {
  if (value == null) return "UNKNOWN" as const;
  const abs = Math.abs(value);
  if (abs >= ENGINE.correlationHighThreshold) return "HIGH" as const;
  if (abs >= ENGINE.correlationModerateThreshold) return "MODERATE" as const;
  return "LOW" as const;
}
