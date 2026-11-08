# LedgerOS feedback tracker

Muhannad's comments, recorded as they arrive. Nothing here is built until he says "push it all" (see `CLAUDE.md` section 7).
Status: **open** (not discussed), **question asked**, **agreed** (ready to build), **shipped** (with version).

| # | Date | Comment (his words, condensed) | Status | Notes / questions / answers |
|---|---|---|---|---|
| 1 | 2026-11-08 | Individual accounts and their balances are hard to connect visually. Maybe banded (striped) rows, or dot leaders between the account name and its balance. | agreed | Only the position box's opened line (the peek list of accounts). Banded rows (every other row lightly shaded), plus a highlight on the row under the mouse. |
| 2 | 2026-11-08 | Does he have to merge every time by hand, or can Claude merge? | agreed (process, not app) | Standing permission given: when he says ship, Claude opens a PR and merges it itself, then confirms the version is live. Recorded in `CLAUDE.md` section 4. |
| 3 | 2026-11-08 | Things that need you: a Dismiss button for over-budget items (resets each month). Also asked what else shows in this list. | agreed | Dismiss per over-budget category; comes back next month (or if it goes further over that month). Synced across devices, and drift dismissals become synced too (start fresh: existing per-device drift dismissals are not carried over). No Dismiss on bank items. **Schema: new jsonb column on pd_ui_prefs** (see the schema line below). |
| 4 | 2026-11-08 | Position box bars: what do the coloured lines mean, how are they calculated, why do some float in the middle? (image mentioned, not received) | agreed | Remove the bars from position boxes completely (labels, amounts, and the rules above subtotals/totals stay). No explanatory note needed. |
| 5 | 2026-11-08 | Provisions: why the "Balance it on a different line" error? Also wants to copy a fixed month forward to the end of the provision. | agreed (copy) / parked (error) | Error: parked by him for now (data is fine). Copy forward: a month that nets to zero can be copied to every later month up to the group's last planned month, overwriting amounts there. |
| 6 | 2026-11-08 | Jamiah: tagged transactions aren't visible in Transactions to Tag ("3 tagged, 0 left"); wants them shown with check marks. In the main table, show the group's month next to the group name. | agreed | Transactions to Tag shows tagged lines again, marked ✓ with the person, and lets him Untag or change the person in the list. In the summary's Group column, every group shows the month it receives the pot, full month name (e.g. 5 · November 2026). |
| 7 | 2026-11-08 | Forecast: add a call-out (note) on specific months to explain a sudden drop or rise in cash position. | agreed | One note per month, shown as a callout bubble (like an Office callout) pointing at that month's bar on the Closing balance chart. Click a bar to add/edit/delete its note; callouts stay visible and alternate height so neighbours don't overlap. Chart only (no marker in the table). Synced across devices. Not in the CSV export. **Schema: new jsonb column on pd_ui_prefs.** |
| 8 | 2026-11-08 | Dashboard: be able to hide the built-in boxes (Cash flow, Closing Balance Watch, etc.). | question asked | Plan: Hide in Edit layout, hidden list kept in the synced layout (no new schema). See Message #11. |
| 9 | 2026-11-08 | All charts across the app: no decimals. | question asked | Asked whether tooltips too. See Message #11. |
| 10 | 2026-11-08 | Budget page: arrows on the month selector; hide the budget grid at the bottom behind an expand/collapse toggle. | question asked | Asked default state and memory. See Message #11. |
| 11 | 2026-11-08 | Budget vs Actual by Category chart: click a category name to scroll down to that category's budget and its accounts. | question asked | Asked about the bars vs the names, and the collapsed grid. See Message #11. |
| 12 | 2026-11-08 | P&L: after opening the chart (📊) and going back, return to the same place he left. | question asked | Asked what "same place" means. See Message #11. |

## Schema changes waiting for the next release
- Two new jsonb columns on `pd_ui_prefs`: `dismissals` (#3: drift and over-budget dismissals) and `forecast_notes` (#7). Additive only. Muhannad runs the SQL once after release; tell him clearly.

## Already shipped but not yet live
- v5.0.1 (Dashboard boxes stack into free space) is on branch `claude/youthful-brown-b8hoh3`, waiting to be merged. It goes out with the next batch.
