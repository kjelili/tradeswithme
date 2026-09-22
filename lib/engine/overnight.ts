import { ENGINE } from "./config";
import type { AssetClass, MorningCandidate, OvernightPaperOrder, OvernightPlan, SymbolAnalysis } from "./types";

function round(value: number, digits = 2) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function floorTo(value: number, digits: number) {
  const p = 10 ** digits;
  return Math.floor(value * p) / p;
}

async function fetchGbpUsdRate(): Promise<OvernightPlan["fx"]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch("https://api.frankfurter.dev/v2/rate/GBP/USD", {
      signal: controller.signal,
      cache: "no-store",
      headers: { "User-Agent": "TradesWithMe/0.6" },
    }).finally(() => clearTimeout(timeout));
    if (!response.ok) throw new Error(`FX endpoint returned ${response.status}`);
    const data = await response.json() as { date?: string; rate?: number };
    if (!Number.isFinite(data.rate) || Number(data.rate) <= 0) throw new Error("FX endpoint returned an invalid rate");
    return {
      pair: "GBP/USD",
      rate: round(Number(data.rate), 6),
      asOf: data.date ?? new Date().toISOString().slice(0, 10),
      source: "FRANKFURTER_DAILY",
    };
  } catch {
    return { pair: "GBP/USD", rate: 1.35, asOf: new Date().toISOString().slice(0, 10), source: "FALLBACK" };
  }
}

function unitDecimals(assetClass: AssetClass) {
  return assetClass === "CRYPTO" ? 8 : 4;
}

function paperRationale(analysis: SymbolAnalysis) {
  const winner = Object.entries(analysis.strategyHealth).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "ensemble";
  return `${analysis.action.replace("_", " ")} · evidence ${analysis.evidence.score}/100 · score ${analysis.score.toFixed(2)} · ${analysis.confidence}% confidence · strongest validated strategy: ${winner}.`;
}

function tooCorrelated(analysis: SymbolAnalysis, selected: OvernightPaperOrder[]) {
  for (const order of selected) {
    if (order.assetClass !== analysis.assetClass) continue;
    const corr = analysis.pairCorrelations[order.symbol];
    if (corr != null && Math.abs(corr) >= ENGINE.correlationHighThreshold) return { blocked: true, symbol: order.symbol, correlation: corr };
  }
  return { blocked: false, symbol: null, correlation: null };
}

export async function buildOvernightPlan(analyses: SymbolAnalysis[], requestedBudgetGbp: number): Promise<OvernightPlan> {
  const budgetGbp = Math.max(0, Math.min(50, Number.isFinite(requestedBudgetGbp) ? requestedBudgetGbp : 50));
  const fx = await fetchGbpUsdRate();
  const orders: OvernightPaperOrder[] = [];
  let remainingGbp = budgetGbp;

  const eligible = analyses.filter((analysis) =>
    analysis.action === "BUY_SETUP" &&
    analysis.source !== "SIMULATED_FALLBACK" &&
    analysis.score >= ENGINE.overnightMinScore &&
    analysis.confidence >= ENGINE.overnightMinConfidence &&
    analysis.evidence.score >= ENGINE.overnightMinEvidenceScore &&
    analysis.eventRisk.level !== "BLOCK" &&
    analysis.correlationRisk.status !== "HIGH" &&
    analysis.tradePlan.suggestedNotional > 0,
  );

  for (const analysis of eligible) {
    if (orders.length >= ENGINE.overnightMaxPaperOrders || remainingGbp < 2) break;
    if (tooCorrelated(analysis, orders).blocked) continue;
    const slotsLeft = ENGINE.overnightMaxPaperOrders - orders.length;
    const diversifiedSliceGbp = Math.min(
      remainingGbp / slotsLeft,
      budgetGbp * 0.5,
      analysis.tradePlan.suggestedNotional / fx.rate,
    );
    if (diversifiedSliceGbp < 2) continue;

    const usdBudget = diversifiedSliceGbp * fx.rate;
    const entry = analysis.tradePlan.entry;
    const units = floorTo(usdBudget / entry, unitDecimals(analysis.assetClass));
    const notionalUsd = units * entry;
    const notionalGbp = floorTo(notionalUsd / fx.rate, 2);
    if (units <= 0 || notionalGbp < 1) continue;

    orders.push({
      symbol: analysis.symbol,
      assetClass: analysis.assetClass,
      source: analysis.source,
      score: analysis.score,
      evidenceScore: analysis.evidence.score,
      confidence: analysis.confidence,
      entryUsd: entry,
      units,
      notionalUsd: round(notionalUsd),
      notionalGbp,
      stopUsd: analysis.tradePlan.stop,
      targetUsd: analysis.tradePlan.target,
      rationale: paperRationale(analysis),
    });
    remainingGbp = Math.max(0, remainingGbp - notionalGbp);
  }

  const allocatedSymbols = new Set(orders.map((order) => order.symbol));
  const morningCandidates: MorningCandidate[] = analyses
    .filter((analysis) =>
      !allocatedSymbols.has(analysis.symbol) &&
      analysis.source !== "SIMULATED_FALLBACK" &&
      analysis.eventRisk.level !== "BLOCK" &&
      (analysis.action === "BUY_SETUP" || analysis.action === "WATCH") &&
      analysis.score > 0 &&
      analysis.evidence.score >= 45,
    )
    .slice(0, ENGINE.morningCandidateLimit)
    .map((analysis, index) => ({
      rank: index + 1,
      symbol: analysis.symbol,
      assetClass: analysis.assetClass,
      source: analysis.source,
      score: analysis.score,
      evidenceScore: analysis.evidence.score,
      confidence: analysis.confidence,
      action: analysis.action,
      entryUsd: analysis.tradePlan.entry,
      stopUsd: analysis.tradePlan.stop,
      targetUsd: analysis.tradePlan.target,
      correlationWarning: analysis.correlationRisk.status === "HIGH" && analysis.correlationRisk.correlatedWith
        ? `Highly correlated with held ${analysis.correlationRisk.correlatedWith} (${analysis.correlationRisk.maxCorrelation?.toFixed(2)}).`
        : null,
      eventRisk: analysis.eventRisk.level,
      rationale: paperRationale(analysis),
    }));

  const allocatedGbp = round(budgetGbp - remainingGbp);
  const notes = [
    `Hard overnight ceiling: £${budgetGbp.toFixed(2)}. The planner cannot allocate above £50 even if a client sends a larger value.`,
    "Overnight allocations are paper-only; TradesWithMe does not submit unattended broker orders.",
    "V4.1 requires real data, evidence score, confidence, event-risk and correlation gates. Highly correlated candidates are not stacked together.",
    "The planner will leave cash unused rather than force a weak setup. Morning candidates remain research leads for a fresh manual review.",
  ];
  if (fx.source === "FALLBACK") notes.push("GBP/USD daily FX lookup failed, so a planning-only fallback rate was used. Verify the live conversion before any real order.");
  if (!orders.length) notes.push("No setup cleared all V4.1 validation gates, so the full paper budget remained unused.");

  return {
    mode: "PAPER_ONLY",
    currency: "GBP",
    budgetGbp: round(budgetGbp),
    allocatedGbp,
    remainingGbp: round(Math.max(0, budgetGbp - allocatedGbp)),
    maxOrders: ENGINE.overnightMaxPaperOrders,
    fx,
    orders,
    morningCandidates,
    notes,
  };
}
