import { NextRequest, NextResponse } from "next/server";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { loadLearningObservatory } from "@/lib/server/observatory";
import { loadLearningPolicy } from "@/lib/server/learning";
import { loadValidationSummary } from "@/lib/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  try {
    const [{ observatory, latestScan }, learning, validation] = await Promise.all([
      loadLearningObservatory(),
      loadLearningPolicy(),
      loadValidationSummary(),
    ]);
    return NextResponse.json({ observatory, latestScan, learning, validation });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Observatory load failed." }, { status: 500 });
  }
}
