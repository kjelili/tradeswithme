"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import FanChart from "@/components/fan-chart";
import { chanceOfProfit } from "@/lib/engine/replay-stats";
import type { Funnel } from "@/lib/engine/funnel";

const ACCESS_KEY = "twm-v3-access";

type Readiness = { status: string; completed: number; wins: number; costBps: number; expectancyPct: number; profitFactor: number; maxDrawdownPct: number; returnsSample: number[] };
type ExecStatus = { state?: { last_run?: { at: string; funnel?: Funnel } | null }; readiness?: Record<"EQUITY" | "CRYPTO", Readiness> | null; error?: string };
type Line = { id: number; run_at: string; agent: string; level: string; message: string };

function code() {
  try { return window.sessionStorage.getItem(ACCESS_KEY) ?? ""; } catch { return ""; }
}

function FunnelView({ funnel }: { funnel: Funnel }) {
  const top = Math.max(1, funnel.stages[0]?.count ?? 1);
  const maxReason = Math.max(1, ...funnel.reasons.map((r) => r.count));
  return (
    <div className="ins-grid">
      <div>
        <h3>Decision funnel <small>{new Date(funnel.at).toLocaleString()}</small></h3>
        <ol className="funnel">
          {funnel.stages.map((s) => (
            <li key={s.key}>
              <div className="funnel-label"><b>{s.label}</b><span>{s.note}</span></div>
              <div className="funnel-bar" aria-hidden="true"><i style={{ width: `${s.count == null ? 0 : Math.max(2, (s.count / top) * 100)}%` }} /></div>
              <strong>{s.count == null ? "off" : s.count}</strong>
            </li>
          ))}
        </ol>
      </div>
      <div>
        <h3>Why signals got skipped</h3>
        {funnel.reasons.length ? (
          <ul className="skip-list">
            {funnel.reasons.map((r) => (
              <li key={r.reason} title={r.examples.join(", ")}>
                <span>{r.reason}</span>
                <div className="funnel-bar skip" aria-hidden="true"><i style={{ width: `${(r.count / maxReason) * 100}%` }} /></div>
                <strong>{r.count}</strong>
                <small>{r.examples.join(", ")}</small>
              </li>
            ))}
          </ul>
        ) : <p className="exec-note">Nothing was skipped on the last run.</p>}
      </div>
    </div>
  );
}

const AGENT_CLASS: Record<string, string> = { SCOUT: "ag-scout", FILTER: "ag-filter", ANALYST: "ag-analyst", RISK: "ag-risk", EXECUTOR: "ag-exec", SYSTEM: "ag-sys" };

function ActivityLog({ lines }: { lines: Line[] }) {
  const runs = useMemo(() => {
    const map = new Map<string, Line[]>();
    for (const l of lines) { const k = l.run_at; map.set(k, [...(map.get(k) ?? []), l]); }
    return [...map.entries()].slice(0, 5).map(([at, ls]) => ({ at, lines: [...ls].sort((a, b) => a.id - b.id) }));
  }, [lines]);
  if (!runs.length) return <p className="exec-note">No activity yet — it appears after the next nightly run (02:20 UTC).</p>;
  return (
    <div className="agents-log" role="log" aria-label="Agent activity log">
      {runs.map((run) => (
        <section key={run.at}>
          <p className="log-run">Run {new Date(run.at).toLocaleString()}</p>
          {run.lines.map((l) => (
            <p key={l.id} className={`log-line lvl-${l.level}`}><b className={AGENT_CLASS[l.agent] ?? ""}>{l.agent}:</b> {l.message}</p>
          ))}
        </section>
      ))}
    </div>
  );
}

export default function DeskInsights() {
  const [status, setStatus] = useState<ExecStatus | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [cls, setCls] = useState<"CRYPTO" | "EQUITY">("CRYPTO");

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const headers = { "x-tradeswithme-access": code() };
      const [a, b] = await Promise.all([fetch("/api/execution", { headers }), fetch("/api/activity", { headers })]);
      const sa = await a.json() as ExecStatus; const sb = await b.json() as { lines?: Line[]; error?: string };
      setStatus(sa); setLines(sb.lines ?? []);
      if (sa.error || sb.error) setErr(sa.error ?? sb.error ?? "");
    } catch (e) { setErr(e instanceof Error ? e.message : "Load failed."); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { if (code()) void load(); }, [load]);

  const r = status?.readiness?.[cls];
  const fan = useMemo(() => (r ? chanceOfProfit(r.returnsSample) : null), [r]);
  const funnel = status?.state?.last_run?.funnel;

  return (
    <section className="exec-panel">
      <div className="exec-head">
        <div>
          <p className="exec-eyebrow">WHAT THE BOT SAW · WHY IT ACTED · WHAT TO EXPECT</p>
          <h2>Funnel, agents &amp; chance of profit</h2>
        </div>
        <div className="exec-actions"><button onClick={() => void load()} disabled={busy}>{busy ? "…" : "Refresh"}</button></div>
      </div>
      {err && <p className="exec-err">{err}</p>}
      {!status && !err && <p className="exec-note">Enter your access code at the top of the desk, then press Refresh.</p>}
      {funnel ? <FunnelView funnel={funnel} /> : status && <p className="exec-note">The funnel appears after the next nightly run.</p>}
      {status && <>
        <h3 className="ins-h">Agent activity</h3>
        <ActivityLog lines={lines} />
        <div className="ins-row">
          <h3 className="ins-h">Forward record at real broker costs</h3>
          <div className="exec-actions">
            {(["CRYPTO", "EQUITY"] as const).map((c) => <button key={c} aria-pressed={cls === c} className={cls === c ? "exec-warn" : ""} onClick={() => setCls(c)}>{c === "CRYPTO" ? "Crypto" : "Equities"}</button>)}
          </div>
        </div>
        {r ? (
          <>
            <ul className="exec-reasons">
              <li><b>{r.status.replace("_", " ")}</b> · {r.completed} settled · {r.wins} wins · avg {r.expectancyPct.toFixed(2)}% · PF {r.profitFactor.toFixed(2)} · max DD {r.maxDrawdownPct.toFixed(1)}% · costs {(r.costBps / 100).toFixed(2)}% per trade</li>
            </ul>
            {fan ? <FanChart fan={fan} title={`Chance of profit — next 100 ${cls === "CRYPTO" ? "crypto" : "equity"} trades (from the forward ledger)`} /> : <p className="exec-note">Needs at least 10 settled {cls === "CRYPTO" ? "crypto" : "equity"} calls before a chance-of-profit can be drawn.</p>}
          </>
        ) : <p className="exec-note">Forward readiness unavailable (Supabase not configured or not migrated).</p>}
      </>}
    </section>
  );
}
