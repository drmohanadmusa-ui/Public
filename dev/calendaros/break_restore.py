#!/usr/bin/env python3
"""Break-then-restore check: proves the new tests actually guard the new code.

Usage: python3 dev/calendaros/break_restore.py breaks.json [path/to/CalendarOS.html]
  breaks.json = [{"name": "what this break simulates",
                  "good": "exact snippet currently in CalendarOS.html (must occur exactly once)",
                  "bad":  "the broken replacement"}, ...]

For each break: write a broken COPY of the app to a temp folder and run the suite against it.
"Red" means run_tests.sh exits non-zero, i.e. at least one NEW failure beyond the known
stale baseline (or a crash). Every break must go red. Finally the untouched app must be green.
CalendarOS.html itself is never modified. Keep breaks.json outside the repo (it is throwaway).
Exit code 0 only if every break went red and the untouched run is green.
"""
import json, os, subprocess, sys, tempfile

DEV = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(DEV, '..', '..', 'CalendarOS.html'))
RUN = os.path.join(DEV, 'run_tests.sh')


def run(path):
    r = subprocess.run(['bash', RUN, path], capture_output=True, text=True)
    lines = (r.stdout + r.stderr).strip().splitlines()
    done = [l for l in lines if ' passed, ' in l and l.endswith(' failed')]
    summary = done[-1] if done else 'SUITE CRASHED (counts as red)'
    new = [l for l in lines if l.startswith('[NEW]') or l.startswith('CRASH')]
    return r.returncode, summary, new


breaks = json.load(open(sys.argv[1], encoding='utf-8'))
good = open(APP, encoding='utf-8').read()
ok = True
with tempfile.TemporaryDirectory() as tmp:
    broken_path = os.path.join(tmp, 'CalendarOS.html')
    for b in breaks:
        n = good.count(b['good'])
        if n != 1:
            print(f"SKIP {b['name']}: snippet found {n} times (must be exactly 1)")
            ok = False
            continue
        open(broken_path, 'w', encoding='utf-8').write(good.replace(b['good'], b['bad']))
        code, summary, new = run(broken_path)
        red = code != 0
        ok &= red
        print(f"BREAK {b['name']} -> {'RED (good)' if red else 'STILL GREEN (bad: no test caught it)'} | {summary}"
              + (f" | {new[0][:140]}" if new else ''))
code, summary, _ = run(APP)
print('RESTORED ->', summary, '(exit', str(code) + ')')
ok &= code == 0
assert open(APP, encoding='utf-8').read() == good, 'CalendarOS.html changed during the run'
sys.exit(0 if ok else 1)
