---
name: ledgeros-ship
description: Release checklist for a LedgerOS change - version bump, CHANGELOG entry, full test run, break-then-restore, privacy check, commit, rebase, push, and post-merge verification. Use whenever a LedgerOS change agreed with Muhannad is ready to go live.
argument-hint: "[new version, e.g. 4.64.0]"
---

# Ship a LedgerOS change

Only ship work Muhannad has agreed to. If a step fails, stop, say exactly what failed, and fix it. Never skip a step to get green.

## 1. Version and changelog

- Bump `const APP_VERSION` in `LedgerOS.html` (near line 580; grep `const APP_VERSION`). Use the version given in the arguments if any; otherwise semver, where a new feature bumps the minor version.
- Add the matching entry at the **top** of `CHANGELOG`: `{version:'X.Y.Z', date:'YYYY-MM-DD', changes:[...]}`.
  - Use today's date in Asia/Riyadh time.
  - Write plain sentences for Muhannad: what he'll see and where, not code names.
  - Escape non-ASCII characters as `\uXXXX`, like the existing entries.
- Confirm that `APP_VERSION` and the top entry match.

## 2. Integrity

- For every function you added or changed, check it is defined exactly once: `grep -c "function NAME(" LedgerOS.html` must print 1.
- Check the extracted JS parses. `dev/ledgeros/run_tests.sh` runs `node --check` as its first step.

## 3. Full test run

- Run `bash dev/ledgeros/run_tests.sh`. It must end `N passed, 0 failed`, with N greater than before.
- The new tests must be real assertions on the new behaviour: no `|| true`, and every `[0]`, `.match(...)[1]` and `querySelector` guarded.

## 4. Break-then-restore (mandatory)

- Write a throwaway JSON file **outside the repo**, for example `/tmp/breaks.json`. It holds one break per new behaviour, normally 2 to 5:

  ```json
  [{"name": "fee not taken per owner", "good": "<exact snippet, unique in LedgerOS.html>", "bad": "<broken version>"}]
  ```

- Run `python3 dev/ledgeros/break_restore.py /tmp/breaks.json`.
  - Every break must print `RED`, and the final line must be `RESTORED -> N passed, 0 failed`.
  - A break that stays GREEN means a test is missing. Add the test and run it again.
  - A `SKIP` means the snippet isn't unique. Widen it.
- After the run, `git diff --stat` must show only your intended changes. The tool restores the app byte for byte.

## 5. Things Muhannad must do by hand

- **Schema change** (`DB_SCHEMA_CORE`)? Tell him to run Settings → Database Schema in the app. It is idempotent, and changes are additive only.
- **New Supabase table?** Remind him to add it to his backup script's table list.
- **SMS parser or an Edge Function changed?** Run `node dev/ledgeros/edge/sms-ingest/build.js` (the suite fails while `index.ts` is stale), then deploy it yourself through the Supabase Management API after the merge (commands at the top of `dev/ledgeros/edge/README.md`) and test it with a non-money text. Don't hand this to him (CLAUDE.md section 8).

## 6. Privacy check (the repo is public)

- Run `git diff origin/main --stat`. The changed files should be `LedgerOS.html`, files under `dev/ledgeros/`, and possibly `.claude/rules/ledgeros.md` or `.claude/skills/ledgeros-*`.
  - **Nothing belonging to CalendarOS may appear:** `CalendarOS.html`, `dev/calendaros/`, `.claude/rules/calendaros.md` or `.claude/skills/calendaros-*`. Shared `CLAUDE.md` changes need Muhannad's OK.
- Scan the diff for real names, balances, account numbers, Supabase URLs or keys, and tokens. Test fixtures use invented people (Sam, Mother, Omar, ...) and invented numbers only.

## 7. Commit and push

- Commit message: `LedgerOS vX.Y.Z: <one-line summary>`.
- Run `git fetch origin main`, then `git rebase origin/main`, then run `bash dev/ledgeros/run_tests.sh` once more after the rebase. Then push the session branch.
- Open a PR from the session branch to `main` and **merge it yourself** with the GitHub tools (standing permission from Muhannad, see `CLAUDE.md` section 4). Don't ask him to merge.

## 8. After the merge

- Run `git fetch origin main && git show origin/main:LedgerOS.html | grep -m1 "const APP_VERSION"`. It must show the new version.
- If the live URL is reachable, check it too. Pages takes about a minute.

## 9. Tell Muhannad (short)

- What changed, in his words.
- The test count, and the break-then-restore result.
- Any manual step (schema SQL, backup script).
- Any mistakes made along the way, including in first-draft tests.
- **Don't** send him the built HTML.
