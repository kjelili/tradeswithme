import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/server/auth";
import { runEventAgent } from "@/lib/server/event-agent";
import { continueScan } from "@/lib/server/polymarket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Every 15 minutes (GitHub Actions — Vercel Hobby crons run once a day). Runs the event agent,
 * then spends the remaining time continuing any Polymarket wallet scan.
 */
export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const t0 = Date.now();
  const out: Record<string, unknown> = {};
  try { out.agent = await runEventAgent(); } catch (e) { out.agentError = e instanceof Error ? e.message : String(e); }
  try { out.scan = await continueScan(Math.max(20_000, 240_000 - (Date.now() - t0))); } catch (e) { out.scanError = e instanceof Error ? e.message : String(e); }
  return NextResponse.json(out);
}
