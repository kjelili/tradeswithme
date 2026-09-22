# TradesWithMe V4.1.4 — Autonomous Learning Observatory

TradesWithMe is a private, personal quantitative research desk for `https://tradeswithme.com`. V4.1.4 turns the V4 adaptive learner into an **autonomous daily research loop**: the server settles mature frozen observations, retrains the bounded learner, scans the configured watchlist with the freshly trained policy, freezes new actionable/shadow observations, and records the run in a Learning Observatory.

It remains **paper-first and human-approved**. V4.1.4 does not include unattended live-broker execution and the learner cannot change the £50 overnight paper ceiling or the owner's risk rules.

## Autonomous daily loop

Vercel calls `/api/cron/daily-scan` every day at **00:20 UTC**. The order is deliberately causal:

```text
settle previously frozen outcomes
        ↓
train bounded policy from completed outcomes
        ↓
load server-synced watchlist / holdings / risk rules
        ↓
scan verified equities + crypto with the fresh policy
        ↓
create the £50 paper-only overnight plan
        ↓
freeze new BUY_SETUP + qualifying WATCH observations
        ↓
persist scan + automation-run audit record
```

You no longer need to press the scan button every day. Opening the dashboard simply loads the latest autonomous result. After changing watchlist, holdings, or risk rules, press **Sync for automation** once so the server cron uses the new settings.

## Learning Observatory

V4.1.4 adds:

- **Automation health**: last scheduled result, next scheduled run, and recent OK/DEGRADED/FAILED cycles.
- **Pending maturity queue**: actionable and shadow observations waiting for future bars, with estimated bars remaining and maturity dates.
- **Pipeline counters**: completed/pending actionable observations, completed/pending shadow observations, and effective learning samples.
- **Automatic training**: no manual “Train from ledger” step is required.
- **Fresh-policy scoring**: mature outcomes are settled and the model is retrained *before* the day’s scan, so a new policy does not wait an extra day to influence analysis.
- **Server-side personal state**: `/api/owner-state` stores the watchlist, holdings and risk settings used by the overnight cycle without requiring a market scan.
- **Audit log**: every scheduled cycle is recorded in `twm_automation_runs`.

See [`docs/AUTOMATION.md`](docs/AUTOMATION.md) for the scheduled lifecycle and failure behavior.

Existing V4 safeguards remain: Yahoo → Stooq equity redundancy, Kraken crypto, fail-closed benchmark regimes, Alpha Vantage earnings checks, GBP/USD health, correlation guard, rolling walk-forward validation, forward trust ledger, bounded agent reweighting, confidence calibration and drift freeze.

## Supabase migration — required

Open Supabase → SQL Editor, paste the entire contents of:

```text
supabase/schema.sql
```

and click **Run**. The schema is safe to re-run. V4.1.4 adds:

```text
twm_automation_runs
```

while preserving the existing V4 tables:

```text
twm_scans
twm_owner_state
twm_forward_signals
twm_shadow_signals
twm_learning_state
twm_learning_runs
```

## Vercel environment variables

```text
APP_ACCESS_CODE=<private dashboard code>
CRON_SECRET=<different random secret>
PERSONAL_WATCHLIST=SPY,QQQ,IWM,DIA,AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,AMD,AVGO,NFLX,PLTR,JPM,BAC,XOM,GLD,TLT,BTC-USD,ETH-USD,SOL-USD,XRP-USD,DOGE-USD,ADA-USD,LINK-USD,AVAX-USD,DOT-USD,LTC-USD
OVERNIGHT_PAPER_BUDGET_GBP=50
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
ALPHAVANTAGE_API_KEY=<optional-but-recommended>
```

Keep the Supabase secret server-side only. Never prefix it with `NEXT_PUBLIC_`.

## Learning lifecycle

- **<15 effective samples — COLD_START:** baseline weights only.
- **15–29.5 effective samples — SHADOW:** learned weights are visible but not applied.
- **30+ effective samples — ADAPTIVE:** bounded learned weights and confidence calibration may influence subsequent scans.
- **Drift score ≥70 — FROZEN:** adaptive weights are disabled and scoring falls back to the original ensemble.

A completed actionable signal counts as `1.0` effective sample. A completed shadow observation counts as `0.5`. Shadow observations never inflate the Forward Trust score.

## Forward-validation requirement

Thirty completed actionable signals are only the beginning of usable evidence. TradesWithMe keeps **100 completed actionable forward signals** as the minimum for a `ROBUST` trust label. Self-training does not override this requirement.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Deploy / push

Vercel Root Directory should be blank.

```powershell
git init -b main
git remote remove origin 2>$null
git remote add origin https://github.com/kjelili/tradesiq.git
git add .
git commit -m "Upgrade TradesWithMe to V4.1.4 Autonomous Learning Observatory"
git push --force -u origin main
```

## Real-money boundary

V4.1.4 automates **research, paper allocation, validation and model training**, not live-money execution. A good learner, backtest or evidence score does not establish future profitability. If the system eventually demonstrates a robust forward edge, live trading should begin as a small human-approved pilot with actual broker spreads/fees/slippage measured against the paper ledger.

## V4.1.4 reliability patch

V4.1.4 hardens autonomous Supabase authentication. The server now requires `SUPABASE_SECRET_KEY` to be a modern `sb_secret_...` key and sends it only in the `apikey` header. Legacy JWT `service_role` authentication is deliberately disabled so cron and manual runs cannot diverge onto different auth paths. The cron records the exact failed phase (`SETTLE`, `TRAIN`, `SCAN`, `PERSIST`, etc.) and the Observatory displays the failure detail directly.

V4.1.4 requires `SUPABASE_SECRET_KEY=sb_secret_...`. Remove `SUPABASE_SERVICE_ROLE_KEY` from Vercel so no legacy JWT can be selected.

### V4.1.4 transient Supabase auth hardening

V4.1.4 keeps the strict `sb_secret_...`-only Data API path from V4.1.2 and adds bounded retries for one narrowly identified transient Supabase/PostgREST response: HTTP 401 `PGRST303` with `JWT issued at future`. It retries that exact condition after 1.5s, 3s and 5.5s. Other 401s and all unrelated failures still fail closed. This avoids masking a bad key, wrong project URL, missing grant or malformed query while making the autonomous settle/train/scan loop resilient to intermittent downstream clock-skew responses.

## V4.1.4 settlement + trade-gate observability fix

V4.1.4 fixes the maturity display and settlement diagnostics exposed by the live V4.1.3 run history.

- Pending progress is now anchored to each symbol's latest verified market-data date from the most recent autonomous scan, not to the wall clock. A weekend, exchange closure, or provider lag can therefore no longer make an observation look mature before five completed bars actually exist.
- The maturity queue now shows **verified bars**, a `WAITING`/`DUE` status, and the actual market-data date used for that estimate.
- Settlement no longer silently swallows per-symbol failures. The autonomous run records market-data, settlement, or persistence diagnostics and marks the cycle degraded when appropriate.
- The cron response includes `settlementWaiting` and `settlementIssues`, making a manual production test auditable.
- A new **Trade Gate Observatory** summarizes why candidates did not become `BUY_SETUP`s. It records blockers such as score below threshold, data-gate failure, benchmark verification, event risk, retired strategies, high correlation, or zero position size. It does not relax any gate automatically.

No Supabase schema migration is required for V4.1.4. Existing V4/V4.1 learning history is preserved.
