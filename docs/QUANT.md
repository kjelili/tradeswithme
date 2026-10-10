# TradesWithMe V5 Quant Intelligence

V5 adds research diagnostics around the existing forward-validation engine. None of these modules can place a live order or override hard risk/data/event gates.

## Regime Engine V2

Each verified benchmark and candidate receives one of:

- `TREND_UP`
- `TREND_DOWN`
- `CHOP_LOW_VOL`
- `CHOP_HIGH_VOL`
- `PANIC`
- `RECOVERY`
- `UNKNOWN`

Classification uses completed-bar trend alignment, 20/60-bar returns, RSI and realized volatility. The confidence score represents internal feature agreement, not probability of a profitable trade.

## Robustness Matrix

For a bounded set of verified histories, V5 samples historical decision points and records subsequent 1/3/5/10/20-bar returns when each core agent had a positive signal. Cells report observation count, positive-outcome rate, average return after a simple modeled cost, and a bounded robustness score.

The matrix is designed to answer: “Does this idea repeat across symbols, horizons, asset classes and regimes?” rather than “Did one backtest look good?”

## Monte Carlo Risk Lab

V5 bootstraps 4,000 30-day paths from recent verified daily returns of high-quality candidates. It reports:

- probability of ending positive
- median return
- 5th-percentile return
- 95% expected shortfall
- median and 95th-percentile maximum drawdown
- probability of a 10% or worse loss

This is a stress test, not a forecast.

## Champion / Challenger

The current baseline/validated policy is the champion. V5 automatically creates bounded strategy-weight tilts (trend, momentum, defensive-reversion and breakout). Challengers are scored using the robustness matrix and remain `SHADOW_ONLY`. They cannot auto-promote into BUY_SETUP authority.

## Counterfactual Gate Calibration

V5 records rejected WATCH/AVOID candidates before their future outcomes are known. After the same forward horizon, it calculates what happened and groups results by gate reason. This helps detect gates that are useful versus gates that may be over-blocking.

Counterfactual outcomes never alter the historical Forward Trust ledger.

## Execution Quality Proxy

Without a broker/order-book connection, V5 cannot know the live bid/ask spread or market depth. It therefore exposes only an EOD proxy based on ATR, realized volatility and volume ratio. The UI explicitly labels this as a proxy and it cannot authorize execution.

## Quant Readiness

Quant Readiness combines data quality, Regime V2 confidence, robustness, Monte Carlo risk and actionable Forward Trust. A high score is not a promise of profit. Live Readiness remains controlled by completed actionable signals and separate human approval.
