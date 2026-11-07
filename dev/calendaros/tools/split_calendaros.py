#!/usr/bin/env python3
"""Split a built CalendarOS.html back into the two source files the test harness needs.

  usage: python3 split_calendaros.py CalendarOS.html OUT_DIR

Writes OUT_DIR/app.js (the whole inline app script) and OUT_DIR/index.html
(the page with the literal placeholder __APP_JS__ where the script was).
This is the exact inverse of build.sh (index.html with __APP_JS__ replaced by app.js),
so rebuilding from the two files gives back a byte-identical CalendarOS.html.
The app script is the LAST plain <script> ... </script> in the page.
"""
import sys, os
src, out = sys.argv[1], sys.argv[2]
html = open(src, encoding='utf-8').read()
start = html.rindex('<script>') + len('<script>')
end = html.rindex('</script>')
os.makedirs(out, exist_ok=True)
open(os.path.join(out, 'app.js'), 'w', encoding='utf-8').write(html[start:end])
open(os.path.join(out, 'index.html'), 'w', encoding='utf-8').write(html[:start] + '__APP_JS__' + html[end:])
print('wrote app.js and index.html to', out)
