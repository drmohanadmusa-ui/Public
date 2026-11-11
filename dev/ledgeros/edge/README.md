# LedgerOS daily closing prices (Supabase Edge Function)

`inv-daily-close/index.ts` runs once a day on Supabase, even when LedgerOS is closed. It reads the price links and
API keys you set in LedgerOS (⚙ Setup → 💹 Price links, saved with your synced settings), fetches one price per
linked position, and saves it as **the closing price of the previous day (UTC)** in `pd_inv_valuations`.

- Run time: 00:05 UTC (03:05 Riyadh). Crypto has no real close, so "the price at midnight UTC" is used, the usual
  convention. US stocks get their last session's close.
- A close has a fixed id per position and date (`1e12 + positionId × 100000 + day number`, the same formula as the
  app's `invCloseValId`). Re-running the job, or the app's **Backfill daily closes**, rewrites the same row.
- On the same date a close beats a price from a refresh (`invValCmp`).
- Sources: DexScreener (GeckoTerminal as backup) for contract addresses, CoinGecko for coin ids, Finnhub for stocks.
- It writes with the project's service key, which Supabase gives the function itself. The key is never in this
  repo or in the app.
- Tests: in the main suite (`bash dev/ledgeros/run_tests.sh`), the `edge:` tests.

## One-time setup (Muhannad, in the Supabase dashboard, about 5 minutes)

### 1. Create the function
1. Supabase dashboard → your LedgerOS project → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `inv-daily-close`.
3. Delete the sample code, paste the whole of `dev/ledgeros/edge/inv-daily-close/index.ts`, then **Deploy**.

### 2. Test it once
In LedgerOS: ⚙ Setup → 💹 Price links → **▶ Run the daily job now**. It should report how many closes were
saved for yesterday. (Or in the dashboard: the function's **Test** tab → Send.)

### 3. Schedule it daily
Supabase dashboard → **SQL Editor** → new query. Replace the two placeholders with your Project URL and anon key
(the same two values as LedgerOS's Connect screen), then **Run**:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ledgeros-inv-daily-close',
  '5 0 * * *',                       -- every day at 00:05 UTC
  $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT.supabase.co/functions/v1/inv-daily-close',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer YOUR-ANON-KEY'),
    body    := '{}'::jsonb
  );
  $$
);
```

To check it ran: SQL Editor → `select * from cron.job_run_details order by start_time desc limit 5;`
To stop it: `select cron.unschedule('ledgeros-inv-daily-close');`

### When the code changes
Edge Functions → `inv-daily-close` → **Code** → paste the new version → **Deploy**. The schedule stays.

## When the security hardening happens
The job uses the service key, so tighter table policies won't stop it. The pg_cron call uses the anon key only to
reach the function. Revisit this when Supabase Auth is added.
