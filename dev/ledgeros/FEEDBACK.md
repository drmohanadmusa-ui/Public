# LedgerOS feedback tracker

Muhannad's comments, recorded as they arrive. Nothing here is built until he says "push it all" (see `CLAUDE.md` section 7).
Status: **open** (not discussed), **question asked**, **agreed** (ready to build), **shipped** (with version).

| # | Date | Comment (his words, condensed) | Status | Notes / questions / answers |
|---|---|---|---|---|
| 1 | 2026-11-08 | Individual accounts and their balances are hard to connect visually. Maybe banded (striped) rows, or dot leaders between the account name and its balance. | agreed | Only the position box's opened line (the peek list of accounts). Banded rows (every other row lightly shaded), plus a highlight on the row under the mouse. |
| 2 | 2026-11-08 | Does he have to merge every time by hand, or can Claude merge? | agreed (process, not app) | Standing permission given: when he says ship, Claude opens a PR and merges it itself, then confirms the version is live. Recorded in `CLAUDE.md` section 4. |
| 3 | 2026-11-08 | Things that need you: a Dismiss button for over-budget items (resets each month). Also asked what else shows in this list. | question asked | Explained the list. Asked: dismiss per category per month; synced or this device only. See Message #9. |
| 4 | 2026-11-08 | Position box bars: what do the coloured lines mean, how are they calculated, why do some float in the middle? (image mentioned, not received) | question asked | Explained the running-total bars. Asked: keep, or switch to simple bars from zero. See Message #9. |
| 5 | 2026-11-08 | Provisions: why the "Balance it on a different line" error? Also wants to copy a fixed month forward to the end of the provision. | question asked | Read-only check: every line has its own ID, so the error only fires when Line and Balance it on are the same line. Proposed hiding the chosen line from the Balance list. Asked copy-forward details. See Message #9. |
| 6 | 2026-11-08 | Jamiah: tagged transactions aren't visible in Transactions to Tag ("3 tagged, 0 left"); wants them shown with check marks. In the main table, show the group's month next to the group name. | question asked | Asked how tagged lines should show, and the month label format. See Message #9. |
| 7 | 2026-11-08 | Forecast: add a call-out (note) on specific months to explain a sudden drop or rise in cash position. | question asked | Synced notes need a schema change (one new column). Asked where they show and synced vs device. See Message #9. |

## Already shipped but not yet live
- v5.0.1 (Dashboard boxes stack into free space) is on branch `claude/youthful-brown-b8hoh3`, waiting to be merged. It goes out with the next batch.
