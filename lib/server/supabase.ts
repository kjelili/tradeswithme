export type SupabaseServerConfig = { url: string; key: string; keyKind: "OPAQUE_SECRET" };

export function supabaseConfig(): SupabaseServerConfig | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) return null;
  if (!key.startsWith("sb_secret_")) {
    throw new Error("SUPABASE_SECRET_KEY must be a Supabase sb_secret_ key from the same project as SUPABASE_URL.");
  }
  return { url, key, keyKind: "OPAQUE_SECRET" };
}

export function supabaseHeaders(config: { key: string }, extra: Record<string, string> = {}) {
  // V4.1.4 supports only Supabase's opaque sb_secret_* server keys.
  // Never emit an Authorization: Bearer header to PostgREST.
  return {
    apikey: config.key,
    "Content-Type": "application/json",
    ...extra,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFutureJwtError(status: number, body: string) {
  if (status !== 401) return false;
  const normalized = body.toLowerCase();
  return normalized.includes("pgrst303") && normalized.includes("jwt issued at future");
}

/**
 * Supabase's Data API sits in front of PostgREST. In production we observed an
 * intermittent PGRST303 "JWT issued at future" response even while using only
 * an opaque sb_secret_* API key. That means the failure is downstream of this
 * app's credential format. Retry only that exact transient auth condition.
 *
 * We deliberately do NOT retry arbitrary 401s or other failures, so a wrong key,
 * wrong project URL, RLS/grant error, or malformed request still fails closed.
 */
export async function supabaseFetch(input: string | URL | Request, init?: RequestInit) {
  const waits = [0, 1500, 3000, 5500];
  let last: Response | null = null;

  for (let attempt = 0; attempt < waits.length; attempt += 1) {
    if (waits[attempt] > 0) await sleep(waits[attempt]);
    const response = await fetch(input, init);
    last = response;
    if (response.status !== 401) return response;

    const body = await response.clone().text().catch(() => "");
    if (!isFutureJwtError(response.status, body)) return response;

    console.warn(`Supabase transient PGRST303 retry ${attempt + 1}/${waits.length}`, {
      status: response.status,
      retrying: attempt < waits.length - 1,
    });
  }

  return last as Response;
}

export async function supabaseError(response: Response, label: string) {
  const body = await response.text().catch(() => "");
  const compact = body.replace(/\s+/g, " ").slice(0, 260);
  return `${label} (${response.status})${compact ? `: ${compact}` : ""}`;
}
