"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { describeWeights, UCITS_EQUIVALENT, type StrategyResult, type Weights } from "@/lib/engine/allocation";
import { FEATURED } from "@/lib/engine/strategy-alert";

const ACCESS_KEY = "twm-v3-access";
type Report = { asOf: string; start: string; cutoff: string; results: StrategyResult[]; warnings: string[]; error?: string };

function code() {
  try { return window.sessionStorage.getItem(ACCESS_KEY) ?? ""; } catch { return ""; }
}
const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
const cls = (v: number) => (v > 0 ? "exec-pos" : v < 0 ? "exec-neg" : "");

// Categorical slots 1–4 (dark steps), assigned in fixed order to the featured strategies.
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"];
const CHART_IDS = ["hold_spy", "trend200_monthly", "dual_mom_cash", "rot_top2_12"];

function Implementation({ w }: { w: Weights }) {
  return (
    <ul className="alloc-impl">
      {Object.entries(w).filter(([, v]) => v > 0.001).map(([t, v]) => <li key={t}><b>{Math.round(v * 100)}% {t}</b> → {UCITS_EQUIVALENT[t] ?? t}</li>)}
    </ul>
  );
}

function Curves({ results }: { results: StrategyResult[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = CHART_IDS.map((id, i) => ({ r: results.find((x) => x.id === id), color: SERIES[i] })).filter((s) => s.r) as Array<{ r: StrategyResult; color: string }>;
  if (!series.length) return null;
  const n = Math.min(...series.map((s) => s.r.curve.length));
  const W = 720, H = 220, PL = 8, PR = 8, PT = 10, PB = 10;
  const all = series.flatMap((s) => s.r.curve.slice(0, n).map((p) => p.equity));
  const lo = Math.min(1, ...all), hi = Math.max(...all);
  const x = (i: number) => PL + (i / Math.max(1, n - 1)) * (W - PL - PR);
  const y = (v: number) => PT + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (H - PT - PB);
  const at = hover ?? n - 1;
  return (
    <figure className="replay-curve">
      <figcaption>Growth of £1 (USD proxies, after costs) · {series[0].r.curve[0]?.date} → {series[0].r.curve[n - 1]?.date}</figcaption>
      <div className="alloc-legend">
        {series.map((s) => (
          <span key={s.r.id}><i style={{ background: s.color }} />{s.r.name} <b>{s.r.curve[at]?.equity.toFixed(2)}×</b></span>
        ))}
        <span className="alloc-date">{series[0].r.curve[at]?.date}</span>
      </div>
      <div className="fan-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Strategy equity curves"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const rel = ((e.clientX - rect.left) / rect.width) * W;
            setHover(Math.max(0, Math.min(n - 1, Math.round(((rel - PL) / (W - PL - PR)) * (n - 1)))));
          }}>
          <line x1={PL} x2={W - PR} y1={y(1)} y2={y(1)} className="replay-base" />
          {series.map((s) => (
            <path key={s.r.id} d={s.r.curve.slice(0, n).map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ")}
              fill="none" stroke={s.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          ))}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PT} y2={H - PB} className="replay-cross" />}
        </svg>
        <span className="fan-axis" style={{ top: `${(y(hi) / H) * 100}%`, left: 4 }}>{hi.toFixed(1)}×</span>
        <span className="fan-axis" style={{ top: `${(y(1) / H) * 100}%`, left: 4 }}>1.0×</span>
      </div>
    </figure>
  );
}

