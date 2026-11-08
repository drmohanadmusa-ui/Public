// Screenshots a LedgerOS HTML file loaded with INVENTED demo data (no network, no Supabase).
// Used to look at the v5 redesign page by page. Every name and number here is made up.
//
// Usage: node dev/ledgeros/redesign/demo_walk.js <path/to/LedgerOS.html> <outDir> [width] [screens,comma,separated] [dark]
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const [htmlPath, outDir, widthArg, screensArg, darkArg] = process.argv.slice(2);
if (!htmlPath || !outDir) { console.error('usage: node demo_walk.js <html> <outDir> [width] [screens] [dark]'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const width = Number(widthArg) || 1440;
const screens = screensArg ? screensArg.split(',') : ['dashboard', 'newjv', 'ledger', 'accounts', 'budget', 'pnl', 'alloc', 'provisions', 'jamiah', 'forecast', 'realestate', 'investments', 'settings'];

function demoData() {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date(); const months = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(d.getFullYear() + '-' + pad(d.getMonth() + 1)); }
  const A = (id, descr, category, extra) => ({ id, descr, name: descr, category, status: 'Active', acc_type: 'Individual Account', direction: 'Debit', ...(extra || {}) });
  const accounts = [
    A(10101, 'Main Current', 'Bank Accounts', { stmt_balance: 48250, stmt_date: months[5] + '-05' }),
    A(10102, 'Family Savings', 'Bank Accounts', { is_savings: true, stmt_balance: 126400, stmt_date: months[4] + '-12' }),
    A(10103, 'Joint Account', 'Bank Accounts', { stmt_balance: 18705.5, stmt_date: months[5] + '-06' }),
    A(10105, 'Rewards Card', 'Bank Accounts', { is_credit_card: true, credit_limit: 20000, stmt_available: 16587.2, stmt_date: months[5] + '-04' }),
    A(11201, 'Loan to a friend', 'Short Term Receivables'), A(14101, 'Kitchen project', 'Temporary Projects Accounts'),
    A(21511, 'Card payable', 'Short Term Liabilities'), A(22901, 'School fees accrued', 'Accruals'), A(23101, 'Car service provision', 'Provisions'),
    A(30101, 'Salary', 'Salary'), A(30201, 'Rent received', 'Other Income'),
    A(60101, 'Groceries', 'Living'), A(60102, 'Dining out', 'Living'), A(60201, 'School fees', 'Children'), A(60301, 'Utilities', 'Home'), A(60401, 'Fuel', 'Transport')
  ];
  const ledger = []; let id = 1, jv = 1000;
  const post = (date, lines) => { jv++; lines.forEach(([acc, descr, amt]) => ledger.push({ id: id++, jv, date, acc, descr, amt, alloc: null, allocatable: false })); };
  post(months[0] + '-01', [[10101, 'Opening balance', 40000], [10102, 'Opening balance', 120000], [10103, 'Opening balance', 15000], [11201, 'Loan', 6500], [14101, 'Deposit', 2300], [21511, 'Card', -8900], [22901, 'Accrued', -4150], [23101, 'Provision', -11600], [10105, 'Card', -3000], [30201, 'Balancing', -158150]]);
  months.forEach((m, i) => {
    post(m + '-02', [[10101, 'Salary ' + m, 32500], [30101, 'Salary ' + m, -32500]]);
    post(m + '-05', [[60101, 'Groceries', 2600 + i * 60], [60102, 'Dining out', 900 + i * 80], [60301, 'Utilities', 960], [60401, 'Fuel', 1050 + i * 20], [10101, 'Monthly spend', -(2600 + i * 60 + 900 + i * 80 + 960 + 1050 + i * 20)]]);
    post(m + '-10', [[60201, 'School fees', 4200], [10103, 'School fees', -4200]]);
    post(m + '-15', [[10103, 'Transfer', 5000], [10101, 'Transfer', -5000]]);
  });
  const budget = []; let bid = 1;
  months.forEach((m) => [[60101, 3500], [60102, 1000], [60201, 4200], [60301, 1200], [60401, 1500], [30101, -32500]].forEach(([acc, amt]) => budget.push({ id: bid++, date: m + '-01', acc, descr: 'Plan', amt })));
  const categories = [{ digit: 1, name: 'Assets' }, { digit: 2, name: 'Liabilities' }, { digit: 3, name: 'Income' }, { digit: 6, name: 'Expenses' }];
  return { accounts, ledger, budget, categories };
}

const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(htmlPath)); }).listen(8766);
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort()); // offline: fonts and Chart.js fall back
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERR', e.message.slice(0, 200)));
  await page.goto('http://127.0.0.1:8766/');
  await page.waitForTimeout(800);
  await page.evaluate(([data, dark]) => {
    Object.assign(D, data); normalizeDataShape(D); rebuildIndex();
    if (dark) applyTheme('dark');
  }, [demoData(), darkArg === 'dark']);
  for (const s of screens) {
    await page.evaluate((x) => go(x), s).catch((e) => console.log('go err', s, e.message.slice(0, 160)));
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, s + '-' + width + (darkArg === 'dark' ? '-dark' : '') + '.png'), fullPage: true });
  }
  await b.close(); srv.close();
})();
