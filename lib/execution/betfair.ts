// Minimal Betfair Exchange API-NG client (UK). Login → catalogue → prices → orders.
// A delayed (free) app key can read markets but cannot place bets; a live key (one-off fee)
// is needed for real money. Orders carry a customerRef so Betfair de-duplicates resubmits.

export type BfRunnerBook = { selectionId: number; status: string; ex?: { availableToBack?: Array<{ price: number; size: number }>; availableToLay?: Array<{ price: number; size: number }> } };
export type BfMarketBook = { marketId: string; status: string; inplay?: boolean; totalMatched?: number; numberOfWinners?: number; runners: BfRunnerBook[] };
export type BfCatalogue = { marketId: string; marketName: string; totalMatched?: number; marketStartTime?: string; event?: { name?: string; countryCode?: string }; competition?: { name?: string }; eventType?: { id?: string; name?: string }; description?: { bettingType?: string }; runners?: Array<{ selectionId: number; runnerName: string }> };
export type BfInstruction = { selectionId: number; side: "BACK" | "LAY"; price: number; size: number; fillOrKill?: boolean };
export type BfPlaceResult = { status: string; errorCode?: string; instructionReports?: Array<{ status: string; errorCode?: string; betId?: string; sizeMatched?: number; averagePriceMatched?: number }> };

export class BetfairError extends Error { constructor(message: string, public status = 0) { super(message); } }

export function betfairConfig(env: NodeJS.ProcessEnv = process.env) {
  const appKey = env.BETFAIR_APP_KEY?.trim(), username = env.BETFAIR_USERNAME?.trim(), password = env.BETFAIR_PASSWORD?.trim();
  if (!appKey || !username || !password) return null;
  return { appKey, username, password };
}

export function createBetfairClient(cfg = betfairConfig(), fetchImpl: typeof fetch = fetch) {
  if (!cfg) return null;
  let token: string | null = null;

  async function req(url: string, init: RequestInit, timeoutMs = 20_000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetchImpl(url, { ...init, signal: controller.signal, cache: "no-store" }); } finally { clearTimeout(t); }
  }

  async function login() {
    const res = await req("https://identitysso.betfair.com/api/login", {
      method: "POST",
      headers: { "X-Application": cfg!.appKey, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: cfg!.username, password: cfg!.password }).toString(),
    });
    const j = await res.json().catch(() => ({})) as { token?: string; status?: string; error?: string };
    if (j.status !== "SUCCESS" || !j.token) throw new BetfairError(`Betfair login failed: ${j.error ?? j.status ?? res.status}`, res.status);
    token = j.token;
  }

  async function call<T>(api: "betting" | "account", op: string, body: unknown): Promise<T> {
    if (!token) await login();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await req(`https://api.betfair.com/exchange/${api}/rest/v1.0/${op}/`, {
        method: "POST",
        headers: { "X-Application": cfg!.appKey, "X-Authentication": token!, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      // Expired session: log in again once — safe for reads; orders are protected by customerRef.
      if (attempt === 0 && (res.status === 400 || res.status === 401) && /INVALID_SESSION|NO_SESSION/.test(text)) { await login(); continue; }
      if (!res.ok) throw new BetfairError(`Betfair ${op} → ${res.status}: ${text.slice(0, 240)}`, res.status);
      return JSON.parse(text) as T;
    }
    throw new BetfairError(`Betfair ${op}: session could not be renewed.`);
  }

  return {
    catalogue: (filter: Record<string, unknown>, maxResults = 40) => call<BfCatalogue[]>("betting", "listMarketCatalogue", { filter, maxResults, sort: "MAXIMUM_TRADED", marketProjection: ["EVENT", "EVENT_TYPE", "COMPETITION", "MARKET_START_TIME", "RUNNER_DESCRIPTION", "MARKET_DESCRIPTION"] }),
    books: (marketIds: string[]) => call<BfMarketBook[]>("betting", "listMarketBook", { marketIds, priceProjection: { priceData: ["EX_BEST_OFFERS"], exBestOffersOverrides: { bestPricesDepth: 1 } } }),
    funds: () => call<{ availableToBetBalance: number; exposure: number }>("account", "getAccountFunds", {}),
    /** Never retried by the caller; `customerRef` (≤32 chars) makes Betfair reject duplicates. */
    place: (marketId: string, customerRef: string, ins: BfInstruction[]) => call<BfPlaceResult>("betting", "placeOrders", {
      marketId, customerRef: customerRef.slice(0, 32), customerStrategyRef: "twm-event-agent",
      instructions: ins.map((i) => ({ selectionId: i.selectionId, handicap: 0, side: i.side, orderType: "LIMIT", limitOrder: { size: i.size, price: i.price, persistenceType: "LAPSE", ...(i.fillOrKill ? { timeInForce: "FILL_OR_KILL" } : {}) } })),
    }),
  };
}
export type BetfairClient = NonNullable<ReturnType<typeof createBetfairClient>>;

/** Converts Betfair books + catalogue into the agent's MarketView (best prices only). */
export function toMarketView(c: BfCatalogue, b: BfMarketBook) {
  const names = new Map((c.runners ?? []).map((r) => [r.selectionId, r.runnerName]));
  return {
    marketId: c.marketId, marketName: c.marketName, eventName: c.event?.name ?? "", startTime: c.marketStartTime ?? "", competition: c.competition?.name ?? null, totalMatched: b.totalMatched ?? c.totalMatched ?? 0,
    runners: b.runners.filter((r) => r.status === "ACTIVE").map((r) => ({
      selectionId: r.selectionId, name: names.get(r.selectionId) ?? String(r.selectionId),
      back: r.ex?.availableToBack?.[0] ?? null, lay: r.ex?.availableToLay?.[0] ?? null,
    })),
  };
}
