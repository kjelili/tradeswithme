import test from "node:test";
import assert from "node:assert/strict";
import type { ScanResult, ValidationSummary } from "../lib/engine/types";

// ---- In-memory fakes for Supabase, Alpaca and Kraken behind global fetch ----
type Row = Record<string, any>;
const db: { orders: Row[]; state: Row[] } = { orders: [], state: [] };
const calls: string[] = [];
let alpacaOrders: Row[] = [];
let alpacaPositions: Row[] = [];
let nextId = 1;

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function filterRows(rows: Row[], params: URLSearchParams) {
  return rows.filter((r) => [...params.entries()].every(([k, v]) => {
    if (["select", "order", "limit", "on_conflict"].includes(k)) return true;
    if (v.startsWith("eq.")) return String(r[k]) === v.slice(3);
    if (v.startsWith("in.(")) return v.slice(4, -1).split(",").includes(String(r[k]));
    if (v.startsWith("gte.")) return String(r[k] ?? "") >= v.slice(4);
    return true;
  }));
}

globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method ?? "GET").toUpperCase();
  calls.push(`${method} ${url.host}${url.pathname}`);
  if (url.host === "sb.test") {
    const table = url.pathname.split("/").pop()!;
    const rows = table === "twm_exec_orders" ? db.orders : db.state;
    if (method === "GET") return json(filterRows(rows, url.searchParams));
    if (method === "POST") {
      const body = JSON.parse(init.body);
      const key = table === "twm_exec_orders" ? "client_ref" : "id";
      const existing = rows.find((r) => r[key] === body[key]);
      if (existing) {
        if ((init.headers?.Prefer ?? "").includes("merge")) Object.assign(existing, body);
        return json([]);
      }
      const row = { id: nextId++, created_at: new Date().toISOString(), ...body };
      rows.push(row);
      return json([row], 201);
    }
    if (method === "PATCH") { for (const r of filterRows(rows, url.searchParams)) Object.assign(r, JSON.parse(init.body)); return new Response(null, { status: 204 }); }
  }
  if (url.host === "paper-api.alpaca.markets" || url.host === "api.alpaca.markets") {
    if (url.pathname === "/v2/account") return json({ status: "ACTIVE", trading_blocked: false, account_blocked: false, cash: "100", equity: "100", currency: "USD" });
    if (url.pathname === "/v2/positions" && method === "GET") return json(alpacaPositions);
    if (url.pathname.startsWith("/v2/positions/")) { const p = alpacaPositions.find((x) => x.symbol === decodeURIComponent(url.pathname.split("/").pop()!)); return p ? json(p) : json({}, 404); }
    if (url.pathname === "/v2/orders" && method === "POST") { const b = JSON.parse(init.body); const o = { id: `a${nextId++}`, status: "accepted", filled_qty: "0", filled_avg_price: null, ...b }; alpacaOrders.push(o); return json(o); }
    if (url.pathname === "/v2/orders:by_client_order_id") { const o = alpacaOrders.find((x) => x.client_order_id === url.searchParams.get("client_order_id")); return o ? json(o) : json({}, 404); }
    if (url.pathname.startsWith("/v2/orders/")) { const o = alpacaOrders.find((x) => x.id === url.pathname.split("/").pop()); return o ? json(o) : json({}, 404); }
    if (url.pathname === "/v2/orders") return json([]);
  }
  if (url.host === "api.kraken.com") {
    if (url.pathname === "/0/public/AssetPairs") return json({ error: [], result: { XXBTZUSD: { altname: "XBTUSD", pair_decimals: 1, lot_decimals: 8, ordermin: "0.00005", costmin: "0.5" } } });
    if (url.pathname === "/0/public/Ticker") return json({ error: [], result: { XXBTZUSD: { c: ["99500.0", "1"] } } });
    if (url.pathname === "/0/private/AddOrder") { const p = new URLSearchParams(init.body); calls.push(`KRAKEN validate=${p.get("validate")} ${p.get("ordertype")}@${p.get("price")} post=${p.get("oflags")} exp=${p.get("expiretm")} close=${p.get("close[ordertype]")}@${p.get("close[price]")} vol=${p.get("volume")}`); return json({ error: [], result: { descr: { order: "buy", close: "close position @ stop loss" } } }); }
  }
  return json({ error: `unmocked ${url}` }, 599);
}) as typeof fetch;

Object.assign(process.env, {
  SUPABASE_URL: "https://sb.test", SUPABASE_SECRET_KEY: "sb_secret_test",
  ALPACA_PAPER_KEY_ID: "pk", ALPACA_PAPER_SECRET: "ps", KRAKEN_API_KEY: "kk", KRAKEN_API_SECRET: Buffer.from("secret").toString("base64"),
  APP_ACCESS_CODE: "code", CRON_SECRET: "cron", LIVE_HARD_CAP_GBP: "50",
});

