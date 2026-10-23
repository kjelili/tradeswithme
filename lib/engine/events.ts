import { ENGINE } from "./config";
import type { AssetClass, EventRisk, IndicatorSnapshot } from "./types";

type EarningsMap = Map<string, string>;

function parseCsvLine(line: string) {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      out.push(current.trim()); current = "";
    } else current += char;
  }
  out.push(current.trim());
  return out;
}

export async function loadEarningsCalendar(): Promise<{ configured: boolean; calendar: EarningsMap; warning?: string }> {
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (!key) return { configured: false, calendar: new Map() };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const url = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=${encodeURIComponent(key)}`;
    const response = await fetch(url, { signal: controller.signal, cache: "no-store", headers: { "User-Agent": "TradesWithMe/0.6" } });
    if (!response.ok) throw new Error(`earnings endpoint returned ${response.status}`);
    const text = await response.text();
    if (!text.includes("symbol") || !text.includes("reportDate")) throw new Error("earnings endpoint did not return a calendar CSV");
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    const header = parseCsvLine(lines[0]);
    const symbolIndex = header.indexOf("symbol");
    const dateIndex = header.indexOf("reportDate");
    if (symbolIndex < 0 || dateIndex < 0) throw new Error("earnings CSV columns were not recognized");
    const calendar = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const row = parseCsvLine(line);
      const symbol = row[symbolIndex]?.toUpperCase();
      const date = row[dateIndex];
      if (symbol && /^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) calendar.set(symbol, date);
    }
    return { configured: true, calendar };
  } catch (error) {
    return { configured: true, calendar: new Map(), warning: `Earnings calendar unavailable: ${error instanceof Error ? error.message : "unknown error"}.` };
  } finally {
    clearTimeout(timeout);
  }
}

function calendarDaysAway(date: string) {
  const today = new Date();
  const utcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const event = new Date(`${date}T00:00:00Z`).getTime();
  return Math.ceil((event - utcToday) / 86_400_000);
}

export function eventRiskFor(
  symbol: string,
  assetClass: AssetClass,
  indicators: IndicatorSnapshot,
  earnings: { configured: boolean; calendar: EarningsMap },
): EventRisk {
  if (assetClass === "CRYPTO") {
    const anomaly = Math.abs(indicators.changePct ?? 0) >= Math.max(8, (indicators.atrPct ?? 3) * 2.2) || (indicators.volumeRatio20 ?? 1) >= 3;
    return anomaly
      ? { level: "CAUTION", reason: "Large price/volume anomaly detected; treat as event-like risk and verify current news before acting.", eventDate: null, daysAway: null, source: "PRICE_ANOMALY" }
      : { level: "CLEAR", reason: "No large daily price/volume anomaly detected. Crypto still trades continuously and can gap on news.", eventDate: null, daysAway: null, source: "NONE" };
  }

  const date = earnings.calendar.get(symbol);
  if (date) {
    const days = calendarDaysAway(date);
    if (days >= 0 && days <= ENGINE.eventBlockDays) return { level: "BLOCK", reason: `Earnings are scheduled in ${days} day${days === 1 ? "" : "s"}; new overnight entry is blocked.`, eventDate: date, daysAway: days, source: "ALPHA_VANTAGE_EARNINGS" };
    if (days >= 0 && days <= ENGINE.eventCautionDays) return { level: "CAUTION", reason: `Earnings are scheduled in ${days} days; confidence is reduced and manual review is required.`, eventDate: date, daysAway: days, source: "ALPHA_VANTAGE_EARNINGS" };
  }

  const anomaly = Math.abs(indicators.changePct ?? 0) >= Math.max(5, (indicators.atrPct ?? 2) * 2.2) || (indicators.volumeRatio20 ?? 1) >= 2.8;
  if (anomaly) return { level: "CAUTION", reason: "Unusual price/volume behavior detected; verify company news before any order.", eventDate: date ?? null, daysAway: date ? calendarDaysAway(date) : null, source: "PRICE_ANOMALY" };
  if (!earnings.configured) return { level: "UNVERIFIED", reason: "Earnings calendar API is not configured. Verify earnings/news manually before trading.", eventDate: null, daysAway: null, source: "UNCONFIGURED" };
  return { level: "CLEAR", reason: "No near-term earnings event or large price/volume anomaly was detected by configured checks.", eventDate: date ?? null, daysAway: date ? calendarDaysAway(date) : null, source: "NONE" };
}
