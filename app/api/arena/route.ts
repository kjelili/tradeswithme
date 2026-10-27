import { NextRequest, NextResponse } from "next/server";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { loadArena, runArena } from "@/lib/server/arena";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const deny = () => NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });

export async function GET(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return deny();
  try { return NextResponse.json(await loadArena()); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Arena unavailable." }, { status: 500 }); }
}

/** Runs today's decisions now (idempotent: agents that already decided for this close are skipped). */
export async function POST(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return deny();
  try { return NextResponse.json(await runArena()); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Arena run failed." }, { status: 500 }); }
}
