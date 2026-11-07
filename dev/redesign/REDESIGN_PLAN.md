# LedgerOS v5.0.0: the new look (build plan)

Agreed with Muhannad on 2026-11-07, in the design session. This file is the hand-over to the build session.
Read `CLAUDE.md` first; everything there still applies. **No real figures, names or Supabase details in this repo.**

## Where the design lives

- **Interactive mockup (the visual reference):** https://claude.ai/artifact/8PFw8Xp17potKigegv2LT2
  (private to Muhannad; read it with the Artifact tool, `action: "read"`).
- **Mockup sources:** `dev/redesign/mockup/*.dc.html`. `Command.dc.html` is the app shell and Dashboard;
  `PosBox.dc.html` is the custom position box; `Pg*.dc.html` are the other pages. All data in them is invented.
  They are design references, not code to paste: the real app is plain inline JS, no framework.
- **Design context:** `PRODUCT.md` (product truth) and `.impeccable/surfaces/ledgeros-html.md` (Impeccable notes).
  The Impeccable, design-taste-frontend and hallmark skills are installed by the environment's setup script.

## Ground rules

1. **Calculation code stays untouched.** Balances, `computeMonthlyCashFlow`, `computeForecastCell`, the P&L,
   accruals (`computeAccrualJV`), the investments engine (`invTxAttribution`, `invCashState`, `computePositionState`),
   reconciliation maths, sync (`syncWrite`/`syncWriteMany`/`persistLocal`). Only screens, layout and CSS change,
   plus the behaviour changes listed under step 4.
2. One release: **v5.0.0**, with a CHANGELOG entry written for Muhannad (non-ASCII as `\uXXXX`).
3. **Schema additive only.** Planned: two `jsonb` columns on `pd_ui_prefs`: `dashboard_layout` and
   `position_boxes` (synced across devices). Add them to `DB_SCHEMA_CORE`; default them in
   `normalizeDataShape`; grep every list that enumerates `pd_ui_prefs` columns. No new tables, so the
   backup script needs no change. Tell Muhannad to run the SQL from Settings > Database Schema.
4. Every change gets tests in `dev/test_batch_fixes.js` (registered in the runner), and break-then-restore
   (`dev/break_restore.py`) before shipping. Baseline: 1701 passed at v4.63.0.

## Decisions (all confirmed by Muhannad)

- **Direction:** "Command Center". Slim icon rail on the left; top bar with search (plain "Ctrl+K" text at the
  right end of the field, no box), sync status, **Light/Dark toggle**, "+ New JV". Font **Geist** (default)
  with Geist Mono for figures; keep the existing font options too. Rounded panels, coloured accents, motion.
- **Colour:** the accent drives the whole UI (rail, tinted ground, highlights, chart bars). Keep the existing
  `ACCENT_PALETTES` (indigo, amber, blue, green, purple, rust, teal) plus Custom. New per-device settings:
  Background (Plain / Tinted / Aurora) and Motion (On / Off; reduced-motion always wins).
  All of these live in **Settings > Appearance**, not the top bar. Only Light/Dark is in the top bar.
- **Classic safety net:** keep v4.63.0 frozen as **`LedgerOS-classic.html`**. The new app stays at
  `LedgerOS.html` (same link as today). Each has a small "Switch to classic / Switch to the new look" link.
  Same origin, so the same Supabase connection and storage. Classic gets no further changes; delete it when
  Muhannad says so. Check: classic must not strip unknown fields when it writes the shared IndexedDB cache in a
  way that loses data (the cloud is the source of truth, but verify and note it).
- **Desktop first** (he works on a laptop/desktop; the phone is for glancing). Keep the mobile menu working.
- Anything Muhannad did not comment on in the mockup: keep it as mocked up.

## Steps

### 0. Classic copy
Copy `LedgerOS.html` (v4.63.0) to `LedgerOS-classic.html`; add only the switch link. Tests still run on `LedgerOS.html`.

### 1. Look and shell
CSS tokens derived from the accent (see `theme()` in `dev/redesign/mockup/Command.dc.html` for the colour maths),
rail + top bar, Geist, Background/Motion prefs, Settings > Appearance (accent swatches + custom, background,
motion, font size, font family, positive/negative colours, content width). Dark mode keeps working.

### 2. Dashboard
- **Edit layout:** drag-and-drop to reorder boxes; drag a box's right edge to resize (12-column grid);
  "+ New box"; "Reset layout". Saved in `pd_ui_prefs.dashboard_layout`.
- **"N things need you"** list: unreconciled accounts, accounts with no statement, stale reconciliations
  (balance freshness setting), over-budget categories, drift alerts. Built from the existing checks.
- **Bank accounts table:** same columns and logic as today (Acc#, Account, Ledger balance, Statement balance
  input, Variance / "Reconciled - date", red when stale, credit cards by available limit, totals row).
- Month figures (bank balance, income, expense, net), cash flow last 6 months, budget this month.
- **Custom position boxes** (`pd_ui_prefs.position_boxes`). Rows: `line` (sum of listed account numbers; shows
  only its total; click to peek at the accounts), `account` (one account shown on its own), `subtotal`
  (running total so far), `total` (closes the box). Each line has a +/- sign. Balances **as of today**.
  Shown on the **Dashboard** only. Three presets rebuilt from `netWorthPanels()`: Short Term Equity, Cash Bank
  Account, Long Term Equity. **Test: each preset's totals equal the old panel's totals.** Style: running-total
  bars, thick rule above subtotals/totals (Muhannad liked this).
