// Trading 212 ISA rebalance assistant (V5.8): plan → owner approval (or opt-in auto) → sells → buys.
import { CASH, describeWeights, type Weights } from "@/lib/engine/allocation";
import { holdingsFromPositions, parseTickerMap, planRebalance, resizeBuys, type PlannedOrder, type RebalancePlan } from "@/lib/engine/rebalance";
import { sendAlert } from "@/lib/execution/alerts";
import { loadExecState } from "@/lib/execution/ledger";
import { createT212Client, t212Config, type T212Client } from "@/lib/execution/t212";
import { loadStrategyReport } from "./strategies";
import { supabaseConfig, supabaseError, supabaseFetch, supabaseHeaders } from "./supabase";

export type PlanStatus = "PROPOSED" | "EXECUTING" | "EXECUTED" | "PARTIAL" | "FAILED" | "CANCELLED" | "BLOCKED";
export type OrderResult = { ticker: string; side: "BUY" | "SELL"; quantity: number; ok: boolean; orderId?: number | string; status?: string; error?: string };
export type PlanRow = {
  id: string; created_at: string; month: string; env: string; strategy: string; status: PlanStatus;
  as_of: string; targets: Weights; plan: RebalancePlan; results: OrderResult[] | null; error: string | null; executed_at: string | null; auto: boolean;
};

const MAX_PLAN_AGE_MS = 6 * 60 * 60 * 1000;
const TABLE = "twm_rebalance_plan";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export function rebalanceSettings(env: NodeJS.ProcessEnv = process.env) {
  const strategy = env.REBALANCE_STRATEGY?.trim() || "blend_spy_rot";
  return {
    strategy: strategy === "ensemble_tranched" ? "ensemble" : strategy, // tranching is a backtest device; trade the ensemble's own target
    auto: ["1", "true", "on", "yes"].includes((env.REBALANCE_AUTO ?? "").trim().toLowerCase()),
    killSwitch: ["1", "true", "on", "yes"].includes((env.TRADING_KILL_SWITCH ?? "").trim().toLowerCase()),
    options: {
      bandPct: num(env.REBALANCE_BAND_PCT, 3),
      minOrderValue: num(env.REBALANCE_MIN_ORDER, 10),
      maxOrderValue: Math.min(num(env.REBALANCE_MAX_ORDER, 1000), 25_000),
      budget: env.REBALANCE_BUDGET ? num(env.REBALANCE_BUDGET, 0) : undefined,
      decimals: Math.min(6, Math.max(0, Math.round(num(env.T212_QTY_DECIMALS, 2)))),
    },
    ...parseTickerMap(env.T212_TICKER_MAP),
  };
}

async function db<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase is not configured; rebalance plans need storage.");
  const res = await supabaseFetch(`${config.url}/rest/v1/${path}`, { ...init, headers: supabaseHeaders(config, { Prefer: "return=representation", ...(init.headers as Record<string, string> | undefined) }), cache: "no-store" });
  if (!res.ok) throw new Error(await supabaseError(res, "Rebalance plan storage failed"));
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export async function loadPlans(limit = 12): Promise<PlanRow[]> {
  if (!supabaseConfig()) return [];
  return db<PlanRow[]>(`${TABLE}?select=*&order=created_at.desc&limit=${limit}`);
}

/** Strategy target for the current month (uses the month-end decision once that close is in). */
export function currentTarget(result: { holding: Weights; ifCheckedToday: Weights }, asOf: string, now: Date) {
  return asOf.slice(0, 7) < now.toISOString().slice(0, 7) ? result.ifCheckedToday : result.holding;
}

