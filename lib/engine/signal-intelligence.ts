import { resolveKrakenPairForSymbol } from "./market-data";
import type {
  AgentAttributionRow,
  LearningPolicy,
  MicrostructureSignal,
  OnChainFlowSignal,
  PredictionMarketSignal,
  SignalIntelligenceSummary,
  SymbolAnalysis,
  ValidationSummary,
} from "./types";

function clamp(v: number, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }
function round(v: number, d = 2) { const p = 10 ** d; return Math.round(v * p) / p; }
function mean(v: number[]) { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }

async function fetchJson(url: string, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TradesWithMe/5.2; +https://tradeswithme.com)",
        Accept: "application/json,*/*",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

const CRYPTO_NAMES: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"], ETH: ["ethereum", "eth"], SOL: ["solana", "sol"], XRP: ["xrp", "ripple"],
  DOGE: ["dogecoin", "doge"], ADA: ["cardano", "ada"], LINK: ["chainlink", "link"], AVAX: ["avalanche", "avax"],
  DOT: ["polkadot", "dot"], LTC: ["litecoin", "ltc"], BNB: ["bnb", "binance coin"], BCH: ["bitcoin cash", "bch"],
  TRX: ["tron", "trx"], XLM: ["stellar", "xlm"], HBAR: ["hedera", "hbar"], SUI: ["sui"], TON: ["toncoin", "ton"],
  NEAR: ["near protocol", "near"], AAVE: ["aave"], UNI: ["uniswap", "uni"], SHIB: ["shiba inu", "shib"], PEPE: ["pepe"],
  ICP: ["internet computer", "icp"], ATOM: ["cosmos", "atom"], ALGO: ["algorand", "algo"], FIL: ["filecoin", "fil"],
  ETC: ["ethereum classic", "etc"], XTZ: ["tezos", "xtz"],
};

const EQUITY_NAMES: Record<string, string[]> = {
  AAPL: ["apple"], MSFT: ["microsoft"], NVDA: ["nvidia"], AMZN: ["amazon"], GOOGL: ["google", "alphabet"],
  META: ["meta platforms", "facebook"], TSLA: ["tesla"], AMD: ["amd", "advanced micro devices"], AVGO: ["broadcom"], NFLX: ["netflix"],
  PLTR: ["palantir"], JPM: ["jpmorgan", "jp morgan"], BAC: ["bank of america"], XOM: ["exxon", "exxonmobil"],
};

const MACRO_TERMS = ["federal reserve", "fed rate", "interest rate", "rate cut", "inflation", "recession", "us economy", "unemployment"];

type PredictionMarketRow = { question: string; probabilityPct: number; volumeUsd: number; text: string };

function parseMaybeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}

async function loadPredictionMarkets(): Promise<{ rows: PredictionMarketRow[]; warning?: string }> {
  try {
    const payload = await fetchJson("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100", 6500);
    const sourceRows = Array.isArray(payload) ? payload : ((payload as { markets?: unknown[] })?.markets ?? []);
    const rows: PredictionMarketRow[] = [];
    for (const raw of sourceRows) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const question = String(row.question ?? row.title ?? "").trim();
      if (!question) continue;
      const outcomes = parseMaybeJsonArray(row.outcomes);
      const prices = parseMaybeJsonArray(row.outcomePrices).map(Number);
      let yesIndex = outcomes.findIndex((x) => x.toLowerCase() === "yes");
      if (yesIndex < 0) yesIndex = 0;
      const probability = Number(prices[yesIndex]);
      if (!Number.isFinite(probability)) continue;
      const volumeUsd = Number(row.volume24hr ?? row.volume24h ?? row.volume ?? 0);
      rows.push({ question, probabilityPct: clamp(probability * 100, 0, 100), volumeUsd: Number.isFinite(volumeUsd) ? volumeUsd : 0, text: question.toLowerCase() });
    }
    return { rows: rows.sort((a, b) => b.volumeUsd - a.volumeUsd) };
  } catch (error) {
    return { rows: [], warning: `Prediction-market context unavailable: ${error instanceof Error ? error.message : "unknown error"}` };
  }
}

