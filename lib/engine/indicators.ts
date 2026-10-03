import type { IndicatorSnapshot, PriceBar } from "./types";

export function mean(values: number[]) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function std(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

export function sma(values: number[], length: number): number | null {
  if (values.length < length) return null;
  return mean(values.slice(-length));
}

export function rsi(values: number[], length = 14): number | null {
  if (values.length <= length) return null;
  const slice = values.slice(-(length + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const d = slice[i] - slice[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / length) / (losses / length);
  return 100 - 100 / (1 + rs);
}

export function atr(bars: PriceBar[], length = 14): number | null {
  if (bars.length <= length) return null;
  const recent = bars.slice(-(length + 1));
  const trs: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    const b = recent[i];
    const prev = recent[i - 1];
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)));
  }
  return mean(trs);
}

export function pctChange(now: number, before: number) {
  return before ? ((now - before) / before) * 100 : 0;
}

function trailingReturn(closes: number[], length: number): number | null {
  if (closes.length <= length) return null;
  return pctChange(closes.at(-1)!, closes.at(-(length + 1))!);
}

export function snapshot(bars: PriceBar[]): IndicatorSnapshot {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume).filter((v) => Number.isFinite(v) && v >= 0);
  const close = closes.at(-1) ?? 0;
  const previous = closes.at(-2) ?? close;
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const a14 = atr(bars, 14);
  const recent20 = closes.slice(-20);
  const sd20 = std(recent20);
  const avg20 = mean(recent20);
  const dailyReturns = closes.slice(-21).slice(1).map((v, i) => closes.slice(-21)[i] ? (v / closes.slice(-21)[i] - 1) : 0);
  const vol20 = dailyReturns.length >= 10 ? std(dailyReturns) * Math.sqrt(252) * 100 : null;
  const high20 = bars.length >= 20 ? Math.max(...bars.slice(-20).map((b) => b.high)) : null;
  const low20 = bars.length >= 20 ? Math.min(...bars.slice(-20).map((b) => b.low)) : null;
  const volumeAvg20 = volumes.length >= 20 ? mean(volumes.slice(-20)) : null;
  const currentVolume = bars.at(-1)?.volume ?? 0;

  return {
    close,
    changePct: pctChange(close, previous),
    sma20: s20,
    sma50: s50,
    sma200: s200,
    rsi14: rsi(closes),
    atr14: a14,
    atrPct: a14 && close ? (a14 / close) * 100 : null,
    return5Pct: trailingReturn(closes, 5),
    return20Pct: trailingReturn(closes, 20),
    return60Pct: trailingReturn(closes, 60),
    z20: sd20 > 0 ? (close - avg20) / sd20 : null,
    high20,
    low20,
    volumeRatio20: volumeAvg20 && volumeAvg20 > 0 ? currentVolume / volumeAvg20 : null,
    realizedVol20Pct: vol20,
  };
}
