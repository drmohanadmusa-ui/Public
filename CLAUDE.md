# LedgerOS: instructions for Claude

This repo (`drmohanadmusa-ui/Public`) is served by GitHub Pages. It hosts two apps:

| File | What it is | Who maintains it |
|---|---|---|
| `LedgerOS.html` | **LedgerOS**, Muhannad's personal and family finance app. This is the project these instructions cover. | Claude Code sessions, following this file |
| `CalendarOS.html` | CalendarOS, a separate app | **Not us. Never edit it.** |
| `dev/` | LedgerOS regression tests and dev tools. It is not part of the app. | Us |
| `.claude/skills/` | Project skills: `/check-live`, `/ship`, `/data-question` | Us |

Live app: https://drmohanadmusa-ui.github.io/Public/LedgerOS.html. Muhannad uses it every day for real family money, so **treat it as production software.**

**This repo is public.** Never commit personal data: real names, balances, account numbers, Supabase URLs or keys, tokens, or screenshots of real data. Test fixtures use invented people and numbers only.

---

## 1. Message counter (no exceptions)

End **every** response with a final line showing the response number in this session. Start at 1 and go up by exactly 1 each time:

— Message #1 —

Muhannad uses it to decide when to move to a fresh session. If the conversation has been auto-compacted, say so once, in one short line above the counter (for example "Context was compacted; a fresh session soon may be wise").

## 2. Working method (agreed with Muhannad, keep following it)

1. **Verify, don't assume.** At the start of a session, run `/check-live`. Before building anything, check whether it already exists: features have been built in other chats before.
2. **Investigate the real code path** before fixing anything.
3. **Ask clarifying questions before large or ambiguous changes**, especially anything touching real family financial data. Several numbered questions at once are fine; he answers by number.
4. **Every change gets real tests** in `dev/test_batch_fixes.js`, registered in the runner list at the bottom.
5. **Break-then-restore before shipping** (`dev/break_restore.py`, see `/ship`). Every break must turn the suite red.
6. **Every version bump gets a matching `CHANGELOG` entry.**
   - `APP_VERSION` and `CHANGELOG` are near line 350 of `LedgerOS.html`.
   - Entries are plain sentences written for Muhannad. Non-ASCII characters are written as `\uXXXX` escapes, like the existing entries.
   - Use semver: a new feature bumps the minor version.
7. **Be honest about mistakes**, including mistakes in first-draft tests. Say what was wrong and what you changed.
8. **After shipping, give a short summary:** what changed, the test count, and any mistakes. **Don't send him the built HTML.** His work PC's antivirus deletes downloads, and he never handles files.
9. **He sends numbered checklists.** Say which items are already done rather than redoing them.

## 3. Deploying

- Work on the session's branch. When the work is tested, push it, and ask Muhannad to **Create PR → Merge**. GitHub Pages updates about a minute after the merge.
- If he asks for a direct push to `main` and the session allows it, that is fine. **Always rebase on `origin/main` first**, because CalendarOS commits land on the same branch.
- After the merge, confirm the version actually changed. Either:
  - run `git fetch origin main && git show origin/main:LedgerOS.html | grep "const APP_VERSION"`, or
  - fetch the live URL, if the network allows it.

## 4. Architecture essentials (read before changing anything)

The app is a single HTML file: inline CSS and JS, no build step, no framework, about 900 KB. Data syncs to Supabase Postgres. The Supabase URL and anon key are typed into a "Connect" gate on each device and kept in that browser's `localStorage`, never in the file.

**State and sync**
- One global `D` object holds all data. It is mirrored to IndexedDB.
- Any **new field on `D`** must be defaulted in `normalizeDataShape(D)`. Otherwise old caches and backups break.
- Writes go through `syncWrite(table, 'upsert'|'delete', row, base)` and `syncWriteMany`, then `persistLocal()`. An upsert sends only the columns in `row`, so partial writes are safe.

**Schema**
- `DB_SCHEMA_CORE` is the single source of truth. Idempotent `ADD COLUMN IF NOT EXISTS` statements are generated from it, so never hand-write migrations.
- **Changes must be additive only.** Muhannad runs the SQL by hand from Settings → Database Schema, so tell him whenever a schema change ships.
- If a new **table** is added, remind him to add it to his backup script's table list. It has gone stale twice before.

**Forecast and P&L**
- Use `computeMonthlyCashFlow` (anchored) for anything shown to him, never the `...Pure` variant.
- Wrap bulk forecast loops in `beginForecastFastPath()` / `endForecastFastPath()`.
- `computeForecastCell(acc, mk)` collapses closed months to actual. Call `computeForecastCell(acc, mk, mk)` when you need the original plan.

**Hardcoded lists going stale** is a recurring bug class. When adding a table, field or pref, grep for every list that enumerates its siblings.

