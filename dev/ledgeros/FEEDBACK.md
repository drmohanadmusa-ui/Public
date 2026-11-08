# LedgerOS feedback tracker

Muhannad's comments, recorded as they arrive. Nothing here is built until he says "push it all" (see `CLAUDE.md` section 7).
Status: **open** (not discussed), **question asked**, **agreed** (ready to build), **shipped** (with version).

| # | Date | Comment (his words, condensed) | Status | Notes / questions / answers |
|---|---|---|---|---|
| 1 | 2026-11-08 | Individual accounts and their balances are hard to connect visually. Maybe banded (striped) rows, or dot leaders between the account name and its balance. | agreed | Only the position box's opened line (the peek list of accounts). Banded rows (every other row lightly shaded), plus a highlight on the row under the mouse. |
| 2 | 2026-11-08 | Does he have to merge every time by hand, or can Claude merge? | agreed (process, not app) | Standing permission given: when he says ship, Claude opens a PR and merges it itself, then confirms the version is live. Recorded in `CLAUDE.md` section 4. |

## Already shipped but not yet live
- v5.0.1 (Dashboard boxes stack into free space) is on branch `claude/youthful-brown-b8hoh3`, waiting to be merged. It goes out with the next batch.
