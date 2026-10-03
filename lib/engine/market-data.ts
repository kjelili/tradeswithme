import { ENGINE } from "./config";
import { equitySessionLag, expectedCompletedEquitySession } from "./quality";
import type { AssetClass, MarketSource, PriceBar } from "./types";
const KRAKEN_BASE_ALIASES: Record<string, string> = { BTC: "XBT", DOGE: "XDG" };

function yyyymmdd(date: Date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function unixSeconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

export function cleanSymbol(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,12}$/.test(normalized)) throw new Error(`Unsupported symbol: ${symbol}`);
  return normalized;
}

export function assetClassForSymbol(rawSymbol: string): AssetClass {
  const symbol = cleanSymbol(rawSymbol);
  // Crypto watchlists use BASE-USD notation. This intentionally allows new Kraken-supported
  // USD pairs to be monitored without requiring a code release for every new asset.
  return /^[A-Z0-9]+-USD$/.test(symbol) ? "CRYPTO" : "EQUITY";
}

function parseCsv(csv: string): PriceBar[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 3 || !lines[0].toLowerCase().includes("date")) return [];
  const bars: PriceBar[] = [];
  for (const line of lines.slice(1)) {
    const [date, open, high, low, close, volume] = line.split(",");
    const bar = {
      date,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume || 0),
    };
    if (bar.date && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) && bar.close > 0) bars.push(bar);
  }
  return dedupeBars(bars);
}

function dedupeBars(input: PriceBar[]) {
  return [...new Map(input.map((bar) => [bar.date, bar])).values()].sort((a, b) => a.date.localeCompare(b.date));
}

function nyClock() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  const minutes = Number(value("hour")) * 60 + Number(value("minute"));
  return { date, minutes, weekday: value("weekday") };
}

function dropUncommittedUsDailyBar(bars: PriceBar[]) {
  const sorted = dedupeBars(bars);
  const last = sorted.at(-1);
  if (!last) return sorted;
  const clock = nyClock();
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(clock.weekday);
  // The daily candle is treated as incomplete until 16:15 New York time.
  if (weekday && last.date === clock.date && clock.minutes < 16 * 60 + 15) return sorted.slice(0, -1);
  return sorted;
}

function parseYahooChart(payload: unknown): PriceBar[] {
  if (!payload || typeof payload !== "object") return [];
  const chart = (payload as { chart?: { result?: unknown[]; error?: { description?: string } | null } }).chart;
  if (chart?.error) throw new Error(chart.error.description ?? "Yahoo chart error");
  const result = chart?.result?.[0] as {
    timestamp?: number[];
    indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }> };
  } | undefined;
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!timestamps.length || !quote) return [];
  const bars: PriceBar[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const open = Number(quote.open?.[i]);
    const high = Number(quote.high?.[i]);
    const low = Number(quote.low?.[i]);
    const close = Number(quote.close?.[i]);
    const volume = Number(quote.volume?.[i] ?? 0);
    const ts = Number(timestamps[i]);
    const date = Number.isFinite(ts) ? new Date(ts * 1000).toISOString().slice(0, 10) : "";
    if (date && [open, high, low, close].every(Number.isFinite) && close > 0) bars.push({ date, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return dropUncommittedUsDailyBar(bars);
}

function parseKrakenOhlc(payload: unknown): PriceBar[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as { error?: unknown[]; result?: Record<string, unknown> };
  if (Array.isArray(root.error) && root.error.length) throw new Error(String(root.error[0]));
  if (!root.result) return [];
  const pairKey = Object.keys(root.result).find((key) => key !== "last");
  if (!pairKey) return [];
  const rows = root.result[pairKey];
  if (!Array.isArray(rows)) return [];
  const bars: PriceBar[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const [time, open, high, low, close, , volume] = row;
    const timestamp = Number(time);
    const bar = {
      date: Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString().slice(0, 10) : "",
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume || 0),
    };
    if (bar.date && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) && bar.close > 0) bars.push(bar);
  }
  // Kraken documents the final OHLC row as the current, not-yet-committed candle.
  return dedupeBars(bars.slice(0, -1));
}

