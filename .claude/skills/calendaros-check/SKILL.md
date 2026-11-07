---
name: calendaros-check
description: Start-of-session check for CalendarOS. Confirms the version in the working copy, on origin/main and (if reachable) on the live site, checks the changelog matches, runs the full regression suite and compares it with the known baseline, then reports and waits. Use at the start of every CalendarOS session and whenever Muhannad asks "what's live?" or "are the tests green?".
---

# Check live CalendarOS

Report facts you actually observed, not what you expect. Change nothing during this check.

1. **Read the rules.** If you haven't this session, read `.claude/rules/calendaros.md` in full.
2. **Sync.** Run `git fetch origin main`. Note your current branch, whether it is behind `origin/main`, and any uncommitted changes (`git status --short`).
   - LedgerOS commits land on main from elsewhere, so being behind is normal.
   - If your branch has no work of its own yet, rebase it on `origin/main`.
3. **Versions.** Show `const APP_VERSION` from:
   - the working copy: `grep -m1 "const APP_VERSION" CalendarOS.html`
   - `origin/main`: `git show origin/main:CalendarOS.html | grep -m1 "const APP_VERSION"`
   - the live site, if reachable: `curl -sL --max-time 20 https://drmohanadmusa-ui.github.io/Public/CalendarOS.html | grep -m1 "const APP_VERSION"`

   If curl is blocked by the session's network allowlist, say so in one line and rely on `origin/main`. Pages serves `main` about a minute after a merge.
4. **Changelog.** Confirm the top `CHANGELOG` entry's `v:` equals `APP_VERSION`, and that its first line states the SQL status. (`test_core_conventions.js` checks this too.)
5. **Tests.** Run `bash dev/calendaros/run_tests.sh`.
   - Report the exact final line (`N passed, M failed`), the "Known stale / NEW / Crashed" line, and every `[NEW]` or `CRASH` line in full.
   - **Clean = 0 NEW and 0 crashed.** The known stale failures are listed in `dev/calendaros/baseline_failures.txt` (29 at the move to Claude Code).
   - The baseline at the move was **864 passed, 29 failed, 0 new** at v4.71.1. The passed count only grows.
   - If a `[NEW]` line appears before any change was made, it is most likely date-sensitivity (tests use the real clock) or a newer `origin/main`. Say which, and don't touch the baseline.
6. **Report** in a few lines:
   - the three versions, and whether they match
   - the test result: counts, NEW lines, crashes
   - anything unexpected: a mismatch, uncommitted changes, a newer `origin/main` the working copy lacks, or a changelog/version mismatch

   Then **wait** for Muhannad's next instruction. Don't start building.
