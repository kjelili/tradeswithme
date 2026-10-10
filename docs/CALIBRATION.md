# V5.1.1 Calibration & Attribution

## Strict prediction-market matching

Ticker strings are matched as standalone normalized tokens. Full company/asset names are preferred. Broad macro markets are not attached to a specific ticker unless the market explicitly names that asset/entity.

## Trade autopsy

For each actionable forward signal TradesWithMe can store the entry-time regime, event risk, decision policy, Signal Intelligence snapshot and microstructure snapshot. At settlement it records:

- **MFE** — maximum favorable excursion during the observed holding window;
- **MAE** — maximum adverse excursion during the observed holding window;
- final outcome / return after modeled round-trip cost;
- a short diagnostic highlighting weak microstructure, large adverse excursion, missed favorable excursion, or lack of follow-through.

MFE/MAE are daily-bar diagnostics, not intraday execution records.

## Segmented Monte Carlo

The aggregate bootstrap remains visible, but V5.1.1 also exposes equity, crypto and current Regime V2 segments. A blended PASS does not hide a segment-level BLOCK.

## Recovery criteria

`FROZEN` is sticky. Recovery requires two consecutive training windows where:

1. recent learning expectancy is positive; and
2. drift is below the guarded threshold.

Even after research recovery, learned BUY_SETUP weights remain disabled until at least 10 completed actionable forward outcomes exist.
