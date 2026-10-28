# V5.4 Broker execution (Alpaca + Kraken)

The nightly cron (02:20 UTC) now ends with an execution cycle:

```text
settle → train → scan → persist evidence
→ manage open bot positions (stops/targets/time exits)
→ reconcile broker vs ledger
→ decide mode (OFF / PAPER / LIVE)
→ place new protected entries from the overnight plan
→ email alert
```

## Safety model

| Guard | Behaviour |
|---|---|
| Default | `EXECUTION_MODE=off` — nothing is sent to any broker. |
| Evidence gate | `live` is honoured **per asset class** only when that class is `VALIDATED` **at realistic broker costs** (≥100 settled calls of that class, expectancy ≥0.2%, PF ≥1.3, max DD ≤10% after Alpaca 0.10% / Kraken 1.25% round trip). Other classes stay on paper. |
| Hard cap | Total open bot exposure ≤ `LIVE_HARD_CAP_GBP` (default £50; code ceiling £1,000). |
| Positions | Max 3 open. One per symbol. Whole shares on Alpaca. |
| Broker-held stops | Alpaca: bracket order (GTC take-profit + stop). Kraken: post-only limit buy 0.2% below market (maker fee, expires after 20h) with a conditional stop-loss close. Stops work while the app sleeps. |
| Loss breaker | Live entries stop when 30-day realised loss ≥ `LOSS_BREAKER_PCT` of the cap. |
| Kill switches | Owner desk "Halt" (instant, DB) · `TRADING_KILL_SWITCH=on` (env) · "Flatten all" closes everything. |
| Reconciliation | Unknown Alpaca positions block new entries. Unreadable state fails closed. |
| Idempotency | One order per symbol/day/mode (`client_ref` unique). Ambiguous timeouts are reconciled, never resubmitted. |
| Auth | Owner endpoints now fail closed in production if `APP_ACCESS_CODE` is missing. |

Kraken has no spot sandbox: in PAPER mode Kraken orders are sent with `validate=true` (checked, never executed). Alpaca PAPER uses Alpaca's paper account.

## Setup

1. Re-run `supabase/schema.sql` (adds `twm_exec_orders`, `twm_exec_state`).
2. Alpaca: create a **paper** account, add `ALPACA_PAPER_KEY_ID/SECRET`. Apply for live (UK: NINO or UTR) later.
3. Kraken: create an API key with **Query Funds, Query Open/Closed Orders, Create & Modify Orders, Cancel Orders**. **Never enable Withdraw.** Hold USD for USD pairs. Use a sub-account or dedicated account if possible.
4. Optional: `RESEND_API_KEY` + `ALERT_EMAIL` for email alerts.
5. Set `EXECUTION_MODE=paper`. Watch the "Autopilot" panel on `/desk` for a few weeks.
6. Add live keys and set `EXECUTION_MODE=live`. It stays on paper until the evidence gate turns VALIDATED.

## Known limitations (verify before trusting real money)

- Kraken: confirm on the first live order that the conditional stop-loss carries the same `userref` (the bot finds and cancels it by userref). If it does not, you will receive "No stop found" alerts.
- Exit prices for time/target market closes are recorded as the last-price estimate, not the exact fill.
- At a £50 cap most US stocks cost more than one share per slot, so trades will be mostly crypto.
- The bot checks once per day. Stops are broker-side, but targets on Kraken and time exits are only evaluated at 02:20 UTC.
- UK tax: gains are subject to Capital Gains Tax. Keep the ledger export.

## Historical trade replay (run this before trusting anything)

`/desk` → **Historical trade replay** → *Run replay (all symbols)*, or locally `npm run replay`.

