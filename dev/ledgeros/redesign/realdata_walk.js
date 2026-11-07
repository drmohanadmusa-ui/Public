// Runs a LedgerOS HTML file headless against the REAL Supabase data, READ-ONLY, and screenshots
// every page. Used for the old-vs-new comparison before shipping the v5 redesign.
//
// Safety:
//   - Every request to Supabase that is not GET/HEAD/OPTIONS is aborted, so nothing can be written.
//   - The anon key is never in this file or the repo. In a Claude Code cloud session it is injected
//     by the network proxy (saved once via the secure credential form, header "apikey").
//   - Screenshots and any output contain real figures: write them to the session scratchpad only,
//     NEVER into the repo.
//
// Usage (outside the repo for output):
//   SB_URL=https://<project>.supabase.co node dev/ledgeros/redesign/realdata_walk.js <path/to/LedgerOS.html> <outDir>
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const [htmlPath, outDir] = process.argv.slice(2);
const SB_URL = process.env.SB_URL;
if (!htmlPath || !outDir || !SB_URL) { console.error('usage: SB_URL=... node realdata_walk.js <html> <outDir>'); process.exit(1); }
if (path.resolve(outDir).startsWith(path.resolve(__dirname, '..', '..', '..'))) { console.error('Refusing to write real-data output inside the repo.'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(htmlPath)); }).listen(8765);
(async () => {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
  const b = await chromium.launch(proxy ? { proxy } : {});
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  let blocked = 0, reads = 0;
  await ctx.route('**/*.supabase.co/**', async (route) => {
    const req = route.request();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) { blocked++; return route.abort(); }
    reads++; const h = { ...req.headers() }; delete h['authorization']; h['apikey'] = 'proxy-injected';
    return route.continue({ headers: h });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERR', e.message.slice(0, 200)));
  await page.goto('http://127.0.0.1:8765/');
  await page.evaluate((u) => { localStorage.setItem('sb_url', u); localStorage.setItem('sb_key', 'proxy-injected'); }, SB_URL);
  await page.reload();
  await page.waitForFunction(() => { const s = document.getElementById('splashScreen'); return s && (getComputedStyle(s).display === 'none' || getComputedStyle(s).opacity === '0'); }, null, { timeout: 180000 }).catch(e => console.log('splash wait', e.message.slice(0, 100)));
  await page.waitForTimeout(3000);
  console.log('ledger rows in app:', await page.evaluate(() => D.ledger.length).catch(() => 'n/a'));
  const screens = ['dashboard', 'newjv', 'ledger', 'accounts', 'budget', 'pnl', 'alloc', 'provisions', 'jamiah', 'forecast', 'realestate', 'investments', 'settings'];
  for (const s of screens) {
    await page.evaluate((x) => go(x), s).catch(e => console.log('go err', s, e.message.slice(0, 100)));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(outDir, s + '.png'), fullPage: true });
    // Every number visible on the page, in order, for the old-vs-new diff.
    const nums = await page.evaluate(() => (document.getElementById('app').innerText.match(/-?−?[\d,]+\.\d{2}|-?−?\d{1,3}(?:,\d{3})+/g) || []));
    fs.writeFileSync(path.join(outDir, s + '.numbers.json'), JSON.stringify(nums));
  }
  console.log('reads', reads, 'blocked writes', blocked);
  await b.close(); srv.close();
})();
