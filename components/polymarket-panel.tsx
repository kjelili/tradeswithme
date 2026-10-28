"use client";

import { useCallback, useEffect, useState } from "react";
import type { WalletSkill } from "@/lib/engine/wallet-skill";

const ACCESS_KEY = "twm-v3-access";
type Flow = { title: string; outcomeIndex: number; buyers: number; usdc: number; avgPrice: number; lastTs: number };
type Data = { state: { startedAt: string; windowStart: number; splitTs: number; total: number; remaining: number; flowAt: string | null } | null; wallets: WalletSkill[]; flow: Flow[]; error?: string };

function code() { try { return window.sessionStorage.getItem(ACCESS_KEY) ?? ""; } catch { return ""; } }
const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const VCLS: Record<string, string> = { "SKILL — HELD OUT": "exec-pos", "LUCK / NOT SIGNIFICANT": "exec-neg" };

export default function PolymarketPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const load = useCallback(async () => {
    try { const r = await fetch("/api/polymarket", { headers: { "x-tradeswithme-access": code() } }); setData(await r.json() as Data); }
    catch (e) { setData({ state: null, wallets: [], flow: [], error: e instanceof Error ? e.message : "Load failed." }); }
  }, []);
  useEffect(() => { if (code()) void load(); }, [load]);

  async function act(action: "start" | "continue") {
    setBusy(action); setMsg(null);
    try {
      const r = await fetch("/api/polymarket", { method: "POST", headers: { "Content-Type": "application/json", "x-tradeswithme-access": code() }, body: JSON.stringify({ action }) });
      const j = await r.json() as { error?: string; done?: number; remaining?: number; queued?: number };
      setMsg(j.error ?? `${j.queued ? `Queued ${j.queued} wallets. ` : ""}Analysed ${j.done ?? 0}; ${j.remaining ?? 0} left (the 15-minute job keeps going).`);
      await load();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Scan failed."); } finally { setBusy(null); }
  }

  const ws = data?.wallets ?? [];
  const counts = ws.reduce<Record<string, number>>((a, w) => { a[w.verdict] = (a[w.verdict] ?? 0) + 1; return a; }, {});
  const shown = all ? ws : ws.filter((w) => w.verdict === "SKILL — HELD OUT" || w.verdict === "SKILL? NOT CONFIRMED").concat(ws.filter((w) => w.verdict === "LUCK / NOT SIGNIFICANT").slice(0, 10));
  const st = data?.state;
  return (
    <section className="exec-panel">
      <div className="exec-head">
        <div>
          <p className="exec-eyebrow">POLYMARKET · TOP WALLETS · LAST 120 DAYS · READ-ONLY (UK IS CLOSE-ONLY)</p>
          <h2>Who has an edge that isn&apos;t luck?</h2>
        </div>
        <div className="exec-actions">
          {!data && <button onClick={() => void load()}>Load</button>}
          <button onClick={() => void act("start")} disabled={!!busy}>{busy === "start" ? "Fetching leaderboards…" : "New 120-day scan"}</button>
          {st && st.remaining > 0 && <button onClick={() => void act("continue")} disabled={!!busy}>{busy === "continue" ? "Analysing…" : `Continue (${st.remaining} left)`}</button>}
        </div>
      </div>
      <p className="exec-note">
        A Polymarket price is a probability, so the honest luck test is: if a trader knew nothing, each position wins as often as the price they paid. Each wallet&apos;s real P&amp;L is compared with 3,000 no-skill replays,
        corrected for testing {ws.length || "many"} wallets at once (Benjamini–Hochberg), and must <b>also</b> beat luck in the final third of the window, which the first test never saw. Market makers (splits/merges) are excluded.
      </p>
      {data?.error && <p className="exec-err">{data.error}</p>}
      {msg && <p className="exec-note"><b>{msg}</b></p>}
      {st && <p className="exec-note">Scan {st.startedAt.slice(0, 10)} · window {day(st.windowStart)} → today · held-out from {day(st.splitTs)} · {st.total - st.remaining}/{st.total} wallets · {Object.entries(counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(" · ")}</p>}
      {ws.length > 0 && (
        <div className="exec-table-wrap">
          <table className="exec-table">
            <thead><tr><th>Wallet</th><th>Verdict</th><th>Markets</th><th>Win rate</th><th>Paid for (implied)</th><th>ROI</th><th>P&amp;L $</th><th title="Chance a no-skill trader matches this P&L">P(luck)</th><th>q (FDR)</th><th>Held-out ROI</th><th>Top market share</th><th>Median bet $</th><th title="Correlation of bet size with result: >0 means bigger bets on winners">Sizing skill</th><th>Hours before close</th><th>Style</th></tr></thead>
            <tbody>{shown.map((w) => (
              <tr key={w.wallet} title={w.reasons.join(" ")}>
                <td><a href={`https://polymarket.com/profile/${w.wallet}`} target="_blank" rel="noopener noreferrer"><b>{w.name || short(w.wallet)}</b></a></td>
                <td className={VCLS[w.verdict] ?? ""}>{w.verdict}</td>
                <td>{w.markets}</td><td>{w.winRatePct}%</td><td>{w.impliedWinRatePct}%</td>
                <td className={w.roiPct > 0 ? "exec-pos" : "exec-neg"}>{w.roiPct}%</td><td>{w.pnl.toLocaleString()}</td>
                <td>{w.pLuck < 1 ? w.pLuck : "—"}</td><td>{w.qValue ?? "—"}</td>
                <td>{w.lateRoiPct == null ? "—" : `${w.lateRoiPct}% (${w.lateMarkets})`}</td>
                <td>{w.largestShareOfPnlPct}%</td><td>{w.medianBetUsd.toLocaleString()}</td><td>{w.sizeSkillCorr ?? "—"}</td>
                <td>{w.medianHoursBeforeEnd ?? "—"}</td><td>{w.style}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {ws.length > 0 && <p className="exec-note"><button className="rb-link" onClick={() => setAll((x) => !x)}>{all ? "Show skilled + top 10 lucky" : `Show all ${ws.length}`}</button> · Hover a row for the reasons.</p>}
      {(data?.flow?.length ?? 0) > 0 && (
        <div className="alloc-detail">
          <h3>Smart-money flow — what edge-confirmed wallets bought in the last 3 days</h3>
          <ul className="exec-reasons">{data!.flow.slice(0, 15).map((f) => <li key={f.title + f.outcomeIndex}><b>{f.buyers} wallet{f.buyers > 1 ? "s" : ""}</b> · ${f.usdc.toLocaleString()} at {Math.round(f.avgPrice * 100)}¢ · outcome #{f.outcomeIndex} of “{f.title}”</li>)}</ul>
          <p className="exec-note">Fed to the Betfair event agent as context when a market matches. Signals, not instructions — and they lag: these wallets already bought.</p>
        </div>
      )}
      <ul className="exec-reasons">
        <li>Why most “top wallets” fail: the leaderboard is selected on profit, so it is full of lucky streaks and single big calls. Copying them after the fact also pays a worse price than they got.</li>
        <li>Polymarket lists the UK as close-only — you can&apos;t open positions there, so this panel is research only (no VPN workarounds). Trades go through the UK-regulated Betfair Exchange below.</li>
      </ul>
    </section>
  );
}