export default function StrategiesPanel() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/strategies${refresh ? "?refresh=1" : ""}`, { headers: { "x-tradeswithme-access": code() } });
      setReport(await res.json() as Report);
    } catch (e) { setReport({ asOf: "", start: "", cutoff: "", results: [], warnings: [], error: e instanceof Error ? e.message : "Load failed." }); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { if (code()) void load(); }, [load]);

  const spy = report?.results.find((r) => r.id === "hold_spy");
  const ranked = useMemo(() => [...(report?.results ?? [])].sort((a, b) => b.train.sharpe - a.train.sharpe), [report]);
  const featured = FEATURED.map((id) => report?.results.find((r) => r.id === id)).filter(Boolean) as StrategyResult[];

  return (
    <section className="exec-panel">
      <div className="exec-head">
        <div>
          <p className="exec-eyebrow">MONEY WHILE YOU SLEEP · SIMPLE RULES · CHECK ONCE A MONTH · ISA-FRIENDLY</p>
          <h2>Simple allocation strategies</h2>
        </div>
        <div className="exec-actions"><button onClick={() => void load(true)} disabled={busy}>{busy ? "Loading ~10 years…" : report ? "Refresh" : "Load strategies"}</button></div>
      </div>
      <p className="exec-note">
        Ten years of daily prices, textbook rules (no tuning), 0.05% cost per trade, decisions made at a close and applied from the next day.
        “Held-out” = the last 2 years. The nightly job emails the month&apos;s positions on the first run of each month (and when the daily 200-day rule flips).
        Tested in USD on US-listed funds; UK trackers in GBP also move with the exchange rate. Research, not financial advice.
      </p>
      {report?.error && <p className="exec-err">{report.error}</p>}
      {report && !report.error && <>
        <div className="alloc-cards">
          {featured.map((r) => (
            <article key={r.id} className="alloc-card">
              <h3>{r.name}</h3>
              <p className="alloc-now"><span>Hold now</span><b>{describeWeights(r.holding)}</b><small>since {r.holdingSince}</small></p>
              {describeWeights(r.ifCheckedToday) !== describeWeights(r.holding) && <p className="alloc-flag">If the month ended today: <b>{describeWeights(r.ifCheckedToday)}</b></p>}
              <Implementation w={r.holding} />
              <p className="alloc-meta">10y: {pct(r.full.cagrPct)}/yr · worst drop {r.full.maxDrawdownPct}% · held-out {pct(r.test.cagrPct)}/yr</p>
            </article>
          ))}
        </div>
        <Curves results={report.results} />
        <div className="exec-table-wrap">
          <table className="exec-table">
            <thead><tr><th>Strategy</th><th>10y /yr</th><th>Worst drop</th><th>Sharpe</th><th>Worst year</th><th>Trades /yr</th><th>Invested</th><th>Held-out /yr</th><th>Held-out drop</th><th>vs S&amp;P held-out</th></tr></thead>
            <tbody>
              {ranked.map((r) => (
                <tr key={r.id} title={r.caveat ?? r.description}>
                  <td><b>{r.name}</b>{r.caveat ? " ⚠" : ""}</td>
                  <td className={cls(r.full.cagrPct)}>{pct(r.full.cagrPct)}</td>
                  <td>{r.full.maxDrawdownPct}%</td>
                  <td>{r.full.sharpe.toFixed(2)}</td>
                  <td className={cls(r.full.worstYearPct)}>{pct(r.full.worstYearPct)}</td>
                  <td>{r.full.switchesPerYear}</td>
                  <td>{r.full.riskOnPct}%</td>
                  <td className={cls(r.test.cagrPct)}>{pct(r.test.cagrPct)}</td>
                  <td>{r.test.maxDrawdownPct}%</td>
                  <td className={cls(r.test.cagrPct - (spy?.test.cagrPct ?? 0))}>{spy ? pct(r.test.cagrPct - spy.test.cagrPct) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="exec-reasons">
          <li>Period {report.start} → {report.asOf}; held-out from {report.cutoff}. Sorted by risk-adjusted return (Sharpe) on the years before the held-out period.</li>
          {ranked.filter((r) => r.caveat).map((r) => <li key={r.id}>⚠ {r.name}: {r.caveat}</li>)}
          {report.warnings.map((w) => <li key={w} className="exec-neg">{w}</li>)}
          <li>Honest reading: trend and momentum rules usually trail buy-and-hold in strong bull markets and earn their keep by cutting long, deep falls. Pick one by the worst drop you could sit through, then stick to it — switching rules after a bad month is how most people lose.</li>
        </ul>
      </>}
    </section>
  );
}
