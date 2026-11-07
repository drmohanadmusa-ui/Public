---
paths: ["CalendarOS.html", "dev/calendaros/**", ".claude/skills/calendaros-*/**"]
---

# CalendarOS: app-specific instructions

These rules add to the shared rules in the root `CLAUDE.md` (one app per session, message counter, public-repo privacy, deploy flow, shared browser storage).

**What this covers:**
- **App:** `CalendarOS.html`: tasks and calendar, health log, lists, recipes, coffee, and a training module with an AI "Review Pack" loop and a phone-first workout screen. Live at https://drmohanadmusa-ui.github.io/Public/CalendarOS.html.
- **Tests and tools:** `dev/calendaros/`. **Skills:** `/calendaros-check`, `/calendaros-ship`. (There is no `/calendaros-data`: no read-only connector exists for CalendarOS's Supabase project. The connected Supabase one is LedgerOS's.)

Muhannad uses it every day on three devices (phone, work PC, home), so **treat it as production software.**

## 1. Working method (agreed with Muhannad, keep following it)

1. **Start with `/calendaros-check`.** Verify, don't assume, including anything written in this file. Before building, check the feature doesn't already exist.
2. **Requests arrive as a numbered list**, often voice-dictated, so wording can be garbled. Ask when unsure what a word means.
3. **Standing instruction:** ask as many questions and follow-ups as needed before starting. **If the schema SQL changes, tell him clearly.**
4. **The loop for every batch:**
   - Investigate the real code path first (grep, read the functions involved).
   - Reply with short findings plus numbered questions, each with the **recommended option first**. He answers tersely ("A", "yes", "go with your recommendations").
   - **Reconfirm the final scope** in a short list. State your interpretation of any ambiguous word, and say plainly "SQL: none needed" or exactly what SQL.
   - **Wait for an explicit "go"** before building.
   - Build ONE version, run `/calendaros-ship`, and report in a few lines: what changed, SQL yes/no, and anything not tested on a real phone.
5. **Reply style:** short, plain language, outcome first, no recap of steps. The changelog is written for a non-technical reader.
6. **Verify with data, don't guess.** Never claim a save or push worked without checking. Hedge data-loss diagnoses until proven: he has corrected overconfident ones before.
7. A request phrased as a question ("why does X…?") gets an answer. Fix only if it is clearly a bug.
8. Ctrl+Z doesn't exist on phones. If a feature depends on a keyboard shortcut, say so.
9. **Be honest about mistakes**, including in first-draft tests. **Don't send him the built HTML** or other files.

## 2. Architecture essentials

**Single file.** `CalendarOS.html` (~1.2 MB): HTML/CSS shell plus one large inline app script (the **last** plain `<script>` block). No framework, no build step in the repo. **Edit `CalendarOS.html` directly** (Edit tool). `dev/calendaros/tools/split_calendaros.py` splits it into `app.js` + `index.html` (placeholder `__APP_JS__`) for the test harness only. The old chat edited split sources and rebuilt; whether to commit split sources instead is an open decision (§8).

**State.** One global `const state = {...}`: `tasks {oneTime, recurring, completions}`, `lists`, `health`, `healthMetricDefs`, `dailyRatings`, `training {exercises, sessions, calendar, logs, sets, resources}`, `recipes`, `coffee`, `settings` (locations, silos, colours, presets, flags, `sync`), `syncMeta {status, dirty, dirtyDomains, lastSyncedAt, lastError}`, plus view/UI fields. `render()` / `renderMain()` rebuild innerHTML wholesale.

**Local storage (shared ~5 MB pool with LedgerOS, see root `CLAUDE.md` §5).**
- `window.storage` is used if a host injects it. Otherwise the app installs a shim over `localStorage` that prefixes every key with **`cos_`** (`cos_dispatch:tasks`, ...). All removals go through that shim. There is no `localStorage.clear()`, and the storage panel only *reads* other apps' keys to report their size. `test_core_conventions.js` guards this.
- `STORAGE_KEYS` (all `dispatch:*`): tasks, lists, health, settings, syncmeta, unlock, ratings, recentcompletions, healthmetricdefs, training, recipes, hydration, coffee, syncerrorhistory, deletionhistory, trainingdrafts.
- **Tiers:** `DISPOSABLE_STORAGE_KEYS` (training, health, recipes, coffee, hydration, ratings, metric defs, sync-error history) can be re-downloaded and are evicted first when storage is full. `CRITICAL_STORAGE_KEYS` (recentcompletions, lists, tasks, settings, trainingdrafts) always win, and a failed critical write always warns him. Writes go through `safeStorageSet`.
- **CalendarOS does not use IndexedDB yet.** The large caches (training sets, health, recipes, coffee) still live in `localStorage`. Moving them to IndexedDB, as LedgerOS did, is in the backlog (§8).
- Device-local settings with no DB column: `mobileWorkoutBeta`, `mobileAccent`, `dashboardSilo`, `hideMissedMoved`, `hideCompleted`, `collapsedMetricGroups`, `repsTopMigrated469`, colour theme. These need no SQL.

