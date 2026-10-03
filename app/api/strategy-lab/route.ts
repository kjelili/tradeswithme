import { NextRequest, NextResponse } from "next/server";
import { CRYPTO_BENCHMARK, EQUITY_BENCHMARK } from "@/lib/engine/config";
import { runStrategyLab } from "@/lib/engine/backtest";
import { assetClassForSymbol, getHistory } from "@/lib/engine/market-data";
import { assessDataQuality, expectedCompletedEquitySession } from "@/lib/engine/quality";
import { detectRegime } from "@/lib/engine/strategies";
import { isOwnerAuthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  try {
    const body = (await request.json()) as { symbol?: string };
    const symbol = (body.symbol ?? "SPY").trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) return NextResponse.json({ error: "Invalid symbol." }, { status: 400 });
    const assetClass = assetClassForSymbol(symbol);
    const benchmarkSymbol = assetClass === "CRYPTO" ? CRYPTO_BENCHMARK : EQUITY_BENCHMARK;
    const [history, benchmark] = await Promise.all([getHistory(symbol), getHistory(benchmarkSymbol)]);
    const expectedEquitySession = assetClass === "EQUITY" ? expectedCompletedEquitySession() : null;
    const historyQuality = assessDataQuality(history.source, history.bars, assetClass, expectedEquitySession);
    const benchmarkQuality = assessDataQuality(benchmark.source, benchmark.bars, assetClass, expectedEquitySession);
    const freshnessPass = (quality: typeof historyQuality) => assetClass === "EQUITY" ? quality.freshnessSessions === 0 : quality.freshnessDays <= 2;
    const historyVerified = history.source !== "SIMULATED_FALLBACK" && historyQuality.score >= 60 && freshnessPass(historyQuality) && historyQuality.bars >= 260;
    const benchmarkVerified = benchmark.source !== "SIMULATED_FALLBACK" && benchmarkQuality.score >= 60 && freshnessPass(benchmarkQuality) && benchmarkQuality.bars >= 260;
    if (!historyVerified) {
      return NextResponse.json({ error: `${symbol} does not currently have verified, sufficiently fresh market data. Strategy Lab refuses fallback data.` }, { status: 422 });
    }
    if (!benchmarkVerified) {
      return NextResponse.json({ error: `${benchmarkSymbol} failed the benchmark data gate, so Strategy Lab will not infer a market regime from fallback data.` }, { status: 422 });
    }
    const regime = detectRegime(benchmark.bars);
    const lab = runStrategyLab(symbol, history.source, history.bars, regime);
    return NextResponse.json({ ...lab, warning: history.warning ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Strategy lab failed." }, { status: 500 });
  }
}
