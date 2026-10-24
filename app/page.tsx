import Link from "next/link";
import { MarketingShell } from "@/components/site-chrome";
import WaitlistForm from "@/components/waitlist-form";
import { loadPublicTrackRecord } from "@/lib/server/public-stats";
import { siteConfig } from "@/lib/site";

export const dynamic = "force-dynamic";

function pct(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export default async function Home() {
  const site = siteConfig();
  const record = await loadPublicTrackRecord();
  const hasResults = record.available && record.completed > 0;

  return (
    <MarketingShell>
      <section className="mk-hero">
        <p className="mk-eyebrow">STOCKS + CRYPTO · DAILY RESEARCH · PUBLIC FORWARD LEDGER</p>
        <h1>Trading research that<br /><em>shows its losses.</em></h1>
        <p className="mk-lede">
          Every night an autonomous research desk scans stocks and crypto, freezes its best setups
          <strong> before the outcome is known</strong>, and scores them on later bars. Wins and losses go on a public
          ledger nobody can edit after the fact. You see the evidence first, then decide.
        </p>
        <div className="mk-hero-cta">
          <a className="mk-btn mk-btn-primary" href="#pricing">See plans</a>
          <Link className="mk-btn" href="/track-record">View the live ledger →</Link>
        </div>
      </section>

      <section className="mk-proof" aria-label="Forward ledger summary">
        <div><span>Settled calls</span><strong>{record.completed}</strong></div>
        <div><span>Win rate</span><strong>{hasResults ? `${record.winRatePct}%` : "—"}</strong></div>
        <div><span>Expectancy / call</span><strong>{hasResults ? pct(record.expectancyPct) : "—"}</strong></div>
        <div><span>Profit factor</span><strong>{hasResults ? record.profitFactor.toFixed(2) : "—"}</strong></div>
        <div><span>Open, not yet scored</span><strong>{record.pending}</strong></div>
        <p className="mk-proof-note">
          {hasResults
            ? `Net of trading costs. Trust band: ${record.trustBand.toLowerCase()} — a robust label needs ${record.minimumRobustSample}+ settled calls.`
            : "The ledger is live and accumulating. Calls settle on later completed bars, so early numbers are deliberately left blank rather than guessed."}
        </p>
      </section>

      <section id="how" className="mk-section">
        <h2>How it works</h2>
        <div className="mk-steps">
          <article><b>01</b><h3>Scan</h3><p>Up to 50 stocks, ETFs and crypto pairs. Every data feed is verified first; bad data fails closed.</p></article>
          <article><b>02</b><h3>Freeze</h3><p>Setups that clear strict evidence gates are timestamped and locked before the next bar exists.</p></article>
          <article><b>03</b><h3>Score</h3><p>Each call is settled at its target, its stop or its time limit — whichever comes first, after costs.</p></article>
          <article><b>04</b><h3>Learn, inside limits</h3><p>A bounded learner reweights its specialists from settled evidence only. It can never loosen risk rules.</p></article>
        </div>
      </section>

      <section className="mk-section mk-why">
        <h2>Why people trust a ledger over a guru</h2>
        <ul>
          <li><strong>No cherry-picking.</strong> Calls are frozen before results exist, and stops count as losses.</li>
          <li><strong>No hindsight.</strong> Ambiguous same-bar stop/target hits are scored as stops.</li>
          <li><strong>No hype.</strong> Too little data shows as “—”, not a made-up win rate.</li>
          <li><strong>No pressure.</strong> The public ledger stays free. Pay only if the evidence earns it.</li>
        </ul>
      </section>

      <section id="pricing" className="mk-section">
        <h2>Plans</h2>
        <p className="mk-sub">Founding prices are locked for life for the first {site.founderSeats} members.</p>
        <div className="mk-plans">
          {site.plans.map((plan) => (
            <article key={plan.id} className={`mk-plan${plan.highlight ? " mk-plan-hi" : ""}`}>
              {plan.highlight && <span className="mk-badge">Founding offer</span>}
              <h3>{plan.name}</h3>
              <p className="mk-price"><strong>{plan.price}</strong> <span>{plan.cadence}</span></p>
              <p className="mk-plan-blurb">{plan.blurb}</p>
              <ul>{plan.features.map((f) => <li key={f}>{f}</li>)}</ul>
              {plan.checkoutUrl ? (
                <a className={`mk-btn ${plan.highlight ? "mk-btn-primary" : ""}`} href={plan.checkoutUrl} rel="noopener">{plan.cta}</a>
              ) : (
                <WaitlistForm interest={plan.id} source="pricing" cta={plan.cta} />
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="mk-section mk-faq">
        <h2>Questions</h2>
        <details><summary>Is this financial advice?</summary><p>No. TradesWithMe is general, non-personalised research and an educational paper ledger. It does not know your circumstances and never places trades for you.</p></details>
        <details><summary>Does it guarantee profits?</summary><p>No. The whole point is to measure whether an edge exists, honestly. Some periods will lose. The ledger shows that too.</p></details>
        <details><summary>What is in the daily brief?</summary><p>The desk&apos;s ranked watchlist, the setups that cleared its evidence gates, near-miss candidates, the market regime and data-health status — the same research the owner reviews each morning.</p></details>
        <details><summary>Can I cancel?</summary><p>Yes, any time, from the link in your receipt email. Founding pricing ends if you cancel.</p></details>
        <details><summary>Who builds it?</summary><p>An independent UK-based engineer and programme manager, building in public with a forward ledger instead of screenshots.</p></details>
      </section>

      <section className="mk-section mk-final">
        <h2>Get the weekly results email</h2>
        <p>Every Monday: what was called, what settled, what it scored. Free.</p>
        <WaitlistForm interest="free" source="footer" cta="Send me results" />
      </section>
    </MarketingShell>
  );
}