const scan = {
  at: "2026-10-24T02:20:00.000Z",
  overnightPlan: {
    fx: { pair: "GBP/USD", rate: 1.25, asOf: "2026-10-23", source: "FRANKFURTER_DAILY" },
    orders: [
      { symbol: "BTC-USD", assetClass: "CRYPTO", source: "KRAKEN_CRYPTO_DAILY", score: .6, evidenceScore: 70, confidence: 70, entryUsd: 100000, units: 0.0002, notionalUsd: 20, notionalGbp: 16, stopUsd: 95000.37, targetUsd: 110000, rationale: "" },
      { symbol: "BAC", assetClass: "EQUITY", source: "YAHOO_DAILY", score: .6, evidenceScore: 70, confidence: 70, entryUsd: 9.5, units: 2, notionalUsd: 19, notionalGbp: 15.2, stopUsd: 9, targetUsd: 10.5, rationale: "" },
    ],
  },
} as unknown as ScanResult;
const notReady = { executionReadiness: { EQUITY: { status: "NOT_READY" }, CRYPTO: { status: "NOT_READY" } } } as unknown as ValidationSummary;

test("LIVE request without VALIDATED evidence trades paper only, and is idempotent", async () => {
  process.env.EXECUTION_MODE = "live";
  const { runExecutionCycle } = await import("../lib/execution/engine");
  const r1 = await runExecutionCycle(scan, notReady, new Date("2026-10-24T02:25:00Z"));
  assert.equal(r1.decision.mode, "PAPER", JSON.stringify(r1));
  assert.deepEqual(r1.errors, []);
  assert.equal(r1.submitted.length, 2);
  assert.ok(!calls.some((c) => c.includes("api.alpaca.markets/v2/orders") && !c.includes("paper")), "must never touch live Alpaca");
  // limit = min(plan 100000×0.998, last 99500×0.998) = 99301 floored to 1dp
  assert.ok(calls.some((c) => c === "KRAKEN validate=true limit@99301 post=post exp=+72000 close=stop-loss@95000.4 vol=0.00020040"), calls.filter((c) => c.startsWith("KRAKEN")).join("\n"));
  const bracket = alpacaOrders[0];
  assert.equal(bracket.order_class, "bracket");
  assert.equal(bracket.stop_loss.stop_price, "9");
  assert.equal(db.orders.find((o) => o.symbol === "BTC-USD")!.status, "VALIDATED");

  const r2 = await runExecutionCycle(scan, notReady, new Date("2026-10-24T03:00:00Z"));
  assert.equal(r2.submitted.length, 0, "re-run must not duplicate");
  assert.equal(alpacaOrders.length, 1);
});

test("broker-side stop fill is recorded as a closed STOP with P&L", async () => {
  const { runExecutionCycle } = await import("../lib/execution/engine");
  const o = alpacaOrders[0];
  Object.assign(o, { status: "filled", filled_qty: "2", filled_avg_price: "9.52", legs: [{ id: "tp", type: "limit", status: "canceled", filled_avg_price: null }, { id: "sl", type: "stop", status: "filled", filled_avg_price: "8.98" }] });
  alpacaPositions = [];
  await runExecutionCycle(scan, notReady, new Date("2026-10-25T02:25:00Z")); // SUBMITTED -> OPEN
  const r = await runExecutionCycle({ ...scan, at: "2026-10-26T02:20:00Z", overnightPlan: { ...scan.overnightPlan!, orders: [] } } as ScanResult, notReady, new Date("2026-10-26T02:25:00Z"));
  const row = db.orders.find((x) => x.symbol === "BAC")!;
  assert.equal(row.status, "CLOSED", JSON.stringify(r));
  assert.equal(row.exit_reason, "STOP");
  assert.ok(Math.abs(row.pnl_usd - ((8.98 - 9.52) * 2 - 9.52 * 2 * 10 / 10_000)) < 1e-9, String(row.pnl_usd)); // net of est. fees
});

test("owner halt blocks new entries; unknown broker positions block entries", async () => {
  const { runExecutionCycle } = await import("../lib/execution/engine");
  db.state[0].halted = true;
  const r = await runExecutionCycle({ ...scan, at: "2026-10-27T02:20:00Z" } as ScanResult, notReady, new Date("2026-10-27T02:25:00Z"));
  assert.equal(r.decision.newEntriesAllowed, false);
  assert.equal(r.submitted.length, 0);
  db.state[0].halted = false;
  alpacaPositions = [{ symbol: "TSLA", qty: "1", current_price: "200" }];
  const r2 = await runExecutionCycle({ ...scan, at: "2026-10-28T02:20:00Z" } as ScanResult, notReady, new Date("2026-10-28T02:25:00Z"));
  assert.equal(r2.decision.newEntriesAllowed, false);
  assert.ok(r2.decision.reasons.some((x) => x.includes("not in the bot ledger")));
});

test("OFF does nothing at all", async () => {
  process.env.EXECUTION_MODE = "off";
  const before = calls.length;
  const { runExecutionCycle } = await import("../lib/execution/engine");
  const r = await runExecutionCycle(scan, notReady);
  assert.equal(r.decision.mode, "OFF");
  assert.equal(calls.length, before);
});
