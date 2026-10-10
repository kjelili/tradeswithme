# TradesWithMe V5.2 — Discovery & Governance

Private personal market-research, forward-validation and paper-allocation desk for `https://tradeswithme.com`.

V5.2 adds a **research-only governance layer** on top of V5.1.1 Signal Intelligence. It does not loosen `BUY_SETUP` thresholds, increase the £50 paper ceiling, change risk limits or add live broker execution. The purpose is to make strategy discovery scientific, reproducible and difficult to overfit.

## V5.2 additions

- **Isolated Strategy Discovery Sandbox** — bounded challenger weight variants are generated around the current champion. They are research-only and cannot alter safety gates or execution authority.
- **Diversity Archive** — MAP-Elites-inspired family preservation keeps trend, momentum, reversion, breakout, balanced and baseline families separate instead of allowing many near-identical challengers to masquerade as independent agreement.
- **Pareto Promotion Engine** — candidates are evaluated on robustness, tail-risk resilience and strategy concentration. Raw return alone cannot win promotion.
- **Failure Replay Lab** — completed actionable trades are replayed from the agent votes that were frozen before outcomes were known. Challengers are penalized for missing prior winners or repeating prior losses.
- **Agent Governance / Interference Audit** — compares intended strategy influence with realized ensemble influence and surfaces cases where external gates suppress otherwise-positive specialists.
- **Conflict Matrix** — shows current symbols where strong supporting agents and strong objecting agents disagree, including the dominant blocker and final action.
- **No auto-promotion** — a challenger can at most become a `SHADOW_LEADER`. It never changes live authority, risk caps or the production champion automatically.

## Existing V5.1.1 intelligence retained

- strict prediction-market entity relevance;
- flow/on-chain context with explicit proxy labelling when no direct provider is configured;
- Kraken crypto order-book microstructure;
- agent attribution;
- trade autopsy with MFE/MAE;
- segmented Monte Carlo;
- Drift Control V2 and recovery criteria;
- Regime Engine V2, robustness matrix, counterfactual gate calibration;
- Forward Trust and Live Readiness based only on actionable forward evidence.

## Supabase

V5.2 stores the governance snapshot inside the existing persisted scan payload, so **no new V5.2 table is required**. If your database is already migrated through V5.1.1, keep it as-is.

If you are upgrading from an older build, running the complete `supabase/schema.sql` remains safe and preserves existing history.

## Vercel environment variables

```text
APP_ACCESS_CODE=...
CRON_SECRET=...
PERSONAL_WATCHLIST=...
OVERNIGHT_PAPER_BUDGET_GBP=50
SUPABASE_URL=https://...supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
ALPHAVANTAGE_API_KEY=...
```

Optional direct on-chain context:

```text
WHALE_ALERT_API_KEY=...
WHALE_ALERT_MIN_USD=1000000
```

Without the optional key, crypto flow remains explicitly labelled `MARKET_FLOW_PROXY`.

## Autonomous cycle

`vercel.json` runs the research cycle at **02:20 UTC**:

```text
settle outcomes
→ retrain bounded learner
→ fetch verified markets
→ Quant Intelligence
→ Signal Intelligence
→ Discovery & Governance sandbox
→ £50 paper plan
→ persist ledgers + scan
```

## Governance lifecycle

```text
Champion
  ↓
bounded challengers
  ↓
isolated evaluation
  ↓
robustness + Monte Carlo + diversity
  ↓
Pareto frontier
  ↓
failure replay against frozen forward cases
  ↓
SHADOW_LEADER at most

NEVER automatic live promotion
```

## Local run

```bash
npm install
npm run typecheck
npm run build
npm run dev
```

## GitHub / Vercel root

The repository root must directly contain:

```text
app/
components/
docs/
lib/
public/
supabase/
package.json
vercel.json
```

In Vercel use **Framework Preset: Next.js** and leave **Root Directory blank**.

## Safety boundary

TradesWithMe remains a research and paper-planning system. Strategy discovery and replay are diagnostics, not proof of profit. V5.2 contains no live broker execution path.
