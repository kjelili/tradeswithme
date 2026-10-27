import { NextRequest, NextResponse } from "next/server";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { loadActivity } from "@/lib/server/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  try {
    return NextResponse.json({ lines: await loadActivity(150) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Activity unavailable." }, { status: 500 });
  }
}