**Investments engine** (Platform → Position → Transaction/Valuation; co-ownership through per-owner units)
- `invTxAttribution(t)` gives per-owner SAR, cash USD and rate. It uses the per-owner `sar`/`usd` stored on the transaction when present.
- `invCashState(asOfDate, opts)` replays deposits, withdrawals, transfers and cash-funded trades per platform and per owner. It keeps `usd`, `sar`, `profitUsd` and `profitSar`.
- Cash uses actual rates. `invCashAvgRate` and `invCashProfitRate` read from it. USDT and USDC count as cash (`invIsStablecoin`).
- `computePositionState` uses weighted average cost, with `openingCostSar` and `openingSar` for transfers.
- **Linked transfer legs** use `cashSide:'transfer'` plus a shared `linkId`.
- **Move coins (v4.63):** `openInvMoveAssets` carries the full cost per owner, and the network fee comes off units in proportion to each owner's share. Activity shows one line per move (kind `'coinmove'`).
- **Cost corrections (v4.59):** stored as `kind:'costadj'` rows in `pd_inv_cash_movements`. The cash maths ignores them.
- **Owner accounts:** `outAcc` is labelled "Invested into platform" and `inAcc` "Withdrawn from platform". His chart of accounts names accounts from the **platform's** perspective: "X - In" means money into platform X.
- **Withdrawals:** capital at cost goes to the withdrawn account and the rest goes to Profit (`invWithdrawalBooking`).
- **Views:** Mine / Family / Activity / Reconcile / Insights / Setup / Classic (`INV_VIEWS`, `invView`).
- **Pooled family contributions:** Collect Contributions plus "Split by platform cash".
  - **The app never posts ledger JVs for this.** Muhannad posts them by hand.

**Accruals (v4.61)**
- `pd_accrual_mappings.cap_months` sets the cap. `computeAccrualJV` accrues only up to cap months × that month's budget.

## 5. Tests

- **Run:** `bash dev/run_tests.sh`. It extracts the app's JS to `dev/.build/`, installs `jsdom` and `fake-indexeddb` on first run, prints any `FAIL` lines, then `N passed, 0 failed`.
  - The baseline at the move to Claude Code was **1701 passed** (v4.63.0).
  - Console noise about `QuotaExceededError` or "Not implemented: scrollTo" is expected.
- **Harness basics:**
  - `makeSandbox()` gives a fresh app context in a vm.
  - Fixture sandboxes: `invCashSandbox`, `poolSandbox`, `v455Sandbox`, `fxSandbox`, `viewSandbox`, `moveSandbox`, `costSandbox`, `capSandbox`, `allocSandbox`, `jamSummarySandbox`.
  - `sb.__set(name, value)` overrides top-level `let`/`const` values. Read them back with `vm.runInContext('name', sb)`, not `sb.name`.
  - `freezeDate(sb, iso)` pins "today". Modals need a `#modalRoot` div.
- **Quirks:**
  - Chart.js isn't loaded, so chart logic lives in standalone functions.
  - JSDOM doesn't turn inline `onclick="..."` into a callable, so tests check the onclick source text.
  - The global input CSS gives checkboxes `width:100%`; use `class="chk" style="width:auto"`.
- **Guard every `.match(...)[1]`, `[0]` and `querySelector(...)` in assertions.** Otherwise a deliberate break crashes the run instead of giving a clean FAIL.
- **No placeholder assertions** such as `|| true`.
- **Patch carefully.** When editing `LedgerOS.html` with scripted replacements, assert each target snippet occurs exactly once. After a big edit, check every function you touched still exists exactly once: a large replace once swallowed a whole function.

## 6. Real data (read-only)

- Muhannad has a **read-only** Supabase connector. Use it only to answer questions about his data (see `/data-question`).
- **Never write, insert, update or delete** real data from a session.
- Figures from real data go in chat only, never into the repo.
- Read the actual connection code before making any security claim. A placeholder URL was once mistaken for a live one.

## 7. Boundaries

- Never edit `CalendarOS.html`.
- Never touch these repos: `personal-apps-hosting` (must stay private), `WebApps` (an old copy) and `personal-data-backups`. They are his to manage.
- Never post ledger JVs on his behalf. Never make destructive schema changes.
- Keep the deliberately empty Railway project as it is.

## 8. Open items and future features (ask before starting any of them)

- **Redesign to v5.0.0 ("Command Center") is agreed and ready to build.** Follow `dev/redesign/REDESIGN_PLAN.md`; the mockup sources are in `dev/redesign/mockup/`.

- **Security hardening (planned):** add Supabase Auth sign-in and tighten the database policies. Muhannad has the details. It needs careful planning with him because it touches every sync path and his backup script.
- **A platform-to-platform cleanup is in progress:** recording some missing buys, then using Move coins. Muhannad has the details. Afterwards, read the moved cost (read-only) so he can post the matching ledger JV himself.
- **Future features:**
  - When coins move between platforms with different invested accounts, offer the matching JV ready-made in New JV for him to post.
  - Per-person shareable investment statement.
  - Automatic live prices.
  - Platform value from positions vs a single statement number. Parked by him.
- **Deferred ("ignore for now"):** editing an old transaction adds the price to the history as today's price. The screen was never identified.

## 9. Recent version history (full detail is in the in-app CHANGELOG)

| Version | What shipped |
|---|---|
| 4.55 | Reconcile pane shows the last 3 posted JVs; Jamiah month net; "Accrued" chips; budget export with or without history |
| 4.56 | Forecast wide export gets one Source column; budget import writes only changed cells |
| 4.57 | Actual-rate cash: Collect records the rate; cash buys snapshot cost; withdrawals book profit |
| 4.58 | Investments split into views (Mine / Family / Activity / Reconcile / Insights / Setup / Classic) |
| 4.59 | Batch cost corrections (recorded in Activity); CSV import keeps per-owner cost |
| 4.60 | Jamiah Pledge / Round column; add a line to an existing allocation |
| 4.61 | Accrual cap per sub category |
| 4.62 | Platform-perspective wording: "Invested into platform" / "Withdrawn from platform" |
| 4.63 | Move coins between platforms (multi-asset, sent vs received, fee per owner, full cost carried) |