function normalizeMarketText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function aliasMatches(text: string, alias: string) {
  const normalizedText = ` ${normalizeMarketText(text)} `;
  const normalizedAlias = normalizeMarketText(alias);
  if (!normalizedAlias) return false;
  // Short ticker-like aliases must appear as standalone tokens. This prevents AMD
  // from matching strings such as "Mamdani" and similar accidental substrings.
  return normalizedText.includes(` ${normalizedAlias} `);
}

function predictionSignalFor(analysis: SymbolAnalysis, markets: PredictionMarketRow[], sourceAvailable: boolean): PredictionMarketSignal {
  if (!sourceAvailable) return { status: "UNAVAILABLE", source: "UNAVAILABLE", probabilityPct: null, uncertaintyPct: null, volumeUsd: null, marketQuestion: null, matchedMarkets: 0, relevanceScore: 0, matchType: "NONE", matchedAlias: null, rationale: "Public prediction-market context could not be loaded. It is never required for a BUY_SETUP." };
  const base = analysis.symbol.replace(/-USD$/, "");
  const aliases = analysis.assetClass === "CRYPTO" ? (CRYPTO_NAMES[base] ?? [base.toLowerCase()]) : (EQUITY_NAMES[analysis.symbol] ?? []);
  const specific = markets.flatMap((market) => {
    const matchedAlias = aliases.find((alias) => aliasMatches(market.text, alias));
    return matchedAlias ? [{ market, matchedAlias }] : [];
  });
  if (!specific.length) {
    const macroCount = analysis.assetClass === "EQUITY" ? markets.filter((m) => MACRO_TERMS.some((term) => aliasMatches(m.text, term))).length : 0;
    return { status: "NO_MATCH", source: "POLYMARKET_PUBLIC", probabilityPct: null, uncertaintyPct: null, volumeUsd: null, marketQuestion: null, matchedMarkets: 0, relevanceScore: 0, matchType: "NONE", matchedAlias: null, rationale: macroCount ? `${macroCount} broad macro market(s) were available, but none named this asset/entity closely enough. Macro context is not assigned to an individual ticker.` : "No sufficiently relevant active prediction market was found. No score adjustment is made." };
  }
  const ranked = specific
    .map(({ market, matchedAlias }) => {
      const aliasWords = normalizeMarketText(matchedAlias).split(" ").filter(Boolean).length;
      const longNameBonus = aliasWords >= 2 ? 12 : 0;
      const tickerPenalty = matchedAlias.toLowerCase() === base.toLowerCase() && base.length <= 4 ? 5 : 0;
      const volumeBonus = Math.min(8, Math.log10(Math.max(1, market.volumeUsd + 1)) * 1.2);
      return { market, matchedAlias, relevance: clamp(78 + longNameBonus + volumeBonus - tickerPenalty, 70, 98) };
    })
    .sort((a, b) => b.relevance - a.relevance || b.market.volumeUsd - a.market.volumeUsd);
  const top = ranked[0];
  const uncertainty = 100 - Math.abs(top.market.probabilityPct - 50) * 2;
  return {
    status: "MATCHED", source: "POLYMARKET_PUBLIC", probabilityPct: round(top.market.probabilityPct, 1), uncertaintyPct: round(uncertainty, 1),
    volumeUsd: round(top.market.volumeUsd, 0), marketQuestion: top.market.question, matchedMarkets: specific.length, relevanceScore: Math.round(top.relevance), matchType: "ASSET", matchedAlias: top.matchedAlias,
    rationale: `Strict entity match via "${top.matchedAlias}". Prediction-market probability is research context only and never authorizes a trade.`,
  };
}

