# TradesWithMe V4.1.6 — Learning design

## Frozen evidence only

The learner trains only on observations that were frozen before their future outcome was known:

- actionable `BUY_SETUP` rows: weight `1.0`
- qualifying shadow `WATCH` rows: weight `0.5`

Shadow rows improve research learning but never increase Forward Trust.

## Agent reweighting

Trend, Momentum, Mean Reversion and Breakout receive bounded reliability estimates. Directional accuracy uses a Beta(8,8) prior and learned weights shrink toward the original ensemble until the agent has substantial observations.

## Promotion states

- `COLD_START`: fewer than 15 effective samples
- `SHADOW`: 15–29.5 effective samples
- `ADAPTIVE`: 30+ samples and normal drift
- `GUARDED`: material drift, but not enough evidence for a hard freeze
- `FROZEN`: persistent severe drift or negative recent expectancy

## Drift Control V2

The previous drift detector reacted to raw percentage-point deterioration. V4.1.6 normalizes deterioration by the dispersion of earlier and recent returns, which is important when crypto has much larger five-bar moves than equities.

The detector calculates global, equity and crypto drift separately. A guarded window increments a drift streak. Hard freeze requires either:

- materially negative recent expectancy with severe drift, or
- severe drift persisting across multiple completed windows.

A positive but weaker recent window can therefore become `GUARDED` without immediately disabling all adaptive research.

## Research adaptation vs decision adaptation

This separation is deliberate:

- At 30+ effective samples, learned weights may influence **research ranking**.
- `BUY_SETUP` decisions continue to use the original baseline strategy weights until at least **10 completed actionable forward signals** exist.
- Only when that actionable milestone exists and the learner is in `ADAPTIVE` mode can learned weights drive the decision score.

The dashboard shows both **Research score** and **Decision score**, plus the active decision policy.

## Governance that cannot be learned around

The learner cannot modify:

- £50 overnight paper ceiling
- risk-per-trade / max-position / max-exposure rules
- stop/target construction
- data verification
- event-risk blocks
- correlation gates
- forward-validation settlement rules
- live broker execution
