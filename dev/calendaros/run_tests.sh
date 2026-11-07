#!/usr/bin/env bash
# Runs the CalendarOS regression suite (Node + jsdom, no browser needed).
# Usage:  bash dev/calendaros/run_tests.sh [path/to/CalendarOS.html]   (default: the repo's CalendarOS.html)
#
# Prints every FAIL line (marked [known] or [NEW]), then the summary line "N passed, M failed".
# Exit code: 0 when every failure is in baseline_failures.txt (the known stale assertions),
#            1 when there is any NEW failure, 2 when a suite crashed or the build step failed.
set -uo pipefail
DEV="$(cd "$(dirname "$0")" && pwd)"
APP="$(readlink -f "${1:-$DEV/../../CalendarOS.html}")"
BUILD="$DEV/.build"
[ -f "$APP" ] || { echo "CalendarOS.html not found at $APP"; exit 2; }

# 1. Fresh build folder: split the built HTML into app.js + index.html (what the harness loads),
#    and copy in the harness, the suites and the two Python tools that test_v440 reads.
rm -rf "$BUILD"; mkdir -p "$BUILD/out"
cp "$APP" "$BUILD/CalendarOS.html"
python3 "$DEV/tools/split_calendaros.py" "$BUILD/CalendarOS.html" "$BUILD" >/dev/null || { echo "split failed"; exit 2; }
cp "$DEV/harness.js" "$DEV"/tests/test_*.js "$DEV/tools/backup_calendaros.py" "$DEV/tools/restore_table.py" "$BUILD/"
node --check "$BUILD/app.js" || { echo "app.js does not parse"; exit 2; }

# 2. Install jsdom once (node resolves $DEV/node_modules from $BUILD).
if [ ! -d "$DEV/node_modules/jsdom" ]; then
  (cd "$DEV" && npm install --silent --no-audit --no-fund) || { echo "npm install failed"; exit 2; }
fi

# 3. Run every suite from inside the build folder (some suites read ./CalendarOS.html relative to cwd).
#    Console noise ("Not implemented: ...") is expected; only FAIL lines and summaries matter.
pass=0; fail=0; crashed=0; : > "$BUILD/fails.txt"
for f in "$DEV"/tests/test_*.js; do
  s="$(basename "$f" .js)"
  (cd "$BUILD" && timeout 180 node "$s.js" >"$BUILD/out/$s.txt" 2>&1)
  sum="$(grep -oE '[0-9]+ passed, [0-9]+ failed' "$BUILD/out/$s.txt" | tail -1)"
  if [ -z "$sum" ]; then
    echo "CRASH $s (no summary line). Last lines:"; tail -5 "$BUILD/out/$s.txt" | sed 's/^/    /'
    crashed=$((crashed+1)); continue
  fi
  p="${sum%% passed*}"; m="${sum#*, }"; m="${m%% failed*}"
  pass=$((pass+p)); fail=$((fail+m))
  grep -E '^\s*FAIL' "$BUILD/out/$s.txt" | sed -E 's/^\s+//; s/\s+$//' | sed "s#^#$s: #" >> "$BUILD/fails.txt"
done

# 4. Compare against the baseline of known stale failures. A baseline line matches exactly,
#    or by prefix when it ends in " *" (for FAIL lines that print a value which varies by date).
read -r new fixed < <(python3 -I - "$DEV/baseline_failures.txt" "$BUILD/fails.txt" <<'PY'
import sys
base = [l.rstrip() for l in open(sys.argv[1], encoding='utf-8') if l.strip() and not l.lstrip().startswith('#')]
fails = [l.rstrip('\n') for l in open(sys.argv[2], encoding='utf-8') if l.strip()]
def hit(b, f): return f.startswith(b[:-2]) if b.endswith(' *') else f == b
new = 0
for f in fails:
    known = any(hit(b, f) for b in base)
    new += not known
    print(('[known] ' if known else '[NEW]   ') + f, file=sys.stderr)
unused = sum(1 for b in base if not any(hit(b, f) for f in fails))
print(new, unused)
PY
)
fixed="${fixed:-0}"; new="${new:-0}"
known=$((fail-new))
echo
echo "Known stale failures: $known (baseline_failures.txt). NEW failures: $new. Crashed suites: $crashed."
[ "$fixed" -gt 0 ] && echo "Note: $fixed baseline line(s) did not fail this run (date-sensitive, or fixed: if fixed, remove them from the baseline)."
echo "$pass passed, $fail failed"
[ "$crashed" -gt 0 ] && exit 2
[ "$new" -gt 0 ] && exit 1
exit 0