function marketFlowProxy(analysis: SymbolAnalysis): OnChainFlowSignal {
  if (analysis.assetClass !== "CRYPTO") return { status: "UNVERIFIED", score: 0, confidence: 0, directionalTilt: 0, source: "UNAVAILABLE", directVerified: false, whaleTransfers: 0, netExchangeFlowUsd: null, rationale: "On-chain flow is only evaluated for crypto assets." };
  const volumeRatio = analysis.indicators.volumeRatio20 ?? 1;
  const ret5 = analysis.indicators.return5Pct ?? 0;
  const ret20 = analysis.indicators.return20Pct ?? 0;
  const atrPct = analysis.indicators.atrPct ?? 0;
  const raw = Math.tanh(ret5 / 8 + ret20 / 28 + (volumeRatio - 1) * 0.65);
  const tilt = clamp(raw, -1, 1);
  const score = Math.round(clamp(50 + tilt * 32 - Math.max(0, atrPct - 12) * 0.4, 12, 88));
  const status = tilt > 0.18 ? "BULLISH" : tilt < -0.18 ? "BEARISH" : "NEUTRAL";
  return { status, score, confidence: Math.round(clamp(42 + Math.abs(tilt) * 26 + Math.min(12, Math.abs(volumeRatio - 1) * 10), 35, 72)), directionalTilt: round(tilt, 3), source: "MARKET_FLOW_PROXY", directVerified: false, whaleTransfers: 0, netExchangeFlowUsd: null, rationale: `Market-flow proxy only: ${volumeRatio.toFixed(2)}× 20D volume, ${ret5.toFixed(1)}% 5D return. This is not blockchain transfer data.` };
}

async function whaleAlertSignal(analysis: SymbolAnalysis): Promise<OnChainFlowSignal | null> {
  const key = process.env.WHALE_ALERT_API_KEY?.trim();
  if (!key || analysis.assetClass !== "CRYPTO") return null;
  const base = analysis.symbol.replace(/-USD$/, "").toLowerCase();
  const supported = new Set(["btc", "eth", "xrp", "ada", "sol", "doge", "ltc", "trx"]);
  if (!supported.has(base)) return null;
  const start = Math.floor(Date.now() / 1000) - 12 * 3600;
  const minUsd = Math.max(250000, Number(process.env.WHALE_ALERT_MIN_USD ?? "1000000"));
  try {
    const payload = await fetchJson(`https://api.whale-alert.io/v1/transactions?api_key=${encodeURIComponent(key)}&min_value=${Math.round(minUsd)}&start=${start}&currency=${encodeURIComponent(base)}`, 6500) as { transactions?: Array<Record<string, unknown>> };
    const txs = Array.isArray(payload.transactions) ? payload.transactions : [];
    if (!txs.length) return null;
    let netExchangeFlowUsd = 0;
    let gross = 0;
    for (const tx of txs) {
      const usd = Number(tx.amount_usd ?? 0);
      if (!Number.isFinite(usd) || usd <= 0) continue;
      gross += usd;
      const from = (tx.from && typeof tx.from === "object" ? tx.from : {}) as Record<string, unknown>;
      const to = (tx.to && typeof tx.to === "object" ? tx.to : {}) as Record<string, unknown>;
      const fromExchange = String(from.owner_type ?? "").toLowerCase().includes("exchange");
      const toExchange = String(to.owner_type ?? "").toLowerCase().includes("exchange");
      if (fromExchange && !toExchange) netExchangeFlowUsd += usd;
      if (!fromExchange && toExchange) netExchangeFlowUsd -= usd;
    }
    const tilt = gross ? clamp(netExchangeFlowUsd / gross, -1, 1) : 0;
    const status = tilt > 0.12 ? "BULLISH" : tilt < -0.12 ? "BEARISH" : "NEUTRAL";
    return { status, score: Math.round(clamp(50 + tilt * 40, 10, 90)), confidence: Math.round(clamp(48 + Math.min(30, txs.length * 3), 48, 82)), directionalTilt: round(tilt, 3), source: "WHALE_ALERT", directVerified: true, whaleTransfers: txs.length, netExchangeFlowUsd: round(netExchangeFlowUsd, 0), rationale: `Direct large-transfer sample: ${txs.length} transactions in the last 12h. Positive flow means observed exchange outflow exceeded inflow; classifications remain noisy and research-only.` };
  } catch {
    return null;
  }
}

