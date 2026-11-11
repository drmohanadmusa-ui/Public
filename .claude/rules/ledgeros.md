---
paths:
  - "LedgerOS.html"
  - "dev/ledgeros/**"
  - ".claude/skills/ledgeros-*/**"
---

# LedgerOS: app-specific instructions

These rules add to the shared rules in the root `CLAUDE.md` (message counter, public-repo privacy, one app per session).

**What this covers:**
- **App:** `LedgerOS.html`, Muhannad's personal and family finance app. Live at https://drmohanadmusa-ui.github.io/Public/LedgerOS.html.
- **Tests and tools:** `dev/ledgeros/`.
- **Skills:** `/ledgeros-check`, `/ledgeros-ship`, `/ledgeros-data`.

He uses LedgerOS every day for real family money, so **treat it as production software.**

## 1. Working method (agreed with Muhannad, keep following it)

1. **Verify, don't assume.** Start a LedgerOS session with `/ledgeros-check`. Before building anything, check whether it already exists: features have been built in other chats before.
2. **Investigate the real code path** before fixing anything.
3. **Ask clarifying questions before large or ambiguous changes**, especially anything touching real family financial data. Several numbered questions at once are fine; he answers by number.
4. **Every change gets real tests** in `dev/ledgeros/test_batch_fixes.js`, registered in the runner list at the bottom.
5. **Break-then-restore before shipping** (`dev/ledgeros/break_restore.py`, see `/ledgeros-ship`). Every break must turn the suite red.
6. **Every version bump gets a matching `CHANGELOG` entry.**
   - `APP_VERSION` and `CHANGELOG` are near line 350 of `LedgerOS.html`.
   - Entries are plain sentences written for Muhannad. Non-ASCII characters are written as `\uXXXX` escapes, like the existing entries.
   - Use semver: a new feature bumps the minor version.
7. **Be honest about mistakes**, including mistakes in first-draft tests. Say what was wrong and what you changed.
8. **After shipping, give a short summary:** what changed, the test count, and any mistakes. **Don't send him the built HTML.**
9. **He sends numbered checklists.** Say which items are already done rather than redoing them.

## 2. Architecture essentials (read before changing anything)

The app is a single HTML file: inline CSS and JS, no build step, no framework, about 900 KB. Data syncs to Supabase Postgres. The Supabase URL and anon key are typed into a "Connect" gate on each device and kept in that browser's `localStorage`, never in the file.

**State and sync**
- One global `D` object holds all data. It is mirrored to IndexedDB (`IDB_NAME`).
- Any **new field on `D`** must be defaulted in `normalizeDataShape(D)`. Otherwise old caches and backups break.
- Writes go through `syncWrite(table, 'upsert'|'delete', row, base)` and `syncWriteMany`, then `persistLocal()`. An upsert sends only the columns in `row`, so partial writes are safe.
- **Storage space is shared with CalendarOS** (same web address). Keep anything large in IndexedDB, not `localStorage`. `LEDGEROS_KEYS` lists LedgerOS's `localStorage` keys; add any new key there.

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

## 3. Tests

- **Run:** `bash dev/ledgeros/run_tests.sh`. It extracts the app's JS to `dev/ledgeros/.build/`, installs `jsdom` and `fake-indexeddb` on first run, prints any `FAIL` lines, then `N passed, 0 failed`.
  - The baseline at the move to Claude Code was **1701 passed** (v4.63.0); **1909 passed** at v5.0.0; **1976 passed** at v5.1.0; **2000 passed** at v5.2.0; **2020 passed** at v5.3.0; **2101 passed** at v5.4.0.
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

## 4. Real data (read-only)

- Muhannad has a **read-only** Supabase connector for LedgerOS's project. Use it only to answer questions about his data (see `/ledgeros-data`).
- **Never write, insert, update or delete** real data from a session.
- Read the actual connection code before making any security claim. A placeholder URL was once mistaken for a live one.

## 5. LedgerOS boundaries

- Never post ledger JVs on his behalf. Never make destructive schema changes.

## 6. Open items and future features (ask before starting any of them)

- **v5.0.0 ("Command Center") shipped** from `dev/ledgeros/redesign/REDESIGN_PLAN.md`. `LedgerOS-classic.html` is the frozen v4.63.0 copy: never change it; delete it only when Muhannad says so. Classic's Restore from backup would clear `dashboard_layout` and `position_boxes` (he has been warned). `dev/ledgeros/redesign/demo_walk.js` screenshots any page with invented data.

- **Security hardening (planned):** add Supabase Auth sign-in and tighten the database policies. Muhannad has the details. It needs careful planning with him because it touches every sync path and his backup script.
- **A platform-to-platform cleanup is in progress:** recording some missing buys, then using Move coins. Muhannad has the details. Afterwards, read the moved cost (read-only) so he can post the matching ledger JV himself.
- **Future features:**
  - When coins move between platforms with different invested accounts, offer the matching JV ready-made in New JV for him to post.
  - Per-person shareable investment statement.
  - Automatic live prices.
  - Platform value from positions vs a single statement number. Parked by him.
- **Deferred ("ignore for now"):** editing an old transaction adds the price to the history as today's price. The screen was never identified.

## 7. Recent version history (full detail is in the in-app CHANGELOG)

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
| 5.0 | Command Center redesign: rail + top bar, accent-driven theme, editable Dashboard boxes and position boxes (`pd_ui_prefs.dashboard_layout` / `position_boxes`), reworked Provisions, Jamiah, Allocations lookup, Forecast horizon + chart |
| 5.1 | Feedback batch (see `dev/ledgeros/FEEDBACK.md`): masonry Dashboard, Hide boxes, synced dismissals (`pd_ui_prefs.dismissals`), whole numbers on charts and Dashboard boxes, Budget arrows/collapsed grid/jump, P&L return, Provisions copy forward, Jamiah ticks in list + group month, Forecast call-outs (`pd_ui_prefs.forecast_notes`) |
| 5.2 | Position-box subtotals that add up chosen rows (`calc:'sum'`, `sum:[{rid,sign}]`), Update plan goes to the exact place, Aurora & glass rail and top bar |
| 5.3 | Drift Detection for provisions: compare per account, income/expense accounts only, exclude list (toggles, synced in `pd_ui_prefs.dismissals.driftSettings`) |
| 5.4 | SMS inbox: new table `pd_sms_inbox` filled by the iPhone logger (`dev/ledgeros/sms`, its own README and `node test_parsers.js`); New JV → 📩 SMS groups by mapped account (`dismissals.smsMap`), Create JV builds one JV per date with other halves, pairs own transfers across banks, cancels exact reversals; posting marks SMS done (`smsId` on JV/draft lines) |
