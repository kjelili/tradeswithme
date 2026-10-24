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
  id: "free" | "founder" | "setup";
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
      id: "founder",
      name: "Founding member",
      price: env("FOUNDER_PRICE", "£19"),
      cadence: "per month",
      blurb: `Daily research brief from the full desk. Price locked for the first ${founderSeats} members.`,
      features: [
        "Morning research brief (stocks + crypto)",
        "Ranked watchlist with evidence scores",
        "Near-miss cohort and regime notes",
        "Full forward ledger incl. open setups",
        "Cancel any time",
      ],
      cta: founderLink ? "Become a founding member" : "Reserve a founding seat",
      checkoutUrl: founderLink,
      highlight: true,
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
