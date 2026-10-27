"use client";

import { useCallback, useEffect, useState } from "react";
import { describeWeights, type Weights } from "@/lib/engine/allocation";

const ACCESS_KEY = "twm-v3-access";
type Standing = { agent: string; label: string; from: string | null; to: string | null; days: number; totalPct: number; maxDrawdownPct: number; volPct: number; trades: number; vsSpyPct: number | null; vsBlendPct: number | null; excessT: number | null; pAheadOfSpy: number | null; verdict: string; lastWeights: Weights | null; errors: number; curve: Array<{ date: string; equity: number }> };
type Row = { agent: string; date: string; status: "OK" | "ERROR"; weights: Weights | null; rationale: string | null; model?: string | null; error?: string | null };
type Data = { configured?: string[]; missing?: string[]; standings?: Standing[]; recent?: Row[]; asOf?: string | null; note?: string | null; error?: string };

function code() { try { return window.sessionStorage.getItem(ACCESS_KEY) ?? ""; } catch { return ""; } }
const pct = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
const cls = (v: number | null) => (v == null ? "" : v > 0 ? "exec-pos" : v < 0 ? "exec-neg" : "");
// Fixed colour per agent so it never changes between loads.
const COLOR: Record<string, string> = { hold_spy: "#3987e5", blend_rule: "#199e70", grok: "#d95926", claude: "#c98500" };

