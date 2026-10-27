// AI agent arena (V5.9). Pure, deterministic parts: prompt, parsing, scoring.
//
// Language models can't be backtested honestly — they have read the history we would test
// them on. So the arena is FORWARD-ONLY: each agent makes one decision per trading day from
// numbers we compute, the decision is stored before the next price exists, and it is scored
// on later closes against simple rules. Paper only; nothing here can move money.
import { CASH, type AlignedSeries, type Weights } from "./allocation";
import { normCdf } from "./robustness";

export const ARENA_UNIVERSE = ["SPY", "QQQ", "EEM", "EFA", "GLD", "TLT", "IEF", "VNQ", "DBC"] as const;
export const ARENA_TICKERS = [...ARENA_UNIVERSE, CASH];
export const ARENA_COST_BPS = 5; // per unit of turnover, same as the allocation strategies
export const ASSET_NAMES: Record<string, string> = {
  SPY: "US large caps (S&P 500)", QQQ: "US tech-heavy (Nasdaq-100)", EEM: "Emerging-market shares", EFA: "Developed ex-US shares",
  GLD: "Gold", TLT: "US Treasuries 20y+", IEF: "US Treasuries 7–10y", VNQ: "US property (REITs)", DBC: "Broad commodities", [CASH]: "Cash (US T-bills)",
};

export type ArenaRow = { agent: string; date: string; status: "OK" | "ERROR"; weights: Weights | null; rationale: string | null; model?: string | null; error?: string | null };
export type Features = { r1m: number; r3m: number; r6m: number; r12m: number; vol3m: number; vs200d: number; drawdown1y: number };

const pct = (v: number) => Math.round(v * 1000) / 10;

/** Point-in-time features at index k (uses closes up to and including k only). */
export function featuresAt(s: AlignedSeries, k: number): Record<string, Features> {
  const out: Record<string, Features> = {};
  for (const t of ARENA_TICKERS) {
    const c = s.close[t];
    if (!c || k < 252) continue;
    const r = (n: number) => c[k] / c[k - n] - 1;
    const rets: number[] = [];
    for (let i = k - 62; i <= k; i += 1) rets.push(c[i] / c[i - 1] - 1);
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
    let sma = 0; for (let i = k - 199; i <= k; i += 1) sma += c[i]; sma /= 200;
    const peak = Math.max(...c.slice(k - 251, k + 1));
    out[t] = { r1m: pct(r(21)), r3m: pct(r(63)), r6m: pct(r(126)), r12m: pct(r(252)), vol3m: pct(sd * Math.sqrt(252)), vs200d: pct(c[k] / sma - 1), drawdown1y: pct(c[k] / peak - 1) };
  }
  return out;
}

export function buildPrompt(input: { date: string; features: Record<string, Features>; current: Weights | null; agentReturnPct?: number | null; spyReturnPct?: number | null }) {
  const system = [
    "You are a portfolio manager competing in a paper-trading arena for a UK individual investor's Stocks & Shares ISA.",
    "Goal: beat simply holding the S&P 500 over months, after costs (0.05% per unit of turnover), with smaller drawdowns. Long-only, no leverage.",
    "You decide target weights once per trading day at the close; they apply from the next day. Changing weights costs money, so only trade with a reason.",
    "Respond with ONLY a JSON object, no prose before or after:",
    '{"weights": {"SPY": 0.0, ...}, "rationale": "max 2 sentences"}',
    `Allowed keys: ${ARENA_TICKERS.join(", ")}. Weights are fractions between 0 and 1 and must sum to at most 1; any remainder is held in ${CASH} (cash).`,
  ].join("\n");
  const rows = Object.entries(input.features).map(([t, f]) => `${t.padEnd(4)} ${ASSET_NAMES[t] ?? t}: 1m ${f.r1m}% · 3m ${f.r3m}% · 6m ${f.r6m}% · 12m ${f.r12m}% · vol(3m, annual) ${f.vol3m}% · vs 200-day avg ${f.vs200d}% · from 1y high ${f.drawdown1y}%`);
  const user = [
    `Date (last completed close): ${input.date}`,
    "",
    "Market data (total returns of US-listed ETFs, computed from closing prices):",
    ...rows,
    "",
    `Your current weights: ${input.current ? JSON.stringify(input.current) : "none yet (starting in cash)"}`,
    input.agentReturnPct != null ? `Your arena return so far: ${input.agentReturnPct}% (S&P 500 over the same days: ${input.spyReturnPct ?? "n/a"}%)` : "",
    "",
    "Return your target weights as JSON.",
  ].filter((x) => x !== null).join("\n");
  return { system, user };
}

/** Strict parser: the model's text is untrusted; only a valid weights object survives. */
export function parseDecision(text: string): { weights: Weights; rationale: string } | { error: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "No JSON object in the reply." };
  let obj: unknown;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return { error: "Reply JSON did not parse." }; }
  const raw = (obj as { weights?: unknown })?.weights;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Reply has no weights object." };
  const allowed = new Set<string>(ARENA_TICKERS);
  const weights: Weights = {};
  let sum = 0;
  for (const [kRaw, v] of Object.entries(raw as Record<string, unknown>)) {
    const k = kRaw.trim().toUpperCase();
    if (!allowed.has(k)) return { error: `Unknown asset "${kRaw}".` };
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return { error: `Invalid weight for ${k}.` };
    if (v < 0.005) continue;
    weights[k] = Math.round(v * 10_000) / 10_000;
    sum += weights[k];
  }
  if (sum > 1.0001) return { error: `Weights sum to ${Math.round(sum * 1000) / 1000} (> 1).` };
  if (sum < 0.9999) weights[CASH] = Math.round(((weights[CASH] ?? 0) + (1 - sum)) * 10_000) / 10_000;
  const r = (obj as { rationale?: unknown }).rationale;
  return { weights, rationale: typeof r === "string" ? r.replace(/\s+/g, " ").trim().slice(0, 600) : "" };
}

