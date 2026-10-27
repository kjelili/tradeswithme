import { planStrategyAlert, type AlertState } from "@/lib/engine/strategy-alert";
import { sendAlert } from "@/lib/execution/alerts";
import { loadStrategyReport } from "./strategies";
import { supabaseConfig, supabaseError, supabaseFetch, supabaseHeaders } from "./supabase";

async function loadState(): Promise<AlertState> {
  const config = supabaseConfig();
  if (!config) return { month: null, holdings: {}, dailyTrend: null };
  const res = await supabaseFetch(`${config.url}/rest/v1/twm_strategy_signal?id=eq.owner&select=*`, { headers: supabaseHeaders(config), cache: "no-store" });
  if (!res.ok) throw new Error(await supabaseError(res, "Strategy signal state read failed"));
  const row = ((await res.json()) as Array<{ month: string | null; holdings: AlertState["holdings"] | null; daily_trend: AlertState["dailyTrend"] }>)[0];
  return { month: row?.month ?? null, holdings: row?.holdings ?? {}, dailyTrend: row?.daily_trend ?? null };
}

async function saveState(s: AlertState) {
  const config = supabaseConfig();
  if (!config) return;
  const res = await supabaseFetch(`${config.url}/rest/v1/twm_strategy_signal?on_conflict=id`, {
    method: "POST",
    headers: supabaseHeaders(config, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ id: "owner", month: s.month, holdings: s.holdings, daily_trend: s.dailyTrend, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(await supabaseError(res, "Strategy signal state write failed"));
}

/** Called from the nightly cron. Never throws into the cron. */
export async function runStrategyAlerts(now = new Date()) {
  const report = await loadStrategyReport(true);
  const state = await loadState();
  const plan = planStrategyAlert(state, report, now);
  if (plan.send) await sendAlert(plan.subject, plan.lines);
  // Save after sending: if the email fails we still advance (sendAlert never throws and logs).
  await saveState(plan.next);
  return { sent: plan.send, subject: plan.subject };
}
