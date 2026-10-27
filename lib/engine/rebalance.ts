// Turns a strategy's target weights into Trading 212 orders (V5.8). Pure, deterministic.
//
// Principles: only touch instruments the owner mapped; never short; sell before buying;
// skip small drifts (costs > benefit); never guess a price for something not yet held.
import { CASH, type Weights } from "./allocation";

export type Holding = { ticker: string; quantity: number; available: number; value: number };
export type PlannedOrder = { ticker: string; proxies: string[]; side: "BUY" | "SELL"; quantity: number; unitValue: number; estValue: number; reason: string };
export type ManualAction = { ticker: string; proxies: string[]; side: "BUY"; estValue: number; reason: string };
export type TargetLine = { ticker: string; proxies: string[]; weightPct: number; targetValue: number; currentValue: number; driftPct: number };
export type RebalancePlan = {
  managedValue: number; cashAvailable: number; cashTargetValue: number;
  lines: TargetLine[]; orders: PlannedOrder[]; manual: ManualAction[];
  blockers: string[]; warnings: string[];
};
export type RebalanceOptions = {
  /** Skip a line whose drift is below this share of the managed value. */
  bandPct?: number;
  /** Skip orders smaller than this (account currency). */
  minOrderValue?: number;
  /** Cap on any single order (account currency). */
  maxOrderValue?: number;
  /** Only manage this much (account currency). */
  budget?: number;
  /** Quantity decimals (fractional shares). */
  decimals?: number;
  /** Keep this share of the managed value in cash for spreads/FX. */
  cashBufferPct?: number;
};

const floorTo = (v: number, d: number) => { const p = 10 ** d; return Math.floor(v * p + 1e-9) / p; };
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Parses T212_TICKER_MAP: JSON like {"SPY":"VUAGl_EQ","QQQ":"EQQQl_EQ"}. */
export function parseTickerMap(raw: string | undefined): { map: Record<string, string>; error?: string } {
  if (!raw?.trim()) return { map: {}, error: "T212_TICKER_MAP is not set." };
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { map: {}, error: "T212_TICKER_MAP must be a JSON object." };
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (typeof v === "string" && v.trim()) map[k.trim().toUpperCase()] = v.trim();
    return { map };
  } catch {
    return { map: {}, error: "T212_TICKER_MAP is not valid JSON." };
  }
}