function eodMicrostructureProxy(analysis: SymbolAnalysis): MicrostructureSignal {
  const proxy = analysis.executionQuality;
  if (!proxy) return { status: "UNAVAILABLE", source: "UNAVAILABLE", score: 0, liveBookVerified: false, spreadBps: null, imbalance: null, topDepthUsd: null, pressureTilt: 0, rationale: "No execution-quality proxy is available." };
  return { status: proxy.score >= 70 ? "GOOD" : proxy.score >= 50 ? "CAUTION" : "POOR", source: "EOD_PROXY", score: proxy.score, liveBookVerified: false, spreadBps: null, imbalance: null, topDepthUsd: null, pressureTilt: 0, rationale: `${proxy.rationale} Equity live order-book depth is not connected.` };
}

async function krakenMicrostructure(analysis: SymbolAnalysis): Promise<MicrostructureSignal> {
  if (analysis.assetClass !== "CRYPTO") return eodMicrostructureProxy(analysis);
  try {
    const pair = await resolveKrakenPairForSymbol(analysis.symbol);
    const payload = await fetchJson(`https://api.kraken.com/0/public/Depth?pair=${encodeURIComponent(pair)}&count=20`, 5500) as { error?: unknown[]; result?: Record<string, { asks?: unknown[][]; bids?: unknown[][] }> };
    if (Array.isArray(payload.error) && payload.error.length) throw new Error(String(payload.error[0]));
    const book = Object.values(payload.result ?? {})[0];
    const asks = Array.isArray(book?.asks) ? book.asks : [];
    const bids = Array.isArray(book?.bids) ? book.bids : [];
    const parse = (rows: unknown[][]) => rows.map((r) => ({ price: Number(r[0]), volume: Number(r[1]) })).filter((r) => Number.isFinite(r.price) && Number.isFinite(r.volume) && r.price > 0 && r.volume >= 0);
    const pa = parse(asks), pb = parse(bids);
    const bestAsk = pa[0]?.price, bestBid = pb[0]?.price;
    if (!bestAsk || !bestBid) throw new Error("empty order book");
    const mid = (bestAsk + bestBid) / 2;
    const spreadBps = (bestAsk - bestBid) / mid * 10000;
    const bidDepth = pb.slice(0, 10).reduce((s, r) => s + r.price * r.volume, 0);
    const askDepth = pa.slice(0, 10).reduce((s, r) => s + r.price * r.volume, 0);
    const totalDepth = bidDepth + askDepth;
    const imbalance = totalDepth ? (bidDepth - askDepth) / totalDepth : 0;
    const depthScore = clamp(Math.log10(Math.max(1, totalDepth)) * 11, 15, 85);
    const spreadPenalty = Math.min(55, spreadBps * 2.3);
    const score = Math.round(clamp(55 + depthScore * 0.45 - spreadPenalty, 10, 96));
    return { status: score >= 72 ? "GOOD" : score >= 50 ? "CAUTION" : "POOR", source: "KRAKEN_ORDER_BOOK", score, liveBookVerified: true, spreadBps: round(spreadBps, 2), imbalance: round(imbalance, 3), topDepthUsd: round(totalDepth, 0), pressureTilt: round(clamp(imbalance, -1, 1), 3), rationale: `Live Kraken top-10 depth proxy: ${spreadBps.toFixed(1)} bps spread, $${Math.round(totalDepth).toLocaleString()} combined depth. Order-book imbalance is transient and cannot authorize a trade.` };
  } catch (error) {
    const fallback = eodMicrostructureProxy(analysis);
    return { ...fallback, rationale: `${fallback.rationale} Kraken book unavailable (${error instanceof Error ? error.message : "unknown error"}).` };
  }
}

