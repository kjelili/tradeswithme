import { NextRequest, NextResponse } from "next/server";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { flattenAll } from "@/lib/execution/engine";
import { loadExecState, loadRecentOrders, saveExecState } from "@/lib/execution/ledger";
import { readExecutionEnv } from "@/lib/execution/policy";
import { readFilterFlags } from "@/lib/engine/edge";
import { loadValidationSummary } from "@/lib/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function publicEnv() {
  const env = readExecutionEnv();
  return {
    requestedMode: env.requestedMode,
    hardCapGbp: env.hardCapGbp,
    lossBreakerPct: env.lossBreakerPct,
    envKillSwitch: env.envKillSwitch,
    brokers: { alpacaLive: env.alpacaLiveKeys, alpacaPaper: env.alpacaPaperKeys, kraken: env.krakenKeys },
    filters: readFilterFlags(),
  };
}

export async function GET(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  try {
    const [state, orders, readiness] = await Promise.all([
      loadExecState(),
      loadRecentOrders(30),
      loadValidationSummary().then((v) => v.executionReadiness).catch(() => null),
    ]);
    return NextResponse.json({ env: publicEnv(), state, orders, readiness });
  } catch (error) {
    return NextResponse.json({ env: publicEnv(), error: error instanceof Error ? error.message : "Execution status unavailable." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { action?: string };
  try {
    if (body.action === "halt") { await saveExecState({ halted: true, reason: "Halted by owner." }); return NextResponse.json({ ok: true }); }
    if (body.action === "resume") { await saveExecState({ halted: false, reason: null }); return NextResponse.json({ ok: true }); }
    if (body.action === "flatten") return NextResponse.json({ ok: true, ...(await flattenAll()) });
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Action failed." }, { status: 500 });
  }
}
