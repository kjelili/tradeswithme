import { NextRequest, NextResponse } from "next/server";
import { supabaseConfig, supabaseError, supabaseFetch, supabaseHeaders } from "@/lib/server/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const INTERESTS = new Set(["free", "founder", "setup", "audit"]);

// Best-effort per-instance throttle. Not a security boundary; it stops casual floods.
const hits = new Map<string, { count: number; resetAt: number }>();
function throttled(ip: string) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt < now) {
    hits.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  entry.count += 1;
  return entry.count > 8;
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (throttled(ip)) return NextResponse.json({ error: "Too many requests. Try again in a few minutes." }, { status: 429 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  // Honeypot: real users never see or fill this field. Pretend success for bots.
  if (typeof body.company === "string" && body.company.trim()) return NextResponse.json({ ok: true });

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  const interest = typeof body.interest === "string" && INTERESTS.has(body.interest) ? body.interest : "free";
  const source = typeof body.source === "string" ? body.source.slice(0, 64) : "site";

  const config = supabaseConfig();
  if (!config) {
    console.error("Waitlist signup lost: Supabase is not configured.");
    return NextResponse.json({ error: "Sign-ups are temporarily unavailable. Please email us instead." }, { status: 503 });
  }

  try {
    const response = await supabaseFetch(`${config.url}/rest/v1/twm_waitlist?on_conflict=email`, {
      method: "POST",
      headers: supabaseHeaders(config, { Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ email, interest, source, updated_at: new Date().toISOString() }),
    });
    if (!response.ok) {
      console.error(await supabaseError(response, "Waitlist insert failed"));
      return NextResponse.json({ error: "Could not save your sign-up. Please try again." }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Waitlist insert error", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not save your sign-up. Please try again." }, { status: 502 });
  }
}
