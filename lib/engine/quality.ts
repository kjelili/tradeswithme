import type { AssetClass, DataQuality, MarketSource, PriceBar } from "./types";

const DAY_MS = 86_400_000;

function parseDate(date: string) {
  return new Date(`${date}T00:00:00Z`);
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string) {
  return Math.round(Math.abs(parseDate(a).getTime() - parseDate(b).getTime()) / DAY_MS);
}

function addDays(date: Date, days: number) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function nthWeekday(year: number, month: number, weekday: number, nth: number) {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (7 + weekday - first.getUTCDay()) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (nth - 1) * 7));
}

function lastWeekday(year: number, month: number, weekday: number) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const offset = (7 + last.getUTCDay() - weekday) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - offset));
}

function observedFixedHoliday(year: number, month: number, day: number) {
  const actual = new Date(Date.UTC(year, month, day));
  if (actual.getUTCDay() === 6) return addDays(actual, -1);
  if (actual.getUTCDay() === 0) return addDays(actual, 1);
  return actual;
}

function easterSunday(year: number) {
  // Gregorian computus (Meeus/Jones/Butcher), sufficient for NYSE Good Friday detection.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month, day));
}

function usMarketHolidaySet(year: number) {
  const holidays = [
    observedFixedHoliday(year, 0, 1),
    nthWeekday(year, 0, 1, 3), // MLK
    nthWeekday(year, 1, 1, 3), // Presidents Day
    addDays(easterSunday(year), -2), // Good Friday
    lastWeekday(year, 4, 1), // Memorial Day
    observedFixedHoliday(year, 5, 19), // Juneteenth
    observedFixedHoliday(year, 6, 4), // Independence Day
    nthWeekday(year, 8, 1, 1), // Labor Day
    nthWeekday(year, 10, 4, 4), // Thanksgiving
    observedFixedHoliday(year, 11, 25), // Christmas
  ];
  return new Set(holidays.map(isoDate));
}

function isUsTradingSession(date: Date) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const current = isoDate(date);
  const holidays = new Set<string>();
  for (const year of [date.getUTCFullYear() - 1, date.getUTCFullYear(), date.getUTCFullYear() + 1]) {
    for (const holiday of usMarketHolidaySet(year)) holidays.add(holiday);
  }
  return !holidays.has(current);
}

function previousUsTradingSession(date: Date) {
  let cursor = addDays(date, -1);
  for (let i = 0; i < 10; i += 1) {
    if (isUsTradingSession(cursor)) return cursor;
    cursor = addDays(cursor, -1);
  }
  return cursor;
}

/**
 * Latest US session that should reasonably have a completed daily bar.
 * We use America/New_York wall time and only expect today's session after 16:15 ET,
 * giving public EOD feeds a small publication buffer after the closing bell.
 */
export function expectedCompletedEquitySession(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const nyDate = new Date(Date.UTC(value("year"), value("month") - 1, value("day")));
  const minutes = value("hour") * 60 + value("minute");
  if (isUsTradingSession(nyDate) && minutes >= 16 * 60 + 15) return isoDate(nyDate);
  return isoDate(previousUsTradingSession(nyDate));
}

export function equitySessionLag(lastBarDate: string, expectedSessionDate: string) {
  if (lastBarDate >= expectedSessionDate) return 0;
  let cursor = parseDate(lastBarDate);
  const expected = parseDate(expectedSessionDate);
  let sessions = 0;
  for (let i = 0; i < 20 && cursor < expected; i += 1) {
    cursor = addDays(cursor, 1);
    if (isUsTradingSession(cursor)) sessions += 1;
  }
  return sessions;
}

function grade(score: number): DataQuality["grade"] {
  if (score >= 90) return "A";
  if (score >= 78) return "B";
  if (score >= 64) return "C";
  if (score >= 45) return "D";
  return "F";
}

export function assessDataQuality(
  source: MarketSource,
  bars: PriceBar[],
  assetClass: AssetClass,
  expectedEquitySession = assetClass === "EQUITY" ? expectedCompletedEquitySession() : null,
): DataQuality {
  const last = bars.at(-1)?.date ?? new Date(0).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const freshnessDays = daysBetween(last, today);
  const freshnessSessions = assetClass === "EQUITY" && expectedEquitySession
    ? equitySessionLag(last, expectedEquitySession)
    : null;
  const sourceReliable = source !== "SIMULATED_FALLBACK";
  const barScore = Math.min(25, Math.max(0, (bars.length - 160) / 8));
  const freshnessScore = assetClass === "EQUITY"
    ? freshnessSessions === 0 ? 25 : freshnessSessions === 1 ? 9 : 0
    : freshnessDays <= 2 ? 25 : Math.max(0, 25 - (freshnessDays - 2) * 10);
  const sourceScore = sourceReliable ? 50 : 0;
  const score = Math.round(Math.max(0, Math.min(100, sourceScore + barScore + freshnessScore)));
  const notes: string[] = [];
  if (!sourceReliable) notes.push("Fallback data cannot support an actionable trade.");
  if (assetClass === "EQUITY" && freshnessSessions != null && freshnessSessions > 0) {
    notes.push(`Latest equity bar is ${freshnessSessions} completed US trading session(s) behind the expected ${expectedEquitySession} session.`);
  }
  if (assetClass === "CRYPTO" && freshnessDays > 2) notes.push(`Latest completed crypto bar is ${freshnessDays} calendar days old.`);
  if (bars.length < 260) notes.push(`Only ${bars.length} bars are available, reducing long-horizon validation depth.`);
  if (!notes.length) notes.push(assetClass === "EQUITY"
    ? `Source, history depth and latest expected US session (${expectedEquitySession}) pass the V5 quality checks.`
    : "Source, history depth and freshness pass the V5 quality checks.");
  return {
    score,
    grade: grade(score),
    freshnessDays,
    freshnessSessions,
    expectedAsOf: expectedEquitySession,
    bars: bars.length,
    sourceReliable,
    notes,
  };
}
