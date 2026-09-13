import type { OwnerState, ScanResult } from "../engine/types";
import { supabaseConfig, supabaseError, supabaseHeaders as headers } from "./supabase";

export async function persistScan(scan: ScanResult) {
  const config = supabaseConfig();
  if (!config) return { persisted: false as const };
  const response = await fetch(`${config.url}/rest/v1/twm_scans`, {
    method: "POST",
    headers: headers(config, { Prefer: "return=minimal" }),
    body: JSON.stringify({ scanned_at: scan.at, regime: scan.regime, payload: scan }),
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Supabase scan persistence failed"));
  return { persisted: true as const };
}

export async function loadPersistedScans(limit = 12): Promise<{ configured: boolean; scans: ScanResult[] }> {
  const config = supabaseConfig();
  if (!config) return { configured: false, scans: [] };
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const response = await fetch(`${config.url}/rest/v1/twm_scans?select=payload&order=scanned_at.desc&limit=${safeLimit}`, {
    headers: headers(config),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Supabase history read failed"));
  const rows = await response.json() as Array<{ payload?: ScanResult }>;
  return { configured: true, scans: rows.map((row) => row.payload).filter((scan): scan is ScanResult => Boolean(scan?.at && scan?.analyses)) };
}

export async function persistOwnerState(state: Omit<OwnerState, "updatedAt">) {
  const config = supabaseConfig();
  if (!config) return { persisted: false as const };
  const updatedAt = new Date().toISOString();
  const response = await fetch(`${config.url}/rest/v1/twm_owner_state?on_conflict=id`, {
    method: "POST",
    headers: headers(config, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ id: "owner", symbols: state.symbols, positions: state.positions, settings: state.settings, updated_at: updatedAt }),
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Owner-state persistence failed"));
  return { persisted: true as const, updatedAt };
}

export async function loadOwnerState(): Promise<{ configured: boolean; state: OwnerState | null }> {
  const config = supabaseConfig();
  if (!config) return { configured: false, state: null };
  const response = await fetch(`${config.url}/rest/v1/twm_owner_state?select=symbols,positions,settings,updated_at&id=eq.owner&limit=1`, {
    headers: headers(config),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await supabaseError(response, "Owner-state read failed"));
  const rows = await response.json() as Array<{ symbols?: string[]; positions?: OwnerState["positions"]; settings?: OwnerState["settings"]; updated_at?: string }>;
  const row = rows[0];
  if (!row?.symbols || !row.settings) return { configured: true, state: null };
  return {
    configured: true,
    state: {
      symbols: row.symbols,
      positions: Array.isArray(row.positions) ? row.positions : [],
      settings: row.settings,
      updatedAt: row.updated_at ?? new Date(0).toISOString(),
    },
  };
}
