import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Owner endpoints. V5.4 fails CLOSED in production: once broker credentials can
 * exist, a missing APP_ACCESS_CODE must never mean "anyone may act as owner".
 * Local development without a code remains open for convenience.
 */
export function isOwnerAuthorized(request: NextRequest) {
  const expected = process.env.APP_ACCESS_CODE?.trim();
  if (!expected) return process.env.NODE_ENV !== "production";
  const supplied = request.headers.get("x-tradeswithme-access")?.trim();
  return Boolean(supplied && safeEqual(supplied, expected));
}

export function isCronAuthorized(request: NextRequest) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return process.env.NODE_ENV !== "production";
  const supplied = request.headers.get("authorization") ?? "";
  return safeEqual(supplied, `Bearer ${expected}`);
}
