export type MarketSource = "YAHOO_CHART_DAILY" | "STOOQ_EOD" | "KRAKEN_CRYPTO_DAILY" | "SIMULATED_FALLBACK";
export type AssetClass = "EQUITY" | "CRYPTO";
export type Regime = "RISK_ON" | "MIXED" | "RISK_OFF" | "UNKNOWN";
export type SignalAction = "BUY_SETUP" | "WATCH" | "HOLD" | "EXIT" | "AVOID";
export type StrategyState = "ACTIVE" | "PROBATION" | "RETIRED";
export type EventRiskLevel = "CLEAR" | "CAUTION" | "BLOCK" | "UNVERIFIED";

export type PriceBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type IndicatorSnapshot = {
  close: number;
  changePct: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  atr14: number | null;
  atrPct: number | null;
  return5Pct: number | null;
  return20Pct: number | null;
  return60Pct: number | null;
  z20: number | null;
  high20: number | null;
  low20: number | null;
  volumeRatio20: number | null;
  realizedVol20Pct: number | null;
};

export type AgentVote = {
  id: "trend" | "momentum" | "reversion" | "breakout" | "critic" | "risk" | "event" | "correlation" | "quality";
  name: string;
  score: number;
  confidence: number;
  rationale: string;
  weight: number;
};

export type StrategyMetrics = {
  id: "trend" | "momentum" | "reversion" | "breakout" | "ensemble";
  name: string;
  totalReturnPct: number;
  annualizedReturnPct: number;
  benchmarkReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  winRatePct: number;
  profitFactor: number;
  trades: number;
  exposurePct: number;
};

export type WalkForwardFold = {
  fold: number;
  start: string;
  end: string;
  metrics: StrategyMetrics[];
};

export type StrategyValidation = {
  id: StrategyMetrics["id"];
  name: string;
  folds: number;
  positiveFolds: number;
  positiveFoldPct: number;
  medianReturnPct: number;
  medianSharpe: number;
  worstDrawdownPct: number;
  medianRelativeReturnPct: number;
  stabilityScore: number;
  state: StrategyState;
};

export type StrategyLabResult = {
  symbol: string;
  source: MarketSource;
  asOf: string;
  bars: number;
  trainPct: number;
  outOfSamplePct: number;
  full: StrategyMetrics[];
  outOfSample: StrategyMetrics[];
  winner: StrategyMetrics;
  walkForward: WalkForwardFold[];
  validation: StrategyValidation[];
  validationWinner: StrategyValidation;
  notes: string[];
};

export type PositionInput = {
  symbol: string;
  qty: number;
  avgPrice: number;
};

export type RiskSettings = {
  accountSize: number;
  riskPerTradePct: number;
  maxPositionPct: number;
  maxPortfolioExposurePct: number;
  rewardRiskTarget: number;
  atrStopMultiple: number;
  overnightPaperBudgetGbp: number;
};

export type TradePlan = {
  action: SignalAction;
  entry: number;
  stop: number | null;
  target: number | null;
  riskPerShare: number | null;
  suggestedShares: number;
  suggestedNotional: number;
  accountRiskDollars: number;
  rewardRisk: number | null;
  invalidation: string;
};

export type EventRisk = {
  level: EventRiskLevel;
  reason: string;
  eventDate: string | null;
  daysAway: number | null;
  source: "ALPHA_VANTAGE_EARNINGS" | "PRICE_ANOMALY" | "NONE" | "UNCONFIGURED";
};


export type HealthStatus = "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "UNCONFIGURED";

export type MarketDataHealthItem = {
  status: HealthStatus;
  verified: number;
  total: number;
  primary: string;
  detail: string;
  asOf: string | null;
};

export type MarketDataHealth = {
  equity: MarketDataHealthItem;
  crypto: MarketDataHealthItem;
  fx: MarketDataHealthItem;
  events: MarketDataHealthItem;
};

export type DataQuality = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  freshnessDays: number;
  bars: number;
  sourceReliable: boolean;
  notes: string[];
};

export type CorrelationRisk = {
  maxCorrelation: number | null;
  correlatedWith: string | null;
  threshold: number;
  status: "LOW" | "MODERATE" | "HIGH" | "UNKNOWN";
};

export type EvidenceProfile = {
  score: number;
  band: "WEAK" | "DEVELOPING" | "STRONG" | "VERY_STRONG";
  walkForwardStability: number;
  dataQualityScore: number;
  diversificationScore: number;
  eventRiskPenalty: number;
  rationale: string;
};

export type SymbolAnalysis = {
  symbol: string;
  assetClass: AssetClass;
  source: MarketSource;
  asOf: string;
  indicators: IndicatorSnapshot;
  regime: Regime;
  score: number;
  confidence: number;
  evidence: EvidenceProfile;
  action: SignalAction;
  votes: AgentVote[];
  strategyHealth: Record<string, number>;
  strategyStates: Record<string, StrategyState>;
  tradePlan: TradePlan;
  eventRisk: EventRisk;
  dataQuality: DataQuality;
  correlationRisk: CorrelationRisk;
  pairCorrelations: Record<string, number>;
  gateReasons: string[];
  warnings: string[];
};

export type OvernightPaperOrder = {
  symbol: string;
  assetClass: AssetClass;
  source: MarketSource;
  score: number;
  evidenceScore: number;
  confidence: number;
  entryUsd: number;
  units: number;
  notionalUsd: number;
  notionalGbp: number;
  stopUsd: number | null;
  targetUsd: number | null;
  rationale: string;
};

