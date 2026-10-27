"use client";

import { useEffect, useMemo, useState } from "react";
import { DEFAULT_WATCHLIST } from "@/lib/engine/config";
import { applyFilters, chanceOfProfit, fillQuality, simulatePortfolio, statsFor, verdictFor, REALISTIC_COSTS, LEDGER_COSTS, type ReplayFilters, type ReplaySymbolResult, type ReplayTrade, type ReplayStats } from "@/lib/engine/replay-stats";
import FanChart from "@/components/fan-chart";

const ACCESS_KEY = "twm-v3-access";
const RESULTS_KEY = "twm-replay-results";
const CONCURRENCY = 3;

type CostMode = "realistic" | "ledger";

function withCosts(trades: ReplayTrade[], mode: CostMode) {
  const c = mode === "realistic" ? REALISTIC_COSTS : LEDGER_COSTS;
  return trades.map((t) => ({ ...t, netPct: t.grossPct - (t.assetClass === "CRYPTO" ? c.cryptoRoundTripBps : c.equityRoundTripBps) / 100 }));
}

function loadSaved(): ReplaySymbolResult[] {
  try { const raw = window.localStorage.getItem(RESULTS_KEY); return raw ? JSON.parse(raw) as ReplaySymbolResult[] : []; } catch { return []; }
}

function StatRow({ label, s }: { label: string; s: ReplayStats }) {
  return (
    <tr>
      <td><b>{label}</b></td><td>{s.trades}</td><td>{s.winRatePct}%</td>
      <td className={s.avgNetPct > 0 ? "exec-pos" : "exec-neg"}>{s.avgNetPct.toFixed(2)}%</td>
      <td>{s.profitFactor.toFixed(2)}</td><td>{s.maxDrawdownPct.toFixed(1)}%</td>
      <td>{s.targets}/{s.stops}/{s.timeExits}</td>
    </tr>
  );
}

function EquityCurve({ curve }: { curve: Array<{ date: string; equity: number }> }) {
  const [hover, setHover] = useState<number | null>(null);
  if (curve.length < 2) return null;
  const W = 640, H = 160, P = 8;
  const values = [1, ...curve.map((p) => p.equity)];
  const min = Math.min(...values), max = Math.max(...values);
  const x = (i: number) => P + (i / (curve.length - 1)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - min) / Math.max(1e-9, max - min)) * (H - 2 * P);
  const path = curve.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ");
  const h = hover != null ? curve[hover] : null;
  return (
    <figure className="replay-curve">
      <figcaption>Portfolio equity (3 slots, after selected costs) — start = 1.00</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Replay portfolio equity curve"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const rel = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(curve.length - 1, Math.round(((rel - P) / (W - 2 * P)) * (curve.length - 1)))));
        }}>
        <line x1={P} x2={W - P} y1={y(1)} y2={y(1)} className="replay-base" />
        <path d={path} className="replay-line" />
        {h && hover != null && <>
          <line x1={x(hover)} x2={x(hover)} y1={P} y2={H - P} className="replay-cross" />
          <circle cx={x(hover)} cy={y(h.equity)} r={4} className="replay-dot" />
        </>}
      </svg>
      <div className="replay-tip" aria-live="polite">{h ? `${h.date} · ${h.equity.toFixed(3)}` : `${curve[0].date} → ${curve.at(-1)!.date} · final ${curve.at(-1)!.equity.toFixed(3)}`}</div>
    </figure>
  );
}