function hash(text: string) {
  let h = 2166136261;
  for (const char of text) {
    h ^= char.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simulatedHistory(symbol: string, count = 280): PriceBar[] {
  const random = mulberry32(hash(symbol));
  const baseMap: Record<string, number> = {
    SPY: 540, QQQ: 470, AAPL: 220, MSFT: 430, NVDA: 120, AMZN: 190, GOOGL: 175, META: 510,
    "BTC-USD": 100000, "ETH-USD": 4000, "SOL-USD": 200, "XRP-USD": 3,
  };
  let price = baseMap[symbol] ?? 80 + random() * 220;
  const crypto = assetClassForSymbol(symbol) === "CRYPTO";
  const bars: PriceBar[] = [];
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - Math.ceil(count * (crypto ? 1.05 : 1.5)));
  let drift = (random() - 0.42) * 0.0007;
  for (let i = 0; bars.length < count; i += 1) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const day = d.getUTCDay();
    if (!crypto && (day === 0 || day === 6)) continue;
    if (i % 55 === 0) drift = (random() - 0.44) * 0.001;
    const shockScale = crypto ? 0.06 : 0.035;
    const shock = (random() - 0.5) * shockScale + drift;
    const open = price * (1 + (random() - 0.5) * (crypto ? 0.015 : 0.008));
    const close = Math.max(0.0001, price * (1 + shock));
    const high = Math.max(open, close) * (1 + random() * (crypto ? 0.02 : 0.012));
    const low = Math.min(open, close) * (1 - random() * (crypto ? 0.02 : 0.012));
    const volume = Math.round(2_000_000 + random() * 40_000_000);
    bars.push({ date: d.toISOString().slice(0, 10), open, high, low, close, volume });
    price = close;
  }
  return bars;
}

async function fetchWithTimeout(url: string, timeoutMs = 9000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TradesWithMe/0.6; +https://tradeswithme.com)",
        "Accept": "application/json,text/csv,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeout);
  }
}

let krakenPairCache: Record<string, string> | null = null;

async function loadKrakenPairMap() {
  if (krakenPairCache) return krakenPairCache;
  const response = await fetchWithTimeout("https://api.kraken.com/0/public/AssetPairs", 12_000);
  if (!response.ok) throw new Error(`Kraken AssetPairs returned ${response.status}`);
  const payload = await response.json() as { error?: unknown[]; result?: Record<string, { altname?: string; wsname?: string }> };
  if (Array.isArray(payload.error) && payload.error.length) throw new Error(String(payload.error[0]));
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload.result ?? {})) {
    const alt = value.altname?.toUpperCase();
    const ws = value.wsname?.toUpperCase().replace("/", "");
    if (alt) map[alt] = alt;
    if (ws) map[ws] = alt ?? key;
  }
  krakenPairCache = map;
  return map;
}

async function fetchKrakenOhlc(pair: string) {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=1440`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Kraken returned ${response.status}`);
  const bars = parseKrakenOhlc(await response.json());
  if (bars.length < ENGINE.minimumBars) throw new Error(`Only ${bars.length} daily bars returned`);
  return bars;
}

