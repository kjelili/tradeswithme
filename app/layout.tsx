import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./marketing.css";

const siteUrl = "https://tradeswithme.com";
const title = "TradesWithMe — Trading research with a public forward ledger";
const description = "Daily stock and crypto research from an autonomous desk. Every call is frozen before the outcome is known and scored after costs on a public ledger — wins and losses.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: title, template: "%s | TradesWithMe" },
  description,
  alternates: { canonical: "/" },
  icons: { icon: "/tradeswithme-mark.svg" },
  openGraph: { title, description, url: siteUrl, siteName: "TradesWithMe", type: "website", locale: "en_GB" },
  twitter: { card: "summary", title, description },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en-GB"><body>{children}</body></html>;
}
