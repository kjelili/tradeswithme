import test from "node:test";
import assert from "node:assert/strict";
import { decideExit, planEntries, readExecutionEnv, resolveMode, userrefFor, clientRefFor, MAX_HARD_CAP_GBP } from "../lib/execution/policy";
import { signKraken, floorToDecimals } from "../lib/execution/kraken";
import type { OvernightPaperOrder } from "../lib/engine/types";

const V = { status: "VALIDATED" as const };
const N = { status: "NOT_READY" as const };
const validated = { EQUITY: V, CRYPTO: V };
const notReady = { EQUITY: N, CRYPTO: N };
const liveEnv = readExecutionEnv({ EXECUTION_MODE: "live", APP_ACCESS_CODE: "x", CRON_SECRET: "y", LIVE_HARD_CAP_GBP: "50" });
const base = { env: liveEnv, readiness: validated, dbHalted: false, fxVerified: true, realizedLossGbp: 0, unknownBrokerPositions: 0 };

test("default env is OFF", () => {
  assert.equal(readExecutionEnv({}).requestedMode, "OFF");
  assert.equal(resolveMode({ ...base, env: readExecutionEnv({}) }).mode, "OFF");
});
test("hard cap is clamped to code ceiling", () => {
  assert.equal(readExecutionEnv({ LIVE_HARD_CAP_GBP: "999999" }).hardCapGbp, MAX_HARD_CAP_GBP);
  assert.equal(readExecutionEnv({ LIVE_HARD_CAP_GBP: "abc" }).hardCapGbp, 50);
});
test("LIVE only when every gate passes", () => {
  assert.equal(resolveMode(base).mode, "LIVE");
  assert.equal(resolveMode({ ...base, readiness: notReady }).mode, "PAPER");
  assert.equal(resolveMode({ ...base, readiness: undefined }).mode, "PAPER");
  assert.equal(resolveMode({ ...base, fxVerified: false }).mode, "PAPER");
  assert.equal(resolveMode({ ...base, env: { ...liveEnv, appAccessCodeSet: false } }).mode, "PAPER");
  assert.equal(resolveMode({ ...base, env: { ...liveEnv, cronSecretSet: false } }).mode, "PAPER");
});
test("halts, kill switch, unknown positions and loss breaker block entries", () => {
  assert.equal(resolveMode({ ...base, dbHalted: true }).newEntriesAllowed, false);
  assert.equal(resolveMode({ ...base, env: { ...liveEnv, envKillSwitch: true } }).newEntriesAllowed, false);
  assert.equal(resolveMode({ ...base, unknownBrokerPositions: 1 }).newEntriesAllowed, false);
  assert.equal(resolveMode({ ...base, realizedLossGbp: 20 }).newEntriesAllowed, false); // 40% of £50
  assert.equal(resolveMode({ ...base, realizedLossGbp: 19.99 }).newEntriesAllowed, true);
  assert.equal(resolveMode({ ...base, realizedLossGbp: Number.POSITIVE_INFINITY }).newEntriesAllowed, false);
});

const order = (o: Partial<OvernightPaperOrder>): OvernightPaperOrder => ({
  symbol: "BTC-USD", assetClass: "CRYPTO", source: "KRAKEN_CRYPTO_DAILY", score: 0.6, evidenceScore: 70, confidence: 70,
  entryUsd: 100, units: 0.2, notionalUsd: 20, notionalGbp: 16, stopUsd: 94, targetUsd: 112, rationale: "", ...o,
});
const planBase = { usdPerGbp: 1.25, hardCapGbp: 50, openExposureGbp: 0, openPositions: 0, openSymbols: new Set<string>(), brokersAvailable: new Set<"ALPACA" | "KRAKEN">(["ALPACA", "KRAKEN"]) };

