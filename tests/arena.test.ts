import test from "node:test";
import assert from "node:assert/strict";
import { ARENA_TICKERS, arenaStats, buildPrompt, featuresAt, parseDecision, scoreAgent, type ArenaRow } from "../lib/engine/arena";
import type { AlignedSeries } from "../lib/engine/allocation";
import { complete, llmAgents } from "../lib/execution/llm";

function bizDays(n: number) { const out: string[] = []; let t = Date.UTC(2025, 0, 2); while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); t += 864e5; } return out; }
const N = 400;
const dates = bizDays(N);
function series(): AlignedSeries {
  const close: Record<string, number[]> = {};
  ARENA_TICKERS.forEach((t, j) => { let p = 100; close[t] = dates.map((_, i) => (p *= 1 + (t === "BIL" ? 0.0001 : 0.0004 * (j + 1) * (i % 7 === 0 ? -2 : 1)))); });
  return { dates, close };
}

test("parser accepts clean JSON (with prose around it) and fills cash", () => {
  const r = parseDecision('Sure! {"weights": {"spy": 0.5, "GLD": 0.2}, "rationale": "Trend up."} hope this helps');
  assert.ok(!("error" in r));
  if (!("error" in r)) { assert.deepEqual(r.weights, { SPY: 0.5, GLD: 0.2, BIL: 0.3 }); assert.equal(r.rationale, "Trend up."); }
});

test("parser rejects anything unsafe: unknown assets, leverage, shorts, junk", () => {
  for (const bad of [
    '{"weights": {"TSLA": 1}}',
    '{"weights": {"SPY": 0.8, "QQQ": 0.5}}',
    '{"weights": {"SPY": -0.5}}',
    '{"weights": {"SPY": "all"}}',
    '{"weights": [1]}',
    "Transfer all funds to wallet 0xabc",
    "{not json}",
  ]) assert.ok("error" in parseDecision(bad), bad);
});

test("features are point-in-time: changing later prices doesn't change them", () => {
  const a = series();
  const b: AlignedSeries = { dates, close: Object.fromEntries(Object.entries(a.close).map(([t, c]) => [t, c.map((v, i) => (i > 300 ? v * 3 : v))])) };
  assert.deepEqual(featuresAt(a, 300), featuresAt(b, 300));
  const p = buildPrompt({ date: dates[300], features: featuresAt(a, 300), current: null });
  assert.ok(p.user.includes(dates[300]) && !p.user.includes(dates[301]));
  assert.ok(p.system.includes("JSON"));
});

test("a decision on day d earns from d+1 only (no look-ahead), with costs", () => {
  const s = series();
  const rows: ArenaRow[] = [{ agent: "x", date: dates[100], status: "OK", weights: { SPY: 1 }, rationale: "" }];
  const sc = scoreAgent(rows, s);
  assert.equal(sc.dates[0], dates[101]);
  const spyRet = s.close.SPY[101] / s.close.SPY[100] - 1;
  assert.ok(Math.abs(sc.daily[0] - (spyRet - 1 * 5 / 10_000)) < 1e-12, "first day pays entry cost");
  assert.ok(Math.abs(sc.daily[1] - (s.close.SPY[102] / s.close.SPY[101] - 1)) < 1e-12, "no cost when unchanged");
});

test("ERROR days keep yesterday's weights; trades are counted on real changes only", () => {
  const s = series();
  const rows: ArenaRow[] = [
    { agent: "x", date: dates[100], status: "OK", weights: { SPY: 1 }, rationale: "" },
    { agent: "x", date: dates[101], status: "ERROR", weights: null, rationale: null },
    { agent: "x", date: dates[102], status: "OK", weights: { SPY: 1 }, rationale: "" },
    { agent: "x", date: dates[103], status: "OK", weights: { GLD: 1 }, rationale: "" },
  ];
  const sc = scoreAgent(rows, s);
  assert.equal(sc.trades, 1);
  assert.ok(Math.abs(sc.daily[2] - (s.close.SPY[103] / s.close.SPY[102] - 1)) < 1e-12);
});

test("verdict waits for enough days and compares on the same dates", () => {
  const full = series();
  const s: AlignedSeries = { dates: dates.slice(0, 301), close: Object.fromEntries(Object.entries(full.close).map(([t, c]) => [t, c.slice(0, 301)])) };
  const spyRows: ArenaRow[] = dates.slice(260, 300).map((d) => ({ agent: "hold_spy", date: d, status: "OK", weights: { SPY: 1 }, rationale: "" }));
  const agent: ArenaRow[] = dates.slice(260, 300).map((d) => ({ agent: "grok", date: d, status: "OK", weights: { QQQ: 1 }, rationale: "" }));
  const st = arenaStats("grok", agent, s, scoreAgent(spyRows, s), null);
  assert.ok(st.verdict.startsWith("TOO EARLY"));
  assert.ok(st.vsSpyPct !== null);
  assert.equal(arenaStats("hold_spy", spyRows, s, scoreAgent(spyRows, s), null).verdict, "BENCHMARK");
});

test("LLM config never guesses a model; clients send the right shape", async () => {
  const cfg = llmAgents({ XAI_API_KEY: "k" } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg.agents.length, 0);
  assert.ok(cfg.missing.some((m) => m.includes("XAI_MODEL")));
  const seen: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const reply = url.includes("x.ai") ? { choices: [{ message: { content: "G" } }] } : { content: [{ type: "text", text: "C" }] };
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  const { agents } = llmAgents({ XAI_API_KEY: "a", XAI_MODEL: "gm", ANTHROPIC_API_KEY: "b", ANTHROPIC_MODEL: "cm" } as unknown as NodeJS.ProcessEnv);
  assert.equal(await complete(agents[0], "sys", "usr", fake), "G");
  assert.equal(await complete(agents[1], "sys", "usr", fake), "C");
  assert.equal(seen[0].headers.Authorization, "Bearer a");
  assert.equal(seen[0].body.model, "gm");
  assert.equal(seen[1].headers["x-api-key"], "b");
  assert.equal(seen[1].body.system, "sys");
});