- Keep the Closing Balance Watch and forecast snapshot banner (as boxes).

### 3. Restyled pages (same function, new look)
- **New JV:** the JV gets full width. **Reconcile panel on top** when reconciling (statement, ledger incl. draft,
  still to clear, **last 3 posted JVs on that account**; this exists today as `reconcileBannerHTML` /
  `reconcileRecentJvsHTML`). Budget impact and Draft JVs **below** the JV.
- **Ledger:** filters (quick range, from/to, search), JV-grouped rows; clicking a JV shows its actions
  (Edit, Duplicate as New JV, Reverse, Download CSV). The selected JV gets an **accent frame**, not a fill.
- **Accounts:** List view with category filters; **Grid view = accounts down, months across, each cell the
  month's movement** (as `renderAccountsGrid` today), with month arrows and exports. Side panel: account balance,
  **5 most recent JVs**, and a **"Full history in Ledger"** button (`jumpToLedgerForAccount`).
- **Budget:** month switcher; **amounts next to every bar** (budget and actual) and on the trend bars;
  Plan vs Actual grid with editable plan cells.
- **P&L, Real Estate, Settings:** restyle only.
- **Investments:** the existing views (Mine/Family/Activity/Reconcile/Insights/Setup/Classic). **Activity:
  filters by platform, owner and ledger account, plus a date range, and Export CSV including per-owner
  SAR/USD/rate columns.**

### 4. Reworked behaviour (careful; test thoroughly)
- **Provisions** (critical; same `pd_provisions` data shape: `lines[{acc,lineId,descrBase}]`,
  `months{YYYY-MM:{lineId:amt}}`, each month must net to zero, `dupBalanceExempt`):
  - Month picker at top + "Generate JV, all groups" (existing `combinedGenerateProvisionJV`), disabled with
    a clear reason while there are errors. Total provision expense for the month.
  - **Search** groups/accounts.
  - Group rows show: **name, JV description for the month, amount hitting the expense account(s)**, OK/Error.
  - **"Needs fixing" bar** listing every unbalanced group/month with the amount, and **"Show me"** that opens
    the group and highlights the row.
  - Inside a group: **months run downward, accounts across** (replaces the horizontal grid), per-month net
    check, current month highlighted; line cards with balance now / still planned / projected; add account,
    add month, rename, generate for this group only.
  - **Bulk fill** inline: line, from month, number of months, amount, and optionally **balance it on** a second
    line (writes the opposite amount). Must work with duplicate-account lines.
  - Muhannad edits provisions while generating (raise/lower an amount, add/remove a line): keep that fast.
- **Jamiah:** a tick **only exists if a transaction is tagged** (uses the existing `tags`). Clicking an empty
  cell lists untagged transactions **matching the pledge**; if none match, list the remaining untagged amounts.
  Tagged transactions disappear from every list. Clicking a tick shows its transaction with **Untag**.
  Add a **Pledge** column after Group (participants already store `pledgeAmount`) and a **Jamiah settings**
  panel (name, account, start month, duration, participants with group and pledge, receiving group per round).
  Rounds stay labelled by month. **Before shipping:** check the real data for ticks/paid states that have no tag
  and report them to Muhannad (read-only).
- **Allocations:** unallocated lines **grouped in one box per account**; tick lines in a box to Assign,
  Arabic statement, Create JV to balance, Add to existing. **"Look up an allocation"** panel: pick a number,
  preview its lines and net, with its own **Arabic statement** button. No Arabic statement on the old
  "existing allocations" list.
- **Forecast** (critical): keep the real structure: Projected Cash Position table (month starting balance,
  inflow categories, total inflows, outflow categories, total outflows, monthly cash change, closing balance),
  "Anchor current month to real balance", category sections with current balance and monthly cells, all
  exports, Forecast Settings. Add horizon **6 / 12 / 18 / End of reporting period** (Settings > Grid & Export
  End Month). Chart of closing balance **with the amount on every bar** and the lowest point. **Sign flips:**
  Muhannad has reversed all categories on purpose; the new display must honour the same sign settings exactly.

### 5. Verification
1. `bash dev/run_tests.sh`: all green, with new tests for every item above.
2. **Old vs new on real data (read-only).** In a cloud session, the Supabase anon key for the project is saved
   on the environment (header `apikey`, injected by the proxy). Get the project URL with the read-only Supabase
   connector (`get_project_url`); never write it into the repo. Then run
   `SB_URL=<url> node dev/redesign/realdata_walk.js <html> <scratchpad dir>` for `LedgerOS-classic.html` and for
   the new `LedgerOS.html`. It blocks every non-read request. Compare: (a) values from the calculation functions
   evaluated in both pages (`computeMonthlyCashFlow` over the horizon, account balances, P&L totals,
   provisions sums, `invCashState`, position-box presets vs `netWorthPanels`); (b) the visible numbers per page.
   Every difference must be explained or fixed. Report the result to Muhannad in chat only.
3. Screenshots at 1440 and 390 width; Impeccable review; dark mode; reduced motion.
4. Break-then-restore for every new behaviour.

### 6. Ship
APP_VERSION 5.0.0 + CHANGELOG; privacy check (no real data in the diff); push the session branch; ask Muhannad
to Create PR > Merge; confirm `origin/main` shows 5.0.0 and that `LedgerOS-classic.html` loads.
Remind him to run the new schema SQL.