- Walks every past day using only the bars available that day and the **same `decideSymbol` code the live bot uses** (`lib/engine/decision.ts`). A test proves decisions don't change when future bars change.
- Simulates the executor's real orders: Alpaca bracket limit (entry ×1.003, intraday stop/target); Kraken post-only limit at min(plan, open)×0.998 that only fills if price trades down to it, broker stop, target/time checked once a day; gaps through a stop fill at the open.
- Realistic costs (same as the real-money gate, `BROKER_ROUND_TRIP_BPS`): crypto **1.25% round trip** (Kraken tier-1 0.40% maker entry + 0.80% taker exit + slippage), equities 0.10%. Toggle to the ledger's 0.16% to see cost sensitivity.
- Verdict: `NO_EDGE` (avg ≤ 0, PF < 1.2 or DD > 25%), `INCONCLUSIVE` (< 30 trades or below the validated bar), `PROMISING` (≥100 trades, PF ≥ 1.3, avg ≥ 0.2%). Even PROMISING still needs forward paper confirmation.
- Not modelled: earnings blocks, correlation to existing holdings, learned weights. Crypto history is capped at ~720 days by Kraken.

**Costs:** the research ledger keeps deducting 0.16% for continuity, but the real-money gate (`executionReadiness` in the validation summary) re-scores every settled call at realistic broker cost, separately for equities and crypto. Recorded live P&L also deducts estimated fees, so the loss breaker sees what the account sees.

Fee tiers change. If your Kraken 30-day volume moves you to a cheaper tier, update `BROKER_ROUND_TRIP_BPS` in `lib/engine/config.ts`.

- Kraken partial fills: a post-only limit can fill partly before it expires. The bot opens the filled volume. Confirm on the first live partial fill that Kraken attaches the conditional stop to that volume.

## V5.5 — edge gate, chase filter, funnel, agents, chance of profit

Adopted from reviewing two trading-bot demos (a Polymarket HFT desk and a Solana copy-trading bot). Their strategies were **not** adopted (Polymarket is close-only for UK residents and needs always-on low-latency infrastructure; memecoin copy-trading is rug-pull-prone and untestable). Their *transparency* ideas were.

| Feature | Where | What it does |
|---|---|---|
| Edge-after-costs gate | `lib/engine/edge.ts`, executor | Refuses a trade when round-trip cost exceeds 25% of the stop distance, or (once 30+ settled calls exist) when the win-rate lower bound is below the trade's break-even win rate after costs. `EDGE_GATE=off` disables. |
| Chase filter | same | Refuses entries already up ≥20% (crypto) / ≥10% (equities) over the last 5 bars. `CHASE_FILTER=off` disables. |
| Maker-fill tracking | replay | Fill rate of Kraken post-only entries and what the missed trades would have returned as market buys (at 1.65% taker cost). |
| Decision funnel + skip reasons | `lib/engine/funnel.ts`, desk | Scanned → verified → strong signal → all gates → overnight plan → orders, with the top reasons signals died. Saved every nightly run, even with execution off. |
| Agent activity log | `twm_activity_log`, desk | Scout / Filter / Analyst / Risk / Executor narration of each run. |
| Why it traded | `twm_exec_orders.rationale`, desk | Click any order: agents for/against, score/evidence, risk vs reward, break-even win rate after costs, 5-bar run-up. |
| Chance of profit | `chanceOfProfit()`, desk + replay | Bootstrapped fan of the next 100 trades from replay trades or the forward ledger at broker cost. Not a forecast. |

The replay's filter toggles show whether the edge gate and chase filter actually removed losing trades. Keep a filter on only if the removed trades averaged below zero.

Migration: re-run `supabase/schema.sql` (adds `rationale` and `twm_activity_log`).

## V5.6 — Improvement lab (`/desk` → Improvement lab, or `npm run lab`)

The first real replay (Oct 2023 – Oct 2026) showed 44 trades at +0.46% after costs, PF 1.49, but only 1 of 44 trades reached its 2R target (34 timed out) and a +7% portfolio return against SPY +75%. The lab asks whether *any* simple change makes it beat just holding — without fooling itself.

