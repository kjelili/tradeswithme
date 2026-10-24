"use client";

import { useCallback, useEffect, useState } from "react";

const ACCESS_KEY = "twm-v3-access";

type Order = {
  id: number; created_at: string; broker: string; mode: string; symbol: string; status: string;
  qty: number; limit_usd: number; stop_usd: number; target_usd: number; notional_gbp: number;
  exit_reason: string | null; pnl_usd: number | null; detail: string | null;
};
type Status = {
  env?: { requestedMode: string; hardCapGbp: number; lossBreakerPct: number; envKillSwitch: boolean; brokers: Record<string, boolean> };
  state?: { halted: boolean; reason: string | null; last_run: { at: string; decision: { mode: string; newEntriesAllowed: boolean; reasons: string[] }; errors: string[] } | null };
  orders?: Order[];
  error?: string;
};

export default function ExecutionPanel() {
  const [code, setCode] = useState("");
  const [data, setData] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => { try { setCode(window.sessionStorage.getItem(ACCESS_KEY) ?? ""); } catch { /* storage unavailable */ } }, []);

  const load = useCallback(async () => {
    setBusy(true); setMsg("");
    try {
      const response = await fetch("/api/execution", { headers: { "x-tradeswithme-access": code } });
      setData(await response.json() as Status);
    } catch (error) { setMsg(error instanceof Error ? error.message : "Load failed."); }
    finally { setBusy(false); }
  }, [code]);

  async function act(action: "halt" | "resume" | "flatten") {
    if (action === "flatten" && !window.confirm("Cancel all bot entries and market-close every bot position now?")) return;
    setBusy(true); setMsg("");
    try {
      const response = await fetch("/api/execution", { method: "POST", headers: { "Content-Type": "application/json", "x-tradeswithme-access": code }, body: JSON.stringify({ action }) });
      const json = await response.json() as { error?: string; closed?: string[] };
      setMsg(json.error ?? (action === "flatten" ? `Flattened: ${(json.closed ?? []).join(", ") || "nothing open"}` : `${action} ok`));
      await load();
    } catch (error) { setMsg(error instanceof Error ? error.message : "Action failed."); }
    finally { setBusy(false); }
  }

  const run = data?.state?.last_run;
  const open = (data?.orders ?? []).filter((o) => ["PENDING_SUBMIT", "SUBMITTED", "OPEN"].includes(o.status));
  const realised = (data?.orders ?? []).filter((o) => o.status === "CLOSED" && o.mode === "LIVE").reduce((s, o) => s + Number(o.pnl_usd ?? 0), 0);

  return (
    <section className="exec-panel">
      <div className="exec-head">
        <div>
          <p className="exec-eyebrow">BROKER EXECUTION · V5.4</p>
          <h2>Autopilot {data?.env ? <em className={`exec-mode exec-${(run?.decision.mode ?? data.env.requestedMode).toLowerCase()}`}>{run?.decision.mode ?? data.env.requestedMode}</em> : null}</h2>
        </div>
        <div className="exec-actions">
          <button onClick={() => void load()} disabled={busy}>{busy ? "…" : "Refresh"}</button>
          {data?.state?.halted
            ? <button onClick={() => void act("resume")} disabled={busy}>Resume entries</button>
            : <button className="exec-warn" onClick={() => void act("halt")} disabled={busy || !data}>Halt new entries</button>}
          <button className="exec-danger" onClick={() => void act("flatten")} disabled={busy || !data}>Flatten all</button>
        </div>
      </div>
      {!data && <p className="exec-note">Uses the same personal access code as the desk. Press Refresh to load execution status.</p>}
      {data?.error && <p className="exec-err">{data.error}</p>}
      {msg && <p className="exec-note">{msg}</p>}
      {data?.env && (
        <div className="exec-grid">
          <div><span>Hard cap</span><strong>£{data.env.hardCapGbp}</strong></div>
          <div><span>Loss breaker</span><strong>{data.env.lossBreakerPct}%</strong></div>
          <div><span>Open bot orders</span><strong>{open.length}</strong></div>
          <div><span>Live realised P&amp;L</span><strong className={realised >= 0 ? "exec-pos" : "exec-neg"}>${realised.toFixed(2)}</strong></div>
          <div><span>Brokers</span><strong className="exec-small">{Object.entries(data.env.brokers).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}</strong></div>
        </div>
      )}
      {run && (
        <ul className="exec-reasons">
          <li><b>Last run {new Date(run.at).toLocaleString()}</b> — new entries {run.decision.newEntriesAllowed ? "allowed" : "blocked"}</li>
          {run.decision.reasons.map((r) => <li key={r}>{r}</li>)}
          {run.errors.map((e) => <li key={e} className="exec-neg">{e}</li>)}
        </ul>
      )}
      {!!data?.orders?.length && (
        <div className="exec-table-wrap">
          <table className="exec-table">
            <thead><tr><th>When</th><th>Mode</th><th>Broker</th><th>Symbol</th><th>Status</th><th>Qty</th><th>Entry</th><th>Stop</th><th>Target</th><th>£</th><th>Exit</th><th>P&amp;L $</th></tr></thead>
            <tbody>{data.orders.map((o) => (
              <tr key={o.id} title={o.detail ?? ""}>
                <td>{o.created_at.slice(0, 10)}</td><td>{o.mode}</td><td>{o.broker}</td><td><b>{o.symbol}</b></td><td>{o.status}</td>
                <td>{Number(o.qty)}</td><td>{Number(o.limit_usd)}</td><td>{Number(o.stop_usd)}</td><td>{Number(o.target_usd)}</td>
                <td>{Number(o.notional_gbp).toFixed(2)}</td><td>{o.exit_reason ?? "—"}</td>
                <td className={Number(o.pnl_usd ?? 0) >= 0 ? "exec-pos" : "exec-neg"}>{o.pnl_usd == null ? "—" : Number(o.pnl_usd).toFixed(2)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
