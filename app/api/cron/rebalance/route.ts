import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/server/auth";
import { runRebalanceCron } from "@/lib/server/rebalance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Weekdays during London market hours. Proposes (or, with REBALANCE_AUTO=on, executes) the monthly ISA rebalance. */
export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try { return NextResponse.json(await runRebalanceCron()); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Rebalance cron failed." }, { status: 500 }); }
}