- **One decision per day, 27 variants on top.** Entry bar strict (live) / medium / loose × target 1R / 1.5R / 2R × hold 5 / 10 / 20 days. The entry rules are the live `classifyEntry` with different thresholds, and a per-day **parity check** proves the lab's strict entry equals the live decision (shown on the panel; must be 0).
- **Scored vs the benchmark.** Every trade's return is compared with holding SPY (stocks) or BTC (crypto) over the same dates ("vs bench"). Positive net but zero alpha means it is just market exposure.
- **Train / held-out split.** Variants are ranked on everything before the last 365 days (by t-stat of net returns). The winner is then judged only on the held-out year. Verdicts: `EDGE HOLDS OUT OF SAMPLE` (≥30 held-out trades, alpha t ≥ 2, 95% range above 0), `PROMISING, NOT PROVEN`, `NO EDGE`.
- **Simple strategies to beat:** buy-and-hold and "hold SPY only when above its 200-day average" (decided on the previous close, switch costs included), for the full period and the held-out year.
- **Sizing:** share of the winner's stock trades that cannot buy one whole share at £50 / 3 slots, and the cap that would cover 90%. Alpaca fractional shares only support *day* orders (no brackets), so fractional execution would need the stop re-placed every morning before the open.

Only change the live config to a lab variant if it earns `EDGE HOLDS OUT OF SAMPLE` — and then still paper-trade it first.

## V5.7 — Simple allocation strategies + monthly signal email

The improvement lab returned **NO EDGE** for the signal engine (all 27 variants negative after costs on the held-out year; best training variant −0.04% vs SPY). V5.7 adds the alternative the evidence favoured: simple, textbook, once-a-month rules an individual can run in a Stocks & Shares ISA.

- `/desk` → **Simple allocation strategies** (top of the desk): hold S&P 500; S&P 500 above its 200-day average (monthly / daily); dual momentum (US vs emerging, else cash or long bonds); rotation among S&P 500, Nasdaq-100, emerging, gold, long Treasuries (top 1 or 2, 6- or 12-month); and watchlist stock momentum (flagged: survivorship bias).
- ~10 years of daily data, 0.05% per unit of turnover, decide at a close → apply from the next day (a test proves no look-ahead). Held-out = last 2 years. Ranked by Sharpe on the training years.
- Cards show **Hold now**, "if the month ended today", and example UCITS (LSE) equivalents for an ISA. Results are USD on US-listed proxies; GBP holders also carry FX moves.
- The nightly cron emails starting positions once, then the month's positions on the first run of each month, and an alert whenever the daily 200-day rule flips. Needs `RESEND_API_KEY` + `ALERT_EMAIL` and the `twm_strategy_signal` table.

Public site: new **Strategy audit (£99, `STRIPE_AUDIT_LINK`)** — you run a customer's rules through the replay/lab and send the verdict. The Founding member plan now promises monthly rules-based allocation signals instead of daily trade ideas (the lab showed those have no edge).

Migration: re-run `supabase/schema.sql` (adds `twm_strategy_signal`, widens `twm_waitlist.interest` to include `audit`).

## V5.8 — Robust allocation, GBP view, Trading 212 ISA rebalancer

The aim moved from "find the best line" to "find rules that are still good after we count how hard we looked".

**New strategies** (all monthly, all from published research, no tuning):

| id | Rule | Source |
|---|---|---|
| `hold_global` | 100% global all-cap tracker (VT ≈ VWRP) | the diversified benchmark |
| `blend_spy_rot` | 50% S&P 500 always + 50% best-2-of-5 rotation | — |
| `gtaa5` | US / intl shares, 7–10y Treasuries, property, commodities: 20% each while above its 10-month average, else cash | Faber (2007) |
| `tsmom_ivol` | 8 asset classes, inverse-volatility slices, held while 12-month return beats cash | Moskowitz, Ooi & Pedersen (2012) |
| `voltarget_spy` | S&P 500 exposure = 15% ÷ last month's volatility (max 100%) | Moreira & Muir (2017) |
| `ensemble` | Equal blend of 200-day trend, rotation, GTAA, multi-asset trend, vol-managed S&P | diversification across rules |
| `ensemble_tranched` | The ensemble in 4 sleeves rebalanced on different weeks | Hoffstein (rebalance timing luck) |

**Robustness columns** (`lib/engine/robustness.ts`, `allocation-report.ts`):

- **Years beat S&P** — share of full calendar years ahead of the S&P 500. Click a row for the year table.
- **P(beat S&P, 10y)** — paired 21-day block bootstrap: 1,000 alternative decades built from real months, strategy and S&P resampled together. Also reports the chance of a >30% fall.
- **Deflated Sharpe** — Bailey & López de Prado: probability the Sharpe is real after counting *every* rule and grid setting tried (27+). ≥0.95 strong; <0.5 could be luck.
- **Plateau grid** — rotation with every lookback (3/6/9/12m) × top-N (1/2/3). If only one cell is good, the result is a lucky peak.

