# TradesWithMe V5.2 — Discovery & Governance

V5.2 treats strategy development like a controlled research process rather than an unconstrained self-modifying trading bot.

## Challenger generation

The current production decision policy is the champion. The sandbox creates bounded strategy-weight variants for trend, momentum, mean reversion, breakout and balanced families. Risk settings, data gates, event gates and the £50 overnight ceiling are not challenger parameters.

## Diversity archive

The archive is MAP-Elites-inspired: candidates are kept in separate strategy families so the discovery process cannot claim diversity merely by producing many tiny variants of the same momentum model.

## Pareto frontier

Candidates are compared on three explicit objectives:

1. historical robustness across Regime V2 states and 5/10/20-bar horizons;
2. Monte Carlo tail-risk resilience;
3. low strategy concentration.

A candidate is Pareto-efficient when no other candidate is at least as good on all three objectives and strictly better on at least one.

## Failure Replay Lab

For completed actionable trades, V5.2 reuses the frozen pre-outcome core-agent votes and asks whether a challenger would still have crossed the original BUY threshold. This creates four outcomes:

- `RETAINED_WINNER`
- `AVOIDED_LOSS`
- `MISSED_WINNER`
- `REPEATED_LOSS`

Replay is deliberately conservative and does not reconstruct a hypothetical live fill.

## Agent Governance

The governance desk compares baseline intended weights with realized absolute vote influence across the current scan. It also records blocker touches: cases where an agent supported a candidate but an external safety gate prevented action.

This helps detect hidden interference, for example a momentum agent receiving a high nominal weight but almost never affecting final decisions.

## Promotion boundary

A challenger may become `SHADOW_LEADER` only after it is Pareto-efficient, materially exceeds the champion composite score and passes sufficient failure replay evidence. This is still research status. There is no automatic production or live promotion path.
