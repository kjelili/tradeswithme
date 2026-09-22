import type { RiskSettings } from "./types";

export const DEFAULT_WATCHLIST = [
  "SPY", "QQQ", "IWM", "DIA",
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "AVGO", "NFLX", "PLTR", "JPM", "BAC", "XOM", "GLD", "TLT",
  "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "ADA-USD", "LINK-USD", "AVAX-USD", "DOT-USD", "LTC-USD",
];

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
  maxSymbolsPerScan: 30,
  marketDataConcurrency: 6,
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
