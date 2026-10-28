import { NextRequest, NextResponse } from "next/server";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { loadEventAgent, runEventAgent } from "@/lib/server/event-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const deny = () => NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });

export async function GET(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return deny();
  try { return NextResponse.json(await loadEventAgent()); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Event agent unavailable." }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return deny();
  try { return NextResponse.json(await runEventAgent()); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Event agent run failed." }, { status: 500 }); }
}
