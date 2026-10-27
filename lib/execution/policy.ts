// Pure, side-effect-free execution policy. Every decision that can move real money
// lives here so it can be unit-tested without brokers, network or a database.

import { KRAKEN_MAKER_ENTRY_DISCOUNT } from "@/lib/engine/config";
import { chased, tradeEdge, type TradeEdge, type WinStats } from "@/lib/engine/edge";
import type { AssetClass, LiveReadinessStatus, OvernightPaperOrder } from "@/lib/engine/types";

export type ExecutionMode = "OFF" | "PAPER" | "LIVE";
export type Broker = "ALPACA" | "KRAKEN";

/** Absolute code-level ceiling. An env typo can never authorise more than this. */
export const MAX_HARD_CAP_GBP = 1000;
export const MAX_OPEN_POSITIONS = 3;

export type ExecutionEnv = {
  requestedMode: ExecutionMode;
  hardCapGbp: number;
  lossBreakerPct: number;
  envKillSwitch: boolean;
  appAccessCodeSet: boolean;
  cronSecretSet: boolean;
  alpacaLiveKeys: boolean;
  alpacaPaperKeys: boolean;
  krakenKeys: boolean;
};

export function readExecutionEnv(env: Record<string, string | undefined> = process.env): ExecutionEnv {
  const raw = (env.EXECUTION_MODE ?? "off").trim().toUpperCase();
  const requestedMode: ExecutionMode = raw === "LIVE" ? "LIVE" : raw === "PAPER" ? "PAPER" : "OFF";
  const cap = Number(env.LIVE_HARD_CAP_GBP ?? "50");
  const breaker = Number(env.LOSS_BREAKER_PCT ?? "40");
  const has = (k: string) => Boolean(env[k]?.trim());
  return {
    requestedMode,
    hardCapGbp: Number.isFinite(cap) ? Math.max(0, Math.min(MAX_HARD_CAP_GBP, cap)) : 50,
    lossBreakerPct: Number.isFinite(breaker) ? Math.max(5, Math.min(100, breaker)) : 40,
    envKillSwitch: ["1", "true", "on", "yes"].includes((env.TRADING_KILL_SWITCH ?? "").trim().toLowerCase()),
    appAccessCodeSet: has("APP_ACCESS_CODE"),
    cronSecretSet: has("CRON_SECRET"),
    alpacaLiveKeys: has("ALPACA_LIVE_KEY_ID") && has("ALPACA_LIVE_SECRET"),
    alpacaPaperKeys: has("ALPACA_PAPER_KEY_ID") && has("ALPACA_PAPER_SECRET"),
    krakenKeys: has("KRAKEN_API_KEY") && has("KRAKEN_API_SECRET"),
  };
}

export type ModeDecision = {
  mode: ExecutionMode;
  newEntriesAllowed: boolean;
  /** In LIVE mode, only these asset classes may open real-money positions. */
  liveAssetClasses: AssetClass[];
  reasons: string[];
};

/**
 * LIVE is granted only when EVERY condition holds. Anything else downgrades to PAPER
 * (or OFF), never upward. Exits/stops are still managed while new entries are blocked.
 */