export async function createPlan(opts: { auto?: boolean; now?: Date; client?: T212Client | null } = {}): Promise<PlanRow> {
  const now = opts.now ?? new Date();
  const s = rebalanceSettings();
  const client = opts.client ?? createT212Client();
  if (!client) throw new Error("Trading 212 is not configured (T212_API_KEY / T212_API_SECRET).");
  const report = await loadStrategyReport();
  const result = report.results.find((r) => r.id === s.strategy);
  if (!result) throw new Error(`Strategy "${s.strategy}" is not available in the current report.`);
  const targets = currentTarget(result, report.asOf, now);

  const summary = await client.summary();
  const positions = await client.positions();
  let known: Set<string> | null = null;
  try { known = new Set((await client.instruments()).map((i) => i.ticker)); } catch { /* rate-limited: skip the check */ }
  const plan = planRebalance({ targets, map: s.map, cashAvailable: summary.cash.availableToTrade, holdings: holdingsFromPositions(positions), knownTickers: known, options: s.options });
  if (s.error) plan.blockers.unshift(s.error);
  if (!known) plan.warnings.push("Instrument list was rate-limited; ticker names were not re-checked this time.");
  if (summary.currency !== "GBP") plan.warnings.push(`Account currency is ${summary.currency}; sizes and caps are in that currency.`);
  if (plan.blockers.length) { plan.orders = []; plan.manual = []; }

  const row = {
    month: now.toISOString().slice(0, 7), env: client.env, strategy: s.strategy, as_of: report.asOf, targets, plan,
    status: (plan.blockers.length ? "BLOCKED" : "PROPOSED") as PlanStatus, results: null, error: null, executed_at: null, auto: Boolean(opts.auto),
  };
  const [saved] = await db<PlanRow[]>(TABLE, { method: "POST", body: JSON.stringify(row) });
  return saved;
}

async function claim(id: string): Promise<PlanRow | null> {
  // Conditional update: only a PROPOSED plan can start executing, so a double click can't trade twice.
  const rows = await db<PlanRow[]>(`${TABLE}?id=eq.${encodeURIComponent(id)}&status=eq.PROPOSED`, { method: "PATCH", body: JSON.stringify({ status: "EXECUTING" }) });
  return rows[0] ?? null;
}

