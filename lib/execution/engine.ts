// Execution cycle: manage exits first, reconcile, then (only if every gate passes)
// place new protected entries. Runs after the nightly scan; stops live at the broker.

import { ENGINE } from "@/lib/engine/config";
import { resolveKrakenPairForSymbol } from "@/lib/engine/market-data";
import type { ScanResult, ValidationSummary } from "@/lib/engine/types";
import { createAlpacaClient, type AlpacaClient } from "./alpaca";
import { sendAlert } from "./alerts";
import { createKrakenClient, floorToDecimals, roundToDecimals, type KrakenClient } from "./kraken";
import { claimOrder, loadActiveOrders, loadExecState, realizedLossGbp, saveExecState, updateOrder, type ExecOrder, type ExitReason } from "./ledger";
import { clientRefFor, decideExit, planEntries, readExecutionEnv, resolveMode, userrefFor, type Broker, type ExecutionMode, type ModeDecision } from "./policy";

type LedgerMode = Exclude<ExecutionMode, "OFF">;

export type ExecutionReport = {
  at: string;
  decision: ModeDecision;
  submitted: string[];
  closed: string[];
  skipped: Array<{ symbol: string; reason: string }>;
  errors: string[];
};

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ---------- Alpaca management ----------

async function manageAlpaca(order: ExecOrder, client: AlpacaClient, now: Date, closed: string[], forceReason?: ExitReason) {
  if (order.status === "PENDING_SUBMIT" || order.status === "SUBMITTED") {
    const remote = await client.orderByClientId(order.client_ref);
    if (!remote) {
      await updateOrder(order.id, { status: "REJECTED", detail: "Order never reached Alpaca." });
      return;
    }
    if (remote.status === "filled") {
      await updateOrder(order.id, { status: "OPEN", broker_order_id: remote.id, opened_at: now.toISOString(), qty: num(remote.filled_qty), limit_usd: num(remote.filled_avg_price) || order.limit_usd });
      return;
    }
    if (["canceled", "expired", "rejected"].includes(remote.status)) {
      await updateOrder(order.id, { status: "CANCELLED", broker_order_id: remote.id, detail: `Alpaca entry ${remote.status}.` });
      return;
    }
    // Entry still resting one cycle later (or a flatten request): cancel rather than chase.
    const ageH = (now.getTime() - new Date(order.created_at).getTime()) / 3_600_000;
    if (forceReason || (ageH >= 20 && num(remote.filled_qty) === 0)) {
      await client.cancelOrder(remote.id);
      await updateOrder(order.id, { status: "CANCELLED", broker_order_id: remote.id, exit_reason: "UNFILLED", detail: "Entry not filled within one cycle; cancelled." });
    } else if (order.status === "PENDING_SUBMIT") {
      await updateOrder(order.id, { status: "SUBMITTED", broker_order_id: remote.id });
    }
    return;
  }

  // OPEN: did a broker-held leg already close it?
  const parent = order.broker_order_id ? await client.order(order.broker_order_id) : null;
  const filledLeg = parent?.legs?.find((leg) => leg.status === "filled");
  if (filledLeg) {
    const exit = num(filledLeg.filled_avg_price);
    const reason: ExitReason = (filledLeg.type ?? filledLeg.order_type) === "limit" ? "TARGET" : "STOP";
    await updateOrder(order.id, { status: "CLOSED", closed_at: now.toISOString(), exit_price_usd: exit, exit_reason: reason, pnl_usd: (exit - order.limit_usd) * order.qty });
    closed.push(`${order.symbol} ${reason} @ $${exit}`);
    return;
  }
  const position = await client.position(order.symbol);
  if (!position) {
    await updateOrder(order.id, { status: "CLOSED", closed_at: now.toISOString(), exit_reason: "MANUAL", detail: "Position no longer at Alpaca (closed outside the bot)." });
    closed.push(`${order.symbol} closed outside bot`);
    return;
  }
  const decision = forceReason ? { exit: true, reason: forceReason } : decideExit({ broker: "ALPACA", openedAt: order.opened_at ?? order.created_at, now, horizonBars: ENGINE.forwardSignalHorizonBars, lastPriceUsd: num(position.current_price), targetUsd: order.target_usd });
  if (!decision.exit) return;
  for (const open of await client.openOrders(order.symbol)) await client.cancelOrder(open.id);
  const exitOrder = await client.closePosition(order.symbol);
  const estimate = num(position.current_price);
  await updateOrder(order.id, { status: "CLOSED", closed_at: now.toISOString(), exit_price_usd: estimate, exit_reason: decision.reason as ExitReason, pnl_usd: (estimate - order.limit_usd) * order.qty, detail: `Market close order ${exitOrder?.id ?? "n/a"}; exit price is the last-price estimate.` });
  closed.push(`${order.symbol} ${decision.reason} ≈ $${estimate}`);
}