test("never exceeds the hard cap", () => {
  const orders = [order({ symbol: "A-USD", notionalGbp: 30 }), order({ symbol: "B-USD", notionalGbp: 30 }), order({ symbol: "C-USD", notionalGbp: 30 })];
  const { intents } = planEntries({ ...planBase, orders });
  const total = intents.reduce((s, i) => s + i.notionalGbp, 0);
  assert.ok(total <= 50 + 1e-9, `total ${total}`);
  const withOpen = planEntries({ ...planBase, orders, openExposureGbp: 45 });
  assert.ok(withOpen.intents.reduce((s, i) => s + i.notionalGbp, 0) <= 5 + 1e-9);
});
test("refuses unprotected, simulated, duplicate or uncredentialed orders", () => {
  const r = planEntries({ ...planBase, openSymbols: new Set(["DUP-USD"]), brokersAvailable: new Set(["KRAKEN"]), orders: [
    order({ symbol: "NOSTOP-USD", stopUsd: null }),
    order({ symbol: "BADSTOP-USD", stopUsd: 101 }),
    order({ symbol: "SIM-USD", source: "SIMULATED_FALLBACK" }),
    order({ symbol: "DUP-USD" }),
    order({ symbol: "AAPL", assetClass: "EQUITY", source: "YAHOO_DAILY" as OvernightPaperOrder["source"], entryUsd: 10 }),
  ] });
  assert.equal(r.intents.length, 0);
  assert.equal(r.skipped.length, 5);
});
test("equities use whole shares; unaffordable shares are skipped", () => {
  const ok = planEntries({ ...planBase, orders: [order({ symbol: "BAC", assetClass: "EQUITY", entryUsd: 9, stopUsd: 8.5, targetUsd: 10, notionalGbp: 16 })] });
  assert.equal(ok.intents[0].qty, Math.floor(16 * 1.25 / ok.intents[0].limitUsd));
  assert.ok(Number.isInteger(ok.intents[0].qty));
  const no = planEntries({ ...planBase, orders: [order({ symbol: "NVDA", assetClass: "EQUITY", entryUsd: 180, stopUsd: 170, targetUsd: 200 })] });
  assert.equal(no.intents.length, 0);
});
test("max three open positions", () => {
  const orders = ["A", "B", "C", "D"].map((s) => order({ symbol: `${s}-USD`, notionalGbp: 5 }));
  assert.equal(planEntries({ ...planBase, orders }).intents.length, 3);
  assert.equal(planEntries({ ...planBase, orders, openPositions: 2 }).intents.length, 1);
});
test("tiny-price crypto keeps precision", () => {
  const r = planEntries({ ...planBase, orders: [order({ symbol: "PEPE-USD", entryUsd: 0.00001234, stopUsd: 0.0000115, targetUsd: 0.0000140 })] });
  assert.ok(r.intents[0].stopUsd > 0 && r.intents[0].stopUsd < r.intents[0].limitUsd);
});
test("exit timing", () => {
  const now = new Date("2026-10-10T02:20:00Z");
  assert.deepEqual(decideExit({ broker: "KRAKEN", openedAt: "2026-10-05T02:20:00Z", now, horizonBars: 5, lastPriceUsd: 100, targetUsd: 110 }), { exit: true, reason: "TIME" });
  assert.deepEqual(decideExit({ broker: "KRAKEN", openedAt: "2026-10-08T02:20:00Z", now, horizonBars: 5, lastPriceUsd: 111, targetUsd: 110 }), { exit: true, reason: "TARGET" });
  assert.equal(decideExit({ broker: "ALPACA", openedAt: "2026-10-05T02:20:00Z", now, horizonBars: 5, lastPriceUsd: 200, targetUsd: 110 }).exit, false);
});
test("idempotency keys are stable and mode-scoped", () => {
  const a = clientRefFor("BTC-USD", "2026-10-24T02:20:00Z", "LIVE");
  assert.equal(a, clientRefFor("BTC-USD", "2026-10-24T09:00:00Z", "LIVE"));
  assert.notEqual(a, clientRefFor("BTC-USD", "2026-10-24T02:20:00Z", "PAPER"));
  assert.equal(userrefFor(a), userrefFor(a));
  assert.ok(userrefFor(a) > 0 && userrefFor(a) < 2 ** 31);
});
test("Kraken signature matches Kraken's documented example", () => {
  const sig = signKraken("/0/private/AddOrder", "1616492376594", "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25", "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==");
  assert.equal(sig, "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==");
});
test("lot flooring never rounds up", () => {
  assert.equal(floorToDecimals(0.123456789, 8), 0.12345678);
  assert.equal(floorToDecimals(1.999999, 2), 1.99);
});

