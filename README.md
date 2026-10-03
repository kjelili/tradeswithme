# TradesWithMe V4.1.6.1 — Resilient Data + Expanded Crypto Research

TradesWithMe is a private personal market-research, forward-validation and paper-allocation desk for `https://tradeswithme.com`.

V4.1.6.1 keeps the V4.1.5 Drift Control V2 / Live Readiness rules unchanged and hardens the market-data layer that feeds them.

## What changed in V4.1.6.1

1. **Fresher equity provider selection** — Yahoo primary is checked first. If its last completed US session is stale, TradesWithMe checks Stooq and a Yahoo mirror and chooses a verified fresh result instead of blindly keeping the primary response.
2. **SPY benchmark rescue** — if the public equity feeds are still stale and `ALPHAVANTAGE_API_KEY` is configured, a compact Alpha Vantage daily response can patch the latest SPY sessions onto the long Yahoo/Stooq history. This is benchmark resilience, not a relaxation of the data gate.
3. **Research-only stale equities** — the freshest real equity history can still be displayed for diagnostics when it is one or more sessions behind, but it cannot produce a new `BUY_SETUP` until the strict session-aware gate passes.
4. **Later daily cycle** — Vercel cron moves from `00:20 UTC` to **`02:20 UTC`**, giving completed US daily feeds more publication time.
5. **Expanded crypto research universe** — the default crypto set grows from 10 to 28 USD pairs and the total scan ceiling rises to 50 symbols. The autonomous worker merges this crypto expansion with your personal watchlist.
6. **Flexible Kraken classification** — any `BASE-USD` watch symbol is treated as crypto, and Kraken `AssetPairs` can resolve newer REST pair codes before the system fails closed.

Adding a coin to the research universe means **monitor and validate**, not buy. Unsupported or insufficient-history pairs cannot become actionable.

## Expanded crypto universe

```text
BTC-USD,ETH-USD,SOL-USD,XRP-USD,DOGE-USD,ADA-USD,LINK-USD,AVAX-USD,DOT-USD,LTC-USD,
BNB-USD,BCH-USD,TRX-USD,XLM-USD,HBAR-USD,SUI-USD,TON-USD,NEAR-USD,AAVE-USD,UNI-USD,
SHIB-USD,PEPE-USD,ICP-USD,ATOM-USD,ALGO-USD,FIL-USD,ETC-USD,XTZ-USD
```

The expansion intentionally mixes established majors with newer large-cap / actively traded networks. TradesWithMe still ranks them by its own evidence, data-quality and validation gates rather than assuming recent winners will keep winning.

## Autonomous daily loop

Vercel calls `/api/cron/daily-scan` daily at **02:20 UTC**:

```text
settle previously frozen outcomes
        ↓
train bounded policy from completed outcomes
        ↓
load server-synced watchlist / holdings / risk rules
        ↓
merge expanded crypto research universe
        ↓
scan verified equities + crypto
        ↓
create the £50 paper-only overnight plan
        ↓
freeze new actionable + shadow observations
        ↓
persist scan + audit record
```

## Learning / live-readiness rules

V4.1.6.1 does **not** loosen V4.1.5's learning or risk rules:

- `<15` effective samples: `COLD_START`
- `15–29.5`: `SHADOW`
- `30+`: `ADAPTIVE` when drift is normal
- material but non-persistent drift: `GUARDED`
- persistent/severe drift: `FROZEN`
- learned weights remain research-only until at least **10 completed actionable signals** exist
- live-readiness uses actionable forward outcomes only; shadow results never qualify live use

## Supabase

No new schema migration is required if the V4.1.5 schema is already installed. Running `supabase/schema.sql` again is safe but optional for this release.

## Vercel environment variables

```text
APP_ACCESS_CODE=<private dashboard code>
CRON_SECRET=<different random secret>
PERSONAL_WATCHLIST=SPY,QQQ,IWM,DIA,AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,AMD,AVGO,NFLX,PLTR,JPM,BAC,XOM,GLD,TLT,BTC-USD,ETH-USD,SOL-USD,XRP-USD,DOGE-USD,ADA-USD,LINK-USD,AVAX-USD,DOT-USD,LTC-USD,BNB-USD,BCH-USD,TRX-USD,XLM-USD,HBAR-USD,SUI-USD,TON-USD,NEAR-USD,AAVE-USD,UNI-USD,SHIB-USD,PEPE-USD,ICP-USD,ATOM-USD,ALGO-USD,FIL-USD,ETC-USD,XTZ-USD
OVERNIGHT_PAPER_BUDGET_GBP=50
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
ALPHAVANTAGE_API_KEY=<recommended>
```

You do not have to replace an older `PERSONAL_WATCHLIST` immediately: the autonomous V4.1.6.1 cron merges the expanded crypto universe into the personal list server-side. Updating the variable simply makes the configured universe explicit.

Keep `SUPABASE_SECRET_KEY` server-side only. Do not use `NEXT_PUBLIC_` and do not restore the legacy `SUPABASE_SERVICE_ROLE_KEY` variable.

## Data sources / fail-closed behavior

- Equities: Yahoo primary → Stooq → Yahoo mirror; SPY may use an Alpha Vantage compact freshness patch when configured
- Crypto: Kraken completed daily OHLC, with `AssetPairs` resolution for newer pair codes
- GBP/USD: Frankfurter
- Earnings: Alpha Vantage when configured

SPY and BTC-USD remain benchmark gates. A stale real feed may support research diagnostics, but it cannot create a new actionable setup until the data gate is fresh.

## Run locally

```bash
npm install
npm run dev
```

## Deploy / push

Vercel Root Directory should be blank and Framework Preset should be Next.js.

```powershell
git init -b main
git remote remove origin 2>$null
git remote add origin https://github.com/kjelili/tradesiq.git
git add .
git commit -m "Upgrade TradesWithMe to V4.1.6.1 resilient data and expanded crypto"
git push --force -u origin main
```

## Real-money boundary

TradesWithMe automates research, paper allocation, validation and bounded learning — **not unattended live trading**. The £50 overnight feature remains paper-only. Expanding the crypto universe increases opportunity coverage and also increases exposure to volatile assets; it does not make profitability more certain.
