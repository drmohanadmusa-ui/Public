# LedgerOS daily closing prices (Supabase Edge Function)

> **Deploys are done by Claude (2026-11-13).** Both functions are deployed and the schedule is set through the
> Supabase Management API with Muhannad's scoped access token (project Anthropic-LedgerOS only; Edge Functions and
> Database read-write, Project Settings and Logs read; saved as a network secret for `api.supabase.com`, 90 days).
> The dashboard steps below are kept as the fallback. Deploy command (from this folder):
> `curl -X POST "https://api.supabase.com/v1/projects/<ref>/functions/deploy?slug=<name>" -F 'metadata={"entrypoint_path":"index.ts","name":"<name>","verify_jwt":<true|false>};type=application/json' -F "file=@<name>/index.ts;type=application/typescript"`
> `inv-daily-close` runs with `verify_jwt:false` (it only saves public prices and is safe to re-run), so the pg_cron job
> needs no key; `sms-ingest` keeps `verify_jwt:true`. SQL goes to `POST /v1/projects/<ref>/database/query`.

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

---

# LedgerOS SMS ingest (Supabase Edge Function `sms-ingest`, v5.11, tracker #59)

The iPhone sends each bank SMS straight to this function (one "Get Contents of URL" step, about a second, works on a
locked phone and even right after a restart). The function runs **the same parser as the Scriptable script** (it is
generated from `sms/ledger_sms_logger.js` by `sms-ingest/build.js`), saves the row in `pd_sms_inbox` (no new table),
and answers `{result, notify}`:

| result | notify (shown by the Shortcut) |
|---|---|
| `Logged: SNB CC · SAR 75.00 · SHOP` | `Logged to Ledger Inbox: …` |
| `Duplicate, not logged: …` (a second automation for the same SMS) | nothing |
| `Needs review: <first line>` (skipped, but has an amount + currency and isn't a code) | `LedgerOS: an SMS needs a look …` |
| `Ignored: contains "…"` (marked "Not a bank" in LedgerOS) / `Skipped: …` | nothing |

Ids are the same as the Scriptable script's, so a message logged either way is never logged twice.
Ignore phrases are read from `pd_ui_prefs.dismissals.smsIgnore` (LedgerOS → 📩 SMS → Needs review → *Not a bank: ignore similar*).
Changing the parser: edit `sms/ledger_sms_logger.js`, run `node dev/ledgeros/edge/sms-ingest/build.js`, then paste the
new `index.ts` into Supabase (the main test suite fails while `index.ts` is out of date).

## One-time setup (Muhannad)

### 1. Deploy the function (Supabase dashboard, 3 minutes)
1. Supabase dashboard → your LedgerOS project → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `sms-ingest`.
3. Delete the sample code, paste the whole of `dev/ledgeros/edge/sms-ingest/index.ts`, then **Deploy**.
4. Check it: LedgerOS → New JV → 📩 SMS → **Paste an SMS** → paste any old bank SMS → **Add**. It should say
   `Logged …` or `Duplicate …`.

### 2. The iPhone (Shortcuts, about 10 minutes)
Final set of automations: **Amount**, **مبلغ**, **شراء** (delete the `SAR` and `ائتمان` ones). In each of the three:
1. Shortcuts → **Automation** → open it. Keep *Run Immediately* on, turn **Notify When Run off**.
2. Remove the old **Run Script** (Scriptable) action.
3. Add **Get Contents of URL**:
   - URL: `https://YOUR-PROJECT.supabase.co/functions/v1/sms-ingest`
   - tap the arrow (Show More): **Method** `POST`
   - **Headers** → Add new header: key `apikey`, value YOUR-ANON-KEY (tested 2026-11-13: this header alone is enough)
   - **Request Body** `JSON` → Add new field → **Text**: key `text`, value: the **Shortcut Input** variable
     (if it offers a choice, pick its **Content**)
4. Add **Get Dictionary Value**: Get **Value** for **notify** in **Contents of URL**.
5. Add **If**: *Dictionary Value* **has any value** → inside it add **Show Notification** with *Dictionary Value*. (End If.)

YOUR-PROJECT and YOUR-ANON-KEY are the same two values as LedgerOS's Connect screen. The anon key only reaches what
the app already reaches; the function writes with the project's own service key, which never leaves Supabase.
Tip: build the actions once, then select them all → Copy, and paste them into the next automation.

### 3. Afterwards
- Scriptable is no longer used for logging. Keep it until the new setup has run for a few days, then delete it.
  A missed SMS can be added in LedgerOS: 📩 SMS → **Paste an SMS**.
- No signal at all when an SMS arrives: the call fails (iOS shows "Automation failed"). Paste that SMS later; the
  **Possibly missing SMS** check in the inbox also flags the gap from the next SMS's balance.

