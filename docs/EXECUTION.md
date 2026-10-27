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
