import { NextRequest, NextResponse } from "next/server";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { loadLearningPolicy, trainLearningPolicy } from "@/lib/server/learning";
import { settlePendingSignals } from "@/lib/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  try {
    return NextResponse.json(await loadLearningPolicy());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Learning-state load failed." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  try {
    const settled = await settlePendingSignals();
    const trained = await trainLearningPolicy();
    return NextResponse.json({ ...trained, settled: settled.settled });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Learning run failed." }, { status: 500 });
  }
}