**GBP view.** Daily ECB USD/GBP (Frankfurter) converts every fund into pounds. Decisions are still made on USD prices, so positions are identical; only returns change. Cash keeps the T-bill return as a stand-in for GBP cash interest.

**Featured cards / monthly email** now show: 50/50 blend (default, chosen after the first real GBP run: S&P-like return with a ~25% smaller worst drop), best-2-of-5 rotation, Ensemble, Hold S&P 500.

### Trading 212 ISA rebalance assistant (`/desk` → ISA rebalance assistant)

1. In the Trading 212 app: Settings → API (beta). Create a key on your **practice (demo)** account first, scopes: account, portfolio, metadata, orders:execute. The API cannot withdraw.
2. Set `T212_API_KEY`, `T212_API_SECRET`, `T212_ENV=demo`, `REBALANCE_STRATEGY` (default `blend_spy_rot`, the 50/50 blend — needs only SPY, QQQ, EEM, GLD, TLT mapped).
3. Set `T212_TICKER_MAP` — every US proxy the strategy can hold → your Trading 212 ticker. The plan **blocks** if a needed proxy is missing or a ticker isn't in your instrument list. The ensemble needs SPY, QQQ, EEM, GLD, TLT, EFA, IEF, VNQ, DBC (BIL = cash, no mapping). Rotation-only strategies need SPY, QQQ, EEM, GLD, TLT. Check every ticker in the app (they look like `VUAGl_EQ`).
4. Re-run `supabase/schema.sql` (adds `twm_rebalance_plan`).
5. "Make plan now" reads cash + positions and shows target vs now, drift and orders. **Approve & send** places sells, waits, re-reads cash, then buys sized to what's actually available.

Safety: only mapped instruments are touched; drifts under `REBALANCE_BAND_PCT` (3%) are skipped; per-order cap `REBALANCE_MAX_ORDER` (code ceiling 25,000); optional `REBALANCE_BUDGET`; plans expire after 6 h and can run once (conditional status update); never retried; `TRADING_KILL_SWITCH` and the desk Halt block it. Instruments you don't hold yet are listed as a one-off **manual** buy (the API gives no safe price for them); after that, rebalances are automatic.

Schedule: `/api/cron/rebalance` runs weekdays 10:40 UTC (London open in both GMT and BST). Default: proposes the month's plan once and emails it. `REBALANCE_AUTO=on`: executes it without approval (max 3 attempts per month, stops once EXECUTED). Run a full month on demo before `T212_ENV=live`.

## V5.9 — AI agent arena (`/desk` → AI agent arena)

People run "Grok bots" (xAI agents on an always-on cloud computer, some wired to Interactive Brokers) to trade. The public record is thin: a ~2-week Alpha Arena contest win, and a live paper tracker where 5 Grok-written bots average +3.9% (one +34%, three negative). A Grok-linked bot was also tricked into sending ~$200k of crypto in May 2026. The arena tests the idea on *your* data before any money is involved.

- **Agents:** Grok (xAI API) and Claude (Anthropic API), plus two rule agents: `hold_spy` and `blend_rule` (your 50/50 blend). Same inputs, same costs.
- **Input:** only numbers we compute at the last close — 1/3/6/12-month returns, 3-month volatility, distance from the 200-day average and from the 1-year high for 9 ETFs + cash. No web, no news, no tools, no text from outside (so nothing to inject).
- **Output:** JSON target weights, parsed strictly (known tickers only, 0–1 each, sum ≤ 1, remainder to cash). Anything else is stored as a failed day and the agent keeps yesterday's weights.
- **Scoring:** forward-only. A decision stored for close *d* earns from close *d+1*, minus 0.05% per unit of turnover. Compared with the S&P and the blend over the same days; daily-difference t-test → P(edge > 0).
- **Verdict:** `TOO EARLY` until 120 trading days. Then `AHEAD — SIGNIFICANT` (t ≥ 2), `AHEAD — COULD BE LUCK`, or `BEHIND`. Paper only, permanently: a graduate becomes a strategy the ISA rebalancer runs with your approval, never an agent with broker keys.
- **Why forward-only:** a language model has already read the price history a backtest would use, so any LLM backtest is contaminated.