// ---------- Kraken management (LIVE only; paper orders are validate-only) ----------

async function manageKraken(order: ExecOrder, client: KrakenClient, now: Date, closed: string[], forceReason?: ExitReason) {
  const userref = order.userref!;
  const pair = order.broker_symbol!;
  const closedOrders = Object.values(await client.closedOrders(userref));
  const openOrders = Object.values(await client.openOrders(userref));
  const buy = closedOrders.find((o) => o.descr.type === "buy" && o.status === "closed" && num(o.vol_exec) > 0);

  if (order.status !== "OPEN") {
    if (!buy) {
      const anyBuy = closedOrders.find((o) => o.descr.type === "buy") ?? openOrders.find((o) => o.descr.type === "buy");
      if (!anyBuy) await updateOrder(order.id, { status: "REJECTED", detail: "Order never reached Kraken." });
      else if (anyBuy.status === "canceled" || anyBuy.status === "expired") await updateOrder(order.id, { status: "CANCELLED", detail: `Kraken entry ${anyBuy.status}.` });
      return;
    }
    await updateOrder(order.id, { status: "OPEN", opened_at: now.toISOString(), qty: num(buy.vol_exec), limit_usd: num(buy.price) || order.limit_usd });
    order = { ...order, status: "OPEN", qty: num(buy.vol_exec), limit_usd: num(buy.price) || order.limit_usd, opened_at: now.toISOString() };
  }

  const stopOpen = openOrders.some((o) => o.descr.type === "sell");
  const soldOrder = closedOrders.find((o) => o.descr.type === "sell" && o.status === "closed" && num(o.vol_exec) > 0);
  if (!stopOpen && soldOrder) {
    const exit = num(soldOrder.price);
    await updateOrder(order.id, { status: "CLOSED", closed_at: now.toISOString(), exit_price_usd: exit, exit_reason: "STOP", pnl_usd: (exit - order.limit_usd) * order.qty });
    closed.push(`${order.symbol} STOP @ $${exit}`);
    return;
  }
  if (!stopOpen) {
    await sendAlert(`No stop found for ${order.symbol}`, [`Kraken shows no open stop-loss for userref ${userref}. Check the position manually.`]);
  }

  const last = await client.lastPrice(pair);
  const decision = forceReason ? { exit: true, reason: forceReason } : decideExit({ broker: "KRAKEN", openedAt: order.opened_at ?? order.created_at, now, horizonBars: ENGINE.forwardSignalHorizonBars, lastPriceUsd: last, targetUsd: order.target_usd });
  if (!decision.exit) return;
  const info = await client.pairInfo(pair);
  if (stopOpen) await client.cancelByUserref(userref);
  const volume = floorToDecimals(order.qty, info.lotDecimals);
  await client.marketSell({ pair, volume: volume.toFixed(info.lotDecimals), userref, validate: false });
  const exit = last ?? order.limit_usd;
  await updateOrder(order.id, { status: "CLOSED", closed_at: now.toISOString(), exit_price_usd: exit, exit_reason: decision.reason as ExitReason, pnl_usd: (exit - order.limit_usd) * volume, detail: "Market sell; exit price is the last-price estimate." });
  closed.push(`${order.symbol} ${decision.reason} ≈ $${exit}`);
}

