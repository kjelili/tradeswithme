import type { DataQuality, MarketSource, PriceBar } from "./types";

function daysBetween(a: string, b: string) {
  const ms = Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime());
  return Math.round(ms / 86_400_000);
}

function grade(score: number): DataQuality["grade"] {
  if (score >= 90) return "A";
  if (score >= 78) return "B";
  if (score >= 64) return "C";
  if (score >= 45) return "D";
  return "F";
}

export function assessDataQuality(source: MarketSource, bars: PriceBar[], assetClass: "EQUITY" | "CRYPTO"): DataQuality {
  const last = bars.at(-1)?.date ?? new Date(0).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const freshnessDays = daysBetween(last, today);
  const allowedFreshness = assetClass === "CRYPTO" ? 2 : 5;
  const sourceReliable = source !== "SIMULATED_FALLBACK";
  const barScore = Math.min(25, Math.max(0, (bars.length - 160) / 8));
  const freshnessScore = freshnessDays <= allowedFreshness ? 25 : Math.max(0, 25 - (freshnessDays - allowedFreshness) * 7);
  const sourceScore = sourceReliable ? 50 : 0;
  const score = Math.round(Math.max(0, Math.min(100, sourceScore + barScore + freshnessScore)));
  const notes: string[] = [];
  if (!sourceReliable) notes.push("Fallback data cannot support an actionable trade.");
  if (freshnessDays > allowedFreshness) notes.push(`Latest completed bar is ${freshnessDays} calendar days old.`);
  if (bars.length < 260) notes.push(`Only ${bars.length} bars are available, reducing long-horizon validation depth.`);
  if (!notes.length) notes.push("Source, history depth and freshness pass the V4.1 quality checks.");
  return { score, grade: grade(score), freshnessDays, bars: bars.length, sourceReliable, notes };
}
