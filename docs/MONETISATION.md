# V5.3 Commercial layer — launch checklist

`/` is now a public sales page. The owner desk moved to `/desk` (noindex, still gated by `APP_ACCESS_CODE`).

## Go live (≈30 min)

1. **Supabase** — re-run `supabase/schema.sql` (safe; adds `twm_waitlist`).
2. **Stripe** — create two Payment Links:
   - Founding member: recurring, monthly, e.g. £19.
   - Private desk setup: one-off, e.g. £149. Add a custom field "Your Vercel/GitHub email".
   - In each link, set the confirmation page to redirect to `https://tradeswithme.com/track-record`.
3. **Vercel env** — set `STRIPE_FOUNDER_LINK`, `STRIPE_SETUP_LINK`, `FOUNDER_PRICE`, `SETUP_PRICE`, `CONTACT_EMAIL`. Confirm `APP_ACCESS_CODE` is set (otherwise `/desk` is open to anyone).
4. Redeploy. Without Stripe links, plan buttons fall back to "reserve a seat" email capture.

## Fulfilment (manual first, automate later)

- Founding members: each morning after the 02:20 UTC run, open `/desk`, copy the ranked queue + gated setups into the brief email (Stripe customer list = recipients).
- Weekly free email (Monday): settled results from `/track-record`.
- Export sign-ups: Supabase → `twm_waitlist` → CSV → your email tool.

## Compliance guardrails

- Keep the brief **general and non-personalised** (same content for every subscriber, no "you should buy").
- Keep the risk warning linked from every email.
- Get a short review from a UK financial-promotions adviser before paid advertising, especially for crypto content.
