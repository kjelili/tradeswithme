import type { AssetClass, LearningObservatory, PendingLearningObservation, ScanResult } from "../engine/types";
import { loadPersistedScans, loadOwnerState } from "./persistence";
import { loadLearningPolicy } from "./learning";
import { loadValidationSummary } from "./validation";
import { supabaseConfig, supabaseError, supabaseHeaders as headers } from "./supabase";

type LedgerRow = {
  id: number;
  symbol: string;
  asset_class: AssetClass;
  entry_date: string;
  horizon_bars: number;
  outcome: string;
};

type AutomationRow = {
  id: number;
  ran_at: string;
  status: "OK" | "DEGRADED" | "FAILED";
  actionable_settled: number;
  shadow_settled: number;
  actionable_inserted: number;
  shadow_inserted: number;
  learning_version: number | null;
  learning_mode: string | null;
  effective_samples: number | string | null;
  regime: string | null;
  crypto_regime: string | null;
  detail: string | null;
};

function utcDay(dateText: string) {
  return new Date(`${dateText.slice(0, 10)}T00:00:00Z`);
}

function addBars(entryDate: string, bars: number, assetClass: AssetClass) {
  const d = utcDay(entryDate);
  let added = 0;
  while (added < bars) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (assetClass === "CRYPTO" || (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)) added += 1;
  }
  return d;
}

function elapsedBars(entryDate: string, assetClass: AssetClass) {
  const start = utcDay(entryDate);
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  let count = 0;
  const cursor = new Date(start);
  while (cursor < end && count < 3650) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (assetClass === "CRYPTO" || (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6)) count += 1;
  }
  return count;
}

function pendingView(kind: "ACTIONABLE" | "SHADOW", row: LedgerRow): PendingLearningObservation {
  const elapsed = Math.min(row.horizon_bars, elapsedBars(row.entry_date, row.asset_class));
  return {
    kind,
    id: row.id,
    symbol: row.symbol,
    assetClass: row.asset_class,
    entryDate: row.entry_date,
    horizonBars: row.horizon_bars,
    estimatedBarsElapsed: elapsed,
    estimatedBarsRemaining: Math.max(0, row.horizon_bars - elapsed),
    estimatedMaturityAt: addBars(row.entry_date, row.horizon_bars, row.asset_class).toISOString(),
  };
}

