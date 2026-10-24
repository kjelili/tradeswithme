import type { Metadata } from "next";
import Link from "next/link";
import LegalPage from "@/components/legal-page";
import { siteConfig } from "@/lib/site";

export const metadata: Metadata = { title: "Terms", alternates: { canonical: "/terms" } };

export default function TermsPage() {
  const { contactEmail } = siteConfig();
  return (
    <LegalPage title="Terms of service" updated="24 October 2026">
      <h2>1. What we provide</h2>
      <p>TradesWithMe provides general, non-personalised market research, a public paper-traded forward ledger and, for paying members, a research email brief. For paid desk-setup orders we deploy and configure the TradesWithMe software on infrastructure you own.</p>
      <h2>2. Not advice</h2>
      <p>Content is for information and education only. It is not investment advice or a personal recommendation, and we do not execute trades for you. You are solely responsible for your own decisions. Read the <Link href="/risk">risk warning</Link>.</p>
      <h2>3. Subscriptions and payment</h2>
      <p>Paid plans are billed in advance through our payment provider (Stripe). Subscriptions renew until cancelled; you can cancel at any time from your receipt email and keep access until the end of the paid period. Founding prices apply while your subscription stays active.</p>
      <h2>4. Refunds</h2>
      <p>If you are unhappy within 14 days of your first payment, email us and we will refund it. One-off setup fees are refundable in full until work starts.</p>
      <h2>5. Acceptable use</h2>
      <p>Paid briefs are for your personal use. Please do not resell or republish them.</p>
      <h2>6. Liability</h2>
      <p>To the extent permitted by law, we are not liable for trading losses or for decisions made using our content. Nothing in these terms limits liability that cannot be limited under UK law.</p>
      <h2>7. Contact</h2>
      <p><a href={`mailto:${contactEmail}`}>{contactEmail}</a>. These terms are governed by the law of England and Wales.</p>
    </LegalPage>
  );
}
