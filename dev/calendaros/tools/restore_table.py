#!/usr/bin/env python3
"""
CalendarOS targeted restore.

Restores ONE table from a backup file produced by backup_calendaros.py, without
touching anything else. Built for the case where a single table lost rows and
you want them back without replaying an entire backup over live data.

Two deliberate safety properties:

  1. DRY RUN BY DEFAULT. It shows exactly what it would write and changes
     nothing unless you pass --apply. Restores are the kind of operation you
     only get one clean attempt at, so the safe mode is the one you get for
     free.

  2. IT ONLY EVER ADDS OR UPDATES. Rows are upserted on the table's real
     primary key. Nothing is deleted, and rows that exist now but are absent
     from the backup are left alone. A restore cannot itself cause data loss,
     which matters when you are already recovering from some.

Usage:
    # See what would happen (safe, writes nothing):
    python3 restore_table.py --file backups/calendaros/2026-08-29.json \\
                             --table training_logs

    # Actually write it:
    python3 restore_table.py --file backups/calendaros/2026-08-29.json \\
                             --table training_logs --apply

Requires the same env vars as the backup script:
    CALENDAROS_SUPABASE_URL
    CALENDAROS_SUPABASE_ANON_KEY
    CALENDAROS_PIN
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# Primary keys, so the upsert updates in place rather than erroring or
# duplicating. These mirror the CREATE TABLE statements in the app's SQL.
CONFLICT_KEYS = {
    # Read off the app's own CREATE TABLE statements, not assumed. Several of
    # these are NOT (pin, id) — getting one wrong would either error or insert
    # a duplicate instead of updating in place.
    "one_time_tasks": "id",
    "recurring_tasks": "id",
    "task_completions": "pin,task_id,completed_date",
    "lists": "id",
    "list_items": "id",
    "health_logs": "pin,log_date",
    "daily_ratings": "pin,rating_date",
    "health_metric_defs": "pin,id",
    "app_settings": "pin",
    "training_exercises": "pin,id",
    "training_sessions": "pin,id",
    "training_calendar": "pin,cal_date",
    "training_logs": "pin,log_date,exercise_id",
    "training_resources": "pin,id",
    "recipes": "pin,id",
    "recipe_ingredients": "pin,id",
    "hydration_logs": "pin,id",
    "training_sets": "pin,log_date,exercise_id,set_no",
}


def fetch_all(url_base):
    """Reads every row, in pages.

    PostgREST caps rows per response and truncates SILENTLY. A single
    Range: 0-99999 request looks like it asks for everything but will just
    return the first page on a capped project, which would make the
    add/update counts in the report wrong. (The upsert itself would still be
    safe — it never deletes — but a report you cannot trust defeats the point
    of a dry run.)"""
    rows = []
    offset = 0
    page_size = 1000
    while True:
        page = req(url_base, extra_headers={
            "Range-Unit": "items",
            "Range": f"{offset}-{offset + page_size - 1}",
        })
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
        if offset > 500_000:
            raise SystemExit("ERROR: runaway paging — aborting")
    return rows


def req(url, method="GET", body=None, extra_headers=None):
    key = os.environ["CALENDAROS_SUPABASE_ANON_KEY"]
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else []
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"ERROR: HTTP {e.code} on {method} {url}\n{detail}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True, help="Backup JSON to restore from")
    ap.add_argument("--table", required=True, help="Single table to restore")
    ap.add_argument("--apply", action="store_true",
                    help="Actually write. Without this, nothing is changed.")
    args = ap.parse_args()

    base = os.environ.get("CALENDAROS_SUPABASE_URL", "").rstrip("/")
    pin = os.environ.get("CALENDAROS_PIN", "")
    if not base or not pin or not os.environ.get("CALENDAROS_SUPABASE_ANON_KEY"):
        raise SystemExit("ERROR: set CALENDAROS_SUPABASE_URL, "
                         "CALENDAROS_SUPABASE_ANON_KEY and CALENDAROS_PIN")

    if args.table not in CONFLICT_KEYS:
        raise SystemExit(f"ERROR: unknown table '{args.table}'. "
                         f"Known: {', '.join(sorted(CONFLICT_KEYS))}")

    with open(args.file, encoding="utf-8") as f:
        backup = json.load(f)
    if args.table not in backup:
        raise SystemExit(f"ERROR: '{args.table}' is not in {args.file}. "
                         f"That backup contains: {', '.join(backup.keys())}")

    rows = [r for r in backup[args.table] if str(r.get("pin")) == str(pin)]
    if not rows:
        raise SystemExit(f"Nothing to restore: no {args.table} rows for pin {pin} in that file.")

    # What is live right now, so the report is about the actual difference.
    live = fetch_all(f"{base}/rest/v1/{args.table}?pin=eq.{pin}&select=*")

    keys = CONFLICT_KEYS[args.table].split(",")
    def ident(r):
        return tuple(str(r.get(k)) for k in keys)

    live_ids = {ident(r) for r in live}
    to_add = [r for r in rows if ident(r) not in live_ids]
    to_update = [r for r in rows if ident(r) in live_ids]

    print(f"Table            : {args.table}")
    print(f"Backup file      : {args.file}")
    print(f"Rows in backup   : {len(rows)}")
    print(f"Rows live now    : {len(live)}")
    print(f"Would ADD        : {len(to_add)}")
    print(f"Would UPDATE     : {len(to_update)}")
    print(f"Left untouched   : {len([r for r in live if ident(r) not in {ident(x) for x in rows}])} "
          f"(live rows not present in the backup are never deleted)")
    print()

    if to_add:
        print("Rows that would be ADDED back:")
        for r in to_add:
            shown = {k: v for k, v in r.items() if k != "pin"}
            print("  " + json.dumps(shown, ensure_ascii=False, default=str)[:200])
        print()

    if not args.apply:
        print("DRY RUN — nothing was written.")
        print("Re-run with --apply to perform the restore.")
        return

    url = f"{base}/rest/v1/{args.table}?on_conflict={CONFLICT_KEYS[args.table]}"
    req(url, method="POST", body=rows,
        extra_headers={"Prefer": "resolution=merge-duplicates,return=minimal"})
    print(f"Restored {len(rows)} row(s) into {args.table}.")

    after = fetch_all(f"{base}/rest/v1/{args.table}?pin=eq.{pin}&select=*")
    print(f"Verified: {args.table} now has {len(after)} row(s) (was {len(live)}).")
    missing = [r for r in rows if ident(r) not in {ident(x) for x in after}]
    if missing:
        raise SystemExit(f"WARNING: {len(missing)} row(s) still missing after the write — "
                         "check the table's constraints before retrying.")
    print("All restored rows confirmed present.")


if __name__ == "__main__":
    main()
