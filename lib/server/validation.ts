import { ENGINE } from "../engine/config";
import { getHistory } from "../engine/market-data";
import type { AgentForwardStat, ForwardSignal, ScanResult, ValidationOutcome, ValidationSummary } from "../engine/types";
import { supabaseConfig, supabaseError, supabaseHeaders as headers } from "./supabase";

function round(v: number, d = 2) {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

type SignalRow = {
  id: number;
  symbol: string;
  asset_class: "EQUITY" | "CRYPTO";
  opened_at: string;
  entry_date: string;
  entry: number | string;
  stop: number | string | null;
  target: number | string | null;
  score: number | string;
  evidence_score: number | string;
  confidence: number | string;
  horizon_bars: number;
  outcome: ValidationOutcome;
  exit_date: string | null;
  exit_price: number | string | null;
  return_pct: number | string | null;
  bars_held: number | null;
  agent_snapshot: ForwardSignal["agentSnapshot"] | null;
};

type ShadowRow = {
  id: number;
  symbol: string;
  asset_class: "EQUITY" | "CRYPTO";
  opened_at: string;
  entry_date: string;
  entry: number | string;
  score: number | string;
  evidence_score: number | string;
  confidence: number | string;
  horizon_bars: number;
  outcome: "PENDING" | "TIME_EXIT";
  exit_date: string | null;
  exit_price: number | string | null;
  return_pct: number | string | null;
  bars_held: number | null;
  agent_snapshot: ForwardSignal["agentSnapshot"] | null;
};

function toSignal(row: SignalRow): ForwardSignal {
  return {
    id: row.id,
    symbol: row.symbol,
    assetClass: row.asset_class,
    openedAt: row.opened_at,
    entryDate: row.entry_date,
    entry: Number(row.entry),
    stop: row.stop == null ? null : Number(row.stop),
    target: row.target == null ? null : Number(row.target),
    score: Number(row.score),
    evidenceScore: Number(row.evidence_score),
    confidence: Number(row.confidence),
    horizonBars: row.horizon_bars,
    outcome: row.outcome,
    exitDate: row.exit_date,
    exitPrice: row.exit_price == null ? null : Number(row.exit_price),
    returnPct: row.return_pct == null ? null : Number(row.return_pct),
    barsHeld: row.bars_held,
    agentSnapshot: Array.isArray(row.agent_snapshot) ? row.agent_snapshot : [],
  };
}

export async function persistForwardSignals(scan: ScanResult) {
  const config = supabaseConfig();
  if (!config) return { configured: false, inserted: 0 };
  const rows = scan.analyses
    .filter((a) => a.action === "BUY_SETUP" && a.source !== "SIMULATED_FALLBACK" && a.tradePlan.stop && a.tradePlan.target)
    .map((a) => ({
      opened_at: scan.at,
      entry_date: a.asOf,
      symbol: a.symbol,
      asset_class: a.assetClass,
      source: a.source,
      entry: a.tradePlan.entry,
      stop: a.tradePlan.stop,
      target: a.tradePlan.target,
      score: a.score,
      evidence_score: a.evidence.score,
      confidence: a.confidence,
      horizon_bars: ENGINE.forwardSignalHorizonBars,
      outcome: "PENDING",
      agent_snapshot: a.votes,
    }));
  if (!rows.length) return { configured: true, inserted: 0 };
  const response = await fetch(`${config.url}/rest/v1/twm_forward_signals?on_conflict=symbol,entry_date`, {
    method: "POST",
    headers: headers(config, { Prefer: "resolution=ignore-duplicates,return=representation" }),
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Forward-signal persistence failed"));
  const inserted = await response.json().catch(() => [] as unknown[]);
  return { configured: true, inserted: Array.isArray(inserted) ? inserted.length : 0 };
}

export async function persistShadowSignals(scan: ScanResult) {
  const config = supabaseConfig();
  if (!config) return { configured: false, inserted: 0 };
  const rows = scan.analyses
    .filter((a) =>
      a.action === "WATCH" &&
      a.source !== "SIMULATED_FALLBACK" &&
      a.dataQuality.score >= 75 &&
      a.eventRisk.level !== "BLOCK" &&
      a.regime !== "UNKNOWN" &&
      a.evidence.score >= 54 &&
      Math.abs(a.score) >= 0.05,
    )
    .slice(0, 12)
    .map((a) => ({
      opened_at: scan.at,
      entry_date: a.asOf,
      symbol: a.symbol,
      asset_class: a.assetClass,
      source: a.source,
      entry: a.indicators.close,
      score: a.score,
      evidence_score: a.evidence.score,
      confidence: a.confidence,
      horizon_bars: ENGINE.forwardSignalHorizonBars,
      outcome: "PENDING",
      agent_snapshot: a.votes,
    }));
  if (!rows.length) return { configured: true, inserted: 0 };
  const response = await fetch(`${config.url}/rest/v1/twm_shadow_signals?on_conflict=symbol,entry_date`, {
    method: "POST",
    headers: headers(config, { Prefer: "resolution=ignore-duplicates,return=representation" }),
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Shadow-signal persistence failed"));
  const inserted = await response.json().catch(() => [] as unknown[]);
  return { configured: true, inserted: Array.isArray(inserted) ? inserted.length : 0 };
}

async function loadPendingRows(limit = 250): Promise<SignalRow[]> {
  const config = supabaseConfig();
  if (!config) return [];
  const response = await fetch(`${config.url}/rest/v1/twm_forward_signals?select=*&outcome=eq.PENDING&order=opened_at.asc&limit=${limit}`, {
    headers: headers(config), cache: "no-store",
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Forward-signal read failed"));
  return await response.json() as SignalRow[];
}

async function loadPendingShadowRows(limit = 500): Promise<ShadowRow[]> {
  const config = supabaseConfig();
  if (!config) return [];
  const response = await fetch(`${config.url}/rest/v1/twm_shadow_signals?select=*&outcome=eq.PENDING&order=opened_at.asc&limit=${limit}`, {
    headers: headers(config), cache: "no-store",
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Shadow-signal read failed"));
  return await response.json() as ShadowRow[];
}

async function resolveOutcome(row: SignalRow, bars: Awaited<ReturnType<typeof getHistory>>["bars"]) {
  const entry = Number(row.entry);
  const stop = row.stop == null ? null : Number(row.stop);
  const target = row.target == null ? null : Number(row.target);
  const future = bars.filter((bar) => bar.date > row.entry_date).slice(0, row.horizon_bars);
  if (!future.length) return null;

  let outcome: ValidationOutcome = "PENDING";
  let exitPrice: number | null = null;
  let exitDate: string | null = null;
  let barsHeld: number | null = null;

  for (let i = 0; i < future.length; i += 1) {
    const bar = future[i];
    const stopHit = stop != null && bar.low <= stop;
    const targetHit = target != null && bar.high >= target;
    if (stopHit && targetHit) {
      // Daily bars do not reveal intraday ordering. Resolve ambiguous same-bar hits conservatively.
      outcome = "STOP"; exitPrice = stop; exitDate = bar.date; barsHeld = i + 1; break;
    }
    if (stopHit) { outcome = "STOP"; exitPrice = stop; exitDate = bar.date; barsHeld = i + 1; break; }
    if (targetHit) { outcome = "TARGET"; exitPrice = target; exitDate = bar.date; barsHeld = i + 1; break; }
  }

  if (outcome === "PENDING" && future.length >= row.horizon_bars) {
    const finalBar = future[row.horizon_bars - 1];
    outcome = "TIME_EXIT";
    exitPrice = finalBar.close;
    exitDate = finalBar.date;
    barsHeld = row.horizon_bars;
  }
  if (outcome === "PENDING" || exitPrice == null || !entry) return null;
  const returnPct = ((exitPrice / entry - 1) * 100) - ENGINE.roundTripCostBps / 100;
  return { outcome, exitDate, exitPrice: round(exitPrice, 8), returnPct: round(returnPct, 4), barsHeld };
}

async function patchSettlement(config: { url: string; key: string }, row: SignalRow, result: NonNullable<Awaited<ReturnType<typeof resolveOutcome>>>) {
  const response = await fetch(`${config.url}/rest/v1/twm_forward_signals?id=eq.${row.id}`, {
    method: "PATCH",
    headers: headers(config, { Prefer: "return=minimal" }),
    body: JSON.stringify({ outcome: result.outcome, exit_date: result.exitDate, exit_price: result.exitPrice, return_pct: result.returnPct, bars_held: result.barsHeld }),
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Forward-signal settlement failed"));
}

async function resolveShadowOutcome(row: ShadowRow, bars: Awaited<ReturnType<typeof getHistory>>["bars"]) {
  const entry = Number(row.entry);
  const future = bars.filter((bar) => bar.date > row.entry_date).slice(0, row.horizon_bars);
  if (!entry || future.length < row.horizon_bars) return null;
  const finalBar = future[row.horizon_bars - 1];
  const returnPct = ((finalBar.close / entry - 1) * 100) - ENGINE.roundTripCostBps / 100;
  return { outcome: "TIME_EXIT" as const, exitDate: finalBar.date, exitPrice: round(finalBar.close, 8), returnPct: round(returnPct, 4), barsHeld: row.horizon_bars };
}

async function patchShadowSettlement(config: { url: string; key: string }, row: ShadowRow, result: NonNullable<Awaited<ReturnType<typeof resolveShadowOutcome>>>) {
  const response = await fetch(`${config.url}/rest/v1/twm_shadow_signals?id=eq.${row.id}`, {
    method: "PATCH",
    headers: headers(config, { Prefer: "return=minimal" }),
    body: JSON.stringify({ outcome: result.outcome, exit_date: result.exitDate, exit_price: result.exitPrice, return_pct: result.returnPct, bars_held: result.barsHeld }),
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Shadow-signal settlement failed"));
}

export async function settlePendingSignals() {
  const config = supabaseConfig();
  if (!config) return { configured: false, settled: 0, actionableSettled: 0, shadowSettled: 0 };
  const [pending, shadowPending] = await Promise.all([loadPendingRows(), loadPendingShadowRows()]);

  const historyCache = new Map<string, Awaited<ReturnType<typeof getHistory>>>();
  async function historyFor(symbol: string) {
    const cached = historyCache.get(symbol);
    if (cached) return cached;
    const history = await getHistory(symbol);
    historyCache.set(symbol, history);
    return history;
  }

  let actionableSettled = 0;
  const groups = new Map<string, SignalRow[]>();
  for (const row of pending) groups.set(row.symbol, [...(groups.get(row.symbol) ?? []), row]);
  const entries = [...groups.entries()];
  for (let i = 0; i < entries.length; i += 4) {
    const batch = entries.slice(i, i + 4);
    const results = await Promise.all(batch.map(async ([symbol, rows]) => {
      try {
        const history = await historyFor(symbol);
        if (history.source === "SIMULATED_FALLBACK") return 0;
        let count = 0;
        for (const row of rows) {
          const result = await resolveOutcome(row, history.bars);
          if (!result) continue;
          await patchSettlement(config, row, result);
          count += 1;
        }
        return count;
      } catch { return 0; }
    }));
    actionableSettled += results.reduce((sum, count) => sum + count, 0);
  }

  let shadowSettled = 0;
  const shadowGroups = new Map<string, ShadowRow[]>();
  for (const row of shadowPending) shadowGroups.set(row.symbol, [...(shadowGroups.get(row.symbol) ?? []), row]);
  const shadowEntries = [...shadowGroups.entries()];
  for (let i = 0; i < shadowEntries.length; i += 4) {
    const batch = shadowEntries.slice(i, i + 4);
    const results = await Promise.all(batch.map(async ([symbol, rows]) => {
      try {
        const history = await historyFor(symbol);
        if (history.source === "SIMULATED_FALLBACK") return 0;
        let count = 0;
        for (const row of rows) {
          const result = await resolveShadowOutcome(row, history.bars);
          if (!result) continue;
          await patchShadowSettlement(config, row, result);
          count += 1;
        }
        return count;
      } catch { return 0; }
    }));
    shadowSettled += results.reduce((sum, count) => sum + count, 0);
  }

  return { configured: true, settled: actionableSettled + shadowSettled, actionableSettled, shadowSettled };
}

function maxDrawdownFromReturns(returns: number[]) {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of returns) {
    equity *= 1 + r / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak ? (peak - equity) / peak : 0);
  }
  return maxDd * 100;
}

function agentStats(signals: ForwardSignal[]): AgentForwardStat[] {
  const map = new Map<string, { name: string; supported: number; completed: number; wins: number; sum: number }>();
  for (const signal of signals) {
    if (signal.returnPct == null) continue;
    for (const vote of signal.agentSnapshot) {
      if (!["trend", "momentum", "reversion", "breakout"].includes(vote.id) || vote.score <= 0.1) continue;
      const current = map.get(vote.id) ?? { name: vote.name, supported: 0, completed: 0, wins: 0, sum: 0 };
      current.supported += 1;
      current.completed += 1;
      current.sum += signal.returnPct;
      if (signal.returnPct > 0) current.wins += 1;
      map.set(vote.id, current);
    }
  }
  return [...map.entries()].map(([id, s]) => {
    const winRatePct = s.completed ? s.wins / s.completed * 100 : 0;
    const avgReturnPct = s.completed ? s.sum / s.completed : 0;
    const status: AgentForwardStat["status"] = s.completed < 10 ? "LEARNING" : avgReturnPct > 0.15 && winRatePct >= 50 ? "POSITIVE" : avgReturnPct > -0.1 ? "MIXED" : "WEAK";
    return { id, name: s.name, supportedSignals: s.supported, completedSignals: s.completed, winRatePct: round(winRatePct), avgReturnPct: round(avgReturnPct, 3), status };
  }).sort((a, b) => b.avgReturnPct - a.avgReturnPct);
}

export async function loadValidationSummary(): Promise<ValidationSummary> {
  const config = supabaseConfig();
  const baseNotes = [
    `A robust trust label requires at least ${ENGINE.robustTrustSample} completed forward signals; ${ENGINE.minimumTrustSample} is only the start of usable evidence.`,
    "Signals are frozen before outcomes are known. Stops/targets are evaluated on later completed daily bars; ambiguous same-bar stop/target hits are scored as stops.",
    `Reported forward returns subtract ${ENGINE.roundTripCostBps} bps round-trip cost, but still do not model every real broker spread, tax or market-impact effect.`,
    "V4.1 shadow observations can train agent weights but are intentionally excluded from this Forward Trust score; only actionable BUY_SETUP signals count here.",
  ];
  if (!config) return { configured: false, completed: 0, pending: 0, wins: 0, losses: 0, winRatePct: 0, avgReturnPct: 0, expectancyPct: 0, profitFactor: 0, maxDrawdownPct: 0, trustScore: 0, trustBand: "INSUFFICIENT", calibrationGapPct: null, minimumRobustSample: ENGINE.robustTrustSample, recent: [], agents: [], notes: ["Supabase is not configured, so a tamper-resistant forward ledger cannot accumulate across deployments.", ...baseNotes] };

  const response = await fetch(`${config.url}/rest/v1/twm_forward_signals?select=*&order=opened_at.desc&limit=500`, { headers: headers(config), cache: "no-store" });
  if (!response.ok) throw new Error(`Validation history read failed (${response.status}). Run supabase/schema.sql for V4.`);
  const rows = await response.json() as SignalRow[];
  const signals = rows.map(toSignal);
  const completedSignals = signals.filter((s) => s.returnPct != null && s.outcome !== "PENDING").sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  const pending = signals.length - completedSignals.length;
  const returns = completedSignals.map((s) => s.returnPct ?? 0);
  const wins = returns.filter((r) => r > 0).length;
  const losses = returns.filter((r) => r <= 0).length;
  const winRatePct = returns.length ? wins / returns.length * 100 : 0;
  const avgReturnPct = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const grossProfit = returns.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(returns.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  const maxDrawdownPct = maxDrawdownFromReturns(returns);
  const averageConfidence = completedSignals.length ? completedSignals.reduce((sum, s) => sum + s.confidence, 0) / completedSignals.length : 0;
  const calibrationGapPct = completedSignals.length ? Math.abs(averageConfidence - winRatePct) : null;

  const rawEdge = clamp(
    50 + avgReturnPct * 11 + (Math.min(profitFactor, 3) - 1) * 12 + (winRatePct - 50) * 0.18 - maxDrawdownPct * 0.9 - (calibrationGapPct ?? 0) * 0.12,
    0, 100,
  );
  const sampleWeight = Math.min(1, completedSignals.length / ENGINE.robustTrustSample);
  let trustScore = completedSignals.length ? Math.round(15 + sampleWeight * (rawEdge - 15)) : 0;
  if (completedSignals.length < ENGINE.minimumTrustSample) trustScore = Math.min(trustScore, 44);
  else if (completedSignals.length < 60) trustScore = Math.min(trustScore, 64);
  else if (completedSignals.length < ENGINE.robustTrustSample) trustScore = Math.min(trustScore, 79);
  const trustBand: ValidationSummary["trustBand"] = completedSignals.length < ENGINE.minimumTrustSample ? "INSUFFICIENT" : trustScore >= 80 && completedSignals.length >= ENGINE.robustTrustSample ? "ROBUST" : trustScore >= 68 ? "PROMISING" : trustScore >= 52 ? "DEVELOPING" : "EARLY";

  return {
    configured: true,
    completed: completedSignals.length,
    pending,
    wins,
    losses,
    winRatePct: round(winRatePct),
    avgReturnPct: round(avgReturnPct, 3),
    expectancyPct: round(avgReturnPct, 3),
    profitFactor: round(profitFactor),
    maxDrawdownPct: round(maxDrawdownPct),
    trustScore,
    trustBand,
    calibrationGapPct: calibrationGapPct == null ? null : round(calibrationGapPct),
    minimumRobustSample: ENGINE.robustTrustSample,
    recent: signals.slice(0, ENGINE.validationRecentLimit),
    agents: agentStats(completedSignals),
    notes: baseNotes,
  };
}
