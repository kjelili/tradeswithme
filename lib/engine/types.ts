export type MarketSource = "YAHOO_CHART_DAILY" | "STOOQ_EOD" | "ALPHAVANTAGE_PATCHED_DAILY" | "KRAKEN_CRYPTO_DAILY" | "SIMULATED_FALLBACK";
export type AssetClass = "EQUITY" | "CRYPTO";
export type Regime = "RISK_ON" | "MIXED" | "RISK_OFF" | "UNKNOWN";
export type QuantRegime = "TREND_UP" | "TREND_DOWN" | "CHOP_LOW_VOL" | "CHOP_HIGH_VOL" | "PANIC" | "RECOVERY" | "UNKNOWN";
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



export type QuantRegimeProfile = {
  regime: QuantRegime;
  confidence: number;
  trendStrength: number;
  volatilityPct: number | null;
  rationale: string;
};

export type ExecutionQuality = {
  status: "GOOD_PROXY" | "CAUTION_PROXY" | "POOR_PROXY" | "UNAVAILABLE";
  score: number;
  liveSpreadVerified: boolean;
  rationale: string;
};

export type RobustnessCell = {
  strategy: LearningAgentId;
  strategyName: string;
  assetClass: AssetClass;
  regime: QuantRegime;
  horizonBars: number;
  observations: number;
  winRatePct: number;
  avgReturnPct: number;
  score: number;
};

export type RobustnessMatrix = {
  generatedAt: string;
  samples: number;
  horizons: number[];
  overallScore: number;
  cells: RobustnessCell[];
};

export type MonteCarloSegment = {
  key: string;
  label: string;
  assetClass: AssetClass | "ALL";
  regime: QuantRegime | "ALL";
  observations: number;
  paths: number;
  probabilityProfitPct: number;
  medianReturnPct: number;
  p05ReturnPct: number;
  expectedShortfall95Pct: number;
  medianMaxDrawdownPct: number;
  p95MaxDrawdownPct: number;
  riskOfRuin10Pct: number;
  status: "PASS" | "CAUTION" | "BLOCK" | "UNAVAILABLE";
};

export type MonteCarloSummary = {
  paths: number;
  horizonDays: number;
  probabilityProfitPct: number;
  medianReturnPct: number;
  p05ReturnPct: number;
  expectedShortfall95Pct: number;
  medianMaxDrawdownPct: number;
  p95MaxDrawdownPct: number;
  riskOfRuin10Pct: number;
  status: "PASS" | "CAUTION" | "BLOCK" | "UNAVAILABLE";
  segments: MonteCarloSegment[];
  notes: string[];
};

export type ChallengerVariant = {
  id: string;
  name: string;
  weights: Record<LearningAgentId, number>;
  robustnessScore: number;
  status: "SHADOW_ONLY";
};

export type ChallengerLab = {
  champion: { name: string; weights: Record<LearningAgentId, number>; robustnessScore: number };
  challengers: ChallengerVariant[];
  shadowLeader: string | null;
  notes: string[];
};

export type CounterfactualGateStat = {
  reason: string;
  completed: number;
  avgReturnPct: number;
  positiveRatePct: number;
  verdict: "HELPFUL" | "MIXED" | "OVERBLOCKING" | "INSUFFICIENT";
};

export type CounterfactualSummary = {
  completed: number;
  pending: number;
  gates: CounterfactualGateStat[];
  currentBlockers: Array<{ reason: string; count: number }>;
  notes: string[];
};

export type QuantReadiness = {
  score: number;
  dataIntegrity: number;
  regimeConfidence: number;
  robustness: number;
  monteCarloRisk: number;
  forwardTrust: number;
  executionProxy: number;
  status: "RESEARCH_ONLY" | "PILOT_RESEARCH";
  rationale: string;
  blockers: string[];
};

export type QuantIntelligence = {
  regimeV2: { equity: QuantRegimeProfile; crypto: QuantRegimeProfile };
  robustness: RobustnessMatrix;
  monteCarlo: MonteCarloSummary;
  challengers: ChallengerLab;
  counterfactual: CounterfactualSummary;
  readiness: QuantReadiness;
};


