// Minimal Trading 212 Public API (v0, beta) client — Invest & Stocks ISA accounts.
// Auth: HTTP Basic base64(API_KEY:API_SECRET). Demo by default; live only when T212_ENV=live.
// Market orders are NOT idempotent on Trading 212's side, so this client never retries an order.

export type T212Env = "demo" | "live";
export type T212Summary = { id?: number; currency: string; totalValue: number; cash: { availableToTrade: number; inPies?: number; reservedForOrders?: number } };
export type T212Position = {
  quantity: number;
  quantityAvailableForTrading?: number;
  currentPrice?: number;
  averagePricePaid?: number;
  instrument: { ticker: string; name?: string; currency?: string; isin?: string };
  walletImpact?: { currency?: string; currentValue?: number };
};
export type T212Instrument = { ticker: string; name?: string; shortName?: string; isin?: string; currencyCode?: string; type?: string };
export type T212Order = { id?: number; ticker?: string; quantity?: number; status?: string; [k: string]: unknown };

export class T212Error extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function t212Config(env: NodeJS.ProcessEnv = process.env) {
  const key = env.T212_API_KEY?.trim();
  const secret = env.T212_API_SECRET?.trim();
  if (!key || !secret) return null;
  const mode: T212Env = env.T212_ENV?.trim().toLowerCase() === "live" ? "live" : "demo";
  return { key, secret, env: mode, baseUrl: `https://${mode}.trading212.com/api/v0` };
}

export function createT212Client(config = t212Config(), fetchImpl: typeof fetch = fetch) {
  if (!config) return null;
  const auth = `Basic ${Buffer.from(`${config.key}:${config.secret}`).toString("base64")}`;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetchImpl(`${config!.baseUrl}${path}`, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
      const text = await res.text();
      if (!res.ok) throw new T212Error(`Trading 212 ${method} ${path} → ${res.status}: ${text.slice(0, 240)}`, res.status);
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    env: config.env,
    /** 1 request / 5 s */
    summary: () => call<T212Summary>("GET", "/equity/account/summary"),
    /** 1 request / 1 s */
    positions: () => call<T212Position[]>("GET", "/equity/positions"),
    /** 1 request / 50 s */
    instruments: () => call<T212Instrument[]>("GET", "/equity/metadata/instruments"),
    /** Positive quantity buys, negative sells. 50 requests / minute. Never retried. */
    marketOrder: (ticker: string, quantity: number) => call<T212Order>("POST", "/equity/orders/market", { ticker, quantity, extendedHours: false }),
  };
}
export type T212Client = NonNullable<ReturnType<typeof createT212Client>>;