export function planRebalance(input: {
  targets: Weights;
  map: Record<string, string>;
  cashAvailable: number;
  holdings: Holding[];
  knownTickers?: Set<string> | null;
  options?: RebalanceOptions;
}): RebalancePlan {
  const o = { bandPct: 3, minOrderValue: 10, maxOrderValue: 1000, decimals: 2, cashBufferPct: 1, ...input.options };
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Aggregate target weights by Trading 212 ticker. Cash stays cash.
  const targetBy = new Map<string, { w: number; proxies: string[] }>();
  let cashW = 0;
  for (const [proxy, w] of Object.entries(input.targets)) {
    if (!(w > 0.0001)) continue;
    if (proxy === CASH) { cashW += w; continue; }
    const t = input.map[proxy];
    if (!t) { blockers.push(`No Trading 212 instrument mapped for ${proxy} (${Math.round(w * 100)}% of the target). Add it to T212_TICKER_MAP.`); continue; }
    if (input.knownTickers && !input.knownTickers.has(t)) { blockers.push(`${t} (for ${proxy}) is not in your Trading 212 instrument list — check the ticker.`); continue; }
    const cur = targetBy.get(t) ?? { w: 0, proxies: [] };
    cur.w += w; cur.proxies.push(proxy);
    targetBy.set(t, cur);
  }

  // Managed universe = every instrument in the map. Other holdings are left alone.
  const managed = new Set(Object.values(input.map));
  const held = new Map(input.holdings.filter((h) => managed.has(h.ticker) && h.quantity > 0).map((h) => [h.ticker, h]));
  const heldValue = [...held.values()].reduce((a, h) => a + h.value, 0);
  const cash = Math.max(0, input.cashAvailable);
  let managedValue = heldValue + cash;
  if (o.budget && o.budget > 0 && managedValue > o.budget) {
    if (heldValue > o.budget) warnings.push(`Managed holdings (${r2(heldValue)}) already exceed the budget (${o.budget}); the plan trims them toward the budget.`);
    managedValue = o.budget;
  }
  const investable = managedValue * (1 - o.cashBufferPct / 100);

  const lines: TargetLine[] = [];
  const orders: PlannedOrder[] = [];
  const manual: ManualAction[] = [];
  const band = Math.max(o.minOrderValue, managedValue * o.bandPct / 100);
  const proxiesFor = (t: string) => Object.entries(input.map).filter(([, v]) => v === t).map(([k]) => k);

  for (const t of new Set([...managed])) {
    const tgt = targetBy.get(t);
    const w = tgt?.w ?? 0;
    const h = held.get(t);
    const current = h?.value ?? 0;
    const target = w * investable;
    if (w === 0 && current === 0) continue;
    const proxies = tgt?.proxies ?? proxiesFor(t);
    lines.push({ ticker: t, proxies, weightPct: Math.round(w * 1000) / 10, targetValue: r2(target), currentValue: r2(current), driftPct: managedValue > 0 ? Math.round((current - target) / managedValue * 1000) / 10 : 0 });
    const diff = target - current;
    const unit = h && h.quantity > 0 ? h.value / h.quantity : 0;
    if (diff < 0) {
      if (!h) continue;
      const fullExit = w === 0;
      if (!fullExit && -diff < band) continue;
      let qty = fullExit ? h.available : Math.min(h.available, floorTo(-diff / unit, o.decimals));
      if (h.available < h.quantity) warnings.push(`${t}: only ${h.available} of ${h.quantity} shares are free to sell (some are locked or in pending orders).`);
      if (qty * unit > o.maxOrderValue) { qty = floorTo(o.maxOrderValue / unit, o.decimals); warnings.push(`${t}: sell capped at ${o.maxOrderValue} (REBALANCE_MAX_ORDER).`); }
      if (qty <= 0 || qty * unit < o.minOrderValue) continue;
      orders.push({ ticker: t, proxies, side: "SELL", quantity: qty, unitValue: r2(unit), estValue: r2(qty * unit), reason: fullExit ? "Exit: no longer in the target." : `Trim to ${Math.round(w * 100)}%.` });
    } else if (diff >= band) {
      let value = Math.min(diff, o.maxOrderValue);
      if (diff > o.maxOrderValue) warnings.push(`${t}: buy capped at ${o.maxOrderValue} (REBALANCE_MAX_ORDER).`);
      if (!unit) {
        manual.push({ ticker: t, proxies, side: "BUY", estValue: r2(value), reason: "Not held yet, so the API can't price it safely. Buy this amount once in the Trading 212 app (value order); later rebalances are automatic." });
        continue;
      }
      const qty = floorTo(value / unit, o.decimals);
      value = qty * unit;
      if (qty <= 0 || value < o.minOrderValue) continue;
      orders.push({ ticker: t, proxies, side: "BUY", quantity: qty, unitValue: r2(unit), estValue: r2(value), reason: current ? `Top up to ${Math.round(w * 100)}%.` : `Open at ${Math.round(w * 100)}%.` });
    }
  }

  // Buys can't exceed cash + expected sale proceeds (minus the buffer). Scale down if needed.
  const sells = orders.filter((x) => x.side === "SELL").reduce((a, x) => a + x.estValue, 0);
  const buys = orders.filter((x) => x.side === "BUY");
  const affordable = Math.max(0, cash + sells - managedValue * o.cashBufferPct / 100);
  const wanted = buys.reduce((a, x) => a + x.estValue, 0);
  if (wanted > affordable && wanted > 0) {
    const f = affordable / wanted;
    warnings.push(`Buys scaled to ${Math.round(f * 100)}% to fit available cash.`);
    for (const b of buys) { b.quantity = floorTo(b.quantity * f, o.decimals); b.estValue = r2(b.quantity * b.unitValue); }
  }
  const finalOrders = orders.filter((x) => x.quantity > 0 && x.estValue >= o.minOrderValue);
  // Sells first so their proceeds fund the buys.
  finalOrders.sort((a, b) => (a.side === b.side ? b.estValue - a.estValue : a.side === "SELL" ? -1 : 1));

  return {
    managedValue: r2(managedValue), cashAvailable: r2(cash), cashTargetValue: r2(managedValue - [...targetBy.values()].reduce((a, x) => a + x.w, 0) * investable),
    lines: lines.sort((a, b) => b.targetValue - a.targetValue),
    orders: blockers.length ? [] : finalOrders,
    manual: blockers.length ? [] : manual,
    blockers, warnings,
  };
}

/** After sells, re-size buys to the cash actually available (never more than planned). */
export function resizeBuys(buys: PlannedOrder[], cashAvailable: number, decimals = 2, minOrderValue = 10) {
  const wanted = buys.reduce((a, x) => a + x.estValue, 0);
  const f = wanted > 0 ? Math.min(1, Math.max(0, cashAvailable * 0.99) / wanted) : 1;
  return buys
    .map((b) => { const quantity = floorTo(b.quantity * f, decimals); return { ...b, quantity, estValue: r2(quantity * b.unitValue) }; })
    .filter((b) => b.quantity > 0 && b.estValue >= minOrderValue);
}

/** Converts Trading 212 positions to holdings valued in the account currency. */
export function holdingsFromPositions(ps: Array<{ quantity: number; quantityAvailableForTrading?: number; currentPrice?: number; instrument: { ticker: string }; walletImpact?: { currentValue?: number } }>): Holding[] {
  return ps.map((p) => ({
    ticker: p.instrument.ticker,
    quantity: p.quantity,
    available: p.quantityAvailableForTrading ?? p.quantity,
    // walletImpact.currentValue is in the account currency, so pence/dollar quotes don't matter.
    value: p.walletImpact?.currentValue ?? 0,
  })).filter((h) => h.quantity > 0 && h.value > 0);
}