test("LIVE is per asset class at broker costs", () => {
  const onlyEq = resolveMode({ ...base, readiness: { EQUITY: V, CRYPTO: N } });
  assert.equal(onlyEq.mode, "LIVE");
  assert.deepEqual(onlyEq.liveAssetClasses, ["EQUITY"]);
  const r = planEntries({ ...planBase, liveAssetClasses: new Set(onlyEq.liveAssetClasses), orders: [
    order({ symbol: "BTC-USD" }),
    order({ symbol: "BAC", assetClass: "EQUITY", entryUsd: 9, stopUsd: 8.5, targetUsd: 10 }),
  ] });
  assert.deepEqual(r.intents.map((i) => i.symbol), ["BAC"]);
  assert.match(r.skipped[0].reason, /not VALIDATED/);
  assert.deepEqual(resolveMode({ ...base, readiness: { EQUITY: N, CRYPTO: N } }).liveAssetClasses, []);
  assert.equal(resolveMode({ ...base, readiness: { EQUITY: N, CRYPTO: N } }).mode, "PAPER");
});
test("Kraken entries are maker limits below the plan entry; Alpaca slightly above", () => {
  const r = planEntries({ ...planBase, orders: [order({ symbol: "ETH-USD", entryUsd: 2000, stopUsd: 1850, targetUsd: 2300 }), order({ symbol: "BAC", assetClass: "EQUITY", entryUsd: 9, stopUsd: 8.5, targetUsd: 10 })] });
  assert.ok(r.intents[0].limitUsd < 2000);
  assert.ok(r.intents[1].limitUsd > 9);
  const tight = planEntries({ ...planBase, orders: [order({ symbol: "X-USD", entryUsd: 100, stopUsd: 99.9, targetUsd: 101 })] });
  assert.equal(tight.intents.length, 0);
});
test("broker-cost readiness: a crypto record that is VALIDATED at ledger cost fails at Kraken cost", async () => {
  const { executionReadinessFor } = await import("../lib/server/validation");
  const mk = (i: number, r: number, ac: "CRYPTO" | "EQUITY") => ({ id: i, symbol: "X", assetClass: ac, openedAt: `2026-01-${String(1 + (i % 28)).padStart(2, "0")}T00:00:${String(i % 60).padStart(2, "0")}Z`, entryDate: "", entry: 1, stop: 0.9, target: 1.2, score: 0.5, evidenceScore: 60, confidence: 60, horizonBars: 5, outcome: "TARGET", exitDate: "", exitPrice: 1, returnPct: r, barsHeld: 3, agentSnapshot: [], autopsy: null }) as any;
  // 120 trades alternating +2.5% / -1.2% after the ledger's 0.16% cost: strong at ledger cost.
  const trades = Array.from({ length: 120 }, (_, i) => mk(i, i % 5 < 3 ? 2.5 : -1.2, "CRYPTO"));
  const crypto = executionReadinessFor(trades, "CRYPTO");
  assert.ok(Math.abs(crypto.expectancyPct - (1.02 + 0.16 - 1.25)) < 1e-3, String(crypto.expectancyPct));
  assert.equal(crypto.status, "NOT_READY");
  assert.equal(executionReadinessFor(trades, "EQUITY").completed, 0);
  assert.equal(executionReadinessFor(trades, "EQUITY").status, "NOT_READY");
  const eqTrades = trades.map((t: any) => ({ ...t, assetClass: "EQUITY" }));
  const eq = executionReadinessFor(eqTrades, "EQUITY");
  assert.equal(eq.costBps, 10);
  assert.ok(eq.expectancyPct > crypto.expectancyPct);
});
test("edge gate and chase filter", async () => {
  const { tradeEdge, chased } = await import("../lib/engine/edge");
  // 3% stop on crypto: 1.25% cost is 42% of risk → blocked.
  assert.equal(tradeEdge({ entry: 100, stop: 97, target: 106, assetClass: "CRYPTO" }).pass, false);
  // 6% stop: 21% → allowed without evidence; breakeven = (6+1.25)/(12+6)
  const ok = tradeEdge({ entry: 100, stop: 94, target: 112, assetClass: "CRYPTO" });
  assert.equal(ok.pass, true);
  assert.ok(Math.abs(ok.breakevenWinRate - 7.25 / 18) < 1e-4);
  // Evidence: 40 trades at 30% wins → lower bound below breakeven → blocked.
  assert.equal(tradeEdge({ entry: 100, stop: 94, target: 112, assetClass: "CRYPTO", stats: { wins: 12, n: 40 } }).pass, false);
  // 60% wins over 80 trades → passes.
  assert.equal(tradeEdge({ entry: 100, stop: 94, target: 112, assetClass: "CRYPTO", stats: { wins: 48, n: 80 } }).pass, true);
  // Under 30 samples the posterior is reported but does not block.
  assert.equal(tradeEdge({ entry: 100, stop: 94, target: 112, assetClass: "CRYPTO", stats: { wins: 2, n: 20 } }).pass, true);
  assert.equal(chased("CRYPTO", 25), true);
  assert.equal(chased("CRYPTO", 19.9), false);
  assert.equal(chased("EQUITY", 10), true);
  assert.equal(chased("EQUITY", null), false);
  const r = planEntries({ ...planBase, runUpPct: { "HOT-USD": 30 }, orders: [order({ symbol: "HOT-USD" }), order({ symbol: "TIGHT-USD", stopUsd: 98 })] });
  assert.equal(r.intents.length, 0);
  assert.match(r.skipped[0].reason, /Chase filter/);
  assert.match(r.skipped[1].reason, /Edge gate/);
  const off = planEntries({ ...planBase, filters: { edgeGate: false, chaseFilter: false }, runUpPct: { "HOT-USD": 30 }, orders: [order({ symbol: "HOT-USD" }), order({ symbol: "TIGHT-USD", stopUsd: 98 })] });
  assert.equal(off.intents.length, 2);
});
