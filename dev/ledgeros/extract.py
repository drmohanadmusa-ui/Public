# Pulls every inline <script> out of LedgerOS.html into one JS file, minus the trailing boot()
# call, so the test harness can load the app's code without starting the app.
# Usage: python3 dev/ledgeros/extract.py <LedgerOS.html> <out.js>
import re, sys
src, dst = sys.argv[1], sys.argv[2]
html = open(src, encoding='utf-8').read()
scripts = [s for s in re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', html, re.DOTALL) if 'src=' not in s and s.strip()]
open(dst, 'w', encoding='utf-8').write(re.sub(r'\nboot\(\);\s*$', '', '\n;\n'.join(scripts)))
