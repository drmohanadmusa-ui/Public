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
   - `APP_VERSION` and `CHANGELOG` are near line 580 of `LedgerOS.html` (grep `const APP_VERSION`).
   - Entries are plain sentences written for Muhannad. Non-ASCII characters are written as `\uXXXX` escapes, like the existing entries.
   - Use semver: a new feature bumps the minor version.
7. **Be honest about mistakes**, including mistakes in first-draft tests. Say what was wrong and what you changed.
8. **After shipping, give a short summary:** what changed, the test count, and any mistakes. **Don't send him the built HTML.**
9. **He sends numbered checklists.** Say which items are already done rather than redoing them.
10. **Question first, ship only when asked** (his standing practice, restated 2026-11-12). This covers your own extras too: a bug you find or a fix you'd like to add goes in the tracker as a question, not into the build, until he says yes. Restated 2026-11-12 (#41): log every change or request in the tracker, ask only questions that clarify what he asked for, then log the answer and wait for more or for "ship".

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
- **Budget & P&L (v5.7, #30):** one rail button (SCREENS id `pnl`, label "Budget & P&L"); tabs from `budgetPnlTabsHTML`: Overview = screen `pnl` (`renderPnL`, period picker drives everything incl. `renderBudgetCharts` via `budgetChartData(pnlFrom, pnlTo)`), Plan grid = screen `budget` (`renderBudget`, grid open on arrival, Export/Import only). `navIsOn` lights the rail for both; `getHiddenPages` hides the page only if both old ids were hidden. The old Budget month table, its month box and `viewBudgetAccountMonth` were removed.
- **Over budget covered by accrual (v5.7, #31):** `overspendCover(cat, over, asOf)` (reserve = `accruedForCategory`); full → yellow bar + black note, not in the Dashboard to-do, highlighted P&L category row; partial → red + "N of it covered".
- **Historical averages (v5.7, #29):** `historicalStatDefs` / `historicalStatsFor` (per month: rolling 30/60/90/180/365 days ending today, clamped to an account's first date; this year so far by days; every earlier year ÷ 12); `historicalStatsTableHTML` on the P&L 📊 chart (account or sub category) and Accounts → 📊; Forecast → Settings toggles via `setForecastStatSetting` (it was missing before v5.7).
- **Dates:** `shiftDate` works in UTC since v5.7 (it used to land a day early east of UTC).
- **Views:** Mine / Family / Activity / Reconcile / Insights / Setup (`INV_VIEWS`, `invView`). The Classic tab was dropped in v5.6; `renderInvClassicPage` is still the dispatch fallback and old tests use it.
- **Pooled family contributions:** Collect Contributions plus "Split by platform cash".
  - **The app never posts ledger JVs for this.** Muhannad posts them by hand.

**Investments v5.6 (#22): boxes, Needs you, prices, wallets**
- **Mine = platform boxes** (`invBoxesHTML`, `invBoxHTML`): click opens the platform page (`invPlatformPageId`, `renderInvPlatformPage` reuses `invHoldingCardHTML(h,'mine',true)`). Box buttons show on hover only (CSS `.inv-box-actions`; always on touch). Arrange: order / hidden / grouped ("Other wallets") in `dismissals.invBoxes`.
- **Needs you** (`invNeedsYouItems`): uncollected contributions, ledger lines on a platform's `outAcc` with no tracker deposit (±5 days, ±2%, since `reconStartDate` or 90 days; `openInvDepositFromLedger`), platform cash, stale prices, robo value > 30 days, recon issues; "checks due" (units not checked 30 days) are minor and not counted. Rail badge `invNavBadgeHTML()` in `renderNav`.
- **Prices:** synced config `dismissals.invPrices = {keys:{cg,finnhub}, links:{posId:{kind:'dex'|'cg'|'stock', chain, address, id}}, wallets:{platformId:[{chain,address}]}, rpc}` (no schema change; anyone with the anon key can read the free API keys). Sources: DexScreener (+ GeckoTerminal backup), CoinGecko Demo, Finnhub. `refreshInvPrices` writes one row per position per day (`invTodayLiveRow`); auto-refresh on opening Investments after 6 h (`invPricesFetchedAt`, per device).
- **Daily closes:** id = `1e12 + positionId×1e5 + day number` (`invCloseValId`); `invNextId` ignores that range; same date → close wins (`invValCmp`, used by `invLatestValuation` and `invPriceAsOf`). Written by `backfillInvCloses` (CoinGecko `market_chart` 00:00 UTC point = previous day's close; GeckoTerminal top pool daily OHLCV with `token=`; stocks not backfilled) and by the Edge Function `dev/ledgeros/edge/inv-daily-close` (Muhannad deploys it by hand; README there; tests are the `edge:` tests in the main suite).
- **Wallet check** (Reconcile, `invWalletPanelHTML`): Solana `getTokenAccountsByOwner` (both token programs), EVM `balanceOf` + `decimals` batch; Save writes `stmt_units`/`stmt_date`. Exchange units stay manual.
- **Logging shortcuts:** `window._invTxPreset` → `invApplyTxPreset` in `openInvTxModal` (new drafts only, used once): Repeat last buy (`invLastBuy`, ignores opening/transfer) and Invest it now after Collect (`invOfferInvestNow`).
- Network calls can't be tested from the session (allowlist), and CORS from github.io was **not verified** before v5.6 shipped: a refused source shows its error on the prices bar.

**Accruals (v4.61, v5.5)**
- `pd_accrual_mappings.cap_months` sets the cap: cap months × that month's budget (budget = Forecast Plan via `computeForecastCell(a, mk, mk)`).
- `computeAccrualJV` runs in two passes:
  - **Pass 1, own entry per category:** under budget, accrue up to the cap; over budget, draw down its own reserve. Reserves are read at the **end of the month being accrued**, never today.
  - **Pass 2, overflow (v5.5):** surplus above a cap is pooled and split among categories with room left after their own entry, in proportion to that room, never past a cap (`accrualSplitCents`, in cents). Uncapped categories neither give nor receive. Leftover goes to the catch-all reserve (`getAccrualOverflowAcc`, synced in `dismissals.accrualOverflowAcc`; it can't be a category's own reserve), otherwise it isn't accrued.
  - Overspends are never offset by overflow: the drawdown is booked in full, then that reserve may be topped up by its share like any other.
- `accrualExplanation` rows carry cap, accrued, own, overflowOut, overflowIn; `accrualOverflowSummary` feeds the pool line. Tests: `capSandbox` (v4.61) and `ovfSandbox` (v5.5).

**SMS inbox (v5.4)**
- iPhone side: Shortcuts Message automations → Scriptable `dev/ledgeros/sms/ledger_sms_logger.js` (7 banks) → upload to `pd_sms_inbox` (dedupe by hashed id; failed uploads queue in iCloud). Its `README.md` is the explainer; parser tests: `node dev/ledgeros/sms/test_parsers.js` (122 passed). Every run writes a line to `Ledger Run Log.txt` on the phone (tells "automation never started" from "script skipped/failed"); run by hand in Scriptable with an SMS copied = test mode (shows the parsed row, Test only / Log it); iCloud file errors are non-fatal so the row still uploads. Locked phone (#24, fix A): keys (`ledger_sms_keys.json`, copied from the Keychain), upload queue and run log are in `FileManager.local()`; failures say `Failed at <stage>`. If a locked test still fails, fix B is agreed in principle: the Shortcut posts the raw SMS with Get Contents of URL and LedgerOS parses it.
- App side (v5.7: 🔗 Numbers & accounts lists every mapping, `smsChangeMapping`; JV lines = own account block, then other halves, then fees): New JV → 📩 SMS. Groups by mapped account (`dismissals.smsMap`), one JV per SMS date, own-bank transfers paired within SAR 1 (difference = fee line), exact reversals cancel. Posting marks the SMS done (`smsId` on lines).

## 3. Tests

- **Run:** `bash dev/ledgeros/run_tests.sh`. It extracts the app's JS to `dev/ledgeros/.build/`, installs `jsdom` and `fake-indexeddb` on first run, prints any `FAIL` lines, then `N passed, 0 failed`.
  - The baseline at the move to Claude Code was **1701 passed** (v4.63.0); **1909 passed** at v5.0.0; **1976 passed** at v5.1.0; **2000 passed** at v5.2.0; **2020 passed** at v5.3.0; **2101 passed** at v5.4.0; **2110 passed** at v5.4.1; **2150 passed** at v5.5.0; **2244 passed** at v5.6.0; **2288 passed** at v5.7.0; **2297 passed** at v5.8.0; **2332 passed** at v5.9.0; **2366 passed** at v5.10.0.
  - Console noise about `QuotaExceededError` or "Not implemented: scrollTo" is expected.
- **Harness basics:**
  - `makeSandbox()` gives a fresh app context in a vm.
  - Fixture sandboxes: `invCashSandbox`, `poolSandbox`, `v455Sandbox`, `fxSandbox`, `viewSandbox`, `moveSandbox`, `costSandbox`, `capSandbox`, `allocSandbox`, `jamSummarySandbox`, `v56Sandbox` (v5.6: fake `fetch` routes, captured writes, no rate-limit waits).
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

**Where the last session stopped (2026-11-12, v5.10.0 live (merged by Claude), 2366 tests; SMS parser tests 122; SMS script `SCRIPT_VERSION` 2026-11-12 sent to him):**
- The tracker (`dev/ledgeros/FEEDBACK.md`) is the source of truth: #1–#55, everything shipped or closed except the items below.
- **Still open:**
  - **#24 SMS on a locked phone:** fix A (keys, queue and run log in Scriptable's on-phone storage) is installed. A check-in was scheduled for 2026-11-13 09:30 Riyadh in the previous session; if he raises it here instead, check read-only whether overnight (locked) SMS reached `pd_sms_inbox` and ask him for his run log (Scriptable → script menu → Copy run log; every line ends with the script version). If any were missed, propose fix B (the Shortcut posts the raw SMS with Get Contents of URL; LedgerOS parses it). He prefers the robust option.
  - **#38 investment price setup (his side):** Finnhub key, link the rest of the positions, DEX wallet addresses, Backfill, deploy and schedule the daily-close Edge Function. Keep open until he confirms. His work PC blocks the price sites; another PC works.
  - **#5 (error half) parked** since v5.1.
- **Process notes:**
  - `gh pr create` fails (GraphQL blocked). Use REST: `gh api repos/drmohanadmusa-ui/Public/pulls -f title=... -f head=<branch> -f base=main -F body=@file`, then `gh api -X PUT repos/drmohanadmusa-ui/Public/pulls/<n>/merge -f merge_method=squash`.
  - **Squash-merge**, so anything removed from a branch before merging never reaches main.
  - `break_restore.py` takes several minutes: run it in the foreground with a long timeout (up to 600000 ms), not in the background.
  - 2026-11-12: `add_repo` with push access and running `run_tests.sh` were first refused by the session's safety check and allowed once Muhannad said so in chat; merging was refused earlier that day, but `gh api -X PUT .../pulls/<n>/merge` worked for PR #20 (v5.9.0). **Default from 2026-11-12 (his instruction): when he says ship, Claude opens the PR and merges it itself**, then checks the version on main; only if the merge is refused, give him the PR link.
  - **Branch clean-up (his standing request, 2026-11-12):** after each merge, try to delete the merged branch. From the session this is refused three ways (API delete ref 403, `git push --delete` disconnect, repo setting `delete_branch_on_merge` 403), so the fix is on his side: GitHub → repo Settings → General → Pull Requests → tick **Automatically delete head branches** (once; then every merged PR branch goes by itself). **He switched it on 2026-11-12** (confirmed via the API: `delete_branch_on_merge` true), so merged PR branches now delete themselves; nothing to list. Older branches from before that were deleted by hand.
  - Never force-push (a squash + `--force-with-lease` was attempted on 2026-11-12 and rejected); push a fresh branch instead.
  - When the SMS script changes, send him the finished `Ledger SMS Logger.js` file in chat (his standing preference).

- **v5.0.0 ("Command Center") shipped** from `dev/ledgeros/redesign/REDESIGN_PLAN.md`. `LedgerOS-classic.html` is the frozen v4.63.0 copy: never change it; delete it only when Muhannad says so. Classic's Restore from backup would clear `dashboard_layout` and `position_boxes` (he has been warned). `dev/ledgeros/redesign/demo_walk.js` screenshots any page with invented data.

- **Security hardening (planned):** add Supabase Auth sign-in and tighten the database policies. Muhannad has the details. It needs careful planning with him because it touches every sync path and his backup script.
- **A platform-to-platform cleanup is in progress:** recording some missing buys, then using Move coins. Muhannad has the details. Afterwards, read the moved cost (read-only) so he can post the matching ledger JV himself.
- **Future features:**
  - When coins move between platforms with different invested accounts, offer the matching JV ready-made in New JV for him to post.
  - Per-person shareable investment statement.
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
| 5.4.1 | Aurora & glass rail: the button list scrolls inside the floating rail on short windows (it was clipped by `overflow:hidden`); compact buttons up to 820px tall; Dashboard over-budget Open P&L lands on and flashes that category (`goPnLThisMonth(cat)`, `data-pnl-cat`) |
| 5.10 | #49–#55: Activity per person in every column + CSV (`invActivityForOwner`); deposit edit keeps each person's rate, SAR follows USD (`setInvCashOwnerUsd`, `_rates`); Solana RPC default publicnode + own address box (`rpc.solana`); robo value date fixed (`invRoboPlatformStats.valueDate`); Family Holdings pop-out (`openInvFamilyHoldings`, `allCols`); statement ⬇ PDF / ⬇ CSV (`printInvOwnerStatement`, `body.print-modal`); top-bar sync icon (`setStatus` → `syncIconState`, drive = local only) |
| 5.9 | #42–#48: price links green when picked (`invLinkPicked`), Find on a saved address = exact token (`invLookupAddress`), CoinGecko hits with chain/price (`invCgCoinDetail`), Address looks up + confirms; SMS Create JV asks the bank balance (`openSmsStmtPrompt`, Skip) then reconcile mode; statement boxes take +/− (`parseAmountSum`); budget bars animate on arrival only; position box account → transactions window (`openPosAccTx`, unallocated only for allocatable accounts); Investments rail badge top-right |
| 5.8 | Robo ✎ Update value opens a value window (`openInvRoboValueModal`, #32); SMS script `SCRIPT_VERSION` 2026-11-12: run log names empty automation runs, by-hand first line, version on every line, Copy run log; empty automation runs no longer read the clipboard (#28); cap tests use invented figures (#37) |
| 5.7 | Budget & P&L merged into one page with two tabs (#30); over-budget covered by accrual (#31); per-month historical averages incl. rolling day windows and every year (#29); SMS Numbers & accounts (#26) and line order (#27); Price links Find keeps its place and explains failures; `shiftDate` UTC fix; `setForecastStatSetting` added |
| 5.6 | Investments (#22): platform boxes (hover actions, arrange/hide/group), Needs you + rail badge, automatic prices (price links, synced keys, refresh, auto after 6 h), daily closes (backfill + Edge Function), wallet unit check, Repeat last buy, Invest it now; Classic tab dropped. Ships with the SMS fix (#25) |
| 5.5 | Accrual cap overflow (#21): pass 2 in `computeAccrualJV` pools surplus above caps and splits it by room left (`accrualSplitCents`, in cents, never past a cap); catch-all reserve `getAccrualOverflowAcc`/`setAccrualOverflowAcc` in `dismissals.accrualOverflowAcc`; drawdowns use the month-end reserve; wider explanation table + `accrualOverflowSummary` |
