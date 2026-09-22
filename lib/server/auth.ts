import type { NextRequest } from "next/server";

export function isOwnerAuthorized(request: NextRequest) {
  const expected = process.env.APP_ACCESS_CODE?.trim();
  if (!expected) return true;
  const supplied = request.headers.get("x-tradeswithme-access")?.trim();
  return Boolean(supplied && supplied === expected);
}

export function isCronAuthorized(request: NextRequest) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${expected}`;
}
