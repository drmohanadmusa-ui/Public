# CalendarOS feedback tracker

Feedback mode (root `CLAUDE.md` §7): comments are recorded here and clarified first. Nothing is built until Muhannad says to ship; then everything **agreed** ships as one version.

Statuses: **open** · **question asked** · **agreed** · **shipped (vX.Y.Z)** · **answered** (a question, nothing to build).

## Batch 2026-11-17: Training page

| # | Comment (his words, lightly tidied) | Type | Status |
|---|---|---|---|
| 1 | When a day's exercise uses a new weight, a banner should tell me. | change | question asked |
| 2 | What is the rationale for increasing weight? | question | answered |
| 3 | What are the parameters of the AI Review Pack, and what is given to it? | question | answered |
| 4 | Increase the rest chime volume. | change | question asked |
| 5 | What is the "Next time" screen logic? | question | answered |
| 6 | Can the logic be built into the app, so the app plans and the AI only reviews occasionally? | change (large) | question asked |
| 7 | Graphs of session average weight and total volume without warm-ups, to track progress. Brainstorm better ways. | change | question asked |

### Notes from the code (v4.73.0)

- **Weight increase rule** (`doubleProgressionSuggestion`): double progression on the last *completed* session's working sets (warm-ups and failure-test sets excluded), judged at that session's heaviest weight.
  - Every set at that weight reached the **top** of the rep range at RIR ≤ 2 → add the exercise's own increment (2.5 / 5 / 10 / 20 kg) and drop to the bottom of the range.
  - Any set below the **bottom** of the range → hold the weight.
  - Otherwise → same weight, one more rep (capped at the top).
- **Where planned weights come from today:** the AI's imported plan ("suggested starting weight: X kg" in each block's notes). The app enforces guards only: machine increment grid, never below the last completed top weight (within 28 days), rest days, and locked dates. The app's own rule runs after each saved exercise (`refreshSuggestionForExercise`) and is stored and sent to the AI as `currentSuggestions`, but it does **not** set the planned weight.
- **"Next time" screen** (phone workout summary, `mwSummaryData`): for each exercise done today, it runs the same rule on today's done working sets against the block's rep range. It shows `old → new kg` (add weight), "hold X kg", or "same X kg" (add a rep). Without a rep range it just shows the number of sets.
- **Review Pack**: the last 30 days. Data pack: review period, goals, body metrics + missing-data list, adherence, weekly volume by muscle (done + still planned), per-muscle weekly set targets, per-exercise session detail (working / warm-up sets, weights, reps, RIR), failure-test results, the app's current suggestions, the current plan, rest days and the 14-day schedule, exercise usage this week, plus the exercise library (IDs, muscles, increment, seat setting, last completed top weight). The prompt sets the coach role, rest days, per-muscle floors, priority muscles, 3 working sets by default (4 only through the exception ladder), at most 6 exercises a day, never-backward weights on the increment grid, and asks for: data sense-check, performance summary, flags, failure-test calibration, a 2-week plan JSON, suggested new exercises, per-day rationale, and a rules check.
- **Chime**: Web Audio sine tones at gain 0.12 (tick) and 0.16–0.18 (done), out of a maximum of 1.0. On iPhone, the ring/silent switch mutes web sounds, and no app can override that.
- **Existing progress charts** (Progress page): sessions per week, hard sets per week, e1RM trend per exercise, failure frequency.