async function finish(id: string, patch: Partial<PlanRow>) {
  await db(`${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ...patch, executed_at: new Date().toISOString() }) });
}

async function place(client: T212Client, o: PlannedOrder): Promise<OrderResult> {
  try {
    const res = await client.marketOrder(o.ticker, o.side === "SELL" ? -o.quantity : o.quantity);
    return { ticker: o.ticker, side: o.side, quantity: o.quantity, ok: true, orderId: res.id, status: typeof res.status === "string" ? res.status : undefined };
  } catch (e) {
    return { ticker: o.ticker, side: o.side, quantity: o.quantity, ok: false, error: e instanceof Error ? e.message : "Order failed" };
  }
}

export async function executePlan(id: string, opts: { client?: T212Client | null; waitMs?: number } = {}): Promise<PlanRow> {
  const s = rebalanceSettings();
  if (s.killSwitch) throw new Error("TRADING_KILL_SWITCH is on — no orders sent.");
  const halt = await loadExecState().catch(() => null);
  if (halt?.halted) throw new Error(`Desk halt is on${halt.reason ? ` (${halt.reason})` : ""} — no orders sent.`);
  const client = opts.client ?? createT212Client();
  if (!client) throw new Error("Trading 212 is not configured.");
  const row = await claim(id);
  if (!row) throw new Error("Plan is not awaiting approval (already executed, cancelled or blocked).");
  if (Date.now() - new Date(row.created_at).getTime() > MAX_PLAN_AGE_MS) {
    await finish(id, { status: "CANCELLED", error: "Plan older than 6 hours — prices moved. Create a new plan." });
    throw new Error("Plan expired (older than 6 hours). Create a fresh plan.");
  }
  if (row.env !== client.env) {
    await finish(id, { status: "CANCELLED", error: `Plan was made on ${row.env}, client is ${client.env}.` });
    throw new Error("Plan environment does not match the configured Trading 212 environment.");
  }

  const results: OrderResult[] = [];
  const sells = row.plan.orders.filter((o) => o.side === "SELL");
  const buys = row.plan.orders.filter((o) => o.side === "BUY");
  for (const o of sells) { results.push(await place(client, o)); await sleep(1300); }
  let sized = buys;
  if (buys.length) {
    if (sells.length) await sleep(opts.waitMs ?? 6000); // let sale proceeds land; summary is limited to 1 call / 5 s
    try {
      const summary = await client.summary();
      sized = resizeBuys(buys, summary.cash.availableToTrade, s.options.decimals, s.options.minOrderValue);
      if (sized.length < buys.length || sized.some((b, i) => b.quantity !== buys[i]?.quantity)) results.push({ ticker: "—", side: "BUY", quantity: 0, ok: true, status: `Buys re-sized to available cash ${summary.cash.availableToTrade}` });
    } catch (e) {
      sized = [];
      results.push({ ticker: "—", side: "BUY", quantity: 0, ok: false, error: `Could not re-read cash; buys skipped (${e instanceof Error ? e.message : "error"}).` });
    }
    for (const o of sized) { results.push(await place(client, o)); await sleep(1300); }
  }
  const failed = results.filter((r) => !r.ok).length;
  const status: PlanStatus = failed === 0 && sized.length === buys.length ? "EXECUTED" : results.some((r) => r.ok && r.ticker !== "—") ? "PARTIAL" : "FAILED";
  await finish(id, { status, results, error: failed ? `${failed} step(s) failed — nothing is retried automatically.` : null });
  await sendAlert(`Rebalance ${status.toLowerCase()} (${row.env}) — ${row.strategy}`, [
    `Target: ${describeWeights(row.targets)}`,
    ...results.map((r) => `${r.ok ? "✓" : "✗"} ${r.side} ${r.quantity} ${r.ticker}${r.status ? ` · ${r.status}` : ""}${r.error ? ` · ${r.error}` : ""}`),
    ...row.plan.manual.map((m) => `→ Manual: buy about ${m.estValue} of ${m.ticker} in the app.`),
    "Market orders placed outside exchange hours queue until the open. Nothing is retried automatically.",
  ]);
  return { ...row, status, results };
}

export async function cancelPlan(id: string) {
  const rows = await db<PlanRow[]>(`${TABLE}?id=eq.${encodeURIComponent(id)}&status=eq.PROPOSED`, { method: "PATCH", body: JSON.stringify({ status: "CANCELLED" }) });
  if (!rows[0]) throw new Error("Only a proposed plan can be cancelled.");
  return rows[0];
}

/**
 * Weekday cron (during LSE hours). Makes a fresh plan; if REBALANCE_AUTO=on and this month's
 * rebalance hasn't completed (max 3 attempts/month), executes it. Otherwise emails the plan.
 */
export async function runRebalanceCron(now = new Date()) {
  const s = rebalanceSettings();
  if (!t212Config()) return { skipped: "Trading 212 not configured." };
  if (s.killSwitch) return { skipped: "Kill switch on." };
  const month = now.toISOString().slice(0, 7);
  const recent = await loadPlans(40);
  const thisMonth = recent.filter((p) => p.month === month);
  if (thisMonth.some((p) => p.status === "EXECUTED" || p.status === "EXECUTING")) return { skipped: "Already rebalanced this month." };
  if (thisMonth.filter((p) => p.auto).length >= 3) return { skipped: "3 automatic attempts this month — needs you." };
  // Without auto mode, propose once per month only.
  if (!s.auto && thisMonth.some((p) => p.status === "PROPOSED" || p.status === "BLOCKED")) return { skipped: "Plan already proposed this month." };
  const plan = await createPlan({ auto: s.auto, now });
  const nothing = plan.status === "PROPOSED" && plan.plan.orders.length === 0 && plan.plan.manual.length === 0;
  if (nothing) { await finish(plan.id, { status: "EXECUTED", results: [], error: null }); return { planId: plan.id, status: "EXECUTED", note: "Within the drift band — nothing to trade." }; }
  if (s.auto && plan.status === "PROPOSED" && plan.plan.orders.length) {
    const done = await executePlan(plan.id);
    return { planId: plan.id, status: done.status };
  }
  await sendAlert(`Rebalance plan ${plan.status === "BLOCKED" ? "blocked" : "ready to approve"} (${plan.env}) — ${month}`, [
    `Strategy ${plan.strategy}: ${describeWeights(plan.targets)} (data to ${plan.as_of}).`,
    ...plan.plan.blockers.map((b) => `BLOCKED: ${b}`),
    ...plan.plan.orders.map((o) => `${o.side} ${o.quantity} ${o.ticker} ≈ ${o.estValue} — ${o.reason}`),
    ...plan.plan.manual.map((m) => `Manual: buy ≈ ${m.estValue} of ${m.ticker}.`),
    "Approve on /desk → ISA rebalance. Plans expire after 6 hours.",
  ]);
  return { planId: plan.id, status: plan.status };
}

export function rebalanceStatus() {
  const s = rebalanceSettings();
  const cfg = t212Config();
  return {
    configured: Boolean(cfg), env: cfg?.env ?? null, strategy: s.strategy, auto: s.auto, killSwitch: s.killSwitch,
    mapped: s.map, mapError: s.error ?? null, options: s.options, cash: CASH,
  };
}
