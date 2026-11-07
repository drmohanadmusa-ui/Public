#!/usr/bin/env bash
# Runs the LedgerOS regression suite.
# Usage:  bash dev/run_tests.sh [path/to/LedgerOS.html]     (default: the repo's LedgerOS.html)
# Prints any FAIL lines, then the summary line "N passed, M failed". Exit code is non-zero on any failure.
set -euo pipefail
DEV="$(cd "$(dirname "$0")" && pwd)"
APP="$(readlink -f "${1:-$DEV/../LedgerOS.html}")"
BUILD="$DEV/.build"
mkdir -p "$BUILD"

# 1. Pull the app's inline JS out of the HTML (minus the boot() call) so the tests can load it.
python3 "$DEV/extract.py" "$APP" "$BUILD/extracted_noboot.js"
node --check "$BUILD/extracted_noboot.js"

# 2. Install jsdom + fake-indexeddb once.
if [ ! -d "$DEV/node_modules/jsdom" ] || [ ! -d "$DEV/node_modules/fake-indexeddb" ]; then
  (cd "$DEV" && npm install --silent --no-audit --no-fund)
fi

# 3. Run. Console noise on stderr (QuotaExceededError, "Not implemented: scrollTo") is expected;
#    only FAIL lines and the final summary matter.
set +e
(cd "$DEV" && LEDGEROS_HTML="$APP" LEDGEROS_JS="$BUILD/extracted_noboot.js" \
  node test_batch_fixes.js >"$BUILD/stdout.txt" 2>"$BUILD/stderr.txt")
code=$?
set -e
grep '^FAIL' "$BUILD/stderr.txt" | head -40 || true
summary="$(grep -E '[0-9]+ passed, [0-9]+ failed' "$BUILD/stdout.txt" | tail -1 || true)"
if [ -z "$summary" ]; then
  echo "SUITE CRASHED (no summary line). Last stderr lines:"; tail -20 "$BUILD/stderr.txt"
  exit 2
fi
echo "$summary"
exit $code
