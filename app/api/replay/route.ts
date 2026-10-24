import { NextRequest, NextResponse } from "next/server";
import { normalizeSettings } from "@/lib/engine/analyze";
import { CRYPTO_BENCHMARK, ENGINE, EQUITY_BENCHMARK } from "@/lib/engine/config";
import { assetClassForSymbol, getHistory } from "@/lib/engine/market-data";
import { replaySymbol } from "@/lib/engine/replay";
import { isOwnerAuthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ~2 extra years of equity history beyond the live 760-day window. Kraken caps crypto
// at ~720 daily candles, so crypto replays cover roughly the last 15 months.
const REPLAY_CALENDAR_DAYS = ENGINE.historyCalendarDays + 730;
const benchmarkCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof getHistory>> }>();

async function benchmark(symbol: string) {
  const hit = benchmarkCache.get(symbol);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value;
  const value = await getHistory(symbol, REPLAY_CALENDAR_DAYS);
  benchmarkCache.set(symbol, { at: Date.now(), value });
  return value;
}

export async function POST(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { symbol?: string };
  const symbol = (body.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) return NextResponse.json({ error: "Invalid symbol." }, { status: 400 });
  try {
    const assetClass = assetClassForSymbol(symbol);
    const [history, bench] = await Promise.all([
      getHistory(symbol, REPLAY_CALENDAR_DAYS),
      benchmark(assetClass === "CRYPTO" ? CRYPTO_BENCHMARK : EQUITY_BENCHMARK),
    ]);
    if (bench.source === "SIMULATED_FALLBACK") return NextResponse.json({ error: "Benchmark data unavailable; replay refused." }, { status: 422 });
    const result = replaySymbol({ symbol, assetClass, source: history.source, bars: history.bars, benchmarkBars: bench.bars, settings: normalizeSettings({}) });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Replay failed." }, { status: 500 });
  }
}