**Sync (Supabase REST, optional).** The URL, anon key and PIN are typed in by Muhannad and live only in his browsers, never in the file.
- `supaUpsert(table, rows, conflictCols)`: POST with `on_conflict` and `resolution=merge-duplicates`. Throws on any non-OK response.
- `supaSelectAll(table)`: paged GET scoped `pin=eq.<pin>` with `Prefer: count=exact`. **Failed, short or malformed reads must throw**, because partial data looks like deletions.
- `supaDeleteMatch(table, match)`: explicit DELETEs. An upsert never deletes server rows, so every local delete queues an entry (`pendingCompletionDeletes`, `pendingTrainingDeletes`, `pendingRecipeDeletes`, `pendingMetricDefDeletes`, ...) that the next push sends.
- **PIN scoping:** every row has a `pin` column. RLS is permissive (anyone with the anon key), so the PIN is a convenience, not security.
- `meta jsonb` on entity tables lets a field be added before a migration.
- **Push before pull:** a dirty domain is pushed before any pull, so a stale device can't overwrite newer edits. Divergence is logged, then resolved in favour of online (the "which copy" modal was removed in 4.44). Training/recipes/coffee/hydration pulls are fault-isolated.
- Row mapping uses `xToRow` / `rowToX` pairs (e.g. `metricDefToRow` / `rowToMetricDef`). **A new synced field needs:** the mapping pair, the upsert, the pull, the SQL block, and a test.

**Supabase tables (21) = `SYNCED_TABLES`:** `one_time_tasks, recurring_tasks, task_completions, lists, list_items, health_logs, daily_ratings, health_metric_defs, app_settings, training_exercises, training_sessions, training_calendar, training_logs, training_sets, training_resources, recipes, recipe_ingredients, hydration_logs, coffee_beans, coffee_bags, coffee_brews`.
- `BACKED_UP_TABLES` is the declared mirror of his backup script's list. A red banner shows if they differ, and tests check `SYNCED_TABLES` against the real `supaUpsert` calls.
- `training_sets` holds the real per-set data. `training_logs` is a derived summary (auto-synced, with a Rebuild button and a render-time self-heal).
- Hydration UI was removed in 4.67, but its table and columns still sync on purpose.

**Schema SQL.** One additive, idempotent block embedded in the app (search `alter table`): `create table if not exists`, `add column if not exists`. It is the only copy. He runs it by hand: Settings → Cloud Sync → Copy SQL → Supabase SQL editor. **Grep the block for anything a changelog announces** (see 4.59 in §6).

**Backup.** The in-app "Copy / Download backup script" builds `backup_calendaros.py` with `TABLES` generated from `SYNCED_TABLES`, so the in-app copy is the one he uses. `dev/calendaros/tools/backup_calendaros.py` and `restore_table.py` are reference copies that `test_v440` reads. Restore is dry-run by default, needs `--apply`, and only upserts.

## 3. Conventions

- **Every shipped change bumps `const APP_VERSION`** (near line 2360) and adds a matching entry at the **top** of `const CHANGELOG = [` as `{ v:'X.Y.Z', changes:[ ... ]}`.
  - **The first line is always the SQL status:** `'No SQL migration needed — front-end only. ...'`, or `'🔴 SQL migration required — Settings → Cloud Sync → Copy SQL, run in the Supabase SQL editor. Adds ... Additive and safe to run more than once. ...'`.
  - Following lines start `NEW —`, `CHANGED —` or `FIX —`, in plain language.
  - Write non-ASCII as `\uXXXX` escapes inside the strings, like the existing entries.
  - **Semver:** a batch of features is a minor bump (4.70.0 → 4.71.0). A fix to something just shipped is a patch bump (4.71.0 → 4.71.1). One version per batch.
- **Never hardcode version numbers in tests.** Assert the changelog *contains* the version under test (`t.CHANGELOG.some(c=>c.v==='4.71.0')`), or compare against `t.APP_VERSION`. "Newest entry is X" assertions broke twice.
- **Never weaken an assertion** to get green. Don't rename or renumber `test_vXXX.js` files.
- **Weekend location rules are display-only.** `taskLocationFor()` / `isLocationRemapped()` change only what is shown and never rewrite stored data.
- **Failed Supabase reads must throw.** Never return partial data.
- **Only overwrite a field if its input exists** (a collapsed-card save once wiped notes). **Patch the DOM instead of a full `renderMain()`** where a test guarantees no full re-render (RIR tap).
- **Keep the desktop training layout** (`renderTrainingToday` etc.). The phone workout shows only at viewport ≤ 860px with the beta switch on and Training on "today".
- **Training rules in the app and Review Pack:**
  - one working weight per exercise per day, and weights never go backwards from the last completed top weight
  - each exercise uses its own weight increments, and reps default to the **top** of the range (4.69)
  - 3 working sets by default; 4 only through the exception ladder; at most 6 exercises per day (search `WORKING SETS PER EXERCISE`)
  - sets are never auto-created for past days, and plan import clears stale not-done sets on future dates only
