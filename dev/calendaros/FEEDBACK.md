# CalendarOS feedback tracker

Feedback mode (root `CLAUDE.md` §7): comments are recorded here and clarified first. Nothing is built until Muhannad says to ship; then everything **agreed** ships as one version.

Statuses: **open** · **question asked** · **agreed** · **shipped (vX.Y.Z)** · **answered** (a question, nothing to build).

## Batch 2026-11-17: Training page

| # | Comment (his words, lightly tidied) | Type | Status |
|---|---|---|---|
| 1 | When a day's exercise uses a new weight, a banner should tell me. | change | shipped (v4.74.0): shows when the planned weight differs from last time (↑ heavier / ↓ lighter), numbers only, no reason; phone workout only. |
| 2 | What is the rationale for increasing weight? | question | answered |
| 3 | What are the parameters of the AI Review Pack, and what is given to it? | question | answered |
| 4 | Increase the rest chime volume. | change | shipped (v4.74.0): about 3× louder, no slider |
| 5 | What is the "Next time" screen logic? | question | answered |
| 6 | Can the logic be built into the app, so the app plans and the AI only reviews occasionally? | change (large) | parked as a future feature. When it differs, the AI's weight wins but the difference is shown. |
| 7 | Graphs of session average weight and total volume without warm-ups, to track progress. Brainstorm better ways. | change | shipped (v4.74.0): per-exercise double graph (top working weight line + working-set volume bars, warm-ups excluded) + an overall strength index (average e1RM change vs 4 weeks ago); in a new tab on the Training page |
| 8 | How does the AI's weight-increase logic compare with the app's? | question | answered |
| 9 | Leg press moves in 10 kg steps; at 70 kg I finish each set with 2+ RIR. Shouldn't big-step machines have a different rule (bigger increase, different parameters)? | change | shipped (v4.74.0): (see 9a-9c) |
| 9a | Fix the gap: "too easy" sets (top of range reached with RIR 3+) must count toward a weight increase. Keep the rest of the current rule. | change | shipped (v4.74.0): every set at the top of the range counts, whatever the RIR |
| 9b | Big-step check, every machine: before adding weight, estimate reps at the new weight (Epley, keeping 2 in reserve). If that lands under the bottom of the range, keep the weight and raise the rep target (at most 3 above the top) until the jump fits. Same rule in the app (Next time screen, suggestions) and in the Review Pack prompt. | change | shipped (v4.74.0):  |
| 9c | On AI plan import, show where the AI's weight differs from what the app's rule would pick. The AI's weight is kept. | change | shipped (v4.74.0):  |

## Batch 2026-11-17 (2): Training -> Progress charts (v4.74.0)

| # | Comment (his words, lightly tidied) | Type | Status |
|---|---|---|---|
| 10 | The graphs look way too big on the page. | change | shipped (v4.74.1) |
| 11 | The graphs need to be interactive: hovering over a bar or a point shows its figures and label. | change | shipped (v4.74.1) |
| 12 | The weight axis shouldn't run from the lowest to the highest weight; it should start at 0 and end 50% above the max weight. | change | shipped (v4.74.1) |

## Batch 2026-11-21: exercise notes, increments, and an AI coach's review (to build in a new session)

Source: his own comments (13-14) plus feedback he received from an AI review of his data and the app (15-32, his numbering in brackets). Logged for a later build session; nothing built here.

