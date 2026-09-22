import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const siteUrl = "https://tradeswithme.com";
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "TradesWithMe V4.1.4 — Autonomous Learning Observatory", template: "%s | TradesWithMe" },
  description: "A personal autonomous trading research desk that schedules its own daily scan, settles frozen outcomes, retrains bounded strategy weights, monitors learning maturity and drift, and maintains a £50 paper-only overnight cap.",
  alternates: { canonical: "/" },
  icons: { icon: "/tradeswithme-mark.svg" },
  openGraph: { title: "TradesWithMe V4.1.4 — Autonomous Learning Observatory", description: "Autonomous settle → train → scan cycles with a Learning Observatory, bounded adaptive weights, drift control, verified data and evidence-gated paper planning.", url: siteUrl, siteName: "TradesWithMe", type: "website" },
};
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
