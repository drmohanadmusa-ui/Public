# LedgerOS feedback tracker

Muhannad's comments, recorded as they arrive. Nothing here is built until he says "push it all" (see `CLAUDE.md` section 7).
Status: **open** (not discussed), **question asked**, **agreed** (ready to build), **shipped** (with version).

| # | Date | Comment (his words, condensed) | Status | Notes / questions / answers |
|---|---|---|---|---|
| 1 | 2026-11-08 | Individual accounts and their balances are hard to connect visually. Maybe banded (striped) rows, or dot leaders between the account name and its balance. | agreed | Only the position box's opened line (the peek list of accounts). Banded rows (every other row lightly shaded), plus a highlight on the row under the mouse. |
| 2 | 2026-11-08 | Does he have to merge every time by hand, or can Claude merge? | agreed (process, not app) | Standing permission given: when he says ship, Claude opens a PR and merges it itself, then confirms the version is live. Recorded in `CLAUDE.md` section 4. |
| 3 | 2026-11-08 | Things that need you: a Dismiss button for over-budget items (resets each month). Also asked what else shows in this list. | agreed | Dismiss per over-budget category; comes back next month (or if it goes further over that month). Synced across devices, and drift dismissals become synced too. No Dismiss on bank items. **Schema: new jsonb column on pd_ui_prefs** (see the schema line below). |
| 4 | 2026-11-08 | Position box bars: what do the coloured lines mean, how are they calculated, why do some float in the middle? (image mentioned, not received) | agreed | Remove the bars from position boxes completely (labels, amounts, and the rules above subtotals/totals stay). No explanatory note needed. |
| 5 | 2026-11-08 | Provisions: why the "Balance it on a different line" error? Also wants to copy a fixed month forward to the end of the provision. | agreed (copy) / parked (error) | Error: parked by him for now (data is fine). Copy forward: a month that nets to zero can be copied to every later month up to the group's last planned month, overwriting amounts there. |
| 6 | 2026-11-08 | Jamiah: tagged transactions aren't visible in Transactions to Tag ("3 tagged, 0 left"); wants them shown with check marks. In the main table, show the group's month next to the group name. | agreed | Transactions to Tag shows tagged lines again, marked ✓ with the person, and lets him Untag or change the person in the list. In the summary's Group column, show the month that group receives the pot next to its number (e.g. 5 · Nov-26). |
| 7 | 2026-11-08 | Forecast: add a call-out (note) on specific months to explain a sudden drop or rise in cash position. | agreed | One note per month, shown as a callout bubble (like an Office callout) pointing at that month's bar on the Closing balance chart. Synced across devices. Not in the CSV export. **Schema: new jsonb column on pd_ui_prefs.** |

## Schema changes waiting for the next release
- Two new jsonb columns on `pd_ui_prefs`: `dismissals` (#3: drift and over-budget dismissals) and `forecast_notes` (#7). Additive only. Muhannad runs the SQL once after release; tell him clearly.

## Already shipped but not yet live
- v5.0.1 (Dashboard boxes stack into free space) is on branch `claude/youthful-brown-b8hoh3`, waiting to be merged. It goes out with the next batch.