async function manageMode(mode: LedgerMode, now: Date, closed: string[], errors: string[], forceReason?: ExitReason) {
  const active = await loadActiveOrders(mode);
  const alpaca = createAlpacaClient(mode);
  const kraken = mode === "LIVE" ? createKrakenClient() : null;
  for (const order of active) {
    try {
      if (order.broker === "ALPACA") {
        if (!alpaca) { errors.push(`${order.symbol}: ${mode} Alpaca keys missing; cannot manage an open order.`); continue; }
        await manageAlpaca(order, alpaca, now, closed, forceReason);
      } else {
        if (!kraken) { errors.push(`${order.symbol}: Kraken keys missing; cannot manage an open order.`); continue; }
        await manageKraken(order, kraken, now, closed, forceReason);
      }
    } catch (error) {
      errors.push(`${order.symbol} (${mode}) management: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function unknownAlpacaPositions(mode: LedgerMode) {
  const client = createAlpacaClient(mode);
  if (!client) return 0;
  const known = new Set((await loadActiveOrders(mode)).filter((o) => o.broker === "ALPACA").map((o) => o.symbol));
  return (await client.positions()).filter((p) => !known.has(p.symbol)).length;
}

// ---------- Entry ----------

async function submitEntry(mode: LedgerMode, scanAt: string, usdPerGbp: number, intent: ReturnType<typeof planEntries>["intents"][number]) {
  const clientRef = clientRefFor(intent.symbol, scanAt, mode);
  const userref = userrefFor(clientRef);
  let brokerSymbol = intent.symbol;
  let qty = intent.qty;
  let stop = intent.stopUsd;
  let volumeText = "";

  if (intent.broker === "KRAKEN") {
    const kraken = createKrakenClient();
    if (!kraken) throw new Error("Kraken keys missing.");
    brokerSymbol = await resolveKrakenPairForSymbol(intent.symbol);
    const info = await kraken.pairInfo(brokerSymbol);
    brokerSymbol = info.key;
    qty = floorToDecimals(intent.qty, info.lotDecimals);
    stop = roundToDecimals(intent.stopUsd, info.pairDecimals);
    if (qty < info.orderMin) throw new Error(`Volume ${qty} below Kraken minimum ${info.orderMin}.`);
    if (info.costMin && qty * intent.limitUsd < info.costMin) throw new Error(`Cost below Kraken minimum $${info.costMin}.`);
    if (!(stop > 0) || stop >= intent.limitUsd) throw new Error("Stop invalid after Kraken price rounding.");
    volumeText = qty.toFixed(info.lotDecimals);
  }

  const paperKraken = intent.broker === "KRAKEN" && mode === "PAPER";
  const claimed = await claimOrder({
    broker: intent.broker, mode, symbol: intent.symbol, broker_symbol: brokerSymbol, client_ref: clientRef, userref,
    status: "PENDING_SUBMIT", qty, limit_usd: intent.limitUsd, stop_usd: stop, target_usd: intent.targetUsd,
    notional_usd: qty * intent.limitUsd, notional_gbp: (qty * intent.limitUsd) / usdPerGbp, usd_per_gbp: usdPerGbp, detail: null,
  });
  if (!claimed) return null; // already handled for this symbol/day/mode

  try {
    if (intent.broker === "ALPACA") {
      const client = createAlpacaClient(mode);
      if (!client) throw new Error(`${mode} Alpaca keys missing.`);
      const account = await client.account();
      if (!account || account.trading_blocked || account.account_blocked || account.status !== "ACTIVE") throw new Error("Alpaca account is not ACTIVE or trading is blocked.");
      const remote = await client.submitBracket({ symbol: intent.symbol, qty, limitUsd: intent.limitUsd, stopUsd: stop, targetUsd: intent.targetUsd, clientOrderId: clientRef });
      await updateOrder(claimed.id, { status: "SUBMITTED", broker_order_id: remote?.id ?? null });
    } else {
      const kraken = createKrakenClient()!;
      const result = await kraken.buyWithStop({ pair: brokerSymbol, volume: volumeText, stopPrice: String(stop), userref, validate: paperKraken });
      await updateOrder(claimed.id, paperKraken
        ? { status: "VALIDATED", detail: `Kraken validated (not executed): ${result.descr.order}${result.descr.close ? ` · ${result.descr.close}` : ""}` }
        : { status: "SUBMITTED", broker_order_id: result.txid?.[0] ?? null, detail: result.descr.order });
    }
    return `${mode} ${intent.broker} ${intent.symbol} qty ${qty} @≤$${intent.limitUsd} stop $${stop} target $${intent.targetUsd}${paperKraken ? " (validated only)" : ""}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Ambiguous network failures stay PENDING_SUBMIT and are reconciled next cycle by
    // client_order_id / userref, so a timeout can never cause a duplicate order.
    const definitive = /→ 4\d\d|EOrder|EGeneral|EFunding|not ACTIVE|keys missing/i.test(message);
    if (definitive) await updateOrder(claimed.id, { status: "REJECTED", detail: message.slice(0, 500) });
    throw error;
  }
}

export async function runExecutionCycle(scan: ScanResult, validation: ValidationSummary | undefined, now = new Date()): Promise<ExecutionReport> {
  const env = readExecutionEnv();
  const report: ExecutionReport = { at: now.toISOString(), decision: { mode: "OFF", newEntriesAllowed: false, reasons: [] }, submitted: [], closed: [], skipped: [], errors: [] };
  if (env.requestedMode === "OFF") {
    report.decision = { mode: "OFF", newEntriesAllowed: false, reasons: ["EXECUTION_MODE is off."] };
    return report;
  }

  // 1) Always manage existing positions first, in both ledgers, whatever today's gates say.
  await manageMode("LIVE", now, report.closed, report.errors).catch((e) => report.errors.push(`LIVE management: ${e instanceof Error ? e.message : e}`));
  await manageMode("PAPER", now, report.closed, report.errors).catch((e) => report.errors.push(`PAPER management: ${e instanceof Error ? e.message : e}`));

  // 2) Decide today's mode.
  const state = await loadExecState().catch(() => ({ halted: true, reason: "State unreadable — failing closed.", last_run: null, updated_at: "" }));
  const fx = scan.overnightPlan?.fx;
  const candidateMode: LedgerMode = env.requestedMode === "LIVE" ? "LIVE" : "PAPER";
  const loss = candidateMode === "LIVE" ? await realizedLossGbp("LIVE").catch(() => Number.POSITIVE_INFINITY) : 0;
  // Fail closed: if positions cannot be reconciled, treat it as an unknown position.
  const unknown = await unknownAlpacaPositions(candidateMode).catch(() => 1);
  let decision = resolveMode({ env, readiness: validation?.liveReadiness, dbHalted: state.halted, fxVerified: fx?.source === "FRANKFURTER_DAILY", realizedLossGbp: loss, unknownBrokerPositions: unknown });
  if (decision.mode !== candidateMode && decision.mode === "PAPER") {
    const paperUnknown = await unknownAlpacaPositions("PAPER").catch(() => 1);
    if (paperUnknown) decision = { ...decision, newEntriesAllowed: false, reasons: [...decision.reasons, `${paperUnknown} paper broker position(s) are not in the bot ledger — reconcile before new entries.`] };
  }
  report.decision = decision;

  // 3) New entries.
  if (decision.mode !== "OFF" && decision.newEntriesAllowed && scan.overnightPlan && fx && fx.rate > 0) {
    const mode = decision.mode as LedgerMode;
    const active = await loadActiveOrders(mode);
    const brokers = new Set<Broker>();
    if (createAlpacaClient(mode)) brokers.add("ALPACA");
    if (env.krakenKeys) brokers.add("KRAKEN");
    const { intents, skipped } = planEntries({
      orders: scan.overnightPlan.orders,
      usdPerGbp: fx.rate,
      hardCapGbp: env.hardCapGbp,
      openExposureGbp: active.reduce((sum, o) => sum + num(o.notional_gbp), 0),
      openPositions: active.length,
      openSymbols: new Set(active.map((o) => o.symbol)),
      brokersAvailable: brokers,
    });
    report.skipped.push(...skipped);
    for (const intent of intents) {
      try {
        const line = await submitEntry(mode, scan.at, fx.rate, intent);
        if (line) report.submitted.push(line);
      } catch (error) {
        report.errors.push(`${intent.symbol} entry: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  await saveExecState({ halted: state.halted, reason: state.reason, last_run: report }).catch(() => undefined);
  if (report.submitted.length || report.closed.length || report.errors.length) {
    await sendAlert(
      `${decision.mode}: ${report.submitted.length} new, ${report.closed.length} closed${report.errors.length ? `, ${report.errors.length} error(s)` : ""}`,
      [...decision.reasons.map((r) => `• ${r}`), "", ...report.submitted.map((s) => `NEW ${s}`), ...report.closed.map((s) => `CLOSED ${s}`), ...report.errors.map((e) => `ERROR ${e}`)],
    );
  }
  return report;
}

/** Owner "flatten": cancel resting entries and close every bot-managed position now. */
export async function flattenAll(now = new Date()) {
  const closed: string[] = [];
  const errors: string[] = [];
  await saveExecState({ halted: true, reason: "Flattened by owner." });
  await manageMode("LIVE", now, closed, errors, "FLATTEN");
  await manageMode("PAPER", now, closed, errors, "FLATTEN");
  await sendAlert("Flatten executed", [...closed.map((c) => `CLOSED ${c}`), ...errors.map((e) => `ERROR ${e}`)]);
  return { closed, errors };
}