- **Never put credentials or tokens in any file.** Test fixtures use invented data: names (Layla, Sam), silos (Alpha/Beta/Gamma), locations (Site A/B, Home, Office), host `proj.example.test`, PIN `1234`.

## 4. Tests

- **Run:** `bash dev/calendaros/run_tests.sh [path/to/CalendarOS.html]`. It works from any clone location and takes about 40 seconds.
  - It splits the app into `dev/calendaros/.build/` (gitignored), installs pinned `jsdom` on first run, and runs every `dev/calendaros/tests/test_*.js`.
  - It prints each FAIL line marked `[known]` or `[NEW]`, then `N passed, M failed`. Exit codes: 0 = no new failures, 1 = new failure, 2 = crash or build error.
- **Baseline at the move to Claude Code (v4.71.1, 2026-11-07): 864 passed, 29 failed, 0 new.** That is 25 suites: 24 carried over (841 passed) plus `test_core_conventions.js` (23).
  - The 29 are **known stale assertions** in 8 older suites (`baseline_failures.txt`): behaviour that later versions deliberately changed. They predate the move.
  - **"Clean" means no `[NEW]` lines, not zero failures.** Never add a line to the baseline to hide a new failure. Retiring a stale assertion is agreed work, and its baseline line is deleted in the same commit.
  - `test_v441` is date-sensitive: 2 extra known lines fail on some weekdays. Tests use the real clock, so compare against an untouched build on the same day before blaming your change.
