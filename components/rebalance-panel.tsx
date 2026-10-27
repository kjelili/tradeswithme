"use client";

import { useCallback, useEffect, useState } from "react";
import { describeWeights } from "@/lib/engine/allocation";
import type { PlanRow } from "@/lib/server/rebalance";

const ACCESS_KEY = "twm-v3-access";
type Status = { configured: boolean; env: "demo" | "live" | null; strategy: string; auto: boolean; killSwitch: boolean; mapped: Record<string, string>; mapError: string | null; options: { bandPct: number; minOrderValue: number; maxOrderValue: number; budget?: number; decimals: number } };
type Data = { status?: Status; plans?: PlanRow[]; error?: string };

function code() {
  try { return window.sessionStorage.getItem(ACCESS_KEY) ?? ""; } catch { return ""; }
}
const money = (v: number) => v.toLocaleString("en-GB", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export default function RebalancePanel() {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/rebalance", { headers: { "x-tradeswithme-access": code() } });
      setData(await res.json() as Data);
    } catch (e) { setData({ error: e instanceof Error ? e.message : "Load failed." }); }
  }, []);
  useEffect(() => { if (code()) void load(); }, [load]);

  async function act(action: "plan" | "approve" | "cancel", id?: string) {
    if (action === "approve") {
      const env = data?.status?.env === "live" ? "LIVE (real money)" : "DEMO";
      if (!window.confirm(`Send these market orders to Trading 212 ${env}? Sells first, then buys sized to the cash available.`)) return;
    }
    setBusy(action); setMsg(null);
    try {
      const res = await fetch("/api/rebalance", { method: "POST", headers: { "Content-Type": "application/json", "x-tradeswithme-access": code() }, body: JSON.stringify({ action, id }) });
      const json = await res.json() as { error?: string; plan?: PlanRow };
      setMsg(json.error ?? (json.plan ? `Plan ${json.plan.status.toLowerCase()}.` : "Done."));
      await load();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Request failed."); }
    finally { setBusy(null); }
  }

  const st = data?.status;
  const plans = data?.plans ?? [];
  const latest = plans[0];
  const fresh = latest && latest.status === "PROPOSED" && Date.now() - new Date(latest.created_at).getTime() < 6 * 3600 * 1000;

  return (
    <section className="exec-panel">
      <div className="exec-head">
        <div>
          <p className="exec-eyebrow">TRADING 212 · STOCKS ISA · MONTHLY · SELLS FIRST · APPROVE OR AUTO</p>
          <h2>ISA rebalance assistant</h2>
        </div>
        <div className="exec-actions">
          {!data && <button onClick={() => void load()} disabled={!!busy}>Load ISA status</button>}
          <button onClick={() => void act("plan")} disabled={!!busy || !st?.configured}>{busy === "plan" ? "Reading account…" : "Make plan now"}</button>
          {fresh && <button className="rb-approve" onClick={() => void act("approve", latest.id)} disabled={!!busy}>{busy === "approve" ? "Sending orders…" : `Approve & send (${latest.env})`}</button>}
          {fresh && <button onClick={() => void act("cancel", latest.id)} disabled={!!busy}>Cancel</button>}
        </div>
      </div>
      {data?.error && <p className="exec-err">{data.error}</p>}
      {st && (
        <p className="exec-note">
          {st.configured ? <>Connected to <b className={st.env === "live" ? "exec-neg" : "exec-pos"}>{st.env?.toUpperCase()}</b></> : <b className="exec-neg">Not connected — set T212_API_KEY / T212_API_SECRET</b>}
          {" "}· strategy <b>{st.strategy}</b> · {st.auto ? <b>auto-execute ON (weekdays 10:40 UTC)</b> : "approval required"}
          {" "}· drift band {st.options.bandPct}% · max order {money(st.options.maxOrderValue)}{st.options.budget ? ` · budget ${money(st.options.budget)}` : ""}
          {st.killSwitch && <b className="exec-neg"> · KILL SWITCH ON</b>}
          {st.mapError && <span className="exec-neg"> · {st.mapError}</span>}
        </p>
      )}
      {msg && <p className="exec-note"><b>{msg}</b></p>}
      {latest ? (
        <div className="rb-plan">
          <p className="exec-note">Latest plan · {new Date(latest.created_at).toLocaleString("en-GB")} · <b>{latest.status}</b> · target {describeWeights(latest.targets)} (data to {latest.as_of}) · managed {money(latest.plan.managedValue)}, cash {money(latest.plan.cashAvailable)}</p>
          {latest.plan.blockers.map((b) => <p key={b} className="exec-err">Blocked: {b}</p>)}
          {latest.plan.lines.length > 0 && (
            <div className="exec-table-wrap">
              <table className="exec-table">
                <thead><tr><th>Instrument</th><th>For</th><th>Target</th><th>Target value</th><th>Now</th><th>Drift</th></tr></thead>
                <tbody>{latest.plan.lines.map((l) => (
                  <tr key={l.ticker}><td><b>{l.ticker}</b></td><td>{l.proxies.join(", ")}</td><td>{l.weightPct}%</td><td>{money(l.targetValue)}</td><td>{money(l.currentValue)}</td><td className={Math.abs(l.driftPct) >= st!.options.bandPct ? "exec-neg" : ""}>{l.driftPct > 0 ? "+" : ""}{l.driftPct}%</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {latest.plan.orders.length > 0 && (
            <ul className="exec-reasons">{latest.plan.orders.map((o) => <li key={o.ticker + o.side}><b>{o.side}</b> {o.quantity} × {o.ticker} ≈ {money(o.estValue)} — {o.reason}</li>)}</ul>
          )}
          {latest.plan.manual.map((m) => <p key={m.ticker} className="alloc-flag">Manual once: buy ≈ {money(m.estValue)} of <b>{m.ticker}</b> in the Trading 212 app. {m.reason}</p>)}
          {latest.plan.orders.length === 0 && latest.plan.manual.length === 0 && !latest.plan.blockers.length && <p className="exec-note">Within the drift band — nothing to trade.</p>}
          {latest.plan.warnings.map((w) => <p key={w} className="exec-note">⚠ {w}</p>)}
          {latest.results && latest.results.length > 0 && (
            <ul className="exec-reasons">{latest.results.map((r, i) => <li key={i} className={r.ok ? "" : "exec-neg"}>{r.ok ? "✓" : "✗"} {r.side} {r.quantity} {r.ticker}{r.status ? ` · ${r.status}` : ""}{r.error ? ` · ${r.error}` : ""}</li>)}</ul>
          )}
        </div>
      ) : st?.configured ? <p className="exec-note">No plans yet. “Make plan now” reads your account and shows the orders before anything is sent.</p> : null}
      <ul className="exec-reasons">
        <li>Only instruments in <code>T212_TICKER_MAP</code> are touched; anything else in the ISA is left alone. No shorting, no leverage, no withdrawals (the API can&apos;t withdraw).</li>
        <li>Plans expire after 6 hours. A plan can execute once (double clicks are ignored). Failed orders are never retried automatically — check the app and make a new plan.</li>
        <li>Market orders outside London hours queue until the open. Start on <b>demo</b>; switch <code>T212_ENV=live</code> only after a clean demo month. Trading 212&apos;s API is in beta.</li>
      </ul>
    </section>
  );
}
