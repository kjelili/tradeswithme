import Link from "next/link";
import type { ReactNode } from "react";
import { siteConfig } from "@/lib/site";

export function SiteHeader() {
  return (
    <header className="mk-header">
      <Link href="/" className="mk-brand" aria-label="TradesWithMe home">
        <span className="mk-logo">T</span>
        <span>TRADES<b>WITHME</b></span>
      </Link>
      <nav className="mk-nav" aria-label="Main">
        <Link href="/track-record">Track record</Link>
        <Link href="/#how">How it works</Link>
        <Link href="/#pricing">Pricing</Link>
        <Link href="/desk" className="mk-nav-desk">Owner desk</Link>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  const { contactEmail } = siteConfig();
  return (
    <footer className="mk-footer">
      <p className="mk-disclaimer">
        TradesWithMe publishes general, non-personalised market research and a paper-traded forward ledger for
        educational purposes. It is not investment advice, a recommendation, or an offer to buy or sell any asset.
        Past and paper performance does not predict future results. Trading stocks and crypto can lose you all of your money.
      </p>
      <div className="mk-footer-row">
        <span>© {new Date().getFullYear()} TradesWithMe</span>
        <nav aria-label="Legal">
          <Link href="/risk">Risk warning</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <a href={`mailto:${contactEmail}`}>Contact</a>
        </nav>
      </div>
    </footer>
  );
}

export function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className="mk">
      <SiteHeader />
      <main className="mk-main">{children}</main>
      <SiteFooter />
    </div>
  );
}
