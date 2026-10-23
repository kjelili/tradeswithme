# TradesWithMe V5.2.1 — Edge Diagnostics

V5.2.1 adds a research-only diagnostic layer to explain *why* actionable trades win or lose and whether the ensemble is behaving as intended. It does not loosen BUY thresholds, widen stops automatically, change the £50 paper ceiling, or add broker execution.

## Agent influence caps

Discovery challengers are prevented from materially over-weighting an agent before that agent has enough completed actionable participation. The cap is intentionally conservative:

- fewer than 5 actionable completions: intended weight + 3 percentage points
- 5–9 completions: intended + 5 points
- 10–29 completions: intended + 8 points
- 30+ completions: diagnostic cap is removed

The production decision policy remains governed by the existing learning/live-readiness rules. Caps primarily stop the discovery sandbox from exaggerating an immature specialist.

## Loss clusters

Completed actionable signals are clustered by asset class, Quant Regime V2 state and outcome. Each cluster reports count, win rate, average return, MFE and MAE. This helps distinguish a general model problem from a regime-specific or asset-class-specific failure.

## Winner vs loser differential

The dashboard compares winners and losers on evidence score, confidence, MFE, MAE and recorded microstructure quality. With small samples these are descriptive only; they are never used to retroactively change a historical decision.

## Stop / horizon calibration

The lab classifies the current sample into one of four research diagnoses:

- `DIRECTION_QUALITY`: stopped trades had little favorable excursion before material adverse movement.
- `STOP_GEOMETRY`: stopped trades first achieved meaningful favorable excursion, suggesting volatility/stop scaling merits sandbox testing.
- `HORIZON_CAPTURE`: time-exit trades gave back substantial favorable excursion.
- `MIXED`: no single failure mode dominates.

Any suggested parameter experiments remain shadow-only.

## Near-miss cohorts

Current WATCH candidates are grouped by the gate that stopped them. Their distance to the BUY threshold is displayed alongside the historical counterfactual result for the same gate. This accelerates learning by observation, not by weakening safeguards.

A gate that historically rejects losing candidates is evidence that the gate is useful. V5.2.1 therefore does not lower a threshold just because many candidates are close to it.
