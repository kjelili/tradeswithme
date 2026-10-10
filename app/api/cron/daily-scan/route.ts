import { NextRequest, NextResponse } from "next/server";
import { normalizePositions, normalizeSettings, normalizeSymbols, runPersonalScan } from "@/lib/engine/analyze";
import { EXPANDED_CRYPTO_WATCHLIST } from "@/lib/engine/config";
import { isCronAuthorized } from "@/lib/server/auth";
import { loadOwnerState, persistScan } from "@/lib/server/persistence";
import { loadCounterfactualSummary, loadValidationSummary, persistCounterfactualSignals, persistForwardSignals, persistShadowSignals, settleCounterfactualSignals, settlePendingSignals } from "@/lib/server/validation";
import { trainLearningPolicy } from "@/lib/server/learning";
import { refreshAgentAttribution } from "@/lib/engine/signal-intelligence";
import { refreshDiscoveryGovernance } from "@/lib/engine/governance-intelligence";
import { persistAutomationRun } from "@/lib/server/observatory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  let actionableSettled = 0;
  let shadowSettled = 0;
  let actionableInserted = 0;
  let shadowInserted = 0;
  let phase = "SETTLE";
  let settlementIssues: string[] = [];
  let settlementWaiting = 0;

  try {
    // V4.1 learns BEFORE scoring today's market. Newly completed outcomes therefore
    // influence the next scan immediately instead of waiting an extra daily cycle.
    phase = "SETTLE";
    const settlement = await settlePendingSignals();
    await settleCounterfactualSignals().catch(() => ({ configured: true, settled: 0, waiting: 0, issues: [] }));
    actionableSettled = settlement.actionableSettled;
    shadowSettled = settlement.shadowSettled;
    settlementIssues = settlement.issues ?? [];
    settlementWaiting = settlement.waiting ?? 0;
    phase = "TRAIN";
    const trained = await trainLearningPolicy();

    phase = "LOAD_OWNER_STATE";
    const owner = await loadOwnerState().catch(() => ({ configured: false, state: null }));
    const envSymbols = normalizeSymbols(process.env.PERSONAL_WATCHLIST?.split(","));
    const configuredBudget = Math.max(0, Math.min(50, Number(process.env.OVERNIGHT_PAPER_BUDGET_GBP ?? "50")));
    const ownerBudget = owner.state?.settings.overnightPaperBudgetGbp ?? configuredBudget;
    const personalSymbols = owner.state?.symbols?.length ? owner.state.symbols : envSymbols;
    // V5.1 automatically adds the expanded liquid crypto research universe while preserving
    // the owner's personal watchlist. Monitoring does not imply a BUY_SETUP or live order.
    const symbols = normalizeSymbols([...personalSymbols, ...EXPANDED_CRYPTO_WATCHLIST]);
    const positions = normalizePositions(owner.state?.positions ?? []);
    const settings = normalizeSettings({ ...(owner.state?.settings ?? {}), overnightPaperBudgetGbp: Math.min(configuredBudget, ownerBudget, 50) });

    phase = "SCAN";
    const scan = await runPersonalScan({ symbols, positions, settings }, trained.policy);
    scan.learning = trained.policy;
    if (settlementIssues.length) scan.warnings.push(...settlementIssues.map((issue) => `Settlement diagnostic: ${issue}`));

    let persisted = false;
    phase = "PERSIST";
    try {
      actionableInserted = (await persistForwardSignals(scan)).inserted;
      shadowInserted = (await persistShadowSignals(scan)).inserted;
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
      scan.warnings.push(error instanceof Error ? error.message : "Could not update scheduled validation state.");
    }

    phase = "LOG_RUN";
    const degraded = scan.dataHealth.equity.status !== "HEALTHY" || scan.dataHealth.crypto.status !== "HEALTHY" || scan.warnings.length > 0;
    await persistAutomationRun({
      status: degraded ? "DEGRADED" : "OK",
      actionableSettled,
      shadowSettled,
      actionableInserted,
      shadowInserted,
      learningVersion: trained.policy.version,
      learningMode: trained.policy.mode,
      effectiveSamples: trained.policy.effectiveSampleCount,
      regime: scan.regime,
      cryptoRegime: scan.cryptoRegime,
      detail: degraded
        ? scan.warnings.slice(0, 3).join(" | ") || "One or more market-data feeds were degraded."
        : `Daily autonomous settle → train → scan cycle completed. ${settlementWaiting} observations still need additional verified bars.`,
    });

    console.log("TradesWithMe V5.2 autonomous discovery/governance cycle", JSON.stringify({
      at: scan.at,
      ownerState: Boolean(owner.state),
      positions: positions.length,
      regime: scan.regime,
      cryptoRegime: scan.cryptoRegime,
      overnightAllocatedGbp: scan.overnightPlan?.allocatedGbp,
      persisted,
      actionableSettled,
      shadowSettled,
      actionableInserted,
      shadowInserted,
      settlementWaiting,
      settlementIssues: settlementIssues.length,
      trust: scan.validation?.trustScore,
      learningMode: scan.learning?.mode,
      learningSamples: scan.learning?.effectiveSampleCount,
    }));

    return NextResponse.json({
      ok: true,
      persisted,
      actionableSettled,
      shadowSettled,
      actionableInserted,
      shadowInserted,
      settlementWaiting,
      settlementIssues,
      ownerStateLoaded: Boolean(owner.state),
      scan,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled autonomous learning cycle failed.";
    const detail = `[${phase}] ${message}`;
    console.error("TradesWithMe V5.2 autonomous discovery/governance cycle failed", detail);
    await persistAutomationRun({
      status: "FAILED",
      actionableSettled,
      shadowSettled,
      actionableInserted,
      shadowInserted,
      detail,
    }).catch(() => false);
    return NextResponse.json({ error: message, phase }, { status: 500 });
  }
}
