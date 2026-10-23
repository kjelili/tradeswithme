import { NextRequest, NextResponse } from "next/server";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { loadValidationSummary, settlePendingSignals } from "@/lib/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  try {
    await settlePendingSignals();
    return NextResponse.json(await loadValidationSummary());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Validation load failed." }, { status: 500 });
  }
}
