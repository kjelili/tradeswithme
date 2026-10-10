# TradesWithMe V5.1.1 — Signal Intelligence + Calibration

V5.1 adds independent context layers around the existing Quant Intelligence and forward-validation engine. These signals are deliberately research-only until their incremental value can be measured.

## 1. Crypto flow agent

For crypto assets V5.1 first attempts optional direct large-transfer context when `WHALE_ALERT_API_KEY` is configured and the asset is supported by the provider adapter. Exchange outflow is treated as positive flow pressure and exchange inflow as negative pressure, but the classification is noisy and never sufficient to authorize a trade.

When a direct provider is not available, V5.1 falls back to `MARKET_FLOW_PROXY`, derived from recent price/volume behaviour. The UI explicitly labels this as a proxy so it cannot be mistaken for blockchain transfer data.

## 2. Prediction-market context

The server loads public active prediction markets and requires strict normalized entity/token matches. Broad macro markets are not assigned to a specific ticker without an explicit asset/entity match. V5.1 surfaces the market-implied probability and uncertainty as context only.

Prediction-market prices can be wrong, manipulated, thin or unrelated to the asset. They do not change the BUY_SETUP gate in V5.1.

## 3. Microstructure agent

Supported crypto candidates can use Kraken's public order-book depth endpoint. V5.1 estimates:

- best bid/ask spread in basis points;
- top-10 bid and ask notional depth;
- bid/ask imbalance;
- a bounded execution-quality score.

For equities the existing EOD volatility/liquidity proxy remains in place until a broker or live market-data connector is added.

Order-book state is transient. The displayed book is not a guaranteed executable fill.

## 4. Agent attribution

The Attribution panel combines:

- learned strategy reliability;
- directional edge measured from completed learning observations;
- completed actionable forward trades;
- actionable win rate and average return when available.

Shadow evidence can train research weights but cannot inflate Forward Trust.

## 5. Authority boundary

V5.1 Signal Intelligence cannot:

- create a live broker order;
- raise the £50 overnight paper cap;
- modify stop or portfolio risk rules;
- bypass data, event or correlation gates;
- make shadow evidence count as actionable Forward Trust;
- promote a challenger to live authority.

This separation lets TradesWithMe measure whether a new information source is useful before allowing it to affect capital decisions.