export type OnChainFlowSignal = {
  status: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNVERIFIED";
  score: number;
  confidence: number;
  directionalTilt: number;
  source: "WHALE_ALERT" | "MARKET_FLOW_PROXY" | "UNAVAILABLE";
  directVerified: boolean;
  whaleTransfers: number;
  netExchangeFlowUsd: number | null;
  rationale: string;
};

export type PredictionMarketSignal = {
  status: "MATCHED" | "NO_MATCH" | "UNAVAILABLE";
  source: "POLYMARKET_PUBLIC" | "UNAVAILABLE";
  probabilityPct: number | null;
  uncertaintyPct: number | null;
  volumeUsd: number | null;
  marketQuestion: string | null;
  matchedMarkets: number;
  relevanceScore: number;
  matchType: "ASSET" | "MACRO" | "NONE";
  matchedAlias: string | null;
  rationale: string;
};

export type MicrostructureSignal = {
  status: "GOOD" | "CAUTION" | "POOR" | "UNAVAILABLE";
  source: "KRAKEN_ORDER_BOOK" | "EOD_PROXY" | "UNAVAILABLE";
  score: number;
  liveBookVerified: boolean;
  spreadBps: number | null;
  imbalance: number | null;
  topDepthUsd: number | null;
  pressureTilt: number;
  rationale: string;
};

export type SymbolSignalIntelligence = {
  onChain: OnChainFlowSignal;
  predictionMarket: PredictionMarketSignal;
  microstructure: MicrostructureSignal;
  researchTilt: number;
  coverageScore: number;
  notes: string[];
};

export type AgentAttributionRow = {
  id: string;
  name: string;
  baseWeight: number | null;
  learnedWeight: number | null;
  reliabilityScore: number | null;
  directionalEdgePct: number | null;
  actionableCompleted: number;
  actionableWinRatePct: number | null;
  actionableAvgReturnPct: number | null;
  status: "LEARNING" | "POSITIVE" | "MIXED" | "WEAK";
};

export type SignalIntelligenceSummary = {
  generatedAt: string;
  onChainDirect: number;
  onChainProxy: number;
  predictionMarketsLoaded: number;
  predictionMatches: number;
  liveMicrostructureBooks: number;
  averageCoverageScore: number;
  attribution: AgentAttributionRow[];
  notes: string[];
};


export type GovernanceFamily = "BASELINE" | "TREND" | "MOMENTUM" | "REVERSION" | "BREAKOUT" | "BALANCED";
export type GovernanceCandidateStatus = "CHAMPION" | "PARETO" | "DOMINATED" | "REPLAY_RISK";

export type GovernanceCandidate = {
  id: string;
  name: string;
  family: GovernanceFamily;
  weights: Record<LearningAgentId, number>;
  robustnessScore: number;
  tailRiskScore: number;
  concentrationScore: number;
  replayScore: number | null;
  compositeScore: number;
  paretoEfficient: boolean;
  status: GovernanceCandidateStatus;
  notes: string[];
};

export type StrategyDiversityCell = {
  family: GovernanceFamily;
  candidates: number;
  bestCandidateId: string;
  bestScore: number;
};

export type StrategyDiversityArchive = {
  diversityScore: number;
  familiesRepresented: number;
  duplicateRejected: number;
  cells: StrategyDiversityCell[];
  notes: string[];
};

export type ReplayCaseResult = "RETAINED_WINNER" | "AVOIDED_LOSS" | "MISSED_WINNER" | "REPEATED_LOSS" | "INSUFFICIENT";
export type ReplayCase = {
  signalId: number;
  symbol: string;
  outcome: ValidationOutcome;
  actualReturnPct: number;
  frozenDecisionScore: number;
  challengerDecisionScore: number;
  challengerWouldBuy: boolean;
  result: ReplayCaseResult;
  rationale: string;
};

export type FailureReplayLab = {
  candidateId: string | null;
  candidateName: string | null;
  completedCases: number;
  winnersRetained: number;
  lossesAvoided: number;
  winnersMissed: number;
  lossesRepeated: number;
  replayScore: number;
  cases: ReplayCase[];
  notes: string[];
};

