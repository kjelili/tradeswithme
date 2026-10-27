// Supabase persistence for broker orders and the owner halt switch.

import { supabaseConfig, supabaseError, supabaseFetch, supabaseHeaders } from "@/lib/server/supabase";
import type { Broker, ExecutionMode } from "./policy";

export type ExecStatus = "PENDING_SUBMIT" | "SUBMITTED" | "OPEN" | "VALIDATED" | "CLOSED" | "REJECTED" | "CANCELLED";
export type ExitReason = "STOP" | "TARGET" | "TIME" | "MANUAL" | "FLATTEN" | "UNFILLED";

export type ExecOrder = {
  id: number;
  created_at: string;
  broker: Broker;
  mode: Exclude<ExecutionMode, "OFF">;
  symbol: string;
  broker_symbol: string | null;
  client_ref: string;
  userref: number | null;
  broker_order_id: string | null;
  status: ExecStatus;
  qty: number;
  limit_usd: number;
  stop_usd: number;
  target_usd: number;
  notional_usd: number;
  notional_gbp: number;
  usd_per_gbp: number;
  opened_at: string | null;
  closed_at: string | null;
  exit_price_usd: number | null;
  exit_reason: ExitReason | null;
  pnl_usd: number | null;
  detail: string | null;
  /** V5.5 "why it traded" card, frozen at entry. */
  rationale?: unknown;
};

function cfg() {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase is not configured; execution requires a durable order ledger.");
  return config;
}

export async function claimOrder(row: Omit<ExecOrder, "id" | "created_at" | "broker_order_id" | "opened_at" | "closed_at" | "exit_price_usd" | "exit_reason" | "pnl_usd">): Promise<ExecOrder | null> {
  const config = cfg();
  // Unique client_ref + ignore-duplicates = an order is claimed at most once, even if
  // the cron fires twice or a run is retried after a timeout.
  const response = await supabaseFetch(`${config.url}/rest/v1/twm_exec_orders?on_conflict=client_ref`, {
    method: "POST",
    headers: supabaseHeaders(config, { Prefer: "resolution=ignore-duplicates,return=representation" }),
    body: JSON.stringify(row),
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Order claim failed"));
  const rows = await response.json() as ExecOrder[];
  return rows[0] ?? null;
}

export async function updateOrder(id: number, patch: Partial<ExecOrder>) {
  const config = cfg();
  const response = await supabaseFetch(`${config.url}/rest/v1/twm_exec_orders?id=eq.${id}`, {
    method: "PATCH",
    headers: supabaseHeaders(config, { Prefer: "return=minimal" }),
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Order update failed"));
}

export async function loadActiveOrders(mode: Exclude<ExecutionMode, "OFF">): Promise<ExecOrder[]> {
  const config = cfg();
  const response = await supabaseFetch(`${config.url}/rest/v1/twm_exec_orders?mode=eq.${mode}&status=in.(PENDING_SUBMIT,SUBMITTED,OPEN)&order=created_at.asc`, { headers: supabaseHeaders(config), cache: "no-store" });
  if (!response.ok) throw new Error(await supabaseError(response, "Active order load failed"));
  return response.json() as Promise<ExecOrder[]>;
}

export async function loadRecentOrders(limit = 30): Promise<ExecOrder[]> {
  const config = cfg();
  const response = await supabaseFetch(`${config.url}/rest/v1/twm_exec_orders?order=created_at.desc&limit=${limit}`, { headers: supabaseHeaders(config), cache: "no-store" });
  if (!response.ok) throw new Error(await supabaseError(response, "Recent order load failed"));
  return response.json() as Promise<ExecOrder[]>;
}

export async function realizedLossGbp(mode: Exclude<ExecutionMode, "OFF">, days = 30) {
  const config = cfg();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const response = await supabaseFetch(`${config.url}/rest/v1/twm_exec_orders?select=pnl_usd,usd_per_gbp&mode=eq.${mode}&status=eq.CLOSED&closed_at=gte.${since}`, { headers: supabaseHeaders(config), cache: "no-store" });
  if (!response.ok) throw new Error(await supabaseError(response, "PnL load failed"));
  const rows = await response.json() as Array<{ pnl_usd: number | null; usd_per_gbp: number }>;
  const netGbp = rows.reduce((sum, r) => sum + (Number(r.pnl_usd ?? 0) / Math.max(0.5, Number(r.usd_per_gbp) || 1.25)), 0);
  return Math.max(0, -netGbp);
}

export type ExecState = { halted: boolean; reason: string | null; last_run: unknown; updated_at: string };

export async function loadExecState(): Promise<ExecState> {
  const config = cfg();
  const response = await supabaseFetch(`${config.url}/rest/v1/twm_exec_state?id=eq.owner&select=*`, { headers: supabaseHeaders(config), cache: "no-store" });
  if (!response.ok) throw new Error(await supabaseError(response, "Execution state load failed"));
  const rows = await response.json() as ExecState[];
  return rows[0] ?? { halted: false, reason: null, last_run: null, updated_at: new Date(0).toISOString() };
}

export async function saveExecState(patch: Partial<Omit<ExecState, "updated_at">>) {
  const config = cfg();
  const response = await supabaseFetch(`${config.url}/rest/v1/twm_exec_state?on_conflict=id`, {
    method: "POST",
    headers: supabaseHeaders(config, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ id: "owner", ...patch, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Execution state save failed"));
}
