import { snapshot } from "./indicators";
import type { AssetClass, PriceBar, QuantRegime, QuantRegimeProfile } from "./types";

function clamp(v: number, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }
function n(v: number | null) { return v ?? 0; }

export function detectQuantRegime(bars: PriceBar[], assetClass: AssetClass): QuantRegimeProfile {
  if (bars.length < 200) return { regime: "UNKNOWN", confidence: 0, trendStrength: 0, volatilityPct: null, rationale: "Insufficient history for regime classification." };
  const s = snapshot(bars);
  if (!s.sma20 || !s.sma50 || !s.sma200) return { regime: "UNKNOWN", confidence: 0, trendStrength: 0, volatilityPct: s.realizedVol20Pct, rationale: "Long-horizon moving averages are unavailable." };

  const vol = n(s.realizedVol20Pct);
  const r20 = n(s.return20Pct);
  const r60 = n(s.return60Pct);
  const above50 = s.close > s.sma50;
  const above200 = s.close > s.sma200;
  const alignedUp = above50 && s.sma20 > s.sma50 && s.sma50 > s.sma200;
  const alignedDown = !above50 && s.sma20 < s.sma50 && s.sma50 < s.sma200;
  const highVol = assetClass === "CRYPTO" ? vol >= 72 : vol >= 30;
  const panicThreshold = assetClass === "CRYPTO" ? -15 : -8;
  const trendStrength = clamp(Math.abs((s.sma50 / s.sma200 - 1) * 100) * 14 + Math.abs(r20) * 2.2, 0, 100);

  let regime: QuantRegime;
  if ((r20 <= panicThreshold || (n(s.rsi14) < 32 && highVol)) && !above50) regime = "PANIC";
  else if (r20 > 5 && r60 < 2 && above50 && n(s.rsi14) >= 48) regime = "RECOVERY";
  else if (alignedUp && r20 > 1.5) regime = "TREND_UP";
  else if (alignedDown && r20 < -1.5) regime = "TREND_DOWN";
  else if (highVol) regime = "CHOP_HIGH_VOL";
  else regime = "CHOP_LOW_VOL";

  const structuralAgreement = regime === "TREND_UP" ? Number(alignedUp) : regime === "TREND_DOWN" || regime === "PANIC" ? Number(alignedDown || !above200) : 0.65;
  const confidence = Math.round(clamp(48 + trendStrength * 0.28 + structuralAgreement * 18 + (Math.abs(r20) > 3 ? 8 : 0) - (regime.startsWith("CHOP") ? 5 : 0), 35, 94));
  return {
    regime,
    confidence,
    trendStrength: Math.round(trendStrength),
    volatilityPct: s.realizedVol20Pct == null ? null : Math.round(s.realizedVol20Pct * 10) / 10,
    rationale: `${regime.replaceAll("_", " ")}: 20D ${r20.toFixed(1)}%, 60D ${r60.toFixed(1)}%, vol ${vol.toFixed(1)}%, RSI ${n(s.rsi14).toFixed(0)}.`,
  };
}
