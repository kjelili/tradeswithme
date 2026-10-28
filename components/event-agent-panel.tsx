"use client";

import { useCallback, useEffect, useState } from "react";

const ACCESS_KEY = "twm-v3-access";
type Bet = { id: string; created_at: string; mode: string; kind: string; market_name: string; event_name: string; start_time: string | null; runner: string; side: string; price: number; stake: number; risk: number; p_model: number | null; p_market: number | null; edge_pct: number | null; reason: string | null; status: string; pnl: number | null; error: string | null; size_matched: number | null };
type View = { created_at: string; market_name: string; event_name: string; model: string; confidence?: string; reason?: string; error?: string; probabilities?: Record<string, number>; market_probabilities?: Record<string, number>; runners?: Array<{ id: number; name: string }>; headlines?: Array<{ title: string; source: string; seen: string }>; smart_money?: string[]; idea?: { runner: string; side: string; price: number; stake: number; edgePct: number } | null };
type Data = { settings?: { mode: string; eventTypes: string[]; maxModelMarkets: number; paperBankroll: number; liveCap: number; kelly: { fraction: number; maxBetPct: number; minEdgePct: number; commission: number }; arbLive: boolean; killSwitch: boolean }; configured?: boolean; llm?: string | null; gate?: { ok: boolean; reason: string }; open?: Bet[]; recent?: Bet[]; views?: View[]; stats?: { paper: { bets: number; pnl: number; roiPct: number }; live: { bets: number; pnl: number; roiPct: number } } | null; error?: string };

