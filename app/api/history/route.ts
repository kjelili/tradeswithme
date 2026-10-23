import { NextRequest, NextResponse } from "next/server";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { loadPersistedScans } from "@/lib/server/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  try {
    return NextResponse.json(await loadPersistedScans(12));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "History load failed." }, { status: 500 });
  }
}