export type MorningCandidate = {
  rank: number;
  symbol: string;
  assetClass: AssetClass;
  source: MarketSource;
  score: number;
  evidenceScore: number;
  confidence: number;
  action: SignalAction;
  entryUsd: number;
  stopUsd: number | null;
  targetUsd: number | null;
  correlationWarning: string | null;
  eventRisk: EventRiskLevel;
  rationale: string;
};

export type OvernightPlan = {
  mode: "PAPER_ONLY";
  currency: "GBP";
  budgetGbp: number;
  allocatedGbp: number;
  remainingGbp: number;
  maxOrders: number;
  fx: {
    pair: "GBP/USD";
    rate: number;
    asOf: string;
    source: "FRANKFURTER_DAILY" | "FALLBACK";
  };
  orders: OvernightPaperOrder[];
  morningCandidates: MorningCandidate[];
  notes: string[];
};

export type ValidationOutcome = "PENDING" | "TARGET" | "STOP" | "TIME_EXIT";

export type ForwardSignal = {
  id: number;
  symbol: string;
  assetClass: AssetClass;
  openedAt: string;
  entryDate: string;
  entry: number;
  stop: number | null;
  target: number | null;
  score: number;
  evidenceScore: number;
  confidence: number;
  horizonBars: number;
  outcome: ValidationOutcome;
  exitDate: string | null;
  exitPrice: number | null;
  returnPct: number | null;
  barsHeld: number | null;
  agentSnapshot: AgentVote[];
};

export type AgentForwardStat = {
  id: string;
  name: string;
  supportedSignals: number;
  completedSignals: number;
  winRatePct: number;
  avgReturnPct: number;
  status: "LEARNING" | "POSITIVE" | "MIXED" | "WEAK";
};

export type ValidationSummary = {
  configured: boolean;
  completed: number;
  pending: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgReturnPct: number;
  expectancyPct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  trustScore: number;
  trustBand: "INSUFFICIENT" | "EARLY" | "DEVELOPING" | "PROMISING" | "ROBUST";
  calibrationGapPct: number | null;
  minimumRobustSample: number;
  recent: ForwardSignal[];
  agents: AgentForwardStat[];
  notes: string[];
};



export type LearningMode = "COLD_START" | "SHADOW" | "ADAPTIVE" | "FROZEN";
export type LearningAgentId = "trend" | "momentum" | "reversion" | "breakout";

export type LearningAgentStat = {
  id: LearningAgentId;
  name: string;
  baseWeight: number;
  learnedWeight: number;
  observations: number;
  directionalAccuracyPct: number;
  avgDirectionalReturnPct: number;
  reliabilityScore: number;
};

export type LearningSegment = {
  key: "GLOBAL" | "EQUITY" | "CRYPTO";
  sampleCount: number;
  winRatePct: number;
  avgReturnPct: number;
  agents: LearningAgentStat[];
};

export type LearningPolicy = {
  version: number;
  trainedAt: string;
  mode: LearningMode;
  sampleCount: number;
  effectiveSampleCount: number;
  actionableSamples: number;
  shadowSamples: number;
  minimumAdaptiveSample: number;
  confidenceAdjustmentPct: number;
  driftScore: number;
  recentExpectancyPct: number | null;
  baselineExpectancyPct: number | null;
  segments: Record<"GLOBAL" | "EQUITY" | "CRYPTO", LearningSegment>;
  notes: string[];
};


export type AutomationRun = {
  id: number;
  ranAt: string;
  status: "OK" | "DEGRADED" | "FAILED";
  actionableSettled: number;
  shadowSettled: number;
  actionableInserted: number;
  shadowInserted: number;
  learningVersion: number | null;
  learningMode: string | null;
  effectiveSamples: number | null;
  regime: string | null;
  cryptoRegime: string | null;
  detail: string | null;
};

export type PendingLearningObservation = {
  kind: "ACTIONABLE" | "SHADOW";
  id: number;
  symbol: string;
  assetClass: AssetClass;
  entryDate: string;
  horizonBars: number;
  estimatedBarsElapsed: number;
  estimatedBarsRemaining: number;
  estimatedMaturityAt: string;
  marketDataAsOf: string | null;
  maturityStatus: "WAITING" | "DUE";
};

export type TradeGateBlocker = {
  reason: string;
  count: number;
  pct: number;
};

export type TradeGateSummary = {
  scanned: number;
  buySetups: number;
  watches: number;
  avoids: number;
  topBlockers: TradeGateBlocker[];
};

export type LearningObservatory = {
  configured: boolean;
  cadence: string;
  nextScheduledAt: string;
  lastRun: AutomationRun | null;
  recentRuns: AutomationRun[];
  actionablePending: number;
  actionableCompleted: number;
  shadowPending: number;
  shadowCompleted: number;
  effectiveCompletedSamples: number;
  pending: PendingLearningObservation[];
  tradeGate: TradeGateSummary | null;
  ownerStateUpdatedAt: string | null;
  notes: string[];
};

export type OwnerState = {
  symbols: string[];
  positions: PositionInput[];
  settings: RiskSettings;
  updatedAt: string;
};

export type ScanRequest = {
  symbols?: string[];
  positions?: PositionInput[];
  settings?: Partial<RiskSettings>;
};

export type ScanResult = {
  at: string;
  mode: "PERSONAL_RESEARCH";
  dataMode: "END_OF_DAY";
  benchmark: string;
  cryptoBenchmark: string;
  regime: Regime;
  cryptoRegime: Regime;
  dataHealth: MarketDataHealth;
  analyses: SymbolAnalysis[];
  settings: RiskSettings;
  overnightPlan?: OvernightPlan;
  validation?: ValidationSummary;
  learning?: LearningPolicy;
  warnings: string[];
};