Setup: re-run `supabase/schema.sql` (adds `twm_arena_decision`), set `XAI_API_KEY` + `XAI_MODEL` and/or `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` (current model ids from each provider's docs — not guessed in code). Runs inside the nightly cron; "Run today now" on the desk is idempotent.

## V6.0 — Polymarket wallet research + Betfair event agent

**Why not trade Polymarket:** Polymarket lists the UK as close-only (existing positions can be closed; new ones can't be opened). So Polymarket is used **read-only** for research, and money goes through the **Betfair Exchange** (UK Gambling Commission licensed, public API).

### Polymarket: who has an edge that isn't luck (`/desk`)

- **Scan:** the month and all-time PnL leaderboards (deduplicated) → each wallet's trades over the last 120 days (`/v2/activity`) → resolutions from Gamma (cached in `twm_pm_market`). Runs in batches; the 15-minute job keeps going until the queue is empty.
- **Luck test:** a price is a probability, so a no-skill trader's position wins with the probability paid. 3,000 replays of each wallet's own positions under that null give **P(luck)**.
- **Multiple testing:** Benjamini–Hochberg q-values across every wallet scanned. A leaderboard is selected on profit, so most rows should fail.
- **Held out:** the first two-thirds of the window flag the edge; the final third must confirm it (p < 0.1, ROI > 0) → `SKILL — HELD OUT`.
- **Also reported:** win rate vs the implied win rate it paid for, ROI, largest single-market share of profit (>50% = one big call), median bet, sizing skill (size vs result correlation), hours before close (timing), style (favourite sniper / longshot / late news-reactive). Wallets dominated by splits/merges/rewards are **excluded** as market makers.
- **Smart-money flow:** what edge-confirmed wallets bought in the last 3 days; matched by name to Betfair markets and passed to the event agent as context.

### Event agent (Betfair) — every 15 minutes

1. Settle finished bets (runner WINNER/LOSER, commission on net winnings).
2. Scan up to 60 of the busiest football / politics single-winner markets in the next 48 h.
3. **Cross-outcome arbitrage:** back-all (book < 100%) or lay-all (book > 100%) with stakes equalised across outcomes, liquidity-capped, **after commission**. Live legs are fill-or-kill.
4. **News → market → probability:** for the top markets, 24 h of headlines from GDELT + smart-money flow → the model (Claude or Grok) returns probabilities only. Headlines are fenced as untrusted data; replies are parsed to numbers or discarded.
5. **Mispricing:** the model's probability is blended with the market's (trust 30% medium / 50% high / 0% low confidence). Back or lay where the edge after commission ≥ 3%, odds ≤ 10.
6. **Kelly:** ¼ Kelly, max 2% of bankroll per bet, Betfair tick ladder, minimum stake, never more than the offered size.
7. **Real money** requires all of: a live app key (Betfair charges a one-off fee), `EVENT_AGENT_MODE=live`, the evidence gate (100 settled paper value bets, ROI > 0, t ≥ 2), no kill switch / desk halt, and total live exposure ≤ `EVENT_LIVE_CAP_GBP` (£50). `customerRef` makes Betfair reject duplicate orders; ambiguous placements are never resubmitted.

**Schedule:** Vercel Hobby crons run once a day, so `.github/workflows/event-agent.yml` calls `/api/cron/event-agent` every 15 minutes. Add repository secrets `TWM_URL` and `TWM_CRON_SECRET` (= `CRON_SECRET`).

**Setup:** re-run `supabase/schema.sql`; set `BETFAIR_APP_KEY` (start with the free delayed key), `BETFAIR_USERNAME`, `BETFAIR_PASSWORD`, `EVENT_AGENT_MODE=paper`, and the model keys from V5.9.

**Honest limits:** Betfair markets are efficient on big events; true single-market arbitrage is rare and closes in seconds (a 15-minute agent will mostly see none). The model has no special access to news beyond headlines. Betfair also charges an Expert Fee on large long-run profits. The paper record decides — not this document.
