// Persistence for the agent activity log shown on the owner desk (V5.5).
import type { ActivityLine } from "@/lib/engine/funnel";
import { supabaseConfig, supabaseError, supabaseFetch, supabaseHeaders } from "./supabase";

export type ActivityRow = ActivityLine & { id: number; run_at: string; created_at: string };

export async function persistActivity(runAt: string, lines: ActivityLine[]) {
  const config = supabaseConfig();
  if (!config || !lines.length) return false;
  const response = await supabaseFetch(`${config.url}/rest/v1/twm_activity_log`, {
    method: "POST",
    headers: supabaseHeaders(config, { Prefer: "return=minimal" }),
    body: JSON.stringify(lines.map((l) => ({ run_at: runAt, agent: l.agent, level: l.level, message: l.message }))),
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Activity log write failed"));
  return true;
}

export async function loadActivity(limit = 150): Promise<ActivityRow[]> {
  const config = supabaseConfig();
  if (!config) return [];
  const response = await supabaseFetch(`${config.url}/rest/v1/twm_activity_log?select=*&order=id.desc&limit=${Math.min(500, Math.max(1, limit))}`, { headers: supabaseHeaders(config), cache: "no-store" });
  if (!response.ok) throw new Error(await supabaseError(response, "Activity log read failed"));
  return response.json() as Promise<ActivityRow[]>;
}
