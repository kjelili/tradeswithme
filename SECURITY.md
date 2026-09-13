# TradesWithMe V4.1.1 security notes

TradesWithMe V4.1.1 is intended for one owner's private research workflow.

- Keep `APP_ACCESS_CODE`, `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` and `ALPHAVANTAGE_API_KEY` only in server-side Vercel environment variables.
- Never expose the Supabase service/secret key through `NEXT_PUBLIC_*` variables or client code.
- Supabase tables use RLS and the application accesses them from server routes with the service key.
- The adaptive learner stores strategy weights, calibration statistics and performance summaries; it does not need broker credentials.
- V4.1.1 does not contain a live broker execution adapter. The overnight allocator is paper-only.
- The learner cannot modify hard risk governance such as the £50 cap, portfolio limits, stops, data gates or event gates.
- If a secret is ever committed to GitHub, rotate it immediately in the provider dashboard and Vercel.