export function resolveMode(input: {
  env: ExecutionEnv;
  /** Per-asset-class readiness at realistic broker costs (ValidationSummary.executionReadiness). */
  readiness: Partial<Record<AssetClass, { status: LiveReadinessStatus }>> | undefined;
  dbHalted: boolean;
  fxVerified: boolean;
  realizedLossGbp: number;
  unknownBrokerPositions: number;
}): ModeDecision {
  const { env } = input;
  const reasons: string[] = [];
  if (env.requestedMode === "OFF") return { mode: "OFF", newEntriesAllowed: false, liveAssetClasses: [], reasons: ["EXECUTION_MODE is off."] };
  const classes: AssetClass[] = ["EQUITY", "CRYPTO"];
  const liveAssetClasses = classes.filter((c) => input.readiness?.[c]?.status === "VALIDATED");

  let mode: ExecutionMode = env.requestedMode;
  const downgrade = (reason: string) => { if (mode === "LIVE") mode = "PAPER"; reasons.push(reason); };

  if (mode === "LIVE") {
    if (!liveAssetClasses.length) {
      downgrade(`No asset class is VALIDATED at realistic broker costs (equities ${input.readiness?.EQUITY?.status ?? "UNKNOWN"}, crypto ${input.readiness?.CRYPTO?.status ?? "UNKNOWN"}) — trading on paper.`);
    } else {
      for (const c of classes) if (!liveAssetClasses.includes(c)) reasons.push(`${c === "CRYPTO" ? "Crypto" : "Equities"} not VALIDATED at broker costs — no real-money ${c.toLowerCase()} entries.`);
    }
    if (!env.appAccessCodeSet) downgrade("APP_ACCESS_CODE is not set.");
    if (!env.cronSecretSet) downgrade("CRON_SECRET is not set.");
    if (!input.fxVerified) downgrade("GBP/USD rate is a fallback; the £ cap cannot be enforced precisely.");
    if (env.hardCapGbp <= 0) downgrade("LIVE_HARD_CAP_GBP is 0.");
  }

  let newEntriesAllowed = true;
  if (env.envKillSwitch) { newEntriesAllowed = false; reasons.push("TRADING_KILL_SWITCH is on."); }
  if (input.dbHalted) { newEntriesAllowed = false; reasons.push("Trading halted from the owner desk."); }
  if (input.unknownBrokerPositions > 0) { newEntriesAllowed = false; reasons.push(`${input.unknownBrokerPositions} broker position(s) are not in the bot ledger — reconcile before new entries.`); }
  const breakerGbp = env.hardCapGbp * env.lossBreakerPct / 100;
  if (mode === "LIVE" && input.realizedLossGbp >= breakerGbp && breakerGbp > 0) {
    newEntriesAllowed = false;
    reasons.push(`Loss breaker tripped: £${input.realizedLossGbp.toFixed(2)} realised loss in 30 days ≥ £${breakerGbp.toFixed(2)}.`);
  }
  if (!reasons.length) reasons.push(mode === "LIVE" ? "All live gates passed." : "Paper mode requested.");
  return { mode, newEntriesAllowed, liveAssetClasses: mode === "LIVE" ? liveAssetClasses : [], reasons };
}

export type EntryIntent = {
  broker: Broker;
  symbol: string;
  qty: number;
  limitUsd: number;
  stopUsd: number;
  targetUsd: number;
  notionalUsd: number;
  notionalGbp: number;
  edge: TradeEdge;
};

export type SkippedEntry = { symbol: string; reason: string };

function roundPrice(price: number, broker: Broker) {
  // Alpaca: cents above $1, 4dp below. Kraken: keep 6 significant digits here; the
  // Kraken adapter re-rounds to each pair's exact pair_decimals before submitting.
  if (broker === "ALPACA") return price >= 1 ? Math.round(price * 100) / 100 : Math.round(price * 10_000) / 10_000;
  return Number(price.toPrecision(6));
}

/**
 * Converts the overnight plan into broker intents under an independent hard cap.
 * The planner already filters for BUY_SETUP, verified data, evidence and correlation;
 * this layer re-checks the money-relevant invariants itself (defence in depth).
 */
