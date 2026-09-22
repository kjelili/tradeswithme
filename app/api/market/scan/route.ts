import { NextRequest, NextResponse } from "next/server";
import { normalizePositions, normalizeSettings, normalizeSymbols, runPersonalScan } from "@/lib/engine/analyze";
import type { ScanRequest } from "@/lib/engine/types";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { persistOwnerState, persistScan } from "@/lib/server/persistence";
import { loadValidationSummary, persistForwardSignals, persistShadowSignals, settlePendingSignals } from "@/lib/server/validation";
import { trainLearningPolicy } from "@/lib/server/learning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as ScanRequest;
    const normalized = {
      symbols: normalizeSymbols(body.symbols),
      positions: normalizePositions(body.positions),
      settings: normalizeSettings(body.settings),
    };

    // Manual diagnostics use the same causal order as automation: settle known
    // outcomes, retrain, then score the current bar with the fresh policy.
    await settlePendingSignals();
    const trained = await trainLearningPolicy();
    const scan = await runPersonalScan(normalized, trained.policy);
    scan.learning = trained.policy;

    let persisted = false;
    try {
      await persistOwnerState(normalized);
      persisted = (await persistScan(scan)).persisted;
      await persistForwardSignals(scan);
      await persistShadowSignals(scan);
      scan.validation = await loadValidationSummary();
    } catch (error) {
      scan.warnings.push(error instanceof Error ? error.message : "Could not update the V4.1 persistence/validation state.");
      scan.validation = await loadValidationSummary().catch(() => undefined);
    }
    return NextResponse.json({ ...scan, persisted });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Scan failed." }, { status: 500 });
  }
}
