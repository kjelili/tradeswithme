# V4.1.1 Autonomous Learning Observatory

## Why one daily cycle

TradesWithMe currently reasons from completed daily bars. Re-running the same analysis many times during the day would not create independent evidence and could encourage overfitting. The production schedule therefore runs once per day at `00:20 UTC`, after the prior U.S. session has closed and around the completion of the Kraken daily candle.

## Cycle order

1. Settle any actionable and shadow observations that now have enough completed future bars.
2. Retrain the bounded learning policy from those completed observations.
3. Load the owner-synced watchlist, positions and risk settings.
4. Fetch and validate market/event/FX data.
5. Scan equities and crypto using the freshly trained policy.
6. Build the £50 paper-only overnight allocation and morning review queue.
7. Freeze qualifying new actionable and shadow observations.
8. Persist the scan and write an automation audit record.

The order matters: V4 previously trained after scoring the current scan, which meant fresh evidence could wait another cycle before influencing analysis. V4.1.1 trains first.

## Observatory fields

The dashboard reads `/api/observatory` and shows:

- last scheduled run status;
- next expected run;
- actionable completed/pending counts;
- shadow completed/pending counts;
- effective learning sample count;
- estimated maturity queue;
- recent automation audit records.

Maturity dates are display estimates. Actual settlement always uses completed market bars returned by the verified data pipeline.

## Personal settings

The cron runs even when no browser is open. It uses `twm_owner_state` when available and otherwise falls back to Vercel environment configuration. After changing watchlist, holdings or risk rules in the dashboard, use **Sync for automation** once. This updates server-side owner state without running a market scan.

## Failure behavior

A cycle may be logged as:

- `OK`: required feeds and persistence completed normally.
- `DEGRADED`: the cycle finished but one or more nonfatal warnings/feed degradations occurred.
- `FAILED`: the scheduled cycle could not complete.

Market data remains fail-closed: failed benchmark verification prevents new setups in that asset class. Adaptive learning remains bounded and can freeze itself when drift becomes material.

## Live-money boundary

Automation covers research, paper planning, forward validation and model learning only. It does not submit broker orders. Live execution, if added later, should remain a separate human-approved workflow until real-money tracking has independently confirmed that paper/forward performance survives actual spread, fees and slippage.