async function getCryptoHistory(symbol: string): Promise<{ symbol: string; source: MarketSource; bars: PriceBar[]; warning?: string }> {
  const base = symbol.replace(/-USD$/, "");
  const krakenBase = KRAKEN_BASE_ALIASES[base] ?? base;
  const directPair = `${krakenBase}USD`;
  const failures: string[] = [];
  try {
    const bars = await fetchKrakenOhlc(directPair);
    return { symbol, source: "KRAKEN_CRYPTO_DAILY", bars };
  } catch (error) {
    failures.push(`direct ${directPair}: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  // Newer Kraken listings do not always share the obvious REST pair code. Resolve against
  // AssetPairs before giving up so the expanded crypto universe remains fail-closed but flexible.
  try {
    const pairs = await loadKrakenPairMap();
    const resolved = pairs[`${krakenBase}USD`] ?? pairs[`${base}USD`];
    if (resolved && resolved !== directPair) {
      const bars = await fetchKrakenOhlc(resolved);
      return { symbol, source: "KRAKEN_CRYPTO_DAILY", bars, warning: `${symbol} used Kraken resolved pair ${resolved}.` };
    }
  } catch (error) {
    failures.push(`pair resolver: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  return {
    symbol,
    source: "SIMULATED_FALLBACK",
    bars: simulatedHistory(symbol),
    warning: `Real crypto data unavailable for ${symbol}; using simulated fallback (${failures.join("; ")}). Do not act on fallback signals.`,
  };
}

async function getYahooEquityHistory(symbol: string, host = "query1.finance.yahoo.com") {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end.getTime() - ENGINE.historyCalendarDays * 86_400_000);
  const yahooSymbol = symbol.replaceAll(".", "-");
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${unixSeconds(start)}&period2=${unixSeconds(end)}&interval=1d&includePrePost=false&events=div%2Csplits`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Yahoo chart returned ${response.status}`);
  const bars = parseYahooChart(await response.json());
  if (bars.length < ENGINE.minimumBars) throw new Error(`Yahoo chart returned only ${bars.length} completed daily bars`);
  return bars;
}

