# TradesWithMe V5.2 security notes

TradesWithMe is a personal research and paper-planning application. V5.2 does not contain a live broker order path.

## Server-only secrets

Keep these only in Vercel server environment variables:

```text
APP_ACCESS_CODE
CRON_SECRET
SUPABASE_SECRET_KEY
ALPHAVANTAGE_API_KEY
WHALE_ALERT_API_KEY   # optional
```

Never prefix privileged credentials with `NEXT_PUBLIC_` and never commit `.env.local`.

## Discovery & governance isolation

V5.2 challenger strategies are research-only. They cannot:

- change the £50 overnight hard cap;
- raise account risk or portfolio-exposure limits;
- bypass data, event, correlation or execution-quality gates;
- submit broker orders;
- replace the champion automatically;
- modify historical forward outcomes;
- train on future bars that were unavailable when a signal was frozen.

Failure Replay uses frozen pre-outcome agent votes and later-known outcomes only for regression scoring. Replay results are not fed back into the historical inputs used to generate the original trade.

## Pareto governance

Candidate comparison deliberately uses multiple objectives. No strategy is promoted solely because it has the highest backtest return. Diversity preservation and replay penalties reduce the risk of overfitting a single strategy family.

## Supabase

Use the modern `sb_secret_...` project secret in `SUPABASE_SECRET_KEY`. Do not expose it to the browser. The app fails closed when persistence/authentication fails.

## Signal Intelligence safety

Public Kraken depth, prediction-market context and optional Whale Alert transfer context remain research-only. Prediction-market probabilities are not ground truth and proxy flow is explicitly labelled as proxy data.

## Access-code scope

The personal access code protects owner-facing API routes. `CRON_SECRET` independently protects the autonomous daily endpoint. Use different strong values and rotate any secret accidentally exposed in screenshots or logs.