function Curves({ standings }: { standings: Standing[] }) {
  const series = standings.filter((s) => s.curve.length > 1);
  if (!series.length) return null;
  const dates = [...new Set(series.flatMap((s) => s.curve.map((p) => p.date)))].sort();
  const idx = new Map(dates.map((d, i) => [d, i]));
  const all = series.flatMap((s) => s.curve.map((p) => p.equity));
  const lo = Math.min(1, ...all), hi = Math.max(1, ...all);
  const W = 720, H = 200, P = 10;
  const x = (d: string) => P + ((idx.get(d) ?? 0) / Math.max(1, dates.length - 1)) * (W - 2 * P);
  const y = (v: number) => P + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (H - 2 * P);
  return (
    <figure className="replay-curve">
      <figcaption>Paper growth of 1 since each agent started · {dates[0]} → {dates.at(-1)}</figcaption>
      <div className="alloc-legend">{series.map((s) => <span key={s.agent}><i style={{ background: COLOR[s.agent] ?? "#888" }} />{s.label} <b>{(s.curve.at(-1)?.equity ?? 1).toFixed(3)}×</b></span>)}</div>
      <div className="fan-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Arena equity curves">
          <line x1={P} x2={W - P} y1={y(1)} y2={y(1)} className="replay-base" />
          {series.map((s) => <path key={s.agent} d={s.curve.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ")} fill="none" stroke={COLOR[s.agent] ?? "#888"} strokeWidth={2} vectorEffect="non-scaling-stroke" />)}
        </svg>
        <span className="fan-axis" style={{ top: `${(y(hi) / H) * 100}%`, left: 4 }}>{hi.toFixed(2)}×</span>
        <span className="fan-axis" style={{ top: `${(y(1) / H) * 100}%`, left: 4 }}>1.00×</span>
      </div>
    </figure>
  );
}

export default function ArenaPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const res = await fetch("/api/arena", { headers: { "x-tradeswithme-access": code() } }); setData(await res.json() as Data); }
    catch (e) { setData({ error: e instanceof Error ? e.message : "Load failed." }); }
  }, []);
  useEffect(() => { if (code()) void load(); }, [load]);

  async function run() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/arena", { method: "POST", headers: { "x-tradeswithme-access": code() } });
      const j = await res.json() as { error?: string; date?: string; written?: string[] };
      setMsg(j.error ?? `Close ${j.date}: ${j.written?.length ? j.written.join(", ") : "every agent had already decided"}.`);
      await load();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Run failed."); }
    finally { setBusy(false); }
  }

  const st = data?.standings ?? [];
  return (
    <section className="exec-panel">
      <div className="exec-head">
        <div>
          <p className="exec-eyebrow">GROK vs CLAUDE vs SIMPLE RULES · ONE DECISION A DAY · FORWARD-ONLY · PAPER</p>
          <h2>AI agent arena</h2>
        </div>
        <div className="exec-actions">
          {!data && <button onClick={() => void load()}>Load arena</button>}
          <button onClick={() => void run()} disabled={busy}>{busy ? "Asking the agents…" : "Run today now"}</button>
        </div>
      </div>
      <p className="exec-note">
        Each AI gets the same numbers every night (returns, volatility, trend and drawdown for 9 ETFs + cash), returns target weights as JSON, and is scored on the closes that follow — after 0.05% per trade — against holding the S&amp;P 500 and your 50/50 blend.
        AIs can&apos;t be backtested honestly (they have already read the past), so the only valid record is this forward one. Agents have no tools and no broker access: their output is parsed as numbers and nothing else.
      </p>
      {data?.error && <p className="exec-err">{data.error}</p>}
      {data && !data.error && <>
        <p className="exec-note">Agents: <b>{data.configured?.length ? data.configured.join(" · ") : "none configured"}</b>{data.missing?.length ? <span className="exec-neg"> · {data.missing.join(" · ")}</span> : null}{data.asOf ? ` · prices to ${data.asOf}` : ""}</p>
        {msg && <p className="exec-note"><b>{msg}</b></p>}
        {data.note && <p className="exec-note">{data.note}</p>}
        {st.length > 0 && <>
          <Curves standings={st} />
          <div className="exec-table-wrap">
            <table className="exec-table">
              <thead><tr><th>Agent</th><th>Since</th><th>Days</th><th>Return</th><th>Worst drop</th><th>Trades</th><th>vs S&amp;P</th><th>vs 50/50 blend</th><th title="Probability the agent's daily edge over the S&P is above zero (t-test on daily differences)">P(edge &gt; 0)</th><th>Verdict</th><th>Holding now</th></tr></thead>
              <tbody>{st.map((s) => (
                <tr key={s.agent}>
                  <td><i className="arena-dot" style={{ background: COLOR[s.agent] ?? "#888" }} /><b>{s.label}</b>{s.errors ? <span className="exec-neg"> · {s.errors} failed day{s.errors > 1 ? "s" : ""}</span> : null}</td>
                  <td>{s.from ?? "—"}</td><td>{s.days}</td>
                  <td className={cls(s.totalPct)}>{pct(s.totalPct)}</td><td>{s.maxDrawdownPct}%</td><td>{s.trades}</td>
                  <td className={cls(s.vsSpyPct)}>{pct(s.vsSpyPct)}</td><td className={cls(s.vsBlendPct)}>{pct(s.vsBlendPct)}</td>
                  <td>{s.pAheadOfSpy == null ? "—" : `${Math.round(s.pAheadOfSpy * 100)}%`}</td>
                  <td className={s.verdict.startsWith("AHEAD OF S&P — SIGNIFICANT") ? "exec-pos" : s.verdict.startsWith("BEHIND") ? "exec-neg" : ""}>{s.verdict}</td>
                  <td>{s.lastWeights ? describeWeights(s.lastWeights) : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>}
        {(data.recent?.length ?? 0) > 0 && (
          <div className="alloc-detail">
            <h3>Latest AI decisions and their reasons</h3>
            <ul className="exec-reasons arena-log">
              {data.recent!.map((r) => (
                <li key={r.agent + r.date} className={r.status === "ERROR" ? "exec-neg" : ""}>
                  <b>{r.date} · {r.agent}</b> {r.status === "OK" && r.weights ? <>→ <b>{describeWeights(r.weights)}</b> — {r.rationale}</> : <>failed: {r.error}</>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ul className="exec-reasons">
          <li>Verdicts need {120} trading days (about 6 months). Before that, any lead is noise — the public Grok bot tracker shows one bot at +34% while the average of five is +3.9%.</li>
          <li>An AI only graduates if it is <b>significantly</b> ahead of the S&amp;P <b>and</b> ahead of your 50/50 blend. Even then it moves to the ISA rebalancer as a strategy you approve, never as an agent with direct broker access.</li>
          <li>Cost: two short API calls per trading day (a few pence). A failed or unparseable reply keeps yesterday&apos;s weights and is counted above.</li>
        </ul>
      </>}
    </section>
  );
}
