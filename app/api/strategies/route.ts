import { NextRequest, NextResponse } from "next/server";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { loadStrategyReport } from "@/lib/server/strategies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  try {
    return NextResponse.json(await loadStrategyReport(request.nextUrl.searchParams.get("refresh") === "1"));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Strategies unavailable." }, { status: 500 });
  }
}
