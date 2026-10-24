import type { Metadata } from "next";
import LegalPage from "@/components/legal-page";

export const metadata: Metadata = { title: "Risk warning", alternates: { canonical: "/risk" } };

export default function RiskPage() {
  return (
    <LegalPage title="Risk warning" updated="24 October 2026">
      <p><strong>Trading stocks, ETFs and cryptoassets is high risk. You can lose all of the money you put in.</strong></p>
      <p>TradesWithMe publishes general market research and a paper-traded forward ledger. It is not personalised, does not take your circumstances into account, and is not a recommendation to buy, sell or hold any asset. Nothing on this site is investment, tax or legal advice.</p>
      <p>Cryptoassets are largely unregulated in the UK. You are unlikely to be protected if something goes wrong, and you are unlikely to have access to the Financial Ombudsman Service or the Financial Services Compensation Scheme.</p>
      <p>Forward-ledger results are paper results. They deduct an estimated trading cost but do not capture every real-world spread, slippage, tax or market-impact effect. Past or paper performance is not a reliable indicator of future results.</p>
      <p>Only trade with money you can afford to lose. If you are unsure whether an investment is right for you, speak to an independent adviser authorised by the Financial Conduct Authority.</p>
    </LegalPage>
  );
}
