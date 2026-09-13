# TradesWithMe V4.1.1 — Adaptive learning design

## Goal

The learner is deliberately narrower than a generic “AI that trains itself.” Its job is to learn **which existing strategy agents have been useful in actual forward-tested signals**, while preventing small samples, drift or overconfidence from taking control of the portfolio process.

## Training data

Two frozen ledgers are eligible: actionable rows from `twm_forward_signals` and high-quality WATCH observations from `twm_shadow_signals`. Shadow rows are evaluated at a fixed five-bar time exit and count at 0.5× learning weight. They never contribute to the Forward Trust score. Both ledgers are frozen before future outcomes are known, reducing hindsight leakage compared with training directly on today’s candidates.

## Agent credit assignment

For each strategy agent, V4.1.1 compares the direction of the agent’s original vote with the later forward return. Positive votes receive credit when the forward return is positive; negative votes receive credit when the forward return is non-positive. The directional return is confidence-weighted.

A Beta(8,8) prior shrinks directional accuracy toward 50% at small sample sizes. Learned weights are additionally shrunk toward the original ensemble until roughly 50 observations exist for that agent.

## Promotion rules

- `<15` effective samples: `COLD_START`.
- `15–29.5`: `SHADOW`; learned weights are visible but not used.
- `>=30`: `ADAPTIVE`, unless drift control freezes the policy.

Actionable outcomes count 1.0×; shadow outcomes count 0.5×.

The thresholds are intentionally conservative. Thirty signals is not enough to prove profitability; it only allows a limited adaptive overlay.

## Drift control

When there are enough observations, V4.1.1 compares the last 20 completed-signal returns against an earlier rolling baseline. Material deterioration raises the drift score. At 70/100 or higher, the policy becomes `FROZEN` and the original strategy weights drive scoring.

## Confidence calibration

Once adaptation is eligible, V4.1.1 compares average predicted confidence with realized win rate. It can subtract up to 12 confidence points or add at most 5. This asymmetry is deliberate: the learner is allowed to become cautious faster than it is allowed to become confident.

## Things the learner cannot learn around

The adaptive layer cannot change:

- £50 overnight paper ceiling
- owner risk-per-trade setting
- maximum position / portfolio exposure
- stop and target construction
- market-data verification
- event-risk blocks
- correlation constraints
- forward-validation rules
- live order execution

That separation is intentional. Performance optimization must not be able to rewrite risk governance.

## Important limitation

The current learner performs bounded online reweighting; it is not a full machine-learning feature model. It learns from the subset of opportunities that reached the forward ledger, so there is selection bias. A later version can add a shadow ledger of non-actionable candidates, purged cross-validation, richer features and champion/challenger model promotion while preserving the same risk boundary.
