import type { RiskSettings } from "./types";

export const CORE_EQUITY_WATCHLIST = [
  "SPY", "QQQ", "IWM", "DIA",
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "AVGO", "NFLX", "PLTR", "JPM", "BAC", "XOM", "GLD", "TLT",
];

// V4.1.6 broadens crypto coverage toward liquid, established and newer large-cap networks.
// Inclusion means "monitor and validate", not "buy". Unsupported Kraken USD pairs simply fail closed.
export const EXPANDED_CRYPTO_WATCHLIST = [
  "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "ADA-USD", "LINK-USD", "AVAX-USD", "DOT-USD", "LTC-USD",
  "BNB-USD", "BCH-USD", "TRX-USD", "XLM-USD", "HBAR-USD", "SUI-USD", "TON-USD", "NEAR-USD", "AAVE-USD", "UNI-USD",
  "SHIB-USD", "PEPE-USD", "ICP-USD", "ATOM-USD", "ALGO-USD", "FIL-USD", "ETC-USD", "XTZ-USD",
];

export const DEFAULT_WATCHLIST = [...CORE_EQUITY_WATCHLIST, ...EXPANDED_CRYPTO_WATCHLIST];

export const EQUITY_BENCHMARK = "SPY";
export const CRYPTO_BENCHMARK = "BTC-USD";
export const BENCHMARK = EQUITY_BENCHMARK;

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  accountSize: 25_000,
  riskPerTradePct: 0.5,
  maxPositionPct: 12,
  maxPortfolioExposurePct: 45,
  rewardRiskTarget: 2,
  atrStopMultiple: 1.8,
  overnightPaperBudgetGbp: 50,
};

export const ENGINE = {
  historyCalendarDays: 760,
  minimumBars: 260,
  buyThreshold: 0.46,
  exitThreshold: -0.28,
  avoidVolatilityPct: 65,
  transactionCostBps: 8,
  roundTripCostBps: 16,
  maxSymbolsPerScan: 50,
  marketDataConcurrency: 8,
  overnightMaxPaperOrders: 3,
  morningCandidateLimit: 10,
  overnightMinScore: 0.50,
  overnightMinConfidence: 60,
  overnightMinEvidenceScore: 58,
  correlationLookback: 60,
  correlationHighThreshold: 0.78,
  correlationModerateThreshold: 0.62,
  forwardSignalHorizonBars: 5,
  validationRecentLimit: 24,
  minimumTrustSample: 30,
  robustTrustSample: 100,
  eventBlockDays: 2,
  eventCautionDays: 5,
  walkForwardFolds: 4,
  walkForwardTestBars: 50,
} as const;
