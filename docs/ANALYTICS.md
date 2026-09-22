# TradesWithMe V4.1.4 — Analytical design

V4.1.4 is designed to make weak evidence visible rather than hide it behind an AI confidence badge. It does not claim that a signal is profitable until the signal survives both historical and forward checks.


## Data integrity gate (V4)

Equity history uses a redundant provider chain: Yahoo chart daily first and Stooq EOD second. Crypto uses Kraken completed daily OHLC. A history is actionable only when it is from a non-fallback source, has at least the configured minimum history depth, and is fresh enough for its asset class.

SPY and BTC-USD are benchmark gates. If the relevant benchmark fails verification, its market regime becomes `UNKNOWN` and any would-be new setup in that asset class is prevented from entering the overnight allocation. Strategy Lab also refuses fallback or stale histories. This is deliberately fail-closed.

## 1. Data gates

Each symbol receives a data-quality score based on:

- whether the source is real or simulated fallback data;
- history depth;
- freshness of the latest completed bar.

Fallback data can never produce an actionable order plan. Low-quality data downgrades or blocks a setup.

## 2. Market-regime context

SPY is the equity regime benchmark and BTC-USD is the crypto regime benchmark. The regime engine uses trend structure and recent return to classify `RISK_ON`, `MIXED`, or `RISK_OFF`. Long-entry thresholds are deliberately harder in a hostile regime.

## 3. Independent strategy agents

The core agents are:

- Trend
- Momentum
- Mean Reversion
- Breakout

They vote independently from information available at the current completed bar. A Devil's Advocate penalizes disagreement, overextension, hostile regimes, and elevated volatility. Risk, event, data-quality and correlation guards are shown separately so the user can see *why* a technically attractive setup was blocked.

## 4. Rolling walk-forward validation

A single train/test split can flatter a strategy by chance. V4.1.4 therefore adds rolling forward windows. For every strategy it records:

- positive forward windows;
- median forward return;
- median return relative to buy-and-hold of the same asset;
- median Sharpe ratio;
- worst drawdown;
- a 0–100 stability score.

Strategies are classified as `ACTIVE`, `PROBATION`, or `RETIRED`. Retired strategies receive very little influence in the live symbol score. This is a rule-based retirement mechanism, not an LLM judgment.

## 5. Evidence score

The 0–100 evidence score combines five separate dimensions:

- current multi-agent score;
- evidence confidence;
- rolling walk-forward stability;
- data quality;
- diversification value against current holdings.

Event risk is then applied as a penalty. An imminent configured earnings event can block a new overnight setup entirely. If an earnings calendar is not configured, equity event risk is explicitly shown as `UNVERIFIED` rather than silently assumed safe.

The evidence score is a ranking score, **not** a probability of profit.

## 6. Correlation control

V4.1.4 calculates trailing return correlation between symbols of the same asset class. A proposed trade can be downgraded when it is highly correlated with a holding you already own. The overnight paper allocator also refuses to stack highly correlated candidates together above the configured threshold.

This helps prevent a portfolio that looks diversified by ticker but is economically one large bet.


## Personal state for scheduled scans

When Supabase is configured, each manual scan synchronizes the normalized watchlist, holdings and risk settings into a single server-side owner-state row. The scheduled overnight scan loads that state so exposure and correlation checks remain personal even when no browser is open. The environment-level £50 ceiling is still applied as an upper bound.

## 7. Event-risk guard

When `ALPHAVANTAGE_API_KEY` is configured, the app checks the upcoming equity earnings calendar. Near-term earnings produce `CAUTION` or `BLOCK` status. Independently, abnormal daily price/volume behavior creates a caution flag for both equities and crypto.

This is not a complete news feed. V4.1.4 deliberately labels unverified event risk so that the user knows a current-news check is still required.

## 8. Forward-validation ledger

When Supabase is configured, every real-data `BUY_SETUP` is frozen server-side with:

- symbol and entry date;
- entry, stop and target;
- score, evidence score and confidence;
- all agent votes at the time of the signal;
- a five-completed-bar evaluation horizon.

Later scans reconcile pending signals against bars that occurred *after* the signal. The result is one of:

- `TARGET`
- `STOP`
- `TIME_EXIT`

If both stop and target are touched inside the same daily candle, V4.1.4 scores the outcome as a stop because daily OHLC data cannot prove which happened first. This intentionally biases the validation ledger conservatively.

Modeled forward returns subtract a round-trip transaction-cost assumption.

## 9. Trust score

The trust panel summarizes only frozen forward signals. It reports:

- completed and pending sample size;
- win rate;
- average return / expectancy;
- profit factor;
- sequential maximum drawdown;
- confidence-vs-outcome gap;
- per-agent forward scorecards.

The trust score is sample-size shrunk. It cannot receive a robust label with a tiny sample, even if the first few trades happen to win. V4.1.4 currently expects at least 30 completed signals before treating the evidence as usable and 100 before a `ROBUST` label is possible.

## 10. Overnight paper allocator

The £50 hard cap remains server-enforced. The allocator requires:

- a real market-data source;
- `BUY_SETUP` state;
- minimum raw score;
- minimum confidence;
- minimum evidence score;
- no blocked event risk;
- no high correlation to held exposure;
- no high correlation to another selected overnight candidate.

It can allocate nothing. Leaving the full £50 in paper cash is a valid output.

## Limits

V4.1.4 still uses daily bars, not executable broker quotes. It does not fully model taxes, time-varying spreads, partial fills, market impact, corporate actions, exchange outages, borrow costs, intraday stop ordering, or every news event. Historical and forward success can still stop working in a new market regime.

The correct use is: research → forward validation → small human-approved experiments → ongoing measurement. Do not treat a score as a guarantee.


## V4.1.4 adaptive-learning overlay

V4.1.4 adds a bounded learner on top of the existing evidence engine. Only completed forward signals are eligible for training. The original agent votes are preserved in the ledger, so the learner can measure whether each strategy agent was directionally useful after the signal was frozen.

The learner uses Bayesian/shrinkage estimates rather than raw win rates. Small samples therefore stay close to the original weights. Learned weights remain in shadow mode until 30 completed signals exist, and a drift detector can freeze adaptation when recent expectancy materially deteriorates relative to the earlier baseline.

Confidence calibration compares historical predicted confidence with realized win rate. Downward calibration is allowed to be stronger than upward calibration. The learner never modifies risk caps, stop construction, event/data gates, portfolio exposure limits or execution behavior.

This is intentionally an online reweighting system, not an unconstrained optimizer. See `docs/LEARNING.md` for implementation details and limits.

## V4.1.4 Trade Gate Observatory

Each scanned symbol now records the reason it did or did not become actionable. The Observatory aggregates those reasons across the latest scan. This is intended to diagnose an overly restrictive or ineffective policy without automatically weakening thresholds. The app still requires prospective forward evidence before any real-money pilot should be considered.
