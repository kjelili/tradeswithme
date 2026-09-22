import type { AssetClass, IndicatorSnapshot, PositionInput, Regime, RiskSettings, SignalAction, TradePlan } from "./types";

function round(v: number, d = 2) {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function floorTo(v: number, decimals: number) {
  const p = 10 ** decimals;
  return Math.floor(v * p) / p;
}

export function portfolioExposure(positions: PositionInput[], prices: Map<string, number>) {
  return positions.reduce((sum, p) => sum + Math.max(0, p.qty) * (prices.get(p.symbol.toUpperCase()) ?? Math.max(0, p.avgPrice)), 0);
}

export function actionFor(score: number, held: boolean, regime: Regime, volatilityPct: number | null, assetClass: AssetClass = "EQUITY"): SignalAction {
  if (held && score <= -0.28) return "EXIT";
  if (held) return score >= 0.15 ? "HOLD" : "WATCH";
  const volatilityCeiling = assetClass === "CRYPTO" ? 120 : 65;
  if ((volatilityPct ?? 0) >= volatilityCeiling) return "AVOID";
  if (regime === "RISK_OFF" && score < 0.64) return "AVOID";
  if (score >= 0.46) return "BUY_SETUP";
  if (score <= -0.2) return "AVOID";
  return "WATCH";
}

export function buildTradePlan(
  action: SignalAction,
  indicators: IndicatorSnapshot,
  settings: RiskSettings,
  currentExposure: number,
  assetClass: AssetClass = "EQUITY",
): TradePlan {
  const entry = indicators.close;
  const atr = indicators.atr14 ?? entry * 0.025;
  const minimumStopPct = assetClass === "CRYPTO" ? 0.02 : 0.012;
  const rawStopDistance = Math.max(atr * settings.atrStopMultiple, entry * minimumStopPct);
  const stop = action === "BUY_SETUP" ? Math.max(0.000001, entry - rawStopDistance) : null;
  const riskPerShare = stop ? entry - stop : null;
  const riskDollars = settings.accountSize * (settings.riskPerTradePct / 100);
  const maxPositionDollars = settings.accountSize * (settings.maxPositionPct / 100);
  const maxExposureDollars = settings.accountSize * (settings.maxPortfolioExposurePct / 100);
  const exposureHeadroom = Math.max(0, maxExposureDollars - currentExposure);
  const maxNotional = Math.min(maxPositionDollars, exposureHeadroom);
  const unitsByRiskRaw = riskPerShare && riskPerShare > 0 ? riskDollars / riskPerShare : 0;
  const unitsByPositionRaw = entry > 0 ? maxNotional / entry : 0;
  const decimals = assetClass === "CRYPTO" ? 6 : 0;
  const unitsByRisk = floorTo(unitsByRiskRaw, decimals);
  const unitsByPosition = floorTo(unitsByPositionRaw, decimals);
  const suggestedShares = action === "BUY_SETUP" ? Math.max(0, Math.min(unitsByRisk, unitsByPosition)) : 0;
  const target = stop && riskPerShare ? entry + riskPerShare * settings.rewardRiskTarget : null;
  const priceDigits = entry < 1 ? 6 : 2;

  return {
    action,
    entry: round(entry, priceDigits),
    stop: stop ? round(stop, priceDigits) : null,
    target: target ? round(target, priceDigits) : null,
    riskPerShare: riskPerShare ? round(riskPerShare, priceDigits) : null,
    suggestedShares,
    suggestedNotional: round(suggestedShares * entry),
    accountRiskDollars: round(suggestedShares * (riskPerShare ?? 0)),
    rewardRisk: target && stop ? round((target - entry) / (entry - stop)) : null,
    invalidation: action === "BUY_SETUP" ? `Setup invalid below ${round(stop ?? entry, priceDigits)} or if the agent score falls below the entry threshold.` : "No new order is suggested for this state.",
  };
}
