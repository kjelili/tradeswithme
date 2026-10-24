import test from "node:test";
import assert from "node:assert/strict";
import { decideExit, planEntries, readExecutionEnv, resolveMode, userrefFor, clientRefFor, MAX_HARD_CAP_GBP } from "../lib/execution/policy";
import { signKraken, floorToDecimals } from "../lib/execution/kraken";
import type { LiveReadiness, OvernightPaperOrder } from "../lib/engine/types";

const validated: LiveReadiness = { status: "VALIDATED", score: 80, reasons: [], completedRequiredForPilot: 0, completedRequiredForValidated: 0 };
const notReady: LiveReadiness = { ...validated, status: "NOT_READY" };
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
  entryUsd: 100, units: 0.2, notionalUsd: 20, notionalGbp: 16, stopUsd: 95, targetUsd: 110, rationale: "", ...o,
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