export type AgentGovernanceRow = {
  id: string;
  name: string;
  intendedInfluencePct: number;
  realizedInfluencePct: number;
  actionableCompleted: number;
  actionableAvgReturnPct: number | null;
  blockerTouches: number;
  status: "EFFECTIVE" | "SUPPRESSED" | "MIXED" | "UNPROVEN";
};

export type AgentConflict = {
  symbol: string;
  supporters: string[];
  objectors: string[];
  dominantBlocker: string | null;
  conflictScore: number;
  finalAction: SignalAction;
};

export type AgentGovernance = {
  rows: AgentGovernanceRow[];
  conflicts: AgentConflict[];
  gateValue: Array<{ reason: string; completed: number; avgReturnPct: number; verdict: CounterfactualGateStat["verdict"] }>;
  notes: string[];
};

export type ParetoFrontier = {
  candidateIds: string[];
  dominatedIds: string[];
  objectives: string[];
  notes: string[];
};

export type DiscoveryGovernance = {
  generatedAt: string;
  authority: "RESEARCH_ONLY";
  candidates: GovernanceCandidate[];
  diversity: StrategyDiversityArchive;
  pareto: ParetoFrontier;
  replay: FailureReplayLab;
  agentGovernance: AgentGovernance;
  promotionStatus: "NO_PROMOTION" | "SHADOW_LEADER";
  shadowLeaderId: string | null;
  notes: string[];
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
  freshnessSessions: number | null;
  expectedAsOf: string | null;
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
  quantRegime?: QuantRegimeProfile;
  executionQuality?: ExecutionQuality;
  signalIntelligence?: SymbolSignalIntelligence;
  score: number;
  confidence: number;
  decisionScore: number;
  decisionConfidence: number;
  decisionEvidenceScore: number;
  decisionPolicy: "BASELINE" | "LEARNED";
  evidence: EvidenceProfile;
  action: SignalAction;
  votes: AgentVote[];
  decisionVotes: AgentVote[];
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

export type TradeAutopsy = {
  mfePct: number | null;
  maePct: number | null;
  quantRegime: QuantRegime | null;
  microstructureScore: number | null;
  microstructureSpreadBps: number | null;
  microstructureVerified: boolean;
  eventRisk: EventRiskLevel | null;
  decisionPolicy: "BASELINE" | "LEARNED" | null;
  researchTilt: number | null;
  diagnosis: string[];
};

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
  autopsy: TradeAutopsy | null;
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

export type LiveReadinessStatus = "NOT_READY" | "PILOT_ELIGIBLE" | "VALIDATED";

export type LiveReadiness = {
  status: LiveReadinessStatus;
  score: number;
  reasons: string[];
  completedRequiredForPilot: number;
  completedRequiredForValidated: number;
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
  liveReadiness: LiveReadiness;
  notes: string[];
};



export type LearningMode = "COLD_START" | "SHADOW" | "ADAPTIVE" | "GUARDED" | "FROZEN";
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

export type DriftMetric = {
  score: number;
  recentExpectancyPct: number | null;
  baselineExpectancyPct: number | null;
  baselineVolatilityPct: number | null;
};

export type LearningRecovery = {
  status: "NOT_NEEDED" | "RECOVERING" | "READY_TO_UNFREEZE" | "BLOCKED";
  positiveWindowStreak: number;
  requiredPositiveWindows: number;
  recentExpectancyPositive: boolean;
  driftBelowGuardedThreshold: boolean;
  actionableSamples: number;
  requiredActionableSamples: number;
  reasons: string[];
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
  minimumActionableForDecisionWeights: number;
  decisionWeightsActive: boolean;
  confidenceAdjustmentPct: number;
  driftScore: number;
  driftStreak: number;
  recoveryPositiveStreak: number;
  recovery: LearningRecovery;
  recentExpectancyPct: number | null;
  baselineExpectancyPct: number | null;
  segmentDrift: Record<"EQUITY" | "CRYPTO", DriftMetric>;
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
  quant?: QuantIntelligence;
  signalIntelligence?: SignalIntelligenceSummary;
  governance?: DiscoveryGovernance;
  warnings: string[];
};
