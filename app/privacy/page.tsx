import type { Metadata } from "next";
import LegalPage from "@/components/legal-page";
import { siteConfig } from "@/lib/site";

export const metadata: Metadata = { title: "Privacy", alternates: { canonical: "/privacy" } };

export default function PrivacyPage() {
  const { contactEmail } = siteConfig();
  return (
    <LegalPage title="Privacy notice" updated="24 October 2026">
      <h2>What we collect</h2>
      <p>Your email address and which plan you are interested in, when you sign up. If you pay, Stripe processes your payment details; we never see or store your card number.</p>
      <h2>Why</h2>
      <p>To send the emails you asked for, to run your subscription, and to answer your messages. Our lawful bases are consent (emails) and contract (paid plans).</p>
      <h2>Where it is stored</h2>
      <p>Sign-ups are stored in our Supabase database; the site is hosted on Vercel; payments are handled by Stripe. We do not sell your data or use advertising trackers.</p>
      <h2>How long</h2>
      <p>Until you unsubscribe or ask us to delete it, and for as long as tax law requires for payment records.</p>
      <h2>Your rights</h2>
      <p>You can ask for a copy of your data, a correction, or deletion at any time: <a href={`mailto:${contactEmail}`}>{contactEmail}</a>. You can also complain to the Information Commissioner&apos;s Office (ico.org.uk).</p>
    </LegalPage>
  );
}