function code() { try { return window.sessionStorage.getItem(ACCESS_KEY) ?? ""; } catch { return ""; } }
const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 1000) / 10}%`);

export default function EventAgentPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const r = await fetch("/api/event-agent", { headers: { "x-tradeswithme-access": code() } }); setData(await r.json() as Data); }
    catch (e) { setData({ error: e instanceof Error ? e.message : "Load failed." }); }
  }, []);
  useEffect(() => { if (code()) void load(); }, [load]);

  async function run() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/event-agent", { method: "POST", headers: { "x-tradeswithme-access": code() } });
      const j = await r.json() as { error?: string; skipped?: string; log?: string[]; valueBets?: number; arbs?: number; mode?: string };
      setMsg(j.error ?? j.skipped ?? `${j.mode}: ${j.valueBets ?? 0} value bet(s), ${j.arbs ?? 0} arbitrage(s). ${(j.log ?? []).join(" ")}`);
      await load();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Run failed."); } finally { setBusy(false); }
  }

  const s = data?.settings;
  const bets = [...(data?.open ?? []), ...(data?.recent ?? [])];
  return (
    <section className="exec-panel">
      <div className="exec-head">
        <div>
          <p className="exec-eyebrow">BETFAIR EXCHANGE · LIVE NEWS → MARKETS → MISPRICING · CROSS-OUTCOME ARBITRAGE · ¼-KELLY</p>
          <h2>Event agent</h2>
        </div>
        <div className="exec-actions">
          {!data && <button onClick={() => void load()}>Load</button>}
          <button onClick={() => void run()} disabled={busy}>{busy ? "Reading news & markets…" : "Run a cycle now"}</button>
        </div>
      </div>
      <p className="exec-note">
        Every 15 minutes: settle finished bets → scan the busiest football and politics markets → check every market for a locked-in arbitrage after commission → for the top markets, pull the last 24h of headlines (GDELT) and edge-confirmed Polymarket flow,
        ask the model for probabilities, blend them with the market price (it only trusts itself 30–50%), and bet where the edge after commission clears {s?.kelly.minEdgePct ?? 3}% — sized at {s ? Math.round(s.kelly.fraction * 100) : 25}% of Kelly, max {s?.kelly.maxBetPct ?? 2}% of bankroll.
      </p>
      {data?.error && <p className="exec-err">{data.error}</p>}
      {data && !data.error && s && <>
        <p className="exec-note">
          Mode <b className={s.mode === "LIVE" ? "exec-neg" : "exec-pos"}>{s.mode}</b> · Betfair {data.configured ? "connected" : <b className="exec-neg">not configured</b>} · model {data.llm ?? <b className="exec-neg">none</b>} · paper bankroll £{s.paperBankroll} · live cap £{s.liveCap} · commission {Math.round(s.kelly.commission * 100)}%
          {s.killSwitch && <b className="exec-neg"> · KILL SWITCH ON</b>}
        </p>
        <p className="exec-note">Real-money gate: <b className={data.gate?.ok ? "exec-pos" : ""}>{data.gate?.ok ? "OPEN" : "CLOSED"}</b> — {data.gate?.reason} Paper so far: {data.stats?.paper.bets ?? 0} settled, P&amp;L £{data.stats?.paper.pnl ?? 0} ({data.stats?.paper.roiPct ?? 0}% ROI){data.stats?.live.bets ? ` · Live: ${data.stats.live.bets} settled, £${data.stats.live.pnl}` : ""}.</p>
        {msg && <p className="exec-note"><b>{msg}</b></p>}
        {bets.length > 0 && (
          <div className="exec-table-wrap">
            <table className="exec-table">
              <thead><tr><th>When</th><th>Mode</th><th>Type</th><th>Event / market</th><th>Bet</th><th>Stake</th><th>Model vs market</th><th>Edge</th><th>Status</th><th>P&amp;L</th></tr></thead>
              <tbody>{bets.slice(0, 40).map((b) => (
                <tr key={b.id} title={b.error ?? b.reason ?? ""}>
                  <td>{b.created_at.slice(5, 16).replace("T", " ")}</td><td>{b.mode}</td><td>{b.kind}</td>
                  <td><b>{b.event_name}</b> · {b.market_name}</td>
                  <td>{b.side} {b.runner} @ {b.price}</td><td>£{b.stake}{b.side === "LAY" ? ` (risk £${b.risk})` : ""}</td>
                  <td>{b.p_model != null ? `${pct(b.p_model)} vs ${pct(b.p_market)}` : "—"}</td><td>{b.edge_pct != null ? `${b.edge_pct}%` : "—"}</td>
                  <td className={b.status === "REJECTED" ? "exec-neg" : ""}>{b.status}{b.error ? " ⚠" : ""}</td>
                  <td className={(b.pnl ?? 0) > 0 ? "exec-pos" : (b.pnl ?? 0) < 0 ? "exec-neg" : ""}>{b.pnl == null ? "—" : `£${b.pnl}`}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {(data.views?.length ?? 0) > 0 && (
          <div className="alloc-detail">
            <h3>What the agent read and thought (latest cycle)</h3>
            <ul className="exec-reasons arena-log">{data.views!.slice(0, 10).map((v, i) => (
              <li key={i} className={v.error ? "exec-neg" : ""}>
                <b>{v.event_name} · {v.market_name}</b> — {v.error ? `failed: ${v.error}` : <>
                  {(v.runners ?? []).map((r) => `${r.name} ${pct(v.probabilities?.[r.id])} (mkt ${pct(v.market_probabilities?.[r.id])})`).join(" · ")} · confidence <b>{v.confidence}</b>. {v.reason}
                  {v.idea ? <b className="exec-pos"> → {v.idea.side} {v.idea.runner} @ {v.idea.price}, £{v.idea.stake}, edge {v.idea.edgePct}%</b> : " → no bet."}
                  {(v.headlines?.length ?? 0) > 0 && <small className="ev-news"> News: {v.headlines!.slice(0, 3).map((h) => `${h.source}: ${h.title}`).join(" | ")}</small>}
                  {(v.smart_money?.length ?? 0) > 0 && <small className="ev-news"> {v.smart_money!.join(" ")}</small>}
                </>}
              </li>
            ))}</ul>
          </div>
        )}
        <ul className="exec-reasons">
          <li>Kelly is only as good as the probability fed into it. That is why the model&apos;s number is blended with the market&apos;s, only a quarter of Kelly is bet, and no single bet exceeds {s.kelly.maxBetPct}% of the bankroll. Odds above 10 are skipped (model error dominates there).</li>
          <li>Real money needs: a Betfair live app key, <code>EVENT_AGENT_MODE=live</code>, <b>and</b> the gate (100 settled paper value bets, ROI &gt; 0 after commission, t ≥ 2). Live exposure never exceeds £{s.liveCap}. Arbitrage legs go live only with <code>EVENT_ARB_LIVE=on</code> and are fill-or-kill.</li>
          <li>Betfair charges an extra Expert Fee to accounts with large long-run profits, and true arbitrage on one market is rare and brief — expect most cycles to find none.</li>
        </ul>
      </>}
    </section>
  );
}
