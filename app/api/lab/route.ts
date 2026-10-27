import { NextRequest, NextResponse } from "next/server";
import { normalizeSettings } from "@/lib/engine/analyze";
import { CRYPTO_BENCHMARK, ENGINE, EQUITY_BENCHMARK } from "@/lib/engine/config";
import { readFilterFlags } from "@/lib/engine/edge";
import { defaultCutoff, labBaseline, labSymbol } from "@/lib/engine/lab";
import { assetClassForSymbol, getHistory } from "@/lib/engine/market-data";
import { isOwnerAuthorized } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DAYS = ENGINE.historyCalendarDays + 730;
const cache = new Map<string, { at: number; value: Awaited<ReturnType<typeof getHistory>> }>();
async function history(symbol: string) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value;
  const value = await getHistory(symbol, DAYS);
  cache.set(symbol, { at: Date.now(), value });
  return value;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { symbol?: string; start?: string; cutoff?: string };
  const symbol = (body.symbol ?? "").trim().toUpperCase();
  try {
    if (symbol === "BASELINE") {
      const out = [];
      for (const [bench, ac] of [[EQUITY_BENCHMARK, "EQUITY"], [CRYPTO_BENCHMARK, "CRYPTO"]] as const) {
        const h = await history(bench);
        if (h.source === "SIMULATED_FALLBACK" || h.bars.length < 260) continue;
        const last = h.bars.at(-1)!.date;
        const cutoff = body.cutoff && DATE.test(body.cutoff) ? body.cutoff : defaultCutoff(last);
        const start = body.start && DATE.test(body.start) ? body.start : h.bars[ENGINE.minimumBars - 1].date;
        out.push(labBaseline(bench, ac, h.bars, start, cutoff));
      }
      return NextResponse.json({ baselines: out });
    }
    if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) return NextResponse.json({ error: "Invalid symbol." }, { status: 400 });
    const assetClass = assetClassForSymbol(symbol);
    const [h, bench] = await Promise.all([history(symbol), history(assetClass === "CRYPTO" ? CRYPTO_BENCHMARK : EQUITY_BENCHMARK)]);
    if (bench.source === "SIMULATED_FALLBACK") return NextResponse.json({ error: "Benchmark data unavailable; lab refused." }, { status: 422 });
    return NextResponse.json(labSymbol({ symbol, assetClass, source: h.source, bars: h.bars, benchmarkBars: bench.bars, settings: normalizeSettings({}), filters: readFilterFlags() }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Lab failed." }, { status: 500 });
  }
}
