import test from "node:test";
import assert from "node:assert/strict";
import { holdingsFromPositions, parseTickerMap, planRebalance, resizeBuys } from "../lib/engine/rebalance";
import { createT212Client } from "../lib/execution/t212";
import { currentTarget, rebalanceSettings } from "../lib/server/rebalance";

const MAP = { SPY: "VUAGl_EQ", QQQ: "EQQQl_EQ", GLD: "SGLNl_EQ", TLT: "IDTLl_EQ" };

test("ticker map parsing is strict", () => {
  assert.ok(parseTickerMap(undefined).error);
  assert.ok(parseTickerMap("not json").error);
  assert.ok(parseTickerMap("[1]").error);
  assert.deepEqual(parseTickerMap('{"spy":"VUAGl_EQ","x":3}').map, { SPY: "VUAGl_EQ" });
});

test("unmapped or unknown targets block the whole plan (no partial strategy)", () => {
  const p = planRebalance({ targets: { SPY: 0.5, EEM: 0.5 }, map: MAP, cashAvailable: 1000, holdings: [] });
  assert.ok(p.blockers.some((b) => b.includes("EEM")));
  assert.equal(p.orders.length, 0);
  const q = planRebalance({ targets: { SPY: 1 }, map: MAP, cashAvailable: 1000, holdings: [], knownTickers: new Set(["EQQQl_EQ"]) });
  assert.ok(q.blockers.length === 1 && q.orders.length === 0);
});

test("sells first, exits fully, never sells more than available, buys fit the cash", () => {
  const p = planRebalance({
    targets: { SPY: 0.5, QQQ: 0.5 }, map: MAP, cashAvailable: 0,
    holdings: [
      { ticker: "VUAGl_EQ", quantity: 10, available: 10, value: 1000 },
      { ticker: "SGLNl_EQ", quantity: 5, available: 4, value: 1000 },
      { ticker: "EQQQl_EQ", quantity: 2, available: 2, value: 400 },
      { ticker: "OTHER", quantity: 1, available: 1, value: 9999 },
    ],
  });
  assert.equal(p.blockers.length, 0);
  assert.equal(p.managedValue, 2400, "unmapped holdings are ignored");
  assert.equal(p.orders[0].side, "SELL");
  const gold = p.orders.find((o) => o.ticker === "SGLNl_EQ")!;
  assert.equal(gold.quantity, 4, "full exit capped at the available quantity");
  assert.ok(!p.orders.some((o) => o.ticker === "OTHER"));
  const buys = p.orders.filter((o) => o.side === "BUY").reduce((a, o) => a + o.estValue, 0);
  const sells = p.orders.filter((o) => o.side === "SELL").reduce((a, o) => a + o.estValue, 0);
  assert.ok(buys <= sells + 1e-9, `${buys} <= ${sells}`);
});

test("small drifts are skipped; cash target stays cash; unheld buys are manual", () => {
  const p = planRebalance({ targets: { SPY: 0.99, BIL: 0.01 }, map: MAP, cashAvailable: 20, holdings: [{ ticker: "VUAGl_EQ", quantity: 10, available: 10, value: 980 }] });
  assert.equal(p.orders.length, 0);
  const q = planRebalance({ targets: { QQQ: 1 }, map: MAP, cashAvailable: 500, holdings: [] });
  assert.equal(q.orders.length, 0);
  assert.equal(q.manual[0].ticker, "EQQQl_EQ");
  assert.ok(q.manual[0].estValue <= 500);
});

test("per-order cap and budget are respected", () => {
  const p = planRebalance({ targets: { SPY: 1 }, map: MAP, cashAvailable: 50_000, holdings: [{ ticker: "VUAGl_EQ", quantity: 1, available: 1, value: 100 }], options: { maxOrderValue: 1000 } });
  assert.ok(p.orders.every((o) => o.estValue <= 1000));
  const b = planRebalance({ targets: { SPY: 1 }, map: MAP, cashAvailable: 50_000, holdings: [{ ticker: "VUAGl_EQ", quantity: 1, available: 1, value: 100 }], options: { budget: 600, maxOrderValue: 10_000 } });
  assert.equal(b.managedValue, 600);
  assert.ok(b.orders[0].estValue <= 500);
});

test("resizeBuys never increases and scales to cash", () => {
  const buys = [{ ticker: "A", proxies: [], side: "BUY" as const, quantity: 10, unitValue: 10, estValue: 100, reason: "" }];
  assert.equal(resizeBuys(buys, 1000)[0].quantity, 10);
  assert.equal(resizeBuys(buys, 50)[0].quantity, 4.95);
  assert.equal(resizeBuys(buys, 5).length, 0);
});

test("holdings use wallet value (account currency), not quote price", () => {
  const h = holdingsFromPositions([{ quantity: 2, currentPrice: 9000, instrument: { ticker: "VUAGl_EQ" }, walletImpact: { currentValue: 180 } }]);
  assert.equal(h[0].value, 180);
});

test("T212 client: basic auth, demo default, sell = negative quantity, no retry", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fake = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 1 }), { status: 200 }); }) as unknown as typeof fetch;
  const c = createT212Client({ key: "k", secret: "s", env: "demo", baseUrl: "https://demo.trading212.com/api/v0" }, fake)!;
  await c.marketOrder("VUAGl_EQ", -1.5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://demo.trading212.com/api/v0/equity/orders/market");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("k:s").toString("base64")}`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { ticker: "VUAGl_EQ", quantity: -1.5, extendedHours: false });
  const failing = (async () => new Response("rate", { status: 429 })) as unknown as typeof fetch;
  let n = 0;
  const c2 = createT212Client({ key: "k", secret: "s", env: "demo", baseUrl: "x" }, ((...a: Parameters<typeof fetch>) => { n += 1; return failing(...a); }) as typeof fetch)!;
  await assert.rejects(() => c2.marketOrder("X", 1));
  assert.equal(n, 1);
});

test("settings: demo unless live is explicit; tranched trades the ensemble target; caps bounded", () => {
  const s = rebalanceSettings({ REBALANCE_STRATEGY: "ensemble_tranched", REBALANCE_MAX_ORDER: "999999", T212_TICKER_MAP: "{}" } as unknown as NodeJS.ProcessEnv);
  assert.equal(s.strategy, "ensemble");
  assert.equal(s.options.maxOrderValue, 25_000);
  assert.equal(s.auto, false);
});

test("current target uses the month-end decision once the month has closed", () => {
  const r = { holding: { SPY: 1 }, ifCheckedToday: { BIL: 1 } };
  assert.deepEqual(currentTarget(r, "2026-09-30", new Date("2026-10-01T10:00:00Z")), { BIL: 1 });
  assert.deepEqual(currentTarget(r, "2026-10-14", new Date("2026-10-15T10:00:00Z")), { SPY: 1 });
});
