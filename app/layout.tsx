import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const siteUrl = "https://tradeswithme.com";
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "TradesWithMe V5.2 — Discovery & Governance", template: "%s | TradesWithMe" },
  description: "A personal autonomous trading research desk with forward validation, bounded learning, quant robustness, prediction-market context, crypto flow intelligence, live Kraken microstructure research and a £50 paper-only overnight cap.",
  alternates: { canonical: "/" },
  icons: { icon: "/tradeswithme-mark.svg" },
  openGraph: { title: "TradesWithMe V5.2 — Discovery & Governance", description: "Research-only strategy discovery, Pareto governance, failure replay, agent interference auditing, quant intelligence and forward-validated paper trading safeguards.", url: siteUrl, siteName: "TradesWithMe", type: "website" },
};
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