function parseAlphaVantageDaily(payload: unknown): PriceBar[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const note = root.Note ?? root.Information ?? root["Error Message"];
  if (note) throw new Error(String(note));
  const series = root["Time Series (Daily)"];
  if (!series || typeof series !== "object") return [];
  const bars: PriceBar[] = [];
  for (const [date, raw] of Object.entries(series as Record<string, Record<string, string>>)) {
    const open = Number(raw["1. open"]);
    const high = Number(raw["2. high"]);
    const low = Number(raw["3. low"]);
    const close = Number(raw["4. close"]);
    const volume = Number(raw["5. volume"] ?? 0);
    if ([open, high, low, close].every(Number.isFinite) && close > 0) bars.push({ date, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return dropUncommittedUsDailyBar(dedupeBars(bars));
}

async function getAlphaVantagePatch(symbol: string) {
  const key = process.env.ALPHAVANTAGE_API_KEY?.trim();
  if (!key) throw new Error("ALPHAVANTAGE_API_KEY is not configured");
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${encodeURIComponent(key)}`;
  const response = await fetchWithTimeout(url, 12_000);
  if (!response.ok) throw new Error(`Alpha Vantage returned ${response.status}`);
  const bars = parseAlphaVantageDaily(await response.json());
  if (!bars.length) throw new Error("Alpha Vantage returned no daily bars");
  return bars;
}

function latestBarDate(bars: PriceBar[]) {
  return bars.at(-1)?.date ?? "0000-00-00";
}

function mergeBars(base: PriceBar[], patch: PriceBar[]) {
  return dedupeBars([...base, ...patch]);
}

async function getStooqEquityHistory(symbol: string) {
  const end = new Date();
  const start = new Date();
  start.setUTCDate(end.getUTCDate() - ENGINE.historyCalendarDays);
  const stooqSymbol = `${symbol.toLowerCase().replaceAll(".", "-")}.us`;
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&d1=${yyyymmdd(start)}&d2=${yyyymmdd(end)}&i=d`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Stooq returned ${response.status}`);
  const bars = dropUncommittedUsDailyBar(parseCsv(await response.text()));
  if (bars.length < ENGINE.minimumBars) throw new Error(`Stooq returned only ${bars.length} completed daily bars`);
  return bars;
}

async function getEquityHistory(symbol: string): Promise<{ symbol: string; source: MarketSource; bars: PriceBar[]; warning?: string }> {
  const expected = expectedCompletedEquitySession();
  const failures: string[] = [];
  let best: { source: MarketSource; bars: PriceBar[]; label: string } | null = null;

  const consider = (source: MarketSource, bars: PriceBar[], label: string) => {
    if (!best || latestBarDate(bars) > latestBarDate(best.bars)) best = { source, bars, label };
    return equitySessionLag(latestBarDate(bars), expected) === 0;
  };

  try {
    const bars = await getYahooEquityHistory(symbol, "query1.finance.yahoo.com");
    if (consider("YAHOO_CHART_DAILY", bars, "Yahoo primary")) return { symbol, source: "YAHOO_CHART_DAILY", bars };
  } catch (error) {
    failures.push(`Yahoo primary: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  // If Yahoo is stale or unavailable, check an independent EOD source instead of accepting stale data.
  try {
    const bars = await getStooqEquityHistory(symbol);
    if (consider("STOOQ_EOD", bars, "Stooq backup")) {
      return { symbol, source: "STOOQ_EOD", bars, warning: `Yahoo was unavailable or stale for ${symbol}; verified Stooq backup was used.` };
    }
  } catch (error) {
    failures.push(`Stooq: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  // Yahoo exposes two chart hosts. The mirror is useful when one edge/cache is stale.
  try {
    const bars = await getYahooEquityHistory(symbol, "query2.finance.yahoo.com");
    if (consider("YAHOO_CHART_DAILY", bars, "Yahoo mirror")) {
      return { symbol, source: "YAHOO_CHART_DAILY", bars, warning: `Yahoo primary was unavailable or stale for ${symbol}; the Yahoo mirror supplied the verified session.` };
    }
  } catch (error) {
    failures.push(`Yahoo mirror: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  // The benchmark controls the entire equity regime. Use the already-configured Alpha Vantage
  // key only as a compact freshness patch for SPY so a delayed public feed cannot disable the
  // whole equity regime. The long history still comes from Yahoo/Stooq.
  const freshest = best as { source: MarketSource; bars: PriceBar[]; label: string } | null;

  if (symbol === "SPY" && freshest) {
    try {
      const patch = await getAlphaVantagePatch(symbol);
      const merged = mergeBars(freshest.bars, patch);
      if (equitySessionLag(latestBarDate(merged), expected) === 0 && merged.length >= ENGINE.minimumBars) {
        return {
          symbol,
          source: "ALPHAVANTAGE_PATCHED_DAILY",
          bars: merged,
          warning: `SPY benchmark freshness was rescued with an Alpha Vantage compact daily patch; long-history bars remain from ${freshest.label}.`,
        };
      }
    } catch (error) {
      failures.push(`Alpha Vantage SPY patch: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  // Return the freshest real history for research diagnostics, but the strict quality gate will
  // still block BUY_SETUP decisions while it is behind the expected US session.
  if (freshest) {
    const lag = equitySessionLag(latestBarDate(freshest.bars), expected);
    return {
      symbol,
      source: freshest.source,
      bars: freshest.bars,
      warning: `Verified ${freshest.label} history for ${symbol} is ${lag} US session(s) behind expected ${expected}; research-only until a fresh completed session is available.${failures.length ? ` (${failures.join("; ")})` : ""}`,
    };
  }

  return {
    symbol,
    source: "SIMULATED_FALLBACK",
    bars: simulatedHistory(symbol),
    warning: `Verified equity data unavailable for ${symbol}; simulated fallback is display-only (${failures.join("; ")}). No equity trade or regime decision is permitted from fallback data.`,
  };
}

export async function getHistory(rawSymbol: string): Promise<{ symbol: string; source: MarketSource; bars: PriceBar[]; warning?: string }> {
  const symbol = cleanSymbol(rawSymbol);
  return assetClassForSymbol(symbol) === "CRYPTO" ? getCryptoHistory(symbol) : getEquityHistory(symbol);
}
