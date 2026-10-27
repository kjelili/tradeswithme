// AI agent arena runner (V5.9): one paper decision per agent per trading day, scored forward.
import { alignSeries, type AlignedSeries } from "@/lib/engine/allocation";
import { ARENA_TICKERS, arenaStats, buildPrompt, featuresAt, parseDecision, scoreAgent, type ArenaRow } from "@/lib/engine/arena";
import { getHistory } from "@/lib/engine/market-data";
import { complete, llmAgents } from "@/lib/execution/llm";
import { currentTarget } from "./rebalance";
import { loadStrategyReport } from "./strategies";
import { supabaseConfig, supabaseError, supabaseFetch, supabaseHeaders } from "./supabase";

const TABLE = "twm_arena_decision";
export const RULE_AGENTS = { hold_spy: "Hold the S&P 500", blend_rule: "50/50 blend (rule)" } as const;

async function db<T>(path: string, init: RequestInit = {}, prefer = "return=representation"): Promise<T> {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase is not configured; the arena needs storage.");
  const res = await supabaseFetch(`${config.url}/rest/v1/${path}`, { ...init, headers: supabaseHeaders(config, { Prefer: prefer }), cache: "no-store" });
  if (!res.ok) throw new Error(await supabaseError(res, "Arena storage failed"));
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function loadRows(): Promise<ArenaRow[]> {
  if (!supabaseConfig()) return [];
  return db<ArenaRow[]>(`${TABLE}?select=agent,date,status,weights,rationale,model,error&order=date.asc&limit=20000`);
}

async function loadPrices(): Promise<AlignedSeries> {
  const raw: Record<string, Array<{ date: string; close: number }>> = {};
  const hs = await Promise.all(ARENA_TICKERS.map(async (t) => [t, await getHistory(t, 800)] as const));
  for (const [t, h] of hs) {
    if (h.source === "SIMULATED_FALLBACK" || h.bars.length < 300) throw new Error(`${t}: no verified price history (${h.source}) — arena refuses to decide on guessed data.`);
    raw[t] = h.bars.map((b) => ({ date: b.date, close: b.close }));
  }
  return alignSeries(raw);
}

/** Nightly (and on demand). Idempotent per agent per date. Never throws for one agent's failure. */
export async function runArena(now = new Date()) {
  const s = await loadPrices();
  const k = s.dates.length - 1;
  const date = s.dates[k];
  const rows = await loadRows();
  const done = new Set(rows.filter((r) => r.date === date).map((r) => r.agent));
  const { agents, missing } = llmAgents();
  const out: ArenaRow[] = [];

  if (!done.has("hold_spy")) out.push({ agent: "hold_spy", date, status: "OK", weights: { SPY: 1 }, rationale: "Benchmark.", model: "rule" });
  if (!done.has("blend_rule")) {
    try {
      const rep = await loadStrategyReport();
      const r = rep.results.find((x) => x.id === "blend_spy_rot");
      if (r) out.push({ agent: "blend_rule", date, status: "OK", weights: currentTarget(r, rep.asOf, now), rationale: "50% S&P 500 + 50% best-2-of-5 rotation (monthly rule).", model: "rule" });
    } catch (e) { out.push({ agent: "blend_rule", date, status: "ERROR", weights: null, rationale: null, model: "rule", error: e instanceof Error ? e.message : "rule failed" }); }
  }

  const feats = featuresAt(s, k);
  const spyScore = scoreAgent(rows.filter((r) => r.agent === "hold_spy"), s);
  await Promise.all(agents.filter((a) => !done.has(a.id)).map(async (a) => {
    const mine = rows.filter((r) => r.agent === a.id);
    const last = [...mine].reverse().find((r) => r.status === "OK");
    const st = mine.length ? arenaStats(a.id, mine, s, spyScore, null) : null;
    const prompt = buildPrompt({ date, features: feats, current: last?.weights ?? null, agentReturnPct: st?.days ? st.totalPct : null, spyReturnPct: st?.days ? st.totalPct - (st.vsSpyPct ?? 0) : null });
    try {
      const text = await complete(a, prompt.system, prompt.user);
      const parsed = parseDecision(text);
      if ("error" in parsed) out.push({ agent: a.id, date, status: "ERROR", weights: null, rationale: text.slice(0, 300), model: a.model, error: parsed.error });
      else out.push({ agent: a.id, date, status: "OK", weights: parsed.weights, rationale: parsed.rationale, model: a.model });
    } catch (e) {
      out.push({ agent: a.id, date, status: "ERROR", weights: null, rationale: null, model: a.model, error: e instanceof Error ? e.message.slice(0, 300) : "call failed" });
    }
  }));

  if (out.length) await db(`${TABLE}?on_conflict=agent,date`, { method: "POST", body: JSON.stringify(out) }, "resolution=ignore-duplicates,return=minimal");
  return { date, written: out.map((r) => `${r.agent}:${r.status}`), missing };
}

export async function loadArena() {
  const { agents, missing } = llmAgents();
  const rows = await loadRows();
  if (!rows.length) return { configured: agents.map((a) => a.label), missing, standings: [], recent: [], asOf: null as string | null, note: "No decisions yet — the arena starts on the next nightly run (or press Run now)." };
  const s = await loadPrices();
  const by = (a: string) => rows.filter((r) => r.agent === a);
  const spy = scoreAgent(by("hold_spy"), s);
  const blend = scoreAgent(by("blend_rule"), s);
  const ids = [...new Set(rows.map((r) => r.agent))];
  const standings = ids.map((id) => {
    const st = arenaStats(id, by(id), s, spy, blend);
    const label = id in RULE_AGENTS ? RULE_AGENTS[id as keyof typeof RULE_AGENTS] : (agents.find((a) => a.id === id)?.label ?? id);
    // Weekly-sampled curve keeps the payload small.
    return { ...st, label, curve: st.curve.filter((_, i, arr) => i % 5 === 0 || i === arr.length - 1) };
  }).sort((a, b) => b.totalPct - a.totalPct);
  const recent = [...rows].filter((r) => !(r.agent in RULE_AGENTS)).sort((a, b) => b.date.localeCompare(a.date) || a.agent.localeCompare(b.agent)).slice(0, 30);
  return { configured: agents.map((a) => a.label), missing, standings, recent, asOf: s.dates.at(-1) ?? null, note: null };
}
