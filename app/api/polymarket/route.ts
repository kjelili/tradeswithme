import { NextRequest, NextResponse } from "next/server";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { continueScan, loadReport, startScan } from "@/lib/server/polymarket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const deny = () => NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });

export async function GET(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return deny();
  try { return NextResponse.json(await loadReport()); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Report unavailable." }, { status: 500 }); }
}

/** {action:"start"} queues the top wallets; {action:"continue"} analyses the next batch (~3 min). */
export async function POST(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return deny();
  const body = await request.json().catch(() => ({})) as { action?: string };
  try {
    if (body.action === "start") { const q = await startScan(); const c = await continueScan(200_000); return NextResponse.json({ ...q, ...c }); }
    return NextResponse.json(await continueScan(240_000));
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Scan failed." }, { status: 500 }); }
}
