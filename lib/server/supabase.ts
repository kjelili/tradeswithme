export type SupabaseServerConfig = { url: string; key: string; keyKind: "OPAQUE_SECRET" | "LEGACY_JWT" | "OTHER" };

export function supabaseConfig(): SupabaseServerConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = (process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) return null;
  const keyKind = key.startsWith("sb_secret_")
    ? "OPAQUE_SECRET"
    : key.startsWith("eyJ")
      ? "LEGACY_JWT"
      : "OTHER";
  return { url, key, keyKind };
}

export function supabaseHeaders(config: { key: string; keyKind?: SupabaseServerConfig["keyKind"] }, extra: Record<string, string> = {}) {
  // New Supabase sb_secret_* keys are opaque API keys, not JWTs. Supabase recommends
  // sending them in `apikey` only. Legacy service_role JWTs can also be sent as Bearer.
  const keyKind = config.keyKind ?? (config.key.startsWith("sb_secret_") ? "OPAQUE_SECRET" : config.key.startsWith("eyJ") ? "LEGACY_JWT" : "OTHER");
  const base: Record<string, string> = {
    apikey: config.key,
    "Content-Type": "application/json",
  };
  if (keyKind === "LEGACY_JWT") base.Authorization = `Bearer ${config.key}`;
  return { ...base, ...extra };
}

export async function supabaseError(response: Response, label: string) {
  const body = await response.text().catch(() => "");
  const compact = body.replace(/\s+/g, " ").slice(0, 260);
  return `${label} (${response.status})${compact ? `: ${compact}` : ""}`;
}
