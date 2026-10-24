// Minimal Kraken Spot REST client. Kraken has no spot sandbox, so PAPER mode sends
// every order with validate=true: Kraken checks pair, precision, minimums, funds and
// key permissions, but nothing is executed.

import { createHash, createHmac } from "node:crypto";

export type KrakenPairInfo = { key: string; altname: string; pairDecimals: number; lotDecimals: number; orderMin: number; costMin: number };
export type KrakenOrderInfo = { status: string; userref: number | null; vol: string; vol_exec: string; price: string; descr: { type: string; ordertype: string; pair: string } };

export function signKraken(path: string, nonce: string, postData: string, secretB64: string) {
  const sha = createHash("sha256").update(nonce + postData).digest();
  return createHmac("sha512", Buffer.from(secretB64, "base64")).update(Buffer.concat([Buffer.from(path), sha])).digest("base64");
}

export function floorToDecimals(value: number, decimals: number) {
  const p = 10 ** decimals;
  return Math.floor(value * p + 1e-9) / p;
}

export function roundToDecimals(value: number, decimals: number) {
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
}

let lastNonce = 0;
function nextNonce() {
  // Strictly increasing within an instance even if two calls share a millisecond.
  lastNonce = Math.max(Date.now() * 1000, lastNonce + 1);
  return String(lastNonce);
}

export function createKrakenClient(fetchImpl: typeof fetch = fetch) {
  const key = process.env.KRAKEN_API_KEY?.trim();
  const secret = process.env.KRAKEN_API_SECRET?.trim();
  if (!key || !secret) return null;
  const base = "https://api.kraken.com";

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetchImpl(`${base}${path}`, { ...init, signal: controller.signal, cache: "no-store" });
      const json = await response.json() as { error?: string[]; result?: T };
      if (!response.ok || (json.error && json.error.length)) throw new Error(`Kraken ${path}: ${(json.error ?? [String(response.status)]).join(", ")}`);
      return json.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  function priv<T>(method: string, params: Record<string, string | number | boolean | undefined>) {
    const path = `/0/private/${method}`;
    const nonce = nextNonce();
    const body = new URLSearchParams({ nonce });
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    const postData = body.toString();
    return request<T>(path, {
      method: "POST",
      headers: { "API-Key": key!, "API-Sign": signKraken(path, nonce, postData, secret!), "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: postData,
    });
  }

  return {
    async pairInfo(pair: string): Promise<KrakenPairInfo> {
      const result = await request<Record<string, { altname: string; pair_decimals: number; lot_decimals: number; ordermin: string; costmin?: string }>>(`/0/public/AssetPairs?pair=${encodeURIComponent(pair)}`, { method: "GET" });
      const [k, info] = Object.entries(result)[0] ?? [];
      if (!k || !info) throw new Error(`Kraken pair ${pair} not found`);
      return { key: k, altname: info.altname, pairDecimals: info.pair_decimals, lotDecimals: info.lot_decimals, orderMin: Number(info.ordermin), costMin: Number(info.costmin ?? 0) };
    },
    async lastPrice(pair: string): Promise<number | null> {
      const result = await request<Record<string, { c: [string, string] }>>(`/0/public/Ticker?pair=${encodeURIComponent(pair)}`, { method: "GET" });
      const row = Object.values(result)[0];
      const price = row ? Number(row.c[0]) : NaN;
      return Number.isFinite(price) && price > 0 ? price : null;
    },
    balance: () => priv<Record<string, string>>("Balance", {}),
    openOrders: async (userref: number) => (await priv<{ open: Record<string, KrakenOrderInfo> }>("OpenOrders", { userref })).open ?? {},
    closedOrders: async (userref: number) => (await priv<{ closed: Record<string, KrakenOrderInfo> }>("ClosedOrders", { userref })).closed ?? {},
    cancelByUserref: (userref: number) => priv<{ count: number }>("CancelOrder", { txid: userref }),
    /** Market buy with a broker-held conditional stop-loss attached to the fill. */
    buyWithStop: (input: { pair: string; volume: string; stopPrice: string; userref: number; validate: boolean }) =>
      priv<{ descr: { order: string; close?: string }; txid?: string[] }>("AddOrder", {
        pair: input.pair,
        type: "buy",
        ordertype: "market",
        volume: input.volume,
        userref: input.userref,
        "close[ordertype]": "stop-loss",
        "close[price]": input.stopPrice,
        validate: input.validate ? true : undefined,
      }),
    marketSell: (input: { pair: string; volume: string; userref: number; validate: boolean }) =>
      priv<{ descr: { order: string }; txid?: string[] }>("AddOrder", {
        pair: input.pair, type: "sell", ordertype: "market", volume: input.volume, userref: input.userref,
        validate: input.validate ? true : undefined,
      }),
  };
}

export type KrakenClient = NonNullable<ReturnType<typeof createKrakenClient>>;