function nextScheduledRun(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(0, 20, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

export async function persistAutomationRun(input: {
  status: "OK" | "DEGRADED" | "FAILED";
  actionableSettled?: number;
  shadowSettled?: number;
  actionableInserted?: number;
  shadowInserted?: number;
  learningVersion?: number | null;
  learningMode?: string | null;
  effectiveSamples?: number | null;
  regime?: string | null;
  cryptoRegime?: string | null;
  detail?: string | null;
}) {
  const config = supabaseConfig();
  if (!config) return false;
  const response = await fetch(`${config.url}/rest/v1/twm_automation_runs`, {
    method: "POST",
    headers: headers(config, { Prefer: "return=minimal" }),
    body: JSON.stringify({
      ran_at: new Date().toISOString(),
      status: input.status,
      actionable_settled: input.actionableSettled ?? 0,
      shadow_settled: input.shadowSettled ?? 0,
      actionable_inserted: input.actionableInserted ?? 0,
      shadow_inserted: input.shadowInserted ?? 0,
      learning_version: input.learningVersion ?? null,
      learning_mode: input.learningMode ?? null,
      effective_samples: input.effectiveSamples ?? null,
      regime: input.regime ?? null,
      crypto_regime: input.cryptoRegime ?? null,
      detail: input.detail ?? null,
    }),
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Automation-run persistence failed"));
  return true;
}

export async function loadLearningObservatory(): Promise<{ observatory: LearningObservatory; latestScan: ScanResult | null }> {
  const config = supabaseConfig();
  if (!config) {
    return {
      latestScan: null,
      observatory: {
        configured: false,
        cadence: "Daily at 00:20 UTC",
        nextScheduledAt: nextScheduledRun(),
        lastRun: null,
        recentRuns: [],
        actionablePending: 0,
        actionableCompleted: 0,
        shadowPending: 0,
        shadowCompleted: 0,
        effectiveCompletedSamples: 0,
        pending: [],
        ownerStateUpdatedAt: null,
        notes: ["Supabase is not configured, so the autonomous learning observatory cannot persist."],
      },
    };
  }

  const [forwardResponse, shadowResponse, runsResponse, history, owner, learning, validation] = await Promise.all([
    fetch(`${config.url}/rest/v1/twm_forward_signals?select=id,symbol,asset_class,entry_date,horizon_bars,outcome&order=opened_at.desc&limit=1000`, { headers: headers(config), cache: "no-store" }),
    fetch(`${config.url}/rest/v1/twm_shadow_signals?select=id,symbol,asset_class,entry_date,horizon_bars,outcome&order=opened_at.desc&limit=1000`, { headers: headers(config), cache: "no-store" }),
    fetch(`${config.url}/rest/v1/twm_automation_runs?select=*&order=ran_at.desc&limit=12`, { headers: headers(config), cache: "no-store" }),
    loadPersistedScans(1),
    loadOwnerState(),
    loadLearningPolicy(),
    loadValidationSummary(),
  ]);

  if (!forwardResponse.ok) throw new Error(await supabaseError(forwardResponse, "Observatory forward-ledger read failed"));
  if (!shadowResponse.ok) throw new Error(await supabaseError(shadowResponse, "Observatory shadow-ledger read failed"));
  if (!runsResponse.ok) throw new Error(await supabaseError(runsResponse, "Observatory automation-log read failed"));

  const forward = await forwardResponse.json() as LedgerRow[];
  const shadow = await shadowResponse.json() as LedgerRow[];
  const runRows = await runsResponse.json() as AutomationRow[];
  const pending = [
    ...forward.filter((r) => r.outcome === "PENDING").map((r) => pendingView("ACTIONABLE", r)),
    ...shadow.filter((r) => r.outcome === "PENDING").map((r) => pendingView("SHADOW", r)),
  ].sort((a, b) => a.estimatedMaturityAt.localeCompare(b.estimatedMaturityAt)).slice(0, 20);

  const runs = runRows.map((r) => ({
    id: r.id,
    ranAt: r.ran_at,
    status: r.status,
    actionableSettled: r.actionable_settled,
    shadowSettled: r.shadow_settled,
    actionableInserted: r.actionable_inserted,
    shadowInserted: r.shadow_inserted,
    learningVersion: r.learning_version,
    learningMode: r.learning_mode,
    effectiveSamples: r.effective_samples == null ? null : Number(r.effective_samples),
    regime: r.regime,
    cryptoRegime: r.crypto_regime,
    detail: r.detail,
  }));

  return {
    latestScan: history.scans[0] ?? null,
    observatory: {
      configured: true,
      cadence: "Daily at 00:20 UTC",
      nextScheduledAt: nextScheduledRun(),
      lastRun: runs[0] ?? null,
      recentRuns: runs,
      actionablePending: forward.filter((r) => r.outcome === "PENDING").length,
      actionableCompleted: forward.filter((r) => r.outcome !== "PENDING").length,
      shadowPending: shadow.filter((r) => r.outcome === "PENDING").length,
      shadowCompleted: shadow.filter((r) => r.outcome !== "PENDING").length,
      effectiveCompletedSamples: learning.effectiveSampleCount,
      pending,
      ownerStateUpdatedAt: owner.state?.updatedAt ?? null,
      notes: [
        `The server scans, settles outcomes and retrains automatically ${"daily at 00:20 UTC"}.`,
        "Pending maturity dates are estimates for display; settlement uses actual completed market bars and therefore handles weekends/data gaps conservatively.",
        `Forward Trust remains based only on actionable signals (${validation.completed} completed); shadow outcomes train weights but do not inflate trust.`,
      ],
    },
  };
}
