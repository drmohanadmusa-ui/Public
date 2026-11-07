/* Optional real-browser smoke test (Chromium via Playwright). Not part of run_tests.sh.
   Usage:  node dev/calendaros/smoke_browser.js [path/to/CalendarOS.html]
   Opens the app at phone size (390x844) from a file:// URL with no sync configured, removes the
   unlock gate, renders the dashboard, and checks there are no uncaught page errors.
   Saves dev/calendaros/.build/smoke_390x844.png for a visual check (gitignored; never send it to anyone).
   Uses the Playwright that is pre-installed on Claude Code cloud machines. If Playwright is missing
   it prints SKIP and exits 0: the jsdom suite (run_tests.sh) is the required gate, this is extra. */
const path = require('path');
const fs = require('fs');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.log('SKIP smoke_browser: Playwright is not installed on this machine (the jsdom suite is still the gate).'); process.exit(0); }

const DEV = __dirname;
const APP = path.resolve(process.argv[2] || path.join(DEV, '..', '..', 'CalendarOS.html'));
const OUT = path.join(DEV, '.build');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    try { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }
    catch (e2) { console.log('SKIP smoke_browser: Chromium could not start:', String(e2.message).split('\n')[0]); process.exit(0); }
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  // Block every network request: the smoke test must never reach a real server or font host.
  await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.goto('file://' + APP);
  await page.waitForTimeout(1200);
  const info = await page.evaluate(() => {
    const gate = document.getElementById('gateScreen'); if (gate) gate.remove();
    const app = document.getElementById('app'); if (app) app.classList.remove('hidden');
    try { if (typeof render === 'function') render(); } catch (e) { return { renderError: String(e) }; }
    return {
      version: typeof APP_VERSION !== 'undefined' ? APP_VERSION : null,
      top: typeof CHANGELOG !== 'undefined' && CHANGELOG[0] ? CHANGELOG[0].v : null,
      mainLen: (document.getElementById('mainContent') || {}).innerHTML?.length || 0,
      foreignKeysTouched: Object.keys(localStorage).filter(k => !k.startsWith('cos_')),
    };
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'smoke_390x844.png') });
  await browser.close();

  let pass = 0, fail = 0;
  const check = (n, c, d) => { if (c) pass++; else { fail++; console.log(`  FAIL ${n}${d !== undefined ? ' — ' + d : ''}`); } };
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('render() ran without throwing', !info.renderError, info.renderError);
  check('APP_VERSION matches newest CHANGELOG entry', info.version && info.version === info.top, `${info.version} vs ${info.top}`);
  check('main content rendered', info.mainLen > 200, info.mainLen);
  check('only cos_ keys written to localStorage', (info.foreignKeysTouched || []).length === 0, (info.foreignKeysTouched || []).join(','));
  console.log(`smoke_browser (v${info.version}, screenshot .build/smoke_390x844.png): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL smoke_browser crashed:', e && e.message); console.log('smoke_browser: 0 passed, 1 failed'); process.exit(1); });
