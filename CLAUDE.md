# Muhannad's apps: shared instructions for Claude

This repo (`drmohanadmusa-ui/Public`) is served by GitHub Pages and hosts **two separate apps**. Both are used every day, so treat both as production software.

| App | App file | Instructions | Tests and tools | Skills |
|---|---|---|---|---|
| **LedgerOS** (personal and family finance) | `LedgerOS.html` | `.claude/rules/ledgeros.md` | `dev/ledgeros/` | `/ledgeros-check`, `/ledgeros-ship`, `/ledgeros-data` |
| **CalendarOS** (productivity, training and tracking) | `CalendarOS.html` | `.claude/rules/calendaros.md` | `dev/calendaros/` | `/calendaros-*` |

Live: https://drmohanadmusa-ui.github.io/Public/LedgerOS.html and https://drmohanadmusa-ui.github.io/Public/CalendarOS.html.

## 1. One app per session (always)

- Work out from Muhannad's request which app the session is about. **If it isn't clear, ask before doing anything.**
- **Before any work, read that app's instructions file in full** with the Read tool (`.claude/rules/ledgeros.md` or `.claude/rules/calendaros.md`), then run its check skill.
- **Never edit the other app's files:** its HTML, its `dev/` folder, its rules file or its skills. If a request seems to need a change to the other app, stop and say so.
- Each commit touches one app only. Before committing, run `git diff origin/main --stat` and check it.
- Changes to this shared `CLAUDE.md` need Muhannad's OK.

## 2. Message counter (no exceptions)

End **every** response with a final line showing the response number in this session. Start at 1 and go up by exactly 1 each time:

— Message #1 —

Muhannad uses it to decide when to move to a fresh session. If the conversation has been auto-compacted, say so once, in one short line above the counter (for example "Context was compacted; a fresh session soon may be wise").

## 3. This repo is public

- Never commit personal data: real names, health details, balances, account numbers, Supabase URLs or keys, tokens, or screenshots of real data.
- Test fixtures use invented people and numbers only.

## 4. Deploying (same for both apps)

- Work on the session's branch. When the work is tested, push it, and ask Muhannad to **Create PR → Merge**. GitHub Pages updates about a minute after the merge.
- If he asks for a direct push to `main` and the session allows it, that's fine. **Always rebase on `origin/main` first**, because the other app's commits land on the same branch.
- **Don't send him the built HTML** or other files. His work PC's antivirus deletes downloads, and he never handles files.
- After the merge, confirm the version changed:
  - `git show origin/main:<App>.html | grep -m1 "const APP_VERSION"`
  - Pages deploy status: `gh api "repos/drmohanadmusa-ui/Public/actions/runs?per_page=3"`
  - The live github.io URL may be blocked by the session's network allowlist.

## 5. Shared browser storage (both apps run on one web address)

- Both apps run on `drmohanadmusa-ui.github.io`, so they share **one ~5 MB `localStorage` pool** and one IndexedDB origin.
- This once made CalendarOS saves fail, because a large LedgerOS cache filled the pool. That cache now lives in IndexedDB.
- **Rules:**
  - Keep anything large in IndexedDB, not `localStorage`.
  - Never call `localStorage.clear()` and never remove keys that belong to the other app.
  - CalendarOS keys use the `cos_` prefix. LedgerOS keys are listed in `LEDGEROS_KEYS`.

## 6. Real data and other repos

- Real data may only be **read**, through Muhannad's read-only connectors. Never write to it, and keep real figures in chat only.
- Never touch these repos: `personal-apps-hosting` (must stay private), `WebApps` (an old copy) and `personal-data-backups`. They are his to manage.
