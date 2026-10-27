// Commercial configuration. Every value is env-driven so pricing and checkout
// links can change in Vercel without a code release.

function env(name: string, fallback = "") {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function safeUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export type Plan = {
  id: "free" | "founder" | "setup" | "audit";
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  features: string[];
  cta: string;
  checkoutUrl: string;
  highlight?: boolean;
};

export function siteConfig() {
  const founderLink = safeUrl(env("STRIPE_FOUNDER_LINK"));
  const setupLink = safeUrl(env("STRIPE_SETUP_LINK"));
  const auditLink = safeUrl(env("STRIPE_AUDIT_LINK"));
  const founderSeats = Number.parseInt(env("FOUNDER_SEATS", "100"), 10) || 100;

  const plans: Plan[] = [
    {
      id: "free",
      name: "Public ledger",
      price: "£0",
      cadence: "forever",
      blurb: "See every settled call, wins and losses, before you pay anything.",
      features: [
        "Public forward track record",
        "Weekly results email",
        "Methodology and safety notes",
      ],
      cta: "Get the weekly email",
      checkoutUrl: "",
    },
    {
      id: "audit",
      name: "Strategy audit",
      price: env("AUDIT_PRICE", "£99"),
      cadence: "one-off",
      blurb: "Find out if your trading rules actually beat just holding the index — before you risk more money.",
      features: [
        "Your rules replayed on 3+ years of real prices",
        "Realistic broker fees and gap fills",
        "Scored against holding the index on the same dates",
        "Judged on a held-out year it never saw",
        "Plain-English verdict in 5 working days",
      ],
      cta: auditLink ? "Book a strategy audit" : "Request a strategy audit",
      checkoutUrl: auditLink,
      highlight: true,
    },
    {
      id: "founder",
      name: "Founding member",
      price: env("FOUNDER_PRICE", "£19"),
      cadence: "per month",
      blurb: `Monthly rules-based allocation signals and the full research lab. Price locked for the first ${founderSeats} members.`,
      features: [
        "Monthly allocation signal by email",
        "Trend, dual-momentum and rotation rules",
        "10-year and held-out results, updated monthly",
        "Every rule's losing years shown, not hidden",
        "Cancel any time",
      ],
      cta: founderLink ? "Become a founding member" : "Reserve a founding seat",
      checkoutUrl: founderLink,
    },
    {
      id: "setup",
      name: "Private desk setup",
      price: env("SETUP_PRICE", "£149"),
      cadence: "one-off",
      blurb: "Your own private TradesWithMe desk, deployed on your Vercel + Supabase.",
      features: [
        "Deployed and configured for you",
        "Your watchlist and risk guardrails",
        "Nightly autonomous research cycle",
        "30-minute handover call",
      ],
      cta: setupLink ? "Book a desk setup" : "Request a desk setup",
      checkoutUrl: setupLink,
    },
  ];

  return {
    url: "https://tradeswithme.com",
    name: "TradesWithMe",
    contactEmail: env("CONTACT_EMAIL", "hello@tradeswithme.com"),
    founderSeats,
    plans,
  };
}
