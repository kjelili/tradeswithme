import { NextRequest, NextResponse } from "next/server";
import { isOwnerAuthorized } from "@/lib/server/auth";
import { cancelPlan, createPlan, executePlan, loadPlans, rebalanceStatus } from "@/lib/server/rebalance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const deny = () => NextResponse.json({ error: "Invalid personal access code." }, { status: 401 });
const fail = (e: unknown, status = 400) => NextResponse.json({ error: e instanceof Error ? e.message : "Rebalance failed." }, { status });

export async function GET(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return deny();
  try { return NextResponse.json({ status: rebalanceStatus(), plans: await loadPlans() }); }
  catch (e) { return fail(e, 500); }
}

export async function POST(request: NextRequest) {
  if (!isOwnerAuthorized(request)) return deny();
  let body: { action?: string; id?: string } = {};
  try { body = await request.json(); } catch { /* empty */ }
  try {
    if (body.action === "plan") return NextResponse.json({ plan: await createPlan() });
    if (body.action === "approve" && body.id) return NextResponse.json({ plan: await executePlan(body.id) });
    if (body.action === "cancel" && body.id) return NextResponse.json({ plan: await cancelPlan(body.id) });
    return fail(new Error("Unknown action. Use plan, approve or cancel."));
  } catch (e) { return fail(e); }
}
