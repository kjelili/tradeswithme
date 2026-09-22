"use client";

import { useEffect, useMemo, useState } from "react";
import { DEFAULT_RISK_SETTINGS, DEFAULT_WATCHLIST, ENGINE } from "@/lib/engine/config";
import type { LearningObservatory, LearningPolicy, PositionInput, RiskSettings, ScanResult, StrategyLabResult, SymbolAnalysis, ValidationSummary } from "@/lib/engine/types";

const SETTINGS_KEY = "twm-v3-settings";
const WATCHLIST_KEY = "twm-v3-watchlist";
const POSITIONS_KEY = "twm-v3-positions";
const HISTORY_KEY = "twm-v3-scan-history";
const ACCESS_KEY = "twm-v3-access";

function money(value: number, digits = 0) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}
function pounds(value: number, digits = 2) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}
function pct(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}
function scoreText(value: number) { return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`; }
function priceMoney(value: number) { return money(value, value < 1 ? 4 : 2); }
function sourceText(source: string) { return source === "YAHOO_CHART_DAILY" ? "YAHOO DAILY" : source === "STOOQ_EOD" ? "STOOQ BACKUP" : source === "KRAKEN_CRYPTO_DAILY" ? "KRAKEN DAILY" : "FALLBACK"; }
function healthClass(status: string) { return `health-${status.toLowerCase()}`; }
function unitsText(value: number, crypto: boolean) { return crypto ? value.toLocaleString("en-US", { maximumFractionDigits: 6 }) : value.toLocaleString("en-US", { maximumFractionDigits: 0 }); }
function actionClass(action: string) { return `action-${action.toLowerCase().replaceAll("_", "-")}`; }
function trustClass(band: string) { return `trust-${band.toLowerCase()}`; }

function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

export default function Dashboard() {
  const [settings, setSettings] = useState<RiskSettings>(DEFAULT_RISK_SETTINGS);
  const [watchlist, setWatchlist] = useState<string[]>(DEFAULT_WATCHLIST);
  const [positions, setPositions] = useState<PositionInput[]>([]);
  const [history, setHistory] = useState<ScanResult[]>([]);
  const [accessCode, setAccessCode] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [validation, setValidation] = useState<ValidationSummary | null>(null);
  const [learning, setLearning] = useState<LearningPolicy | null>(null);
  const [observatory, setObservatory] = useState<LearningObservatory | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState("SPY");
  const [lab, setLab] = useState<StrategyLabResult | null>(null);
  const [running, setRunning] = useState(false);
  const [labRunning, setLabRunning] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [validationLoading, setValidationLoading] = useState(false);
  const [learningLoading, setLearningLoading] = useState(false);
  const [observatoryLoading, setObservatoryLoading] = useState(false);
  const [ownerSyncing, setOwnerSyncing] = useState(false);
  const [error, setError] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [newQty, setNewQty] = useState("");
  const [newAvg, setNewAvg] = useState("");

  useEffect(() => {
    setSettings({ ...DEFAULT_RISK_SETTINGS, ...loadJson(SETTINGS_KEY, DEFAULT_RISK_SETTINGS) });
    setWatchlist(loadJson(WATCHLIST_KEY, DEFAULT_WATCHLIST));
    setPositions(loadJson(POSITIONS_KEY, []));
    setHistory(loadJson(HISTORY_KEY, []));
    setAccessCode(window.sessionStorage.getItem(ACCESS_KEY) ?? "");
  }, []);

  useEffect(() => { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }, [settings]);
  useEffect(() => { window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist)); }, [watchlist]);
  useEffect(() => { window.localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions)); }, [positions]);
  useEffect(() => { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 12))); }, [history]);
  useEffect(() => { if (accessCode) window.sessionStorage.setItem(ACCESS_KEY, accessCode); else window.sessionStorage.removeItem(ACCESS_KEY); }, [accessCode]);
  useEffect(() => {
    if (!accessCode.trim()) return;
    const timer = window.setTimeout(() => { void loadObservatory(true); }, 700);
    return () => window.clearTimeout(timer);
    // The observatory is read-only here; scans/training run server-side on schedule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessCode]);

  const selected = useMemo(() => scan?.analyses.find((a) => a.symbol === selectedSymbol) ?? scan?.analyses[0] ?? null, [scan, selectedSymbol]);
  const priceMap = useMemo(() => new Map(scan?.analyses.map((a) => [a.symbol, a.indicators.close]) ?? []), [scan]);
  const exposure = positions.reduce((sum, p) => sum + Math.max(0, p.qty) * (priceMap.get(p.symbol) ?? p.avgPrice), 0);
  const exposurePct = settings.accountSize > 0 ? exposure / settings.accountSize * 100 : 0;
  const overnight = scan?.overnightPlan;
  const morning = overnight?.morningCandidates ?? [];
  const activeValidation = validation ?? scan?.validation ?? null;
  const activeLearning = learning ?? scan?.learning ?? null;

  async function loadObservatory(silent = false) {
    setObservatoryLoading(true);
    if (!silent) setError("");
    try {
      const response = await fetch("/api/observatory", { headers: { "x-tradeswithme-access": accessCode } });
      const data = await response.json();
      if (!response.ok) {
        if (silent && response.status === 401) return;
        throw new Error(data.error ?? "Learning Observatory load failed.");
      }
      setObservatory(data.observatory as LearningObservatory);
      setLearning(data.learning as LearningPolicy);
      setValidation(data.validation as ValidationSummary);
      const latest = data.latestScan as ScanResult | null;
      if (latest) {
        setScan(latest);
        setHistory((old) => [latest, ...old].filter((item, index, all) => all.findIndex((x) => x.at === item.at) === index).slice(0, 12));
        if (!latest.analyses.some((a) => a.symbol === selectedSymbol) && latest.analyses[0]) setSelectedSymbol(latest.analyses[0].symbol);
      }
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : "Learning Observatory load failed.");
    } finally { setObservatoryLoading(false); }
  }

  async function syncOwnerState() {
    setOwnerSyncing(true); setError("");
    try {
      const response = await fetch("/api/owner-state", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tradeswithme-access": accessCode },
        body: JSON.stringify({ symbols: watchlist, positions, settings }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Automation settings sync failed.");
      await loadObservatory(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Automation settings sync failed."); }
    finally { setOwnerSyncing(false); }
  }

  async function runScan() {
    setRunning(true); setError("");
    try {
      const response = await fetch("/api/market/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tradeswithme-access": accessCode },
        body: JSON.stringify({ symbols: watchlist, positions, settings }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Market scan failed.");
      const result = data as ScanResult;
      setScan(result);
      if (result.validation) setValidation(result.validation);
      if (result.learning) setLearning(result.learning);
      setHistory((old) => [result, ...old].filter((item, index, all) => all.findIndex((x) => x.at === item.at) === index).slice(0, 12));
      if (!result.analyses.some((a) => a.symbol === selectedSymbol) && result.analyses[0]) setSelectedSymbol(result.analyses[0].symbol);
    } catch (e) { setError(e instanceof Error ? e.message : "Market scan failed."); }
    finally { setRunning(false); }
  }

  async function loadValidation() {
    setValidationLoading(true); setError("");
    try {
      const response = await fetch("/api/validation", { headers: { "x-tradeswithme-access": accessCode } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Validation load failed.");
      setValidation(data as ValidationSummary);
    } catch (e) { setError(e instanceof Error ? e.message : "Validation load failed."); }
    finally { setValidationLoading(false); }
  }


  async function trainLearning() {
    setLearningLoading(true); setError("");
    try {
      const response = await fetch("/api/learning", { method: "POST", headers: { "x-tradeswithme-access": accessCode } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Adaptive learning run failed.");
      setLearning(data.policy as LearningPolicy);
      await loadValidation();
    } catch (e) { setError(e instanceof Error ? e.message : "Adaptive learning run failed."); }
    finally { setLearningLoading(false); }
  }

  async function loadOvernightHistory() {
    setHistoryLoading(true); setError("");
    try {
      const response = await fetch("/api/history", { headers: { "x-tradeswithme-access": accessCode } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "History load failed.");
      if (!data.configured) { setError("Supabase is not configured yet; overnight scans and the forward ledger cannot persist between Vercel runs."); return; }
      const serverScans = (data.scans ?? []) as ScanResult[];
      const merged = [...serverScans, ...history].filter((item, index, all) => all.findIndex((x) => x.at === item.at) === index).sort((a,b) => b.at.localeCompare(a.at)).slice(0, 12);
      setHistory(merged);
      if (serverScans[0]) { setScan(serverScans[0]); setSelectedSymbol(serverScans[0].analyses[0]?.symbol ?? selectedSymbol); }
    } catch (e) { setError(e instanceof Error ? e.message : "History load failed."); }
    finally { setHistoryLoading(false); }
  }

  async function runLab(symbol: string) {
    setLabRunning(true); setError("");
    try {
      const response = await fetch("/api/strategy-lab", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tradeswithme-access": accessCode },
        body: JSON.stringify({ symbol }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Strategy Lab failed.");
      setLab(data as StrategyLabResult);
    } catch (e) { setError(e instanceof Error ? e.message : "Strategy Lab failed."); }
    finally { setLabRunning(false); }
  }

  function addHolding() {
    const symbol = newSymbol.trim().toUpperCase();
    const qty = Number(newQty); const avgPrice = Number(newAvg);
    if (!/^[A-Z0-9.-]{1,12}$/.test(symbol) || qty <= 0 || avgPrice <= 0) { setError("Enter a valid symbol, quantity, and average price."); return; }
    setPositions((old) => [...old.filter((p) => p.symbol !== symbol), { symbol, qty, avgPrice }]);
    if (!watchlist.includes(symbol)) setWatchlist((old) => [...old, symbol].slice(0, ENGINE.maxSymbolsPerScan));
    setNewSymbol(""); setNewQty(""); setNewAvg(""); setError("");
  }

  function updateWatchlist(raw: string) {
    const values = raw.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.-]{1,12}$/.test(s));
    setWatchlist([...new Set(values)].slice(0, ENGINE.maxSymbolsPerScan));
  }

  function resetPersonalData() {
    setSettings(DEFAULT_RISK_SETTINGS); setWatchlist(DEFAULT_WATCHLIST); setPositions([]); setHistory([]); setScan(null); setLab(null); setValidation(null); setLearning(null); setObservatory(null);
    [SETTINGS_KEY, WATCHLIST_KEY, POSITIONS_KEY, HISTORY_KEY].forEach((key) => window.localStorage.removeItem(key));
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-wrap"><div className="logo-mark"><span>T</span></div><div><div className="brand">TRADES<span>WITHME</span></div><div className="tagline">AUTONOMOUS LEARNING · V4.1.4</div></div></div>
        <div className="header-actions"><span className="status-pill"><i /> PERSONAL MODE</span><span className="mode-pill">OVERNIGHT PAPER · £50 HARD CAP</span></div>
      </header>

      <section className="hero-row">
        <div><p className="eyebrow">AUTONOMOUS LEARNING OBSERVATORY · DAILY SCAN · FORWARD VALIDATION · DRIFT CONTROL · STOCKS + CRYPTO</p><h1>Prove the edge<br/><em>before risking capital.</em></h1><p className="hero-copy">V4.1.4 runs the research loop for you: each scheduled cycle settles mature observations, retrains the bounded learner, scans verified markets with the fresh policy, and freezes new evidence for future scoring. Safety gates and the £50 paper-only cap remain outside the learner.</p></div>
        <div className="command-card">
          <label>Personal access code <small>Required only when APP_ACCESS_CODE is configured in Vercel.</small><input type="password" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="••••••••••" /></label>
          <button className="run-btn" onClick={() => void loadObservatory()} disabled={observatoryLoading}>{observatoryLoading ? "Refreshing observatory…" : "Refresh autonomous desk"}</button>
          <div className="command-foot"><span>{scan ? `Latest autonomous scan ${new Date(scan.at).toLocaleString()}` : "Enter access code to load latest run"}</span><span>{scan ? `${scan.dataHealth?.equity?.status === "UNAVAILABLE" ? "EQUITY DATA GATE" : scan.regime} / ${scan.dataHealth?.crypto?.status === "UNAVAILABLE" ? "CRYPTO DATA GATE" : scan.cryptoRegime}` : "REGIMES —"}</span></div>
          {error && <div className="error-box">{error}</div>}
        </div>
      </section>

      <section className="metric-grid v3-metrics">
        <article className="metric-card"><span>Forward trust</span><strong className={activeValidation ? trustClass(activeValidation.trustBand) : ""}>{activeValidation?.configured ? `${activeValidation.trustScore}/100` : "—"}</strong><small>{activeValidation?.configured ? `${activeValidation.trustBand} · ${activeValidation.completed} completed` : "Configure Supabase to accumulate proof"}</small></article>
        <article className="metric-card"><span>Account size</span><strong>{money(settings.accountSize)}</strong><small>{exposurePct.toFixed(1)}% currently represented in holdings</small></article>
        <article className="metric-card"><span>Overnight paper</span><strong>{pounds(overnight?.allocatedGbp ?? 0)}</strong><small>of {pounds(Math.min(50, settings.overnightPaperBudgetGbp))} hard maximum</small></article>
        <article className="metric-card"><span>Market regimes</span><strong><span className={scan?.dataHealth?.equity?.status === "UNAVAILABLE" ? "regime-unknown" : `regime-${(scan?.regime ?? "mixed").toLowerCase()}`}>{scan?.dataHealth?.equity?.status === "UNAVAILABLE" ? "UNAVAILABLE" : scan?.regime ?? "—"}</span></strong><small>{scan?.dataHealth?.equity?.status === "UNAVAILABLE" ? "SPY data gate failed · no equity entries" : `Crypto: ${scan?.dataHealth?.crypto?.status === "UNAVAILABLE" ? "UNAVAILABLE" : scan?.cryptoRegime ?? "—"}`}</small></article>
      </section>

      <section className="panel health-panel">
        <div className="panel-head"><div><span className="section-kicker">DATA INTEGRITY</span><h2>Market data health</h2></div><span className="mini-tag">V4.1.4 FAIL-CLOSED</span></div>
        {!scan?.dataHealth ? <div className="empty-state mini">The autonomous cycle verifies every upstream feed before the decision engine is allowed to act.</div> : <div className="health-grid">
          <HealthCard name="US equities + ETFs" item={scan.dataHealth.equity} />
          <HealthCard name="Crypto" item={scan.dataHealth.crypto} />
          <HealthCard name="GBP/USD" item={scan.dataHealth.fx} />
          <HealthCard name="Earnings events" item={scan.dataHealth.events} />
          <div className="health-card"><span>Forward ledger</span><strong className={healthClass(activeValidation?.configured ? "HEALTHY" : "UNAVAILABLE")}>{activeValidation?.configured ? "CONNECTED" : "UNAVAILABLE"}</strong><small>{activeValidation?.configured ? `${activeValidation.completed} completed · ${activeValidation.pending} pending` : "Supabase forward validation is not connected."}</small></div>
        </div>}
      </section>


      <section className="panel observatory-panel">
        <div className="panel-head"><div><span className="section-kicker">LEARNING OBSERVATORY</span><h2>Autonomous settle → train → scan pipeline</h2></div><button className="ghost-btn" onClick={() => void loadObservatory()} disabled={observatoryLoading}>{observatoryLoading ? "Refreshing…" : "Refresh observatory"}</button></div>
        {!observatory ? <div className="empty-state compact">Enter your personal access code once. The server-side schedule runs independently of this browser.</div> : <ObservatoryDesk observatory={observatory} />}
      </section>

      <section className="panel learning-panel">
        <div className="panel-head"><div><span className="section-kicker">ADAPTIVE LEARNING</span><h2>Self-training research engine</h2></div><span className="mini-tag">AUTOMATIC</span></div>
        {!activeLearning ? <div className="empty-state compact">The learner updates automatically after mature observations are settled. It trains only on predictions frozen before outcomes were known.</div> : <LearningDesk learning={activeLearning} />}
      </section>

      <section className="panel validation-panel">
        <div className="panel-head"><div><span className="section-kicker">CAN I TRUST THIS SYSTEM?</span><h2>Forward validation ledger</h2></div><button className="ghost-btn" onClick={() => void loadValidation()} disabled={validationLoading}>{validationLoading ? "Reconciling…" : "Refresh validation"}</button></div>
        {!activeValidation ? <div className="empty-state compact">The autonomous cycle freezes BUY_SETUP signals before outcomes are known and evaluates them on later completed bars.</div> : <ValidationDesk validation={activeValidation} />}
      </section>

      <section className="overnight-grid">
        <article className="panel">
          <div className="panel-head"><div><span className="section-kicker">WHILE I SLEEP</span><h2>£50 evidence-gated paper desk</h2></div><span className="mini-tag">NO LIVE ORDERS</span></div>
          {!overnight ? <div className="empty-state compact">The next autonomous cycle will build the overnight paper plan.</div> : <div className="overnight-body">
            <div className="budget-bar"><div><span>Allocated</span><strong>{pounds(overnight.allocatedGbp)}</strong></div><div><span>Cash left</span><strong>{pounds(overnight.remainingGbp)}</strong></div><div><span>GBP/USD reference</span><strong>{overnight.fx.rate.toFixed(4)}</strong><small>{overnight.fx.source}</small></div></div>
            {!overnight.orders.length ? <div className="empty-state mini">No candidate cleared all V4.1.4 evidence, event, data-quality, learning and diversification gates. Cash stays unallocated.</div> : <div className="overnight-orders">{overnight.orders.map((o) => <div className="overnight-order" key={o.symbol}><div><b>{o.symbol}</b><small>{o.assetClass} · evidence {o.evidenceScore}/100</small></div><span><small>Paper allocation</small><b>{pounds(o.notionalGbp)}</b></span><span><small>Units</small><b>{unitsText(o.units, o.assetClass === "CRYPTO")}</b></span><span><small>Confidence</small><b>{o.confidence}%</b></span><p>{o.rationale}</p></div>)}</div>}
            <p className="safety-note">V4.1.4 will not spend simply because budget exists. It can leave all £50 idle. This remains a paper allocation until you separately decide to place a real order.</p>
          </div>}
        </article>

        <article className="panel">
          <div className="panel-head"><div><span className="section-kicker">WHEN I WAKE UP</span><h2>Ranked manual-review queue</h2></div><span className="mini-tag">RECHECK FIRST</span></div>
          {!morning.length ? <div className="empty-state compact">Additional candidates appear here after autonomous scans.</div> : <div className="morning-list">{morning.map((c) => <button className="morning-row" key={c.symbol} onClick={() => setSelectedSymbol(c.symbol)}><b>#{c.rank}</b><span><strong>{c.symbol}</strong><small>{c.assetClass} · {c.eventRisk}</small></span><span><small>Evidence</small><strong>{c.evidenceScore}/100</strong></span><span><small>Score / confidence</small><strong>{scoreText(c.score)} · {c.confidence}%</strong></span>{c.correlationWarning && <em>{c.correlationWarning}</em>}</button>)}</div>}
        </article>
      </section>

      <section className="workspace-grid">
        <article className="panel">
          <div className="panel-head"><div><span className="section-kicker">EVIDENCE RANKING</span><h2>Current research candidates</h2></div><span className="mini-tag">{scan?.analyses.length ?? 0} ASSETS</span></div>
          {!scan ? <div className="empty-state">The autonomous cycle ranks your watchlist daily.</div> : <div className="scan-list">{scan.analyses.map((a) => <button key={a.symbol} className={`scan-row v3-scan-row ${selected?.symbol === a.symbol ? "selected" : ""}`} onClick={() => setSelectedSymbol(a.symbol)}><span className="symbol-cell"><b>{a.symbol}</b><small>{a.assetClass} · {sourceText(a.source)}</small></span><span><b>{priceMoney(a.indicators.close)}</b><small className={(a.indicators.changePct ?? 0) >= 0 ? "up" : "down"}>{pct(a.indicators.changePct, 2)}</small></span><span className="evidence-cell"><b>{a.evidence.score}/100</b><i><em style={{ width: `${a.evidence.score}%` }} /></i><small>{a.evidence.band} · data {a.dataQuality.grade}</small></span><span><b>{a.eventRisk.level}</b><small>{a.correlationRisk.status} correlation</small></span><span className={`action-pill ${actionClass(a.action)}`}>{a.action.replace("_", " ")}</span></button>)}</div>}
        </article>

        <article className="panel detail-panel">
          <div className="panel-head"><div><span className="section-kicker">DECISION DESK</span><h2>{selected ? `${selected.symbol} evidence thesis` : "Select a symbol"}</h2></div>{selected && <button className="ghost-btn" onClick={() => void runLab(selected.symbol)} disabled={labRunning}>{labRunning ? "Testing…" : "Run Strategy Lab"}</button>}</div>
          {!selected ? <div className="empty-state compact">Select a ranked symbol after scanning.</div> : <DecisionDesk analysis={selected} />}
        </article>
      </section>

      <section className="bottom-grid">
        <article className="panel">
          <div className="panel-head"><div><span className="section-kicker">MY RISK RULES</span><h2>Personal guardrails</h2></div><div className="panel-actions"><button className="ghost-btn" onClick={() => void syncOwnerState()} disabled={ownerSyncing}>{ownerSyncing ? "Syncing…" : "Sync for automation"}</button><button className="ghost-btn" onClick={resetPersonalData}>Reset local data</button></div></div>
          <div className="settings-grid">
            <NumberSetting label="Account size" value={settings.accountSize} min={1000} step={1000} onChange={(v) => setSettings({ ...settings, accountSize: v })} />
            <NumberSetting label="Risk / trade %" value={settings.riskPerTradePct} min={0.05} max={2} step={0.05} onChange={(v) => setSettings({ ...settings, riskPerTradePct: v })} />
            <NumberSetting label="Max position %" value={settings.maxPositionPct} min={1} max={30} step={1} onChange={(v) => setSettings({ ...settings, maxPositionPct: v })} />
            <NumberSetting label="Max exposure %" value={settings.maxPortfolioExposurePct} min={5} max={100} step={5} onChange={(v) => setSettings({ ...settings, maxPortfolioExposurePct: v })} />
            <NumberSetting label="Target reward:risk" value={settings.rewardRiskTarget} min={1} max={5} step={0.25} onChange={(v) => setSettings({ ...settings, rewardRiskTarget: v })} />
            <NumberSetting label="ATR stop multiple" value={settings.atrStopMultiple} min={0.5} max={5} step={0.1} onChange={(v) => setSettings({ ...settings, atrStopMultiple: v })} />
            <NumberSetting label="Overnight paper budget £" value={settings.overnightPaperBudgetGbp} min={0} max={50} step={5} onChange={(v) => setSettings({ ...settings, overnightPaperBudgetGbp: Math.max(0, Math.min(50, v)) })} />
          </div>
          <div className="watchlist-editor"><label>Watchlist · max {ENGINE.maxSymbolsPerScan} · crypto format BTC-USD<input value={watchlist.join(", ")} onChange={(e) => updateWatchlist(e.target.value)} /></label></div>
        </article>

        <article className="panel">
          <div className="panel-head"><div><span className="section-kicker">MY POSITIONS</span><h2>Correlation-aware exposure</h2></div><span className="mini-tag">SYNCED ON SCAN</span></div>
          <div className="holding-form"><input placeholder="AAPL" value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} /><input type="number" step="any" placeholder="Qty" value={newQty} onChange={(e) => setNewQty(e.target.value)} /><input type="number" step="any" placeholder="Avg price" value={newAvg} onChange={(e) => setNewAvg(e.target.value)} /><button onClick={addHolding}>Add holding</button></div>
          {!positions.length ? <div className="empty-state mini">Add holdings so V4.1.4 can measure candidate correlation against exposure you already own. Use “Sync for automation” after changing holdings so the scheduled cycle uses them.</div> : <div className="holdings">{positions.map((p) => { const last = priceMap.get(p.symbol) ?? p.avgPrice; const pnl = p.qty * (last - p.avgPrice); return <div className="holding-row" key={p.symbol}><b>{p.symbol}</b><span>{p.qty} units</span><span>{money(last, 2)}</span><span className={pnl >= 0 ? "up" : "down"}>{pnl >= 0 ? "+" : ""}{money(pnl)}</span><button onClick={() => setPositions((old) => old.filter((x) => x.symbol !== p.symbol))}>×</button></div>; })}</div>}
        </article>
      </section>

      <section className="panel lab-panel">
        <div className="panel-head"><div><span className="section-kicker">STRATEGY LAB</span><h2>Out-of-sample + rolling walk-forward validation</h2></div><span className="mini-tag">NO SINGLE-PERIOD HEROES</span></div>
        {!lab ? <div className="empty-state compact">Choose a symbol above and run Strategy Lab. V4.1.4 checks the held-out tail and multiple rolling forward windows.</div> : <StrategyLab lab={lab} />}
      </section>

      <section className="panel memory-panel">
        <div className="panel-head"><div><span className="section-kicker">SCAN MEMORY</span><h2>Recent personal + overnight scans</h2></div><button className="ghost-btn" onClick={() => void loadOvernightHistory()} disabled={historyLoading}>{historyLoading ? "Loading…" : "Load overnight"}</button></div>
        {!history.length ? <div className="empty-state mini">Manual scans stay in this browser. Supabase persists scheduled scans and the forward-validation ledger.</div> : <div className="memory-list">{history.slice(0, 6).map((item) => <div className="memory-row" key={item.at}><time>{new Date(item.at).toLocaleString()}</time><b>{item.regime}</b><span>{item.analyses[0]?.symbol ?? "—"} {item.analyses[0] ? `${item.analyses[0].evidence?.score ?? "—"}/100` : ""}</span><small>{item.analyses.filter((a) => a.action === "BUY_SETUP").length} setups</small></div>)}</div>}
      </section>

      {scan?.warnings?.length ? <section className="warning-strip"><b>Validation / data warnings</b>{scan.warnings.map((w, i) => <span key={i}>{w}</span>)}</section> : null}
      <footer><p>TradesWithMe V4.1.4 is a personal adaptive research, forward-validation and risk-planning tool. The £50 overnight feature is paper-only and does not place broker orders. The learner may reweight research agents and calibrate confidence, but it cannot change the £50 cap, risk rules, data/event gates or place live orders. A high evidence, learning or trust score is not a promise of profit.</p><span>TRADESWITHME.COM · V4.1.4 SETTLEMENT + GATE OBSERVATORY BUILD</span></footer>
    </main>
  );
}

function HealthCard({ name, item }: { name: string; item: { status: string; verified: number; total: number; primary: string; detail: string; asOf: string | null } }) {
  return <div className="health-card"><span>{name}</span><strong className={healthClass(item.status)}>{item.status}</strong><b>{item.primary}</b><small>{item.detail}</small><em>{item.asOf ? `As of ${item.asOf}` : "No verified timestamp"} · {item.verified}/{item.total} verified</em></div>;
}


function ObservatoryDesk({ observatory }: { observatory: LearningObservatory }) {
  if (!observatory.configured) return <div className="validation-warning">Supabase is not configured. Run the V4.1.4 schema so autonomous runs, pending observations and training history can persist.</div>;
  const last = observatory.lastRun;
  return <div className="observatory-body">
    <div className="observatory-stats">
      <div><span>Automation</span><strong className={last?.status === "FAILED" ? "down" : "up"}>{last?.status ?? "WAITING"}</strong><small>{last ? `last run ${new Date(last.ranAt).toLocaleString()}` : "no scheduled run logged yet"}</small>{last?.detail ? <small className={last.status === "FAILED" ? "down" : ""}>{last.detail}</small> : null}</div>
      <div><span>Next scheduled cycle</span><strong>{new Date(observatory.nextScheduledAt).toLocaleString()}</strong><small>{observatory.cadence}</small></div>
      <div><span>Actionable ledger</span><strong>{observatory.actionableCompleted} done · {observatory.actionablePending} pending</strong><small>counts toward Forward Trust</small></div>
      <div><span>Shadow ledger</span><strong>{observatory.shadowCompleted} done · {observatory.shadowPending} pending</strong><small>0.5× learning weight; never inflates trust</small></div>
      <div><span>Effective learning samples</span><strong>{observatory.effectiveCompletedSamples.toFixed(1)}</strong><small>learner progresses without browser interaction</small></div>
    </div>
    <div className="observatory-grid">
      <div>
        <div className="subhead">PENDING MATURITY QUEUE</div>
        {!observatory.pending.length ? <p className="muted-copy">No frozen observations are waiting to mature yet. The next qualifying autonomous scan can add them.</p> : <div className="maturity-table">
          <div className="maturity-head"><span>Type</span><span>Symbol</span><span>Verified bars</span><span>Status</span><span>Market data</span></div>
          {observatory.pending.slice(0, 12).map((o) => <div className="maturity-row" key={`${o.kind}-${o.id}`}><span>{o.kind === "ACTIONABLE" ? "LIVE TEST" : "SHADOW"}</span><b>{o.symbol}</b><span>{o.estimatedBarsElapsed}/{o.horizonBars}</span><span className={o.maturityStatus === "DUE" ? "up" : ""}>{o.maturityStatus}</span><span>{o.marketDataAsOf ?? "—"}</span></div>)}
        </div>}
      </div>
      <div>
        <div className="subhead">RECENT AUTONOMOUS RUNS</div>
        {!observatory.recentRuns.length ? <p className="muted-copy">The Vercel cron has not logged a V4.1.4 cycle yet. The first run is scheduled automatically.</p> : <div className="automation-run-list">{observatory.recentRuns.slice(0, 6).map((run) => <div className="automation-run" key={run.id}><div><b className={run.status === "FAILED" ? "down" : "up"}>{run.status}</b><small>{new Date(run.ranAt).toLocaleString()}</small>{run.detail ? <small className={run.status === "FAILED" ? "down" : ""}>{run.detail}</small> : null}</div><span>settled {run.actionableSettled + run.shadowSettled}</span><span>frozen {run.actionableInserted + run.shadowInserted}</span><span>{run.learningMode ?? "—"} · {run.effectiveSamples ?? 0} eff.</span></div>)}</div>}
      </div>
    </div>
    {observatory.tradeGate ? <div className="trade-gate-observatory">
      <div className="subhead">TRADE GATE OBSERVATORY</div>
      <div className="trade-gate-summary">
        <div><span>Scanned</span><strong>{observatory.tradeGate.scanned}</strong></div>
        <div><span>BUY_SETUP</span><strong className={observatory.tradeGate.buySetups > 0 ? "up" : ""}>{observatory.tradeGate.buySetups}</strong></div>
        <div><span>WATCH</span><strong>{observatory.tradeGate.watches}</strong></div>
        <div><span>AVOID</span><strong>{observatory.tradeGate.avoids}</strong></div>
      </div>
      {!observatory.tradeGate.topBlockers.length ? <p className="muted-copy">No trade blockers were recorded in the latest autonomous scan.</p> : <div className="trade-gate-list">{observatory.tradeGate.topBlockers.map((b) => <div className="trade-gate-row" key={b.reason}><b>{b.reason.replaceAll("_", " ")}</b><span>{b.count} assets</span><span>{b.pct.toFixed(1)}%</span></div>)}</div>}
      <p className="muted-copy">This panel explains why candidates did not become actionable setups. It is diagnostic only; V4.1.4 does not lower safety thresholds automatically.</p>
    </div> : null}
    <div className="lab-notes">{observatory.notes.map((note) => <p key={note}>• {note}</p>)}{observatory.ownerStateUpdatedAt && <p>• Automation settings last synced {new Date(observatory.ownerStateUpdatedAt).toLocaleString()}.</p>}</div>
  </div>;
}

function LearningDesk({ learning }: { learning: LearningPolicy }) {
  const segment = learning.segments.GLOBAL;
  return <div className="learning-body">
    <div className="learning-stats">
      <div><span>Mode</span><strong className={`learn-${learning.mode.toLowerCase()}`}>{learning.mode}</strong><small>{learning.effectiveSampleCount.toFixed(1)}/{learning.minimumAdaptiveSample} effective · {learning.actionableSamples} actionable + {learning.shadowSamples} shadow</small></div>
      <div><span>Policy version</span><strong>v{learning.version}</strong><small>{learning.trainedAt.startsWith("1970") ? "baseline only" : new Date(learning.trainedAt).toLocaleString()}</small></div>
      <div><span>Confidence calibration</span><strong>{learning.confidenceAdjustmentPct >= 0 ? "+" : ""}{learning.confidenceAdjustmentPct.toFixed(1)} pts</strong><small>bounded; only active in ADAPTIVE mode</small></div>
      <div><span>Drift score</span><strong className={learning.driftScore >= 70 ? "down" : "up"}>{learning.driftScore.toFixed(0)}/100</strong><small>{learning.driftScore >= 70 ? "adaptive policy frozen" : "no material drift freeze"}</small></div>
      <div><span>Recent expectancy</span><strong className={(learning.recentExpectancyPct ?? 0) >= 0 ? "up" : "down"}>{learning.recentExpectancyPct == null ? "—" : pct(learning.recentExpectancyPct, 2)}</strong><small>last 20 completed learning observations</small></div>
    </div>
    <div className="learning-grid">
      <div><div className="subhead">GLOBAL STRATEGY WEIGHTS</div><div className="learning-agent-table">{segment.agents.map((a) => <div className="learning-agent-row" key={a.id}><div><b>{a.name}</b><small>{a.observations} observations · reliability {a.reliabilityScore.toFixed(0)}/100</small></div><span><small>base</small><b>{(a.baseWeight * 100).toFixed(0)}%</b></span><span><small>learned</small><b>{(a.learnedWeight * 100).toFixed(1)}%</b></span><span><small>directional edge</small><b className={a.avgDirectionalReturnPct >= 0 ? "up" : "down"}>{pct(a.avgDirectionalReturnPct, 2)}</b></span></div>)}</div></div>
      <div className="learning-segments"><div className="subhead">SEGMENT MEMORY</div>{([learning.segments.EQUITY, learning.segments.CRYPTO] as const).map((s) => <div className="learning-segment" key={s.key}><b>{s.key}</b><span>{s.sampleCount} completed</span><span>{s.winRatePct.toFixed(1)}% win</span><span className={s.avgReturnPct >= 0 ? "up" : "down"}>{pct(s.avgReturnPct, 2)} expectancy</span></div>)}<p>V4.1.4 uses shrinkage toward the original weights. It does not let a small lucky sample take over the ensemble.</p></div>
    </div>
    <div className="lab-notes">{learning.notes.map((note) => <p key={note}>• {note}</p>)}<p>• A newly trained policy affects the next scan; current displayed candidates may have been scored by the previously stored policy.</p></div>
  </div>;
}

function ValidationDesk({ validation }: { validation: ValidationSummary }) {
  if (!validation.configured) return <div className="validation-body"><div className="validation-warning">Supabase is not configured. Run the V4.1.4 schema migration and add the two Supabase environment variables so signals can be frozen and scored over time.</div>{validation.notes.map((n) => <p className="validation-note" key={n}>• {n}</p>)}</div>;
  return <div className="validation-body">
    <div className="validation-stats">
      <div><span>Trust score</span><strong className={trustClass(validation.trustBand)}>{validation.trustScore}/100</strong><small>{validation.trustBand}</small></div>
      <div><span>Completed / pending</span><strong>{validation.completed} / {validation.pending}</strong><small>minimum robust sample {validation.minimumRobustSample}</small></div>
      <div><span>Win rate</span><strong>{pct(validation.winRatePct)}</strong><small>{validation.wins} wins · {validation.losses} non-wins</small></div>
      <div><span>Expectancy</span><strong className={validation.expectancyPct >= 0 ? "up" : "down"}>{pct(validation.expectancyPct, 2)}</strong><small>average after modeled costs</small></div>
      <div><span>Profit factor</span><strong>{validation.profitFactor.toFixed(2)}</strong><small>gross gains ÷ gross losses</small></div>
      <div><span>Sequence max DD</span><strong>{validation.maxDrawdownPct.toFixed(1)}%</strong><small>equal-weight signal sequence</small></div>
    </div>
    <div className="validation-grid">
      <div><div className="subhead">RECENT FROZEN SIGNALS</div>{!validation.recent.length ? <p className="muted-copy">No forward signals yet. BUY_SETUPs are added on future scans.</p> : <div className="ledger-table"><div className="ledger-head"><span>Symbol</span><span>Opened</span><span>Evidence</span><span>Outcome</span><span>Return</span></div>{validation.recent.slice(0, 10).map((s) => <div className="ledger-row" key={s.id}><b>{s.symbol}</b><span>{s.entryDate}</span><span>{s.evidenceScore}/100</span><span>{s.outcome}</span><span className={(s.returnPct ?? 0) >= 0 ? "up" : "down"}>{s.returnPct == null ? "pending" : pct(s.returnPct, 2)}</span></div>)}</div>}</div>
      <div><div className="subhead">AGENT FORWARD SCOREBOARD</div>{!validation.agents.length ? <p className="muted-copy">Agents need completed forward signals before this scoreboard becomes meaningful.</p> : <div className="agent-scoreboard">{validation.agents.map((a) => <div className="agent-score-row" key={a.id}><div><b>{a.name}</b><small>{a.status} · {a.completedSignals} completed</small></div><span>{pct(a.avgReturnPct, 2)}</span><span>{a.winRatePct.toFixed(0)}% win</span></div>)}</div>}</div>
    </div>
    <div className="lab-notes">{validation.notes.map((note) => <p key={note}>• {note}</p>)}</div>
  </div>;
}

function DecisionDesk({ analysis }: { analysis: SymbolAnalysis }) {
  const p = analysis.tradePlan;
  return <div className="decision-body">
    <div className="evidence-banner"><div><span>Evidence</span><strong>{analysis.evidence.score}/100</strong><small>{analysis.evidence.band}</small></div><div><span>Walk-forward</span><strong>{analysis.evidence.walkForwardStability}/100</strong><small>best validated strategy</small></div><div><span>Data quality</span><strong>{analysis.dataQuality.grade}</strong><small>{analysis.dataQuality.score}/100</small></div><div><span>Event risk</span><strong>{analysis.eventRisk.level}</strong><small>{analysis.eventRisk.eventDate ?? analysis.eventRisk.source}</small></div><div><span>Correlation</span><strong>{analysis.correlationRisk.status}</strong><small>{analysis.correlationRisk.correlatedWith ? `${analysis.correlationRisk.correlatedWith} ${analysis.correlationRisk.maxCorrelation?.toFixed(2)}` : "no held peer"}</small></div></div>
    <p className="evidence-rationale">{analysis.evidence.rationale}</p>
    <div className="decision-summary"><div><span>Agent score</span><strong>{scoreText(analysis.score)}</strong></div><div><span>Evidence confidence</span><strong>{analysis.confidence}%</strong></div><div><span>20D return</span><strong>{pct(analysis.indicators.return20Pct)}</strong></div><div><span>RSI 14</span><strong>{analysis.indicators.rsi14?.toFixed(0) ?? "—"}</strong></div><div><span>20D vol</span><strong>{pct(analysis.indicators.realizedVol20Pct)}</strong></div><div><span>ATR</span><strong>{analysis.indicators.atr14 ? money(analysis.indicators.atr14, 2) : "—"}</strong></div></div>
    <div className="ticket"><div className="ticket-head"><span>HUMAN-APPROVED ORDER PLAN</span><b className={actionClass(analysis.action)}>{analysis.action.replace("_", " ")}</b></div><div className="ticket-grid"><label>Entry<strong>{priceMoney(p.entry)}</strong></label><label>Stop<strong>{p.stop ? priceMoney(p.stop) : "—"}</strong></label><label>Target<strong>{p.target ? priceMoney(p.target) : "—"}</strong></label><label>{analysis.assetClass === "CRYPTO" ? "Units" : "Shares"}<strong>{unitsText(p.suggestedShares, analysis.assetClass === "CRYPTO")}</strong></label><label>Notional<strong>{money(p.suggestedNotional)}</strong></label><label>Max planned loss<strong>{money(p.accountRiskDollars)}</strong></label></div><p>{p.invalidation}</p></div>
    <div className="strategy-state-row"><div className="subhead">STRATEGY STATES</div>{Object.entries(analysis.strategyStates).map(([id,state]) => <span className={`strategy-state state-${state.toLowerCase()}`} key={id}>{id}: {state}</span>)}</div>
    <div className="votes"><div className="subhead">AGENT DEBATE</div>{analysis.votes.map((vote) => <div className="vote-row" key={vote.id}><span>{vote.name}</span><b className={vote.score >= 0 ? "up" : "down"}>{scoreText(vote.score)}</b><div><i><em style={{ width: `${Math.min(100, Math.abs(vote.score) * 100)}%` }} /></i><small>{vote.rationale}</small></div></div>)}</div>
  </div>;
}

function NumberSetting({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max?: number; step: number; onChange: (v: number) => void }) {
  return <label>{label}<input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} /></label>;
}

function StrategyLab({ lab }: { lab: StrategyLabResult }) {
  return <div className="lab-body">
    <div className="lab-callout v3-lab-callout"><div><span>Symbol</span><b>{lab.symbol}</b></div><div><span>Held-out winner</span><b>{lab.winner.name}</b></div><div><span>Walk-forward winner</span><b>{lab.validationWinner.name}</b></div><div><span>Stability</span><b>{lab.validationWinner.stabilityScore}/100</b></div><div><span>State</span><b>{lab.validationWinner.state}</b></div><div><span>Source</span><b>{sourceText(lab.source)}</b></div></div>
    <div className="subhead">ROLLING WALK-FORWARD STABILITY</div>
    <div className="wf-table"><div className="wf-head"><span>Strategy</span><span>State</span><span>Positive folds</span><span>Median return</span><span>Median relative</span><span>Median Sharpe</span><span>Worst DD</span><span>Stability</span></div>{lab.validation.map((v) => <div className="wf-row" key={v.id}><b>{v.name}</b><span className={`state-text-${v.state.toLowerCase()}`}>{v.state}</span><span>{v.positiveFolds}/{v.folds}</span><span className={v.medianReturnPct >= 0 ? "up" : "down"}>{pct(v.medianReturnPct)}</span><span>{pct(v.medianRelativeReturnPct)}</span><span>{v.medianSharpe.toFixed(2)}</span><span>{v.worstDrawdownPct.toFixed(1)}%</span><span><b>{v.stabilityScore}</b>/100</span></div>)}</div>
    <div className="subhead">FINAL 25% HELD-OUT CHECK</div>
    <div className="lab-table"><div className="lab-head"><span>Strategy</span><span>Return</span><span>Benchmark</span><span>Sharpe</span><span>Max DD</span><span>Trades</span><span>Exposure</span></div>{lab.outOfSample.map((m) => <div className="lab-row" key={m.id}><b>{m.name}</b><span className={m.totalReturnPct >= 0 ? "up" : "down"}>{pct(m.totalReturnPct)}</span><span>{pct(m.benchmarkReturnPct)}</span><span>{m.sharpe.toFixed(2)}</span><span>{m.maxDrawdownPct.toFixed(1)}%</span><span>{m.trades}</span><span>{m.exposurePct.toFixed(0)}%</span></div>)}</div>
    <div className="lab-notes">{lab.notes.map((note) => <p key={note}>• {note}</p>)}</div>
  </div>;
}
