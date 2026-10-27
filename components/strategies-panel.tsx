"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { describeWeights, UCITS_EQUIVALENT, type Weights } from "@/lib/engine/allocation";
import type { CurrencyReport, PublicResult } from "@/lib/engine/allocation-report";
import { FEATURED } from "@/lib/engine/strategy-alert";

const ACCESS_KEY = "twm-v3-access";
type Report = { asOf: string; start: string; cutoff: string; results: PublicResult[]; usd?: CurrencyReport; gbp?: CurrencyReport | null; warnings: string[]; error?: string };

function code() {
  try { return window.sessionStorage.getItem(ACCESS_KEY) ?? ""; } catch { return ""; }
}
const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
const cls = (v: number) => (v > 0 ? "exec-pos" : v < 0 ? "exec-neg" : "");

// Categorical slots 1–4 (dark steps), assigned in fixed order.
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"];
const CHART_IDS = ["hold_spy", "hold_global", "blend_spy_rot", "ensemble"];

function Implementation({ w }: { w: Weights }) {
  return (
    <ul className="alloc-impl">
      {Object.entries(w).filter(([, v]) => v > 0.001).map(([t, v]) => <li key={t}><b>{Math.round(v * 100)}% {t}</b> → {UCITS_EQUIVALENT[t] ?? t}</li>)}
    </ul>
  );
}