| # | Comment (lightly tidied) | Type | Status |
|---|---|---|---|
| 13 | Exercise note: a button next to "+ Add set" / "- Remove last" on the phone workout opens a window to type a note. | change | shipped (v4.75.0) |
| 14 | Leg press was listed with a 2.5 kg step; he corrected it to 10 kg in the app. Update whatever else needs it, and the AI's planning instructions. | fix | app part: nothing to build (the pack already sends the 10 kg step); Doc 2 text: waiting for his paste |
| 15 | [P1 #1] Reason for every missed session (work / sleep / energy / travel / other, one tap); a "short on time" option keeping only the first 3-4 blocks; reasons in the data pack. | change | shipped (v4.75.0) |
| 16 | [P1 #2] Check entries when typed: protein x4 + fat x9 (+ carbs x4) above the day's calories -> warn/block; add carbs; "day complete" checkbox; sleep as a time picker stored in minutes; weight as a number; a set with more reps than an earlier RIR-0 set asks "rested longer?" and saves the answer as a note. | change | shipped (v4.75.0) |
| 17 | [P1 #3] Rest: defaults about 3 min for compounds and 2 min for isolation (editable per exercise); log actual rest automatically (done -> next set started) and send it in the pack; a deliberate pairing flag (e.g. curl + extension). | change | shipped (v4.75.0): actual rest recorded (pairing dropped, default rest stays 60 s) |
| 18 | [P1 #4] Increments: show each machine's step on the exercise screen; allow an add-on weight where the machine has one; never suggest a weight off the grid. | change | dropped (Q6, Q23) |
| 19 | [P1 #5] Weekly check-in on Friday morning: waist, photos monthly; app calculates 7-day average weight, weekly rate of loss, projected date to reach the goal weight. | change | dropped or done by him (see decisions) |
| 20 | [P1 #6] Adaptive calorie targets: estimate real maintenance from intake vs weight trend over 2-3 weeks; daily target for a chosen rate of loss (suggested 0.5-0.75 kg/week); daily progress bars for calories, protein, fat, fiber; a fat cap; a steps target (e.g. 8,000). | change (large) | dropped or done by him (see decisions) |
| 21 | [P1 #7] RIR accuracy score per exercise from failure tests (e.g. "you underestimate by about 8 reps"). | change | dropped or done by him (see decisions) |
| 22 | [P1 #8] Fairer volume: per-exercise partial credit per muscle (e.g. leg press quads 1, glutes 0.5, hamstrings 0.25); secondary credit on at half a set. | change | dropped or done by him (see decisions) |
| 23 | [P1 #9] Data pack: remove ~80 old session templates from currentPlan; add per-muscle volume for each of the last 4 weeks, weekly average weight and waist, weekly average calories and protein, skip reasons, rest times, session length, planned vs done per block of the previous plan; failure sets carry RIR 0, not null. | change | shipped (v4.75.0) |
| 24 | [P1 #10] One progression rule in both the app and his documents. | change | shipped (v4.75.0) |
| 25 | [P2 #1] Remove conflicts between his documents and the prompt (one 10-20 band, 60 s rest, simple progression, failure tests isolation-only), or state that the prompt wins. | change | shipped (v4.75.0) |
| 26 | [P2 #2] Only include rules that apply: the priority section only when priorities are set. | change | shipped (v4.75.0) |
| 27 | [P2 #3] Muscles with a single primary exercise may repeat it up to 3x/week; the variety rule doesn't apply to them. | change | shipped (v4.75.0) |
| 28 | [P2 #4] Extra day vs 4th set: prefer an extra day or a different exercise, but a 4th set is allowed when it is the lower-fatigue option, justified in the rules check (relaxes the v4.70 strict ladder). | change | shipped (v4.75.0) |
| 29 | [P2 #5] Fallback plan: if only 3 of the 5 days happen, which 3 sessions and what to merge so every muscle still gets >= 70% of its MIN. | change | dropped or done by him (see decisions) |
| 30 | [P2 #6] Nutrition targets in the prompt; an output section with next fortnight's targets, one nutrition change, and 3 measurable goals for the next review (a scorecard). | change | dropped or done by him (see decisions) |
| 31 | [P2 #7] Week 2 weights = week 1 as a floor; the app's live progression applies earned bumps. | change | dropped or done by him (see decisions) |
| 32 | [P2 #8] Review on a fixed rhythm: every 2 weeks, same weekday. | change | dropped or done by him (see decisions) |

### Facts checked in the code (v4.74.1, 2026-11-21)

- Per-day, per-exercise notes already exist on the computer's log card (`training_logs.notes`, synced). The phone workout has no way to edit them yet. **Correction (review 2026-11-21): the Review Pack does NOT send these notes** (`buildTrainingReviewPack` only uses `training_logs` to count logged days), so item 13 must also add them to the session detail.
- The Review Pack sends each exercise's own `weightIncrementKg` from the library (fallback 2.5 only when unset), so his 10 kg correction flows into the next pack automatically. His own plan documents ("Doc 1/2") are outside the app.
- The rest timer default is a flat 60 s (`defaultRestSec`); a per-exercise `restSec` overrides it. **Correction:** sets have a synced `rest_taken_sec` column, but **nothing ever writes it** (always null). Item 17 must start recording it (from marking a set done to the next set).
- **Compound vs isolation:** the Lift Type switch was removed in v4.59. `isIsolationExercise` uses an old `liftType` if present, else guesses from muscles (anything touching chest, traps, lats, shoulders, quads, hamstrings or glutes counts as compound). Failure tests only pick "isolation" exercises, so e.g. lateral raises and leg curls are never tested. Item 25's claim that "the app also tests compounds" does not match the code.
- Health metrics (calories, protein, fat, sleep, weight, ...) are user-defined Health Log metrics; the app does not know which metric is which yet.
- The app does **not** apply earned weight bumps to planned weights (item 6, parked), so P2 #7's "the app's live progression applies earned bumps" is not true today.

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
- **AI vs app weight rule:** the Review Pack prompt gives the AI the same rule in words (hold if under the bottom of the range; add one increment when the top is reached "at RIR 2 or lower"; never below the last completed top weight; on the increment grid). The AI can also deload on purpose (it must say so), and it is asked to flag stalls (same weight ≥ 2 sessions with RIR > 2).
- **Gap in both (found 2026-11-17):** the increase needs every set at the top of the range **and RIR ≤ 2**. Reaching the top with RIR 3+ (too easy) does **not** count, so the app says "same weight" forever. The AI gets the same wording and would only catch it as a stall.
- **Big steps:** the increment is per exercise (`weightIncrementKg`), but the rule is the same for every machine. On leg press, 70 → 80 kg is +14%. By the app's own e1RM formula (Epley), 70 kg × 12 at RIR 2 predicts about 6 reps at 80 kg with 2 in reserve, which is under the bottom of 8–12. At 70 kg × 14 reps at RIR 2, 80 kg predicts about 8 reps, so the jump lands inside the range.

### Decisions 2026-11-21 (his answers to Q1-33)

| Q | Item | Decision |
|---|---|---|
| 1 | review | Tracker corrections applied (above). |
| 2 | 16 carbs | Done by him (Carbs metric added). Nothing to build. |
| 3 | 16 weight | He set the Weight metric to Number. Build: convert old text entries (e.g. "102 Kgs" -> 102). |
| 4 | 16 | KEEP the "rested longer?" prompt: a set with more reps than an earlier RIR-0 set asks, answer saved on the set. |
| 5 | 17 pairing | Dropped. |
| 6 | 18 add-on weight | Dropped (no machine has one). |
| 7 | 19 photos | Reminder only (his own weekly reminder covers it, see Q24). |
| 8 | 20 maintenance calc | Dropped. |
| 9 | 21 RIR accuracy score | Dropped. |
| 10 | 22 credit editor | No build. He checks each exercise's primary muscles himself (Exercise Library; a muscle only helped by an exercise moves to secondary). Guide given in chat 2026-11-21. He checked: the muscle setup is right, keep it as is for now. |
| 11 | 32 review rhythm | Done by him (recurring task in CalendarOS). Nothing to build. |
| 12 | 31 week-2 weights | Ignore. Nothing to build or add to the prompt. |
| 13 | 13 notes | BOTH on the phone: that day's note for the exercise (same as the computer log card) and the permanent exercise note. Both go into the Review Pack. |
| 14 | 13 | No last-session note reminder. |
| 15 | 14/24/25 documents | BOTH: one line at the top of the prompt ("this prompt wins where my documents disagree"), and in the build session he pastes Doc 2 for corrected text. |
| 16 | 15 missed days | Ask the next time he opens the app: one-tap sheet listing missed planned days (work / sleep / energy / travel / other). Reasons go into the data pack. |
| 17 | 15 short on time | Ignore (dropped). |
| 18 | 16 metric types | Match metrics by name, and ask him to confirm / select where unsure. |
| 19 | 16 calorie check | Warn with "Save anyway", about 10% slack (protein x4 + carbs x4 + fat x9 vs calories). |
| 20 | 16 day complete | "Day complete" box; unticked days are marked "partial" for the AI only (still counted in averages). |
| 21 | 16 sleep | Simple, fast hours + minutes entry; stored in minutes. Old "6.34"-style entries mean 6 h 34 min; "5:00" means 5 h. Convert them. |
| 22 | 17 rest default | Keep 60 s. No compound/isolation switch. Actual rest still gets recorded (item 17). |
| 23 | 18 | Don't show the machine step on the exercise screen. |
| 24 | 19 check-in | He added a weekly reminder himself. In-app check-in dropped; weekly average weight / waist still go in the data pack (item 23). |
| 25 | 15 privacy | Move the goal weight / loss target out of the public code into Settings (private, synced). |
| 26 | 20/30 nutrition targets | Ignore: he uses a separate food app. Dropped. |
| 27 | 22 | Do NOT turn on secondary counting. |
| 28 | 23 templates | Drop every session template not used (not on the calendar in the pack's window). |
| 29 | 24 | One progression rule (double progression + big-jump check) stated at the top of the prompt. |
| 30 | 26/27 | Accept both: priority section only when priorities are set; single-exercise muscles may repeat up to 3x/week, variety rule waived. |
| 31 | 28 | Accept: a 4th set is allowed instead of an extra day when it is the lower-fatigue option, justified in the rules check. |
| 32 | 29 fallback plan | Ignore (dropped). |
| 33 | build | One release. |

### Build scope for the next session (one release, v4.75.0)

Everything below is agreed. Items not listed were dropped or done by him (see the decisions table).

1. **Notes on the phone workout (13):** a Notes button next to "+ Add set" / "- Remove last" opens a window with two fields: today's note for this exercise (the same `training_logs.notes` as the computer's log card) and the permanent exercise note (Edit Exercise -> Notes). Both go into the Review Pack (session detail and exercise library). The day note is not in the pack today.
2. **Missed sessions (15):** the next time he opens the app, a one-tap sheet lists planned days that passed unlogged; reasons: work / sleep / energy / travel / other. Stored and synced; reasons go into the data pack.
3. **Health Log entry checks (16):** match metrics to calories / protein / fat / carbs / fiber / sleep / weight / waist / steps by name, asking him to confirm where unsure; calorie check warns with "Save anyway" (protein x4 + carbs x4 + fat x9 > calories by more than ~10%); "Day complete" box, unticked days marked "partial" for the AI only; sleep entered fast as hours + minutes and stored in minutes, old entries converted ("6.34" = 6 h 34 min, "5:00" = 5 h); old text weights converted to numbers ("102 Kgs" -> 102).
4. **"Rested longer?" (16):** when a set has more reps than an earlier set of the same exercise that day logged at RIR 0 (failure), ask once (Rested longer / Earlier effort was off / Other) and save the answer on the set.
5. **Actual rest (17):** record `rest_taken_sec` (time from marking the previous set done to marking this one done); default rest stays 60 s.
6. **Privacy (25):** move the goal weight and loss target out of the public code into Settings (private, synced); update `test_v440`'s goals-shape check.
7. **Data pack (23):** drop session templates not used on the calendar in the pack's window; add per-muscle volume for each of the last 4 weeks, weekly average weight and waist, weekly average calories and protein, skip reasons, rest times, session length, planned vs done per block of the previous plan, exercise notes; failure sets carry RIR 0, not null.
8. **Prompt (24-28):** a line at the top, "this prompt wins wherever my documents disagree"; one progression rule (double progression + big-jump check) stated once at the top; the priority-muscles section only when priorities are set; muscles with a single primary exercise may repeat it up to 3x/week, variety rule waived; a 4th set is allowed instead of an extra day when it is the lower-fatigue option, justified in the rules check (update `test_v4700` deliberately).
9. **His Doc 2:** in the build session he pastes Doc 2; produce corrected text (per-muscle ranges, 60 s rest default, the single progression rule, failure tests as the app really picks them). The text stays in chat, never in the repo.

**Shipped 2026-11-21 as v4.75.0:** items 1-8. SQL: four additive columns (`app_settings.training_skip_reasons`, `health_metric_defs.role`, `health_logs.day_complete`, `training_sets.note`). Item 9 (Doc 2) is chat-only and waits for him to paste Doc 2. Interpretations used: the missed-days sheet looks back 14 days; "partial" applies only from the first day he ticks "Day complete"; rest = time since the last set marked done that day (any exercise), gaps over 30 min not counted; currentPlan keeps sessions on the calendar from 30 days back to 14 days ahead.

Check before building: which of 1-5 need SQL (e.g. a reason field for missed days, a note on sets). State it clearly and wait for his "go".

## Batch 2026-11-21 (2): after v4.75.0

| # | Comment (lightly tidied) | Type | Status |
|---|---|---|---|
| 33 | "What each metric means": Resting Heart Rate and Sleep Score exist as metrics but aren't in the drop-down list of meanings. | change | question asked (Q34) |
| 34 | (found while answering 33) "Sleep Score" was guessed as "sleep" because its name contains "sleep". | fix | question asked (Q35) |

Facts (v4.75.0): the meanings list holds only the nine the app uses (calorie check, sleep h+min entry and conversion, weekly averages of weight / waist / calories / protein). Every metric, whether or not it has a meaning, already goes to the AI each day by its own name in `bodyMetrics`. A new meaning only changes something if the app then uses it, e.g. a weekly average in `weeklyHistory`. Adding meanings needs no SQL (`role` is a text column).
