import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/site-chrome";
import WaitlistForm from "@/components/waitlist-form";
import { loadPublicTrackRecord } from "@/lib/server/public-stats";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Public forward track record",
  description: "Every settled TradesWithMe research call — wins and losses — frozen before the outcome was known and scored after costs.",
  alternates: { canonical: "/track-record" },
};

const OUTCOME_LABEL: Record<string, string> = { TARGET: "Target hit", STOP: "Stopped out", TIME_EXIT: "Time exit" };

export default async function TrackRecordPage() {
  const r = await loadPublicTrackRecord();
  const hasResults = r.available && r.completed > 0;

  return (
    <MarketingShell>
      <section className="mk-hero mk-hero-sm">
        <p className="mk-eyebrow">FORWARD LEDGER · SETTLED CALLS ONLY</p>
        <h1>Public track record</h1>
        <p className="mk-lede">
          Each row was frozen by the desk before the next price bar existed, then settled at its target, stop or
          time limit, with a round-trip trading cost deducted. Open calls are hidden until they settle; members see them live.
        </p>
      </section>

      <section className="mk-proof" aria-label="Summary">
        <div><span>Settled</span><strong>{r.completed}</strong></div>
        <div><span>Wins / losses</span><strong>{hasResults ? `${r.wins} / ${r.losses}` : "—"}</strong></div>
        <div><span>Win rate</span><strong>{hasResults ? `${r.winRatePct}%` : "—"}</strong></div>
        <div><span>Profit factor</span><strong>{hasResults ? r.profitFactor.toFixed(2) : "—"}</strong></div>
        <div><span>Max drawdown</span><strong>{hasResults ? `${r.maxDrawdownPct.toFixed(2)}%` : "—"}</strong></div>
        <p className="mk-proof-note">
          {r.available
            ? `${r.pending} call(s) open and waiting to settle. Trust band: ${r.trustBand.toLowerCase()}. Updated ${new Date(r.updatedAt).toUTCString()}.`
            : "Ledger data is temporarily unavailable. Please check back shortly."}
        </p>
      </section>

      <section className="mk-section">
        {r.settled.length ? (
          <div className="mk-table-wrap">
            <table className="mk-table">
              <thead><tr><th>Frozen</th><th>Symbol</th><th>Class</th><th>Outcome</th><th>Settled</th><th>Bars</th><th className="num">Net return</th></tr></thead>
              <tbody>
                {r.settled.map((s) => (
                  <tr key={`${s.symbol}-${s.entryDate}`}>
                    <td>{s.entryDate}</td>
                    <td><b>{s.symbol}</b></td>
                    <td>{s.assetClass === "CRYPTO" ? "Crypto" : "Equity"}</td>
                    <td>{OUTCOME_LABEL[s.outcome] ?? s.outcome}</td>
                    <td>{s.exitDate ?? "—"}</td>
                    <td>{s.barsHeld ?? "—"}</td>
                    <td className={`num ${s.returnPct >= 0 ? "mk-pos" : "mk-neg"}`}>{s.returnPct > 0 ? "+" : ""}{s.returnPct.toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mk-empty">No calls have settled yet. The first results appear after the desk&apos;s holding horizon passes — join the weekly email to get them.</p>
        )}
      </section>

      <section className="mk-section mk-final">
        <h2>See open calls before they settle</h2>
        <p>Founding members get the daily brief, including setups that are still live. <Link href="/#pricing">See plans</Link>.</p>
        <WaitlistForm interest="free" source="track-record" cta="Email me weekly results" />
      </section>
    </MarketingShell>
  );
}