function Curves({ results, currency }: { results: PublicResult[]; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = CHART_IDS.map((id, i) => ({ r: results.find((x) => x.id === id), color: SERIES[i] })).filter((s) => s.r) as Array<{ r: PublicResult; color: string }>;
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
      <figcaption>Growth of {currency === "GBP" ? "£1 (in pounds)" : "$1 (in dollars)"}, after costs · {series[0].r.curve[0]?.date} → {series[0].r.curve[n - 1]?.date}</figcaption>
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

function Detail({ r }: { r: PublicResult }) {
  const rb = r.robustness;
  if (!rb) return null;
  const b = rb.bootstrap;
  return (
    <div className="alloc-detail">
      <h3>{r.name} — year by year vs the S&amp;P 500</h3>
      <div className="exec-table-wrap">
        <table className="exec-table alloc-years">
          <thead><tr><th>Year</th>{rb.years.map((y) => <th key={y.year}>{y.year}</th>)}</tr></thead>
          <tbody>
            <tr><td><b>Strategy</b></td>{rb.years.map((y) => <td key={y.year} className={cls(y.pct)}>{pct(y.pct)}</td>)}</tr>
            <tr><td>S&amp;P 500</td>{rb.years.map((y) => <td key={y.year} className={cls(y.spyPct)}>{pct(y.spyPct)}</td>)}</tr>
            <tr><td>Difference</td>{rb.years.map((y) => <td key={y.year} className={cls(y.pct - y.spyPct)}>{pct(y.pct - y.spyPct)}</td>)}</tr>
          </tbody>
        </table>
      </div>
      {b && (
        <p className="exec-note">
          Resampled {b.paths.toLocaleString()} alternative {b.years}-year histories from real months (strategy and S&amp;P moved together):
          beat the S&amp;P in <b>{b.pBeatPct}%</b>; yearly gap median <b className={cls(b.medianCagrDiffPct)}>{pct(b.medianCagrDiffPct)}</b> (90% range {pct(b.cagrDiff5Pct)} to {pct(b.cagrDiff95Pct)});
          fell more than {b.ddThresholdPct}% at some point in <b>{b.pDrawdownOverPct}%</b> of histories vs <b>{b.pBenchDrawdownOverPct}%</b> for the S&amp;P.
        </p>
      )}
    </div>
  );
}

function Grid({ rep }: { rep: CurrencyReport }) {
  if (!rep.grid.length) return null;
  const looks = [...new Set(rep.grid.map((g) => g.lookbackMonths))];
  const tops = [...new Set(rep.grid.map((g) => g.topN))];
  const best = Math.max(...rep.grid.map((g) => g.sharpe));
  return (
    <div className="alloc-detail">
      <h3>Is the rotation setting a plateau or a lucky peak?</h3>
      <p className="exec-note">Best-N-of-5 rotation with every lookback / N combination. Each cell: Sharpe (10y) · held-out /yr. Green = within 80% of the best. <b>{rep.plateauPct}%</b> of settings are on the plateau — the higher, the less the result depends on picking the exact setting.</p>
      <div className="exec-table-wrap">
        <table className="exec-table alloc-grid">
          <thead><tr><th>Hold best</th>{looks.map((l) => <th key={l}>{l}-month</th>)}</tr></thead>
          <tbody>
            {tops.map((t) => (
              <tr key={t}>
                <td><b>{t}</b></td>
                {looks.map((l) => {
                  const g = rep.grid.find((x) => x.lookbackMonths === l && x.topN === t);
                  return <td key={l} className={g && g.sharpe >= best * 0.8 ? "alloc-plateau" : ""}>{g ? <>{g.sharpe.toFixed(2)}<small> · {pct(g.testCagrPct)}</small></> : "—"}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function StrategiesPanel() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [ccy, setCcy] = useState<"USD" | "GBP">("GBP");
  const [selected, setSelected] = useState<string>("blend_spy_rot");

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/strategies${refresh ? "?refresh=1" : ""}`, { headers: { "x-tradeswithme-access": code() } });
      setReport(await res.json() as Report);
    } catch (e) { setReport({ asOf: "", start: "", cutoff: "", results: [], warnings: [], error: e instanceof Error ? e.message : "Load failed." }); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { if (code()) void load(); }, [load]);

  const rep: CurrencyReport | null = (ccy === "GBP" ? report?.gbp : report?.usd) ?? report?.usd ?? null;
  const shownCcy = rep?.currency ?? "USD";
  const results = rep?.results ?? report?.results ?? [];
  const spy = results.find((r) => r.id === "hold_spy");
  const ranked = useMemo(() => [...results].sort((a, b) => b.train.sharpe - a.train.sharpe), [results]);
  const featured = FEATURED.map((id) => results.find((r) => r.id === id)).filter(Boolean) as PublicResult[];
  const sel = results.find((r) => r.id === selected) ?? featured[0];

  return (
    <section className="exec-panel">
      <div className="exec-head">
        <div>
          <p className="exec-eyebrow">MONEY WHILE YOU SLEEP · SIMPLE RULES · CHECK ONCE A MONTH · ISA-FRIENDLY</p>
          <h2>Simple allocation strategies</h2>
        </div>
        <div className="exec-actions">
          <div className="alloc-toggle" role="group" aria-label="Currency">
            {(["GBP", "USD"] as const).map((c) => (
              <button key={c} className={ccy === c ? "on" : ""} onClick={() => setCcy(c)} disabled={c === "GBP" && report != null && !report.gbp}>{c === "GBP" ? "£ GBP" : "$ USD"}</button>
            ))}
          </div>
          <button onClick={() => void load(true)} disabled={busy}>{busy ? "Loading ~10 years…" : report ? "Refresh" : "Load strategies"}</button>
        </div>
      </div>
      <p className="exec-note">
        Ten years of daily prices, textbook rules from published research (no tuning), 0.05% cost per trade, decisions made at a close and applied from the next day.
        “Held-out” = the last 2 years. <b>£ GBP</b> converts every fund into pounds with daily ECB exchange rates — what a UK investor holding unhedged trackers actually got.
        Signals are always decided on the US prices, so positions are identical in both views. Research, not financial advice.
      </p>
      {report?.error && <p className="exec-err">{report.error}</p>}
      {report && !report.error && rep && <>
        {ccy === "GBP" && !report.gbp && <p className="exec-err">GBP view unavailable (exchange-rate history did not load) — showing USD.</p>}
        <div className="alloc-cards">
          {featured.map((r) => (
            <article key={r.id} className="alloc-card">
              <h3>{r.name}</h3>
              <p className="alloc-now"><span>Hold now</span><b>{describeWeights(r.holding)}</b><small>since {r.holdingSince}</small></p>
              {describeWeights(r.ifCheckedToday) !== describeWeights(r.holding) && <p className="alloc-flag">If the month ended today: <b>{describeWeights(r.ifCheckedToday)}</b></p>}
              <Implementation w={r.holding} />
              <p className="alloc-meta">10y: {pct(r.full.cagrPct)}/yr · worst drop {r.full.maxDrawdownPct}% · held-out {pct(r.test.cagrPct)}/yr{r.robustness?.bootstrap ? ` · beat S&P in ${r.robustness.bootstrap.pBeatPct}% of resampled decades` : ""}</p>
            </article>
          ))}
        </div>
        <Curves results={results} currency={shownCcy} />
        <div className="exec-table-wrap">
          <table className="exec-table alloc-main">
            <thead><tr>
              <th>Strategy</th><th>10y /yr</th><th>Worst drop</th><th>Sharpe</th><th>Worst year</th><th>Trades /yr</th><th>Invested</th>
              <th>Held-out /yr</th><th>vs S&amp;P held-out</th>
              <th title="Share of full calendar years this strategy returned more than the S&P 500">Years beat S&amp;P</th>
              <th title="Paired block bootstrap: share of 1,000 resampled 10-year histories in which it ended ahead of the S&P 500">P(beat S&amp;P, 10y)</th>
              <th title="Deflated Sharpe ratio: probability the Sharpe is real after counting every rule and setting we tried. ≥0.95 is strong evidence.">Deflated Sharpe</th>
            </tr></thead>
            <tbody>
              {ranked.map((r) => {
                const rb = r.robustness;
                return (
                  <tr key={r.id} title={r.caveat ?? r.description} className={sel?.id === r.id ? "alloc-sel" : ""} onClick={() => setSelected(r.id)}>
                    <td><b>{r.name}</b>{r.caveat ? " ⚠" : ""}</td>
                    <td className={cls(r.full.cagrPct)}>{pct(r.full.cagrPct)}</td>
                    <td>{r.full.maxDrawdownPct}%</td>
                    <td>{r.full.sharpe.toFixed(2)}</td>
                    <td className={cls(r.full.worstYearPct)}>{pct(r.full.worstYearPct)}</td>
                    <td>{r.full.switchesPerYear}</td>
                    <td>{r.full.riskOnPct}%</td>
                    <td className={cls(r.test.cagrPct)}>{pct(r.test.cagrPct)}</td>
                    <td className={cls(r.test.cagrPct - (spy?.test.cagrPct ?? 0))}>{spy && r.id !== "hold_spy" ? pct(r.test.cagrPct - spy.test.cagrPct) : "—"}</td>
                    <td>{rb && r.id !== "hold_spy" ? `${rb.yearsBeatSpyPct}%` : "—"}</td>
                    <td>{rb?.bootstrap ? `${rb.bootstrap.pBeatPct}%` : "—"}</td>
                    <td className={rb ? (rb.dsr >= 0.95 ? "exec-pos" : rb.dsr < 0.5 ? "exec-neg" : "") : ""}>{rb ? rb.dsr.toFixed(2) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="exec-note">Click a row for its year-by-year record and resampling test.</p>
        {sel && <Detail r={sel} />}
        <Grid rep={rep} />
        <ul className="exec-reasons">
          <li>Period {rep.start} → {rep.asOf}; held-out from {rep.cutoff}. Sorted by Sharpe on the years before the held-out period. Deflated Sharpe counts {rep.trials} rules and settings tried.</li>
          {ranked.filter((r) => r.caveat).map((r) => <li key={r.id}>⚠ {r.name}: {r.caveat}</li>)}
          {report.warnings.map((w) => <li key={w} className="exec-neg">{w}</li>)}
          <li>How to choose: pick the rule whose <b>worst drop</b> you could sit through without selling, prefer a high <b>P(beat S&amp;P)</b> or a lower drop for similar return, and treat a Deflated Sharpe below 0.5 as “could be luck”. Then stick to it — switching rules after a bad month is how most people lose.</li>
        </ul>
      </>}
    </section>
  );
}
