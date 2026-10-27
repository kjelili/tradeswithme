// Decides when to email the monthly allocation signal (V5.7). Pure for testing.
import { describeWeights, UCITS_EQUIVALENT, type StrategyResult, type Weights } from "./allocation";

export type AlertState = { month: string | null; holdings: Record<string, Weights>; dailyTrend: Weights | null };
export const FEATURED = ["ensemble", "blend_spy_rot", "rot_top2_12", "hold_global"];

const same = (a: Weights | null | undefined, b: Weights | null | undefined) => describeWeights(a ?? {}) === describeWeights(b ?? {});

export function implementation(w: Weights) {
  return Object.entries(w).filter(([, v]) => v > 0.001).map(([t, v]) => `${Math.round(v * 100)}% → ${UCITS_EQUIVALENT[t] ?? t}`).join("; ");
}

export function planStrategyAlert(state: AlertState, report: { asOf: string; results: StrategyResult[] }, now: Date) {
  const month = now.toISOString().slice(0, 7);
  const byId = new Map(report.results.map((r) => [r.id, r]));
  const lines: string[] = [];
  let send = false;
  let subject = "";
  const next: AlertState = { month: state.month, holdings: { ...state.holdings }, dailyTrend: state.dailyTrend };

  // Monthly: once the data includes the previous month's final close, publish this month's positions.
  const monthEndReady = report.asOf.slice(0, 7) < month;
  if (monthEndReady && state.month !== month) {
    send = true;
    subject = `Monthly allocation signal — ${month}`;
    lines.push(`Data to ${report.asOf} (last close of the month). Positions to hold for ${month}:`, "");
    for (const id of FEATURED) {
      const r = byId.get(id);
      if (!r) continue;
      const w = r.ifCheckedToday;
      const changed = !same(state.holdings[id], w);
      lines.push(`• ${r.name}: ${describeWeights(w)}${state.month ? (changed ? "  ← CHANGE" : "  (no change)") : ""}`);
      lines.push(`    ISA: ${implementation(w)}`);
      next.holdings[id] = w;
    }
    lines.push("", "Rules-based research, not financial advice. Results were tested in USD on US-listed proxies; UK trackers in GBP also move with the exchange rate.");
    next.month = month;
  }

  // First run mid-month: send today's starting positions once, so you can begin now.
  if (!send && state.month === null && Object.keys(state.holdings).length === 0) {
    send = true;
    subject = "Allocation signals are live — starting positions";
    lines.push(`Data to ${report.asOf}. If you start today, these are the current positions (next review: first trading day of next month):`, "");
    for (const id of FEATURED) {
      const r = byId.get(id);
      if (!r) continue;
      lines.push(`• ${r.name}: ${describeWeights(r.holding)}`, `    ISA: ${implementation(r.holding)}`);
      next.holdings[id] = r.holding;
    }
    lines.push("", "Rules-based research, not financial advice.");
  }

  // Daily trend rule: alert only when it flips.
  const daily = byId.get("trend200_daily");
  if (daily) {
    if (state.dailyTrend && !same(state.dailyTrend, daily.holding)) {
      send = true;
      subject ||= `S&P 500 200-day rule flipped → ${describeWeights(daily.holding)}`;
      lines.push("", `Daily 200-day rule flipped on ${daily.holdingSince}: now ${describeWeights(daily.holding)} (was ${describeWeights(state.dailyTrend)}).`);
    }
    next.dailyTrend = daily.holding;
  }
  return { send, subject, lines, next };
}
