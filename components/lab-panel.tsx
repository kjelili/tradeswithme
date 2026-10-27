"use client";

import { useEffect, useMemo, useState } from "react";
import { DEFAULT_WATCHLIST } from "@/lib/engine/config";
import { affordability, analyseLab, cutoffFor, LIVE_VARIANT, type LabBaseline, type LabSymbolResult, type SampleStats } from "@/lib/engine/lab-stats";

const ACCESS_KEY = "twm-v3-access";
const RESULTS_KEY = "twm-lab-results";
const CONCURRENCY = 3;

function code() {
  try { return window.sessionStorage.getItem(ACCESS_KEY) ?? ""; } catch { return ""; }
}

const pct = (v: number, d = 2) => `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;
const cls = (v: number) => (v > 0 ? "exec-pos" : v < 0 ? "exec-neg" : "");

const VERDICT_LABEL: Record<string, string> = {
  EDGE_HOLDS_OUT_OF_SAMPLE: "EDGE HOLDS OUT OF SAMPLE",
  PROMISING_NOT_PROVEN: "PROMISING, NOT PROVEN",
  NO_EDGE: "NO EDGE",
};

function Stat({ label, s }: { label: string; s: SampleStats }) {
  return (
    <div className="lab-stat">
      <span>{label}</span>
      <strong className={cls(s.avgAlphaPct)}>{s.n ? pct(s.avgAlphaPct) : "—"}</strong>
      <small>{s.n} trades · net {s.n ? pct(s.avgNetPct) : "—"} · win {s.winRatePct}% · t={s.tAlpha}</small>
    </div>
  );
}

export default function LabPanel() {
  const [results, setResults] = useState<LabSymbolResult[]>([]);
  const [baselines, setBaselines] = useState<LabBaseline[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [errors, setErrors] = useState<string[]>([]);
  const [scope, setScope] = useState<"ALL" | "EQUITY" | "CRYPTO">("EQUITY");

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RESULTS_KEY);
      if (raw) { const saved = JSON.parse(raw) as { results: LabSymbolResult[]; baselines: LabBaseline[] }; setResults(saved.results ?? []); setBaselines(saved.baselines ?? []); }
    } catch { /* ignore */ }
  }, []);

  async function run() {
    const headers = { "Content-Type": "application/json", "x-tradeswithme-access": code() };
    const symbols = [...DEFAULT_WATCHLIST];
    setRunning(true); setErrors([]); setResults([]); setBaselines([]); setProgress({ done: 0, total: symbols.length });
    const out: LabSymbolResult[] = [];
    const errs: string[] = [];
    let next = 0;
    async function worker() {
      while (next < symbols.length) {
        const symbol = symbols[next++];
        try {
          const res = await fetch("/api/lab", { method: "POST", headers, body: JSON.stringify({ symbol }) });
          const json = await res.json() as LabSymbolResult & { error?: string };
          if (!res.ok || json.error) errs.push(`${symbol}: ${json.error ?? res.status}`); else { out.push(json); setResults([...out]); }
        } catch (e) { errs.push(`${symbol}: ${e instanceof Error ? e.message : "failed"}`); }
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    let bl: LabBaseline[] = [];
    try {
      const start = out.map((r) => r.firstDate ?? "").filter(Boolean).sort()[0];
      const res = await fetch("/api/lab", { method: "POST", headers, body: JSON.stringify({ symbol: "BASELINE", start, cutoff: cutoffFor(out) }) });
      bl = ((await res.json()) as { baselines?: LabBaseline[] }).baselines ?? [];
      setBaselines(bl);
    } catch { errs.push("Baselines unavailable."); }
    setErrors(errs);
    setRunning(false);
    try { window.localStorage.setItem(RESULTS_KEY, JSON.stringify({ results: out, baselines: bl })); } catch { /* too large for storage: results stay in memory */ }
  }

  const lab = useMemo(() => (results.length ? analyseLab(results, { assetClass: scope }) : null), [results, scope]);
  const parity = results.reduce((s, r) => s + (r.parityMismatches ?? 0), 0);
  const afford = useMemo(() => (lab ? affordability(results.flatMap((r) => r.trades).filter((t) => t.v === lab.best.id)) : null), [lab, results]);
  const bench = baselines.find((b) => b.benchmark === (scope === "CRYPTO" ? "BTC-USD" : "SPY"));

  function download() {
    const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), results, baselines }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tradeswithme-lab-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <section className="exec-panel">
      <div className="exec-head">
        <div>
          <p className="exec-eyebrow">IMPROVEMENT LAB · 27 VARIANTS · SCORED VS THE BENCHMARK · HELD-OUT LAST YEAR</p>
          <h2>Can it be made to beat just holding? {lab && <em className={`exec-mode lab-${lab.verdict.verdict.toLowerCase()}`}>{VERDICT_LABEL[lab.verdict.verdict]}</em>}</h2>
        </div>
        <div className="exec-actions">
          {(["EQUITY", "CRYPTO", "ALL"] as const).map((s) => <button key={s} aria-pressed={scope === s} className={scope === s ? "exec-warn" : ""} onClick={() => setScope(s)} disabled={running}>{s === "ALL" ? "All" : s === "EQUITY" ? "Equities" : "Crypto"}</button>)}
          {results.length > 0 && <button onClick={download} disabled={running}>Download JSON</button>}
          <button className="exec-warn" onClick={() => void run()} disabled={running}>{running ? `Testing ${progress.done}/${progress.total}…` : "Run lab (all symbols)"}</button>
        </div>
      </div>
      <p className="exec-note">
        Re-makes the live decision for every past day, then tests 3 entry bars (strict = live, medium, loose) × 3 targets (1, 1.5, 2× risk) × 3 holding periods (5, 10, 20 days),
        with realistic costs and the V5.5 filters. Every trade is compared with holding {scope === "CRYPTO" ? "BTC" : "SPY"} over the same dates (“vs benchmark”).
        Variants are ranked on the years before the last 365 days only; the winner is then judged on that held-out year it never saw. Takes ~15–25 min.
      </p>

      {lab && <>
        <div className="lab-grid">
          <Stat label={`Best on training years · ${lab.best.id}`} s={lab.best.train} />
          <Stat label={`Same variant · held-out year`} s={lab.best.test} />
          <Stat label={`Live config (${LIVE_VARIANT}) · held-out year`} s={lab.live.test} />
          <div className="lab-stat">
            <span>Held-out year: bot vs simple strategies</span>
            <strong className={cls(lab.best.test.portfolioReturnPct - Math.max(bench?.buyHold.test.totalPct ?? 0, bench?.trend200.test.totalPct ?? 0))}>{pct(lab.best.test.portfolioReturnPct)}</strong>
            <small>{bench ? `hold ${bench.benchmark} ${pct(bench.buyHold.test.totalPct)} · ${bench.benchmark} above 200-day ${pct(bench.trend200.test.totalPct)}` : "baselines loading…"}</small>
          </div>
        </div>
        <ul className="exec-reasons">
          {lab.verdict.reasons.map((r) => <li key={r}><b>{r}</b></li>)}
          <li>Held-out year starts {lab.cutoff}. 95% range for the winner&apos;s per-trade edge vs benchmark: {lab.best.test.n ? `${pct(lab.best.test.alphaCi95[0])} to ${pct(lab.best.test.alphaCi95[1])}` : "—"} (if it includes 0, the edge isn&apos;t proven).</li>
          {bench && <li>Full period ({bench.start} → {bench.end}): hold {bench.benchmark} {pct(bench.buyHold.full.totalPct)} (worst drop {bench.buyHold.full.maxDrawdownPct}%) · 200-day trend filter {pct(bench.trend200.full.totalPct)} (worst drop {bench.trend200.full.maxDrawdownPct}%, invested {bench.trend200.full.exposurePct}% of days) · best variant portfolio {pct(lab.best.all.portfolioReturnPct)} (worst drop {lab.best.all.portfolioMaxDdPct}%).</li>}
          {afford && afford.equityTrades > 0 && <li>Sizing: at £50 split into 3 slots (${afford.slotUsd} each), {afford.unaffordablePct}% of this variant&apos;s stock trades can&apos;t buy one whole share. A cap of about £{afford.capFor90PctGbp} covers 90% of them, or use fractional shares (Alpaca allows them only as day orders, no brackets, so the stop would be re-placed each morning).</li>}
          <li className={parity ? "exec-neg" : ""}>Parity check: {parity === 0 ? "the lab's strict entry reproduced the live decision on every day tested." : `${parity} day(s) where the lab disagreed with the live decision — treat results with caution.`}</li>
        </ul>
        <div className="exec-table-wrap">
          <table className="exec-table">
            <thead><tr><th>Variant</th><th>Train trades</th><th>Train net</th><th>Train t</th><th>Test trades</th><th>Test net</th><th>Test vs bench</th><th>95% range vs bench</th><th>Test PF</th><th>Target/Stop/Time</th></tr></thead>
            <tbody>
              {[...lab.rows].sort((a, b) => b.train.tNet - a.train.tNet).map((v) => (
                <tr key={v.id} className={v.id === lab.best.id ? "lab-best" : v.id === LIVE_VARIANT ? "lab-live" : ""}>
                  <td><b>{v.id}</b>{v.id === lab.best.id ? " ★" : v.id === LIVE_VARIANT ? " (live)" : ""}</td>
                  <td>{v.train.n}</td>
                  <td className={cls(v.train.avgNetPct)}>{v.train.n ? pct(v.train.avgNetPct) : "—"}</td>
                  <td>{v.train.tNet}</td>
                  <td>{v.test.n}</td>
                  <td className={cls(v.test.avgNetPct)}>{v.test.n ? pct(v.test.avgNetPct) : "—"}</td>
                  <td className={cls(v.test.avgAlphaPct)}>{v.test.n ? pct(v.test.avgAlphaPct) : "—"}</td>
                  <td>{v.test.n > 1 ? `${pct(v.test.alphaCi95[0])} … ${pct(v.test.alphaCi95[1])}` : "—"}</td>
                  <td>{v.test.n ? v.test.profitFactor.toFixed(2) : "—"}</td>
                  <td>{v.all.targets}/{v.all.stops}/{v.all.timeExits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>}
      {errors.length > 0 && <ul className="exec-reasons">{errors.map((e) => <li key={e} className="exec-neg">{e}</li>)}</ul>}
    </section>
  );
}
