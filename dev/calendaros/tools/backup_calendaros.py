#!/usr/bin/env python3
"""
CalendarOS automated backup script.

Pulls every table (scoped to your PIN, matching how the app itself scopes
every query) from the CalendarOS Supabase project and writes one JSON file
containing the raw rows exactly as stored — no field renaming. The output
shape is unchanged: a top-level object of {table_name: [rows...]}, so
restore_table.py keeps working as-is.

Usage:
    python3 backup_calendaros.py --out backups/calendaros/2026-08-26.json

Requires:
    CALENDAROS_SUPABASE_URL
    CALENDAROS_SUPABASE_ANON_KEY
    CALENDAROS_PIN

--------------------------------------------------------------------------
CHANGES vs the previous version, and why each one matters
--------------------------------------------------------------------------
1. TABLE COVERAGE, VERIFIED AUTOMATICALLY EVERY RUN (v4.44.0). The app
   already tracks its own table list (SYNCED_TABLES in CalendarOS.html) and
   the developer-facing mirror of it this script is supposed to match
   (BACKED_UP_TABLES) — but that comparison only ran when someone happened
   to open Settings and notice a banner. A table added to the app between
   then and the next backup run would be silently skipped forever. This
   script now reads SYNCED_TABLES straight out of CalendarOS.html at the
   start of every run and aborts BEFORE fetching anything if the app has a
   table this script's TABLES list doesn't know about — the coverage check
   is now a hard gate at backup time, not a reminder someone has to see.

2. PAGINATION. PostgREST caps rows per response (Supabase's default cap is
   commonly 1000), and it truncates SILENTLY — you get 200 OK with a partial
   body. Every table is fetched in pages via Range headers until exhausted,
   and the true total from Content-Range is cross-checked against what was
   actually retrieved.

3. FAILURES ARE FATAL, NOT EMPTY. A missing table, a permissions problem, or
   a transient 5xx aborts the whole run rather than silently writing an
   empty list for that table — a backup that LOOKS complete but is missing
   a table is worse than no backup, because nothing about the file tells you
   that later.

4. NO DAY-OVER-DAY SHRINK CHECK (removed in v4.44.0). An earlier version of
   this script compared each day's row counts against the previous backup
   and refused to write if any table shrank, on the theory that a shrink
   might mean silent data loss. That check is gone: every day already writes
   to its own separate, dated file (backups/calendaros/YYYY-MM-DD.json), so
   there is nothing for a smaller backup to overwrite or endanger — a
   deliberate deletion (or any other legitimate shrink) is just what today's
   file correctly shows, and every previous day's file is untouched either
   way. Item #1 above is the check that actually matters: it catches DATA
   BEING MISSED, not data being removed on purpose.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

# Every table the app syncs. Keep this in step with the supaUpsert() calls in
# CalendarOS.html — if a new module adds a table, it must be added here too.
# In practice you shouldn't need to catch drift by eye: verify_table_coverage()
# below reads the app's own SYNCED_TABLES at the start of every run and fails
# loudly if this list has fallen behind it.
TABLES = [
    # core
    "one_time_tasks", "recurring_tasks", "task_completions",
    "lists", "list_items", "health_logs", "daily_ratings",
    "health_metric_defs", "app_settings",
    # training
    "training_exercises", "training_sessions", "training_calendar",
    "training_logs", "training_resources",
    # training sets (per-set logging — v4.40.0)
    "training_sets",
    # recipes
    "recipes", "recipe_ingredients",
    # hydration
    "hydration_logs",
]

# Tables that may legitimately not exist yet, because they arrive with a
# migration the person may not have run. A 404 here is reported and recorded
# but does not fail the run; anything else still does.
OPTIONAL_TABLES = {"training_resources"}

PAGE_SIZE = 1000


class BackupError(Exception):
    pass


def find_app_file(explicit_path):
    """Locates CalendarOS.html so its SYNCED_TABLES can be read for the
    coverage check. Tries the explicit --app-file path first, then a couple
    of layouts that are common for this kind of repo (script living in a
    backup_scripts/ subfolder, app file at the repo root). Returns the path
    it found, or None if nothing matched — the caller decides how to react
    to that (see verify_table_coverage)."""
    if explicit_path:
        return explicit_path if os.path.isfile(explicit_path) else None
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "CalendarOS.html"),        # script at repo root
        os.path.join(here, "..", "CalendarOS.html"),   # script in a subfolder (e.g. backup_scripts/)
        os.path.join(os.getcwd(), "CalendarOS.html"),  # CI working directory
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def verify_table_coverage(app_file_arg):
    """Reads `const SYNCED_TABLES = [...]` out of the live CalendarOS.html and
    fails the run if it lists a table this script doesn't back up. This is
    the check that replaces the old day-over-day shrink comparison — it
    catches the failure mode that actually matters for a backup script: rows
    that exist in the app and are silently never being backed up at all,
    because a new module added a table and nobody updated TABLES here.

    Does not fail if this script has EXTRA tables the app no longer lists
    (a table can be intentionally retired from the app before anyone gets
    around to trimming this list — harmless, just prints a note)."""
    app_file = find_app_file(app_file_arg)
    if not app_file:
        print(
            "WARNING: could not find CalendarOS.html to verify table coverage "
            "against (looked next to this script, one directory up, and in the "
            "current working directory). Pass --app-file to point at it "
            "explicitly. Proceeding with the TABLES list as-is, unverified.",
            file=sys.stderr,
        )
        return

    with open(app_file, encoding="utf-8") as f:
        html = f.read()

    m = re.search(r"const\s+SYNCED_TABLES\s*=\s*\[(.*?)\]\s*;", html, re.S)
    if not m:
        raise BackupError(
            f"Could not find `const SYNCED_TABLES = [...]` in {app_file} — "
            "the app's build may have changed shape. Not backing up against "
            "an unverified table list; fix the parsing here or pass a "
            "different --app-file."
        )
    app_tables = re.findall(r"'([a-zA-Z0-9_]+)'", m.group(1))
    if not app_tables:
        raise BackupError(f"SYNCED_TABLES in {app_file} parsed to zero tables — that can't be right.")

    missing = [t for t in app_tables if t not in TABLES]
    extra = [t for t in TABLES if t not in app_tables]

    print(f"Table coverage check against {app_file}: app has {len(app_tables)} synced table(s).")
    if extra:
        print(f"  Note: this script also backs up {extra} — not in the app's current SYNCED_TABLES "
              "(fine if that table was intentionally retired; harmless either way).")

    if missing:
        raise BackupError(
            f"The app syncs {missing} but this script's TABLES list does not include "
            f"{'it' if len(missing) == 1 else 'them'} — {'this table is' if len(missing) == 1 else 'these tables are'} "
            "not being backed up at all. Add it to TABLES above (Settings → Cloud Sync → "
            "Copy Backup Script in the app generates the current list) before running the backup."
        )
    print("  OK — every table the app syncs is covered.")


def fetch_page(base_url, api_key, table, pin, offset, limit):
    url = f"{base_url}/rest/v1/{table}?pin=eq.{pin}&select=*"
    req = urllib.request.Request(url, headers={
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        # Range is how PostgREST paginates. count=exact makes it report the
        # true total in Content-Range so truncation cannot go unnoticed.
        "Range-Unit": "items",
        "Range": f"{offset}-{offset + limit - 1}",
        "Prefer": "count=exact",
    })
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            content_range = resp.headers.get("Content-Range", "")
            return body, content_range
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise BackupError(f"HTTP {e.code} fetching {table}: {detail}") from e
    except urllib.error.URLError as e:
        raise BackupError(f"Network error fetching {table}: {e.reason}") from e


def total_from_content_range(content_range):
    """Content-Range looks like '0-999/2451'. Returns the total, or None."""
    m = re.search(r"/(\d+)$", content_range or "")
    return int(m.group(1)) if m else None


def fetch_table(base_url, api_key, table, pin):
    """Fetches every row, paging until exhausted. Raises on any error."""
    rows = []
    offset = 0
    expected_total = None
    while True:
        page, content_range = fetch_page(base_url, api_key, table, pin, offset, PAGE_SIZE)
        if expected_total is None:
            expected_total = total_from_content_range(content_range)
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        if offset > 500_000:  # runaway guard
            raise BackupError(f"{table}: exceeded 500k rows — aborting as a safety measure")

    # If the server told us the true total, insist we actually got it all.
    if expected_total is not None and len(rows) != expected_total:
        raise BackupError(
            f"{table}: fetched {len(rows)} rows but server reports {expected_total} — "
            "refusing to write a truncated backup"
        )
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--app-file",
        help="Path to CalendarOS.html, used only to verify table coverage. "
             "Auto-detected next to this script, one directory up, or in the "
             "current working directory if not given.",
    )
    parser.add_argument(
        "--skip-coverage-check", action="store_true",
        help="Skip the SYNCED_TABLES coverage check entirely (e.g. if CalendarOS.html "
             "genuinely isn't available in this run's environment).",
    )
    args = parser.parse_args()

    base_url = os.environ.get("CALENDAROS_SUPABASE_URL", "").rstrip("/")
    api_key = os.environ.get("CALENDAROS_SUPABASE_ANON_KEY", "")
    pin = os.environ.get("CALENDAROS_PIN", "")
    if not base_url or not api_key or not pin:
        print("ERROR: CALENDAROS_SUPABASE_URL, CALENDAROS_SUPABASE_ANON_KEY, "
              "and CALENDAROS_PIN must all be set", file=sys.stderr)
        sys.exit(1)

    if not args.skip_coverage_check:
        try:
            verify_table_coverage(args.app_file)
        except BackupError as e:
            print(f"\nERROR: {e}", file=sys.stderr)
            print("Aborting without writing a file, rather than committing a backup "
                  "that is missing a table.", file=sys.stderr)
            sys.exit(1)
        print()

    print(f"Backing up CalendarOS from {base_url} (pin {pin}) ...")
    backup = {}
    missing_optional = []
    for table in TABLES:
        try:
            rows = fetch_table(base_url, api_key, table, pin)
        except BackupError as e:
            if table in OPTIONAL_TABLES and "HTTP 404" in str(e):
                print(f"  {table}: not present yet (migration not run) — skipping")
                missing_optional.append(table)
                continue
            # Everything else is fatal. A backup with a silently empty table is
            # worse than no backup, because it looks fine.
            print(f"\nERROR: {e}", file=sys.stderr)
            print("Aborting without writing a file, rather than committing an "
                  "incomplete backup.", file=sys.stderr)
            sys.exit(1)
        backup[table] = rows
        print(f"  {table}: {len(rows)} row(s)")

    # Core-table sanity check: a wrong PIN or a broken connection can return
    # 200 OK with nothing in it, which looks superficially like a valid but
    # empty account rather than an error. Different failure mode from table
    # coverage above — this one guards against backing up from a dead/wrong
    # source, not against forgetting to list a table.
    if len(backup.get("one_time_tasks", [])) == 0 and len(backup.get("recurring_tasks", [])) == 0:
        print("\nERROR: both one_time_tasks and recurring_tasks came back empty — "
              "this looks suspicious for an established install. Failing rather "
              "than writing a hollow backup.", file=sys.stderr)
        sys.exit(2)

    out_dir = os.path.dirname(args.out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(backup, f, indent=2, ensure_ascii=False, default=str)

    total = sum(len(v) for v in backup.values())
    print(f"\nWrote {args.out} — {len(backup)} tables, {total} rows total")
    if missing_optional:
        print(f"Note: skipped (not yet migrated): {', '.join(missing_optional)}")


if __name__ == "__main__":
    main()