export default function ReplayPanel() {
  const [results, setResults] = useState<ReplaySymbolResult[]>([]);
  useEffect(() => { setResults(loadSaved()); }, []);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [errors, setErrors] = useState<string[]>([]);
  const [costMode, setCostMode] = useState<CostMode>("realistic");
  const [filters, setFilters] = useState<ReplayFilters>({ edgeGate: true, chaseFilter: true });

  async function run() {
    let code = "";
    try { code = window.sessionStorage.getItem(ACCESS_KEY) ?? ""; } catch { /* ignore */ }
    const symbols = [...DEFAULT_WATCHLIST];
    setRunning(true); setErrors([]); setResults([]); setProgress({ done: 0, total: symbols.length, current: "" });
    const out: ReplaySymbolResult[] = [];
    const errs: string[] = [];
    let next = 0;
    async function worker() {
      while (next < symbols.length) {
        const symbol = symbols[next++];
        setProgress((p) => ({ ...p, current: symbol }));
        try {
          const response = await fetch("/api/replay", { method: "POST", headers: { "Content-Type": "application/json", "x-tradeswithme-access": code }, body: JSON.stringify({ symbol }) });
          const json = await response.json() as ReplaySymbolResult & { error?: string };
          if (!response.ok || json.error) errs.push(`${symbol}: ${json.error ?? response.status}`);
          else { out.push(json); setResults([...out]); }
        } catch (error) {
          errs.push(`${symbol}: ${error instanceof Error ? error.message : "failed"}`);
        }
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setErrors(errs);
    setRunning(false);
    try { window.localStorage.setItem(RESULTS_KEY, JSON.stringify(out)); } catch { /* storage full or blocked */ }
  }

  const view = useMemo(() => {
    const raw = withCosts(results.flatMap((r) => r.trades), costMode);
    // What the bot would actually trade = executable trades that pass the V5.5 filters.
    const all = applyFilters(raw, filters);
    const eq = all.filter((t) => t.assetClass === "EQUITY");
    const cr = all.filter((t) => t.assetClass === "CRYPTO");
    const ledger = results.flatMap((r) => r.ledgerTrades);
    const s = statsFor(all);
    const blockedEdge = raw.filter((t) => t.edgePass === false).length;
    const blockedChase = raw.filter((t) => t.chased).length;
    return {
      all: s, unfiltered: statsFor(raw), eq: statsFor(eq), cr: statsFor(cr), ledger: statsFor(ledger),
      blockedByFilters: statsFor(raw.filter((t) => !all.includes(t))),
      blockedEdge, blockedChase,
      verdict: verdictFor(s), portfolio: simulatePortfolio(all), withNet: all,
      fills: fillQuality(results),
      fan: chanceOfProfit(all.map((t) => t.netPct)),
    };
  }, [results, costMode, filters]);

  function download() {
    const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), costMode, results }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tradeswithme-replay-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const span = results.length ? `${results.map((r) => r.firstDecision ?? "").filter(Boolean).sort()[0]} → ${results.map((r) => r.lastDecision ?? "").sort().at(-1)}` : "";

  return (
    <section className="exec-panel">
      <div className="exec-head">
        <div>
          <p className="exec-eyebrow">HISTORICAL TRADE REPLAY · SAME DECISION CODE AS LIVE</p>
          <h2>Would it have made money? {results.length > 0 && <em className={`exec-mode replay-${view.verdict.verdict.toLowerCase()}`}>{view.verdict.verdict.replace("_", " ")}</em>}</h2>
        </div>
        <div className="exec-actions">
          <button onClick={() => setCostMode(costMode === "realistic" ? "ledger" : "realistic")} disabled={running}>Costs: {costMode === "realistic" ? "realistic" : "ledger (0.16%)"}</button>
          <button onClick={() => setFilters({ ...filters, edgeGate: !filters.edgeGate })} disabled={running} aria-pressed={filters.edgeGate}>Edge gate: {filters.edgeGate ? "on" : "off"}</button>
          <button onClick={() => setFilters({ ...filters, chaseFilter: !filters.chaseFilter })} disabled={running} aria-pressed={filters.chaseFilter}>Chase filter: {filters.chaseFilter ? "on" : "off"}</button>
          {results.length > 0 && <button onClick={download} disabled={running}>Download JSON</button>}
          <button className="exec-warn" onClick={() => void run()} disabled={running}>{running ? `Replaying ${progress.done}/${progress.total}…` : "Run replay (all symbols)"}</button>
        </div>
      </div>
      <p className="exec-note">
        Replays every past day with only the bars available that day, applies the live BUY_SETUP + overnight gates, then simulates the orders the executor places
        (Alpaca bracket limit; Kraken post-only limit 0.2% below market + broker stop, target/time checked daily; gaps fill at the open). Realistic costs = the real-money gate's: crypto 1.25% round trip (Kraken tier-1 0.40% maker in, 0.80% taker out, + slippage), equities 0.10%.
        Not modelled: earnings blocks, correlation to holdings, learned weights. Takes ~10–20 min.
        {running && progress.current ? ` Now: ${progress.current}.` : ""}
      </p>
      {results.length > 0 && <>
        <ul className="exec-reasons">
          <li><b>{span}</b> · {results.reduce((s, r) => s + r.decisionsEvaluated, 0).toLocaleString()} symbol-days evaluated · {results.reduce((s, r) => s + r.signals, 0)} entry signals</li>
          {view.verdict.reasons.map((r) => <li key={r}>{r}</li>)}
          <li>Portfolio (max 3 positions): {view.portfolio.taken} trades taken · return {view.portfolio.finalReturnPct}% · max drawdown {view.portfolio.maxDrawdownPct}%</li>
          <li>Filters removed {view.blockedByFilters.trades} trade(s) (edge gate {view.blockedEdge}, chase {view.blockedChase}); the removed trades averaged <b className={view.blockedByFilters.avgNetPct > 0 ? "exec-pos" : "exec-neg"}>{view.blockedByFilters.trades ? `${view.blockedByFilters.avgNetPct.toFixed(2)}%` : "—"}</b>. Negative means the filters saved money. Approximate: a refused trade would also have freed the symbol for a re-entry.</li>
          {view.fills.attempts > 0 && <li>Kraken maker entries: {view.fills.fillRatePct}% filled ({view.fills.missed} of {view.fills.attempts} missed). Missed trades as market buys would have averaged <b className={view.fills.avgMissedNetAtTakerPct > 0 ? "exec-pos" : "exec-neg"}>{view.fills.avgMissedNetAtTakerPct.toFixed(2)}%</b> after 1.65% taker costs ({view.fills.missedWinners} winners missed).</li>}
        </ul>
        <div className="exec-table-wrap">
          <table className="exec-table">
            <thead><tr><th>Set</th><th>Trades</th><th>Win</th><th>Avg net</th><th>PF</th><th>Max DD</th><th>Target/Stop/Time</th></tr></thead>
            <tbody>
              <StatRow label="Bot trades (filters applied)" s={view.all} />
              <StatRow label="Without V5.5 filters" s={view.unfiltered} />
              <StatRow label="Equities" s={view.eq} />
              <StatRow label="Crypto" s={view.cr} />
              <StatRow label="Ledger rule (close entry, 0.16%)" s={view.ledger} />
            </tbody>
          </table>
        </div>
        <EquityCurve curve={view.portfolio.curve} />
        {view.fan ? <FanChart fan={view.fan} title="Chance of profit — next 100 bot trades (bootstrapped from these replay trades)" /> : <p className="exec-note">Chance-of-profit needs at least 10 replay trades.</p>}
        <div className="exec-table-wrap">
          <table className="exec-table">
            <thead><tr><th>Symbol</th><th>Days</th><th>Signals</th><th>Trades</th><th>Win</th><th>Avg net</th><th>PF</th><th>Buy &amp; hold</th><th>Max score</th></tr></thead>
            <tbody>
              {[...results].sort((a, b) => b.trades.length - a.trades.length || a.symbol.localeCompare(b.symbol)).map((r) => {
                const s = statsFor(view.withNet.filter((t) => t.symbol === r.symbol));
                return (
                  <tr key={r.symbol} title={r.skipped ?? ""}>
                    <td><b>{r.symbol}</b></td><td>{r.decisionsEvaluated}</td><td>{r.signals}</td><td>{s.trades}</td>
                    <td>{s.trades ? `${s.winRatePct}%` : "—"}</td>
                    <td className={s.avgNetPct > 0 ? "exec-pos" : s.trades ? "exec-neg" : ""}>{s.trades ? `${s.avgNetPct.toFixed(2)}%` : "—"}</td>
                    <td>{s.trades ? s.profitFactor.toFixed(2) : "—"}</td>
                    <td>{r.skipped ? r.skipped : `${r.buyHoldPct}%`}</td>
                    <td>{r.maxDecisionScore >= 0 ? r.maxDecisionScore.toFixed(2) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>}
      {errors.length > 0 && <ul className="exec-reasons">{errors.map((e) => <li key={e} className="exec-neg">{e}</li>)}</ul>}
    </section>
  );
}