export function planEntries(input: {
  orders: OvernightPaperOrder[];
  usdPerGbp: number;
  hardCapGbp: number;
  openExposureGbp: number;
  openPositions: number;
  openSymbols: Set<string>;
  brokersAvailable: Set<Broker>;
  /** Set in LIVE mode: orders for other asset classes are refused. */
  liveAssetClasses?: Set<AssetClass>;
  /** V5.5 filters (default on). */
  filters?: { edgeGate: boolean; chaseFilter: boolean };
  /** Settled win stats per asset class at broker cost (edge-gate posterior). */
  winStats?: Partial<Record<AssetClass, WinStats>>;
  /** Trailing 5-bar return per symbol (chase filter). */
  runUpPct?: Record<string, number | null>;
}): { intents: EntryIntent[]; skipped: SkippedEntry[] } {
  const filters = input.filters ?? { edgeGate: true, chaseFilter: true };
  const intents: EntryIntent[] = [];
  const skipped: SkippedEntry[] = [];
  let remainingGbp = Math.max(0, input.hardCapGbp - input.openExposureGbp);
  let slots = Math.max(0, MAX_OPEN_POSITIONS - input.openPositions);

  for (const order of input.orders) {
    const skip = (reason: string) => skipped.push({ symbol: order.symbol, reason });
    const broker: Broker = order.assetClass === "CRYPTO" ? "KRAKEN" : "ALPACA";
    if (slots <= 0) { skip("Max open positions reached."); continue; }
    if (input.openSymbols.has(order.symbol)) { skip("Already holding this symbol."); continue; }
    if (!input.brokersAvailable.has(broker)) { skip(`${broker} credentials for this mode are not configured.`); continue; }
    if (order.source === "SIMULATED_FALLBACK") { skip("Simulated data can never trade."); continue; }
    if (input.liveAssetClasses && !input.liveAssetClasses.has(order.assetClass)) { skip(`${order.assetClass} is not VALIDATED at realistic broker costs.`); continue; }
    const entry = order.entryUsd;
    const stop = order.stopUsd;
    const target = order.targetUsd;
    if (!(entry > 0) || stop == null || target == null || !(stop > 0) || !(stop < entry) || !(target > entry)) {
      skip("Missing or inconsistent stop/target; refusing an unprotected order.");
      continue;
    }
    const budgetGbp = Math.min(order.notionalGbp, remainingGbp);
    const budgetUsd = budgetGbp * input.usdPerGbp;
    // Equities: marketable bracket limit (+0.3%). Crypto: post-only maker limit below the
    // plan entry (the executor lowers it further if the live price is already lower).
    const limitUsd = roundPrice(entry * (broker === "ALPACA" ? 1.003 : KRAKEN_MAKER_ENTRY_DISCOUNT), broker);
    if (!(limitUsd > stop)) { skip("Entry limit would sit at or below the stop."); continue; }
    if (filters.chaseFilter && chased(order.assetClass, input.runUpPct?.[order.symbol])) {
      skip(`Chase filter: already up ${input.runUpPct?.[order.symbol]?.toFixed(1)}% in 5 bars.`);
      continue;
    }
    const edge = tradeEdge({ entry: limitUsd, stop, target, assetClass: order.assetClass, stats: input.winStats?.[order.assetClass] ?? null });
    if (filters.edgeGate && !edge.pass) { skip(`Edge gate: ${edge.reasons[0]}`); continue; }
    const qty = broker === "ALPACA" ? Math.floor(budgetUsd / limitUsd) : Math.floor((budgetUsd / limitUsd) * 1e8) / 1e8;
    if (qty <= 0) { skip(`£${budgetGbp.toFixed(2)} cannot buy one unit at $${limitUsd}.`); continue; }
    const notionalUsd = qty * limitUsd;
    const notionalGbp = notionalUsd / input.usdPerGbp;
    if (notionalGbp > remainingGbp + 1e-9) { skip("Would exceed the hard cap."); continue; }
    intents.push({ broker, symbol: order.symbol, qty, limitUsd, stopUsd: roundPrice(stop, broker), targetUsd: roundPrice(target, broker), notionalUsd, notionalGbp, edge });
    remainingGbp -= notionalGbp;
    slots -= 1;
  }
  return { intents, skipped };
}

export type ExitDecision = { exit: boolean; reason: "TARGET" | "TIME" | null };

/** Stops live at the broker. The bot itself only closes on target (Kraken) or time. */
export function decideExit(input: { broker: Broker; openedAt: string; now: Date; horizonBars: number; lastPriceUsd: number | null; targetUsd: number }): ExitDecision {
  const days = (input.now.getTime() - new Date(input.openedAt).getTime()) / 86_400_000;
  // Equity bars are trading days: 5 bars ≈ 7 calendar days. Crypto trades daily.
  const maxDays = input.broker === "ALPACA" ? Math.ceil(input.horizonBars * 7 / 5) : input.horizonBars;
  if (input.broker === "KRAKEN" && input.lastPriceUsd != null && input.lastPriceUsd >= input.targetUsd) return { exit: true, reason: "TARGET" };
  if (days >= maxDays) return { exit: true, reason: "TIME" };
  return { exit: false, reason: null };
}

/** Stable 31-bit positive integer used as Kraken's userref for idempotent order tagging. */
export function userrefFor(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 1) || 1;
}

export function clientRefFor(symbol: string, scanAt: string, mode: ExecutionMode) {
  return `twm-${mode.toLowerCase()}-${symbol.replace(/[^A-Z0-9]/gi, "")}-${scanAt.slice(0, 10)}`;
}