- **Break-then-restore:** `python3 dev/calendaros/break_restore.py /tmp/breaks.json`. It breaks a temp *copy*, never the real file. Red means a `[NEW]` failure. See `/calendaros-ship`.
- **Optional real browser:** `node dev/calendaros/smoke_browser.js` loads the app in Chromium at 390×844 with all network blocked, checks for page errors, and saves `.build/smoke_390x844.png`. It uses the Playwright pre-installed on cloud machines (verified 2026-11-07) and prints SKIP if that is missing. Use it for UI changes: jsdom misses layout bugs.
- **Harness (`harness.js`):**
  - `loadApp(opts)` strips the final `init();`, evals the app into jsdom (URL `https://example.com/`), and returns `win`.
  - Top-level functions are `win.fn()`. `const`/`let` values are on `win.__t` (`state`, `APP_VERSION`, `CHANGELOG`, `SYNCED_TABLES`, ...). Add getters there when needed.
  - `win.storage` is an in-memory Map (`win.__store`, **no** `cos_` prefix, so the shim isn't tested at runtime). `win.fetch` records calls in `win.__calls` and answers from `opts.fetchHandler(url, method, init)` → `{status, rows, total}`.
  - Sync tests set `t.state.settings.sync = {url:'https://proj.example.test', anonKey:'anon', pin:'1234'}`.
  - **Dates are not frozen:** use `win.todayStr()` / `win.addDays()`.
  - Health-page tests need `t.state.settings.healthCoreMetricsSeeded = true`.
- **Quirks:**
  - Inline `onclick=` doesn't run in jsdom, so call functions directly. jsdom writes `selected` as `selected=""` (match `/selected(="")?>/`).
  - Stub `win.matchMedia` (`matches:true` simulates a phone), `win.window.scrollTo`, `#mainContent`, `prompt`/`confirm`, and `navigator.clipboard`.
  - Scrubber tests dispatch `pointerdown` with `clientY`. Post-drag click suppression lasts 400 ms.
  - Some suites read `./CalendarOS.html` relative to cwd. The runner runs from `.build/`.
  - Console noise ("Not implemented: ...") is expected.
- **Test hygiene:** guard every `.match(...)[1]`, `[0]` and `querySelector(...)` so a break gives a clean FAIL, not a crash. No `|| true` placeholders. Prefer regex/`includes`/`some()` over brittle exact strings.
- **Patch carefully:** with scripted replacements, assert each anchor occurs exactly once. After a big edit, check every touched function is still defined exactly once.

## 5. Real data

No read-only connector exists for CalendarOS's Supabase project, so sessions can't see his data. When he reports a data problem, ask him for the in-app sync/activity log (Settings), not credentials. **Never write to real data.**

## 6. Incidents and mistakes worth remembering

- **`training_logs` never synced from the new logging flow.** It looked like data loss, but the data was safe in `training_sets`. Hedge data-loss diagnoses.
- **4.59.0 announced a migration the SQL block didn't contain** (fixed in 4.59.1). Grep the block for what you announce.
- **A collapsed-card save wiped notes**, and a **full re-render on RIR tap** broke a guarantee (see §3).
- **AI plan session names collided** on import: names must contain the full date and year. Import didn't clear stale future not-done sets (it does now).
- **Planned volume double-counted** today's done sets (a duplicated calculation was consolidated). **4.61:** Calendar View / Session Library were dropped from navigation. **4.63:** "weights going backwards" because progression used warm-ups or future staged days.
- **v4.71.0 "Hide missed / moved" hid too much.** He meant only what is missed/moved *for the date shown* (fixed in 4.71.1). Restate your interpretation of ambiguous words, and test the "should stay visible" cases too.
- **Pushes were rejected (non-fast-forward)** because LedgerOS commits land on the same `main`. Always rebase on `origin/main` first.
- **Mobile workout layout bugs were found only by screenshots.** Use `smoke_browser.js` or a seeded screenshot for UI work.
- **The old claude.ai sandbox lost its workspace more than once.** That's why everything now lives in this repo.
- **Privacy:** an old hand-over file held a GitHub token in plain text. Never repeat that.
- **The move to Claude Code (2026-11) found a coverage gap:** no test checked that a failed Supabase read throws. `test_core_conventions.js` now does, verified by break-then-restore.

## 7. Recent version history (full detail in the in-app CHANGELOG)

| Version | What shipped |
|---|---|
| 4.57 | Neck, calves and forearms removed from tracked muscle groups; training hand-over baseline |
| 4.58–4.59.1 | Swap recomputes suggested weight; import no longer overwrites manual notes; missing-SQL fix |
| 4.60 | Exercise rows default to collapsed |
| 4.61 | Calendar View / Session Library restored to Training navigation |
| 4.62 | Locked-date import protection (dates with logged sets can't be overwritten) |
| 4.63 | Weights-going-backwards fix (done working sets only) |
| 4.64 | Coffee module (beans, bags, brews, calculator, insights, AI pack). **SQL** |
| 4.65 | Review Pack uses 30 days; coffee calculator flash fix; Log History auto-fill |
| 4.66 | Mobile workout (beta): full-screen, one exercise at a time on phones |
| 4.67 | Drag scrubber for weight/reps, set cascade, RIR sheet, mid-workout swap, missing-data alarm, Hydration UI removed |
| 4.68 | Dashboard silo chips, reorderable health metrics, blank location/silo on new tasks, date bubbles above field |
| 4.69 | Duplicate task, reps default to top of range, phone scroll lock, rest tips in dock, RIR tap on done sets |
| 4.70 | Review Pack: 3 sets default / 4-set ladder, 6 exercises per day, rules-check listing (prompt text only) |
| 4.71.0 | Ctrl+Z undoes recurring moves, "Hide missed / moved" switch, health metric groups. **SQL:** `group_id`, `metric_groups` |
| 4.71.1 | Fix: "Hide missed / moved" hides only what is missed/moved for the shown date |

## 8. Open items and backlog (ask before starting any of them)

**Waiting on Muhannad's decision:**
1. **Privacy clean-up of the public app.** `CalendarOS.html` itself still contains personal details: a personal goal weight/target in the Review Pack goals, a family first name used as a silo colour key, and city names in old changelog entries. Removing them needs a normal versioned release, plus an update to the test that asserts the goals shape (`test_v440`). Don't copy the values anywhere.
2. **Rotate the GitHub token** that sat in an old plain-text hand-over file. Not confirmed done.
3. **Retire the 29 stale assertions** (rewrite each to current intended behaviour, delete its baseline line).
4. **Commit split sources** (`app.js` + `index.html`) or keep editing `CalendarOS.html` directly (current method).
5. **Move the large caches to IndexedDB** to free the shared `localStorage` pool (LedgerOS has done this).
6. Retire the "Mobile workout (beta)" switch? (Keep the desktop layout code either way.)
7. Remove the inert hydration plumbing (table sync, settings columns, backup entry)?
8. A visible Undo for recurring moves (Ctrl+Z only today; he uses a phone a lot).
9. Confirm the 4.71.0 SQL was run (sync errors with `PGRST204` / missing column mean re-run Copy SQL).
10. The iPhone chime (hardened in 4.59/4.61) was never confirmed on a device.
11. His own copy of `backup_calendaros.py` must list the coffee tables. The red banner shows if not, and re-copying from Settings fixes it. Where or whether it runs on a schedule was never verified.

**Parked (only if he asks):** per-exercise notes on the phone screen; full-screen rest ring; app-level lock so plan import can never create exercises; post-workout questionnaire (start with session RPE); attachments (needs a security-model decision); more coffee-tasting features; import-side warning for 4-set blocks (he declined).
