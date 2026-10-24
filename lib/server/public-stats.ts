import type { ValidationSummary } from "@/lib/engine/types";
import { loadValidationSummary } from "@/lib/server/validation";

export type PublicSettledSignal = {
  symbol: string;
  assetClass: string;
  entryDate: string;
  exitDate: string | null;
  outcome: string;
  returnPct: number;
  barsHeld: number | null;
};

export type PublicTrackRecord = {
  available: boolean;
  completed: number;
  pending: number;
  wins: number;
  losses: number;
  winRatePct: number;
  expectancyPct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  trustScore: number;
  trustBand: ValidationSummary["trustBand"];
  minimumRobustSample: number;
  settled: PublicSettledSignal[];
  updatedAt: string;
};

const EMPTY: Omit<PublicTrackRecord, "updatedAt"> = {
  available: false,
  completed: 0,
  pending: 0,
  wins: 0,
  losses: 0,
  winRatePct: 0,
  expectancyPct: 0,
  profitFactor: 0,
  maxDrawdownPct: 0,
  trustScore: 0,
  trustBand: "INSUFFICIENT",
  minimumRobustSample: 0,
  settled: [],
};

function round(value: number, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

/**
 * Public, read-only view of the forward ledger. Only SETTLED signals are exposed:
 * open setups stay behind the paywall and agent internals are never published.
 * It never settles signals (only the owner/cron paths do). Cached per instance,
 * time-boxed, and never throws, so a data outage cannot take the homepage down.
 */
const CACHE_TTL_MS = 15 * 60 * 1000;
const LOAD_TIMEOUT_MS = 20_000;
let cached: { at: number; value: PublicTrackRecord } | null = null;

export async function loadPublicTrackRecord(): Promise<PublicTrackRecord> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = await loadUncached();
  // Only cache real data, so a transient outage is retried on the next visit.
  if (value.available) cached = { at: Date.now(), value };
  return value;
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)),
  ]);
}

async function loadUncached(): Promise<PublicTrackRecord> {
  const updatedAt = new Date().toISOString();
  try {
    const summary = await withTimeout(loadValidationSummary(), LOAD_TIMEOUT_MS);
    if (!summary.configured) return { ...EMPTY, updatedAt };
    const settled = summary.recent
      .filter((s) => s.outcome !== "PENDING" && s.returnPct != null)
      .slice(0, 50)
      .map((s) => ({
        symbol: s.symbol,
        assetClass: s.assetClass,
        entryDate: s.entryDate,
        exitDate: s.exitDate,
        outcome: s.outcome,
        returnPct: round(s.returnPct ?? 0),
        barsHeld: s.barsHeld,
      }));
    return {
      available: true,
      completed: summary.completed,
      pending: summary.pending,
      wins: summary.wins,
      losses: summary.losses,
      winRatePct: round(summary.winRatePct, 1),
      expectancyPct: round(summary.expectancyPct),
      profitFactor: round(summary.profitFactor),
      maxDrawdownPct: round(summary.maxDrawdownPct),
      trustScore: summary.trustScore,
      trustBand: summary.trustBand,
      minimumRobustSample: summary.minimumRobustSample,
      settled,
      updatedAt,
    };
  } catch (error) {
    console.warn("Public track record unavailable", error instanceof Error ? error.message : error);
    return { ...EMPTY, updatedAt };
  }
}
