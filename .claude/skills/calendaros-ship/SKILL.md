---
name: calendaros-ship
description: Release checklist for a CalendarOS change - version bump and CHANGELOG entry (with the SQL status line), integrity checks, full test run against the baseline, break-then-restore, optional phone-size browser check, privacy scan, one-app-only diff check, commit, rebase on origin/main, push, ask for Create PR then Merge, and post-merge verification. Use whenever a CalendarOS change Muhannad has said "go" to is ready to go live.
---

# Ship a CalendarOS change

Only ship work Muhannad has explicitly said "go" to. If a step fails, stop, say exactly what failed, and fix it. Never skip a step or weaken a test to get green.

## 1. Version and changelog

- Bump `const APP_VERSION` in `CalendarOS.html` (near line 2360). Use the version Muhannad named, if any. Otherwise use semver: a batch of features is a minor bump, a fix to something just shipped is a patch bump.
- Add the matching entry at the **top** of `const CHANGELOG = [` as `{ v:'X.Y.Z', changes:[ ... ]},`.
  - **The first line is the SQL status:** either `'No SQL migration needed — front-end only. ...'` or `'🔴 SQL migration required — Settings → Cloud Sync → Copy SQL, run in the Supabase SQL editor. Adds ... Additive and safe to run more than once. ...'`.
  - Following lines start `NEW —`, `CHANGED —` or `FIX —`, written for a non-technical reader: what he will see and where, not code names.
  - Write non-ASCII as `\uXXXX` escapes, like the existing entries.
- Confirm that `APP_VERSION` and the top entry match.

## 2. Integrity

- For every function you added or changed, check it is defined exactly once: `grep -cE "^(async )?function NAME\(" CalendarOS.html` must print 1.
- Check for duplicate top-level function names across the app. This must print nothing:
  `python3 dev/calendaros/tools/split_calendaros.py CalendarOS.html /tmp/cos_split && grep -oP '^(async )?function \K\w+' /tmp/cos_split/app.js | sort | uniq -d`
- **SQL change?** Grep the embedded Copy SQL block (search `alter table`) for every statement the changelog announces. It must be additive and idempotent (`if not exists`). A new synced field needs the mapping pair, the upsert, the pull, the SQL, and a test.
- **New table?** Add it to `SYNCED_TABLES` **and** `BACKED_UP_TABLES`, and tell him to re-copy the backup script (step 6).
- `run_tests.sh` runs `node --check` on the app script as its first step.

## 3. Tests

- Add real tests for the new behaviour in a new `dev/calendaros/tests/test_vXYZ0.js`, named after the version. Copy the pattern of `test_v4710.js` and finish with the `name: N passed, M failed` line.
  - No hardcoded "newest version" assertions: use `t.CHANGELOG.some(c=>c.v==='X.Y.Z')` or `t.APP_VERSION`.
  - Guard every `[0]`, `.match(...)[1]` and `querySelector`. No `|| true`.
  - Test the "should stay unchanged" cases too, not only the "should change" ones.
- Run `bash dev/calendaros/run_tests.sh`. It must end with **0 NEW and 0 crashed**, and the passed count must be higher than before.
- Never add a line to `baseline_failures.txt` to hide a failure.

## 4. Break-then-restore (mandatory)

- Write a throwaway JSON file **outside the repo**, e.g. `/tmp/breaks.json`, with one break per new behaviour (normally 2 to 5):

  ```json
  [{"name": "what the break simulates", "good": "<exact snippet, unique in CalendarOS.html>", "bad": "<broken version>"}]
  ```

- Run `python3 dev/calendaros/break_restore.py /tmp/breaks.json`. It breaks a temp copy only and never edits `CalendarOS.html`.
  - Every break must print `RED`, and the last line must be `RESTORED -> N passed, 29 failed (exit 0)`. The number of failures is whatever the current baseline is.
  - A break that stays GREEN means a test is missing. Add the test and run it again.
  - A `SKIP` means the snippet isn't unique. Widen it.

## 5. UI changes: look at it

- Run `node dev/calendaros/smoke_browser.js`. It must print `5 passed, 0 failed`. Then look at `dev/calendaros/.build/smoke_390x844.png` yourself.
- For the screen you changed, seed invented `state` in a short Playwright script and screenshot it at 390×844. Mobile layout bugs were only ever found this way.
- Say clearly what was **not** tested on a real phone. **Never send screenshots or files to Muhannad.**

## 6. Things Muhannad must do by hand

- **SQL change:** tell him clearly, and paste the exact new statements in your reply. Tell him to run Settings → Cloud Sync → Copy SQL in the Supabase SQL editor **before** using the new version, because sync shows errors until then.
- **New table:** tell him to re-copy the backup script from Settings into his `backup_calendaros.py`.

## 7. Privacy and one-app check (the repo is public)

- Run `git diff origin/main --stat`.
  - Allowed: `CalendarOS.html`, `dev/calendaros/**`, `.claude/rules/calendaros.md`, `.claude/skills/calendaros-*`.
  - **Nothing belonging to LedgerOS may appear:** `LedgerOS.html`, `dev/ledgeros/`, `.claude/rules/ledgeros.md`, `.claude/skills/ledgeros-*`.
  - Changes to the shared `CLAUDE.md` need Muhannad's OK.
- Scan the added lines (`git diff origin/main -U0 | grep '^+'`) for:
  - real names, health or body details, birthdays, phone numbers, emails, card references
  - `supabase.co` URLs, `eyJ` keys, `ghp_` / `github_pat_` tokens, PINs
- Test fixtures use invented data only: Layla, Sam, Alpha/Beta silos, Site A/B, `proj.example.test`, PIN `1234`.

## 8. Commit and push

- Commit message: `CalendarOS vX.Y.Z: <one-line summary>`. Stage files by name, never `git add -A`.
- Run `git fetch origin main`, then `git rebase origin/main`, then `bash dev/calendaros/run_tests.sh` once more after the rebase.
- Push the session branch with `git push -u origin <branch>`, then ask Muhannad to **Create PR → Merge**.
- If he asked for a direct push to `main` and the session allows it, push `HEAD:main` instead, after the same rebase.

## 9. After the merge

- Run `git fetch origin main && git show origin/main:CalendarOS.html | grep -m1 "const APP_VERSION"`. It must show the new version.
- Run `git show origin/main:CalendarOS.html | cmp - CalendarOS.html` to confirm what is on main is byte-identical to what you tested.
- Check the Pages deploy with `gh api "repos/drmohanadmusa-ui/Public/actions/runs?per_page=3"`. The newest "pages build and deployment" run must be `completed` / `success`. Check the live URL too if it is reachable, which takes about a minute.

## 10. Tell Muhannad (short)

- What changed, in his words.
- SQL: none needed, or exactly what to run.
- The test count (and that there are 0 new failures), plus the break-then-restore result.
- What was not tested on a real phone.
- Any mistakes made along the way, including in first-draft tests.
- **Don't** send him the built HTML or any file.
