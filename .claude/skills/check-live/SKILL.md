---
name: check-live
description: Start-of-session check for LedgerOS. Confirms the version in the repo, on origin/main and (if reachable) on the live site, and runs the full regression suite. Use at the start of every LedgerOS session and whenever Muhannad asks "what's live?" or "are the tests green?".
---

# Check live LedgerOS

Report facts you actually observed. Don't report what you expect.

1. **Sync.** Run `git fetch origin main`. Note your current branch, and whether it is behind `origin/main`. CalendarOS commits land on main from elsewhere, so being behind is normal. Rebase if your branch has no work yet.
2. **Versions.** Show `const APP_VERSION` from:
   - the working copy: `grep -m1 "const APP_VERSION" LedgerOS.html`
   - `origin/main`: `git show origin/main:LedgerOS.html | grep -m1 "const APP_VERSION"`
   - the live site, if reachable: `curl -sL --max-time 20 https://drmohanadmusa-ui.github.io/Public/LedgerOS.html | grep -m1 "const APP_VERSION"`

   If curl is blocked by the session's network allowlist, say so in one line and rely on `origin/main`. Pages serves `main` about a minute after a merge.
3. **Changelog.** Confirm the top `CHANGELOG` entry's version equals `APP_VERSION`.
4. **Tests.** Run `bash dev/run_tests.sh`. Report the exact final line (`N passed, M failed`) and any `FAIL` lines.
   - The baseline at the move to Claude Code was 1701 passed at v4.63.0. The count only grows.
5. **Report** in a few lines:
   - the versions (and whether they match)
   - the test result
   - anything unexpected: a mismatch, failures, uncommitted changes, or a newer `origin/main` that the working copy doesn't have

   Then **wait** for Muhannad's next instruction. Don't start building.
