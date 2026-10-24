// Minimal Alpaca Trading API v2 client (US equities). Paper and live share one API;
// only the base URL and keys differ. Every call is time-boxed and throws on non-2xx.

export type AlpacaMode = "PAPER" | "LIVE";

export type AlpacaOrder = {
  id: string;
  client_order_id: string;
  symbol: string;
  status: string;
  side: string;
  qty: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  order_type?: string;
  type?: string;
  legs?: AlpacaOrder[] | null;
};

export type AlpacaPosition = { symbol: string; qty: string; avg_entry_price: string; current_price: string; market_value: string };

export class AlpacaError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function alpacaCredentials(mode: AlpacaMode) {
  const keyId = (mode === "LIVE" ? process.env.ALPACA_LIVE_KEY_ID : process.env.ALPACA_PAPER_KEY_ID)?.trim();
  const secret = (mode === "LIVE" ? process.env.ALPACA_LIVE_SECRET : process.env.ALPACA_PAPER_SECRET)?.trim();
  if (!keyId || !secret) return null;
  return { keyId, secret, baseUrl: mode === "LIVE" ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets" };
}

export function createAlpacaClient(mode: AlpacaMode, fetchImpl: typeof fetch = fetch) {
  const creds = alpacaCredentials(mode);
  if (!creds) return null;

  async function call<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetchImpl(`${creds!.baseUrl}${path}`, {
        method,
        headers: { "APCA-API-KEY-ID": creds!.keyId, "APCA-API-SECRET-KEY": creds!.secret, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: "no-store",
      });
      if (allow404 && response.status === 404) return null;
      const text = await response.text();
      if (!response.ok) throw new AlpacaError(`Alpaca ${method} ${path} → ${response.status}: ${text.slice(0, 240)}`, response.status);
      return text ? JSON.parse(text) as T : ({} as T);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mode,
    account: () => call<{ status: string; trading_blocked: boolean; account_blocked: boolean; cash: string; equity: string; currency: string }>("GET", "/v2/account"),
    positions: async () => (await call<AlpacaPosition[]>("GET", "/v2/positions")) ?? [],
    position: (symbol: string) => call<AlpacaPosition>("GET", `/v2/positions/${encodeURIComponent(symbol)}`, undefined, true),
    orderByClientId: (clientOrderId: string) => call<AlpacaOrder>("GET", `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`, undefined, true),
    order: (id: string) => call<AlpacaOrder>("GET", `/v2/orders/${encodeURIComponent(id)}?nested=true`, undefined, true),
    openOrders: async (symbol: string) => (await call<AlpacaOrder[]>("GET", `/v2/orders?status=open&nested=true&symbols=${encodeURIComponent(symbol)}`)) ?? [],
    cancelOrder: (id: string) => call<unknown>("DELETE", `/v2/orders/${encodeURIComponent(id)}`, undefined, true),
    closePosition: (symbol: string) => call<AlpacaOrder>("DELETE", `/v2/positions/${encodeURIComponent(symbol)}`, undefined, true),
    /**
     * Limit entry with broker-held take-profit and stop-loss legs (GTC), so protection
     * stays in force while the bot is asleep.
     */
    submitBracket: (input: { symbol: string; qty: number; limitUsd: number; stopUsd: number; targetUsd: number; clientOrderId: string }) =>
      call<AlpacaOrder>("POST", "/v2/orders", {
        symbol: input.symbol,
        qty: String(input.qty),
        side: "buy",
        type: "limit",
        limit_price: String(input.limitUsd),
        time_in_force: "gtc",
        order_class: "bracket",
        take_profit: { limit_price: String(input.targetUsd) },
        stop_loss: { stop_price: String(input.stopUsd) },
        client_order_id: input.clientOrderId,
      }),
  };
}

export type AlpacaClient = NonNullable<ReturnType<typeof createAlpacaClient>>;
