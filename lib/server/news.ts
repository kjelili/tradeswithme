// Live headlines from the GDELT 2.0 DOC API (free, no key, updated every 15 minutes).
import type { Headline } from "@/lib/engine/event-agent";

/** Turns "Arsenal v Chelsea" / "Next UK Prime Minister" into a GDELT query. */
export function newsQuery(eventName: string, marketName = "") {
  const words = `${eventName} ${marketName}`.replace(/\b(v|vs|match odds|winner|over\/under.*|to win|the|of|and)\b/gi, " ").replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 2).slice(0, 5);
  if (!words.length) return null;
  return words.length > 1 ? `(${words.map((w) => `"${w}"`).join(" OR ")})` : `"${words[0]}"`;
}

export async function headlines(query: string, hours = 24, max = 12, fetchImpl: typeof fetch = fetch): Promise<Headline[]> {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`${query} sourcelang:english`)}&mode=artlist&format=json&sort=datedesc&maxrecords=${max}&timespan=${hours}h`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return [];
    const j = await res.json().catch(() => ({})) as { articles?: Array<{ title?: string; domain?: string; seendate?: string }> };
    const seen = new Set<string>();
    return (j.articles ?? []).filter((a) => a.title && !seen.has(a.title.toLowerCase()) && seen.add(a.title.toLowerCase()))
      .map((a) => ({ title: String(a.title).slice(0, 200), source: a.domain ?? "", seen: a.seendate ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)} ${a.seendate.slice(9, 11)}:${a.seendate.slice(11, 13)}Z` : "" }));
  } catch { return []; } finally { clearTimeout(t); }
}
