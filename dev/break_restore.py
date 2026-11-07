# Break-then-restore check: proves the new tests actually guard the new code.
#
# Usage: python3 dev/break_restore.py breaks.json
#   breaks.json = [{"name": "what this break simulates",
#                   "good": "exact snippet currently in LedgerOS.html (must occur exactly once)",
#                   "bad":  "the broken replacement"}, ...]
#
# For each break: copy the app, apply the break, run the suite. Every break must turn the suite RED.
# The original file is always restored at the end, and the restored suite must be GREEN.
# Exit code 0 only if every break went red and the restore is green.
# Keep breaks.json outside the repo (e.g. /tmp) — it is a throwaway file.
import json, os, shutil, subprocess, sys

DEV = os.path.dirname(os.path.abspath(__file__))
APP = os.path.abspath(os.path.join(DEV, '..', 'LedgerOS.html'))
RUN = os.path.join(DEV, 'run_tests.sh')

def run():
    r = subprocess.run(['bash', RUN, APP], capture_output=True, text=True)
    lines = r.stdout.strip().splitlines()
    done = [l for l in lines if ' passed, ' in l and ' failed' in l]
    summary = done[-1] if done else 'SUITE CRASHED (a test threw; counts as red)'
    fails = [l for l in lines if l.startswith('FAIL')]
    return r.returncode, summary, fails

breaks = json.load(open(sys.argv[1], encoding='utf-8'))
good = open(APP, encoding='utf-8').read()
backup = APP + '.good'
shutil.copy(APP, backup)
ok = True
try:
    for b in breaks:
        n = good.count(b['good'])
        if n != 1:
            print(f"SKIP {b['name']}: snippet found {n} times (must be exactly 1)"); ok = False; continue
        open(APP, 'w', encoding='utf-8').write(good.replace(b['good'], b['bad']))
        code, summary, fails = run()
        red = code != 0
        ok &= red
        print(f"BREAK {b['name']} -> {'RED (good)' if red else 'STILL GREEN (bad: no test caught it)'} | {summary}"
              + (f" | {fails[0][:140]}" if fails else ''))
finally:
    shutil.copy(backup, APP); os.remove(backup)
code, summary, _ = run()
print('RESTORED ->', summary)
ok &= code == 0
assert open(APP, encoding='utf-8').read() == good, 'restore mismatch'
sys.exit(0 if ok else 1)