function turnover(a: Weights, b: Weights) {
  let t = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) t += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return t;
}

/**
 * Scores one agent: a decision stored for date d earns returns from the first close AFTER d.
 * ERROR days keep the previous weights. Before the first decision the agent isn't scored.
 */
export function scoreAgent(rows: ArenaRow[], s: AlignedSeries) {
  const ok = rows.filter((r) => r.status === "OK" && r.weights).sort((a, b) => a.date.localeCompare(b.date));
  const dates: string[] = [];
  const daily: number[] = [];
  if (!ok.length) return { dates, daily, trades: 0 };
  let w: Weights | null = null;
  let j = 0, trades = 0;
  for (let k = 1; k < s.dates.length; k += 1) {
    // Apply every decision dated on or before the previous close; charge the net turnover.
    let cost = 0;
    while (j < ok.length && ok[j].date <= s.dates[k - 1]) {
      const next = ok[j].weights!;
      const t = turnover(w ?? {}, next);
      if (t > 0.001) { cost += t; if (w) trades += 1; }
      w = next; j += 1;
    }
    if (!w) continue;
    let r = 0;
    for (const [t, wt] of Object.entries(w)) { const c = s.close[t]; if (c) r += wt * (c[k] / c[k - 1] - 1); }
    r -= cost * ARENA_COST_BPS / 10_000;
    dates.push(s.dates[k]); daily.push(r);
  }
  return { dates, daily, trades };
}

export type ArenaStats = {
  agent: string; from: string | null; to: string | null; days: number; totalPct: number; maxDrawdownPct: number; volPct: number; trades: number;
  vsSpyPct: number | null; vsBlendPct: number | null; excessT: number | null; pAheadOfSpy: number | null; verdict: string; lastWeights: Weights | null; errors: number;
};

function compound(x: number[]) { return x.reduce((e, r) => e * (1 + r), 1); }

/** Compare an agent with a benchmark on the days both were scored. */
function vsBench(a: { dates: string[]; daily: number[] }, b: { dates: string[]; daily: number[] }) {
  const m = new Map(b.dates.map((d, i) => [d, b.daily[i]]));
  const ex: number[] = []; const ra: number[] = []; const rb: number[] = [];
  a.dates.forEach((d, i) => { const v = m.get(d); if (v !== undefined) { ex.push(a.daily[i] - v); ra.push(a.daily[i]); rb.push(v); } });
  if (!ex.length) return null;
  const n = ex.length, mean = ex.reduce((x, y) => x + y, 0) / n;
  const sd = n > 1 ? Math.sqrt(ex.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1)) : 0;
  const t = sd > 0 ? (mean / sd) * Math.sqrt(n) : 0;
  return { n, diffPct: Math.round((compound(ra) - compound(rb)) * 1000) / 10, t: Math.round(t * 100) / 100, pAhead: Math.round(normCdf(t) * 1000) / 1000 };
}

export const MIN_DAYS_FOR_VERDICT = 120;

export function arenaStats(agent: string, rows: ArenaRow[], s: AlignedSeries, spy: ReturnType<typeof scoreAgent> | null, blend: ReturnType<typeof scoreAgent> | null): ArenaStats & { curve: Array<{ date: string; equity: number }> } {
  const sc = scoreAgent(rows, s);
  let eq = 1, peak = 1, dd = 0;
  const curve: Array<{ date: string; equity: number }> = [];
  sc.daily.forEach((r, i) => { eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); curve.push({ date: sc.dates[i], equity: Math.round(eq * 10_000) / 10_000 }); });
  const n = sc.daily.length;
  const mean = n ? sc.daily.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(sc.daily.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const vs = spy && agent !== "hold_spy" ? vsBench(sc, spy) : null;
  const vb = blend && agent !== "blend_rule" ? vsBench(sc, blend) : null;
  let verdict: string;
  if (agent === "hold_spy") verdict = "BENCHMARK";
  else if (!vs || vs.n < MIN_DAYS_FOR_VERDICT) verdict = `TOO EARLY (${vs?.n ?? n}/${MIN_DAYS_FOR_VERDICT} days)`;
  else if (vs.t >= 2) verdict = "AHEAD OF S&P — SIGNIFICANT (still paper)";
  else if (vs.diffPct > 0) verdict = "AHEAD OF S&P — COULD BE LUCK";
  else verdict = "BEHIND S&P";
  const last = [...rows].filter((r) => r.status === "OK").sort((a, b) => b.date.localeCompare(a.date))[0];
  return {
    agent, from: sc.dates[0] ?? null, to: sc.dates.at(-1) ?? null, days: n,
    totalPct: Math.round((eq - 1) * 1000) / 10, maxDrawdownPct: Math.round(dd * 1000) / 10, volPct: Math.round(sd * Math.sqrt(252) * 1000) / 10,
    trades: sc.trades, vsSpyPct: vs?.diffPct ?? null, vsBlendPct: vb?.diffPct ?? null, excessT: vs?.t ?? null, pAheadOfSpy: vs?.pAhead ?? null,
    verdict, lastWeights: last?.weights ?? null, errors: rows.filter((r) => r.status === "ERROR").length, curve,
  };
}
