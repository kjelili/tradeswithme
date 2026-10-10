import { NextRequest, NextResponse } from "next/server";
import { normalizePositions, normalizeSettings, normalizeSymbols } from "@/lib/engine/analyze";
import type { ScanRequest } from "@/lib/engine/types";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { persistOwnerState } from "@/lib/server/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as ScanRequest;
    const state = {
      symbols: normalizeSymbols(body.symbols),
      positions: normalizePositions(body.positions),
      settings: normalizeSettings(body.settings),
    };
    const saved = await persistOwnerState(state);
    return NextResponse.json({ ok: true, ...saved });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Owner-state sync failed." }, { status: 500 });
  }
}