function attributionRows(learning?: LearningPolicy, validation?: ValidationSummary): AgentAttributionRow[] {
  const learned = learning?.segments?.GLOBAL?.agents ?? [];
  const forward = validation?.agents ?? [];
  const base: Record<string, number> = { trend: 0.30, momentum: 0.28, reversion: 0.18, breakout: 0.24 };
  return ["trend", "momentum", "reversion", "breakout"].map((id) => {
    const l = learned.find((x) => x.id === id);
    const f = forward.find((x) => x.id === id);
    return {
      id, name: l?.name ?? f?.name ?? id,
      baseWeight: base[id] ?? null,
      learnedWeight: l?.learnedWeight ?? null,
      reliabilityScore: l?.reliabilityScore ?? null,
      directionalEdgePct: l?.avgDirectionalReturnPct ?? null,
      actionableCompleted: f?.completedSignals ?? 0,
      actionableWinRatePct: f ? f.winRatePct : null,
      actionableAvgReturnPct: f ? f.avgReturnPct : null,
      status: f?.status ?? "LEARNING",
    } as AgentAttributionRow;
  });
}

export async function enrichSignalIntelligence(analyses: SymbolAnalysis[], learning?: LearningPolicy): Promise<SignalIntelligenceSummary> {
  const prediction = await loadPredictionMarkets();
  const topCrypto = new Set(analyses.filter((a) => a.assetClass === "CRYPTO" && a.action !== "AVOID").slice(0, 12).map((a) => a.symbol));
  let onChainDirect = 0, onChainProxy = 0, predictionMatches = 0, liveMicrostructureBooks = 0;

  await Promise.all(analyses.map(async (analysis) => {
    const directFlow = topCrypto.has(analysis.symbol) ? await whaleAlertSignal(analysis) : null;
    const onChain = directFlow ?? marketFlowProxy(analysis);
    if (onChain.directVerified) onChainDirect += 1;
    else if (onChain.source === "MARKET_FLOW_PROXY") onChainProxy += 1;
    const predictionMarket = predictionSignalFor(analysis, prediction.rows, !prediction.warning);
    if (predictionMarket.status === "MATCHED") predictionMatches += 1;
    const microstructure = topCrypto.has(analysis.symbol) ? await krakenMicrostructure(analysis) : eodMicrostructureProxy(analysis);
    if (microstructure.liveBookVerified) liveMicrostructureBooks += 1;
    const tilt = analysis.assetClass === "CRYPTO" ? onChain.directionalTilt * 0.65 + microstructure.pressureTilt * 0.35 : 0;
    const coverageParts = [microstructure.score, onChain.source === "UNAVAILABLE" ? 0 : onChain.confidence, predictionMarket.relevanceScore];
    analysis.signalIntelligence = {
      onChain, predictionMarket, microstructure,
      researchTilt: round(clamp(tilt, -1, 1), 3),
      coverageScore: Math.round(clamp(mean(coverageParts), 0, 100)),
      notes: ["Signal Intelligence is research-only in V5.2. Strict relevance filters prevent ticker substring collisions; context cannot change BUY_SETUP, risk caps or live readiness."],
    };
  }));

  return {
    generatedAt: new Date().toISOString(),
    onChainDirect, onChainProxy,
    predictionMarketsLoaded: prediction.rows.length,
    predictionMatches,
    liveMicrostructureBooks,
    averageCoverageScore: Math.round(mean(analyses.map((a) => a.signalIntelligence?.coverageScore ?? 0))),
    attribution: attributionRows(learning),
    notes: [
      prediction.warning ?? `Loaded ${prediction.rows.length} active public prediction markets for low-weight context matching.`,
      onChainDirect ? `${onChainDirect} crypto asset(s) received direct large-transfer context.` : "No direct on-chain provider was available; crypto flow remains a clearly labeled market-flow proxy unless WHALE_ALERT_API_KEY is configured.",
      "Kraken order-book depth is live market microstructure for supported crypto pairs; equities remain on an EOD execution proxy until a broker/data connector is added.",
    ],
  };
}

export function refreshAgentAttribution(summary: SignalIntelligenceSummary | undefined, learning: LearningPolicy | undefined, validation: ValidationSummary | undefined) {
  if (!summary) return;
  summary.attribution = attributionRows(learning, validation);
}
