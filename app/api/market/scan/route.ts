import { NextRequest, NextResponse } from "next/server";
import { normalizePositions, normalizeSettings, normalizeSymbols, runPersonalScan } from "@/lib/engine/analyze";
import type { ScanRequest } from "@/lib/engine/types";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { persistOwnerState, persistScan } from "@/lib/server/persistence";
import { loadCounterfactualSummary, loadValidationSummary, persistCounterfactualSignals, persistForwardSignals, persistShadowSignals, settleCounterfactualSignals, settlePendingSignals } from "@/lib/server/validation";
import { trainLearningPolicy } from "@/lib/server/learning";
import { refreshAgentAttribution } from "@/lib/engine/signal-intelligence";
import { refreshDiscoveryGovernance } from "@/lib/engine/governance-intelligence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
    await settleCounterfactualSignals().catch(() => ({ configured: true, settled: 0, waiting: 0, issues: [] }));
    const trained = await trainLearningPolicy();
    const scan = await runPersonalScan(normalized, trained.policy);
    scan.learning = trained.policy;

    let persisted = false;
    try {
      await persistOwnerState(normalized);
      await persistForwardSignals(scan);
      await persistShadowSignals(scan);
      try {
        await persistCounterfactualSignals(scan);
        if (scan.quant) {
          const historicalCounterfactual = await loadCounterfactualSummary();
          historicalCounterfactual.currentBlockers = scan.quant.counterfactual.currentBlockers;
          scan.quant.counterfactual = historicalCounterfactual;
        }
      } catch (counterError) {
        scan.warnings.push(counterError instanceof Error ? counterError.message : "Counterfactual ledger is unavailable; run the V5 Supabase migration.");
      }
      scan.validation = await loadValidationSummary();
      if (scan.quant) scan.quant.readiness.forwardTrust = scan.validation.trustScore;
      refreshAgentAttribution(scan.signalIntelligence, scan.learning, scan.validation);
      scan.governance = refreshDiscoveryGovernance(scan.governance, scan.analyses, scan.quant, scan.validation);
      persisted = (await persistScan(scan)).persisted;
    } catch (error) {
      scan.warnings.push(error instanceof Error ? error.message : "Could not update the V5.2 persistence/validation state.");
      scan.validation = await loadValidationSummary().catch(() => undefined);
    }
    return NextResponse.json({ ...scan, persisted });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Scan failed." }, { status: 500 });
  }
}
