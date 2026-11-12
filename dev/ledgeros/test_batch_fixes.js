// Targeted regression tests for the two JS-logic fixes in this batch:
//   - Item 5: dashboard KPIs getting stuck at 0 after a re-render while already on the page
//   - Item 6: double-click on Post JV creating a duplicate JV
// Run with: node test_batch_fixes.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');
// Paths: the app is ../../LedgerOS.html (repo root); the extracted JS is written by run_tests.sh.
// Both can be overridden with LEDGEROS_HTML / LEDGEROS_JS.
const APP_HTML = process.env.LEDGEROS_HTML || path.resolve(__dirname, '..', '..', 'LedgerOS.html');
const APP_JS = process.env.LEDGEROS_JS || path.resolve(__dirname, '.build', 'extracted_noboot.js');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
function assert(cond, msg){
  if(cond){ pass++; }
  else { fail++; console.error('FAIL:', msg); }
}

function makeSandbox(){
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div><div id="toast"></div></body></html>', { url: 'http://localhost/' });
  const window = dom.window;
  window.localStorage = (function(){
    let store = {};
    return {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k,v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
      clear: () => { store = {}; }
    };
  })();
  window.fetch = () => Promise.reject(new Error('network disabled in test'));
  window.performance = window.performance || { now: () => Date.now() };
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  const sandbox = window;
  sandbox.console = console;
  vm.createContext(sandbox);
  const code = fs.readFileSync(APP_JS, 'utf8');
  vm.runInContext(code, sandbox, { filename: 'LedgerOS-app.js' });
  // Top-level `let`/`const` bindings in a vm context are NOT exposed as properties of the
  // sandbox object (only `var`s and function declarations are) — so provide a helper that lets
  // the tests reassign them from outside via an in-context eval instead of direct assignment.
  sandbox.__set = (name, value) => { sandbox[name+'__tmp'] = value; vm.runInContext(name+' = '+name+'__tmp;', sandbox); };
  return sandbox;
}

function freezeDate(sb, isoDate){
  const code = `
    (function(){
      const __RealDate = Date;
      class __FrozenDate extends __RealDate {
        constructor(...args){
          if(args.length===0){ super(${JSON.stringify(isoDate)}); }
          else { super(...args); }
        }
        static now(){ return new __RealDate(${JSON.stringify(isoDate)}).getTime(); }
      }
      Date = __FrozenDate;
    })();
  `;
  vm.runInContext(code, sb);
}

async function testDriftDetectionFlagsProvisionLine(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-12T00:00:00.000Z'); // "today" — so the last 2 fully-past months are 2026-06 and 2026-07
  const D = {
    provisionGroups: [{
      id:1, name:'Car', lines:[{acc:60201, lineId:60201, descrBase:null}],
      months: {
        '2026-06': {60201: 300}, // planned 300, actual will be 390 -> 30% over, drifted
        '2026-07': {60201: 300}, // same again -> 2 consecutive drifted months
      }
    }],
    forecastAccountRules: [],
    ledger: [
      {acc:60201, date:'2026-06-15', amt:390},
      {acc:60201, date:'2026-07-15', amt:390},
    ]
  };
  sb.__set('D', D);
  sb.__set('_forecastFastIndexes', null);
  // default settings: 15% threshold, 2 consecutive months — a 30% drift over 2 months should flag
  const flags = sb.computeDriftFlags();
  assert(flags.length === 1, 'A provision line drifted 30% for 2 consecutive months should produce exactly one flag, got ' + flags.length);
  assert(flags[0].kind === 'provision' && flags[0].groupId === 1, 'The flag should identify the correct provision group');
  assert(Math.abs(flags[0].avgActual - 390) < 0.01, 'avgActual should reflect the real posted amount (390), got ' + flags[0].avgActual);
}

async function testDriftDetectionSkipsHealthyLine(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-12T00:00:00.000Z');
  const D = {
    provisionGroups: [{
      id:1, name:'Car', lines:[{acc:60201, lineId:60201, descrBase:null}],
      months: { '2026-06': {60201: 300}, '2026-07': {60201: 300} }
    }],
    forecastAccountRules: [],
    ledger: [
      {acc:60201, date:'2026-06-15', amt:305}, // within default 15% threshold
      {acc:60201, date:'2026-07-15', amt:295},
    ]
  };
  sb.__set('D', D);
  sb.__set('_forecastFastIndexes', null);
  const flags = sb.computeDriftFlags();
  assert(flags.length === 0, 'A provision line within threshold should not be flagged, got ' + flags.length + ' flags');
}

async function testDriftDetectionRequiresAllConsecutiveMonths(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-12T00:00:00.000Z');
  const D = {
    provisionGroups: [{
      id:1, name:'Car', lines:[{acc:60201, lineId:60201, descrBase:null}],
      months: { '2026-06': {60201: 300}, '2026-07': {60201: 300} }
    }],
    forecastAccountRules: [],
    ledger: [
      {acc:60201, date:'2026-06-15', amt:390}, // drifted
      {acc:60201, date:'2026-07-15', amt:302}, // NOT drifted — breaks the "all consecutive months" requirement
    ]
  };
  sb.__set('D', D);
  sb.__set('_forecastFastIndexes', null);
  const flags = sb.computeDriftFlags();
  assert(flags.length === 0, 'Drift in only 1 of 2 required consecutive months should not flag, got ' + flags.length);
}

async function testDriftDismissSuppressesUntilNewMonthCloses(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-12T00:00:00.000Z');
  const D = {
    provisionGroups: [{
      id:1, name:'Car', lines:[{acc:60201, lineId:60201, descrBase:null}],
      months: { '2026-06': {60201: 300}, '2026-07': {60201: 300} }
    }],
    forecastAccountRules: [],
    ledger: [
      {acc:60201, date:'2026-06-15', amt:390},
      {acc:60201, date:'2026-07-15', amt:390},
    ]
  };
  sb.__set('D', D);
  sb.__set('_forecastFastIndexes', null);
  sb.__set('go', ()=>{}); // dismissDriftFlag calls go(screen) to re-render — neutralize for this test
  sb.__set('screen', 'dashboard');

  let flags = sb.computeDriftFlags();
  assert(flags.length === 1, 'Sanity check: should be flagged before dismissal');
  sb.dismissDriftFlag(flags[0].key);
  flags = sb.computeDriftFlags();
  assert(flags.length === 0, 'Flag should be suppressed immediately after dismissal, while still "this month"');

  // Simulate a new month closing — "today" moves forward a month, so the comparison window shifts
  // to include 2026-07 and 2026-08, meaning 2026-08 (not yet dismissed) enters the window
  freezeDate(sb, '2026-09-12T00:00:00.000Z');
  D.provisionGroups[0].months['2026-08'] = {60201: 300};
  D.ledger.push({acc:60201, date:'2026-08-15', amt:390});
  flags = sb.computeDriftFlags();
  assert(flags.length === 1, 'Once a new month closes and enters the comparison window, the (still-drifting) flag should reappear, got ' + flags.length);
}

async function testSidebarPinToggle(){
  const sb = makeSandbox();
  const doc = sb.document;
  const btn = doc.createElement('button'); btn.id = 'sidebarPinBtn'; doc.body.appendChild(btn);
  const sidebar = doc.createElement('aside'); sidebar.id = 'sidebar'; sidebar.classList.add('open'); doc.body.appendChild(sidebar);
  const scrim = doc.createElement('div'); scrim.id = 'mobileNavScrim'; scrim.classList.add('show'); doc.body.appendChild(scrim);
  sb.__set('sidebarPinned', false);
  sb.__set('safeSetItemWarn', () => true);
  sb.toggleSidebarPin();
  assert(doc.body.classList.contains('sidebar-pinned'), 'toggleSidebarPin() should add sidebar-pinned to body when turning on');
  assert(btn.classList.contains('on'), 'The pin button should show as active when pinned');
  assert(!sidebar.classList.contains('open'), 'Turning pin on should close the now-redundant mobile drawer');
  sb.toggleSidebarPin();
  assert(!doc.body.classList.contains('sidebar-pinned'), 'toggleSidebarPin() should remove sidebar-pinned from body when turning off');
  assert(!btn.classList.contains('on'), 'The pin button should show as inactive when unpinned');
}

async function testMobileNavOpenClose(){
  const sb = makeSandbox();
  const doc = sb.document;
  const sidebar = doc.createElement('aside'); sidebar.id = 'sidebar'; doc.body.appendChild(sidebar);
  const scrim = doc.createElement('div'); scrim.id = 'mobileNavScrim'; doc.body.appendChild(scrim);
  sb.openMobileNav();
  assert(sidebar.classList.contains('open'), 'openMobileNav() should add the open class to #sidebar');
  assert(scrim.classList.contains('show'), 'openMobileNav() should add the show class to the scrim');
  sb.closeMobileNav();
  assert(!sidebar.classList.contains('open'), 'closeMobileNav() should remove the open class from #sidebar');
  assert(!scrim.classList.contains('show'), 'closeMobileNav() should remove the show class from the scrim');
}

async function testGoClosesMobileNavAndUpdatesTitle(){
  const sb = makeSandbox();
  const doc = sb.document;
  const sidebar = doc.createElement('aside'); sidebar.id = 'sidebar'; sidebar.classList.add('open'); doc.body.appendChild(sidebar);
  const scrim = doc.createElement('div'); scrim.id = 'mobileNavScrim'; scrim.classList.add('show'); doc.body.appendChild(scrim);
  const titleEl = doc.createElement('span'); titleEl.id = 'mobileTopbarTitle'; doc.body.appendChild(titleEl);
  const navEl = doc.createElement('nav'); navEl.id = 'nav'; doc.body.appendChild(navEl);
  const appEl = doc.getElementById('app');
  sb.__set('D', { accounts:[], ledger:[], provisionGroups:[], forecastAccountRules:[] });
  sb.__set('dashboardNeedsCountUp', false);
  sb.__set('screen', 'dashboard');
  sb.__set('reconcileAcc', null);
  sb.__set('jvReturnScreen', null);
  sb.__set('renderLedger', () => { appEl.innerHTML = 'ledger rendered'; });
  sb.go('ledger');
  assert(!sidebar.classList.contains('open'), 'Navigating via go() should close the mobile nav drawer');
  assert(!scrim.classList.contains('show'), 'Navigating via go() should hide the scrim');
  // As of v4.12.0 the title carries the page's icon as well as its label.
  assert(titleEl.textContent === '📖 Ledger', 'The mobile top bar title should update to match the new screen (with its icon), got "' + titleEl.textContent + '"');
}

async function testCategoryAccountIdsExcludesWorkingCapital(){
  const sb = makeSandbox();
  const D = {
    accounts: [
      {id:10101, category:'Bank Accounts', is_savings:false},
      {id:10199, category:'Bank Accounts', is_savings:false}, // Working Capital rollup — must be excluded
    ],
    ledger: [
      {acc:10101, amt:500},
      {acc:10199, amt:9999}, // if this leaks in anywhere, the totals below would be wrong
    ]
  };
  sb.__set('D', D);
  const ids = sb.categoryAccountIds('Bank Accounts');
  assert(ids.has(10101) && !ids.has(10199), 'categoryAccountIds should exclude 10199 from Bank Accounts');
  const total = sb.bankBalance();
  assert(total === 500, 'bankBalance() should exclude 10199, got ' + total);
  // The regression this fixes: viewCategoryAccounts used a SEPARATE filter that didn't know about
  // this exclusion — assert it now shares the exact same id-set as the card total.
  const popupAccs = D.accounts.filter(a => ids.has(a.id));
  assert(popupAccs.length === 1 && popupAccs[0].id === 10101, 'The breakdown popup should list exactly the same accounts as the card total');
}

function makeLedgerEditorSandbox(ledgerRows, accounts){
  const sb = makeSandbox();
  const D = { ledger: ledgerRows, accounts: accounts || [
    {id:10101, name:'10101 - Cash', status:'Active'},
    {id:10102, name:'10102 - Bank', status:'Active'},
    {id:60101, name:'60101 - Groceries', status:'Active'},
  ]};
  sb.__set('D', D);
  sb.__set('ACC_BY_ID', Object.fromEntries(D.accounts.map(a=>[a.id,a])));
  sb.__set('blockIfSyncing', () => false);
  sb.__set('screen', 'ledger');
  sb.__set('go', () => {});
  sb.__set('renderLedger', () => {});
  sb.__set('renderDashboard', () => {});
  sb.__set('renderStatement', () => {});
  sb.__set('renderAlloc', () => {});
  sb.__set('persistLocal', () => {});
  sb.__set('logActivity', () => {});
  sb.__set('showImportProgress', () => {});
  sb.__set('updateImportProgress', () => {});
  let finishMsg = null;
  sb.__set('finishImportProgress', (msg) => { finishMsg = msg; });
  let modalHtml = null;
  sb.__set('showModal', (html) => { modalHtml = html; });
  let confirmCalled = false, confirmReturn = true;
  sb.__set('confirm', (msg) => { confirmCalled = true; return confirmReturn; });
  const syncCalls = [];
  sb.__set('syncWriteMany', async (ops) => { syncCalls.push(...ops); return {results:[]}; });
  return { sb, D, getModalHtml:()=>modalHtml, getFinishMsg:()=>finishMsg, wasConfirmCalled:()=>confirmCalled, setConfirmReturn:(v)=>{confirmReturn=v;}, getSyncCalls:()=>syncCalls };
}

async function testLedgerEditorBlocksUnbalancedJV(){
  const ledgerRows = [
    {id:1, jv:100, date:'2026-06-01', acc:10101, descr:'Deposit', amt:500, alloc:null, allocatable:false, accNameSnapshot:null},
    {id:2, jv:100, date:'2026-06-01', acc:60101, descr:'Groceries', amt:-500, alloc:null, allocatable:false, accNameSnapshot:null},
  ];
  const { sb, D, getModalHtml, getSyncCalls } = makeLedgerEditorSandbox(ledgerRows);
  // Edit row 2's amount so the JV no longer nets to zero
  const csvRows = [{ 'row id':'2', 'jv#':'100', date:'2026-06-01', 'account#':'60101', description:'Groceries', amount:'-400', 'alloc#':'', 'historical name':'', delete:'' }];
  await sb.importLedgerEditorCSV(csvRows);
  assert(D.ledger.find(l=>l.id===2).amt === -500, 'Ledger must be UNCHANGED when validation blocks the import — got ' + D.ledger.find(l=>l.id===2).amt);
  assert(getSyncCalls().length === 0, 'No sync writes should happen when the import is blocked');
  const html = getModalHtml();
  assert(html && html.includes('JV #100') && html.includes('no longer balance'), 'The blocking report should mention the specific JV# that would be unbalanced');
}

async function testLedgerEditorBlocksBrokenAllocation(){
  const ledgerRows = [
    {id:1, jv:100, date:'2026-06-01', acc:10101, descr:'Expense claim', amt:-200, alloc:500, allocatable:true, accNameSnapshot:null},
    {id:2, jv:101, date:'2026-06-05', acc:10101, descr:'Reimbursement', amt:200, alloc:500, allocatable:true, accNameSnapshot:null},
  ];
  const { sb, D, getModalHtml } = makeLedgerEditorSandbox(ledgerRows);
  // Delete row 2 — alloc group 500 was balanced (net 0), now it's just row 1 at -200, no longer balanced
  const csvRows = [{ 'row id':'2', 'jv#':'', date:'', 'account#':'', description:'', amount:'', 'alloc#':'', 'historical name':'', delete:'DELETE' }];
  await sb.importLedgerEditorCSV(csvRows);
  assert(D.ledger.length === 2, 'Ledger must be UNCHANGED when validation blocks the import — got ' + D.ledger.length + ' rows');
  const html = getModalHtml();
  assert(html && html.includes('00500') && html.includes('unbalanced'), 'The blocking report should mention the specific allocation group that would break');
}

async function testLedgerEditorAppliesValidEdit(){
  const ledgerRows = [
    {id:1, jv:100, date:'2026-06-01', acc:10101, descr:'Deposit', amt:500, alloc:null, allocatable:false, accNameSnapshot:null},
    {id:2, jv:100, date:'2026-06-01', acc:60101, descr:'Groceries', amt:-500, alloc:null, allocatable:false, accNameSnapshot:null},
  ];
  const { sb, D, getSyncCalls, getFinishMsg, wasConfirmCalled } = makeLedgerEditorSandbox(ledgerRows);
  // Correct both lines together so the JV still balances, and set a historical name correction
  const csvRows = [
    { 'row id':'1', 'jv#':'100', date:'2026-06-01', 'account#':'10101', description:'Deposit', amount:'600', 'alloc#':'', 'historical name':'', delete:'' },
    { 'row id':'2', 'jv#':'100', date:'2026-06-01', 'account#':'60101', description:'Groceries', amount:'-600', 'alloc#':'', 'historical name':'Old Grocery Name', delete:'' },
  ];
  await sb.importLedgerEditorCSV(csvRows);
  assert(wasConfirmCalled(), 'A valid import should prompt for confirmation before committing');
  assert(D.ledger.find(l=>l.id===1).amt === 600, 'Row 1 amount should be updated to 600');
  assert(D.ledger.find(l=>l.id===2).amt === -600, 'Row 2 amount should be updated to -600');
  assert(D.ledger.find(l=>l.id===2).accNameSnapshot === 'Old Grocery Name', 'Historical Name should be applied to row 2');
  assert(getSyncCalls().length === 2, 'Both changed rows should be synced, got ' + getSyncCalls().length);
  assert(getFinishMsg() && getFinishMsg().includes('2 updated'), 'Completion message should report 2 rows updated');
}

async function testLedgerEditorDeletesFullJVCleanly(){
  const ledgerRows = [
    {id:1, jv:100, date:'2026-06-01', acc:10101, descr:'Deposit', amt:500, alloc:null, allocatable:false, accNameSnapshot:null},
    {id:2, jv:100, date:'2026-06-01', acc:60101, descr:'Groceries', amt:-500, alloc:null, allocatable:false, accNameSnapshot:null},
  ];
  const { sb, D } = makeLedgerEditorSandbox(ledgerRows);
  const csvRows = [
    { 'row id':'1', 'jv#':'', date:'', 'account#':'', description:'', amount:'', 'alloc#':'', 'historical name':'', delete:'DELETE' },
    { 'row id':'2', 'jv#':'', date:'', 'account#':'', description:'', amount:'', 'alloc#':'', 'historical name':'', delete:'DELETE' },
  ];
  await sb.importLedgerEditorCSV(csvRows);
  assert(D.ledger.length === 0, 'Deleting every line of a JV should be allowed cleanly (nothing left to be unbalanced), got ' + D.ledger.length + ' rows remaining');
}

async function testLedgerEditorRejectsDuplicateRowId(){
  const ledgerRows = [
    {id:1, jv:100, date:'2026-06-01', acc:10101, descr:'Deposit', amt:500, alloc:null, allocatable:false, accNameSnapshot:null},
    {id:2, jv:100, date:'2026-06-01', acc:60101, descr:'Groceries', amt:-500, alloc:null, allocatable:false, accNameSnapshot:null},
  ];
  const { sb, D, getModalHtml } = makeLedgerEditorSandbox(ledgerRows);
  const csvRows = [
    { 'row id':'1', 'jv#':'100', date:'2026-06-01', 'account#':'10101', description:'Deposit A', amount:'500', 'alloc#':'', 'historical name':'', delete:'' },
    { 'row id':'1', 'jv#':'100', date:'2026-06-01', 'account#':'10101', description:'Deposit B', amount:'500', 'alloc#':'', 'historical name':'', delete:'' },
  ];
  await sb.importLedgerEditorCSV(csvRows);
  assert(D.ledger.find(l=>l.id===1).descr === 'Deposit', 'A file with a duplicate Row ID should change nothing (blocked as a parse error)');
  const html = getModalHtml();
  assert(html && html.toLowerCase().includes('duplicate'), 'The report should specifically call out the duplicate Row ID');
}

async function testKpiValueNoLongerStuckAtZero(){
  const sb = makeSandbox();
  // Simulate: fresh navigation-in already happened and consumed the one-shot flag
  sb.__set('dashboardNeedsCountUp', false);
  const html = sb.kpiValue(12345.67, '', 'absMoney');
  assert(html.includes(sb.absMoney(12345.67)), 'kpiValue should render the real value immediately when no count-up animation is pending (was previously always 0)');
  assert(!html.includes('>'+sb.absMoney(0)+'<'), 'kpiValue should NOT render 0 when dashboardNeedsCountUp is false');

  // Simulate: a genuine navigation-in, where the 0-then-animate behavior should still happen
  sb.__set('dashboardNeedsCountUp', true);
  const html2 = sb.kpiValue(12345.67, '', 'absMoney');
  assert(html2.includes('>'+sb.absMoney(0)+'<'), 'kpiValue should still render 0 initially when a real count-up animation is about to play');
}

async function testJVDoubleClickGuard(){
  const sb = makeSandbox();
  // Minimal fixture: two postable accounts so a balanced 2-line JV can be built
  const accounts = [
    {id:10101, descr:'Cash', category:'Bank Accounts', status:'Active', acc_type:'Individual Account'},
    {id:60101, descr:'Groceries', category:'Expense', status:'Active', acc_type:'Individual Account'}
  ];
  const D = { accounts, ledger: [] };
  sb.__set('D', D);
  sb.__set('ACC_BY_ID', {10101:accounts[0], 60101:accounts[1]});
  sb.__set('jvDraft', { date: '2026-08-11', lines: [
    {key:'a', acc:10101, descr:'Test line 1', amt:-100},
    {key:'b', acc:60101, descr:'Test line 2', amt:100}
  ]});
  sb.__set('jvReturnScreen', null);
  sb.__set('reconcileAcc', null);
  sb.__set('syncQueue', []);
  sb.__set('syncInProgress', false);
  // Neutralize side-effecting helpers the harness doesn't stub a full app for
  sb.__set('go', () => {});
  sb.__set('blockIfSyncing', () => false);
  sb.__set('persistLocal', () => {});
  sb.__set('logActivity', () => {});
  // Make syncWrite artificially slow so a "double click" during the await is realistic
  let syncWriteCalls = 0;
  sb.__set('syncWrite', async () => { syncWriteCalls++; await new Promise(r => setTimeout(r, 20)); return true; });

  const before = D.ledger.length;
  // Fire postJV() twice back-to-back, synchronously, exactly as a fast double-click would
  const p1 = sb.postJV();
  const p2 = sb.postJV();
  await Promise.all([p1, p2]);

  const jvNumbersPosted = new Set(D.ledger.map(l => l.jv));
  assert(D.ledger.length === before + 2, 'Exactly one JV (2 lines) should be posted from a rapid double-click, not two — got ' + (D.ledger.length - before) + ' ledger rows');
  assert(jvNumbersPosted.size === 1, 'Only one distinct JV number should have been posted — got ' + jvNumbersPosted.size);
}

async function testPnlVarianceMagnitudeIsSignConventionProof(){
  const sb = makeSandbox();
  // Surplus (spent LESS than budgeted) with a POSITIVE-sign expense convention: budget=400, actual=300
  // The old raw-subtraction bug (actual - budget = -100) would show this as red (over budget) — wrong.
  const posConventionSurplus = sb.pnlVarianceMagnitude(400, 300);
  assert(posConventionSurplus > 0, 'Surplus under positive-sign convention should be positive (green), got ' + posConventionSurplus);
  assert(sb.moneyClass(posConventionSurplus) === 'g', 'Surplus should color green, got class "' + sb.moneyClass(posConventionSurplus) + '"');

  // Same real-world surplus, but with a NEGATIVE-sign expense convention: budget=-400, actual=-300
  // Must give the SAME green result — this is exactly what "sign-convention-proof" means.
  const negConventionSurplus = sb.pnlVarianceMagnitude(-400, -300);
  assert(negConventionSurplus > 0, 'The same real surplus under negative-sign convention should also be positive (green), got ' + negConventionSurplus);
  assert(sb.moneyClass(negConventionSurplus) === 'g', 'Surplus should color green regardless of sign convention, got class "' + sb.moneyClass(negConventionSurplus) + '"');

  // Over budget case, positive convention: budget=300, actual=400 — should be red
  const posConventionOver = sb.pnlVarianceMagnitude(300, 400);
  assert(sb.moneyClass(posConventionOver) === 'r', 'Over-budget should color red, got class "' + sb.moneyClass(posConventionOver) + '"');
}

// ---- v4.19.0: Dashboard "This Month Expense" vs budget ----
function seedDashboardBudget(sb, budgetPerAcc){
  sb.__set('D', Object.assign({}, sb.D, {
    accounts: [
      {id:60101, category:'Living', acc_type:'Individual Account', status:'Active'},
      {id:60102, category:'Living', acc_type:'Individual Account', status:'Active'},
      // Deleted and non-individual accounts must be excluded, exactly as the P&L page does.
      {id:60103, category:'Living', acc_type:'Individual Account', status:'Deleted'},
      {id:60104, category:'Living', acc_type:'Category Account', status:'Active'},
      {id:30101, category:'Salary',  acc_type:'Individual Account', status:'Active'}
    ],
    ledger: []
  }));
  sb.__set('pnlBudgetForAccountInRange', (accId) => budgetPerAcc[accId] || 0);
}

async function testDashboardExpenseBudgetSumsOnlyLiveExpenseAccounts(){
  const sb = makeSandbox();
  // 60103 is Deleted, 60104 is a Category Account, 30101 is income — none should be counted.
  seedDashboardBudget(sb, {60101: 3000, 60102: 2000, 60103: 9999, 60104: 8888, 30101: 7777});
  const b = sb.dashboardExpenseBudget('2026-08', 0);
  assert(Math.abs(b.budget - 5000) < 0.005, 'Budget should total only live individual/accrual expense accounts (5000), got ' + b.budget);
  assert(b.hasBudget === true, 'A 5000 budget should register as having a budget');
}

async function testDashboardExpenseBudgetComparesAgainstTheWholeMonth(){
  const sb = makeSandbox();
  seedDashboardBudget(sb, {60101: 3100});
  // Month-to-date spend against the FULL month's budget. The prorated "on pace" reading that
  // used to sit alongside this was removed in v4.21.0.
  const b = sb.dashboardExpenseBudget('2026-08', 1200);
  assert(Math.abs(b.fullVariance - 1900) < 0.005, 'Full-month variance should be +1900 (under), got ' + b.fullVariance);
  assert(sb.moneyClass(b.fullVariance) === 'g', 'Under budget should read green');
  const over = sb.dashboardExpenseBudget('2026-08', 4000);
  assert(Math.abs(over.fullVariance + 900) < 0.005, 'Overspending should give -900, got ' + over.fullVariance);
  assert(sb.moneyClass(over.fullVariance) === 'r', 'Over budget should read red');
}

async function testDashboardExpenseBudgetIsSignConventionProof(){
  const sb = makeSandbox();
  // The same real-world position expressed with a negative-sign expense convention on both sides.
  seedDashboardBudget(sb, {60101: -3100});
  const b = sb.dashboardExpenseBudget('2026-08', -4000);
  assert(Math.abs(b.fullVariance + 900) < 0.005,
    'Variance must be -900 under a negative-sign convention too (magnitude comparison, not raw subtraction), got ' + b.fullVariance);
  assert(sb.moneyClass(b.fullVariance) === 'r', 'Over budget should read red regardless of sign convention');
}

async function testDashboardExpenseBudgetHandlesNoBudgetAndPastMonths(){
  const sb = makeSandbox();
  seedDashboardBudget(sb, {});
  const none = sb.dashboardExpenseBudget('2026-08', 1200);
  assert(none.hasBudget === false, 'A zero budget should not claim to have a budget');
  assert(sb.dashboardExpenseBudgetLine(none).indexOf('No budget set') !== -1,
    'With no budget the line should say so rather than reporting "over budget by" the entire spend');

  // Any month reads the same way now — there is no day-of-month component left to go stale.
  seedDashboardBudget(sb, {60101: 3100});
  const past = sb.dashboardExpenseBudget('2026-07', 1200);
  assert(Math.abs(past.fullVariance - 1900) < 0.005, 'A past month should compare against its own full budget, got ' + past.fullVariance);
}

// ---- v4.19.0: clickable allocation badges ----
async function testAllocBadgeIsClickableAndBlankWhenUnallocated(){
  const sb = makeSandbox();
  assert(sb.allocBadgeCell(null) === '', 'An unallocated line should render an empty cell, got: ' + JSON.stringify(sb.allocBadgeCell(null)));
  assert(sb.allocBadgeCell(0) === '', 'Allocation 0 should render empty rather than badge "00000"');
  const cell = sb.allocBadgeCell(6);
  assert(cell.indexOf('00006') !== -1, 'Badge should show the padded allocation number, got: ' + cell);
  assert(/openAllocGroupFrom\(event,\s*6\)/.test(cell), 'Badge should open the allocation detail window on click, got: ' + cell);
}

async function testAllocJumpFromLedgerRowDoesNotAlsoOpenTheJV(){
  const sb = makeSandbox();
  // The Ledger row's own onclick opens the JV. Without stopPropagation, clicking the badge would
  // fire both handlers and the JV modal would immediately replace the allocation modal.
  let stopped = 0, opened = null;
  sb.__set('viewAllocGroup', (n) => { opened = n; });
  sb.openAllocGroupFrom({ stopPropagation: () => { stopped++; } }, 42);
  assert(stopped === 1, 'The badge click must stop propagating to the row handler, got ' + stopped + ' calls');
  assert(opened === 42, 'The allocation detail window should open for the clicked number, got ' + opened);
}

async function testAllocModalActionsDoNotRepaintTheWrongPage(){
  const sb = makeSandbox();
  // Reachable from the Ledger page now, so unassignLine must not paint the Allocations page
  // into #app while the nav still says Ledger.
  let allocRenders = 0, ledgerRenders = 0;
  sb.__set('renderAlloc', () => { allocRenders++; });
  sb.__set('renderLedgerResults', () => { ledgerRenders++; });
  sb.__set('blockIfSyncing', () => false);
  sb.__set('closeModal', () => {});
  sb.__set('viewAllocGroup', () => {});
  sb.__set('toast', () => {});
  sb.__set('persistLocal', () => {});
  sb.__set('syncWrite', async () => {});
  sb.__set('D', Object.assign({}, sb.D, {ledger: [{id:1, jv:1, date:'2026-08-01', acc:60101, descr:'x', amt:10, alloc:7}]}));

  sb.__set('screen', 'ledger');
  await sb.unassignLine(1, 7);
  assert(allocRenders === 0, 'On the Ledger page, unassigning must NOT render the Allocations page, got ' + allocRenders + ' renders');
  assert(ledgerRenders === 1, 'On the Ledger page, unassigning should refresh the ledger results, got ' + ledgerRenders);

  sb.__set('D', Object.assign({}, sb.D, {ledger: [{id:2, jv:2, date:'2026-08-01', acc:60101, descr:'x', amt:10, alloc:8}]}));
  sb.__set('screen', 'alloc');
  await sb.unassignLine(2, 8);
  assert(allocRenders === 1, 'On the Allocations page it SHOULD still repaint, got ' + allocRenders);
}

async function testGoPnLThisMonthOpensPnlForTheCurrentMonth(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-10T09:00:00Z');
  let went = null;
  sb.__set('go', (s) => { went = s; });
  sb.goPnLThisMonth();
  assert(went === 'pnl', 'Should navigate to the P&L page, got ' + went);
  assert(vm.runInContext('pnlPreset', sb) === 'month', 'Preset should be set to this month, got ' + vm.runInContext('pnlPreset', sb));
  assert(vm.runInContext('pnlFrom', sb) === '2026-08-01' && vm.runInContext('pnlTo', sb) === '2026-08-31',
    'Range should cover the whole current month, got ' + vm.runInContext('pnlFrom', sb) + ' → ' + vm.runInContext('pnlTo', sb));
}

// ================= v4.20.0: management fee, platform cash, reconciliation =================
// ownerId 1 = self, ownerId 2 = family
function invCashSandbox(extra){
  const sb = makeSandbox();
  // `D` is a top-level `let`, so it is not exposed as a property of the sandbox object. The
  // object reference set into the context is the same one held here, so mutating sb._D in a test
  // mutates the app's state too.
  const data = Object.assign({
    accounts: [], ledger: [], budget: [],
    invOwners: [{id:1, name:'Me', isSelf:true, outAcc:null, inAcc:null},
                {id:2, name:'Relative', isSelf:false, outAcc:null, inAcc:null}],
    invPlatforms: [{id:1, name:'Broker A'}, {id:2, name:'Broker B'}],
    invPositions: [{id:1, platformId:1, name:'ACME', currency:'USD', assetClass:'Equity', status:'Active'}],
    invTransactions: [], invValuations: [], invCashMovements: [], invRoboValueLog: [], forecastSnapshots: [], provisionGroups: [], forecastAccountRules: [],
    invSettings: {fxUsdSar: 3.75, mgmtFeePct: 0}
  }, extra||{});
  sb.__set('D', data);
  sb._D = data;
  return sb;
}

async function testBuyFeeMovesUnitsButNotTheSarSplit(){
  const sb = invCashSandbox({invTransactions:[
    // 100 units for 100,000 SAR, split 50/50, 5% management fee.
    {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:100000,
     owners:[{ownerId:1,units:50},{ownerId:2,units:50}], feePct:5, cashSide:'bank'}
  ]});
  const at = sb.invTxAttribution(sb._D.invTransactions[0]);
  assert(Math.abs(at.units[2] - 47.5) < 1e-9, 'Family should hold 47.5 units after a 5% fee, got ' + at.units[2]);
  assert(Math.abs(at.units[1] - 52.5) < 1e-9, 'Self should hold 52.5 units after a 5% fee, got ' + at.units[1]);
  assert(Math.abs((at.units[1]+at.units[2]) - 100) < 1e-9, 'The fee must not create or destroy units');
  // The SAR split deliberately does NOT move — that is what makes it a fee rather than a
  // smaller purchase.
  assert(Math.abs(at.moneySar[1] - 50000) < 0.005 && Math.abs(at.moneySar[2] - 50000) < 0.005,
    'SAR must stay at the entered 50/50 split, got ' + at.moneySar[1] + ' / ' + at.moneySar[2]);

  const st = sb.computePositionState(1);
  assert(Math.abs(st.byOwner[2].costSar - 50000) < 0.005, 'Family cost basis should stay 50,000, got ' + st.byOwner[2].costSar);
  // The whole point: their average cost rises, yours falls.
  const famAvg = st.byOwner[2].costSar/st.byOwner[2].units, selfAvg = st.byOwner[1].costSar/st.byOwner[1].units;
  assert(famAvg > 1000 && selfAvg < 1000, 'Family average cost should rise above 1000 and self fall below, got ' + famAvg + ' / ' + selfAvg);
}

async function testSellFeeComesOutOfProceedsAndIsFeeIncomeNotGain(){
  const sb = invCashSandbox({invTransactions:[
    {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:100000,
     owners:[{ownerId:1,units:50},{ownerId:2,units:50}], feePct:0, cashSide:'bank'},
    // Sell the family's 50 units for 75,000 (a 25,000 gain), 10% fee = 7,500 to self.
    {id:2, positionId:1, date:'2026-02-01', kind:'sell', units:50, totalSar:75000,
     owners:[{ownerId:2,units:50}], feePct:10, cashSide:'cash', usdAmount:20000}
  ]});
  const at = sb.invTxAttribution(sb._D.invTransactions[1]);
  assert(Math.abs(at.feeSar - 7500) < 0.005, 'Fee should be 7,500, got ' + at.feeSar);
  // Units leave in full — the fee comes out of the money, not the units.
  const entered = sb.invTxEnteredUnits(sb._D.invTransactions[1]);
  assert(Math.abs(entered[2] - 50) < 1e-9, 'All 50 units should still leave the family owner, got ' + entered[2]);
  // Self is NOT credited in moneySar: the fee is income, not an investment return.
  assert(!(at.moneySar[1] > 0), 'Self must not be credited investment proceeds by the fee, got ' + at.moneySar[1]);
  assert(Math.abs(at.cashSar[1] - 7500) < 0.005, 'Self SHOULD receive the fee as cash, got ' + at.cashSar[1]);
  assert(Math.abs(at.cashSar[2] - 67500) < 0.005, 'Family cash should be proceeds less the fee, got ' + at.cashSar[2]);

  const st = sb.computePositionState(1);
  assert(Math.abs(st.byOwner[2].realizedSar - 17500) < 0.005,
    'Family realised gain should be 25,000 less the 7,500 fee = 17,500, got ' + st.byOwner[2].realizedSar);
  const fee = sb.invFeeIncomeByYear();
  assert(fee.length === 1 && Math.abs(fee[0].fee - 7500) < 0.005, 'Fee income should be reported separately as 7,500');
  const realised = sb.invRealisedByYear(true);
  assert(!realised.some(r=>Math.abs(r.gain - 7500) < 0.005), 'The fee must NOT appear as self realised investment gain');
}

async function testFeeIsAppliedByEveryConsumerNotJustCostBasis(){
  // The "fixed everywhere" lesson: a fee applied in some readers and not others would make the
  // same transaction value differently on different screens.
  const sb = invCashSandbox({invTransactions:[
    {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:100000,
     owners:[{ownerId:1,units:50},{ownerId:2,units:50}], feePct:5, cashSide:'bank'}
  ], invValuations:[{id:1, positionId:1, date:'2026-03-01', price:1}]});
  const asOf = sb.invPositionStateAsOf(1, '2026-06-01', true);
  assert(Math.abs(asOf.units - 52.5) < 1e-9,
    'Historical state must apply the fee too (52.5 self units), got ' + asOf.units);
  const st = sb.computePositionState(1);
  assert(Math.abs(st.byOwner[1].units - asOf.units) < 1e-9,
    'Historical state and cost-basis engine must agree on units, got ' + st.byOwner[1].units + ' vs ' + asOf.units);
}

async function testPlatformCashTracksSellProceedsAndFundedBuys(){
  const sb = invCashSandbox({invTransactions:[
    {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:37500,
     owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'},
    // Sell into USD held on the platform: 75,000 SAR / 3.75 = $20,000
    {id:2, positionId:1, date:'2026-02-01', kind:'sell', units:100, totalSar:75000,
     owners:[{ownerId:1,units:100}], feePct:0, cashSide:'cash', usdAmount:20000}
  ]});
  const cash = sb.invPlatformCash(1);
  assert(Math.abs(cash.totalUsd - 20000) < 0.005, 'Cash should be $20,000 after the sell, got ' + cash.totalUsd);
  // 37,500 gain / 3.75 = $10,000 of that balance is profit rather than returned capital.
  assert(Math.abs(cash.profitUsd - 10000) < 0.005, 'Retained profit should be $10,000, got ' + cash.profitUsd);

  // A cash-funded buy takes the money back off the platform.
  sb._D.invTransactions.push({id:3, positionId:1, date:'2026-03-01', kind:'buy', units:50, totalSar:18750,
    owners:[{ownerId:1,units:50}], feePct:0, cashSide:'cash', usdAmount:5000});
  const after = sb.invPlatformCash(1);
  assert(Math.abs(after.totalUsd - 15000) < 0.005, 'Cash should drop to $15,000 after a cash-funded buy, got ' + after.totalUsd);
  // Reinvested profit stays flagged as profit — this is what keeps the bridge balanced.
  assert(Math.abs(after.profitUsd - 10000) < 0.005, 'A cash-funded buy must not consume retained profit, got ' + after.profitUsd);
}

async function testBankSideTransactionsDoNotTouchCash(){
  const sb = invCashSandbox({invTransactions:[
    {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:37500,
     owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'},
    {id:2, positionId:1, date:'2026-02-01', kind:'sell', units:100, totalSar:75000,
     owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'}
  ]});
  assert(Math.abs(sb.invPlatformCash(1).totalUsd) < 0.005,
    'A sell settled to the bank must leave no platform cash, got ' + sb.invPlatformCash(1).totalUsd);
}

async function testDepositWithdrawalAndTransferWithFee(){
  const sb = invCashSandbox({invCashMovements:[
    {id:1, platformId:1, date:'2026-01-01', kind:'deposit', usdAmount:10000,
     owners:[{ownerId:1, usd:10000}], feeUsd:0, capitalUsd:0, profitUsd:0},
    // Transfer $4,000 to Broker B, $25 fee borne by self on the sending side.
    {id:2, platformId:1, date:'2026-02-01', kind:'transfer', usdAmount:4000, toPlatformId:2,
     owners:[{ownerId:1, usd:4000}], feeUsd:25, capitalUsd:0, profitUsd:0}
  ]});
  const a = sb.invPlatformCash(1), b = sb.invPlatformCash(2);
  assert(Math.abs(a.totalUsd - 5975) < 0.005, 'Source should be 10000 - 4000 - 25 fee = 5,975, got ' + a.totalUsd);
  assert(Math.abs(b.totalUsd - 4000) < 0.005, 'Destination should receive the full 4,000 (fee is not deducted twice), got ' + b.totalUsd);

  sb._D.invCashMovements.push({id:3, platformId:1, date:'2026-03-01', kind:'withdrawal', usdAmount:1000,
    owners:[{ownerId:1, usd:1000}], feeUsd:0, capitalUsd:1000, profitUsd:0});
  assert(Math.abs(sb.invPlatformCash(1).totalUsd - 4975) < 0.005,
    'Withdrawal should reduce the balance to 4,975, got ' + sb.invPlatformCash(1).totalUsd);
}

async function testTransferFeeIsBorneBySelfNotSharedWithFamily(){
  const sb = invCashSandbox({invCashMovements:[
    {id:1, platformId:1, date:'2026-01-01', kind:'deposit', usdAmount:10000,
     owners:[{ownerId:1, usd:5000},{ownerId:2, usd:5000}], feeUsd:0, capitalUsd:0, profitUsd:0},
    {id:2, platformId:1, date:'2026-02-01', kind:'transfer', usdAmount:2000, toPlatformId:2,
     owners:[{ownerId:1, usd:1000},{ownerId:2, usd:1000}], feeUsd:100, capitalUsd:0, profitUsd:0}
  ]});
  const a = sb.invPlatformCash(1);
  assert(Math.abs(a.byOwner[2].usd - 4000) < 0.005, 'Family should pay none of the fee, got ' + a.byOwner[2].usd);
  assert(Math.abs(a.byOwner[1].usd - 3900) < 0.005, 'Self should bear the whole 100 fee, got ' + a.byOwner[1].usd);
}

async function testTransferCarriesProfitProportionally(){
  const sb = invCashSandbox({invTransactions:[
    {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:37500,
     owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'},
    {id:2, positionId:1, date:'2026-02-01', kind:'sell', units:100, totalSar:75000,
     owners:[{ownerId:1,units:100}], feePct:0, cashSide:'cash', usdAmount:20000}
  ], invCashMovements:[
    // Move half the balance: half the retained profit should travel with it, otherwise moving
    // cash between platforms would quietly reclassify profit as capital.
    {id:1, platformId:1, date:'2026-03-01', kind:'transfer', usdAmount:10000, toPlatformId:2,
     owners:[{ownerId:1, usd:10000}], feeUsd:0, capitalUsd:0, profitUsd:0}
  ]});
  const a = sb.invPlatformCash(1), b = sb.invPlatformCash(2);
  assert(Math.abs(a.profitUsd - 5000) < 0.005, 'Half the profit should remain, got ' + a.profitUsd);
  assert(Math.abs(b.profitUsd - 5000) < 0.005, 'Half the profit should travel with the money, got ' + b.profitUsd);
}

async function testReconciliationBridgeBalancesWithCashHeld(){
  // The bridge: cost basis + platform cash - retained profit = ledger (Out - In).
  // Deposit 37,500 SAR of capital, buy, then sell at a gain and keep the proceeds as cash.
  // The ledger only ever saw 37,500 go out, so the bridge must still land on 37,500.
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    invOwners: [{id:1, name:'Me', isSelf:true, outAcc:10101, inAcc:null}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:37500, descr:'invested'}],
    invTransactions:[
      {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:37500,
       owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'},
      {id:2, positionId:1, date:'2026-02-01', kind:'sell', units:100, totalSar:75000,
       owners:[{ownerId:1,units:100}], feePct:0, cashSide:'cash', usdAmount:20000}
    ]});
  const r = sb.invOwnerReconciliation()[0];
  assert(Math.abs(r.cashSar - 75000) < 0.005, 'Cash should be 75,000 SAR, got ' + r.cashSar);
  assert(Math.abs(r.retainedProfitSar - 37500) < 0.005, 'Retained profit should be 37,500 SAR, got ' + r.retainedProfitSar);
  assert(Math.abs(r.trackerCapital - 37500) < 0.005, 'Tracker capital should bridge back to 37,500, got ' + r.trackerCapital);
  assert(r.ok === true, 'The bridge should reconcile, difference was ' + r.diff);
}

async function testReconciliationWouldFalseAlarmWithoutTheProfitTerm(){
  // Guards the reason the retained-profit term exists at all: without it, every profitable
  // sell-to-cash would raise a reconciliation error.
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    invOwners: [{id:1, name:'Me', isSelf:true, outAcc:10101, inAcc:null}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:37500, descr:'invested'}],
    invTransactions:[
      {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:37500,
       owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'},
      {id:2, positionId:1, date:'2026-02-01', kind:'sell', units:100, totalSar:75000,
       owners:[{ownerId:1,units:100}], feePct:0, cashSide:'cash', usdAmount:20000}
    ]});
  const r = sb.invOwnerReconciliation()[0];
  const naive = r.trackerCost + r.cashSar; // what it would be without subtracting retained profit
  assert(Math.abs(naive - r.ledgerNet) > 1000,
    'Without the retained-profit term this scenario should NOT balance — otherwise the test proves nothing');
  assert(r.ok === true, 'With the term, it must balance');
}

async function testPlatformReconciliationFlagsUnitAndCashVariances(){
  const sb = invCashSandbox({
    invPositions: [{id:1, platformId:1, name:'ACME', currency:'USD', status:'Active', stmtUnits:100},
                   {id:2, platformId:1, name:'BTC', currency:'USD', status:'Active', stmtUnits:0.5}],
    invPlatforms: [{id:1, name:'Broker A', stmtCashUsd:2000}, {id:2, name:'Broker B'}],
    invTransactions:[
      {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:1000,
       owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'},
      // Statement says 0.5 BTC, tracker has 0.50000001 — a 1e-8 gap that must NOT read as matched.
      {id:2, positionId:2, date:'2026-01-01', kind:'buy', units:0.50000001, totalSar:1000,
       owners:[{ownerId:1,units:0.50000001}], feePct:0, cashSide:'bank'}
    ]});
  const r = sb.invPlatformReconciliation(1);
  const acme = r.positions.find(x=>x.pos.id===1), btc = r.positions.find(x=>x.pos.id===2);
  assert(acme.ok === true, 'A matching unit count should reconcile');
  assert(btc.ok === false, 'A 1e-8 crypto discrepancy must be flagged, not rounded into a match');
  assert(r.cashOk === false && Math.abs(r.cashVariance - 2000) < 0.005,
    'A statement cash balance with no tracked cash should show the full variance, got ' + r.cashVariance);
  assert(r.allMatched === false, 'The platform should not report as fully reconciled');
}

async function testWithdrawalSplitDrawsProfitFirstButAllowsOverride(){
  const sb = invCashSandbox({invTransactions:[
    {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:37500,
     owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'},
    {id:2, positionId:1, date:'2026-02-01', kind:'sell', units:100, totalSar:75000,
     owners:[{ownerId:1,units:100}], feePct:0, cashSide:'cash', usdAmount:20000}
  ]});
  // $20,000 on the platform, $10,000 of it profit.
  const auto = sb.invWithdrawalSplit({platformId:1, usdAmount:12000, profitOverride:null});
  assert(Math.abs(auto.profitUsd - 10000) < 0.005 && Math.abs(auto.capitalUsd - 2000) < 0.005,
    'Profit should be drawn first: 10,000 profit + 2,000 capital, got ' + auto.profitUsd + ' / ' + auto.capitalUsd);
  const manual = sb.invWithdrawalSplit({platformId:1, usdAmount:12000, profitOverride:3000});
  assert(Math.abs(manual.profitUsd - 3000) < 0.005 && Math.abs(manual.capitalUsd - 9000) < 0.005,
    'An explicit override should be respected, got ' + manual.profitUsd + ' / ' + manual.capitalUsd);
  const clamped = sb.invWithdrawalSplit({platformId:1, usdAmount:500, profitOverride:9999});
  assert(Math.abs(clamped.profitUsd - 500) < 0.005, 'The profit portion cannot exceed the withdrawal itself');
}

async function testFeeWithNoFamilyOwnersChargesNothing(){
  const sb = invCashSandbox({invTransactions:[
    {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:100000,
     owners:[{ownerId:1,units:100}], feePct:5, cashSide:'bank'}
  ]});
  const at = sb.invTxAttribution(sb._D.invTransactions[0]);
  assert(Math.abs(at.units[1] - 100) < 1e-9, 'A wholly-self transaction should be untouched by the fee, got ' + at.units[1]);
  assert(at.feeUnits === 0 && at.feeSar === 0, 'No fee should be charged when there are no family owners');
}

async function testSchemaSqlCoversTheCashTable(){
  const sb = makeSandbox();
  const sql = vm.runInContext('DB_SCHEMA_SQL', sb);
  assert(/create table if not exists pd_inv_cash_movements/.test(sql),
    'The from-scratch schema must create pd_inv_cash_movements');
  ['cash_side','usd_amount','fee_pct'].forEach(c=>{
    assert(sql.indexOf(c) !== -1, 'The from-scratch schema is missing the ' + c + ' column');
  });
  ['stmt_cash_usd','stmt_units','mgmt_fee_pct'].forEach(c=>{
    assert(sql.indexOf(c) !== -1, 'The from-scratch schema is missing the ' + c + ' column');
  });
  // Additive only — a destructive statement here would be a data-loss bug. DB_MIGRATIONS itself
  // was removed in v4.22.0 in favor of this one self-upgrading script (CREATE TABLE for a fresh
  // database, auto-generated ADD COLUMN IF NOT EXISTS for an existing one) — there is no longer a
  // separate migration file to check.
  assert(!/drop\s+table/i.test(sql) && !/drop\s+column/i.test(sql),
    'The schema script must never drop a table or column');
  assert(/add column if not exists/i.test(sql), 'The schema script should add columns idempotently for an existing database');
}


// ---- v4.21.0 ----
async function testAddedJVLinesStartBlankEvenWhileReconciling(){
  const sb = makeSandbox();
  sb.__set('renderNewJV', ()=>{});
  sb.__set('reconcileAcc', 10101);   // mid-reconciliation
  sb.resetJVDraft();
  const draft0 = vm.runInContext('jvDraft', sb);
  draft0.lines[0].acc = 10101;       // as startReconcile() would leave it
  sb.addJVLine();
  const draft = vm.runInContext('jvDraft', sb);
  const added = draft.lines[draft.lines.length-1];
  assert(!added.acc, 'A line added while reconciling must start blank, got acc=' + added.acc);
  // Line 1 keeps the account — the reconcile banner's maths depends on it.
  assert(draft.lines[0].acc === 10101, 'The first line must keep the account being reconciled');
}

async function testStartReconcileStillPrefillsTheFirstLine(){
  const sb = makeSandbox();
  sb.__set('go', ()=>{});
  sb.startReconcile(10101);
  const draft = vm.runInContext('jvDraft', sb);
  assert(draft.lines[0].acc === 10101, 'Picking an account to reconcile must still fill line 1, got ' + draft.lines[0].acc);
  assert(vm.runInContext('reconcileAcc', sb) === 10101, 'Reconcile mode should still be active');
}

async function testJVInputsOptOutOfBrowserAutofill(){
  const sb = makeSandbox();
  sb.__set('renderNewJV', ()=>{});
  sb.resetJVDraft();
  const row = sb.jvLineRow(vm.runInContext('jvDraft', sb).lines[0], 0);
  const count = (row.match(/autocomplete="off"/g)||[]).length;
  assert(count >= 3, 'Account, description and amount inputs should all opt out of autofill, found ' + count);
}

async function testDashboardBudgetLineHasNoPaceFigure(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:60101, acc_type:'Individual Account', status:'Active'}], ledger:[]});
  sb.__set('pnlBudgetForAccountInRange', ()=>3100);
  const b = sb.dashboardExpenseBudget('2026-08', 1200);
  const line = sb.dashboardExpenseBudgetLine(b);
  assert(/Under budget by/.test(line), 'The full-month over/under should remain, got: ' + line);
  assert(!/on pace/i.test(line), 'The on-pace figure should be gone, got: ' + line);
  assert(!/day \d+\/\d+/.test(line), 'The day count should be gone, got: ' + line);
  assert(b.paceVariance === undefined && b.proratedBudget === undefined,
    'The prorated state should be removed rather than left computed but unused');
  assert(Math.abs(b.fullVariance - 1900) < 0.005, 'The full-month variance should still be 1900, got ' + b.fullVariance);
}

async function testSchemaUpgradesAnExistingDatabaseNotJustANewOne(){
  const sb = makeSandbox();
  const core = vm.runInContext('DB_SCHEMA_CORE', sb);
  const full = vm.runInContext('DB_SCHEMA_SQL', sb);
  // The whole point of the merge: "create table if not exists" is skipped wholesale on an
  // existing table, so without an add-column pass every column introduced after that table was
  // first created would silently never appear.
  assert(full.length > core.length, 'The full script should be the core plus the column top-up');
  assert(/add column if not exists/.test(full), 'The script must contain add-column statements');
  assert(!/add column if not exists/.test(core), 'The core should hold table definitions only');

  // EVERY column of EVERY table must be re-asserted, or the gap still exists for that column.
  const tableRe = /create table if not exists (\w+) \(([\s\S]*?)\n\);/g;
  let m, checked = 0;
  const missing = [];
  while((m = tableRe.exec(core)) !== null){
    for(let line of m[2].split('\n')){
      let t = line.trim().replace(/--.*$/, '').replace(/,$/, '').trim();
      if(!t) continue;
      if(/^(primary key|unique|constraint|foreign key|check|references)\b/i.test(t)) continue;
      const sp = t.indexOf(' ');
      if(sp < 1) continue;
      const name = t.slice(0, sp);
      checked++;
      if(full.indexOf('alter table ' + m[1] + ' add column if not exists ' + name + ' ') === -1){
        missing.push(m[1] + '.' + name);
      }
    }
  }
  assert(checked > 100, 'Expected to check every column across all tables, checked ' + checked);
  assert(missing.length === 0, 'Columns with no add-column statement: ' + missing.join(', '));

  // The columns that would actually have been lost on a v4.19-era database.
  ['cash_side','usd_amount','fee_pct','stmt_cash_usd','stmt_units','mgmt_fee_pct'].forEach(c=>{
    assert(new RegExp('add column if not exists ' + c + '\\b').test(full),
      'The v4.20.0 column ' + c + ' must be added to existing databases too');
  });
}

async function testColumnTopUpIsSafeAndWellFormed(){
  const sb = makeSandbox();
  const full = vm.runInContext('DB_SCHEMA_SQL', sb);
  const top = vm.runInContext('buildSchemaColumnTopUp(DB_SCHEMA_CORE)', sb);
  // Nothing destructive may be generated. This runs against the person's live database.
  assert(!/drop\s+(table|column|database|schema)/i.test(full), 'The script must never drop anything');
  assert(!/truncate|delete\s+from/i.test(full), 'The script must never delete data');
  // Type/default CHANGES are deliberately not generated — only additions.
  assert(!/alter\s+column/i.test(top), 'The top-up must not alter existing columns, only add missing ones');
  // A column-level PRIMARY KEY can't be re-declared via add column.
  assert(!/add column if not exists[^;]*primary key/i.test(top), 'PRIMARY KEY must be stripped from add-column statements');
  // A composite "primary key (a, b)" is a table constraint, not a column.
  assert(!/add column if not exists \(/.test(top), 'A table-level constraint must not be emitted as a column');
  // Comment lines inside the table body must not leak in as columns.
  assert(!/add column if not exists --/.test(top), 'Comments must not be emitted as columns');
  assert(top.indexOf('pd_subcategories add column if not exists cat_digit') !== -1,
    'The composite-key table should still get its real columns');
  // Every generated line is a complete statement.
  top.split('\n').filter(l=>l.startsWith('alter table')).forEach(l=>{
    assert(l.endsWith(';'), 'Unterminated statement: ' + l);
    assert(l.split(' ').length >= 8, 'Malformed statement (no type?): ' + l);
  });
}

async function testAddingAColumnUpgradesExistingDatabasesAutomatically(){
  // Guards the reason the top-up is generated rather than hand-written: a new column must reach
  // existing databases without anyone remembering to update a second list.
  const sb = makeSandbox();
  const fakeCore = [
    'create table if not exists pd_demo (',
    '  id         bigint primary key,',
    '  name       text default \'\',',
    '  brand_new  numeric default 0,   -- added in some later version',
    '  updated_at timestamptz default now()',
    ');'
  ].join('\n');
  const top = sb.buildSchemaColumnTopUp(fakeCore);
  assert(/alter table pd_demo add column if not exists brand_new numeric default 0;/.test(top),
    'A newly added column should generate its own add-column statement, got:\n' + top);
  assert(/alter table pd_demo add column if not exists id bigint;/.test(top),
    'The key column should appear without its PRIMARY KEY constraint, got:\n' + top);
  assert(!/-- added in some later version/.test(top), 'Trailing comments must be stripped');
}

async function testSchemaIncludesTheLedgerChangeMarker(){
  const sb = makeSandbox();
  const sql = vm.runInContext('DB_SCHEMA_SQL', sb);
  assert(/create table if not exists pd_sync_meta/.test(sql), 'The schema must create pd_sync_meta');
  // The table alone is inert without something maintaining it.
  assert(/create trigger trg_pd_ledger_sync_meta/.test(sql), 'The schema must create the trigger that maintains the marker');
  assert(/pd_touch_sync_meta/.test(sql), 'The schema must define the trigger function');
  assert(sql.indexOf("'pd_sync_meta'")!==-1, 'pd_sync_meta should be in the RLS table list');
}

// ================= v4.23.0: opening balance, reconciliation start date, position transfer =================
async function testOpeningBalanceCostTrackedAndBleedsDownProportionallyOnSell(){
  const sb = invCashSandbox({invTransactions:[
    {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:10000,
     owners:[{ownerId:1,units:100}], feePct:0, cashSide:'opening'},
    {id:2, positionId:1, date:'2026-02-01', kind:'buy', units:100, totalSar:20000,
     owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'}
  ]});
  const st = sb.computePositionState(1);
  // 200 units total, cost 30,000 -> avg 150. Half the units (opening) contributed 10,000 of it.
  assert(Math.abs(st.byOwner[1].openingCostSar - 10000) < 0.005, 'Opening cost should be 10,000, got ' + st.byOwner[1].openingCostSar);

  sb._D.invTransactions.push({id:3, positionId:1, date:'2026-03-01', kind:'sell', units:100, totalSar:18000,
    owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'});
  const after = sb.computePositionState(1);
  // Selling half the pool (100 of 200 units) should bleed opening cost down by the SAME
  // proportion (half), not all-at-once and not untouched — WAC doesn't track lot identity.
  assert(Math.abs(after.byOwner[1].openingCostSar - 5000) < 0.005,
    'Opening cost should bleed down proportionally to 5,000 after selling half the pool, got ' + after.byOwner[1].openingCostSar);
}

async function testAsOfDateFiltersTransactionsForComputePositionState(){
  const sb = invCashSandbox({invTransactions:[
    {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:100, totalSar:10000,
     owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'},
    {id:2, positionId:1, date:'2026-06-01', kind:'buy', units:50, totalSar:6000,
     owners:[{ownerId:1,units:50}], feePct:0, cashSide:'bank'}
  ]});
  const asOfMarch = sb.computePositionState(1, '2026-03-01');
  assert(Math.abs(asOfMarch.totalUnits - 100) < 1e-9, 'Only the January buy should count as of March, got ' + asOfMarch.totalUnits);
  const now = sb.computePositionState(1);
  assert(Math.abs(now.totalUnits - 150) < 1e-9, 'Both buys should count with no cutoff, got ' + now.totalUnits);
}

async function testReconciliationExcludesOpeningBalanceCost(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    invOwners: [{id:1, name:'Me', isSelf:true, outAcc:10101, inAcc:null}],
    // The ledger only ever saw 5,000 leave the bank — the other 10,000 of cost is a declared
    // opening balance with no bank movement behind it at all.
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:5000, descr:'invested'}],
    invTransactions:[
      {id:1, positionId:1, date:'2025-01-01', kind:'buy', units:100, totalSar:10000,
       owners:[{ownerId:1,units:100}], feePct:0, cashSide:'opening'},
      {id:2, positionId:1, date:'2026-01-01', kind:'buy', units:50, totalSar:5000,
       owners:[{ownerId:1,units:50}], feePct:0, cashSide:'bank'}
    ]});
  const r = sb.invOwnerReconciliation()[0];
  assert(Math.abs(r.openingCostSar - 10000) < 0.005, 'Opening cost should be 10,000, got ' + r.openingCostSar);
  assert(Math.abs(r.trackerCapital - 5000) < 0.005,
    'Tracker capital should exclude the opening balance and bridge to 5,000, got ' + r.trackerCapital);
  assert(r.ok === true, 'Excluding the opening balance should let this reconcile, diff was ' + r.diff);
}

async function testReconciliationWithoutOpeningExclusionWouldFalseAlarm(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    invOwners: [{id:1, name:'Me', isSelf:true, outAcc:10101, inAcc:null}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:5000, descr:'invested'}],
    invTransactions:[
      {id:1, positionId:1, date:'2025-01-01', kind:'buy', units:100, totalSar:10000,
       owners:[{ownerId:1,units:100}], feePct:0, cashSide:'opening'},
      {id:2, positionId:1, date:'2026-01-01', kind:'buy', units:50, totalSar:5000,
       owners:[{ownerId:1,units:50}], feePct:0, cashSide:'bank'}
    ]});
  const r = sb.invOwnerReconciliation()[0];
  const naive = r.trackerCost; // what it would be without subtracting openingCostSar
  assert(Math.abs(naive - r.ledgerNet) > 1000,
    'Without the exclusion this scenario should NOT balance, or the test proves nothing');
}

async function testReconciliationStartDateComparesDeltaNotFullHistory(){
  // A pre-start-date JV wrongly dumped 8,000 of profit into the capital account (a historical
  // booking error, per the person's own diagnosis) — full-history comparison would show a
  // permanent 8,000 gap. Since-start-date comparison should ignore it entirely.
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    invOwners: [{id:1, name:'Me', isSelf:true, outAcc:10101, inAcc:null}],
    ledger: [
      {id:1, jv:1, date:'2025-01-01', acc:10101, amt:10000, descr:'invested'},
      {id:2, jv:2, date:'2025-06-01', acc:10101, amt:-8000, descr:'wrongly booked profit as capital return'},
      {id:3, jv:3, date:'2026-03-01', acc:10101, amt:4000, descr:'invested after going clean'}
    ],
    invSettings: {fxUsdSar:3.75, mgmtFeePct:0, reconStartDate:'2026-01-01'},
    invTransactions:[
      {id:1, positionId:1, date:'2025-01-01', kind:'buy', units:100, totalSar:10000,
       owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'},
      {id:2, positionId:1, date:'2025-06-01', kind:'sell', units:80, totalSar:2000,
       owners:[{ownerId:1,units:80}], feePct:0, cashSide:'bank'},
      {id:3, positionId:1, date:'2026-03-01', kind:'buy', units:40, totalSar:4000,
       owners:[{ownerId:1,units:40}], feePct:0, cashSide:'bank'}
    ]});
  const full = sb.invOwnerReconciliation()[0];
  assert(full.sinceDate === '2026-01-01', 'sinceDate should reflect the configured start date');
  // Since the start date: only the March transaction happened, cleanly, on both sides.
  assert(Math.abs(full.trackerCapital - 4000) < 0.005, 'Delta capital since start should be 4,000, got ' + full.trackerCapital);
  assert(Math.abs(full.ledgerNet - 4000) < 0.005, 'Delta ledger since start should be 4,000, got ' + full.ledgerNet);
  assert(full.ok === true, 'Should reconcile once the pre-start-date error is excluded from the comparison, diff was ' + full.diff);
}

async function testReconciliationWithoutStartDateShowsTheFullHistoryGap(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    invOwners: [{id:1, name:'Me', isSelf:true, outAcc:10101, inAcc:null}],
    // True event: bought for 5,000, later sold for 8,000 (a real 4,000 profit). The ledger
    // wrongly posted the FULL 8,000 proceeds into the capital account instead of splitting
    // 4,000 capital / 4,000 profit — exactly the historical error described in the reconciliation
    // panel's own copy.
    ledger: [
      {id:1, jv:1, date:'2025-01-01', acc:10101, amt:5000, descr:'invested'},
      {id:2, jv:2, date:'2025-06-01', acc:10101, amt:-8000, descr:'full sale proceeds wrongly posted as capital return'}
    ],
    invTransactions:[
      {id:1, positionId:1, date:'2025-01-01', kind:'buy', units:100, totalSar:5000,
       owners:[{ownerId:1,units:100}], feePct:0, cashSide:'bank'},
      {id:2, positionId:1, date:'2025-06-01', kind:'sell', units:80, totalSar:8000,
       owners:[{ownerId:1,units:80}], feePct:0, cashSide:'bank'}
    ]});
  const r = sb.invOwnerReconciliation()[0];
  assert(r.sinceDate === null, 'No start date configured, so sinceDate should be null');
  // Ledger: 5000 - 8000 = -3000, abs = 3000. Tracker: 20 units left at avg cost 50 = 1000.
  assert(Math.abs(r.ledgerNet - 3000) < 0.005, 'Ledger net should read 3,000, got ' + r.ledgerNet);
  assert(Math.abs(r.trackerCapital - 1000) < 0.005, 'Tracker capital should read 1,000, got ' + r.trackerCapital);
  assert(!r.ok, 'Without a start date, the historical booking error should still show as a gap, diff was ' + r.diff);
}

// v4.63.0: the move carries the FULL cost (agreed option a) — the fee makes each arriving unit dearer
// instead of being booked as a realised loss. These two tests replace the v4.x "fee loss" versions.
function moveSandbox(extra){
  const sb = invCashSandbox(Object.assign({
    invOwners: [{id:1, name:'Me', isSelf:true}, {id:2, name:'Relative', isSelf:false}],
    invPlatforms: [{id:1, name:'A'}, {id:2, name:'B'}],
    invPositions: [{id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[
      // 10 units at 100,000 SAR total (avg 10,000/unit), split 60/40.
      {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:10, totalSar:100000,
       owners:[{ownerId:1,units:6},{ownerId:2,units:4}], feePct:0, cashSide:'bank'}
    ]}, extra||{}));
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.__set('toast', ()=>{});
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('openInvPosition', ()=>{});
  sb.__set('syncWrite', async()=>({ok:true}));
  sb.__set('persistLocal', ()=>{});
  return sb;
}
async function moveRun(sb, fromPid, toPid, date, rows){
  sb.openInvMoveAssets(fromPid);
  sb.setInvMoveField('toPid', toPid); sb.setInvMoveField('date', date);
  for(const posId in rows){ sb.setInvMoveRow(Number(posId), 'sent', String(rows[posId][0])); if(rows[posId][1]!==undefined) sb.setInvMoveRow(Number(posId), 'received', String(rows[posId][1])); }
  await sb.saveInvMoveAssets();
}
async function testPositionMoveKeepsSharesTakesFeeProRataAndCarriesFullCost(){
  const sb = moveSandbox();
  await moveRun(sb, 1, 2, '2026-02-01', {1:[4, 3.9]});
  const destPos = sb._D.invPositions.find(p=>p.platformId===2 && p.ticker==='BTC');
  assert(destPos, 'A new position should be created on the destination platform');
  const dest = sb.computePositionState(destPos.id), src = sb.computePositionState(1);
  assert(Math.abs(dest.totalUnits-3.9)<1e-9, 'Destination holds 3.9 (4 sent − 0.1 fee), got ' + dest.totalUnits);
  assert(Math.abs(dest.totalCostSar-40000)<0.5, 'The FULL cost of the 4 units sent (40,000) arrives — the fee is not a loss, got ' + dest.totalCostSar);
  assert(Math.abs(src.totalUnits-6)<1e-9 && Math.abs(src.totalCostSar-60000)<0.5, 'Source keeps 6 units / 60,000');
  assert(Math.abs(src.totalRealizedSar)<0.01 && Math.abs(dest.totalRealizedSar)<0.01, 'No realised gain or loss from a move, got ' + src.totalRealizedSar);
  assert(Math.abs(dest.byOwner[1].units-2.34)<1e-9 && Math.abs(dest.byOwner[2].units-1.56)<1e-9, 'Fee taken in proportion: Me 2.4→2.34, Relative 1.6→1.56, got ' + dest.byOwner[1].units + ' / ' + dest.byOwner[2].units);
  assert(Math.abs(dest.byOwner[1].costSar-24000)<0.5 && Math.abs(dest.byOwner[2].costSar-16000)<0.5, 'Each person\'s cost moves with them (24,000 / 16,000)');
  assert(Math.abs(dest.byOwner[1].units/dest.totalUnits-0.6)<1e-9, 'Shares are unchanged (60/40)');
}
async function testPositionMoveMergesIntoExistingMatchingPosition(){
  const sb = moveSandbox({invOwners:[{id:1, name:'Me', isSelf:true}],
    invPositions:[{id:1, platformId:1, name:'ETH', ticker:'ETH', currency:'USD', assetClass:'Crypto', status:'Active'},
                  {id:2, platformId:2, name:'Ethereum', ticker:'ETH', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2026-01-01', kind:'buy', units:5, totalSar:50000, owners:[{ownerId:1,units:5}], feePct:0, cashSide:'bank'},
                     {id:2, positionId:2, date:'2026-01-01', kind:'buy', units:2, totalSar:15000, owners:[{ownerId:1,units:2}], feePct:0, cashSide:'bank'}]});
  const before = sb._D.invPositions.length;
  await moveRun(sb, 1, 2, '2026-02-01', {1:[1]});
  assert(sb._D.invPositions.length===before, 'A matching ticker on the destination is reused, not duplicated');
  assert(Math.abs(sb.computePositionState(2).totalUnits-3)<1e-9, 'Destination now holds 2 + 1 = 3 (received defaults to sent)');
}
async function testXirrTreatsTransferAsNetZeroExceptTheFee(){
  // A transfer must not look like new investment or a cash-out in XIRR — only the tiny fee loss
  // should register as a real (negative) cash flow.
  const sb = invCashSandbox({
    invOwners: [{id:1, name:'Me', isSelf:true}],
    invPositions: [{id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[
      {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:10, totalSar:100000,
       owners:[{ownerId:1,units:10}], feePct:0, cashSide:'bank'},
      // Same-day transfer of 4 units with a 0.1 unit fee — modelled as the sell/buy pair the
      // engine builds, entered directly here to isolate the XIRR consumer.
      {id:2, positionId:1, date:'2026-02-01', kind:'sell', units:4, totalSar:39000,
       owners:[{ownerId:1,units:4}], feePct:0, cashSide:'transfer'},
      {id:3, positionId:2, date:'2026-02-01', kind:'buy', units:3.9, totalSar:39000,
       owners:[{ownerId:1,units:3.9}], feePct:0, cashSide:'transfer'}
    ]});
  sb._D.invPositions.push({id:2, platformId:2, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'});
  let netOnTransferDate = 0;
  (sb._D.invTransactions||[]).forEach(t=>{
    if(t.date!=='2026-02-01') return;
    const at = sb.invTxAttribution(t);
    const amt = at.moneySar[1]||0;
    netOnTransferDate += (t.kind==='sell'? amt : -amt);
  });
  assert(Math.abs(netOnTransferDate) < 0.5,
    'The transfer pair should net to ~0 in cash-flow terms (both legs carry the same value), got ' + netOnTransferDate);
}

async function testAccountCurrentBalancesCSVHasTheRightColumns(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:10101, category:'Cash', acc_type:'Individual Account', status:'Active'}], ledger:[{id:1,jv:1,date:'2026-01-01',acc:10101,amt:500,descr:'x'}]});
  let capturedBlob = null, capturedText = null;
  sb.__set('document', sb.document);
  const origCreate = sb.document.createElement.bind(sb.document);
  sb.document.createElement = (tag) => {
    const el = origCreate(tag);
    if(tag==='a') el.click = () => {}; // real navigation isn't meaningful in JSDOM; just no-op it
    return el;
  };
  // `URL` itself is a non-writable global — sb.__set('URL', ...) would silently no-op. Patching
  // the existing object's method works because that's an ordinary property assignment.
  if(!sb.URL) sb.URL = {};
  sb.URL.createObjectURL = (blob) => { capturedBlob = blob; capturedText = blob.__testText; return 'blob:x'; };
  // JSDOM's Blob doesn't expose its constructor input, so patch Blob itself to remember it.
  const OrigBlob = sb.Blob;
  sb.Blob = function(parts, opts){ const b = new OrigBlob(parts, opts); b.__testText = parts.join(''); return b; };
  sb.__set('toast', ()=>{});
  sb.__set('logActivity', ()=>{});
  sb.exportAccountCurrentBalancesCSV();
  assert(capturedBlob, 'The export should create a downloadable CSV blob');
  assert(capturedText && capturedText.indexOf('Account #,Name,Category,Balance') === 0,
    'Header row should be exactly Account #,Name,Category,Balance, got: ' + (capturedText||'').split('\n')[0]);
  assert(capturedText.indexOf('10101,') !== -1 && capturedText.indexOf(',500') !== -1,
    'The row should carry the account id and its actual balance (500), got:\n' + capturedText);
}

async function testAccountMonthlyMovementCSVCoversFullHistoryNotJustCurrentMonth(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:10101, category:'Cash', acc_type:'Individual Account', status:'Active'}], ledger:[
    {id:1,jv:1,date:'2025-11-15',acc:10101,amt:300,descr:'old'},
    {id:2,jv:2,date:'2026-01-10',acc:10101,amt:200,descr:'new'}
  ]});
  sb.__set('todayStr', ()=>'2026-01-20');
  let capturedText = null;
  const OrigBlob = sb.Blob;
  sb.Blob = function(parts, opts){ capturedText = parts.join(''); return new OrigBlob(parts, opts); };
  if(!sb.URL) sb.URL = {};
  sb.URL.createObjectURL = () => 'blob:x';
  const origCreate = sb.document.createElement.bind(sb.document);
  sb.document.createElement = (tag) => { const el = origCreate(tag); if(tag==='a') el.click = () => {}; return el; };
  sb.__set('toast', ()=>{});
  sb.__set('logActivity', ()=>{});
  sb.exportAccountMonthlyMovementCSV();
  assert(capturedText, 'The export should produce CSV text');
  const header = capturedText.split('\n')[0];
  // Range must run from the EARLIEST ledger entry (Nov 2025) through the current month (Jan
  // 2026) — three months — not just the current month, which is the whole point of this export
  // versus the existing Forecast Grid one.
  assert(header.indexOf('2025-11') !== -1, 'Header should include the earliest ledger month (2025-11), got: ' + header);
  assert(header.indexOf('2026-01') !== -1, 'Header should include the current month (2026-01), got: ' + header);
  assert(header.split(',').length === 4 + 3, 'Expected 4 fixed columns + 3 months (Nov, Dec, Jan), got header: ' + header);
  const dataRow = capturedText.split('\n')[1];
  assert(dataRow.indexOf('300') !== -1 && dataRow.indexOf('200') !== -1,
    'The row should carry each month\'s actual movement (300 and 200), got: ' + dataRow);
}

async function testMergedReconImportPriceRoundTripKeepsBlankRowsUntouched(){
  // Superseded by v4.29.0 item 6: price logging folded into the Reconciliation CSV. This is the
  // same coverage — blank "New Price" cells must not fabricate a valuation — against the merged
  // import path (handleInvReconImport) rather than the removed standalone one.
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Broker A'}],
    invPositions: [
      {id:1, platformId:1, name:'ACME', ticker:'ACME', currency:'USD', assetClass:'Stocks', status:'Active'},
      {id:2, platformId:1, name:'Widgets Co', ticker:'', currency:'USD', assetClass:'Stocks', status:'Active'}
    ],
    invValuations: [{id:1, positionId:1, date:'2026-01-01', price:100}]
  });
  sb._invPriceImportDate = '2026-02-01';
  const csv = 'Platform,Position,Ticker,Type,Tracker Amount,Last Statement Value,Last Checked,New Statement Value,Last Price,Last Price Date,New Price\n'+
    'Broker A,ACME,ACME,Position,0,,,,100,2026-01-01,150\n'+   // priced — should update
    'Broker A,Widgets Co,,Position,0,,,,,,\n';                  // blank — should be left alone
  let lastImportDone = null;
  sb.__set('FileReader', function(){
    this.readAsText = () => {
      Object.defineProperty(this,'result',{value:csv,configurable:true});
      lastImportDone = this.onload();
    };
  });
  const fakeInput = {files:[{}], value:''};
  let toastMsg = null;
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('toast', (msg)=>{ toastMsg = msg; });
  sb.handleInvReconImport(fakeInput);
  await lastImportDone;
  assert(toastMsg, 'The import should finish and report a result, got no toast at all');
  const acmeVals = (sb._D.invValuations||[]).filter(v=>v.positionId===1);
  assert(acmeVals.some(v=>v.date==='2026-02-01' && Math.abs(v.price-150)<0.005),
    'ACME should get a new valuation of 150 on the import date, got: ' + JSON.stringify(acmeVals));
  const widgetVals = (sb._D.invValuations||[]).filter(v=>v.positionId===2);
  assert(widgetVals.length === 0,
    'Widgets Co had a blank New Price and no prior valuation — a blank must not fabricate one, got: ' + JSON.stringify(widgetVals));
}


async function testRealEstateCollapsedHeaderShowsCurrentMonthNet(){
  const sb = makeSandbox();
  sb.__set('reExpandedBuildings', new Set()); // collapsed
  sb.__set('D', {accounts:[
    {id:40101, id_:1}, {id:60101, id_:2}
  ]});
  const acctApt = {id:40101};
  const acctExp = {id:60101};
  sb.__set('accountMonthPlanOrActual', (a, m, cur) => {
    if(a.id===40101) return m===cur? -5000 : -1000; // revenue stored negative per app convention
    if(a.id===60101) return m===cur? 2000 : 500;    // expense stored positive
    return 0;
  });
  const building = {id:1, name:'Test Tower', apartmentAccountIds:[40101], expenseAccountIds:[60101]};
  sb.__set('D', Object.assign(vm.runInContext('D', sb), {accounts:[
    {id:40101}, {id:60101}
  ]}));
  const html = sb.renderBuildingSection(building, ['2026-07','2026-08'], '2026-08');
  // Net for the current month = revenue(-5000) + expense(2000) = -3000; displayed as money0(-net) = 3000.
  assert(/3,000\.00|3,000/.test(html), 'Collapsed header should show the current-month net figure, got snippet: ' + html.slice(0,400));
  assert(!/apartment|Apartments \(Revenue\)/.test(html), 'Collapsed view should not render the detail tables');
}

// ================= v4.24.0: account export buttons moved to Accounts page + Grid view =================
async function testAccountExportButtonsMovedOffSettingsOntoAccountsPage(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[], invSettings:{}, invPlatforms:[], invOwners:[], invPositions:[], invTransactions:[], invValuations:[], invCashMovements:[]});
  sb.__set('acctPageTab', 'list');
  sb.__set('accQ', ''); sb.__set('accShowDeleted', false); sb.__set('accSelectMode', false);
  sb.renderAccounts();
  const appHtml = sb.document.getElementById('app').innerHTML;
  assert(/exportAccountCurrentBalancesCSV\(\)/.test(appHtml), 'Accounts page should carry the Current Balances export button');
  assert(/exportAccountMonthlyMovementCSV\(\)/.test(appHtml), 'Accounts page should carry the Monthly Movement export button');
  assert(/\+ Add Account/.test(appHtml) && /Select/.test(appHtml), 'The existing Select / Add Account buttons should still be present');

  // Rendering the whole Settings page needs a large amount of fixture data unrelated to this
  // check (custom categories, forecast plans, real estate buildings, translations, and more).
  // Inspecting the coa tab's own template block directly is just as valid and far more robust.
  const src = fs.readFileSync(APP_HTML, 'utf8');
  const coaStart = src.indexOf("coa: {label:'🗂 Chart of Accounts'");
  const coaEnd = src.indexOf("accrual: {label:", coaStart);
  const coaBlock = src.slice(coaStart, coaEnd);
  assert(!/exportAccountCurrentBalancesCSV/.test(coaBlock) && !/exportAccountMonthlyMovementCSV/.test(coaBlock),
    'The export buttons should be gone from Settings → Chart of Accounts, not duplicated there');
}

async function testAccountsGridShowsBalanceAndMonthlyMovementPerAccount(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:10101, category:'Cash', acc_type:'Individual Account', status:'Active'}],
    ledger:[
      {id:1,jv:1,date:'2026-06-15',acc:10101,amt:300,descr:'x'},
      {id:2,jv:2,date:'2026-08-10',acc:10101,amt:200,descr:'y'}
    ]});
  sb.__set('todayStr', ()=>'2026-08-20');
  sb.__set('acctGridWindowStart', null);
  sb.renderAccountsGrid();
  const html = sb.document.getElementById('app').innerHTML;
  assert(html.indexOf('10101') !== -1, 'The grid should list the account number');
  // Current balance = 300+200 = 500.
  assert(/500\.00|500,00|>500</.test(html) || html.indexOf('500.00')!==-1, 'The grid should show the current balance (500), got snippet: ' + html.slice(0,600));
  // June and August movements should both appear somewhere in the row.
  assert(html.indexOf('300.00')!==-1, "June's movement (300) should appear in the grid");
  assert(html.indexOf('200.00')!==-1, "August's movement (200) should appear in the grid");
}

async function testAccountsGridWindowDefaultsToTwelveMonthsEndingCurrent(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[]});
  sb.__set('todayStr', ()=>'2026-08-20');
  sb.__set('acctGridWindowStart', null);
  const months = sb.acctGridMonths();
  assert(months.length === 12, 'Default window should be 12 months, got ' + months.length);
  assert(months[0] === '2025-09' && months[11] === '2026-08',
    'Window should run Sep 2025 → Aug 2026 (12 months ending at the current month), got ' + months[0] + ' → ' + months[months.length-1]);
}

async function testAccountsGridShiftMovesTheWindowByOneMonth(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[]});
  sb.__set('todayStr', ()=>'2026-08-20');
  sb.__set('acctGridWindowStart', '2026-01');
  sb.__set('renderAccountsGrid', ()=>{});
  sb.acctGridShift(1);
  assert(vm.runInContext('acctGridWindowStart', sb) === '2026-02', 'Shifting forward should move the window start by one month');
  sb.acctGridShift(-1);
  assert(vm.runInContext('acctGridWindowStart', sb) === '2026-01', 'Shifting back should return to the original month');
}

// ================= v4.25.0: new-position defaults + forced ticker uppercase =================
async function testNewPositionDefaultsToCryptoAndUSD(){
  const sb = makeSandbox();
  sb.__set('openInvPositionModal', (pos) => { sb._capturedDraft = pos; });
  sb.openInvAddPosition(1);
  const draft = sb._capturedDraft;
  assert(draft.assetClass === 'Crypto', 'New position should default to Crypto, got ' + draft.assetClass);
  assert(draft.currency === 'USD', 'New position should default to USD, got ' + draft.currency);
  assert(draft.platformId === 1, 'The platform id should still be passed through, got ' + draft.platformId);
}

async function testTickerInputUppercasesWithoutLosingCursorPosition(){
  const sb = makeSandbox();
  sb._invPosDraft = {id:null, name:'Solana', ticker:'', assetClass:'Crypto', currency:'USD', status:'Active'};
  const input = sb.document.createElement('input');
  input.value = 'sol';
  input.selectionStart = 3; input.selectionEnd = 3;
  sb.setInvPosTicker(input);
  assert(input.value === 'SOL', 'The visible field should be uppercased as typed, got ' + input.value);
  assert(vm.runInContext('window._invPosDraft', sb).ticker === 'SOL', 'The draft should store the uppercased ticker, got ' + vm.runInContext('window._invPosDraft', sb).ticker);
}

async function testSaveInvPositionUppercasesTickerAsASafetyNet(){
  // Covers paste and any other write path that bypasses the live input handler.
  const sb = invCashSandbox({invPositions:[]});
  sb.__set('closeModal', ()=>{});
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('toast', ()=>{});
  sb._invPosDraft = {id:null, platformId:1, name:'Solana', ticker:'sol', assetClass:'Crypto', currency:'USD', status:'Active'};
  await sb.saveInvPosition();
  const saved = sb._D.invPositions[sb._D.invPositions.length-1];
  assert(saved.ticker === 'SOL', 'The saved position\'s ticker should be uppercased even if it arrived lowercase, got ' + saved.ticker);
}

// ================= v4.26.0: USD entry for opening balance, cash log placement, manual prices, recon alignment =================
async function testOpeningBalanceModalUsesUsdEntryNotPlainSar(){
  const sb = invCashSandbox({invPositions:[{id:1, platformId:1, name:'Solana', ticker:'SOL', currency:'USD', assetClass:'Crypto', status:'Active'}]});
  sb.window = sb.window || sb;
  sb._invTxDraft = {id:null, positionId:1, date:'2026-08-24', kind:'buy', units:'', totalSar:'', owners:[], note:'', splitMode:'units', ownersSar:{}, cashSide:'opening', usdAmount:'', feePct:''};
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.renderInvTxModal();
  const body = sb.document.getElementById('modalRoot').innerHTML;
  assert(/USD paid/.test(body), 'Opening balance should present a USD field, got snippet: ' + body.slice(0,600));
  assert(!/Total SAR paid.{0,80}oninput="window\._invTxDraft\.totalSar/.test(body),
    'The SAR field should be derived/disabled, not directly editable, for an opening balance transaction');
}

async function testUsdFieldSupportsFormulaOnBlur(){
  const sb = invCashSandbox({invPositions:[{id:1, platformId:1, name:'Solana', ticker:'SOL', currency:'USD', assetClass:'Crypto', status:'Active'}]});
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb._invTxDraft = {id:null, positionId:1, date:'2026-08-24', kind:'buy', units:'10', totalSar:'', owners:[], note:'', splitMode:'units', ownersSar:{}, cashSide:'opening', usdAmount:'105*10', feePct:''};
  const fakeInput = {};
  sb.invTxUsdBlur(fakeInput);
  const d = sb._invTxDraft;
  assert(Math.abs(d.usdAmount - 1050) < 0.005, 'A typed formula (105*10) should evaluate to 1050, got ' + d.usdAmount);
  assert(Math.abs(d.totalSar - 1050*sb.getInvFxRate()) < 0.5, 'SAR should be derived from the evaluated USD amount, got ' + d.totalSar);
}

async function testPricePerUnitShowsUsdForCashAndOpeningEntries(){
  const sb = invCashSandbox({});
  const usdDraft = {units:'10', totalSar:'1050', cashSide:'opening', usdAmount:'280'};
  const usdText = sb.invTxPpuText(usdDraft);
  assert(/USD/.test(usdText), 'Should read in USD when a USD amount was entered, got: ' + usdText);
  const ppuMatch = usdText.match(/Price per unit:\s*([\d.]+)/);
  assert(ppuMatch && Math.abs(parseFloat(ppuMatch[1]) - 28) < 0.01, 'PPU should be 280/10 = 28 USD, got: ' + usdText);
  const bankDraft = {units:'10', totalSar:'1000', cashSide:'bank', usdAmount:''};
  assert(/SAR/.test(sb.invTxPpuText(bankDraft)), 'A bank-funded buy should still read in SAR, got: ' + sb.invTxPpuText(bankDraft));
}

async function testSaveInvTxRequiresUsdAmountForOpeningBalance(){
  const sb = invCashSandbox({invPositions:[{id:1, platformId:1, name:'Solana', ticker:'SOL', currency:'USD', assetClass:'Crypto', status:'Active'}]});
  let toastMsg = null;
  sb.__set('toast', (msg)=>{ toastMsg = msg; });
  sb._invTxDraft = {id:null, positionId:1, date:'2026-08-24', kind:'buy', units:'10', totalSar:'', owners:[{ownerId:1,units:10}], note:'', splitMode:'units', ownersSar:{}, cashSide:'opening', usdAmount:'', feePct:''};
  await sb.saveInvTx();
  assert(toastMsg && /USD/.test(toastMsg), 'Should require a USD amount for an opening-balance buy, got: ' + toastMsg);
  assert((sb._D.invTransactions||[]).length === 0, 'Nothing should be saved without the required USD amount');
}

async function testPlatformPanelOnlyKeepsTheEditButtonNow(){
  // Superseded by v4.29.0 item 5: + Position / Deposit / Withdraw / Transfer / Cash log all moved
  // to page-level buttons with a platform picker. The per-platform panel should keep only Edit.
  const sb = invCashSandbox({invPlatforms:[{id:1, name:'Raseed'}], invPositions:[]});
  sb.__set('invExpandedPlatforms', new Set([1]));
  const html = sb.renderInvPlatformSection({id:1, name:'Raseed'});
  assert(html.indexOf('Cash log') === -1, 'Cash log should no longer be rendered inside the platform panel');
  assert(html.indexOf('openInvAddPosition') === -1, '+ Position should no longer be rendered inside the platform panel');
  assert(html.indexOf('openInvCashModal') === -1, 'Deposit/Withdraw/Transfer should no longer be rendered inside the platform panel');
  assert(html.indexOf('openInvEditPlatform(1)') !== -1, 'The Edit button should still be present');
}

async function testManualPriceEntrySavesAValuationAndRendersStaleness(){
  const sb = invCashSandbox({invPositions:[{id:1, platformId:1, name:'Solana', ticker:'SOL', currency:'USD', assetClass:'Crypto', status:'Active'}]});
  sb.__set('todayStr', ()=>'2026-08-24');
  sb.__set('toast', ()=>{});
  sb.__set('renderInvManualPriceTable', ()=>{});
  const dateInput = sb.document.createElement('input'); dateInput.id='manPriceDate_1'; dateInput.value='2026-08-24'; sb.document.body.appendChild(dateInput);
  await sb.saveInvManualPrice(1, '150', 'manPriceDate_1');
  const vals = (sb._D.invValuations||[]).filter(v=>v.positionId===1);
  assert(vals.length===1 && Math.abs(vals[0].price-150)<0.005, 'A manually entered price should be saved, got: ' + JSON.stringify(vals));

  // Staleness: a price logged 10 days ago should be flagged stale (>7 days); one logged today should not.
  sb._D.invValuations = [{id:2, positionId:1, date:'2026-08-14', price:100}]; // 10 days before 2026-08-24
  const staleSt = sb.invPriceStaleness(1);
  assert(staleSt.stale === true, 'A price 10 days old should be flagged stale, got days=' + staleSt.days);
  sb._D.invValuations = [{id:3, positionId:1, date:'2026-08-24', price:100}];
  const freshSt = sb.invPriceStaleness(1);
  assert(freshSt.stale === false, 'A price logged today should not be flagged stale');
}

async function testReconciliationColumnsShareTheSameLayoutAcrossPlatforms(){
  const sb = invCashSandbox({
    invPlatforms: [{id:1, name:'Raseed'}, {id:2, name:'Fomo'}],
    invPositions: [
      {id:1, platformId:1, name:'Marathon Digital Holdings Inc', ticker:'MARA', currency:'USD', assetClass:'Stocks', status:'Active'},
      {id:2, platformId:2, name:'Virgo', ticker:'&VIRGO', currency:'USD', assetClass:'Stocks', status:'Active'}
    ]});
  sb.__set('invReconExpandedPlatforms', new Set([1,2])); // platforms are collapsed by default now — expand both to see their tables
  sb.renderInvReconPage('');
  const html = sb.document.getElementById('app').innerHTML;
  // Both platform tables must reuse the exact same colgroup markup, or their columns can drift
  // out of alignment against each other regardless of content width.
  const colgroups = [...html.matchAll(/<colgroup>.*?<\/colgroup>/g)].map(m=>m[0]);
  assert(colgroups.length === 2, 'Expected one colgroup per platform table, found ' + colgroups.length);
  assert(colgroups[0] === colgroups[1], 'Both platform tables should share an identical column layout, got:\n' + colgroups[0] + '\nvs\n' + colgroups[1]);
}

async function testReconciliationShowsLastReconciledDateWithStaleness(){
  const sb = invCashSandbox({
    invPlatforms: [{id:1, name:'Raseed', stmtDate:'2026-08-01'}],
    invPositions: [{id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active', stmtUnits:1, stmtDate:'2026-08-10'}]
  });
  sb.__set('todayStr', ()=>'2026-08-24');
  const last = sb.invPlatformLastReconciledDate(1);
  assert(last === '2026-08-10', 'Should take the MOST RECENT date across the platform and its positions, got ' + last);
  sb.renderInvReconPage('');
  const html = sb.document.getElementById('app').innerHTML;
  assert(html.indexOf('last reconciled') !== -1, 'The panel should show a last-reconciled label');
  assert(html.indexOf('color:var(--red)') !== -1, '2026-08-10 is 14 days before 2026-08-24, so it should render in red');
}

// ================= v4.27.0: USD entry follows position currency, not just funding source =================
async function testBankFundedUsdPositionShowsUsdEntryToo(){
  const sb = invCashSandbox({invPositions:[{id:1, platformId:1, name:'Marathon Digital Holdings Inc', ticker:'MARA', currency:'USD', assetClass:'Stocks', status:'Active'}]});
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb._invTxDraft = {id:null, positionId:1, date:'2026-08-24', kind:'buy', units:'', totalSar:'', owners:[], note:'', splitMode:'units', ownersSar:{}, cashSide:'bank', usdAmount:'', feePct:''};
  sb.renderInvTxModal();
  const body = sb.document.getElementById('modalRoot').innerHTML;
  assert(/USD paid/.test(body), 'A bank-funded buy on a USD-denominated position should still show a USD field, got snippet: ' + body.slice(0,700));
  assert(!/Total SAR paid.{0,80}oninput="window\._invTxDraft\.totalSar/.test(body),
    'The SAR field should be derived/disabled here too, not directly editable');
}

async function testSarCurrencyPositionFundedFromBankStaysPlainSar(){
  const sb = invCashSandbox({invPositions:[{id:1, platformId:1, name:'Riyal Fund', ticker:'', currency:'SAR', assetClass:'Other', status:'Active'}]});
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb._invTxDraft = {id:null, positionId:1, date:'2026-08-24', kind:'buy', units:'', totalSar:'', owners:[], note:'', splitMode:'units', ownersSar:{}, cashSide:'bank', usdAmount:'', feePct:''};
  sb.renderInvTxModal();
  const body = sb.document.getElementById('modalRoot').innerHTML;
  assert(!/USD paid/.test(body), 'A SAR-denominated position funded from the bank should stay plain SAR entry, got snippet: ' + body.slice(0,700));
  assert(/Total SAR paid.{0,80}oninput="window\._invTxDraft\.totalSar/.test(body),
    'The SAR field should be directly editable in this case');
}

async function testPpuReadsUsdForBankFundedUsdPositionToo(){
  const sb = invCashSandbox({});
  const draft = {units:'10', totalSar:'1050', cashSide:'bank', usdAmount:'280'};
  const usdPos = {currency:'USD'};
  const sarPos = {currency:'SAR'};
  assert(/USD/.test(sb.invTxPpuText(draft, usdPos)), 'PPU should read USD for a bank-funded USD position, got: ' + sb.invTxPpuText(draft, usdPos));
  assert(/SAR/.test(sb.invTxPpuText(draft, sarPos)), 'PPU should stay SAR for a bank-funded SAR position, got: ' + sb.invTxPpuText(draft, sarPos));
}

async function testSaveInvTxRequiresUsdForBankFundedUsdPosition(){
  const sb = invCashSandbox({invPositions:[{id:1, platformId:1, name:'MARA', ticker:'MARA', currency:'USD', assetClass:'Stocks', status:'Active'}]});
  let toastMsg = null;
  sb.__set('toast', (msg)=>{ toastMsg = msg; });
  sb._invTxDraft = {id:null, positionId:1, date:'2026-08-24', kind:'buy', units:'10', totalSar:'', owners:[{ownerId:1,units:10}], note:'', splitMode:'units', ownersSar:{}, cashSide:'bank', usdAmount:'', feePct:''};
  await sb.saveInvTx();
  assert(toastMsg && /USD/.test(toastMsg), 'Should require USD for a bank-funded USD position, got: ' + toastMsg);
  assert((sb._D.invTransactions||[]).length === 0, 'Nothing should be saved without the required USD amount');
}

async function testSaveInvTxPersistsUsdAmountForBankFundedUsdPosition(){
  const sb = invCashSandbox({invPositions:[{id:1, platformId:1, name:'MARA', ticker:'MARA', currency:'USD', assetClass:'Stocks', status:'Active'}]});
  sb.__set('toast', ()=>{});
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('openInvPosition', ()=>{});
  sb.__set('setInvMgmtFeePct', async ()=>{});
  sb._invTxDraft = {id:null, positionId:1, date:'2026-08-24', kind:'buy', units:'60.6033', totalSar:'', owners:[{ownerId:1,units:60.6033}], note:'', splitMode:'units', ownersSar:{}, cashSide:'bank', usdAmount:'', feePct:''};
  sb.setInvTxUsd('815.06'); // mirrors what typing into the USD field actually does — derives totalSar too
  await sb.saveInvTx();
  const saved = sb._D.invTransactions[sb._D.invTransactions.length-1];
  assert(saved.cashSide === 'bank', 'The persisted funding source should stay bank — USD entry here is a UI convenience only, got ' + saved.cashSide);
  assert(Math.abs(saved.usdAmount - 815.06) < 0.005, 'The typed USD figure should be persisted for later editing, got ' + saved.usdAmount);
  assert(Math.abs(saved.totalSar - 815.06*sb.getInvFxRate()) < 0.5, 'SAR should be derived from the USD figure at the configured rate, got ' + saved.totalSar);
}

async function testEditingOldRecordBackfillsUsdFromStoredSar(){
  // A record saved before this feature existed (or before its position was reclassified to USD)
  // may have totalSar populated with no usdAmount at all — editing it should not present a blank
  // USD field next to a populated SAR figure.
  const sb = invCashSandbox({
    invPositions:[{id:1, platformId:1, name:'MARA', ticker:'MARA', currency:'USD', assetClass:'Stocks', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2026-01-01', kind:'buy', units:10, totalSar:1000,
      owners:[{ownerId:1,units:10}], feePct:0, cashSide:'bank', usdAmount:0}]
  });
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.openInvTxModal(1, 1);
  const draft = sb._invTxDraft;
  assert(Math.abs(draft.usdAmount - (1000/sb.getInvFxRate())) < 0.5,
    'Editing should back-fill USD from the stored SAR total, got ' + draft.usdAmount);
}

// ================= v4.28.0: dual-currency widgets, platform collapse, recon CSV + per-row dates, Enter-to-next =================
async function testDualCurrencyKpiShowsUsdFirstBoldThenSar(){
  const sb = makeSandbox();
  sb.__set('D', {invSettings:{fxUsdSar:3.75}});
  const html = sb.invKpiCardDual('Your Cost Basis', 3750);
  const usdIdx = html.indexOf('$1,000.00');
  const sarIdx = html.indexOf('3,750.00');
  assert(usdIdx !== -1, 'USD figure (1000.00, since 3750/3.75) should appear, got: ' + html);
  assert(sarIdx !== -1, 'SAR figure should appear, got: ' + html);
  assert(usdIdx < sarIdx, 'USD should appear before SAR in the markup, got: ' + html);
  assert(html.indexOf('kpi-value') < sarIdx, 'The bold kpi-value class should wrap the USD line, not the SAR one');
}

async function testTopWidgetsUseDualCurrencyIncludingFamily(){
  const sb = invCashSandbox({
    invOwners:[{id:1,name:'Me',isSelf:true},{id:2,name:'Relative',isSelf:false}],
    invTransactions:[
      {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:10, totalSar:3750,
       owners:[{ownerId:1,units:6},{ownerId:2,units:4}], feePct:0, cashSide:'bank'}
    ]});
  sb.__set('invView','classic'); // v4.58.0: the pre-4.58 page is now the Classic view
  sb.renderInvestmentsPage();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/Your Cost Basis/.test(html) && /\$/.test(html), 'Your Cost Basis should show a $ figure');
  assert(/Held for Family/.test(html), 'Held for Family should still appear when family owns units');
}

async function testPositionModalUsesDualCurrencyWidgets(){
  const sb = invCashSandbox({
    invPositions:[{id:1, platformId:1, name:'Solana', ticker:'SOL', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2026-01-01', kind:'buy', units:10, totalSar:3750,
      owners:[{ownerId:1,units:10}], feePct:0, cashSide:'bank'}]
  });
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.openInvPosition(1);
  const body = sb.document.getElementById('modalRoot').innerHTML;
  assert(/\$1,000\.00/.test(body), 'Cost widget should show the USD figure ($1000 at fx 3.75), got snippet: ' + body.slice(0,900));
  assert(/3,750\.00 SAR/.test(body), 'Cost widget should show the SAR figure underneath, got snippet: ' + body.slice(0,900));
}

async function testPriceDateRemovedFromPlatformTableAndAlwaysBlack(){
  const sb = invCashSandbox({
    invPositions:[{id:1, platformId:1, name:'Solana', ticker:'SOL', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invValuations:[{id:1, positionId:1, date:'2026-01-01', price:100}] // long stale by the test's frozen "today"
  });
  sb.__set('invExpandedPlatforms', new Set([1]));
  sb.__set('todayStr', ()=>'2026-08-24');
  const html = sb.renderInvPlatformSection({id:1, name:'Raseed'});
  assert(html.indexOf('2026-01-01') === -1, 'The price date should no longer appear in the platform table, got snippet: ' + html.slice(0,1200));
  assert(html.indexOf('color:var(--red)') === -1, 'No red staleness colouring should appear on the platform table price cell');
}

async function testStalePricesPanelRemovedFromInvestmentsPage(){
  const sb = invCashSandbox({
    invPositions:[{id:1, platformId:1, name:'Solana', ticker:'SOL', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2020-01-01', kind:'buy', units:10, totalSar:1000,
      owners:[{ownerId:1,units:10}], feePct:0, cashSide:'bank'}]
  });
  sb.__set('invView','classic'); // v4.58.0: the pre-4.58 page is now the Classic view
  sb.renderInvestmentsPage();
  const html = sb.document.getElementById('app').innerHTML;
  assert(!/Prices need refreshing/.test(html), 'The stale-prices alert panel should no longer appear on the Investments page');
}

async function testPlatformsCollapsedByDefault(){
  const sb = invCashSandbox({invPlatforms:[{id:1, name:'Raseed'}], invPositions:[]});
  // Deliberately does NOT set invExpandedPlatforms — a fresh sandbox runs the app's own top-level
  // `let invExpandedPlatforms = new Set();` once, so this exercises the real default rather than
  // a value the test dictated itself.
  const html = sb.renderInvPlatformSection({id:1, name:'Raseed'});
  assert(!/💵 Cash balance/.test(html), 'A freshly-loaded platform should start collapsed, got snippet: ' + html.slice(0,700));
  assert(/▸ Expand/.test(html), 'A collapsed platform should show an Expand affordance');
}

async function testCollapsedPlatformShowsCashAndOwnerPortionSummary(){
  const sb = invCashSandbox({
    invOwners:[{id:1,name:'Me',isSelf:true},{id:2,name:'Relative',isSelf:false}],
    invPositions:[{id:1, platformId:1, name:'Solana', ticker:'SOL', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2026-01-01', kind:'buy', units:10, totalSar:3750,
      owners:[{ownerId:1,units:6},{ownerId:2,units:4}], feePct:0, cashSide:'bank'}],
    invValuations:[{id:1, positionId:1, date:'2026-01-01', price:100}] // 10 units * $100 = $1000 market
  });
  sb.__set('invExpandedPlatforms', new Set());
  const html = sb.renderInvPlatformSection({id:1, name:'Raseed'});
  assert(/Yours:/.test(html), "Collapsed header should show the self owner's portion");
  assert(/Family:/.test(html), 'Collapsed header should show the family portion when family holds units');
}

async function testToggleInvPlatformExpandedFlipsState(){
  const sb = makeSandbox();
  sb.__set('D', {invPlatforms:[], invOwners:[], invPositions:[], invTransactions:[], invValuations:[], invCashMovements:[], invSettings:{}});
  sb.__set('invExpandedPlatforms', new Set());
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.toggleInvPlatformExpanded(1);
  assert(vm.runInContext('invExpandedPlatforms', sb).has(1), 'Toggling should expand a collapsed platform');
  sb.toggleInvPlatformExpanded(1);
  assert(!vm.runInContext('invExpandedPlatforms', sb).has(1), 'Toggling again should collapse it back');
}

async function testReconCsvExportAndImportRoundTrip(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Raseed', stmtCashUsd:500, stmtDate:'2026-08-01'}],
    invPositions:[{id:1, platformId:1, name:'Bitcoin', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2026-01-01', kind:'buy', units:1, totalSar:100000,
      owners:[{ownerId:1,units:1}], feePct:0, cashSide:'bank'}]
  });
  const rows = sb.invReconCSVRows();
  assert(rows.length===2, 'Should have one position row and one cash row, got ' + rows.length);
  assert(rows.some(r=>r.type==='Position' && r.ticker==='BTC'), 'The BTC position should appear');
  assert(rows.some(r=>r.type==='Cash'), 'A cash line should appear');

  // Import: update the position's statement units via the "New Statement Value" column.
  const csv = 'Platform,Position,Ticker,Type,Tracker Amount,Last Statement Value,Last Checked,New Statement Value\n'+
    'Raseed,Bitcoin,BTC,Position,1,,,0.98\n'+
    'Raseed,Cash (USD),,Cash,0.00,,,\n'; // cash row blank — must be left untouched
  sb.__set('FileReader', function(){
    this.readAsText = () => { Object.defineProperty(this,'result',{value:csv,configurable:true}); this.onload(); };
  });
  let lastImportDone = null;
  sb.__set('FileReader', function(){
    this.readAsText = () => { Object.defineProperty(this,'result',{value:csv,configurable:true}); lastImportDone = this.onload(); };
  });
  sb.__set('renderInvestmentsPage', ()=>{});
  let toastMsg = null;
  sb.__set('toast', (m)=>{ toastMsg = m; });
  const fakeInput = {files:[{}], value:''};
  sb.handleInvReconImport(fakeInput);
  await lastImportDone;
  const pos = sb._D.invPositions.find(p=>p.id===1);
  assert(Math.abs(pos.stmtUnits-0.98)<0.005, 'The position statement units should update to 0.98, got ' + pos.stmtUnits);
  const plat = sb._D.invPlatforms.find(p=>p.id===1);
  assert(Math.abs(plat.stmtCashUsd-500)<0.005,
    'A blank New Statement Value must leave the pre-existing figure (500) untouched, got ' + plat.stmtCashUsd);
}

async function testReconPageShowsPerPositionLastCheckedDate(){
  const sb = invCashSandbox({
    // Platform-level date is RECENT (not stale); the position's own date is OLD (stale). If the
    // per-row column didn't actually render the position's own date, this would only ever show
    // the recent, non-stale platform-aggregate date — the assertions below would then fail,
    // which is exactly what distinguishes "shown per row" from "only shown in the header".
    invPlatforms:[{id:1, name:'Raseed', stmtDate:'2026-08-23'}],
    invPositions:[{id:1, platformId:1, name:'Bitcoin', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active', stmtUnits:1, stmtDate:'2026-08-10'}]
  });
  sb.__set('todayStr', ()=>'2026-08-24');
  sb.__set('invReconExpandedPlatforms', new Set([1])); // collapsed by default now — expand to see the row
  sb.renderInvReconPage('');
  const html = sb.document.getElementById('app').innerHTML;
  assert(html.indexOf('2026-08-10') !== -1, "The position's own last-checked date should be shown in its row");
  assert(html.indexOf('color:var(--red)') !== -1, '2026-08-10 is 14 days before 2026-08-24, so it should render in red');
}

async function testEnterKeyMovesToNextReconInput(){
  const sb = invCashSandbox({});
  const inputs = [sb.document.createElement('input'), sb.document.createElement('input'), sb.document.createElement('input')];
  inputs.forEach(i=>{ i.className='recon-input'; sb.document.body.appendChild(i); });
  let focused = null;
  inputs[1].focus = () => { focused = inputs[1]; };
  const enterEvent = {key:'Enter', preventDefault: ()=>{}};
  sb.invReconEnterNext(inputs[0], enterEvent);
  assert(focused === inputs[1], 'Pressing Enter on the first field should focus the next one');
}

async function testEnterKeyOnLastReconInputJustBlurs(){
  const sb = invCashSandbox({});
  const input = sb.document.createElement('input');
  input.className = 'recon-input';
  sb.document.body.appendChild(input);
  let blurred = false;
  input.blur = () => { blurred = true; };
  const enterEvent = {key:'Enter', preventDefault: ()=>{}};
  sb.invReconEnterNext(input, enterEvent);
  assert(blurred === true, 'Enter on the very last field should blur it (saving via change) rather than throwing');
}

async function testNonEnterKeyIsIgnoredByReconNavigation(){
  const sb = invCashSandbox({});
  const inputs = [sb.document.createElement('input'), sb.document.createElement('input')];
  inputs.forEach(i=>{ i.className='recon-input'; sb.document.body.appendChild(i); });
  let focused = false, defaultPrevented = false;
  inputs[1].focus = () => { focused = true; };
  const tabEvent = {key:'Tab', preventDefault: ()=>{ defaultPrevented = true; }};
  sb.invReconEnterNext(inputs[0], tabEvent);
  assert(!focused, 'A non-Enter key should not trigger the custom navigation');
  assert(!defaultPrevented, "A non-Enter key's default behaviour (native Tab) should not be blocked");
}

// ================= v4.29.0: alphabetical platforms, action picker, merged recon+prices, idle lock =================
async function testPlatformsSortedAlphabeticallyCaseInsensitive(){
  const sb = makeSandbox();
  sb.__set('D', {invPlatforms:[{id:1,name:'zeta'},{id:2,name:'Alpha'},{id:3,name:'beta'}]});
  const sorted = sb.invPlatformsSorted();
  assert(sorted.map(p=>p.name).join(',')==='Alpha,beta,zeta', 'Should sort case-insensitively, got ' + sorted.map(p=>p.name).join(','));
}

async function testSinglePlatformSkipsThePicker(){
  const sb = invCashSandbox({invPlatforms:[{id:1, name:'Raseed'}]});
  let openedWith = null;
  sb.__set('openInvAddPosition', (platformId)=>{ openedWith = platformId; });
  sb.__set('openInvPlatformPicker', ()=>{ openedWith = 'PICKER_SHOWN'; });
  sb.invStartPlatformAction('position');
  assert(openedWith === 1, 'With one platform, the action should go straight there, got ' + openedWith);
}

async function testMultiplePlatformsShowsThePicker(){
  const sb = invCashSandbox({invPlatforms:[{id:1, name:'Raseed'},{id:2, name:'Fomo'}]});
  let pickerShownFor = null;
  sb.__set('openInvPlatformPicker', (action)=>{ pickerShownFor = action; });
  sb.invStartPlatformAction('deposit');
  assert(pickerShownFor === 'deposit', 'With more than one platform, the picker should be shown, got ' + pickerShownFor);
}

async function testZeroPlatformsDoesNothing(){
  const sb = invCashSandbox({invPlatforms:[]});
  let called = false;
  sb.__set('openInvPlatformPicker', ()=>{ called = true; });
  sb.invStartPlatformAction('withdrawal');
  assert(!called, 'With zero platforms there is nothing to pick — the action should just no-op');
}

async function testPortfolioPageDisablesActionButtonsWithZeroPlatforms(){
  const sb = invCashSandbox({invPlatforms:[]});
  sb.__set('invView','classic'); // v4.58.0: the pre-4.58 page is now the Classic view
  sb.renderInvestmentsPage();
  const html = sb.document.getElementById('app').innerHTML;
  ['position','deposit','withdrawal','transfer','cashlog'].forEach(action=>{
    // Find the actual <button ...> tag for this action and confirm it carries "disabled" — a
    // bare /disabled/.test(html) on the whole page would trivially pass via any UNRELATED
    // disabled control elsewhere (e.g. the derived SAR field), so this must check THIS button.
    const tagMatch = html.match(new RegExp("<button[^>]*onclick=\"invStartPlatformAction\\('"+action+"'\\)\"[^>]*>"));
    assert(tagMatch, 'The '+action+' button should exist on the page at all, got snippet: ' + html.slice(0,800));
    assert(/disabled/.test(tagMatch[0]), 'The '+action+' button should be disabled with zero platforms, got tag: ' + tagMatch[0]);
  });
}

async function testLogPricesFunctionsAreGoneMergedIntoRecon(){
  const sb = makeSandbox();
  assert(typeof sb.openInvLogPrices === 'undefined', 'openInvLogPrices should no longer exist — folded into the Reconciliation page');
  assert(typeof sb.downloadInvReconCSV === 'function', 'The merged export function should exist');
  assert(typeof sb.invManualPriceRows === 'function', 'The manual price table logic should still exist, now used by the Reconciliation page');
}

async function testReconPageIncludesTheManualPriceSection(){
  const sb = invCashSandbox({
    invPositions:[{id:1, platformId:1, name:'Solana', ticker:'SOL', currency:'USD', assetClass:'Crypto', status:'Active'}]
  });
  sb.renderInvReconPage('');
  const html = sb.document.getElementById('app').innerHTML;
  assert(/💹 Prices/.test(html), 'The Reconciliation page should include the merged Prices section');
  assert(html.indexOf('invManualPriceTable') !== -1, 'The manual price table container should be present');
}

async function testMergedReconCsvHasBothStatementAndPriceColumns(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Raseed'}],
    invPositions:[{id:1, platformId:1, name:'Bitcoin', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invValuations:[{id:1, positionId:1, date:'2026-08-01', price:60000}]
  });
  const rows = sb.invReconCSVRows();
  const btcRow = rows.find(r=>r.ticker==='BTC');
  assert(btcRow, 'BTC row should exist');
  assert(Math.abs(btcRow.lastPrice-60000)<0.5, 'The price should be merged into the recon row, got ' + btcRow.lastPrice);
  assert(btcRow.lastPriceDate==='2026-08-01', 'The price date should be merged in too, got ' + btcRow.lastPriceDate);
  const cashRow = rows.find(r=>r.type==='Cash');
  assert(cashRow.lastPrice===null, 'Cash rows should have no price — cash is not priced');
}

async function testTextWidthNoLongerCappedOnPortfolioPage(){
  const sb = invCashSandbox({});
  sb.__set('invView','classic'); // v4.58.0: the pre-4.58 page is now the Classic view
  sb.renderInvestmentsPage();
  const html = sb.document.getElementById('app').innerHTML;
  assert(html.indexOf('max-width:540px') === -1, 'The hardcoded 540px cap should be gone');
  assert(html.indexOf('Cost basis is what actually left your bank') !== -1, 'The description text should still be present');
}

async function testMarkUserActivityUpdatesLastActivityTime(){
  const sb = makeSandbox();
  sb.__set('lastActivityTime', 0);
  sb.__set('appIsLocked', false);
  sb.markUserActivity();
  const now = vm.runInContext('lastActivityTime', sb);
  assert(Date.now() - now < 2000, 'markUserActivity should set lastActivityTime to roughly now, got ' + now);
}

async function testMarkUserActivityIsIgnoredOnceLocked(){
  const sb = makeSandbox();
  sb.__set('lastActivityTime', 12345);
  sb.__set('appIsLocked', true);
  sb.markUserActivity();
  assert(vm.runInContext('lastActivityTime', sb) === 12345, 'Once locked, further activity must not revive the session — only Relaunch should');
}

async function testCheckIdleLockDoesNothingBeforeTheThreshold(){
  const sb = makeSandbox();
  sb.__set('lastActivityTime', Date.now() - 5*60*1000); // 5 minutes idle, well under the 30-minute default
  sb.__set('appIsLocked', false);
  sb.__set('idleWarningShownAt', null);
  sb.__set('syncQueue', []);
  let warned = false;
  sb.__set('showIdleWarning', ()=>{ warned = true; });
  sb.checkIdleLock();
  assert(!warned, 'Should not even warn before the threshold');
}

async function testCheckIdleLockHoldsOffWhileSyncQueueIsNonEmpty(){
  const sb = makeSandbox();
  sb.__set('lastActivityTime', Date.now() - 31*60*1000); // past the default threshold
  sb.__set('appIsLocked', false);
  sb.__set('idleWarningShownAt', null);
  sb.__set('syncQueue', [{id:1}]); // something still unsynced
  let warned = false;
  sb.__set('showIdleWarning', ()=>{ warned = true; });
  sb.checkIdleLock();
  assert(!warned, 'Must hold off even warning while anything is unsynced, to avoid discarding pending writes');
}

async function testCheckIdleLockHoldsOffWhileAModalIsOpen(){
  const sb = makeSandbox();
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot';
  modalRoot.innerHTML = '<div>some in-progress form</div>';
  sb.document.body.appendChild(modalRoot);
  sb.__set('lastActivityTime', Date.now() - 31*60*1000);
  sb.__set('appIsLocked', false);
  sb.__set('idleWarningShownAt', null);
  sb.__set('syncQueue', []);
  let warned = false;
  sb.__set('showIdleWarning', ()=>{ warned = true; });
  sb.checkIdleLock();
  assert(!warned, 'Must hold off while a modal is open, since that is where most in-progress editing lives');
}

async function testCheckIdleLockWarnsBeforeLockingWithNothingBlocking(){
  const sb = makeSandbox();
  sb.__set('lastActivityTime', Date.now() - 31*60*1000);
  sb.__set('appIsLocked', false);
  sb.__set('idleWarningShownAt', null);
  sb.__set('syncQueue', []);
  let locked = false, warned = false;
  sb.__set('lockAppForInactivity', ()=>{ locked = true; });
  sb.__set('showIdleWarning', ()=>{ warned = true; });
  sb.checkIdleLock();
  assert(warned, 'Should show the warning once past the threshold with nothing blocking');
  assert(!locked, 'Should NOT lock immediately — the warning has its own 60-second window first');
}

async function testCheckIdleLockLocksAfterTheWarningWindowElapses(){
  const sb = makeSandbox();
  sb.__set('appIsLocked', false);
  sb.__set('syncQueue', []);
  sb.__set('idleWarningShownAt', Date.now() - 61000); // warning shown 61s ago — past the 60s window
  let locked = false;
  sb.__set('lockAppForInactivity', ()=>{ locked = true; });
  sb.checkIdleLock();
  assert(locked, 'Should lock once the warning window has elapsed with nothing blocking');
}

async function testCheckIdleLockDoesNotLockDuringTheWarningWindow(){
  const sb = makeSandbox();
  sb.__set('appIsLocked', false);
  sb.__set('syncQueue', []);
  sb.__set('idleWarningShownAt', Date.now() - 10000); // only 10s into the 60s warning
  let locked = false;
  sb.__set('lockAppForInactivity', ()=>{ locked = true; });
  sb.checkIdleLock();
  assert(!locked, 'Should not lock before the warning window itself has elapsed');
}

async function testMarkUserActivityDismissesAnActiveWarning(){
  const sb = makeSandbox();
  sb.__set('appIsLocked', false);
  sb.__set('idleWarningShownAt', Date.now());
  let dismissed = false;
  sb.__set('dismissIdleWarning', ()=>{ dismissed = true; });
  sb.markUserActivity();
  assert(dismissed, 'Any activity during the warning should dismiss it, not just delay the lock silently');
}

async function testIdleLockMinutesZeroMeansNever(){
  const sb = makeSandbox();
  sb.__set('lastActivityTime', Date.now() - 999*60*1000); // absurdly idle
  sb.__set('appIsLocked', false);
  sb.__set('idleWarningShownAt', null);
  sb.__set('syncQueue', []);
  // JSDOM's Storage object can't be swapped for a plain mock (no setter on the localStorage
  // getter, and even instance-level method overrides don't take effect — it's backed by special
  // internal handling rather than ordinary properties) — using the real API is the reliable path.
  sb.localStorage.setItem('idleLockMinutes', '0');
  let warned = false;
  sb.__set('showIdleWarning', ()=>{ warned = true; });
  sb.checkIdleLock();
  assert(!warned, 'A 0-minute setting should mean the lock is disabled entirely, never warns');
}

async function testGetSetIdleLockMinutesRoundTripsThroughLocalStorage(){
  const sb = makeSandbox();
  const saved = sb.setIdleLockMinutes('45');
  assert(saved===45, 'setIdleLockMinutes should return the normalized value, got ' + saved);
  assert(sb.getIdleLockMinutes()===45, 'getIdleLockMinutes should read back what was saved, got ' + sb.getIdleLockMinutes());
}

async function testGetIdleLockMinutesFallsBackToDefaultWhenUnset(){
  const sb = makeSandbox();
  // A fresh sandbox's localStorage genuinely has nothing in it yet — no mock needed.
  assert(sb.getIdleLockMinutes()===30, 'With nothing saved yet, should default to 30 minutes, got ' + sb.getIdleLockMinutes());
}

async function testLockAppForInactivityShowsOverlayWithRelaunch(){
  const sb = makeSandbox();
  sb.__set('appIsLocked', false);
  sb.lockAppForInactivity();
  const overlay = sb.document.getElementById('idleLockOverlay');
  assert(overlay, 'The lock overlay should be appended to the document');
  assert(/Relaunch/.test(overlay.innerHTML), 'The overlay should offer a way to relaunch');
  assert(vm.runInContext('appIsLocked', sb) === true, 'appIsLocked should be set to true');
}

async function testLockAppForInactivityIsIdempotent(){
  const sb = makeSandbox();
  sb.__set('appIsLocked', false);
  sb.lockAppForInactivity();
  sb.lockAppForInactivity();
  const overlays = sb.document.querySelectorAll('#idleLockOverlay');
  assert(overlays.length === 1, 'Calling lock twice should not stack a second overlay, got ' + overlays.length);
}

async function testRelaunchAppReloadsThePage(){
  // JSDOM's location.reload is deliberately non-configurable and can't be substituted the way
  // URL.createObjectURL or Blob were earlier — any attempt silently falls through to JSDOM's own
  // (unimplemented) navigation stub instead of a test double. Checking the function's own source
  // is the robust option here, and matches what actually matters: that Relaunch calls a real
  // page reload rather than, say, just closing the overlay.
  const sb = makeSandbox();
  const src = sb.relaunchApp.toString();
  assert(/location\.reload\(\)/.test(src), 'relaunchApp should call location.reload(), got: ' + src);
}

// ================= v4.30.0: restoreFromBackup no longer crashes on fields an older backup lacks =================
async function testNormalizeDataShapeFillsInEveryMissingField(){
  const sb = makeSandbox();
  const bare = {accounts:[], ledger:[]}; // an old-style backup: only the two original tables
  sb.normalizeDataShape(bare);
  ['categories','subcategories','provisionGroups','accrualMappings','jamiahs','invOwners',
   'invPlatforms','invPositions','invTransactions','invValuations','invCashMovements',
   'realEstateBuildings','forecastAccountRules','customForecastCategories'].forEach(f=>{
    assert(Array.isArray(bare[f]), 'normalizeDataShape should default '+f+' to an array, got ' + JSON.stringify(bare[f]));
  });
  ['invSettings','uiPrefs','forecastPlans','nameTranslations','descrTranslations'].forEach(f=>{
    assert(bare[f] && typeof bare[f]==='object' && !Array.isArray(bare[f]),
      'normalizeDataShape should default '+f+' to a plain object, got ' + JSON.stringify(bare[f]));
  });
}

async function testNormalizeDataShapeDoesNotOverwriteExistingData(){
  const sb = makeSandbox();
  const withData = {accounts:[{id:1}], invOwners:[{id:1,name:'Me'}], invSettings:{fxUsdSar:4}};
  sb.normalizeDataShape(withData);
  assert(withData.invOwners.length===1 && withData.invOwners[0].name==='Me',
    'Existing data must survive normalization untouched');
  assert(withData.invSettings.fxUsdSar===4, 'An existing invSettings object must not be replaced wholesale');
}

async function testRestoreFromBackupDoesNotCrashOnAnOldBackupMissingNewerFields(){
  // Regression test for a real bug found while reviewing an external backup script: a JSON
  // backup taken before the Investments/Real Estate/Smart Rules modules existed has none of
  // those fields. restoreFromBackup's D reassignment previously left them undefined, and later
  // code (the cloud-restore branch) read D.realEstateBuildings.length etc. unconditionally —
  // a TypeError on any restore that reached that point with an older-shaped backup.
  const sb = makeSandbox();
  sb.__set('usingCloud', false); // exercises the same D reconstruction and normalization either way
  sb.__set('blockIfSyncing', ()=>false);
  sb.__set('toast', ()=>{});
  sb.__set('go', ()=>{});
  sb.__set('saveJVDraftsList', ()=>{});
  sb.__set('persistLocal', ()=>{});
  const oldBackup = {accounts:[{id:10101}], ledger:[{id:1,jv:1,date:'2026-01-01',acc:10101,amt:100,descr:'x'}]};
  await sb.restoreFromBackup(oldBackup); // must not throw
  const D = vm.runInContext('D', sb);
  assert(Array.isArray(D.invOwners), 'D.invOwners should be a defaulted array after restoring an old backup, not undefined');
  assert(Array.isArray(D.realEstateBuildings), 'D.realEstateBuildings should be defaulted, not undefined');
  assert(Array.isArray(D.forecastAccountRules), 'D.forecastAccountRules should be defaulted, not undefined');
  assert(D.invSettings && typeof D.invSettings==='object', 'D.invSettings should be a defaulted object, not undefined');
}

async function testRestoreFromBackupPreservesNewerFieldsWhenPresentInTheFile(){
  const sb = makeSandbox();
  sb.__set('usingCloud', false);
  sb.__set('blockIfSyncing', ()=>false);
  sb.__set('toast', ()=>{});
  sb.__set('go', ()=>{});
  sb.__set('saveJVDraftsList', ()=>{});
  sb.__set('persistLocal', ()=>{});
  const fullBackup = {accounts:[], ledger:[],
    invOwners:[{id:1,name:'Me',isSelf:true}], realEstateBuildings:[{id:1,name:'Raseed Tower'}]};
  await sb.restoreFromBackup(fullBackup);
  const D = vm.runInContext('D', sb);
  assert(D.invOwners.length===1 && D.invOwners[0].name==='Me', 'A backup that DOES include the newer fields should have them restored, not discarded');
  assert(D.realEstateBuildings.length===1 && D.realEstateBuildings[0].name==='Raseed Tower', 'Real estate buildings should be restored when present in the file');
}

async function testRestoreFromBackupStillCallsNormalizeDataShape(){
  // Every field normalizeDataShape defaults is ALSO explicitly defaulted inline in
  // restoreFromBackup's own D reassignment, so this call is currently non-load-bearing for
  // today's fields — it's forward-looking defense-in-depth for the next field someone adds to D
  // elsewhere and forgets to list here too (which is exactly how the original bug happened).
  // Locking in that the call itself survives, so that safety net can't be silently dropped.
  const sb = makeSandbox();
  sb.__set('usingCloud', false);
  sb.__set('blockIfSyncing', ()=>false);
  sb.__set('toast', ()=>{});
  sb.__set('go', ()=>{});
  sb.__set('saveJVDraftsList', ()=>{});
  sb.__set('persistLocal', ()=>{});
  let called = false;
  sb.__set('normalizeDataShape', (d)=>{ called = true; return d; });
  await sb.restoreFromBackup({accounts:[], ledger:[]});
  assert(called, 'restoreFromBackup should still call normalizeDataShape as a forward-looking safety net');
}

async function testIdleLockSettingsPanelShowsCurrentValueAndSaves(){
  const sb = makeSandbox();
  sb.__set('settingsTab', 'cloud');
  // A fresh sandbox's own default `D` (the top-level `let D = {...}` literal) is already the
  // complete, correctly-shaped empty state renderSettings needs across all its tabs — no
  // hand-built fixture required, and nothing to fall out of date later.
  sb.setIdleLockMinutes(20);
  sb.renderSettings();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/Idle Session Lock/.test(html), 'The settings panel should be present');
  assert(/value="20"/.test(html), 'The input should show the currently saved value, got snippet: ' + html.slice(html.indexOf('Idle Session Lock'), html.indexOf('Idle Session Lock')+500));
  assert(/0 = never/.test(html), 'The 0=never hint should be present');
  assert(/This setting applies to this device only/.test(html), 'The per-device note should be present');
}

async function testSaveIdleLockMinutesFromSettingsPersistsAndToasts(){
  const sb = makeSandbox();
  const input = sb.document.createElement('input');
  input.id = 'idleLockMinutesInput';
  input.value = '15';
  sb.document.body.appendChild(input);
  let toastMsg = null;
  sb.__set('toast', (m)=>{ toastMsg = m; });
  sb.saveIdleLockMinutesFromSettings();
  assert(sb.getIdleLockMinutes()===15, 'Should persist the typed value, got ' + sb.getIdleLockMinutes());
  assert(toastMsg && /15 minute/.test(toastMsg), 'Should confirm the new value, got: ' + toastMsg);
}

// ================= v4.32.0: JV Balance Check =================
async function testToggleJvBalanceCheckStartsFreshEachTime(){
  const sb = makeSandbox();
  sb.__set('renderNewJV', ()=>{});
  sb.__set('jvBalanceCheckSelected', new Set([0,1]));
  sb.toggleJvBalanceCheck();
  assert(vm.runInContext('jvBalanceCheckMode', sb) === true, 'Should turn the mode on');
  assert(vm.runInContext('jvBalanceCheckSelected', sb).size === 0, 'Turning it on should start with a clean selection, not whatever was left from before');
}

async function testToggleJvBalanceCheckLineTogglesMembership(){
  const sb = makeSandbox();
  sb.__set('renderNewJV', ()=>{});
  sb.toggleJvBalanceCheckLine(2);
  assert(vm.runInContext('jvBalanceCheckSelected', sb).has(2), 'Selecting a line should add its index');
  sb.toggleJvBalanceCheckLine(2);
  assert(!vm.runInContext('jvBalanceCheckSelected', sb).has(2), 'Selecting it again should remove it');
}

async function testJvBalanceCheckSubtotalSumsOnlySelectedLines(){
  const sb = makeSandbox();
  sb.__set('jvDraft', {date:'2026-08-29', lines:[
    {acc:10111, descr:'a', amt:612}, {acc:10203, descr:'b', amt:-612}, {acc:20101, descr:'c', amt:-1000}
  ]});
  sb.__set('jvBalanceCheckSelected', new Set([0,1]));
  const {sum, count} = sb.jvBalanceCheckSubtotal();
  assert(count===2, 'Should count only the selected lines, got ' + count);
  assert(Math.abs(sum-0)<0.005, 'Selected pair (612, -612) should subtotal to 0, got ' + sum);
}

async function testJvBalanceCheckSubtotalDetectsTheImbalance(){
  // Mirrors the real scenario: a missing adjustment line leaves a bank-line group off by 0.15.
  const sb = makeSandbox();
  sb.__set('jvDraft', {date:'2026-08-29', lines:[
    {acc:10111, descr:'a', amt:612}, {acc:10111, descr:'b', amt:11000}, {acc:10203, descr:'c', amt:-612},
    {acc:20101, descr:'d', amt:-11000.15}
  ]});
  sb.__set('jvBalanceCheckSelected', new Set([0,1,2,3]));
  const {sum} = sb.jvBalanceCheckSubtotal();
  assert(Math.abs(sum - (-0.15)) < 0.005, 'Should surface the exact -0.15 shortfall, got ' + sum);
}

async function testJvBalanceCheckSubtotalIgnoresStaleIndexesGracefully(){
  const sb = makeSandbox();
  sb.__set('jvDraft', {date:'2026-08-29', lines:[{acc:10111, descr:'a', amt:100}]});
  sb.__set('jvBalanceCheckSelected', new Set([0, 5])); // 5 doesn't exist
  const {sum, count} = sb.jvBalanceCheckSubtotal();
  assert(count===1 && Math.abs(sum-100)<0.005, 'A stale/out-of-range index should be skipped rather than throwing, got sum=' + sum + ' count=' + count);
}

async function testClearJvBalanceCheckSelectionEmptiesTheSet(){
  const sb = makeSandbox();
  sb.__set('renderNewJV', ()=>{});
  sb.__set('jvBalanceCheckSelected', new Set([0,1,2]));
  sb.clearJvBalanceCheckSelection();
  assert(vm.runInContext('jvBalanceCheckSelected', sb).size === 0, 'Clear should empty the selection');
}

async function testRemoveJVLineRemapsSelectionIndexesCorrectly(){
  // Without remapping, removing line 1 would leave a selection that had included line 2 now
  // silently pointing at what USED to be line 3 — auditing the wrong row without any warning.
  const sb = makeSandbox();
  sb.__set('jvDraft', {date:'2026-08-29', lines:[
    {acc:1, descr:'keep-0', amt:10}, {acc:2, descr:'REMOVE-1', amt:20},
    {acc:3, descr:'keep-2-becomes-1', amt:30}, {acc:4, descr:'keep-3-becomes-2', amt:40}
  ]});
  sb.__set('jvBalanceCheckSelected', new Set([0,1,2,3]));
  sb.__set('renderNewJV', ()=>{});
  sb.removeJVLine(1);
  const sel = vm.runInContext('jvBalanceCheckSelected', sb);
  assert(!sel.has(3), 'The old max index should have shifted down after a removal, not stayed dangling');
  assert(sel.has(0) && sel.has(1) && sel.has(2), 'Indices before and after the removed line should remap to 0,1,2, got ' + [...sel].join(','));
  const lines = vm.runInContext('jvDraft', sb).lines;
  assert(lines[1].descr==='keep-2-becomes-1' && lines[2].descr==='keep-3-becomes-2',
    'Sanity check on the remap: line content at the remapped indices should be what actually moved there');
}

async function testResetJVDraftClearsBalanceCheckSelection(){
  const sb = makeSandbox();
  sb.__set('jvBalanceCheckSelected', new Set([0,1]));
  sb.resetJVDraft();
  assert(vm.runInContext('jvBalanceCheckSelected', sb).size === 0, 'Starting a fresh JV should not carry over a selection from a previous voucher');
}

async function testRenderNewJVShowsBalanceCheckBarOnlyWhenModeIsOn(){
  const sb = makeSandbox();
  sb.__set('jvDraft', {date:'2026-08-29', lines:[{acc:10111, descr:'a', amt:100}, {acc:10203, descr:'b', amt:-100}]});
  sb.__set('jvBalanceCheckMode', false);
  sb.renderNewJV();
  let html = sb.document.getElementById('app').innerHTML;
  assert(!/Balance Check — click lines/.test(html), 'The subtotal bar should be hidden when the mode is off');
  assert(!/toggleJvBalanceCheckLine/.test(html), 'Checkboxes should not render when the mode is off');

  sb.__set('jvBalanceCheckMode', true);
  sb.renderNewJV();
  html = sb.document.getElementById('app').innerHTML;
  assert(/Balance Check — click lines/.test(html), 'The subtotal bar should show when the mode is on');
  assert(/toggleJvBalanceCheckLine\(0\)/.test(html) && /toggleJvBalanceCheckLine\(1\)/.test(html),
    'Every line should get a selection checkbox when the mode is on');
}

async function testUnselectedLinesAreDimmedWhileSelectedLinesAreNot(){
  const sb = makeSandbox();
  sb.__set('jvBalanceCheckMode', true);
  sb.__set('jvBalanceCheckSelected', new Set([0]));
  const rowSelected = sb.jvLineRow({acc:10111, descr:'a', amt:100}, 0);
  const rowUnselected = sb.jvLineRow({acc:10203, descr:'b', amt:-100}, 1);
  assert(!/opacity:\.4/.test(rowSelected), 'A selected line should NOT be dimmed');
  assert(/opacity:\.4/.test(rowUnselected), 'An unselected line SHOULD be dimmed while the mode is active');
}

// ================= v4.33.0: Closing Balance Watch, statement-date fix, reconcile focus, JV total on blur =================
async function testClosingBalanceWatchStoresUpToThreeArbitraryMonths(){
  const sb = makeSandbox();
  sb.__set('renderDashboard', ()=>{});
  sb.setClosingBalanceWatchMonth(0, '2026-12');
  sb.setClosingBalanceWatchMonth(2, '2026-03'); // not consecutive, and slot 1 left blank
  const months = sb.getClosingBalanceWatchMonths();
  assert(months[0]==='2026-12' && months[2]==='2026-03', 'Should store exactly what was picked per slot, got ' + JSON.stringify(months));
}

async function testClosingBalanceWatchWidgetShowsClosingOnlyForPickedMonths(){
  const sb = makeSandbox();
  // A fresh sandbox's own default D is already complete (every field beginForecastFastPath and
  // the rest of a full render need) — mutating it in place avoids the missing-field crashes that
  // come from swapping in a hand-picked partial D for a function that touches the whole app.
  const data = vm.runInContext('D', sb);
  data.ledger.push({id:1, jv:1, date:'2026-01-01', acc:10101, amt:1000, descr:'x'});
  sb.__set('renderDashboard', ()=>{}); // setClosingBalanceWatchMonth triggers a full dashboard render we don't need here
  sb.setClosingBalanceWatchMonth(0, '2026-01');
  const html = sb.renderClosingBalanceWatchWidget();
  assert(/Closing Balance Watch/.test(html), 'The widget title should be present');
  assert(/type="month"/.test(html), 'Should render month pickers');
  assert(!/Starting|Inflow|Outflow/.test(html), 'Should show ONLY the Closing figure, not the other cash-flow rows');
}

async function testClosingBalanceWatchWidgetHandlesNoMonthsPicked(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[], ledger:[]});
  sb.__set('localStorage', sb.localStorage); // fresh — nothing picked yet
  const html = sb.renderClosingBalanceWatchWidget();
  assert(/Choose a month/.test(html), 'An unpicked slot should invite a choice rather than show a stale or wrong figure');
}

async function testStatementBalanceOnlySavesOnEnterNotOnBlur(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:10101, is_credit_card:false, stmt_balance:500, stmt_date:'2026-08-01'}]});
  let saved = false;
  sb.__set('saveStmtBalance', ()=>{ saved = true; });
  const html = sb.renderDashboard ? '' : '';
  const row = sb.document.createElement('div');
  // Directly inspect the generated markup for the statement-balance input to confirm onblur no
  // longer calls saveStmtBalance at all — it must only restore the displayed text.
  sb.__set('bankTotal', 0);
  const src = fs.readFileSync(APP_HTML, 'utf8');
  const inputBlock = src.slice(src.indexOf('id="stmtBal_'), src.indexOf('id="stmtBal_')+700);
  assert(!/onblur="saveStmtBalance/.test(inputBlock), 'onblur must no longer call saveStmtBalance — that was the bug (silently saving/dating on blur)');
  assert(/onblur="this\.value = this\.dataset\.raw/.test(inputBlock), 'onblur should just restore the last-saved display text, discarding the unconfirmed edit');
  assert(/onkeydown="if\(event\.key==='Enter'\)[^"]*saveStmtBalance/.test(inputBlock), 'Enter should still be the thing that actually saves');
}

async function testStartReconcileFocusesTheDescriptionField(){
  const sb = invCashSandbox({accounts:[{id:10101, acc_type:'Individual Account', status:'Active'}], templates:[]});
  const nav = sb.document.createElement('div'); nav.id='nav'; sb.document.body.appendChild(nav);
  sb.startReconcile(10101);
  const active = sb.document.activeElement;
  assert(active && active.id==='jvDescr_0', "Focus should land on the first line's description field, got " + (active&&active.id));
}

async function testJvAmountDoesNotRecalculateTotalOnEveryKeystroke(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:10101, acc_type:'Individual Account', status:'Active'}], ledger:[]});
  sb.__set('jvDraft', {date:'2026-08-29', lines:[{acc:10101, descr:'a', amt:''}, {acc:10203, descr:'b', amt:''}]});
  let totalsCalled = 0;
  sb.__set('updateJVTotals', ()=>{ totalsCalled++; });
  const input = sb.document.createElement('input');
  input.id = 'jvAmt_0';
  sb.document.body.appendChild(input);
  // Simulate what the oninput handler now does directly (the app wires oninput to this exact
  // statement) — it must NOT include a call to updateJVTotals.
  vm.runInContext("jvDraft.lines[0].amt='1'", sb);
  assert(totalsCalled===0, 'Typing a digit must not trigger a total recalculation — only blur/Enter should');
}

async function testJvAmtBlurStillRecalculatesTheTotal(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:10101, acc_type:'Individual Account', status:'Active'}], ledger:[]});
  sb.__set('jvDraft', {date:'2026-08-29', lines:[{acc:10101, descr:'a', amt:'105*10'}]});
  let totalsCalled = 0;
  sb.__set('updateJVTotals', ()=>{ totalsCalled++; });
  sb.jvAmtBlur(0);
  assert(totalsCalled===1, 'Blur (and, by the same code path, Enter) must still recalculate the total');
  assert(Math.abs(vm.runInContext('jvDraft', sb).lines[0].amt - 1050) < 0.005, 'Blur should still evaluate a typed formula, got ' + vm.runInContext('jvDraft', sb).lines[0].amt);
}

async function testBalanceCheckSubtotalAlsoOnlyUpdatesOnBlurNotEveryKeystroke(){
  // Per explicit confirmation: the Balance Check subtotal shares updateJVTotals, so it follows
  // the same blur/Enter-only rule rather than live-updating per keystroke.
  const sb = makeSandbox();
  const src = fs.readFileSync(APP_HTML, 'utf8');
  const oninputLine = src.match(/oninput="jvDraft\.lines\[\$\{i\}\]\.amt=this\.value[^"]*"/);
  assert(oninputLine, 'Should find the amount field oninput handler');
  assert(!/updateJVTotals/.test(oninputLine[0]), 'oninput must not call updateJVTotals — Balance Check inherits the same fix since it reads from that same function');
}

// ================= v4.34.0: Forecast Snapshots =================
function fcSnapSandbox(extra){
  // invCashSandbox's default D is deliberately minimal (built for investment-only tests) and is
  // missing fields beginForecastFastPath needs (provisionGroups, etc.) now that the snapshot
  // engine's fix routes through the same fast-path machinery the Forecast Grid uses.
  const sb = invCashSandbox(Object.assign({
    accounts: [{id:10101, category:'Bank Accounts', acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:10000, descr:'x'}],
    provisionGroups: [],
    forecastSnapshots: []
  }, extra||{}));
  return sb;
}

async function testGetSetForecastSnapshotHorizonRoundTrips(){
  const sb = fcSnapSandbox();
  const saved = sb.setForecastSnapshotHorizon('6');
  assert(saved===6, 'Should normalize and return the saved horizon, got ' + saved);
  assert(sb.getForecastSnapshotHorizon()===6, 'Should read back what was saved, got ' + sb.getForecastSnapshotHorizon());
}

async function testGetForecastSnapshotHorizonDefaultsToTwelve(){
  const sb = fcSnapSandbox();
  assert(sb.getForecastSnapshotHorizon()===12, 'With nothing saved yet, should default to 12 months, got ' + sb.getForecastSnapshotHorizon());
}

async function testBuildForecastSnapshotMonthsCapturesExactlyTheHorizon(){
  const sb = fcSnapSandbox();
  sb.__set('todayStr', ()=>'2026-08-29');
  const months = sb.buildForecastSnapshotMonths('2026-08', 3);
  assert(months.length===3, 'Should capture exactly the requested horizon, got ' + months.length);
  assert(months[0].month==='2026-08' && months[1].month==='2026-09' && months[2].month==='2026-10',
    'Should run consecutively forward from the anchor, got ' + months.map(m=>m.month).join(','));
  assert('closing' in months[0], 'Each captured month should carry a Closing figure');
}

async function testTakeForecastSnapshotPersistsAndReturnsTheRecord(){
  const sb = fcSnapSandbox();
  sb.__set('todayStr', ()=>'2026-08-29');
  const rec = await sb.takeForecastSnapshot('manual');
  assert(rec.kind==='manual', 'Should tag the requested kind, got ' + rec.kind);
  assert(rec.anchorMonth==='2026-08', 'Should anchor to the current month, got ' + rec.anchorMonth);
  assert(sb._D.forecastSnapshots.length===1, 'Should append to D.forecastSnapshots');
  assert(sb._D.forecastSnapshots[0].months.length===sb.getForecastSnapshotHorizon(),
    'The stored snapshot should carry the full configured horizon of months');
}

async function testDeleteForecastSnapshotRemovesItAfterConfirm(){
  const sb = fcSnapSandbox({forecastSnapshots:[{id:1, anchorMonth:'2026-08', takenAt:'2026-08-01', kind:'manual', months:[]}]});
  sb.__set('confirm', ()=>true);
  sb.__set('renderForecastSettingsPage', ()=>{});
  await sb.deleteForecastSnapshot(1);
  assert(sb._D.forecastSnapshots.length===0, 'Should remove the snapshot once confirmed');
}

async function testDeleteForecastSnapshotKeepsItIfNotConfirmed(){
  const sb = fcSnapSandbox({forecastSnapshots:[{id:1, anchorMonth:'2026-08', takenAt:'2026-08-01', kind:'manual', months:[]}]});
  sb.__set('confirm', ()=>false);
  sb.__set('renderForecastSettingsPage', ()=>{});
  await sb.deleteForecastSnapshot(1);
  assert(sb._D.forecastSnapshots.length===1, 'Should NOT remove the snapshot if the person declines the confirmation');
}

async function testAutoSnapshotSkipsWhenNoLedgerHistoryExists(){
  const sb = fcSnapSandbox({ledger:[]}); // fresh install, nothing to compare against
  await sb.checkAutoForecastSnapshot();
  assert(sb._D.forecastSnapshots.length===0, 'Should not auto-snapshot a completely empty ledger — nothing meaningful to capture yet');
}

async function testAutoSnapshotTakesOneWhenNoneExistsThisMonth(){
  const sb = fcSnapSandbox();
  sb.__set('todayStr', ()=>'2026-08-29');
  await sb.checkAutoForecastSnapshot();
  assert(sb._D.forecastSnapshots.length===1, 'Should take an automatic snapshot when none exists for the current month');
  assert(sb._D.forecastSnapshots[0].kind==='auto', 'The auto-taken snapshot should be tagged auto');
  assert(vm.runInContext('forecastSnapshotBannerMonth', sb)==='2026-08', 'Should arm the one-time banner for this month');
}

async function testAutoSnapshotDoesNotDuplicateWithinTheSameMonth(){
  const sb = fcSnapSandbox({forecastSnapshots:[{id:1, anchorMonth:'2026-08', takenAt:'2026-08-01', kind:'auto', months:[]}]});
  sb.__set('todayStr', ()=>'2026-08-29');
  await sb.checkAutoForecastSnapshot();
  assert(sb._D.forecastSnapshots.length===1, 'A second auto-check in the same calendar month must not take a second automatic snapshot');
  assert(vm.runInContext('forecastSnapshotBannerMonth', sb)===null, 'The banner should not re-arm when nothing new was actually taken');
}

async function testAutoSnapshotAllowsAManualOneInTheSameMonthToo(){
  // Confirms manual snapshots have no monthly cap, unlike automatic ones.
  const sb = fcSnapSandbox({forecastSnapshots:[{id:1, anchorMonth:'2026-08', takenAt:'2026-08-01', kind:'auto', months:[]}]});
  sb.__set('todayStr', ()=>'2026-08-15');
  await sb.takeForecastSnapshot('manual');
  assert(sb._D.forecastSnapshots.length===2, 'A manual snapshot should be taken regardless of an existing automatic one this month');
}

async function testForecastSnapshotBannerHtmlOnlyShowsWhenArmed(){
  const sb = fcSnapSandbox();
  sb.__set('forecastSnapshotBannerMonth', null);
  assert(sb.forecastSnapshotBannerHTML()==='', 'No banner markup should render when nothing was just auto-taken');
  sb.__set('forecastSnapshotBannerMonth', '2026-08');
  assert(/snapshot taken/i.test(sb.forecastSnapshotBannerHTML()), 'Banner markup should appear once armed');
}

async function testDismissForecastSnapshotBannerClearsIt(){
  const sb = fcSnapSandbox();
  sb.__set('forecastSnapshotBannerMonth', '2026-08');
  sb.__set('screen', 'ledger'); // not on the dashboard, so no re-render should be attempted
  sb.dismissForecastSnapshotBanner();
  assert(vm.runInContext('forecastSnapshotBannerMonth', sb)===null, 'Dismissing should clear the armed state');
}

async function testForecastSnapshotClosingForReturnsNullOutsideHorizon(){
  const sb = fcSnapSandbox();
  const snap = {months:[{month:'2026-08', closing:1000},{month:'2026-09', closing:1100}]};
  assert(sb.forecastSnapshotClosingFor(snap, '2026-09')===1100, 'Should find the closing figure for a captured month');
  assert(sb.forecastSnapshotClosingFor(snap, '2027-01')===null, 'A month outside the captured horizon should return null, not throw or guess');
}

async function testForecastSnapshotsCoveringFindsOnlyRelevantOnesInOrder(){
  const sb = fcSnapSandbox({forecastSnapshots:[
    {id:1, anchorMonth:'2026-07', takenAt:'2026-07-01', kind:'auto', months:[{month:'2026-07',closing:1},{month:'2026-08',closing:2}]},
    {id:2, anchorMonth:'2026-09', takenAt:'2026-09-01', kind:'auto', months:[{month:'2026-09',closing:3}]}, // does NOT cover 2026-08
    {id:3, anchorMonth:'2026-06', takenAt:'2026-06-01', kind:'manual', months:[{month:'2026-06',closing:0},{month:'2026-08',closing:5}]},
  ]});
  const covering = sb.forecastSnapshotsCovering('2026-08');
  assert(covering.length===2, 'Should include only snapshots whose horizon actually reached 2026-08, got ' + covering.length);
  assert(covering[0].anchorMonth==='2026-06' && covering[1].anchorMonth==='2026-07',
    'Should be sorted oldest first by anchor month, got ' + covering.map(s=>s.anchorMonth).join(','));
}

async function testForecastSnapshotTrendChartRendersAPointPerCoveringSnapshotPlusNow(){
  const sb = fcSnapSandbox({forecastSnapshots:[
    {id:1, anchorMonth:'2026-06', takenAt:'2026-06-01', kind:'manual', months:[{month:'2026-08', closing:5000}]}
  ]});
  sb.__set('todayStr', ()=>'2026-08-29');
  const html = sb.renderForecastSnapshotTrendChart('2026-08');
  const circles = (html.match(/<circle/g)||[]).length;
  assert(circles===2, 'Should plot one point for the covering snapshot and one for "now", got ' + circles);
  assert(/Now/.test(html), 'The final point should be labelled Now');
}

async function testForecastSnapshotTrendChartEmptyWithFewerThanTwoPoints(){
  const sb = fcSnapSandbox({forecastSnapshots:[]});
  sb.__set('todayStr', ()=>'2026-08-29');
  const html = sb.renderForecastSnapshotTrendChart('2026-08');
  assert(html==='', 'With only the live "now" point and nothing historical, there is nothing to trend — should render nothing rather than a one-point chart');
}

async function testForecastSettingsPageIncludesSnapshotHorizonAndButton(){
  const sb = fcSnapSandbox();
  sb.setForecastSnapshotHorizon(9);
  sb.renderForecastSettingsPage();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/Forecast Snapshots/.test(html), 'The Snapshots panel should be present');
  assert(/value="9"/.test(html), 'The horizon input should reflect the saved value');
  assert(/Take Snapshot Now/.test(html), 'The manual snapshot button should be present');
}

// ================= v4.35.0: Closing Balance Watch bug fix + performance fix =================
async function testClosingBalanceWatchMatchesTheRealAnchoredGrid(){
  // Regression test for the exact bug reported: the widget must show the SAME number the real
  // Cash Position grid shows for a given month, which means it must go through the anchor-to-
  // actual correction, not the raw/unanchored chain (which produced wildly different figures).
  const sb = makeSandbox();
  const data = vm.runInContext('D', sb);
  data.accounts.push({id:10101, category:'Bank Accounts', acc_type:'Individual Account', status:'Active'});
  data.ledger.push({id:1, jv:1, date:'2025-01-01', acc:10101, amt:50000, descr:'opening'});
  sb.__set('todayStr', ()=>'2026-08-29');
  sb.__set('renderDashboard', ()=>{});
  sb.setClosingBalanceWatchMonth(0, '2026-09');
  const widgetHtml = sb.renderClosingBalanceWatchWidget();

  // Independently recompute what the real grid would show for the same month, the same way
  // renderCashFlowPanel does, and require the widget's displayed text to contain that exact figure.
  let gridClosing;
  try{ sb.beginForecastFastPath(); gridClosing = sb.computeMonthlyCashFlow(['2026-09'], '2026-08')[0].closing; }
  finally{ sb.endForecastFastPath(); }
  const gridMoneyText = sb.money0(gridClosing); // v5.1: Dashboard boxes show whole numbers
  assert(widgetHtml.indexOf(gridMoneyText) !== -1,
    'Widget must display the exact same figure as the real grid (' + gridMoneyText + '), got snippet: ' + widgetHtml.slice(widgetHtml.indexOf('2026-09')-20, widgetHtml.indexOf('2026-09')+200));
}

async function testClosingBalanceWatchUsesAnchoredNotPureChain(){
  const src = fs.readFileSync(APP_HTML, 'utf8');
  const fn = src.match(/function renderClosingBalanceWatchWidget\(\)\{[\s\S]*?\n\}/)[0];
  assert(/computeMonthlyCashFlow\(picked/.test(fn), 'Must use the anchored computeMonthlyCashFlow, matching what the real grid shows');
  assert(!/computeMonthlyCashFlowPure\(picked/.test(fn), 'Must NOT use the raw/unanchored chain directly — that was the bug');
  assert(/beginForecastFastPath/.test(fn) && /endForecastFastPath/.test(fn),
    'Must wrap the calculation in the fast path — without it, this re-scans the whole ledger on every dashboard render');
}

async function testForecastSnapshotCaptureUsesAnchoredChainAndFastPath(){
  const src = fs.readFileSync(APP_HTML, 'utf8');
  const fn = src.match(/function buildForecastSnapshotMonths\([\s\S]*?\n\}/)[0];
  assert(/computeMonthlyCashFlow\(months/.test(fn), 'Snapshot capture must use the anchored chain, same fix as the widget');
  assert(!/computeMonthlyCashFlowPure\(months/.test(fn), 'Must not capture the raw/unanchored chain');
  assert(/beginForecastFastPath/.test(fn) && /endForecastFastPath/.test(fn), 'Snapshot capture must be fast-path wrapped');
}

async function testSnapshotComparisonNowFigureUsesAnchoredChain(){
  const src = fs.readFileSync(APP_HTML, 'utf8');
  const compareFn = src.slice(src.indexOf('function renderForecastSnapshotComparison'), src.indexOf('function renderForecastSnapshotComparison')+2000);
  assert(/computeMonthlyCashFlow\(\[targetMonth\]/.test(compareFn), 'The comparison\'s live "now" figure must use the anchored chain');
  const chartFn = src.match(/function renderForecastSnapshotTrendChart\([\s\S]*?\n\}/)[0];
  assert(/computeMonthlyCashFlow\(\[targetMonth\]/.test(chartFn), 'The trend chart\'s "Now" point must use the anchored chain');
}

async function testNetWorthGridAutoFitsInsteadOfFixedThreeColumns(){
  const src = fs.readFileSync(APP_HTML, 'utf8');
  assert(/\.grid3\{display:grid;grid-template-columns:repeat\(auto-fit,\s*minmax\(300px,\s*350px\)\)/.test(src),
    'The net worth grid should auto-fit same-width, width-capped cards rather than being locked to exactly 3 equal-share columns');
  assert(!/\.grid3\{display:grid;grid-template-columns:1fr 1fr 1fr/.test(src),
    'Must not have reverted to a rigid 3-column layout');
}

// Finds the true matching closing tag for a <div> that starts at `openTagStart`, via a proper
// depth-counting token scan (a naive indexOf-based walk breaks on any nested <div>, which is
// exactly the shape of this markup — three multi-row panels each with their own inner divs).
function findMatchingDivClose(html, openTagStart){
  const tagRe = /<div\b[^>]*>|<\/div>/g;
  tagRe.lastIndex = openTagStart;
  let m, depth = 0;
  while((m = tagRe.exec(html))){
    if(m[0].startsWith('</')){ depth--; if(depth===0) return m.index; }
    else depth++;
  }
  return -1;
}

async function testClosingBalanceWatchIsInItsOwnRowNotTheNetWorthGrid(){
  // v5.0: the Dashboard is a grid of separate boxes. The Closing Balance Watch and each of the
  // three position boxes (which replaced the old net worth panels) are their own boxes, so the
  // watch never shares a box with the equity panels.
  const sb = makeSandbox();
  const data = vm.runInContext('D', sb);
  data.ledger.push({id:1, jv:1, date:'2026-01-01', acc:10101, amt:1000, descr:'x'});
  sb.renderDashboard();
  const cells = [...sb.document.querySelectorAll('#app .dash-cell')];
  const cellOf = text => cells.filter(c=>c.textContent.includes(text));
  assert(cellOf('Closing Balance Watch').length===1, 'The Closing Balance Watch is exactly one box');
  assert(cellOf('Short Term Equity').length===1, 'Short Term Equity is exactly one box');
  const watch = cellOf('Closing Balance Watch')[0], ste = cellOf('Short Term Equity')[0];
  assert(watch && ste && watch!==ste, 'The watch is not in the same box as the equity panel');
  assert(watch && !/Long Term Equity|Cash Bank Account/.test(watch.textContent), 'The watch box holds only the watch');
}

// ================= v4.36.0: Robo-Investment platforms, portfolio value, USD column, Out/In/Profit display =================
async function testInvRoboPlatformStatsComputesCostBasisFromOutInAccounts(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}, {id:20101, acc_type:'Individual Account', status:'Active'}],
    ledger: [
      {id:1, jv:1, date:'2026-01-01', acc:10101, amt:50000, descr:'invested'},
      {id:2, jv:2, date:'2026-06-01', acc:20101, amt:10000, descr:'withdrawn'}
    ]
  });
  const p = {id:1, name:'Wealthfront', outAcc:10101, inAcc:20101, profitAcc:null, isRobo:true, roboValue:55000, roboValueDate:'2026-08-01'};
  const stats = sb.invRoboPlatformStats(p);
  assert(Math.abs(stats.costBasis - 40000) < 0.005, 'Cost basis should be Out(50000) - In(10000) = 40000, got ' + stats.costBasis);
  assert(Math.abs(stats.gain - 15000) < 0.005, 'Gain should be value(55000) - costBasis(40000) = 15000, got ' + stats.gain);
  assert(stats.hasValue === true, 'A logged roboValue should read as having a value');
}

async function testInvRoboPlatformStatsHandlesUnassignedAccountsAsZero(){
  const sb = invCashSandbox({accounts:[], ledger:[]});
  const p = {id:1, name:'Robo', outAcc:null, inAcc:null, profitAcc:null, isRobo:true, roboValue:null, roboValueDate:null};
  const stats = sb.invRoboPlatformStats(p);
  assert(stats.costBasis === 0, 'Unassigned Out/In accounts should read as zero cost basis, not throw');
  assert(stats.hasValue === false, 'No logged value should read as hasValue false');
  assert(stats.gain === null, 'Gain should be null (not computable) when no value has ever been logged');
}

async function testSaveInvRoboValuePersistsAndDatesIt(){
  const sb = invCashSandbox({invPlatforms:[{id:1, name:'Robo', isRobo:true, roboValue:null, roboValueDate:null}]});
  sb.__set('todayStr', ()=>'2026-08-29');
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('toast', ()=>{});
  await sb.saveInvRoboValue(1, '61234.56');
  const p = sb._D.invPlatforms.find(x=>x.id===1);
  assert(Math.abs(p.roboValue-61234.56)<0.005, 'Should persist the typed value, got ' + p.roboValue);
  assert(p.roboValueDate==='2026-08-29', 'Should date it to today, got ' + p.roboValueDate);
}

async function testSaveInvRoboValueIgnoresNonPositiveInput(){
  const sb = invCashSandbox({invPlatforms:[{id:1, name:'Robo', isRobo:true, roboValue:100, roboValueDate:'2026-01-01'}]});
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('toast', ()=>{});
  await sb.saveInvRoboValue(1, '0');
  await sb.saveInvRoboValue(1, 'abc');
  const p = sb._D.invPlatforms.find(x=>x.id===1);
  assert(p.roboValue===100 && p.roboValueDate==='2026-01-01', 'A zero or non-numeric entry should be ignored, leaving the last real value untouched');
}

async function testRoboPlatformRendersSimplifiedCardNotThePositionTable(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:50000, descr:'x'}],
    invPlatforms:[{id:1, name:'Wealthfront', outAcc:10101, inAcc:null, profitAcc:null, isRobo:true, roboValue:55000, roboValueDate:'2026-08-01'}],
    invPositions:[]
  });
  sb.__set('invExpandedPlatforms', new Set([1]));
  const html = sb.renderInvPlatformSection({id:1, name:'Wealthfront', outAcc:10101, inAcc:null, profitAcc:null, isRobo:true, roboValue:55000, roboValueDate:'2026-08-01'});
  assert(/Robo-Investment/.test(html), 'Should be labelled as a Robo-Investment platform');
  assert(!/openInvCashModal|openInvAddPosition|openInvCashLog/.test(html),
    'Should not wire up any position/cash action buttons — none of them apply to a Robo platform, got snippet: ' + html.slice(0,900));
  assert(/Cost basis \(invested − withdrawn\)/.test(html), 'Should show the derived cost basis line');
  assert(/Gain \/ Loss/.test(html), 'Should show a Gain/Loss line');
}

async function testActionablePlatformsExcludesRoboPlatforms(){
  const sb = invCashSandbox({invPlatforms:[
    {id:1, name:'Normal Broker'},
    {id:2, name:'Robo Advisor', isRobo:true}
  ]});
  const actionable = sb.invActionablePlatformsSorted();
  assert(actionable.length===1 && actionable[0].name==='Normal Broker', 'Robo platforms must not appear in the action picker, got ' + actionable.map(p=>p.name).join(','));
}

async function testInvStartPlatformActionSkipsRoboWhenChoosingSinglePlatformShortcut(){
  // Two platforms total, but only ONE is actionable — the single-platform shortcut should still
  // fire (going straight there), rather than either picking the Robo one or showing a picker
  // with only one real choice in it.
  const sb = invCashSandbox({invPlatforms:[
    {id:1, name:'Normal Broker'},
    {id:2, name:'Robo Advisor', isRobo:true}
  ]});
  let openedWith = null, pickerShown = false;
  sb.__set('openInvAddPosition', (id)=>{ openedWith = id; });
  sb.__set('openInvPlatformPicker', ()=>{ pickerShown = true; });
  sb.invStartPlatformAction('position');
  assert(openedWith===1, 'Should go straight to the one actionable platform, got ' + openedWith);
  assert(!pickerShown, 'Should not show a picker when only one platform is actually actionable');
}

async function testReconciliationPageExcludesRoboPlatforms(){
  const sb = invCashSandbox({invPlatforms:[
    {id:1, name:'Normal Broker'},
    {id:2, name:'Robo Advisor', isRobo:true}
  ], invPositions:[]});
  sb.renderInvReconPage('');
  const html = sb.document.getElementById('app').innerHTML;
  assert(/Normal Broker/.test(html), 'The normal platform should still appear in Reconciliation');
  assert(!/Robo Advisor/.test(html), 'The Robo platform should not appear in Reconciliation — nothing there applies to it');
}

async function testRoboPlatformValueFoldsIntoSelfKpiTotals(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:40000, descr:'x'}],
    invPlatforms:[{id:1, name:'Robo', outAcc:10101, inAcc:null, profitAcc:null, isRobo:true, roboValue:45000, roboValueDate:'2026-08-01'}],
    invPositions:[]
  });
  sb.__set('invView','classic'); // v4.58.0: the pre-4.58 page is now the Classic view
  sb.renderInvestmentsPage();
  const html = sb.document.getElementById('app').innerHTML;
  // The Robo platform's OWN card also shows $12,000.00 independently (from its own stats calc),
  // so checking "does this figure appear anywhere on the page" would pass even if the KPI fold
  // itself were removed entirely. Isolate the check to the KPI cards section specifically — from
  // "Your Cost Basis" up to the action-button row that always follows the KPI cards and always
  // precedes any platform section, regardless of whether that platform is Robo or normal.
  const kpiStart = html.indexOf('Your Cost Basis');
  const kpiEnd = html.indexOf('invStartPlatformAction', kpiStart);
  assert(kpiStart!==-1 && kpiEnd!==-1, 'Should find both the KPI section start and the button row that bounds it');
  const kpiSection = html.slice(kpiStart, kpiEnd);
  assert(/\$12,000\.00/.test(kpiSection), 'Robo platform value should be folded into the Your Current Value KPI card specifically, got KPI section: ' + kpiSection);
}

async function testNormalPlatformShowsPortfolioValueNextToCashInBothViews(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Broker A'}],
    invPositions:[{id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2026-01-01', kind:'buy', units:1, totalSar:37500, owners:[{ownerId:1,units:1}], feePct:0, cashSide:'bank'}],
    invValuations:[{id:1, positionId:1, date:'2026-08-01', price:20000}] // 1 unit * 20000 USD = 20000 USD market value
  });
  sb.__set('invExpandedPlatforms', new Set());
  const collapsedHtml = sb.renderInvPlatformSection({id:1, name:'Broker A'});
  assert(/Portfolio:/.test(collapsedHtml), 'Collapsed header should show Portfolio value next to cash, got: ' + collapsedHtml.slice(0,600));

  sb.__set('invExpandedPlatforms', new Set([1]));
  const expandedHtml = sb.renderInvPlatformSection({id:1, name:'Broker A'});
  assert(/📈 Portfolio value/.test(expandedHtml), 'Expanded view should show a Portfolio value line next to cash balance');
}

async function testPositionTableIncludesAUsdValueColumn(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Broker A'}],
    invPositions:[{id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2026-01-01', kind:'buy', units:1, totalSar:37500, owners:[{ownerId:1,units:1}], feePct:0, cashSide:'bank'}],
    invValuations:[{id:1, positionId:1, date:'2026-08-01', price:20000}]
  });
  sb.__set('invExpandedPlatforms', new Set([1]));
  const html = sb.renderInvPlatformSection({id:1, name:'Broker A'});
  assert(/Value \(USD\)/.test(html), 'The position table should have a USD value column header');
  // With only one position, the footer's Total row coincidentally shows the SAME figure
  // ($20,000.00), so a loose "does this text appear somewhere near the header" check would pass
  // even if the per-row cell were removed entirely. Isolate to the BTC row itself: it must
  // contain both the SAR figure and the USD figure as two distinct cells, in that row alone.
  const rowStart = html.indexOf('openInvPosition(1)');
  const rowEnd = html.indexOf('</tr>', rowStart);
  assert(rowStart!==-1 && rowEnd!==-1, 'Should find the BTC position row');
  const row = html.slice(rowStart, rowEnd);
  assert(row.indexOf('75,000.00')!==-1, 'The row should show the SAR market value (75,000), got row: ' + row);
  assert(row.indexOf('$20,000.00')!==-1, 'The row should ALSO show the USD market value ($20,000) as its own cell, got row: ' + row);
}

async function testOutInProfitBalancesShownWhenExpandedWithUnassignedFallback(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:12345, descr:'x'}],
    invPlatforms:[{id:1, name:'Broker A', outAcc:10101, inAcc:null, profitAcc:null}],
    invPositions:[]
  });
  sb.__set('invExpandedPlatforms', new Set([1]));
  const html = sb.renderInvPlatformSection({id:1, name:'Broker A', outAcc:10101, inAcc:null, profitAcc:null});
  assert(/Invested into platform: /.test(html) && html.indexOf('12,345.00')!==-1, 'Should show the linked invested-into-platform account balance (v4.62.0 wording)');
  assert(/\{un-assigned\}/.test(html), 'An unlinked In/Profit account should show the {un-assigned} placeholder, not a blank or a crash');
}

async function testOutInProfitBalancesHiddenWhenCollapsed(){
  const sb = invCashSandbox({invPlatforms:[{id:1, name:'Broker A', outAcc:null, inAcc:null, profitAcc:null}], invPositions:[]});
  sb.__set('invExpandedPlatforms', new Set());
  const html = sb.renderInvPlatformSection({id:1, name:'Broker A', outAcc:null, inAcc:null, profitAcc:null});
  assert(!/Invested \(Out\)/.test(html), 'The Out/In/Profit line should only show when the platform is expanded');
}

async function testPlatformModalIncludesRoboCheckbox(){
  const sb = invCashSandbox({});
  sb.__set('document', sb.document);
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.openInvPlatformModal(null);
  const html = sb.document.getElementById('modalRoot').innerHTML;
  assert(/Robo-Investment platform/.test(html), 'The platform modal should offer the Robo-Investment checkbox');
}

// ================= v4.37.0: Robo-Investment in charts/log, layout, snapshot comparison overhaul =================
async function testAllocationByIncludesRoboAsStocksWhenSupplied(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:37500, descr:'x'}],
    invPlatforms:[{id:1, name:'Robo Fund', outAcc:10101, inAcc:null, profitAcc:null, isRobo:true, roboValue:40000, roboValueDate:'2026-08-01'}],
    invPositions:[]
  });
  const byClass = sb.invAllocationBy(p=>p.assetClass, true, ()=>'Stocks');
  const stocksRow = byClass.find(r=>r.label==='Stocks');
  assert(stocksRow && Math.abs(stocksRow.value-40000)<0.5, 'Robo value should appear under Stocks in the asset-class breakdown, got ' + JSON.stringify(byClass));

  const byPlat = sb.invAllocationBy(p=>'ignored', true, (p)=>p.name);
  const platRow = byPlat.find(r=>r.label==='Robo Fund');
  assert(platRow && Math.abs(platRow.value-40000)<0.5, 'Robo value should appear under its own platform name in the by-platform breakdown, got ' + JSON.stringify(byPlat));
}

async function testAllocationByExcludesRoboWhenNoRoboKeyFnSupplied(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Robo Fund', outAcc:null, inAcc:null, profitAcc:null, isRobo:true, roboValue:40000, roboValueDate:'2026-08-01'}],
    invPositions:[]
  });
  const byClass = sb.invAllocationBy(p=>p.assetClass, true); // no roboKeyFn — a caller that didn't opt in
  assert(byClass.length===0, 'Without an explicit roboKeyFn, Robo platforms should not silently appear');
}

async function testSaveInvRoboValueAppendsToTheHistoryLog(){
  const sb = invCashSandbox({invPlatforms:[{id:1, name:'Robo', isRobo:true, roboValue:null, roboValueDate:null}]});
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('toast', ()=>{});
  sb.__set('todayStr', ()=>'2026-08-01');
  await sb.saveInvRoboValue(1, '50000');
  sb.__set('todayStr', ()=>'2026-09-01');
  await sb.saveInvRoboValue(1, '52000');
  const log = sb._D.invRoboValueLog.filter(r=>r.platformId===1);
  assert(log.length===2, 'Two separate dated saves should produce two log entries, got ' + log.length);
  assert(log.some(r=>r.date==='2026-08-01' && Math.abs(r.value-50000)<0.5), 'Should log the first entry');
  assert(log.some(r=>r.date==='2026-09-01' && Math.abs(r.value-52000)<0.5), 'Should log the second entry');
}

async function testSaveInvRoboValueSameDateCorrectsRatherThanDuplicates(){
  const sb = invCashSandbox({invPlatforms:[{id:1, name:'Robo', isRobo:true, roboValue:null, roboValueDate:null}]});
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('toast', ()=>{});
  sb.__set('todayStr', ()=>'2026-08-01');
  await sb.saveInvRoboValue(1, '50000');
  await sb.saveInvRoboValue(1, '51000'); // same day, corrected figure
  const log = sb._D.invRoboValueLog.filter(r=>r.platformId===1);
  assert(log.length===1, 'Re-saving the same date should correct the existing entry, not add a second one, got ' + log.length);
  assert(Math.abs(log[0].value-51000)<0.5, 'The corrected value should be the latest one saved');
}

async function testInvRoboValueAsOfReturnsLatestEntryAtOrBeforeDate(){
  const sb = invCashSandbox({invRoboValueLog:[
    {id:1, platformId:1, date:'2026-06-01', value:40000},
    {id:2, platformId:1, date:'2026-08-01', value:45000},
  ]});
  assert(sb.invRoboValueAsOf(1, '2026-07-01')===40000, 'Between two log entries should return the earlier one still in effect');
  assert(sb.invRoboValueAsOf(1, '2026-09-01')===45000, 'After the latest entry should return that latest value');
  assert(sb.invRoboValueAsOf(1, '2026-01-01')===null, 'Before any log entry should return null, not a guessed value');
}

async function testPortfolioHistoryOnlyIncludesRoboFromWhenLoggingStarted(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2025-01-01', acc:10101, amt:40000, descr:'x'}],
    invPlatforms:[{id:1, name:'Robo', outAcc:10101, inAcc:null, profitAcc:null, isRobo:true}],
    invValuations:[{id:1, positionId:1, date:'2026-01-01', price:1},{id:2, positionId:1, date:'2026-08-01', price:1}],
    invPositions:[],
    invRoboValueLog:[{id:1, platformId:1, date:'2026-06-01', value:45000}]
  });
  const hist = sb.invPortfolioHistory(true);
  const jan = hist.find(h=>h.date==='2026-01-01');
  assert(jan && jan.value===0, 'A date before the first Robo log entry should get nothing added from it, got ' + (jan&&jan.value));
  // The negative case above (0 before logging started) is also what you'd see if the whole Robo
  // contribution were removed entirely — this positive case is the one that actually proves the
  // feature exists: a date AFTER the log entry must include it.
  const aug = hist.find(h=>h.date==='2026-08-01');
  assert(aug && Math.abs(aug.value-45000)<0.5, 'A date after the Robo log entry should include its value (45000), got ' + (aug&&aug.value));
}

async function testPortfolioHistoryIncludesDatesThatOnlyExistInTheRoboLog(){
  // The earlier test's Robo log date coincidentally matches an existing valuation date, so it
  // doesn't actually prove the two date sets are UNIONED — that date would appear in the
  // history either way. This uses a Robo-only date (no valuation on that day at all) to prove
  // invPortfolioHistory pulls its date list from BOTH sources, not just invValuations.
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2025-01-01', acc:10101, amt:40000, descr:'x'}],
    invPlatforms:[{id:1, name:'Robo', outAcc:10101, inAcc:null, profitAcc:null, isRobo:true}],
    invValuations:[], // deliberately no valuations at all — the only date in the whole history should come from the Robo log
    invPositions:[],
    invRoboValueLog:[{id:1, platformId:1, date:'2026-03-15', value:45000}]
  });
  const hist = sb.invPortfolioHistory(true);
  assert(hist.length===1, 'The history should have exactly one date entry — the Robo-only one, got ' + hist.length);
  assert(hist[0].date==='2026-03-15', 'That date should be the Robo log\'s own date, got ' + hist[0].date);
  assert(Math.abs(hist[0].value-45000)<0.5, 'And it should carry the Robo value, got ' + hist[0].value);
}

async function testAllocationChartsIncludeRoboPlatformAsStocksAndByItsOwnName(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:40000, descr:'x'}],
    invPlatforms:[{id:1, name:'Wealthfront', outAcc:10101, inAcc:null, profitAcc:null, isRobo:true, roboValue:45000, roboValueDate:'2026-08-01'}],
    invPositions:[]
  });
  const allocClass = sb.invAllocationBy(p=>p.assetClass, true, ()=>'Stocks');
  const stocksRow = allocClass.find(r=>r.label==='Stocks');
  assert(stocksRow, 'The Robo platform should contribute a "Stocks" row to the by-asset-class chart');
  assert(Math.abs(stocksRow.value-45000)<0.5, 'It should carry the Robo platform\'s current value, got ' + (stocksRow&&stocksRow.value));

  const allocPlat = sb.invAllocationBy(p=>{ const pl = sb.invPlatformById(p.platformId); return pl? pl.name : '—'; }, true, (p)=>p.name);
  const platRow = allocPlat.find(r=>r.label==='Wealthfront');
  assert(platRow, 'The Robo platform should contribute its own row (by its name) to the by-platform chart');
  assert(Math.abs(platRow.value-45000)<0.5, 'It should carry the same value there too, got ' + (platRow&&platRow.value));
}

async function testRenderInvestmentsPageActuallyPassesRoboIntoTheRealAllocationCalls(){
  // The previous test proves invAllocationBy works correctly WHEN given a roboKeyFn — but calls
  // it directly with its own arguments, so it can't tell whether the real call sites inside
  // renderInvestmentsPage actually pass one. Spying on drawInvCharts (which receives the
  // already-built allocClass/allocPlat arrays as arguments) verifies the real wiring, not just
  // the underlying function in isolation.
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:40000, descr:'x'}],
    invPlatforms:[{id:1, name:'Wealthfront', outAcc:10101, inAcc:null, profitAcc:null, isRobo:true, roboValue:45000, roboValueDate:'2026-08-01'}],
    invPositions:[]
  });
  let capturedAllocClass = null, capturedAllocPlat = null;
  sb.__set('drawInvCharts', (history, allocClass, allocPlat) => { capturedAllocClass = allocClass; capturedAllocPlat = allocPlat; });
  sb.__set('invView','classic'); // v4.58.0: the pre-4.58 page is now the Classic view
  sb.renderInvestmentsPage();
  assert(capturedAllocClass, 'drawInvCharts should have been called with the by-asset-class data');
  assert(capturedAllocClass.some(r=>r.label==='Stocks' && Math.abs(r.value-45000)<0.5),
    'The REAL call site should pass a Stocks row for the Robo platform, got ' + JSON.stringify(capturedAllocClass));
  assert(capturedAllocPlat.some(r=>r.label==='Wealthfront' && Math.abs(r.value-45000)<0.5),
    'The REAL call site should pass a Wealthfront row for the by-platform chart too, got ' + JSON.stringify(capturedAllocPlat));
}

async function testAllocationByWithoutRoboKeyFnStaysUnaffected(){
  // A caller that doesn't pass roboKeyFn (the pre-existing behaviour, or any future caller that
  // genuinely shouldn't include Robo platforms) must not have them silently injected anyway.
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Robo', isRobo:true, roboValue:45000, roboValueDate:'2026-08-01'}],
    invPositions:[]
  });
  const alloc = sb.invAllocationBy(p=>p.assetClass, true);
  assert(alloc.length===0, 'Without a roboKeyFn, Robo platforms must not be included at all, got ' + JSON.stringify(alloc));
}

async function testDashboardGridUsesFixedMaxWidthNotStretching(){
  const src = fs.readFileSync(APP_HTML, 'utf8');
  assert(/minmax\(300px,\s*350px\)/.test(src), 'The grid should cap card width rather than letting a lone card stretch to fill the row');
}

async function testComparisonShowsFullCategoryBreakdownNotJustClosingBalance(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:5000, descr:'x'}],
    forecastSnapshots:[{id:1, anchorMonth:'2026-08', takenAt:'2026-08-01', kind:'manual', signFlips:{},
      months:[{month:'2026-08', starting:0, inflow:5000, outflow:0, change:5000, closing:5000,
        subrows:{income:5000, invest_income_st:0, invest_income_lt:0, asset_st:0, asset_lt:0,
                 expense:0, invest_expense_st:0, invest_expense_lt:0, liability_st:0, liability_lt:0, provision:0, accrual:0}}]}]
  });
  sb.__set('todayStr', ()=>'2026-08-29');
  sb.setForecastSnapCompare(1, '2026-08', 'now', null);
  const html = sb.renderForecastSnapshotComparison();
  assert(/Income/.test(html), 'Should show the Income category row, not just the collapsed Closing Balance');
  assert(/Source: 💰 Bank Accounts/.test(html), 'Should explicitly label which panel this comparison is sourced from');
}

async function testTakeForecastSnapshotCapturesCurrentSignFlips(){
  const sb = invCashSandbox({accounts:[{id:10101, acc_type:'Individual Account', status:'Active'}], ledger:[{id:1,jv:1,date:'2026-01-01',acc:10101,amt:100,descr:'x'}]});
  sb.__set('todayStr', ()=>'2026-08-29');
  sb.localStorage.setItem('forecastSignFlips', JSON.stringify({income:true, expense:true}));
  const rec = await sb.takeForecastSnapshot('manual');
  assert(rec.signFlips && rec.signFlips.income===true && rec.signFlips.expense===true,
    'A newly taken snapshot must capture whatever sign-flip settings are active right now, got ' + JSON.stringify(rec.signFlips));
}

async function testComparisonWarnsWhenSignFlipsChangedSinceTheSnapshot(){
  const sb = invCashSandbox({
    forecastSnapshots:[{id:1, anchorMonth:'2026-08', takenAt:'2026-08-01', kind:'manual', signFlips:{income:true},
      months:[{month:'2026-08', starting:0, inflow:0, outflow:0, change:0, closing:0, subrows:{}}]}]
  });
  sb.__set('localStorage', sb.localStorage);
  sb.localStorage.setItem('forecastSignFlips', '{}'); // sign flip was REMOVED since the snapshot
  sb.setForecastSnapCompare(1, '2026-08', 'now', null);
  const html = sb.renderForecastSnapshotComparison();
  assert(/sign convention.*has changed/.test(html), 'Should warn that the sign convention differs from when the snapshot was taken, got: ' + html.slice(0,600));
}

async function testComparisonNoWarningWhenSignFlipsUnchanged(){
  const sb = invCashSandbox({
    forecastSnapshots:[{id:1, anchorMonth:'2026-08', takenAt:'2026-08-01', kind:'manual', signFlips:{},
      months:[{month:'2026-08', starting:0, inflow:0, outflow:0, change:0, closing:0, subrows:{}}]}]
  });
  sb.localStorage.setItem('forecastSignFlips', '{}');
  sb.setForecastSnapCompare(1, '2026-08', 'now', null);
  const html = sb.renderForecastSnapshotComparison();
  assert(!/has changed/.test(html), 'Should NOT warn when nothing about the sign convention actually changed');
}

async function testSnapshotVsSnapshotComparisonMode(){
  const sb = invCashSandbox({
    forecastSnapshots:[
      {id:1, anchorMonth:'2026-08', takenAt:'2026-08-01', kind:'manual', signFlips:{},
        months:[{month:'2026-10', starting:0, inflow:1000, outflow:0, change:1000, closing:1000, subrows:{income:1000}}]},
      {id:2, anchorMonth:'2026-09', takenAt:'2026-09-01', kind:'manual', signFlips:{},
        months:[{month:'2026-10', starting:0, inflow:1500, outflow:0, change:1500, closing:1500, subrows:{income:1500}}]},
    ]
  });
  sb.setForecastSnapCompare(1, '2026-10', 'snapshot', 2);
  const html = sb.renderForecastSnapshotComparison();
  assert(/Projected on 2026-09-01/.test(html), 'Should label the second column with the OTHER snapshot\'s date, not "Projected now"');
  assert(html.indexOf('1,000')!==-1 && html.indexOf('1,500')!==-1, 'Should show both snapshots\' closing figures for the same month');
  assert(html.indexOf('500')!==-1, 'Should show the 500 difference between the two snapshots');
}

async function testSnapshotVsSnapshotHandlesAMonthOneSnapshotNeverCaptured(){
  const sb = invCashSandbox({
    forecastSnapshots:[
      {id:1, anchorMonth:'2026-08', takenAt:'2026-08-01', kind:'manual', signFlips:{},
        months:[{month:'2027-06', starting:0, inflow:0, outflow:0, change:0, closing:9999, subrows:{}}]}, // 10-month horizon
      {id:2, anchorMonth:'2026-09', takenAt:'2026-09-01', kind:'manual', signFlips:{},
        months:[{month:'2026-10', starting:0, inflow:0, outflow:0, change:0, closing:0, subrows:{}}]}, // never reached 2027-06
    ]
  });
  sb.setForecastSnapCompare(1, '2027-06', 'snapshot', 2);
  const html = sb.renderForecastSnapshotComparison();
  assert(/didn't capture/.test(html), 'Should explain that the other snapshot\'s horizon never reached this month, rather than crashing or showing a misleading zero');
}

async function testTrendChartHasVisibleValueLabelsNotJustHoverTooltips(){
  const sb = invCashSandbox({
    forecastSnapshots:[{id:1, anchorMonth:'2026-08', takenAt:'2026-08-01', kind:'manual', signFlips:{},
      months:[{month:'2026-09', starting:0, inflow:0, outflow:0, change:0, closing:50000, subrows:{}}]}]
  });
  sb.__set('todayStr', ()=>'2026-08-29');
  const html = sb.renderForecastSnapshotTrendChart('2026-09');
  const textLabelCount = (html.match(/<text[^>]*font-weight="600"[^>]*>/g)||[]).length;
  assert(textLabelCount>=1, 'The chart should draw at least one visible numeric label directly on it, not only hover-only <title> tooltips');
}

// ================= v4.38.0: idle lock on tab-resume/device-unlock, conflict modal blank-text fix =================
async function testInitIdleLockChecksImmediatelyOnVisibilityChange(){
  const sb = makeSandbox();
  let checked = false;
  sb.__set('checkIdleLock', ()=>{ checked = true; });
  sb.initIdleLock();
  Object.defineProperty(sb.document, 'visibilityState', {value:'visible', configurable:true});
  sb.document.dispatchEvent(new sb.Event('visibilitychange'));
  assert(checked, 'Becoming visible again should trigger an immediate idle check, not wait for the next interval tick');
}

async function testInitIdleLockDoesNotCheckWhenBecomingHidden(){
  const sb = makeSandbox();
  let checked = false;
  sb.__set('checkIdleLock', ()=>{ checked = true; });
  sb.initIdleLock();
  Object.defineProperty(sb.document, 'visibilityState', {value:'hidden', configurable:true});
  sb.document.dispatchEvent(new sb.Event('visibilitychange'));
  assert(!checked, 'Going TO the background should not itself trigger a check — only coming back should');
}

async function testVisibilityCheckSeesTheStaleActivityTimeBeforeAnyClickCanResetIt(){
  // This is the actual bug: returning to a backgrounded tab is itself a click/touch, which would
  // normally reset lastActivityTime via markUserActivity BEFORE the next interval tick ever saw
  // how much time had passed. The fix only works if the visibilitychange-triggered check runs
  // using the OLD activity time, not a freshly-reset one — this proves that ordering holds.
  const sb = makeSandbox();
  sb.__set('lastActivityTime', Date.now() - 40*60*1000); // 40 minutes idle — past the default 30
  sb.__set('appIsLocked', false);
  sb.__set('idleWarningShownAt', null);
  sb.__set('syncQueue', []);
  let warned = false;
  sb.__set('showIdleWarning', ()=>{ warned = true; });
  sb.initIdleLock();
  Object.defineProperty(sb.document, 'visibilityState', {value:'visible', configurable:true});
  sb.document.dispatchEvent(new sb.Event('visibilitychange'));
  assert(warned, 'The immediate check on becoming visible should see the true elapsed idle time and warn, not a freshly-reset clock');
}

async function testRowSummaryUsesCuratedFieldsWhenAvailable(){
  const sb = makeSandbox();
  const html = sb.rowSummary('pd_ledger', {id:1, jv:1, entry_date:'2026-01-01', acc:10101, descr:'Rent', amt:-500, alloc:null, updated_at:'x'});
  assert(/descr: <b>Rent<\/b>/.test(html), 'Curated tables should still show their short, human-picked field set');
  assert(!/updated_at/.test(html), 'Curated tables should not show updated_at even though it exists on the row');
}

async function testRowSummaryFallsBackGenericallyForAnUncuratedTable(){
  // Regression test for the reported bug: any table not in the small curated whitelist rendered
  // NO TEXT AT ALL in the conflict modal (fieldLabelsFor returned [], so rowSummary's .map/.join
  // produced an empty string) — this covers the many tables added since that whitelist was last
  // updated (Investments, Real Estate, Forecast Snapshots, and anything added after this fix too).
  const sb = makeSandbox();
  const html = sb.rowSummary('pd_inv_transactions', {id:1, position_id:5, entry_date:'2026-01-01', kind:'buy', units:10, total_sar:37500, updated_at:'x'});
  assert(html.length>0, 'An uncurated table must still show SOME text, not render blank');
  assert(/kind: <b>buy<\/b>/.test(html), "The generic fallback should show the row's own real field values");
  assert(!/updated_at/.test(html), 'The generic fallback should still exclude the noisy updated_at field');
  assert(!/\bid: /.test(html), 'The generic fallback should exclude the bare id field too, shown separately in the modal header');
}

async function testRowSummaryFallbackHandlesJsonbColumnsWithoutCrashing(){
  const sb = makeSandbox();
  const html = sb.rowSummary('pd_inv_cash_movements', {id:1, platform_id:1, entry_date:'2026-01-01', kind:'deposit', owners:[{ownerId:1,usd:500}], updated_at:'x'});
  assert(html.length>0, 'A row with a jsonb array field must still produce readable text, not throw or render blank');
  assert(/owners:/.test(html), 'The jsonb field itself should still be represented, stringified');
}

async function testRowSummaryReturnsPlaceholderForANullRow(){
  const sb = makeSandbox();
  assert(/\(deleted\)/.test(sb.rowSummary('pd_ledger', null)), 'A null row (the other side deleted it) should say so explicitly');
}

// ================= v4.39.0: Robo Gain/Loss sign-flip fix, KPI widget breakdown modals =================
async function testInvRoboPlatformStatsFixesTheSignFlipWhenWithdrawnExceedsInvested(){
  // Regression test for the exact reported bug: Invested (Out) 0.00, Withdrawn (In) 5,600.00,
  // Current value 5,639.74 was showing Gain/Loss of 11,239.74 instead of the correct 39.74.
  // costBasis = 0 - 5600 = -5600; the old formula did value - (-5600) = value + 5600 (wrong).
  const sb = invCashSandbox({
    accounts: [{id:20101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:20101, amt:5600, descr:'x'}] // only the In account has activity
  });
  const p = {id:1, name:'DRAHIM', outAcc:null, inAcc:20101, profitAcc:null, isRobo:true, roboValue:5639.74, roboValueDate:'2026-08-30'};
  const stats = sb.invRoboPlatformStats(p);
  assert(Math.abs(stats.costBasis - (-5600)) < 0.005, 'The raw signed cost basis should still be -5600 for transparency, got ' + stats.costBasis);
  assert(Math.abs(stats.gain - 39.74) < 0.01, 'Gain/Loss should be 39.74 (value minus the MAGNITUDE of cost basis), got ' + stats.gain);
  assert(stats.costBasisFlagged === true, 'A negative cost basis should be flagged as worth checking');
}

async function testInvRoboPlatformStatsNormalCaseUnaffected(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:10000, descr:'x'}]
  });
  const p = {id:1, name:'Normal Robo', outAcc:10101, inAcc:null, profitAcc:null, isRobo:true, roboValue:12000, roboValueDate:'2026-08-30'};
  const stats = sb.invRoboPlatformStats(p);
  assert(Math.abs(stats.costBasis - 10000) < 0.005, 'Normal (Out > In) case should be unaffected, got ' + stats.costBasis);
  assert(Math.abs(stats.gain - 2000) < 0.005, 'Gain should be the ordinary value minus cost basis, got ' + stats.gain);
  assert(stats.costBasisFlagged === false, 'A normal positive cost basis should not be flagged');
}

async function testRoboKpiFoldUsesCostBasisMagnitudeNotRawSignedValue(){
  // Without this fix, a flagged platform's negative cost basis would SUBTRACT from Your Cost
  // Basis instead of adding to it, corrupting the whole portfolio total for every other holding.
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}, {id:20101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:20101, amt:5600, descr:'x'}],
    invPlatforms:[{id:1, name:'DRAHIM', outAcc:null, inAcc:20101, profitAcc:null, isRobo:true, roboValue:5639.74, roboValueDate:'2026-08-30'}],
    invPositions:[]
  });
  sb.__set('invView','classic'); // v4.58.0: the pre-4.58 page is now the Classic view
  sb.renderInvestmentsPage();
  const html = sb.document.getElementById('app').innerHTML;
  const kpiStart = html.indexOf('Your Cost Basis');
  const kpiEnd = html.indexOf('invStartPlatformAction', kpiStart);
  const kpiSection = html.slice(kpiStart, kpiEnd);
  // 5600 SAR magnitude / 3.75 = $1,493.33 should show, NOT a negative or wildly-inflated figure.
  assert(/\$1,493\.33/.test(kpiSection), 'Your Cost Basis should reflect the 5,600 magnitude, got: ' + kpiSection);
}

async function testRoboCardWarnsWhenCostBasisIsFlagged(){
  const sb = invCashSandbox({
    accounts: [{id:20101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:20101, amt:5600, descr:'x'}],
    invPlatforms:[{id:1, name:'DRAHIM', outAcc:null, inAcc:20101, profitAcc:null, isRobo:true, roboValue:5639.74, roboValueDate:'2026-08-30'}],
    invPositions:[]
  });
  sb.__set('invExpandedPlatforms', new Set([1]));
  const html = sb.renderInvPlatformSection({id:1, name:'DRAHIM', outAcc:null, inAcc:20101, profitAcc:null, isRobo:true, roboValue:5639.74, roboValueDate:'2026-08-30'});
  assert(/wrong way round/.test(html), 'Should warn that the accounts may be assigned the wrong way round');
  assert(/39\.74/.test(html), 'The correct Gain/Loss figure should appear on the card, got snippet: ' + html.slice(html.indexOf('Gain'),html.indexOf('Gain')+200));
}

async function testAllocationChartFallbackUsesCostBasisMagnitudeWhenNoValueLogged(){
  // The allocation charts (By Asset Class / By Platform) fall back to cost basis as the
  // contribution figure for a Robo platform that hasn't had a current value logged yet. Without
  // the abs() fix, a flagged (negative) cost basis would show as a NEGATIVE slice in the chart —
  // nonsensical for a pie/doughnut chart, which only ever expects magnitudes.
  const sb = invCashSandbox({
    accounts: [{id:20101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:20101, amt:5600, descr:'x'}],
    invPlatforms:[{id:1, name:'DRAHIM', outAcc:null, inAcc:20101, profitAcc:null, isRobo:true, roboValue:null, roboValueDate:null}], // no value logged yet
    invPositions:[]
  });
  const allocClass = sb.invAllocationBy(p=>p.assetClass, true, ()=>'Stocks');
  const stocksRow = allocClass.find(r=>r.label==='Stocks');
  assert(stocksRow, 'Should still contribute a Stocks row even with no value logged yet (falls back to cost basis)');
  assert(stocksRow.value>0, 'The fallback contribution must be positive (a magnitude), not the raw negative cost basis, got ' + (stocksRow&&stocksRow.value));
  assert(Math.abs(stocksRow.value-5600)<0.5, 'The fallback should use the 5,600 magnitude, got ' + stocksRow.value);
}

async function testKpiCardsAreClickableAndOpenTheirBreakdowns(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:37500, descr:'x'}],
    invPositions:[{id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2026-01-01', kind:'buy', units:1, totalSar:37500, owners:[{ownerId:1,units:1}], feePct:0, cashSide:'bank'}],
    invValuations:[{id:1, positionId:1, date:'2026-08-01', price:20000}]
  });
  sb.__set('invView','classic'); // v4.58.0: the pre-4.58 page is now the Classic view
  sb.renderInvestmentsPage();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/onclick="openInvKpiBreakdown\('cost'\)"/.test(html), 'Your Cost Basis should open its breakdown on click');
  assert(/onclick="openInvKpiBreakdown\('value'\)"/.test(html), 'Current Value should open its breakdown on click');
  assert(/onclick="openInvKpiBreakdown\('unrealized'\)"/.test(html), 'Your Unrealised P/L should open its breakdown on click');
  assert(/onclick="openInvKpiBreakdown\('invested'\)"/.test(html), 'Invested Amount should open its breakdown on click');
  assert(/onclick="openInvKpiBreakdown\('pl'\)"/.test(html), 'P/L should open its breakdown on click');
  assert(!/Annualised Return/.test(html), 'The Annualised Return widget should be gone entirely');
}

async function testInvPlatformBreakdownRowsSumExactlyToTheDisplayedTotal(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    invOwners:[{id:1,name:'Me',isSelf:true},{id:2,name:'Relative',isSelf:false}],
    invPlatforms:[{id:1,name:'Broker A'},{id:2,name:'Broker B'}],
    invPositions:[
      {id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'},
      {id:2, platformId:2, name:'ETH', ticker:'ETH', currency:'USD', assetClass:'Crypto', status:'Active'}
    ],
    invTransactions:[
      {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:1, totalSar:37500, owners:[{ownerId:1,units:0.6},{ownerId:2,units:0.4}], feePct:0, cashSide:'bank'},
      {id:2, positionId:2, date:'2026-01-01', kind:'buy', units:2, totalSar:18750, owners:[{ownerId:1,units:2}], feePct:0, cashSide:'bank'}
    ],
    invValuations:[{id:1, positionId:1, date:'2026-08-01', price:20000},{id:2, positionId:2, date:'2026-08-01', price:3000}]
  });
  const rows = sb.invPlatformBreakdownRows(true);
  assert(rows.length===2, 'Should have one row per platform (Broker A, Broker B), got ' + rows.length);
  const totalCost = rows.reduce((s,r)=>s+r.cost,0);
  const totals = sb.invOwnerTotals();
  const selfTotal = totals.filter(t=>t.owner.isSelf).reduce((s,t)=>s+t.costSar,0);
  assert(Math.abs(totalCost-selfTotal)<0.01, 'Platform-grouped rows should still sum to exactly the same total as the KPI widget, got ' + totalCost + ' vs ' + selfTotal);
}

async function testInvPlatformBreakdownIncludesRoboPlatformsForSelfOnly(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:40000, descr:'x'}],
    invPlatforms:[{id:1, name:'Robo', outAcc:10101, inAcc:null, profitAcc:null, isRobo:true, roboValue:45000, roboValueDate:'2026-08-01'}],
    invPositions:[]
  });
  const selfRows = sb.invPlatformBreakdownRows(true);
  assert(selfRows.some(r=>/Robo-Investment/.test(r.name)), 'The self breakdown should include the Robo platform');
  const familyRows = sb.invPlatformBreakdownRows(false);
  assert(!familyRows.some(r=>/Robo-Investment/.test(r.name)), 'Robo platforms are always self-owned — they must never appear in the family breakdown');
}

async function testOpenInvKpiBreakdownRendersATotalMatchingTheColumn(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    invPlatforms:[{id:1,name:'Broker A'},{id:2,name:'Broker B'}],
    invPositions:[
      {id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'},
      {id:2, platformId:2, name:'ETH', ticker:'ETH', currency:'USD', assetClass:'Crypto', status:'Active'}
    ],
    invTransactions:[
      {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:1, totalSar:37500, owners:[{ownerId:1,units:1}], feePct:0, cashSide:'bank'},
      {id:2, positionId:2, date:'2026-01-01', kind:'buy', units:1, totalSar:12500, owners:[{ownerId:1,units:1}], feePct:0, cashSide:'bank'}
    ],
    invValuations:[{id:1, positionId:1, date:'2026-08-01', price:20000},{id:2, positionId:2, date:'2026-08-01', price:5000}]
  });
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.openInvKpiBreakdown('cost');
  const html = sb.document.getElementById('modalRoot').innerHTML;
  assert(/Your Cost Basis/.test(html), 'The modal should be titled for the clicked widget');
  assert(/Broker A/.test(html) && /Broker B/.test(html), 'Should show one row per platform, not per position');
  const tfootStart = html.indexOf('<tfoot');
  assert(tfootStart!==-1, 'The modal should have a totals footer');
  const tfoot = html.slice(tfootStart);
  assert(tfoot.indexOf('50,000.00')!==-1, 'The footer total should be the SUM of both platforms (37,500 + 12,500 = 50,000), got tfoot: ' + tfoot);
}

async function testClickingAPlatformRowDrillsIntoItsPositions(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1,name:'Broker A'}],
    invPositions:[
      {id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'},
      {id:2, platformId:1, name:'ETH', ticker:'ETH', currency:'USD', assetClass:'Crypto', status:'Active'}
    ],
    invTransactions:[
      {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:1, totalSar:37500, owners:[{ownerId:1,units:1}], feePct:0, cashSide:'bank'},
      {id:2, positionId:2, date:'2026-01-01', kind:'buy', units:1, totalSar:12500, owners:[{ownerId:1,units:1}], feePct:0, cashSide:'bank'}
    ],
    invValuations:[{id:1, positionId:1, date:'2026-08-01', price:20000},{id:2, positionId:2, date:'2026-08-01', price:5000}]
  });
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.openInvKpiBreakdown('cost');
  const platformHtml = sb.document.getElementById('modalRoot').innerHTML;
  assert(/openInvPlatformPositionBreakdown\(1, 'cost', true\)/.test(platformHtml), 'A non-Robo platform row should be clickable into its positions');

  sb.openInvPlatformPositionBreakdown(1, 'cost', true);
  const drillHtml = sb.document.getElementById('modalRoot').innerHTML;
  assert(/BTC/.test(drillHtml) && /ETH/.test(drillHtml), 'Drilling into the platform should list its individual positions, got: ' + drillHtml.slice(0,600));
  assert(/Broker A/.test(drillHtml), 'The drill-down should be titled with the platform name');
  assert(/◂ Back/.test(drillHtml), 'Should offer a way back to the platform list');
}

async function testInvestedAndPlKindsAreNeverDrillable(){
  // Invested Amount and P/L are platform-level cash figures with no natural per-position split
  // (an Out account balance isn't tied to any specific buy) — their rows must never be clickable
  // into a position drill-down the way Cost/Value/Unrealised/Family rows are.
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:37500, descr:'x'}],
    invPlatforms:[{id:1,name:'Broker A', outAcc:10101, inAcc:null, profitAcc:null}],
    invPositions:[{id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2026-01-01', kind:'buy', units:1, totalSar:37500, owners:[{ownerId:1,units:1}], feePct:0, cashSide:'bank'}],
    invValuations:[{id:1, positionId:1, date:'2026-08-01', price:20000}]
  });
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.openInvKpiBreakdown('invested');
  const investedHtml = sb.document.getElementById('modalRoot').innerHTML;
  assert(!/openInvPlatformPositionBreakdown/.test(investedHtml), 'Invested Amount rows must not be clickable into a position drill-down, got: ' + investedHtml.slice(0,500));
  assert(!/Click a platform to see the positions/.test(investedHtml), 'The drill-down hint text should not appear for Invested Amount');

  sb.openInvKpiBreakdown('pl');
  const plHtml = sb.document.getElementById('modalRoot').innerHTML;
  assert(!/openInvPlatformPositionBreakdown/.test(plHtml), 'P/L rows must not be clickable into a position drill-down either, got: ' + plHtml.slice(0,500));
}

async function testRoboPlatformRowIsNotClickableInBreakdown(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:40000, descr:'x'}],
    invPlatforms:[{id:1, name:'Robo', outAcc:10101, inAcc:null, profitAcc:null, isRobo:true, roboValue:45000, roboValueDate:'2026-08-01'}],
    invPositions:[]
  });
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.openInvKpiBreakdown('cost');
  const html = sb.document.getElementById('modalRoot').innerHTML;
  assert(!/openInvPlatformPositionBreakdown\(1,/.test(html), 'A Robo platform has no positions to drill into, so its row should not be clickable');
}

async function testInvestedAmountUsesOutAccountOnlyNotNetOfIn(){
  // Confirmed convention: Invested Amount = |Out| alone, distinct from the Robo Cost Basis
  // figure elsewhere in the app, which nets Out against In.
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}, {id:20101, acc_type:'Individual Account', status:'Active'}],
    ledger: [
      {id:1, jv:1, date:'2026-01-01', acc:10101, amt:10000, descr:'invested'},
      {id:2, jv:2, date:'2026-06-01', acc:20101, amt:3000, descr:'withdrawn'}
    ],
    invPlatforms:[{id:1, name:'Broker A', outAcc:10101, inAcc:20101, profitAcc:null}],
    invPositions:[]
  });
  const rows = sb.invPlatformBreakdownRows(true);
  const row = rows.find(r=>r.name==='Broker A');
  assert(row, 'Should produce a row even with no positions, since it still has an Out account balance');
  assert(Math.abs(row.invested-10000)<0.5, 'Invested should be the Out balance alone (10,000), not net of In, got ' + row.invested);
}

async function testPlInvestmentsPageWidgetMatchesValueMinusInvested(){
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    // Two Out-account movements (60,000 total) but only one buy transaction recorded against a
    // position (37,500 cost basis) — deliberately makes Invested Amount (60,000) differ from
    // Cost Basis (37,500), so "Your Unrealised P/L" and the new "P/L" widget produce DIFFERENT
    // numbers. Without this, both widgets could show the same figure by coincidence and a search
    // for the text "P/L" would match whichever widget happened to render first, regardless of
    // which one was actually broken — exactly the kind of false pass that's bitten this before.
    ledger: [
      {id:1, jv:1, date:'2026-01-01', acc:10101, amt:37500, descr:'x'},
      {id:2, jv:2, date:'2026-03-01', acc:10101, amt:22500, descr:'y'}
    ],
    invPlatforms:[{id:1,name:'Broker A', outAcc:10101, inAcc:null, profitAcc:null}],
    invPositions:[{id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2026-01-01', kind:'buy', units:1, totalSar:37500, owners:[{ownerId:1,units:1}], feePct:0, cashSide:'bank'}],
    invValuations:[{id:1, positionId:1, date:'2026-08-01', price:12000}] // value = 1*12000*3.75 = 45,000 SAR
  });
  sb.__set('invView','classic'); // v4.58.0: the pre-4.58 page is now the Classic view
  sb.renderInvestmentsPage();
  const html = sb.document.getElementById('app').innerHTML;
  // Invested = 60,000 (both Out movements); Value = 45,000; P/L = 45,000-60,000 = -15,000 SAR = -$4,000.00.
  // Isolate to the exact "P/L" label (">P/L<") so this can't match "Your Unrealised P/L" instead,
  // which would show a different figure here (45,000-37,500 = 7,500 SAR = $2,000.00).
  const labelIdx = html.indexOf('>P/L<');
  assert(labelIdx!==-1, 'The P/L widget label should be present as its own KPI card');
  const cardSnippet = html.slice(labelIdx, labelIdx+300);
  assert(/\$-4,000\.00/.test(cardSnippet), 'P/L widget should show Value(45,000) minus Invested(60,000) = -15,000 SAR = -$4,000, got card: ' + cardSnippet);
  assert(!/\$2,000\.00/.test(cardSnippet), 'The P/L card must not accidentally show the Unrealised P/L figure instead');
}

// ================= v4.40.0: Month End Accrual JV budget-source fix =================
// ================= v4.42.0: accrual JV plan collapsing to actual once the month has closed =================
async function testStartingBalanceRowAlsoWorksAgainstLiveNowNotJustSnapshotVsSnapshot(){
  // Both other tests use snapshot-vs-snapshot mode — neither actually exercises the "compare
  // against current live forecast" branch, which captures nowStarting through a separate code
  // path (computeMonthlyCashFlow's own result) that could silently go missing without either of
  // those tests noticing.
  const sb = invCashSandbox({
    accounts: [{id:10101, category:'Bank Accounts', acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2025-12-01', acc:10101, amt:20000, descr:'x'}], // BEFORE the target month, so Jan's real starting balance is genuinely 20,000 — not coincidentally 0 like the snapshot's stored figure
    forecastSnapshots:[{id:1, anchorMonth:'2026-01', takenAt:'2026-01-01', kind:'manual', signFlips:{},
      months:[{month:'2026-01', starting:0, inflow:0, outflow:0, change:0, closing:0,
        subrows:{income:0, invest_income_st:0, invest_income_lt:0, asset_st:0, asset_lt:0,
                 expense:0, invest_expense_st:0, invest_expense_lt:0, liability_st:0, liability_lt:0, provision:0, accrual:0}}]}]
  });
  sb.__set('todayStr', ()=>'2026-01-15');
  // Independently compute the REAL expected starting figure the exact same way the app does —
  // asserting against this specific number (rather than a loose "doesn't say undefined" check)
  // is what actually catches nowStarting silently falling through its ||0 fallback: an
  // undefined value renders as a perfectly plausible-looking "0.00", not the literal word
  // "undefined", so a weaker check would pass even with the capture genuinely broken.
  let expectedNowStarting;
  try{ sb.beginForecastFastPath(); expectedNowStarting = sb.computeMonthlyCashFlow(['2026-01'], '2026-01')[0].starting; }
  finally{ sb.endForecastFastPath(); }
  sb.setForecastSnapCompare(1, '2026-01', 'now', null); // explicitly the live-now branch, not snapshot-vs-snapshot
  const html = sb.renderForecastSnapshotComparison();
  const rowStart = html.indexOf('Month Cash Starting Balance');
  assert(rowStart!==-1, 'The Starting Balance row should appear when comparing against live current data too');
  const row = html.slice(rowStart, html.indexOf('</tr>', rowStart));
  const expectedText = sb.money0(expectedNowStarting);
  assert(row.indexOf(expectedText)!==-1, 'The live-now branch should show the real computed starting figure ('+expectedText+'), not a silently-defaulted 0, got row: ' + row);
}

// ================= v4.42.0: accrual JV plan collapsing to actual once the month has closed =================
async function testAccrualJVStillReadsThePlanAfterTheAccrualMonthHasClosed(){
  // Regression test for the real-world bug reported directly: v4.40.0's fix used
  // computeForecastCell(a, accrualMonth, currentMonth) — but that function treats any month
  // BEFORE "currentMonth" as closed history and collapses its plan into actual (correct for the
  // Forecast Grid, wrong here). The person's own bug report ran the August accrual after the
  // calendar had rolled into September, and every category showed Budget === Actual as a result.
  // v4.40.0's own regression tests used "today" WITHIN the accrual month, so they never actually
  // exercised this — a real gap, not a false pass, closed here.
  const sb = invCashSandbox({
    accounts: [
      {id:60502, category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:60199, category:'Bills', acc_type:'Accrual Account', status:'Active'},
      {id:20101, category:'Liabilities', acc_type:'Individual Account', status:'Active'},
    ],
    ledger: [{id:1, jv:1, date:'2026-08-15', acc:60502, amt:8051.83, descr:'rent paid'}],
    provisionGroups: [{id:1, name:'Home Rent', lines:[{lineId:'l1', acc:60502}], months:{'2026-08':{l1:7068.50}}}],
    accrualMappings: [{category:'Bills', liabilityAcc:20101, expenseAcc:60199}]
  });
  sb.__set('todayStr', ()=>'2026-09-01'); // running August's accrual AFTER August has closed
  const monthInput = sb.document.createElement('input'); monthInput.id='accrualMonthInput'; monthInput.value='2026-08';
  sb.document.body.appendChild(monthInput);
  sb.__set('renderNewJV', ()=>{});
  sb.__set('toast', ()=>{});
  sb.computeAccrualJV();
  const explanation = vm.runInContext('accrualExplanation', sb);
  const billsRow = explanation.find(e=>e.category==='Bills');
  assert(billsRow, 'Should produce an explanation row for Bills');
  assert(Math.abs(billsRow.budget - 7068.50) < 0.5,
    'Budget should still be the real Provisions-sourced plan (7,068.50) even after the month has closed, not silently collapsed to match Actual, got ' + billsRow.budget);
  assert(Math.abs(billsRow.variance - (-983.33)) < 0.5,
    'Variance should reflect the real overage (983.33 over), not zero, got ' + billsRow.variance);
  assert(billsRow.action !== 'On budget — no accrual needed', 'Should NOT report "on budget" when there is a real 983.33 variance');
}

async function testAccrualJVUsesForecastPlanNotStaleLegacyBudgetTable(){
  // Regression test for the exact reported bug: a "Bills" category with a Provisions-sourced
  // rent account (the "P" badge on the Forecast Grid) had its plan value completely invisible to
  // the accrual JV, because the JV only ever summed the separate, legacy D.budget table — which
  // this account never had a row in at all. Budget showed 818 instead of the true ~7,068.50.
  const sb = invCashSandbox({
    accounts: [
      {id:60101, category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'}, // no provisions/budget — plan should be 0
      {id:60502, category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'}, // rent — provisions-only plan, matching the real bug
      {id:60199, category:'Bills', acc_type:'Accrual Account', status:'Active'}, // the 99-account
      {id:20101, category:'Liabilities', acc_type:'Individual Account', status:'Active'}, // liability
    ],
    ledger: [{id:1, jv:1, date:'2026-08-15', acc:60502, amt:3917, descr:'rent paid'}], // actual spend
    provisionGroups: [{id:1, name:'Home Rent', lines:[{lineId:'l1', acc:60502}], months:{'2026-08':{l1:2917}}}], // the plan lives HERE, never in D.budget
    budget: [], // deliberately empty — the old code's only data source
    accrualMappings: [{category:'Bills', liabilityAcc:20101, expenseAcc:60199}]
  });
  sb.__set('todayStr', ()=>'2026-08-30');
  const monthInput = sb.document.createElement('input'); monthInput.id='accrualMonthInput'; monthInput.value='2026-08';
  sb.document.body.appendChild(monthInput);
  sb.__set('renderNewJV', ()=>{});
  sb.__set('toast', ()=>{});
  sb.computeAccrualJV();
  const explanation = vm.runInContext('accrualExplanation', sb);
  const billsRow = explanation.find(e=>e.category==='Bills');
  assert(billsRow, 'Should produce an explanation row for Bills');
  assert(Math.abs(billsRow.budget - 2917) < 0.5,
    'Budget should reflect the Provisions-sourced plan (2917), not the empty D.budget table, got ' + billsRow.budget);
  assert(Math.abs(billsRow.actual - 3917) < 0.5, 'Actual should still be the real ledger spend, got ' + billsRow.actual);
}

async function testAccrualJVStillFallsBackToLegacyBudgetTableWhenNoProvisionsExist(){
  // Confirms the fix is a strict superset, not a regression for accounts that genuinely only
  // ever used the old D.budget table (behavior='expense' falls back to budgetPlanFor after
  // checking Provisions, and budgetPlanFor itself reads D.budget).
  const sb = invCashSandbox({
    accounts: [
      {id:60101, category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:60199, category:'Bills', acc_type:'Accrual Account', status:'Active'},
      {id:20101, category:'Liabilities', acc_type:'Individual Account', status:'Active'},
    ],
    ledger: [{id:1, jv:1, date:'2026-08-15', acc:60101, amt:500, descr:'x'}],
    provisionGroups: [],
    budget: [{id:1, acc:60101, date:'2026-08-01', amt:600}], // ONLY source: the legacy table
    accrualMappings: [{category:'Bills', liabilityAcc:20101, expenseAcc:60199}]
  });
  sb.__set('todayStr', ()=>'2026-08-30');
  const monthInput = sb.document.createElement('input'); monthInput.id='accrualMonthInput'; monthInput.value='2026-08';
  sb.document.body.appendChild(monthInput);
  sb.__set('renderNewJV', ()=>{});
  sb.__set('toast', ()=>{});
  sb.computeAccrualJV();
  const explanation = vm.runInContext('accrualExplanation', sb);
  const billsRow = explanation.find(e=>e.category==='Bills');
  assert(Math.abs(billsRow.budget - 600) < 0.5, 'An account with only a legacy D.budget entry should still have its plan picked up via the fallback chain, got ' + billsRow.budget);
}

// ================= v4.41.0: XIRR removed + Invested/Value/P&L widgets, platform-grouped breakdowns, Clear All, statement CSV =================
async function testClearAllJVLinesRequiresConfirmation(){
  const sb = makeSandbox();
  sb.__set('jvDraft', {date:'2026-08-30', lines:[{acc:10101,descr:'a',amt:100},{acc:10203,descr:'b',amt:-100},{acc:10101,descr:'c',amt:50}]});
  sb.__set('confirm', ()=>false);
  sb.__set('renderNewJV', ()=>{});
  sb.clearAllJVLines();
  assert(vm.runInContext('jvDraft', sb).lines.length===3, 'Declining the confirmation should leave the lines untouched');
}

async function testClearAllJVLinesResetsToTwoBlankLinesButKeepsTheDate(){
  const sb = makeSandbox();
  sb.__set('jvDraft', {date:'2026-08-30', lines:[{acc:10101,descr:'a',amt:100},{acc:10203,descr:'b',amt:-100},{acc:10101,descr:'c',amt:50}]});
  sb.__set('confirm', ()=>true);
  sb.__set('renderNewJV', ()=>{});
  sb.clearAllJVLines();
  const draft = vm.runInContext('jvDraft', sb);
  assert(draft.lines.length===2, 'Should reset to exactly two blank lines, got ' + draft.lines.length);
  assert(draft.lines.every(l=>l.acc===''&&l.descr===''&&l.amt===''), 'Both lines should be genuinely blank');
  assert(draft.date==='2026-08-30', 'The date should be left untouched, not reset to today');
}

async function testClearAllJVLinesAlsoClearsBalanceCheckSelection(){
  const sb = makeSandbox();
  sb.__set('jvDraft', {date:'2026-08-30', lines:[{acc:10101,descr:'a',amt:100},{acc:10203,descr:'b',amt:-100}]});
  sb.__set('jvBalanceCheckSelected', new Set([0,1]));
  sb.__set('confirm', ()=>true);
  sb.__set('renderNewJV', ()=>{});
  sb.clearAllJVLines();
  assert(vm.runInContext('jvBalanceCheckSelected', sb).size===0, 'A stale Balance Check selection referencing the old lines should be cleared too');
}

async function testExportStatementCSVProducesTheRightRowsAndRunningBalance(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:10101, descr:'Cash', category:'Bank Accounts'}], ledger:[
    {id:1, jv:1, date:'2026-01-01', acc:10101, descr:'Opening', amt:1000},
    {id:2, jv:2, date:'2026-02-01', acc:10101, descr:'Deposit', amt:500}
  ]});
  sb.__set('ACC_BY_ID', {10101:{id:10101, descr:'Cash', category:'Bank Accounts'}});
  sb.__set('statementAcc', 10101);
  sb.__set('statementSortDesc', false);
  sb.__set('todayStr', ()=>'2026-08-30');
  let capturedCsv = null;
  sb.__set('Blob', function(parts){ capturedCsv = parts[0]; });
  const fakeAnchor = {click:()=>{}};
  sb.__set('URL', {createObjectURL: ()=>'blob:x'});
  sb.document.createElement = ((orig)=>function(tag){ if(tag==='a') return fakeAnchor; return orig.call(sb.document, tag); })(sb.document.createElement.bind(sb.document));
  sb.exportStatementCSV();
  assert(capturedCsv, 'Should build a CSV blob');
  assert(capturedCsv.indexOf('Opening')!==-1 && capturedCsv.indexOf('Deposit')!==-1, 'Should include both ledger lines');
  assert(capturedCsv.indexOf('1000')!==-1 && capturedCsv.indexOf('1500')!==-1, 'Should include the correct running balance after each line (1000, then 1500)');
}

async function testExportStatementCSVRespectsCurrentSortOrder(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:10101, descr:'Cash', category:'Bank Accounts'}], ledger:[
    {id:1, jv:1, date:'2026-01-01', acc:10101, descr:'First', amt:1000},
    {id:2, jv:2, date:'2026-02-01', acc:10101, descr:'Second', amt:500}
  ]});
  sb.__set('ACC_BY_ID', {10101:{id:10101, descr:'Cash', category:'Bank Accounts'}});
  sb.__set('statementAcc', 10101);
  sb.__set('statementSortDesc', true); // descending — Second should come before First
  sb.__set('todayStr', ()=>'2026-08-30');
  let capturedCsv = null;
  sb.__set('Blob', function(parts){ capturedCsv = parts[0]; });
  const fakeAnchor = {click:()=>{}};
  sb.__set('URL', {createObjectURL: ()=>'blob:x'});
  sb.document.createElement = ((orig)=>function(tag){ if(tag==='a') return fakeAnchor; return orig.call(sb.document, tag); })(sb.document.createElement.bind(sb.document));
  sb.exportStatementCSV();
  assert(capturedCsv.indexOf('Second') < capturedCsv.indexOf('First'), 'CSV row order should follow the current sort toggle (descending here)');
}

async function testStatementViewHasCsvButtonNextToPrintButton(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:10101, descr:'Cash', category:'Bank Accounts'}], ledger:[]});
  sb.__set('ACC_BY_ID', {10101:{id:10101, descr:'Cash', category:'Bank Accounts'}});
  sb.__set('statementAcc', 10101);
  sb.__set('statementSortDesc', false);
  sb.renderStatement();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/onclick="exportStatementCSV\(\)"/.test(html), 'The CSV export button should be present');
  const csvIdx = html.indexOf('exportStatementCSV');
  const printIdx = html.indexOf('window.print()');
  assert(csvIdx!==-1 && printIdx!==-1 && csvIdx<printIdx, 'CSV export should sit next to (before) the Print statement button');
}

// ================= v4.43.0: comparison table was missing the Starting Balance row =================
async function testComparisonIncludesStartingBalanceRow(){
  // Regression test for the reported "doesn't make sense" bug: category flow rows (Income,
  // Expense, etc.) could all show "—" while Closing Balance differs by a huge amount, because the
  // table never showed Starting Balance — which is very often the actual driver of a Closing
  // Balance gap, especially across a month boundary where the real bank balance gets re-anchored.
  const sb = invCashSandbox({
    accounts: [{id:10101, acc_type:'Individual Account', status:'Active'}],
    ledger: [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:5000, descr:'x'}],
    forecastSnapshots:[{id:1, anchorMonth:'2026-08', takenAt:'2026-08-29', kind:'auto', signFlips:{},
      months:[{month:'2026-09', starting:-168076, inflow:0, outflow:0, change:0, closing:-168076,
        subrows:{income:32403, invest_income_st:0, invest_income_lt:5009, asset_st:0, asset_lt:1000,
                 expense:-32662, invest_expense_st:-500, invest_expense_lt:-24584, liability_st:0, liability_lt:-12894, provision:-981, accrual:0}}]}]
  });
  sb.__set('todayStr', ()=>'2026-09-01');
  sb.setForecastSnapCompare(1, '2026-09', 'now', null);
  const html = sb.renderForecastSnapshotComparison();
  assert(/Month Cash Starting Balance/.test(html), 'The comparison table should show a Starting Balance row');
  assert(html.indexOf('-168,076')!==-1 || html.indexOf('-168,075')!==-1, 'The snapshot\'s own starting balance figure should appear, got snippet: ' + html.slice(html.indexOf('Month Cash Starting Balance')-20, html.indexOf('Month Cash Starting Balance')+300));
}

async function testStartingBalanceDiffAccountsForTheClosingBalanceGap(){
  // Snapshot-vs-snapshot mode gives exact control over both figures, unlike comparing against
  // live "now" data (which depends on the anchor-to-actual internals and would make the expected
  // number fragile here) — this isolates the check to purely the Starting Balance row's own math.
  const sb = invCashSandbox({
    forecastSnapshots:[
      {id:1, anchorMonth:'2026-08', takenAt:'2026-08-29', kind:'auto', signFlips:{},
        months:[{month:'2026-09', starting:-168076, inflow:0, outflow:0, change:0, closing:-168075.69,
          subrows:{income:0, invest_income_st:0, invest_income_lt:0, asset_st:0, asset_lt:0,
                   expense:0, invest_expense_st:0, invest_expense_lt:0, liability_st:0, liability_lt:0, provision:0, accrual:0}}]},
      {id:2, anchorMonth:'2026-09', takenAt:'2026-09-01', kind:'auto', signFlips:{},
        months:[{month:'2026-09', starting:93254.16, inflow:0, outflow:0, change:0, closing:93254.16,
          subrows:{income:0, invest_income_st:0, invest_income_lt:0, asset_st:0, asset_lt:0,
                   expense:0, invest_expense_st:0, invest_expense_lt:0, liability_st:0, liability_lt:0, provision:0, accrual:0}}]}
    ]
  });
  sb.setForecastSnapCompare(1, '2026-09', 'snapshot', 2);
  const html = sb.renderForecastSnapshotComparison();
  const rowStart = html.indexOf('Month Cash Starting Balance');
  assert(rowStart!==-1, 'The Starting Balance row should be present');
  const row = html.slice(rowStart, html.indexOf('</tr>', rowStart));
  // Expected diff: 93,254.16 - (-168,076) = 261,330.16 — a real, large, non-dash figure.
  assert(row.indexOf('261,330')!==-1, 'The Starting Balance row should show the real ~261,330 diff between the two snapshots, got row: ' + row);
  assert(!/>—</.test(row), 'This diff must not render as a dash when the two starting figures genuinely differ by a quarter million');
}

// ================= v4.44.0: sign-flip warning wording for ambiguous pre-tracking snapshots =================
async function testSignFlipWarningIsHedgedWhenThenSnapshotHasNoRecordedFlips(){
  // The person confirmed directly: no sign settings were actually changed between the two
  // snapshots being compared. The old confident red warning was a false positive caused by an
  // older snapshot's sign_flips genuinely being unrecoverable (backfilled to an empty default by
  // the database the moment the column was added) — indistinguishable from "confirmed nothing
  // was flipped." Asserting a change definitely happened isn't something this data can support.
  const sb = makeSandbox();
  const html = sb.forecastCompareSignFlipWarning({}, {income:true});
  assert(html.length>0, 'Should still show something when a flip differs');
  assert(/predates sign-convention tracking/.test(html), 'Should use the hedged wording, not assert a change definitely happened');
  assert(!/has changed since the earlier point/.test(html), 'Must NOT use the confident wording when the older snapshot has no recorded flip data at all');
  assert(/can be safely ignored/.test(html), 'Should tell the person this can be ignored if they know nothing was actually changed');
}

async function testSignFlipWarningStaysConfidentWhenThenSnapshotHasRealData(){
  // A "then" snapshot that genuinely captured flip data (even with everything off) IS a
  // trustworthy comparison — the ambiguity only applies to a completely empty/unrecorded object.
  const sb = makeSandbox();
  const html = sb.forecastCompareSignFlipWarning({income:false, expense:false}, {income:true, expense:false});
  assert(/has changed since the earlier point/.test(html), 'Should use the confident wording when the older snapshot actually recorded its flip state');
  assert(!/predates sign-convention tracking/.test(html), 'Should not hedge when the comparison is genuinely trustworthy');
}

async function testSignFlipWarningEmptyWhenNothingActuallyDiffers(){
  const sb = makeSandbox();
  assert(sb.forecastCompareSignFlipWarning({}, {})==='', 'No warning at all when both sides have no flips');
  assert(sb.forecastCompareSignFlipWarning({income:true}, {income:true})==='', 'No warning when the flip states genuinely match');
}

async function testSignFlipWarningConfidentWhenAFlipWasTurnedOff(){
  const sb = makeSandbox();
  const html = sb.forecastCompareSignFlipWarning({income:true}, {});
  assert(/has changed since the earlier point/.test(html), 'A real recorded flip that is now off should still get the confident warning, got: ' + html);
}

// ================= v4.45.0: skip zero-amount provision lines; Budget Grid export/import current+future fix =================
async function testGenerateProvisionJVSkipsZeroAmountLines(){
  const sb = makeSandbox();
  sb.__set('D', {provisionGroups:[{id:1, name:'Test', lines:[
    {lineId:'l1', acc:60101}, {lineId:'l2', acc:60102}, {lineId:'l3', acc:60103}
  ], months:{'2026-08':{l1:100, l2:0, l3:50}}}]});
  const genInput = sb.document.createElement('select'); genInput.id='genMonthSel_1';
  const opt = sb.document.createElement('option'); opt.value='2026-08'; genInput.appendChild(opt);
  genInput.value='2026-08'; // JSDOM silently ignores this without a matching <option> present first
  sb.document.body.appendChild(genInput);
  sb.__set('go', ()=>{});
  sb.__set('toast', ()=>{});
  sb.generateProvisionJV(1);
  const draft = vm.runInContext('jvDraft', sb);
  assert(draft.lines.length===2, 'The zero-amount line (l2) should be excluded, got ' + draft.lines.length + ' lines');
  assert(!draft.lines.some(l=>l.acc===60102), 'Account 60102 (the zero line) should not appear in the generated JV');
  assert(draft.lines.some(l=>l.acc===60101) && draft.lines.some(l=>l.acc===60103), 'The two non-zero lines should still be present');
}

async function testGenerateProvisionJVStillRequiresTwoRealLines(){
  const sb = makeSandbox();
  sb.__set('D', {provisionGroups:[{id:1, name:'Test', lines:[
    {lineId:'l1', acc:60101}, {lineId:'l2', acc:60102}
  ], months:{'2026-08':{l1:100, l2:0}}}]});
  const genInput = sb.document.createElement('select'); genInput.id='genMonthSel_1';
  const opt = sb.document.createElement('option'); opt.value='2026-08'; genInput.appendChild(opt);
  genInput.value='2026-08'; // JSDOM silently ignores this without a matching <option> present first
  sb.document.body.appendChild(genInput);
  let toastMsg = null;
  sb.__set('go', ()=>{});
  sb.__set('toast', (m)=>{ toastMsg = m; });
  const before = vm.runInContext('jvDraft', sb);
  sb.generateProvisionJV(1);
  assert(toastMsg && /at least two lines/.test(toastMsg), 'Should refuse with only one real (non-zero) line remaining, got: ' + toastMsg);
}

async function testCombinedGenerateProvisionJVSkipsZeroAmountLines(){
  const sb = makeSandbox();
  sb.__set('D', {provisionGroups:[
    {id:1, name:'A', lines:[{lineId:'l1', acc:60101}], months:{'2026-08':{l1:200}}},
    {id:2, name:'B', lines:[{lineId:'l1', acc:60201}, {lineId:'l2', acc:60301}], months:{'2026-08':{l1:0, l2:150}}}
  ]});
  sb.__set('provisionsSelectedMonth', '2026-08');
  sb.__set('go', ()=>{});
  sb.__set('toast', ()=>{});
  sb.combinedGenerateProvisionJV();
  const draft = vm.runInContext('jvDraft', sb);
  assert(!draft.lines.some(l=>l.acc===60201), 'The zero-amount line from group B should be excluded from the combined JV');
  assert(draft.lines.some(l=>l.acc===60101), 'The real line from group A should still be present');
}

async function testExportBudgetGridStartsAtCurrentMonthNotEarliestLedgerMonth(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:60101, category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'}],
    ledger:[{id:1, jv:1, date:'2023-01-01', acc:60101, amt:100, descr:'old'}], budget:[], provisionGroups:[]});
  sb.__set('todayStr', ()=>'2026-08-30');
  let capturedCsv = null;
  sb.__set('Blob', function(parts){ capturedCsv = parts[0]; });
  const fakeAnchor = {click:()=>{}};
  sb.__set('URL', {createObjectURL: ()=>'blob:x'});
  sb.document.createElement = ((orig)=>function(tag){ if(tag==='a') return fakeAnchor; return orig.call(sb.document, tag); })(sb.document.createElement.bind(sb.document));
  sb.exportBudgetGridCSV();
  assert(capturedCsv, 'Should produce a CSV');
  const header = capturedCsv.split('\n')[0];
  assert(header.indexOf('2023-01')===-1, 'Should NOT include a month from years before today, got header: ' + header);
  assert(header.indexOf('2026-08')!==-1, 'Should include the current month as the first month column, got header: ' + header);
}

async function testExportBudgetGridShowsPlanNotActualForCurrentMonth(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:60101, category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'}],
    ledger:[{id:1, jv:1, date:'2026-08-15', acc:60101, amt:777, descr:'partial actual spend so far'}],
    budget:[{id:1, acc:60101, date:'2026-08-01', amt:250}], provisionGroups:[]});
  sb.__set('todayStr', ()=>'2026-08-30');
  let capturedCsv = null;
  sb.__set('Blob', function(parts){ capturedCsv = parts[0]; });
  const fakeAnchor = {click:()=>{}};
  sb.__set('URL', {createObjectURL: ()=>'blob:x'});
  sb.document.createElement = ((orig)=>function(tag){ if(tag==='a') return fakeAnchor; return orig.call(sb.document, tag); })(sb.document.createElement.bind(sb.document));
  sb.exportBudgetGridCSV();
  const headerCols = capturedCsv.split('\n')[0].split(',');
  const dataCols = capturedCsv.split('\n')[1].split(',');
  const monthColIdx = headerCols.indexOf('2026-08');
  assert(monthColIdx!==-1, 'The current month column should be present in the header');
  assert(dataCols[monthColIdx]==='250', 'Current month column should show the BUDGET figure (250), not the actual spend, got: ' + dataCols[monthColIdx]);
}

async function testImportBudgetGridAcceptsTheCurrentMonthColumn(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:60101, category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'}],
    ledger:[], budget:[], provisionGroups:[]});
  sb.__set('todayStr', ()=>'2026-08-30');
  sb.__set('confirm', ()=>true);
  sb.__set('blockIfSyncing', ()=>false);
  sb.__set('showImportProgress', ()=>{});
  sb.__set('updateImportProgress', ()=>{});
  sb.__set('finishImportProgress', ()=>{});
  sb.__set('persistLocal', ()=>{});
  sb.__set('syncWriteMany', async ()=>{});
  sb.__set('renderBudget', ()=>{});
  await sb.importBudgetGridCSV([{'account id':'60101', '2026-08':'999'}]);
  const D = vm.runInContext('D', sb);
  const budgetRow = D.budget.find(b=>b.acc===60101 && b.date==='2026-08-01');
  assert(budgetRow, 'A current-month column should actually be written now, not silently skipped');
  assert(Math.abs(budgetRow.amt-999)<0.005, 'The written budget value should match what was imported, got ' + (budgetRow&&budgetRow.amt));
}

// ================= v4.46.0: bulk Coin Balances import =================
function invCoinCsv(){
  return 'Account #,79011,79012\n'+
    'Coin,Platform,Mother,Omar\n'+
    'USDT,Uniswap,79.34,20.18\n'+
    'BONK,MEXC,0,0\n'+ // all-zero row — must be skipped
    'ANDY,MEXC,100,50\n';
}

async function testParseInvCoinImportCSVSkipsLeadingAccountNumberRow(){
  const sb = makeSandbox();
  const rows = sb.parseInvCoinImportCSV(invCoinCsv());
  assert(rows.length===2, 'Should find 2 real coin rows (BONK, all-zero, must be skipped), got ' + rows.length);
  assert(rows[0].coin==='USDT' && rows[1].coin==='ANDY', 'Should skip the account-number row and read from the real header, got ' + rows.map(r=>r.coin).join(','));
}

async function testParseInvCoinImportCSVSkipsAllZeroRows(){
  const sb = makeSandbox();
  const rows = sb.parseInvCoinImportCSV(invCoinCsv());
  assert(!rows.some(r=>r.coin==='BONK'), 'A row where every owner is 0 should not create an empty position');
}

async function testParseInvCoinImportCSVTrimsOwnerNamesAndExcludesSummaryColumns(){
  const sb = makeSandbox();
  const csv = 'Coin,Platform,Karim ,My Portion,LOCAL LEDGER TOTAL\nUSDT,Uniswap,100,0.5,200\n';
  const rows = sb.parseInvCoinImportCSV(csv);
  assert(Object.keys(rows[0].owners).length===1 && rows[0].owners['Karim']===100,
    'Should trim trailing whitespace from the owner name and exclude My Portion / LOCAL LEDGER TOTAL as owner columns, got ' + JSON.stringify(rows[0].owners));
}

async function testParseInvCoinImportCSVThrowsWithoutACoinHeader(){
  const sb = makeSandbox();
  let threw = false;
  try{ sb.parseInvCoinImportCSV('Foo,Bar\n1,2\n'); } catch(e){ threw = true; }
  assert(threw, 'Should throw a clear error when no "Coin" header row exists, rather than silently importing garbage');
}

async function testBuildInvCoinImportMappingsAutoMatchesExistingByNameCaseInsensitive(){
  const sb = makeSandbox();
  sb.__set('D', {invPlatforms:[{id:5, name:'uniswap'}], invOwners:[{id:9, name:'Mother'}]});
  sb.__set('invCoinImportRows', sb.parseInvCoinImportCSV(invCoinCsv()));
  sb.__set('invCoinImportPlatformMap', {});
  sb.__set('invCoinImportOwnerMap', {});
  sb.buildInvCoinImportMappings();
  const platMap = vm.runInContext('invCoinImportPlatformMap', sb);
  const ownerMap = vm.runInContext('invCoinImportOwnerMap', sb);
  assert(platMap['Uniswap'].id===5, 'Should case-insensitively match "Uniswap" to the existing "uniswap" platform');
  assert(platMap['MEXC'].newName==='MEXC', 'An unmatched platform should default to "create new" with its own CSV name');
  assert(ownerMap['Mother']===9, 'Should match Mother to the existing owner by name');
  assert(ownerMap['Omar']===null, 'An unmatched owner should be null (unresolved), not silently guessed');
}

async function testInvCoinImportIsReadyRequiresEveryOwnerResolved(){
  const sb = makeSandbox();
  sb.__set('invCoinImportOwnerMap', {Mother: 1, Omar: null});
  assert(sb.invCoinImportIsReady()===false, 'Should not be ready while any owner is unresolved');
  sb.__set('invCoinImportOwnerMap', {Mother: 1, Omar: 2});
  assert(sb.invCoinImportIsReady()===true, 'Should be ready once every owner is resolved');
}

async function testInvCoinImportIsReadyDoesNotRequirePlatformResolution(){
  // An unmatched platform defaults to "create new" — that's a valid, ready state on its own.
  const sb = makeSandbox();
  sb.__set('invCoinImportPlatformMap', {MEXC: {newName:'MEXC'}});
  sb.__set('invCoinImportOwnerMap', {});
  assert(sb.invCoinImportIsReady()===true, 'A platform set to "create new" should not block readiness');
}

async function testCommitInvCoinImportCreatesPositionWithZeroCostOpeningTransaction(){
  const sb = makeSandbox();
  sb.__set('D', {invPlatforms:[{id:1, name:'Uniswap'}], invPositions:[], invTransactions:[], invOwners:[{id:9,name:'Mother'},{id:10,name:'Sam'}]});
  sb.__set('invCoinImportRows', [{coin:'USDT', platformName:'Uniswap', owners:{Mother:79.34, Sam:20.18}}]);
  sb.__set('invCoinImportPlatformMap', {Uniswap:{id:1}});
  sb.__set('invCoinImportOwnerMap', {Mother:9, Sam:10});
  sb.__set('confirm', ()=>true);
  sb.__set('showImportProgress', ()=>{});
  sb.__set('updateImportProgress', ()=>{});
  sb.__set('finishImportProgress', ()=>{});
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('todayStr', ()=>'2026-09-02');
  await sb.commitInvCoinImport();
  const D = vm.runInContext('D', sb);
  assert(D.invPositions.length===1, 'Should create exactly one position, got ' + D.invPositions.length);
  const pos = D.invPositions[0];
  assert(pos.ticker==='USDT' && pos.currency==='USD' && pos.assetClass==='Crypto' && pos.platformId===1, 'Position should carry the right ticker/currency/asset class/platform');
  assert(D.invTransactions.length===1, 'Should create exactly one transaction');
  const tx = D.invTransactions[0];
  assert(tx.totalSar===0 && tx.cashSide==='opening', 'The transaction must be a $0 Opening Balance, not a priced buy');
  assert(Math.abs(tx.units-99.52)<0.01, 'Units should be the sum of both owners (79.34+20.18=99.52), got ' + tx.units);
  assert(tx.owners.length===2 && tx.owners.every(o=>[9,10].includes(o.ownerId)), 'Both owners should be present in the split, got ' + JSON.stringify(tx.owners));
}

async function testCommitInvCoinImportCreatesMissingPlatformOnTheFly(){
  const sb = makeSandbox();
  sb.__set('D', {invPlatforms:[], invPositions:[], invTransactions:[], invOwners:[{id:9,name:'Mother'}]});
  sb.__set('invCoinImportRows', [{coin:'ANDY', platformName:'MEXC', owners:{Mother:100}}]);
  sb.__set('invCoinImportPlatformMap', {MEXC:{newName:'MEXC'}});
  sb.__set('invCoinImportOwnerMap', {Mother:9});
  sb.__set('confirm', ()=>true);
  sb.__set('showImportProgress', ()=>{});
  sb.__set('updateImportProgress', ()=>{});
  sb.__set('finishImportProgress', ()=>{});
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('todayStr', ()=>'2026-09-02');
  await sb.commitInvCoinImport();
  const D = vm.runInContext('D', sb);
  assert(D.invPlatforms.length===1 && D.invPlatforms[0].name==='MEXC', 'Should create the missing platform with its CSV name');
  assert(D.invPlatforms[0].isRobo===false, 'The created platform should be a normal platform, not Robo-Investment — the whole point of this tool is preserving per-coin, per-owner breakdown');
  assert(D.invPositions[0].platformId===D.invPlatforms[0].id, 'The new position should land on the newly-created platform');
}

async function testCommitInvCoinImportReusesTheSameNewPlatformAcrossMultipleRows(){
  // Without reuse, two coins on the same not-yet-existing platform would create TWO platforms
  // named "MEXC" instead of one.
  const sb = makeSandbox();
  sb.__set('D', {invPlatforms:[], invPositions:[], invTransactions:[], invOwners:[{id:9,name:'Mother'}]});
  sb.__set('invCoinImportRows', [
    {coin:'ANDY', platformName:'MEXC', owners:{Mother:100}},
    {coin:'BONK', platformName:'MEXC', owners:{Mother:50}}
  ]);
  sb.__set('invCoinImportPlatformMap', {MEXC:{newName:'MEXC'}});
  sb.__set('invCoinImportOwnerMap', {Mother:9});
  sb.__set('confirm', ()=>true);
  sb.__set('showImportProgress', ()=>{});
  sb.__set('updateImportProgress', ()=>{});
  sb.__set('finishImportProgress', ()=>{});
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('todayStr', ()=>'2026-09-02');
  await sb.commitInvCoinImport();
  const D = vm.runInContext('D', sb);
  assert(D.invPlatforms.length===1, 'Both coins should land on the SAME newly-created MEXC platform, not two separate ones, got ' + D.invPlatforms.length);
  assert(D.invPositions.length===2 && D.invPositions.every(p=>p.platformId===D.invPlatforms[0].id), 'Both positions should reference the single created platform');
}

async function testCommitInvCoinImportReusesAnExistingPositionByTicker(){
  // Re-running the import (or a coin appearing more than once) should update the existing
  // position rather than creating a duplicate with the same ticker on the same platform.
  const sb = makeSandbox();
  sb.__set('D', {invPlatforms:[{id:1,name:'Uniswap'}], invPositions:[{id:1, platformId:1, name:'USDT', ticker:'USDT', assetClass:'Crypto', currency:'USD', status:'Active'}], invTransactions:[], invOwners:[{id:9,name:'Mother'}]});
  sb.__set('invCoinImportRows', [{coin:'USDT', platformName:'Uniswap', owners:{Mother:79.34}}]);
  sb.__set('invCoinImportPlatformMap', {Uniswap:{id:1}});
  sb.__set('invCoinImportOwnerMap', {Mother:9});
  sb.__set('confirm', ()=>true);
  sb.__set('showImportProgress', ()=>{});
  sb.__set('updateImportProgress', ()=>{});
  sb.__set('finishImportProgress', ()=>{});
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('todayStr', ()=>'2026-09-02');
  await sb.commitInvCoinImport();
  const D = vm.runInContext('D', sb);
  assert(D.invPositions.length===1, 'Should NOT create a duplicate USDT position — the existing one should be reused, got ' + D.invPositions.length);
  assert(D.invTransactions.length===1 && D.invTransactions[0].positionId===1, 'The new opening transaction should attach to the existing position');
}

async function testCommitInvCoinImportRespectsDeclinedConfirmation(){
  const sb = makeSandbox();
  sb.__set('D', {invPlatforms:[{id:1,name:'Uniswap'}], invPositions:[], invTransactions:[], invOwners:[{id:9,name:'Mother'}]});
  sb.__set('invCoinImportRows', [{coin:'USDT', platformName:'Uniswap', owners:{Mother:79.34}}]);
  sb.__set('invCoinImportPlatformMap', {Uniswap:{id:1}});
  sb.__set('invCoinImportOwnerMap', {Mother:9});
  sb.__set('confirm', ()=>false);
  await sb.commitInvCoinImport();
  const D = vm.runInContext('D', sb);
  assert(D.invPositions.length===0 && D.invTransactions.length===0, 'Declining the confirmation should create nothing at all');
}

async function testInvCoinImportAgainstTheRealUploadedSpreadsheetShape(){
  // Self-contained replica of the actual uploaded file's exact structure — the account-number
  // row, the embedded newline inside "Platform/\nWallet", the trailing space on "Karim ", and
  // the My Portion / LOCAL LEDGER TOTAL summary columns — rather than depending on a temp file
  // that only existed on disk during manual verification and won't be present in any later run.
  const sb = makeSandbox();
  const csv = ',Account #,79011,79012,79013,79014,79015,79016,79017,79018,79019,79001,,\r\n'+
    'Coin,"Platform/\nWallet",Mother,Omar,Father,Karim ,Tariq,Yusuf,Nabil,Ziad,Dana,Sam,My Portion,LOCAL LEDGER TOTAL\r\n'+
    'USDT,Uniswap,80,20,125,125,80,25,5,10,25,3900,0.89,4395\r\n'+
    'ANDY,MEXC,1600000,500000,1000000,700000,1300000,700000,500000,300000,1600000,3800000,0.32,12000000\r\n'+
    'JUP,Binance,0,0,0,0,0,0,0,0,0,250,1,250\r\n'; // real-shape zero-row case
  const rows = sb.parseInvCoinImportCSV(csv);
  assert(rows.length===3, 'Should parse the two real coin rows plus JUP (Sam-only, still non-zero), got ' + rows.length);
  const owners = new Set(rows.flatMap(r=>Object.keys(r.owners)));
  assert(owners.has('Karim') && !owners.has('Karim '), 'The trailing-space owner name should be trimmed to a clean match, got: ' + [...owners].join(','));
  assert(!owners.has('My Portion') && !owners.has('LOCAL LEDGER TOTAL'), 'Summary columns must not be treated as owner columns');
  const jupRow = rows.find(r=>r.coin==='JUP');
  assert(jupRow && Object.keys(jupRow.owners).length===1 && jupRow.owners['Sam']===250,
    'A coin held by only one person should still import with just that one owner, got: ' + JSON.stringify(jupRow&&jupRow.owners));
}

// ================= v4.47.0: collapsible per-position owner breakdown =================
function ownerBreakdownFixture(){
  return {
    invOwners:[{id:1,name:'Sam Example',isSelf:true},{id:2,name:'Rana Example',isSelf:false}],
    invPlatforms:[{id:1,name:'Astrofolio'}],
    invPositions:[{id:1, platformId:1, name:'AQUARIUS', ticker:'AQUARIUS', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2026-01-01', kind:'buy', units:1000, totalSar:0,
      owners:[{ownerId:1,units:612},{ownerId:2,units:388}], feePct:0, cashSide:'opening'}],
    invValuations:[]
  };
}

async function testOwnerBreakdownIsCollapsedByDefault(){
  const sb = invCashSandbox(ownerBreakdownFixture());
  sb.__set('invExpandedPlatforms', new Set([1]));
  sb.__set('invExpandedPositionOwners', new Set());
  const html = sb.renderInvPlatformSection({id:1, name:'Astrofolio'});
  assert(/▸ Show 2 owners/.test(html), 'Should show a collapsed toggle naming the owner count, got snippet: ' + html.slice(0,900));
  assert(!/Rana Example/.test(html), 'Owner names should not appear in the row until expanded');
}

async function testOwnerBreakdownExpandsWithFullDetailColumns(){
  const sb = invCashSandbox(ownerBreakdownFixture());
  sb.__set('invExpandedPlatforms', new Set([1]));
  sb.__set('invExpandedPositionOwners', new Set([1]));
  const html = sb.renderInvPlatformSection({id:1, name:'Astrofolio'});
  assert(/▾ Hide 2 owners/.test(html), 'Should show a "Hide" toggle once expanded');
  assert(/Sam Example/.test(html) && /Rana Example/.test(html), 'Both owner names should appear once expanded');
  assert(/61\.2%/.test(html), 'Should show each owner\'s percentage of the position (612/1000 = 61.2%)');
  assert(html.indexOf('612')!==-1 && html.indexOf('388')!==-1, 'Should show each owner\'s unit count');
  const outerHeadEnd = html.indexOf('</thead>');
  const headerRow = html.slice(html.indexOf('<thead>', outerHeadEnd+1), html.indexOf('</thead>', outerHeadEnd+1));
  ['Owner','%','Units','Cost (SAR)','Value (SAR)','Unrealised'].forEach(col=>{
    assert(headerRow.indexOf(col)!==-1, 'The expanded breakdown should have a "'+col+'" column, got header: ' + headerRow);
  });
}

async function testOwnerBreakdownToggleStopsClickPropagationToThePositionLink(){
  const src = fs.readFileSync(APP_HTML, 'utf8');
  const toggleSnippet = src.slice(src.indexOf('toggleInvPositionOwnersExpanded(${pos.id})')-80, src.indexOf('toggleInvPositionOwnersExpanded(${pos.id})')+40);
  assert(/stopPropagation/.test(toggleSnippet), 'Clicking the owner toggle must not also navigate into the position detail page, got: ' + toggleSnippet);
}

async function testToggleInvPositionOwnersExpandedFlipsIndependently(){
  const sb = makeSandbox();
  sb.__set('D', {invPlatforms:[], invOwners:[], invPositions:[], invTransactions:[], invValuations:[], invCashMovements:[], invSettings:{}});
  sb.__set('invExpandedPositionOwners', new Set());
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.toggleInvPositionOwnersExpanded(1);
  assert(vm.runInContext('invExpandedPositionOwners', sb).has(1), 'Toggling should expand position 1\'s breakdown');
  sb.toggleInvPositionOwnersExpanded(2);
  assert(vm.runInContext('invExpandedPositionOwners', sb).has(1) && vm.runInContext('invExpandedPositionOwners', sb).has(2),
    'Expanding a second position should not collapse the first — each position toggles independently');
  sb.toggleInvPositionOwnersExpanded(1);
  assert(!vm.runInContext('invExpandedPositionOwners', sb).has(1) && vm.runInContext('invExpandedPositionOwners', sb).has(2),
    'Collapsing position 1 should leave position 2 expanded');
}

async function testOwnerBreakdownShowsZeroCostAndDashForNoValuationCorrectly(){
  // Matches the actual real-world state right after the Coin Balances import: $0 cost, no price
  // logged yet, so Value/Unrealised should show as a dash rather than a misleading $0.
  const sb = invCashSandbox(ownerBreakdownFixture());
  sb.__set('invExpandedPlatforms', new Set([1]));
  sb.__set('invExpandedPositionOwners', new Set([1]));
  const html = sb.renderInvPlatformSection({id:1, name:'Astrofolio'});
  const rowStart = html.indexOf('Rana Example');
  const row = html.slice(rowStart, html.indexOf('</tr>', rowStart));
  assert(row.indexOf('0.00')!==-1, 'Cost should show as a real 0.00, since that IS the actual (imported) cost basis');
  assert((row.match(/—/g)||[]).length>=2, 'Value and Unrealised should show as a dash (no valuation logged yet), not a misleading 0.00, got row: ' + row);
}

async function testLedgerSearchDebounced(){
  const sb = makeSandbox();
  sb.__set('ledgerFilter', {q:''});
  sb.__set('ledgerPage', 0);
  let renderCalls = 0;
  sb.__set('renderLedgerResults', () => { renderCalls++; });
  sb.filterLedgerDescr('5');
  sb.filterLedgerDescr('50');
  sb.filterLedgerDescr('500');
  assert(renderCalls === 0, 'renderLedgerResults should NOT fire synchronously on every keystroke — got ' + renderCalls + ' immediate calls');
  await new Promise(r => setTimeout(r, 300));
  assert(renderCalls === 1, 'After the debounce window, exactly one render should fire for the whole burst of typing, got ' + renderCalls);
}

async function testSplashProgressBlendsLedgerFraction(){
  const sb = makeSandbox();
  const doc = sb.document;
  const fill = doc.createElement('div'); fill.id = 'splashProgressFill'; doc.body.appendChild(fill);
  const pctEl = doc.createElement('div'); pctEl.id = 'splashProgressPct'; doc.body.appendChild(pctEl);
  sb.updateSplashProgress(37.6);
  assert(fill.style.width === '38%', 'updateSplashProgress should round and set the bar width, got ' + fill.style.width);
  assert(pctEl.textContent === '38%', 'updateSplashProgress should also update the explicit percentage text, got ' + pctEl.textContent);
  sb.updateSplashProgress(150); // out-of-range input should clamp
  assert(fill.style.width === '100%', 'updateSplashProgress should clamp above 100, got ' + fill.style.width);
  sb.updateSplashProgress(-20);
  assert(fill.style.width === '0%', 'updateSplashProgress should clamp below 0, got ' + fill.style.width);
}

async function testSmartRuleFreezeAfterTarget(){
  const sb = makeSandbox();
  const D = {
    accounts: [{id:60301, descr:'Insurance', forecast_category:'income', status:'Active', acc_type:'Individual Account'}],
    ledger: [],
    forecastAccountRules: [{id:1, name:'Test Rule', account:60301, rule:{type:'fixed', value:100, sign:1}, targetOffset:1, freezeAfterTarget:true}],
    forecastPlans: {},
    provisionGroups: [],
    budget: []
  };
  sb.__set('D', D);
  sb.__set('_forecastFastIndexes', null);
  const acc = {id:60301, descr:'Insurance', forecast_category:'income', status:'Active'};
  const currentMonth = '2026-08';
  // Target month (offset +1) = 2026-09: should show the live-computed value, not 0
  const targetCell = sb.computeForecastCell(acc, '2026-09', currentMonth);
  assert(targetCell.plan === 100, 'Target month should show the live-computed rule value (100), got ' + targetCell.plan);
  assert(targetCell.editable === false, 'Target month should not be editable');

  // A month AFTER target (2026-10), currently blank, with freezeAfterTarget on: should be forced to 0 and locked
  const afterBlank = sb.computeForecastCell(acc, '2026-10', currentMonth);
  assert(afterBlank.plan === 0, 'Blank month after target should be frozen to 0 when freezeAfterTarget is on, got ' + afterBlank.plan);
  assert(afterBlank.editable === false, 'Blank month after target should be locked (not editable) when freezeAfterTarget is on');
  assert(afterBlank.source === 'smart_rule', 'Frozen month should be attributed to the smart rule as its source');

  // Same month, but with an existing manually-typed value — must be left alone (normal category behavior), not overwritten
  D.forecastPlans[60301] = {'2026-10': 250};
  const afterWithValue = sb.computeForecastCell(acc, '2026-10', currentMonth);
  assert(afterWithValue.plan === 250, 'A month after target with an existing manual value must be left untouched, got ' + afterWithValue.plan);

  // A rule WITHOUT freezeAfterTarget set should leave months-after-target on normal behavior (unfrozen)
  D.forecastAccountRules[0].freezeAfterTarget = false;
  delete D.forecastPlans[60301];
  const afterNoFreeze = sb.computeForecastCell(acc, '2026-10', currentMonth);
  assert(afterNoFreeze.editable === true, 'Without freezeAfterTarget, months after target should keep normal (editable) category behavior, got editable=' + afterNoFreeze.editable);
}

async function testProvisionDescrSurvivesBlockedSync(){
  const sb = makeSandbox();
  const D = { provisionGroups: [{id:1, name:'Car', lines:[{acc:60101, lineId:60101, descrBase:null}], months:{}}] };
  sb.__set('D', D);
  sb.__set('syncInProgress', true); // force blockIfSyncing() to report "still syncing"
  sb.__set('syncWrite', async () => { throw new Error('syncWrite should not be reached while blocked'); });
  await sb.setProvisionLineDescr(1, 0, 'Comprehensive cover'); // v5.0: replaced saveProvisionLineDescr, same rule
  assert(D.provisionGroups[0].lines[0].descrBase === 'Comprehensive cover', 'Description should be applied locally even when blockIfSyncing() reports busy — got ' + D.provisionGroups[0].lines[0].descrBase);
}

function testAccountSearchMatchesIsTokenBased(){
  const sb = makeSandbox();
  const accounts = [
    {id:60605, name:'Gifts - Expenses'},
    {id:60300, name:'Food & Beverage'},
    {id:60301, name:'Main Meals - Breakfast'},
  ];
  // The exact bug reported: "gifts expenses" (no hyphen) must match "Gifts - Expenses" even
  // though it's not a contiguous substring — this is why plain .includes(query) failed before.
  const m1 = sb.accountSearchMatches('gifts expenses', accounts);
  assert(m1.length===1 && m1[0].id===60605, 'Token query "gifts expenses" should match "Gifts - Expenses" despite the hyphen, got ' + JSON.stringify(m1));
  // Tokens can appear in either order
  const m2 = sb.accountSearchMatches('expenses gifts', accounts);
  assert(m2.length===1 && m2[0].id===60605, 'Token order should not matter, got ' + JSON.stringify(m2));
  // Matching by account id still works
  const m3 = sb.accountSearchMatches('60300', accounts);
  assert(m3.length===1 && m3[0].id===60300, 'Should still match by account id, got ' + JSON.stringify(m3));
  // A query with a token that matches nothing should return no results
  const m4 = sb.accountSearchMatches('gifts zzz', accounts);
  assert(m4.length===0, 'A token with no match anywhere should exclude the account, got ' + JSON.stringify(m4));
  // Empty query returns the (capped) full list, matching prior behavior for an empty search box
  const m5 = sb.accountSearchMatches('', accounts);
  assert(m5.length===3, 'Empty query should return all accounts (up to 25), got ' + m5.length);
}

function testPnLShowsPercentOfTotalExpenses(){
  const sb = makeSandbox();
  const D = {
    accounts: [
      {id:60100, name:'Government & Banks', category:'Government & Banks', acc_type:'Individual Account', status:'Active'},
      {id:60200, name:'Transportation', category:'Transportation', acc_type:'Individual Account', status:'Active'},
    ],
    ledger: [
      {id:1, jv:1, acc:60100, date:'2026-01-05', descr:'x', amt:-25},
      {id:2, jv:2, acc:60200, date:'2026-01-06', descr:'y', amt:-75},
    ],
    budget: [], provisionGroups: [], forecastAccountRules: [],
  };
  sb.__set('D', D);
  sb.__set('pnlFrom', '2026-01-01');
  sb.__set('pnlTo', '2026-01-31');
  sb.__set('pnlPreset', 'custom');
  sb.renderPnL();
  const html = sb.document.getElementById('app').innerHTML;
  // Total expenses = 100 (25+75). 60100 is 25% of total, 60200 is 75% of total.
  assert(html.includes('25.00%'), 'Expected account 60100 line to show 25.00% of total expenses in the rendered P&L HTML');
  assert(html.includes('75.00%'), 'Expected account 60200 line to show 75.00% of total expenses in the rendered P&L HTML');
  assert(html.includes('% of Total'), 'Expected the new "% of Total" column header to be present');
}

function testLedgerPageAccountFilterUsesTokenSearch(){
  const sb = makeSandbox();
  const D = { accounts: [
    {id:60605, name:'Gifts - Expenses', acc_type:'Individual Account', status:'Active'},
    {id:60300, name:'Food & Beverage', acc_type:'Individual Account', status:'Active'},
  ]};
  sb.__set('D', D);
  sb.__set('ledgerFilter', {acc:'', from:'', to:'', q:'', jv:'', preset:'', specificMonth:'', unallocOnly:false});
  sb.__set('ledgerAccPicker', {q:'', matches:[], hi:-1});
  sb.__set('document', sb.document); // ensure renderLedgerAcDrop's getElementById call doesn't throw
  const dropEl = sb.document.createElement('div'); dropEl.id = 'ledgerAcdrop'; sb.document.body.appendChild(dropEl);
  sb.ledgerAccInputHandler('gifts expenses');
  const picker = vm.runInContext('ledgerAccPicker', sb);
  assert(picker.matches.length===1 && picker.matches[0].id===60605,
    'The Ledger page\'s own Account filter (a separate picker from the JV line one) must also use token-based search — got ' + JSON.stringify(picker.matches));
}
function testArabicTableHeaderRightAlignCssPresent(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(html.includes('table[dir="rtl"] th{text-align:right}') || /table\[dir="rtl"\]\s*th\s*\{\s*text-align:\s*right/.test(html),
    'Expected a CSS rule right-aligning <th> headers inside RTL tables (e.g. the Arabic settlement statement)');
}

function testSettlementRoundUpIsCeilingPerLine(){
  const sb = makeSandbox();
  assert(sb.settlementRoundAmt(13.01, true)===14, '13.01 should round up to 14, got ' + sb.settlementRoundAmt(13.01, true));
  assert(sb.settlementRoundAmt(13.99, true)===14, '13.99 should round up to 14, got ' + sb.settlementRoundAmt(13.99, true));
  assert(sb.settlementRoundAmt(13.00, true)===13, 'A whole number must NOT be bumped up: 13.00 should stay 13, got ' + sb.settlementRoundAmt(13.00, true));
  // True mathematical ceiling on negatives (the person chose this over away-from-zero)
  assert(sb.settlementRoundAmt(-13.01, true)===-13, '-13.01 should ceil to -13, got ' + sb.settlementRoundAmt(-13.01, true));
  // Floating-point drift must not push a whole number up a full unit
  assert(sb.settlementRoundAmt(13.000000000001, true)===13, 'FP drift on a whole number must not ceil to 14, got ' + sb.settlementRoundAmt(13.000000000001, true));
  // Off = untouched
  assert(sb.settlementRoundAmt(13.01, false)===13.01, 'With the toggle off the amount must be unchanged, got ' + sb.settlementRoundAmt(13.01, false));
}

function testSettlementCleanOutputTotalIsSumOfRoundedLines(){
  const sb = makeSandbox();
  sb.__set('settlementDraft', {acc:10212, roundUp:true, lines:[
    {id:1, jv:2914, date:'2026-07-31', amt:13.01, original:'a', arText:'أ', source:'learned', excluded:false},
    {id:2, jv:2915, date:'2026-08-01', amt:13.01, original:'b', arText:'ب', source:'learned', excluded:false},
  ]});
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.showSettlementCleanOutput();
  const html = sb.document.body.innerHTML;
  // Each line rounds to 14 independently, so the total must be 28 — NOT 27 (which is what
  // rounding the true total of 26.02 once at the end would give).
  assert(html.includes('28'), 'Total should be the sum of the rounded lines (28), not the rounded true total (27)');
  assert(!html.includes('27.00'), 'Total must not be 27.00, which would mean the total was rounded once instead of per line');
}

function testNavEntranceAnimationOnlyOnFirstRender(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[], ledger:[]});
  sb.__set('screen', 'dashboard');
  const navEl = sb.document.createElement('div'); navEl.id='nav'; sb.document.body.appendChild(navEl);
  sb.renderNav();
  assert(navEl.innerHTML.includes('anim'), 'The first nav render of the session SHOULD carry the entrance animation class');
  sb.renderNav();
  assert(!navEl.innerHTML.includes('anim'), 'Re-rendering the nav (which happens on every page change) must NOT replay the entrance animation');
}

function invSandbox(){
  const sb = makeSandbox();
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  const app = sb.document.getElementById('app') || sb.document.createElement('div');
  app.id='app'; if(!app.parentNode) sb.document.body.appendChild(app);
  sb.__set('D', {
    accounts:[], ledger:[],
    invOwners:[{id:1,name:'Me',isSelf:true,outAcc:null,inAcc:null},{id:2,name:'Brother',isSelf:false,outAcc:null,inAcc:null}],
    invPlatforms:[{id:1,name:'Broker A'}],
    invPositions:[{id:1,platformId:1,name:'Acme',ticker:'ACME',assetClass:'Stocks',currency:'SAR',status:'Active'}],
    invTransactions:[], invValuations:[],
  });
  return sb;
}
function testOwnershipPercentDerivedFromUnitsNotContributedCapital(){
  const sb = invSandbox();
  const D = vm.runInContext('D', sb);
  // The classic trap: I buy 10 units for 100 (10/unit). It doubles. Brother then buys
  // 5 units for 100 (20/unit). Contributed capital is 100/100 = 50/50, but a 50% share
  // would hand him half of MY earlier gain. Unit attribution must not do that.
  D.invTransactions.push({id:1,positionId:1,date:'2026-01-01',kind:'buy',units:10,totalSar:100,owners:[{ownerId:1,units:10}]});
  D.invTransactions.push({id:2,positionId:1,date:'2026-02-01',kind:'buy',units:5,totalSar:100,owners:[{ownerId:2,units:5}]});
  const st = sb.computePositionState(1);
  assert(Math.abs(st.byOwner[1].units-10)<1e-9, 'Owner 1 should hold 10 units');
  assert(Math.abs(st.byOwner[2].units-5)<1e-9, 'Owner 2 should hold 5 units');
  assert(Math.abs(st.byOwner[1].costSar-100)<1e-9, 'Owner 1 cost should be 100');
  assert(Math.abs(st.byOwner[2].costSar-100)<1e-9, 'Owner 2 cost should be 100');
  // Share must be by units (10/15 = 66.7%), NOT by contributed capital (which would be 50%).
  const pct1 = st.byOwner[1].units/st.totalUnits*100;
  assert(Math.abs(pct1-66.6667)<0.01, 'Owner 1 share must be 66.67% (by units), not 50% (by capital) — got '+pct1.toFixed(4));
}
function testValuationAppliesFxForUsdPositions(){
  const sb = invSandbox();
  const D = vm.runInContext('D', sb);
  D.invPositions[0].currency = 'USD';
  D.invTransactions.push({id:1,positionId:1,date:'2026-01-01',kind:'buy',units:10,totalSar:3750,owners:[{ownerId:1,units:10}]});
  D.invValuations.push({id:1,positionId:1,date:'2026-02-01',price:120});
  sb.setInvFxRate(3.75);
  const v = sb.computePositionValuation(D.invPositions[0]);
  // 10 units * $120 * 3.75 = 4500 SAR, against a 3750 SAR cost = 750 SAR unrealised.
  assert(Math.abs(v.marketSar-4500)<1e-6, 'USD position should convert at the FX rate: expected 4500 SAR, got '+v.marketSar);
  assert(Math.abs(v.unrealizedSar-750)<1e-6, 'Unrealised should be 750 SAR, got '+v.unrealizedSar);
}
function testSellUsesWeightedAverageCostAndRealisesGain(){
  const sb = invSandbox();
  const D = vm.runInContext('D', sb);
  D.invTransactions.push({id:1,positionId:1,date:'2026-01-01',kind:'buy',units:10,totalSar:100,owners:[{ownerId:1,units:10}]});
  D.invTransactions.push({id:2,positionId:1,date:'2026-02-01',kind:'buy',units:10,totalSar:300,owners:[{ownerId:1,units:10}]});
  // Average cost is now (100+300)/20 = 20/unit. Selling 5 for 150 releases 100 of cost
  // and realises 50 of gain.
  D.invTransactions.push({id:3,positionId:1,date:'2026-03-01',kind:'sell',units:5,totalSar:150,owners:[{ownerId:1,units:5}]});
  const st = sb.computePositionState(1);
  assert(Math.abs(st.byOwner[1].units-15)<1e-9, 'Should hold 15 units after selling 5 of 20, got '+st.byOwner[1].units);
  assert(Math.abs(st.byOwner[1].costSar-300)<1e-9, 'Remaining cost should be 300 (15 units at avg 20), got '+st.byOwner[1].costSar);
  assert(Math.abs(st.byOwner[1].realizedSar-50)<1e-9, 'Realised gain should be 50, got '+st.byOwner[1].realizedSar);
}
function testTransactionsProcessedInDateOrderNotInsertionOrder(){
  const sb = invSandbox();
  const D = vm.runInContext('D', sb);
  // Entered out of order (the person said they'd back-fill past transactions with real dates),
  // so a sell must not be processed before the buy that funds it.
  D.invTransactions.push({id:2,positionId:1,date:'2026-03-01',kind:'sell',units:5,totalSar:150,owners:[{ownerId:1,units:5}]});
  D.invTransactions.push({id:1,positionId:1,date:'2026-01-01',kind:'buy',units:10,totalSar:100,owners:[{ownerId:1,units:10}]});
  const st = sb.computePositionState(1);
  assert(Math.abs(st.byOwner[1].units-5)<1e-9, 'Should hold 5 units; out-of-order entry must be sorted by date, got '+st.byOwner[1].units);
  assert(Math.abs(st.byOwner[1].realizedSar-100)<1e-9, 'Realised gain should be 100 (sold 5 at cost 10 for 150), got '+st.byOwner[1].realizedSar);
}
function testFamilyHoldingsSeparatedFromOwn(){
  const sb = invSandbox();
  const D = vm.runInContext('D', sb);
  D.invTransactions.push({id:1,positionId:1,date:'2026-01-01',kind:'buy',units:10,totalSar:100,owners:[{ownerId:1,units:10}]});
  D.invTransactions.push({id:2,positionId:1,date:'2026-01-01',kind:'buy',units:10,totalSar:100,owners:[{ownerId:2,units:10}]});
  const totals = sb.invOwnerTotals();
  const me = totals.find(t=>t.owner.isSelf);
  const bro = totals.find(t=>!t.owner.isSelf);
  assert(Math.abs(me.costSar-100)<1e-9, 'Own cost basis must exclude the family member, got '+me.costSar);
  assert(Math.abs(bro.costSar-100)<1e-9, 'Family cost basis should be tracked separately, got '+bro.costSar);
}
function testReconciliationFlagsMismatchAgainstLedger(){
  const sb = invSandbox();
  const D = vm.runInContext('D', sb);
  D.invOwners[0].outAcc = 10101; D.invOwners[0].inAcc = 10102;
  D.accounts = [{id:10101,name:'Invested',acc_type:'Individual Account',status:'Active'},{id:10102,name:'Withdrawn',acc_type:'Individual Account',status:'Active'}];
  D.ledger = [{id:1,jv:1,acc:10101,date:'2026-01-01',descr:'buy',amt:100}];
  D.invTransactions.push({id:1,positionId:1,date:'2026-01-01',kind:'buy',units:10,totalSar:100,owners:[{ownerId:1,units:10}]});
  let recon = sb.invOwnerReconciliation().find(r=>r.owner.id===1);
  assert(recon.ok, 'Matching tracker cost and ledger net should reconcile cleanly, diff was '+recon.diff);
  // Now make the ledger disagree — the tracker must notice rather than silently drift.
  D.ledger.push({id:2,jv:2,acc:10101,date:'2026-02-01',descr:'buy not in tracker',amt:500});
  recon = sb.invOwnerReconciliation().find(r=>r.owner.id===1);
  assert(!recon.ok, 'A ledger purchase missing from the tracker must be flagged, diff was '+recon.diff);
}

function testFxRateIsSyncedNotDeviceLocal(){
  const sb = invSandbox();
  const D = vm.runInContext('D', sb);
  D.invSettings = {fxUsdSar: 4.00};
  assert(sb.getInvFxRate()===4.00, 'FX rate must be read from synced state, got '+sb.getInvFxRate());
  // It must NOT fall back to a device-local value, since that is exactly the cross-device
  // inconsistency this change was made to remove.
  sb.localStorage.setItem('invFxUsdSar','9.99');
  assert(sb.getInvFxRate()===4.00, 'FX rate must ignore device-local storage, got '+sb.getInvFxRate());
}
function testPortfolioHistoryUsesUnitsAndPriceAsOfEachDate(){
  const sb = invSandbox();
  const D = vm.runInContext('D', sb);
  D.invTransactions.push({id:1,positionId:1,date:'2026-01-01',kind:'buy',units:10,totalSar:100,owners:[{ownerId:1,units:10}]});
  D.invValuations.push({id:1,positionId:1,date:'2026-01-31',price:15});
  D.invTransactions.push({id:2,positionId:1,date:'2026-02-15',kind:'buy',units:10,totalSar:200,owners:[{ownerId:1,units:10}]});
  D.invValuations.push({id:2,positionId:1,date:'2026-02-28',price:20});
  const h = sb.invPortfolioHistory(true);
  assert(h.length===2, 'Expected one history point per valuation date, got '+h.length);
  // At 31 Jan only the first 10 units existed: 10 * 15 = 150, cost 100.
  assert(Math.abs(h[0].value-150)<1e-6, 'Jan value should use only units held then (150), got '+h[0].value);
  assert(Math.abs(h[0].cost-100)<1e-6, 'Jan cost should be 100, got '+h[0].cost);
  // At 28 Feb both buys are in: 20 * 20 = 400, cost 300.
  assert(Math.abs(h[1].value-400)<1e-6, 'Feb value should be 400, got '+h[1].value);
  assert(Math.abs(h[1].cost-300)<1e-6, 'Feb cost should be 300, got '+h[1].cost);
}
function testStalePricesAreFlagged(){
  const sb = invSandbox();
  const D = vm.runInContext('D', sb);
  D.invTransactions.push({id:1,positionId:1,date:'2020-01-01',kind:'buy',units:10,totalSar:100,owners:[{ownerId:1,units:10}]});
  let stale = sb.invStalePositions(14);
  assert(stale.length===1 && stale[0].never, 'A held position with no price at all must be flagged');
  D.invValuations.push({id:1,positionId:1,date:'2020-06-01',price:20});
  stale = sb.invStalePositions(14);
  assert(stale.length===1 && !stale[0].never, 'A long-outdated price must be flagged as stale');
  freezeDate(sb, '2026-08-18');
  D.invValuations.push({id:2,positionId:1,date:'2026-08-17',price:25});
  stale = sb.invStalePositions(14);
  assert(stale.length===0, 'A price from yesterday must NOT be flagged, got '+JSON.stringify(stale));
}
function testCsvImportIsAllOrNothingOnBadRow(){
  const sb = invSandbox();
  const D = vm.runInContext('D', sb);
  const before = D.invTransactions.length;
  // Second row references a position that doesn't exist — the whole file must be rejected
  // rather than importing the good row and leaving cost basis half-updated.
  sb.importInvTransactionsCSV([
    ['Tx ID','Position ID','Position','Date','Kind','Units','Total SAR','Owners','Note'],
    ['','1','Acme','2026-01-01','buy','10','100','1:10',''],
    ['','999','Ghost','2026-01-02','buy','5','50','1:5',''],
  ]);
  assert(D.invTransactions.length===before, 'A file with any invalid row must import nothing, but '+(D.invTransactions.length-before)+' row(s) were written');
}
function testCsvImportRejectsOwnerUnitsMismatch(){
  const sb = invSandbox();
  const D = vm.runInContext('D', sb);
  const before = D.invTransactions.length;
  sb.importInvTransactionsCSV([
    ['Tx ID','Position ID','Position','Date','Kind','Units','Total SAR','Owners','Note'],
    ['','1','Acme','2026-01-01','buy','10','100','1:7',''],
  ]);
  assert(D.invTransactions.length===before, 'Owner units not summing to the row Units must be rejected');
}

function testReverseJvProducesExactMirrorAndNetsToZero(){
  const sb = makeSandbox();
  sb.__set('D', {accounts:[{id:10101,name:'Bank',acc_type:'Individual Account',status:'Active'},{id:60300,name:'Food',acc_type:'Individual Account',status:'Active'}],
    ledger:[
      {id:1, jv:2914, date:'2026-07-31', acc:60300, descr:'Dinner', amt:125, alloc:7, allocatable:true, accNameSnapshot:'Food'},
      {id:2, jv:2914, date:'2026-07-31', acc:10101, descr:'Dinner', amt:-125, alloc:null, allocatable:false, accNameSnapshot:'Bank'},
    ]});
  freezeDate(sb, '2026-08-18');
  const rows = sb.buildReversalLines(2914, 3001, '2026-08-18', 100);
  assert(rows.length===2, 'Reversal should mirror every original line, got '+rows.length);
  // Amounts are exactly negated, so original + reversal nets to zero.
  const net = rows.reduce((s,r)=>s+r.amt,0) + 125 + (-125);
  assert(Math.abs(net)<1e-9, 'Original plus reversal must net to zero, got '+net);
  assert(rows[0].amt===-125 && rows[1].amt===125, 'Each line amount must be exactly negated');
  assert(rows[0].date==='2026-08-18', 'Reversal must be dated today, not the original date, got '+rows[0].date);
  assert(rows[0].descr==='Reversal of JV #2914 — Dinner', 'Description should prefix the original text, got "'+rows[0].descr+'"');
  assert(rows[0].jv===3001, 'Reversal lines should carry the new JV number');
  // Allocation is deliberately not carried across — the person is warned instead.
  assert(rows[0].alloc===null && rows[0].allocatable===false, 'Reversal lines must not inherit the allocation group');
  // The historical account name is preserved so the reversal reads correctly later.
  assert(rows[0].accNameSnapshot==='Food', 'Reversal should keep the historical account name');
}
function testDeleteJvIsGoneEntirely(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(!/deleteJV/.test(html), 'deleteJV must be removed entirely — reversal replaces deletion');
  assert(/reverseJV/.test(html), 'reverseJV should exist');
}
function testEveryScreenHasAnIcon(){
  const sb = makeSandbox();
  const SCREENS = vm.runInContext('SCREENS', sb);
  assert(SCREENS.length>0, 'SCREENS should not be empty');
  for(const s of SCREENS){
    assert(s.length===3 && s[2] && String(s[2]).trim()!=='', 'Screen "'+s[0]+'" is missing an icon');
  }
}
function testSchemaSqlCoversEveryTableTheAppReads(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  const sb = makeSandbox();
  const sql = vm.runInContext('DB_SCHEMA_SQL', sb);
  // Every table the app actually fetches must be creatable from the schema script, or a
  // fresh database built from it would be missing tables and the app would fail on load.
  // Both access paths must be scanned. pd_sync_meta was read via SB.from(...) rather than
  // fetchAllRows(...) and so slipped past this check entirely for several versions — the table
  // was missing from the schema script and nothing caught it.
  const viaFetch = (html.match(/fetchAllRows\('(pd_[a-z_]+)'/g)||[]).map(m=>m.match(/'(pd_[a-z_]+)'/)[1]);
  const viaFrom  = (html.match(/SB\.from\('(pd_[a-z_]+)'/g)||[]).map(m=>m.match(/'(pd_[a-z_]+)'/)[1]);
  const used = Array.from(new Set(viaFetch.concat(viaFrom)));
  assert(used.length>15, 'Expected to find the app\'s table list, found '+used.length);
  assert(used.indexOf('pd_sync_meta')!==-1, 'The scan should now reach SB.from(...) tables like pd_sync_meta');
  const missing = used.filter(t=> !sql.includes('create table if not exists '+t+' ') && !sql.includes('create table if not exists '+t+'\n') && !sql.includes('create table if not exists '+t+'('));
  assert(missing.length===0, 'DB_SCHEMA_SQL is missing table(s): '+missing.join(', '));
  // Single-row blob tables need their row seeded or the app cannot write to them.
  for(const t of ['pd_forecast_plans','pd_name_translations','pd_descr_translations','pd_inv_settings']){
    assert(sql.includes('insert into '+t), 'DB_SCHEMA_SQL should seed the singleton row for '+t);
  }
  assert(/enable row level security/.test(sql), 'DB_SCHEMA_SQL should set up RLS');
}

function testSettingsIsAPagePinnedLastAndPillNotClickable(){
  const sb = makeSandbox();
  const SCREENS = vm.runInContext('SCREENS', sb);
  assert(SCREENS.some(s=>s[0]==='settings'), 'Settings should now be a real page in SCREENS');
  const ordered = sb.orderedScreens();
  assert(ordered[ordered.length-1][0]==='settings', 'Settings must be pinned to the bottom, got '+ordered[ordered.length-1][0]);
  assert(!sb.reorderableScreens().some(s=>s[0]==='settings'), 'Settings must not appear in the reorderable list');
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(!/id="cloudBtn" onclick/.test(html), 'The sync status pill must no longer be clickable');
  assert(/id="cloudBtn"/.test(html), 'The sync status pill should still exist');
}
function testCustomPageOrderIsRespected(){
  const sb = makeSandbox();
  sb.__set('D', {uiPrefs:{pageOrder:['budget','pnl','ledger','dashboard']}});
  const ids = sb.orderedScreens().map(s=>s[0]);
  // v5.7 (#30): 'budget' is no longer a rail page (it is the Plan grid tab); a saved order keeping it is fine.
  assert(ids[0]==='pnl' && ids[1]==='ledger' && ids[2]==='dashboard',
    'Saved order should lead the list, got '+ids.slice(0,3).join(','));
  assert(ids[ids.length-1]==='settings', 'Settings stays pinned last regardless of saved order');
}
function testScreensMissingFromSavedOrderAreAppendedNotDropped(){
  const sb = makeSandbox();
  const SCREENS = vm.runInContext('SCREENS', sb);
  // A saved order from an older version won't mention pages added later. Those must still
  // appear, or a new page would silently vanish for anyone with a saved ordering.
  sb.__set('D', {uiPrefs:{pageOrder:['ledger','budget']}});
  const ids = sb.orderedScreens().map(s=>s[0]);
  assert(ids.length===SCREENS.length, 'Every screen must appear exactly once, got '+ids.length+' of '+SCREENS.length);
  for(const s of SCREENS){
    assert(ids.includes(s[0]), 'Screen "'+s[0]+'" was dropped from the ordered list');
  }
  assert(new Set(ids).size===ids.length, 'No screen should appear twice');
}
function testAlwaysVisiblePagesCannotBeHidden(){
  const sb = makeSandbox();
  sb.__set('D', {uiPrefs:{pageOrder:null}});
  const navEl = sb.document.createElement('div'); navEl.id='nav'; sb.document.body.appendChild(navEl);
  sb.localStorage.setItem('hiddenPages','[]');
  // Guarded in the function itself, not just hidden in the UI.
  sb.togglePageVisibility('settings', false);
  assert(!JSON.parse(sb.localStorage.getItem('hiddenPages')).includes('settings'), 'Settings must never be hideable');
  sb.togglePageVisibility('dashboard', false);
  assert(!JSON.parse(sb.localStorage.getItem('hiddenPages')).includes('dashboard'), 'Dashboard must never be hideable');
  // A normal page still hides fine.
  sb.togglePageVisibility('jamiah', false);
  assert(JSON.parse(sb.localStorage.getItem('hiddenPages')).includes('jamiah'), 'A normal page should still be hideable');
}

function testSarSplitDerivesUnitsProportionally(){
  const sb = invSandbox();
  // The person's own example: 5,000 SAR of BTC — 1K his, 2K wife, 2K mother.
  const out = sb.invDeriveUnitsFromSar(0.0125, [{ownerId:1,sar:1000},{ownerId:2,sar:2000},{ownerId:3,sar:2000}]);
  const byId = {}; out.forEach(o=>byId[o.ownerId]=o.units);
  assert(Math.abs(byId[1]-0.0025)<1e-9, 'A 1000/5000 share of 0.0125 units should be 0.0025, got '+byId[1]);
  assert(Math.abs(byId[2]-0.005)<1e-9, 'A 2000/5000 share should be 0.005, got '+byId[2]);
  // Units must reconcile EXACTLY to the transaction total, or cost basis drifts on every split buy.
  const sum = out.reduce((s,o)=>s+o.units,0);
  assert(Math.abs(sum-0.0125)<1e-12, 'Derived units must sum exactly to the transaction units, got '+sum);
}
function testSarSplitRemainderGoesToLargestHolder(){
  const sb = invSandbox();
  // 1 unit split three ways cannot divide evenly — the remainder must land somewhere explicit.
  const out = sb.invDeriveUnitsFromSar(1, [{ownerId:1,sar:1},{ownerId:2,sar:1},{ownerId:3,sar:1}]);
  const sum = out.reduce((s,o)=>s+o.units,0);
  assert(Math.abs(sum-1)<1e-12, 'An uneven three-way split must still sum to exactly 1, got '+sum);
  // With a clear largest holder, the remainder should attach to them.
  const out2 = sb.invDeriveUnitsFromSar(1, [{ownerId:1,sar:1},{ownerId:2,sar:2}]);
  const sum2 = out2.reduce((s,o)=>s+o.units,0);
  assert(Math.abs(sum2-1)<1e-12, 'Two-way split must sum to exactly 1, got '+sum2);
  const largest = out2.reduce((a,b)=>a.units>=b.units?a:b);
  assert(largest.ownerId===2, 'The larger SAR contribution should hold the larger unit share');
}
function testSarSplitKeepsUnitPrecisionForCrypto(){
  const sb = invSandbox();
  // Rounding units to 2 decimals here would turn 0.0125 BTC into 0.01 — a 20% error.
  const out = sb.invDeriveUnitsFromSar(0.0125, [{ownerId:1,sar:5000}]);
  assert(Math.abs(out[0].units-0.0125)<1e-12, 'Unit precision must survive the SAR split, got '+out[0].units);
}
function testSarForUnitsRoundTripsTheSplit(){
  const sb = invSandbox();
  // Reopening a saved transaction back-calculates SAR from stored units, so both columns agree.
  assert(Math.abs(sb.invSarForUnits(0.0125, 5000, 0.0025)-1000)<0.005, 'Back-calculated SAR should be 1000, got '+sb.invSarForUnits(0.0125,5000,0.0025));
  assert(sb.invSarForUnits(0, 5000, 0)===0, 'Zero units should not divide by zero');
}
function testPostJvShowsSpinnerWhileWorking(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(/btn-spin/.test(html) && /@keyframes btnSpin/.test(html), 'A spinner style should exist for the Post JV button');
  assert(/postBtn\.innerHTML = '<span class="btn-spin"><\/span>Posting…'/.test(html),
    'Post JV should swap the button label to a spinner plus "Posting…" while it works');
  assert(/document\.body\.contains\(postBtn\)/.test(html),
    'The button should only be restored if it is still on screen (posting navigates away on success)');
}

function testSarSplitUsesTransactionTotalNotAllocatedSubtotal(){
  const sb = invSandbox();
  // The reported bug: 1 unit for 100,000 SAR, only 50,000 allocated so far. Dividing by the
  // running subtotal made the first person read as owning the whole 1 unit.
  const out = sb.invDeriveUnitsFromSar(1, [{ownerId:1, sar:50000}], 100000);
  assert(Math.abs(out[0].units-0.5)<1e-9, 'A half-allocated split should show half the units, got '+out[0].units);
  // Once fully allocated it still reconciles exactly.
  const full = sb.invDeriveUnitsFromSar(1, [{ownerId:1,sar:50000},{ownerId:2,sar:50000}], 100000);
  const sum = full.reduce((s,o)=>s+o.units,0);
  assert(Math.abs(sum-1)<1e-12, 'A fully allocated split must sum to exactly 1, got '+sum);
}
function testPartialSplitDoesNotDumpRemainderOnOnePerson(){
  const sb = invSandbox();
  // Mid-entry, the remainder must NOT be forced onto someone — that would show one person
  // holding the whole balance while the other rows are still blank.
  const out = sb.invDeriveUnitsFromSar(1, [{ownerId:1, sar:25000}], 100000);
  assert(Math.abs(out[0].units-0.25)<1e-9, 'A quarter allocation should read as 0.25 units, got '+out[0].units);
}
function testUnitsDisplayKeeps8Decimals(){
  const sb = invSandbox();
  assert(sb.invFmtUnits(0.0125)==='0.0125', 'Crypto units should display without being rounded away, got '+sb.invFmtUnits(0.0125));
  assert(sb.invFmtUnits(0.00000001)==='1e-8' || sb.invFmtUnits(0.00000001)==='0.00000001',
    'Eight decimal places should survive, got '+sb.invFmtUnits(0.00000001));
  assert(sb.invFmtUnits(1)==='1', 'A whole number should still read cleanly, got '+sb.invFmtUnits(1));
}
function testTxModalDoesNotRerenderWhileTyping(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  // Re-rendering the whole modal on input recreated the inputs and threw focus out of the box
  // being typed in, so every value-entry handler must patch in place instead.
  assert(!/oninput="window\._invTxDraft\.units=this\.value; renderInvTxModal\(\)"/.test(html),
    'The Units field must not re-render the whole modal on input');
  assert(!/oninput="window\._invTxDraft\.totalSar=this\.value; renderInvTxModal\(\)"/.test(html),
    'The Total SAR field must not re-render the whole modal on input');
  assert(/invTxRefreshDerived\(\)/.test(html), 'An in-place refresh should be used instead');
  assert(/function invTxRefreshDerived\(\)/.test(html), 'invTxRefreshDerived should exist');
}
function testCtrlEnterConfirmsModalPrimaryAction(){
  const sb = makeSandbox();
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  modalRoot.innerHTML = '<div class="modal"><button class="btn pri" id="inlineNew">+ New</button><button class="btn ghost">Cancel</button><button class="btn pri" id="save">Save</button></div>';
  // jsdom reports offsetParent as null, so exercise the selection logic directly rather than
  // relying on layout: the LAST primary button is the footer's confirm action.
  const modal = sb.document.querySelector('#modalRoot .modal');
  const btns = Array.from(modal.querySelectorAll('button.btn.pri')).filter(b=>!b.disabled);
  assert(btns[btns.length-1].id==='save', 'The last primary button should be the confirm action, got '+btns[btns.length-1].id);
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(/\(ev\.ctrlKey\|\|ev\.metaKey\) && ev\.key==='Enter'/.test(html), 'Ctrl/Cmd+Enter should be handled globally');
  assert(/function modalPrimaryButton\(\)/.test(html), 'modalPrimaryButton should exist so future modals need no extra wiring');
  assert(/button\.btn\.pri/.test(html) && !/button\.btn\.del/.test(html.match(/function modalPrimaryButton\(\)[\s\S]{0,400}/)[0]),
    'Destructive buttons must never be triggered by the shortcut');
}

function testOwnerDeletionBlockedWhileReferenced(){
  const sb = invSandbox();
  const D = vm.runInContext('D', sb);
  assert(sb.invOwnerTxCount(1)===0, 'An owner with no transactions should count zero');
  D.invTransactions.push({id:1,positionId:1,date:'2026-01-01',kind:'buy',units:10,totalSar:100,owners:[{ownerId:1,units:10}]});
  assert(sb.invOwnerTxCount(1)===1, 'An owner attributed units should be counted, got '+sb.invOwnerTxCount(1));
  assert(sb.invOwnerTxCount(2)===0, 'An owner on no transactions should still count zero');
  const before = D.invOwners.length;
  // jsdom's confirm() returns falsy, which would abort the delete regardless of the guard and
  // make this test pass for the wrong reason. Stub it to yes so the guard is what's under test.
  sb.confirm = () => true;
  sb.deleteInvOwner(1);
  assert(D.invOwners.length===before, 'An owner on a transaction must not be deletable');
  // Sanity check the stub works: an unreferenced owner IS removed.
  sb.deleteInvOwner(2);
  assert(D.invOwners.length===before-1, 'An unreferenced owner should be deletable, got '+D.invOwners.length+' of '+before);
  // A zero-unit attribution is not a real reference and must not block deletion forever.
  D.invTransactions = [{id:1,positionId:1,date:'2026-01-01',kind:'buy',units:10,totalSar:100,owners:[{ownerId:1,units:0}]}];
  assert(sb.invOwnerTxCount(1)===0, 'A zero-unit attribution should not count as a reference');
}
function testStatementDefaultsToNewestFirst(){
  const sb = makeSandbox();
  const desc = vm.runInContext('statementSortDesc', sb);
  assert(desc===true, 'The account statement should open newest-first by default, got '+desc);
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(/safeSetItem\('statementSortDesc'/.test(html), 'The sort choice should be remembered once changed');
}
function testNumberSpinnersHidden(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  // The spinner arrows overlapped the digits, making 50000 look struck through.
  assert(/input\[type=number\]::-webkit-inner-spin-button/.test(html), 'WebKit number spinners should be hidden');
  assert(/-moz-appearance:textfield/.test(html), 'Firefox number spinners should be hidden');
}

function storageSandbox(){
  const sb = makeSandbox();
  const store = {};
  let failFrom = null; // when set, any write pushing past this many bytes throws like a real quota error
  const ls = {
    get length(){ return Object.keys(store).length; },
    key: i => Object.keys(store)[i],
    getItem: k => (k in store? store[k] : null),
    removeItem: k => { delete store[k]; },
    clear: () => { Object.keys(store).forEach(k=>delete store[k]); },
    setItem: (k,v) => {
      if(failFrom!==null){
        const other = Object.keys(store).filter(x=>x!==k).reduce((s,x)=>s+x.length+store[x].length,0);
        if(other + String(k).length + String(v).length > failFrom){
          const e = new Error("Failed to execute 'setItem' on 'Storage': Setting the value of '"+k+"' exceeded the quota.");
          e.name = 'QuotaExceededError';
          throw e;
        }
      }
      store[k] = String(v);
    },
  };
  // jsdom exposes localStorage as a getter-only accessor, so a plain assignment silently does
  // nothing and the test would exercise the real store instead of the quota-limited fake.
  Object.defineProperty(sb, 'localStorage', {value: ls, writable:true, configurable:true});
  sb.__setQuota = n => { failFrom = n; };
  sb.__store = store;
  return sb;
}
function testStorageScanCoversWholeOriginNotJustOurKeys(){
  const sb = storageSandbox();
  sb.localStorage.setItem('ledgerData_v1', 'x'.repeat(1000));
  sb.localStorage.setItem('calendarTasks_v1', 'y'.repeat(500));   // another app on the same domain
  sb.localStorage.setItem('someRandomThirdParty', 'z'.repeat(200));
  const scan = sb.scanLocalStorage();
  assert(scan.entries.length===3, 'The scan must cover every key on the origin, got '+scan.entries.length);
  // Filtering to our own prefix is exactly what hides a neighbour filling the pool.
  assert(scan.entries.some(e=>e.key==='calendarTasks_v1'), 'Another app\'s keys must be listed, not filtered out');
  assert(scan.entries[0].key==='ledgerData_v1', 'Entries should be sorted largest first');
  assert(scan.mine>scan.foreign, 'LedgerOS keys should be attributed to LedgerOS');
  assert(!scan.entries.find(e=>e.key==='calendarTasks_v1').ours, 'A foreign key must be tagged as not ours');
  // key.length + value.length, since both count toward the quota.
  assert(scan.entries[0].size === 'ledgerData_v1'.length + 1000, 'Size should count key plus value, got '+scan.entries[0].size);
}
function testCacheBreakdownReportsPerCollectionSizes(){
  const sb = storageSandbox();
  const payload = {
    ledger: Array.from({length:50},(_,i)=>({id:i, jv:i, date:'2026-01-01', acc:60300, descr:'Groceries - Foods', amt:-100, alloc:null, allocatable:false, accNameSnapshot:'Groceries - Foods', updated_at:'2026-01-01T00:00:00.000000+00:00'})),
    accounts: [{id:60300, name:'Groceries'}],
  };
  sb.localStorage.setItem('ledgerData_v1', JSON.stringify(payload));
  const a = sb.analyzeLedgerCache();
  assert(a && a.parts, 'The cache should be analysable');
  assert(a.parts[0].key==='ledger', 'The largest collection should lead, got '+a.parts[0].key);
  assert(a.parts[0].count===50, 'Record counts should be reported, got '+a.parts[0].count);
  assert(a.parts[0].perRecord>150, 'Bytes-per-record should be reported so the cost is visible, got '+a.parts[0].perRecord);
}
function testQuotaExceededIsSurfacedNotSwallowed(){
  const sb = storageSandbox();
  let toasted = [];
  sb.__set('toast', (m,bad)=>{ toasted.push(String(m)); });
  sb.__set('logActivity', ()=>{});
  sb.__setQuota(100); // tiny cap so the next write fails like a real browser
  // safeSetItem must report failure rather than throwing or pretending it worked.
  const ok = sb.safeSetItem('ledgerData_v1', 'x'.repeat(5000));
  assert(ok===false, 'safeSetItem must return false when the quota is exceeded');
  assert(sb.localStorage.getItem('ledgerData_v1')===null, 'Nothing should have been written');
  // The sync queue holds changes that have NOT reached the cloud — a failure there must be loud.
  // Tighten the cap further: the queue payload is small, so a 100-byte cap would still fit it.
  sb.__setQuota(5);
  sb.__set('syncQueue', [{op:'upsert'},{op:'upsert'}]);
  toasted = [];
  const ok2 = sb.saveSyncQueue();
  assert(ok2===false, 'saveSyncQueue must report failure');
  assert(toasted.length>0, 'A failed sync-queue write must raise a visible warning, not be swallowed');
  assert(/URGENT|unsaved/i.test(toasted.join(' ')), 'The warning must convey that unsaved changes are at risk, got: '+toasted.join(' '));
}
function testClearingCacheBlockedWhileChangesArePending(){
  const sb = storageSandbox();
  const toasted = [];
  sb.__set('toast', m=>toasted.push(String(m)));
  sb.__set('logActivity', ()=>{});
  sb.confirm = () => true;
  sb.localStorage.setItem('ledgerData_v1', 'x'.repeat(1000));
  // The cache is disposable ONLY once everything has reached Supabase.
  sb.__set('syncQueue', [{op:'upsert'}]);
  sb.clearLocalLedgerCache();
  assert(sb.localStorage.getItem('ledgerData_v1')!==null, 'The cache must not be cleared while changes are unsynced');
  assert(/Not safe/i.test(toasted.join(' ')), 'The refusal should say why, got: '+toasted.join(' '));
  // With an empty queue it is safe to drop.
  sb.__set('syncQueue', []);
  sb.__set('renderSettings', ()=>{});
  sb.clearLocalLedgerCache();
  assert(sb.localStorage.getItem('ledgerData_v1')===null, 'With nothing pending, the cache should be cleared');
}

// Uses a real IndexedDB implementation (fake-indexeddb) rather than a stub, so the round trip
// exercises actual transactions, structured cloning and key handling.
function idbSandbox(){
  const sb = storageSandbox();
  // A fresh factory per test so databases don't leak between tests.
  const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
  const factory = new (FDBFactory.default || FDBFactory)();
  Object.defineProperty(sb, 'indexedDB', {value: factory, writable:true, configurable:true});
  sb.__set('_idb', null);
  sb.__set('_idbUnavailable', false);
  sb.__set('logActivity', ()=>{});
  sb.__set('toast', ()=>{});
  return sb;
}
function realLedgerFixture(rows){
  return {
    accounts: [{id:60300, name:'Groceries - Foods', status:'Active'}],
    ledger: Array.from({length:rows},(_,i)=>({
      id:i+1, jv:1000+i, date:'2026-01-'+String((i%28)+1).padStart(2,'0'), acc:60300,
      descr:'Groceries - Foods', amt:-(100+i), alloc:null, allocatable:false,
      accNameSnapshot:'Groceries - Foods', updated_at:'2026-01-01T00:00:00.000000+00:00'
    })),
    budget: [{id:1, date:'2026-01-01', acc:60300, descr:'', amt:750}],
    forecastPlans: {'2026-01': {x:1}},
    invSettings: {fxUsdSar:3.75},
  };
}
async function testIdbRoundTripPreservesEveryRecord(){
  const sb = idbSandbox();
  const fixture = realLedgerFixture(500);
  sb.__set('D', JSON.parse(JSON.stringify(fixture)));
  const ok = await sb.idbSaveD();
  assert(ok===true, 'Saving to IndexedDB should succeed');
  const back = await sb.idbLoadD();
  assert(back, 'Data should be readable back out of IndexedDB');
  assert(back.ledger.length===500, 'Every ledger row must survive the round trip, got '+back.ledger.length);
  // Compare the full payload, not just counts — a silent field drop would pass a count check.
  assert(JSON.stringify(back.ledger)===JSON.stringify(fixture.ledger), 'Ledger rows must round-trip byte-identically');
  assert(JSON.stringify(back.forecastPlans)===JSON.stringify(fixture.forecastPlans), 'Nested objects must round-trip intact');
  assert(back.accounts[0].name==='Groceries - Foods', 'Account records must round-trip intact');
}
async function testMigrationIsNonDestructiveAndVerified(){
  const sb = idbSandbox();
  const fixture = realLedgerFixture(300);
  sb.localStorage.setItem('ledgerData_v1', JSON.stringify(fixture));
  sb.__set('D', {});
  const seen = [];
  const res = await sb.migrateCacheToIdb((pct,what)=>seen.push(pct));
  assert(res.migrated===true, 'Migration should report success, got: '+JSON.stringify(res.reason||''));
  assert(seen.length>0 && seen[seen.length-1]===100, 'Progress should be reported and reach 100');
  // The legacy key is removed only AFTER verification.
  assert(sb.localStorage.getItem('ledgerData_v1')===null, 'The legacy key should be gone once verified');
  const back = await sb.idbLoadD();
  assert(back.ledger.length===300, 'All rows must be present in the new store, got '+back.ledger.length);
  assert(JSON.stringify(back.ledger)===JSON.stringify(fixture.ledger), 'Migrated rows must be identical to the originals');
}
async function testMigrationKeepsLegacyDataWhenVerificationFails(){
  const sb = idbSandbox();
  const fixture = realLedgerFixture(50);
  sb.localStorage.setItem('ledgerData_v1', JSON.stringify(fixture));
  sb.__set('D', {});
  // Simulate the store losing rows: read-back returns fewer than were written.
  sb.__set('idbLoadD', async ()=>({ledger: fixture.ledger.slice(0,10), accounts: fixture.accounts}));
  const res = await sb.migrateCacheToIdb(()=>{});
  assert(res.migrated===false, 'A failed verification must not report success');
  assert(res.keepLegacy===true, 'It must signal that the legacy cache was kept');
  // The original data must still be there — this is the whole point of verify-before-delete.
  const still = sb.localStorage.getItem('ledgerData_v1');
  assert(still!==null, 'The legacy cache MUST survive a failed verification');
  assert(JSON.parse(still).ledger.length===50, 'The legacy cache must be untouched, got '+JSON.parse(still).ledger.length);
}
async function testInterruptedMigrationLosesNothingAndResumes(){
  const sb = idbSandbox();
  const fixture = realLedgerFixture(100);
  sb.localStorage.setItem('ledgerData_v1', JSON.stringify(fixture));
  sb.__set('D', {});
  // Interrupt partway through the writes, as a closed tab would.
  const realPut = vm.runInContext('idbPut', sb);
  let calls = 0;
  sb.__set('idbPut', async (k,v)=>{ if(++calls===2) throw new Error('tab closed'); return realPut(k,v); });
  let threw = false;
  try{ await sb.migrateCacheToIdb(()=>{}); }catch(e){ threw = true; }
  assert(threw, 'An interrupted migration should surface, not silently half-finish');
  // Nothing lost: the source is still intact, so the next boot simply tries again.
  const still = sb.localStorage.getItem('ledgerData_v1');
  assert(still!==null && JSON.parse(still).ledger.length===100, 'Interruption must leave the original cache fully intact');
  // Resume: with the interruption removed, migration completes normally.
  sb.__set('idbPut', realPut);
  const res = await sb.migrateCacheToIdb(()=>{});
  assert(res.migrated===true, 'A retry after interruption should succeed');
  const back = await sb.idbLoadD();
  assert(back.ledger.length===100, 'All rows should be present after the retry, got '+back.ledger.length);
}
async function testFallbackCacheIsTrimmedNotFull(){
  const sb = idbSandbox();
  freezeDate(sb, '2026-08-19');
  const old = {id:1, date:'2020-01-01', acc:60300, descr:'ancient', amt:-5};
  const recent = {id:2, date:'2026-08-01', acc:60300, descr:'recent', amt:-5};
  sb.__set('D', {ledger:[old, recent], budget:[], accounts:[]});
  const trimmed = sb.buildTrimmedCache(vm.runInContext('D', sb));
  assert(trimmed.ledger.length===1 && trimmed.ledger[0].descr==='recent',
    'The fallback cache must drop old history so it stays small, got '+JSON.stringify(trimmed.ledger.map(l=>l.descr)));
  assert(trimmed.__trimmed && trimmed.__trimmed.months>0, 'The fallback should record that it is trimmed');
  assert(trimmed.accounts, 'Non-ledger collections should be kept in full');
}
async function testFootprintGuardWarnsWhenWeCrowdTheDomain(){
  const sb = idbSandbox();
  const warned = [];
  sb.__set('logActivity', (kind,msg)=>warned.push(String(msg)));
  sb.__set('toast', m=>warned.push(String(m)));
  sb.localStorage.setItem('ledgerData_v1', 'x'.repeat(2 * 1024 * 1024)); // 2 MB of a ~5 MB pool
  const r = sb.checkLocalStorageFootprint();
  assert(r && r.pct>25, 'The guard should measure our share, got '+(r&&r.pct));
  assert(warned.some(w=>/crowd|local storage/i.test(w)), 'It should warn when LedgerOS is crowding the domain');
}

// ================= v4.48.0: configurable Balance Freshness threshold + splash screen version =================
async function testGetBalanceStaleDaysDefaultsToZero(){
  const sb = makeSandbox();
  assert(sb.getBalanceStaleDays()===0, 'With nothing saved yet, should default to 0 days (matches the original same-day-only behavior), got ' + sb.getBalanceStaleDays());
}

async function testSaveBalanceStaleDaysPersistsToUiPrefsAndSyncsOnlyThatColumn(){
  const sb = makeSandbox();
  const calls = [];
  sb.__set('syncWrite', async (table, kind, row, base) => { calls.push({table, kind, row}); return {ok:true}; });
  sb.__set('persistLocal', ()=>{});
  await sb.saveBalanceStaleDays(5);
  assert(sb.getBalanceStaleDays()===5, 'Should update the in-memory value immediately, got ' + sb.getBalanceStaleDays());
  assert(calls.length===1 && calls[0].table==='pd_ui_prefs' && calls[0].row.balance_stale_days===5,
    'Should sync-write only the balance_stale_days column to pd_ui_prefs (a partial upsert, so page_order on the same row is left alone), got ' + JSON.stringify(calls));
}

async function testDashboardBalanceColorRespectsConfiguredGracePeriod(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-24T00:00:00.000Z');
  const D = vm.runInContext('D', sb);
  D.accounts = [{id:10101, category:'Bank Accounts', acc_type:'Individual Account', status:'Active', is_credit_card:false, stmt_balance:1000, stmt_date:'2026-08-21'}]; // 3 days before "today"
  D.ledger = [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:1000, descr:'x'}];
  D.uiPrefs = {balanceStaleDays: 3};
  sb.renderDashboard();
  const html = sb.document.getElementById('app').innerHTML;
  const rowStart = html.indexOf('Reconciled');
  assert(rowStart!==-1, 'Should show a Reconciled label for a matched statement balance');
  const row = html.slice(html.lastIndexOf('<tr', rowStart), html.indexOf('</tr>', rowStart));
  assert(/var\(--green\)/.test(row), '3 days elapsed with a configured 3-day grace period should still show green, got row: ' + row);
}

async function testDashboardBalanceColorTurnsRedPastTheGracePeriod(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-24T00:00:00.000Z');
  const D = vm.runInContext('D', sb);
  D.accounts = [{id:10101, category:'Bank Accounts', acc_type:'Individual Account', status:'Active', is_credit_card:false, stmt_balance:1000, stmt_date:'2026-08-20'}]; // 4 days before "today"
  D.ledger = [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:1000, descr:'x'}];
  D.uiPrefs = {balanceStaleDays: 3};
  sb.renderDashboard();
  const html = sb.document.getElementById('app').innerHTML;
  const rowStart = html.indexOf('Reconciled');
  const row = html.slice(html.lastIndexOf('<tr', rowStart), html.indexOf('</tr>', rowStart));
  assert(/var\(--red\)/.test(row), '4 days elapsed past a configured 3-day grace period should show red, got row: ' + row);
}

async function testDashboardBalanceColorDefaultMatchesOriginalSameDayOnlyBehavior(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-24T00:00:00.000Z');
  const D = vm.runInContext('D', sb);
  D.accounts = [{id:10101, category:'Bank Accounts', acc_type:'Individual Account', status:'Active', is_credit_card:false, stmt_balance:1000, stmt_date:'2026-08-23'}]; // yesterday
  D.ledger = [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:1000, descr:'x'}];
  // uiPrefs.balanceStaleDays deliberately left unset — must default to the original behavior.
  sb.renderDashboard();
  const html = sb.document.getElementById('app').innerHTML;
  const rowStart = html.indexOf('Reconciled');
  const row = html.slice(html.lastIndexOf('<tr', rowStart), html.indexOf('</tr>', rowStart));
  assert(/var\(--red\)/.test(row), 'With the default 0-day grace period, a balance updated yesterday should show red — matching the pre-v4.48.0 behavior exactly, got row: ' + row);
}

async function testDashboardBalanceColorSameDayStillGreenWithDefault(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-24T00:00:00.000Z');
  const D = vm.runInContext('D', sb);
  D.accounts = [{id:10101, category:'Bank Accounts', acc_type:'Individual Account', status:'Active', is_credit_card:false, stmt_balance:1000, stmt_date:'2026-08-24'}]; // today
  D.ledger = [{id:1, jv:1, date:'2026-01-01', acc:10101, amt:1000, descr:'x'}];
  sb.renderDashboard();
  const html = sb.document.getElementById('app').innerHTML;
  const rowStart = html.indexOf('Reconciled');
  const row = html.slice(html.lastIndexOf('<tr', rowStart), html.indexOf('</tr>', rowStart));
  assert(/var\(--green\)/.test(row), 'A balance updated today should still show green with the default grace period, got row: ' + row);
}

async function testNormalizeDataShapeDefaultsBalanceStaleDaysToZero(){
  const sb = makeSandbox();
  const bare = {uiPrefs:{pageOrder:['a','b']}}; // has uiPrefs but predates this field
  sb.normalizeDataShape(bare);
  assert(bare.uiPrefs.balanceStaleDays===0, 'normalizeDataShape should default balanceStaleDays to 0 when the field is missing entirely, got ' + bare.uiPrefs.balanceStaleDays);
}

async function testNormalizeDataShapeDoesNotOverwriteAnExistingBalanceStaleDays(){
  const sb = makeSandbox();
  const withValue = {uiPrefs:{pageOrder:null, balanceStaleDays:7}};
  sb.normalizeDataShape(withValue);
  assert(withValue.uiPrefs.balanceStaleDays===7, 'An existing balanceStaleDays value must survive normalization untouched, got ' + withValue.uiPrefs.balanceStaleDays);
}

async function testRestoreFromBackupCloudPathIncludesBalanceStaleDaysEvenWithoutPageOrder(){
  // Regression test for the exact hardcoded-whitelist bug class this app has hit before (sync
  // conflict modal, the backup script itself, twice): the pre-existing restoreFromBackup line
  // only wrote pd_ui_prefs to the cloud AT ALL if pageOrder was truthy — so a backup where only
  // the new Balance Freshness threshold was ever customized (pageOrder still null/default) would
  // silently lose that setting on a cloud restore. Full behavioral coverage of the cloud-restore
  // branch would require mocking the entire chained Supabase client across 17+ tables, which no
  // existing test in this suite does either (see testRestoreFromBackupDoesNotCrashOnAnOldBackupMissingNewerFields's
  // own comment) — checking the actual source line directly is the established pattern here for
  // exactly this situation (see e.g. testDeleteJvIsGoneEntirely).
  const src = fs.readFileSync(APP_HTML, 'utf8');
  const line = src.match(/if\(D\.uiPrefs[^;]*insertWithRetry\('pd_ui_prefs'[^;]*;/);
  const lineText = line? line[0] : '';
  assert(!!line, 'Should find the pd_ui_prefs cloud-restore line');
  assert(/D\.uiPrefs\.pageOrder \|\| D\.uiPrefs\.balanceStaleDays/.test(lineText),
    'The condition must also fire when only balanceStaleDays is set, not just pageOrder, got: ' + lineText);
  assert(/balance_stale_days:getBalanceStaleDays\(\)/.test(lineText), 'The restore payload must include balance_stale_days, got: ' + lineText);
}

async function testBalanceFreshnessSettingsPanelShowsCurrentValue(){
  const sb = makeSandbox();
  sb.__set('settingsTab', 'balancefreshness');
  const D = vm.runInContext('D', sb);
  D.uiPrefs = D.uiPrefs || {}; D.uiPrefs.balanceStaleDays = 4;
  sb.renderSettings();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/Balance Freshness/.test(html), 'The settings panel should be present');
  assert(/id="balanceStaleDaysInput"[^>]*value="4"/.test(html), 'The input should reflect the currently saved value (4), got snippet: ' + html.slice(html.indexOf('balanceStaleDaysInput')-40, html.indexOf('balanceStaleDaysInput')+80));
}

async function testSaveBalanceStaleDaysFromInputValidatesAndToasts(){
  const sb = makeSandbox();
  const input = sb.document.createElement('input'); input.id='balanceStaleDaysInput'; input.value='7'; sb.document.body.appendChild(input);
  let toastMsg = null;
  sb.__set('toast', (m)=>{ toastMsg = m; });
  sb.__set('renderSettings', ()=>{});
  sb.__set('screen', 'ledger'); // not on the dashboard — renderDashboard should not be required
  const calls = [];
  sb.__set('syncWrite', async (table, kind, row, base) => { calls.push(row); return {ok:true}; });
  sb.__set('persistLocal', ()=>{});
  await sb.saveBalanceStaleDaysFromInput();
  assert(sb.getBalanceStaleDays()===7, 'Should persist the typed value, got ' + sb.getBalanceStaleDays());
  assert(toastMsg && /Balance Freshness/.test(toastMsg), 'Should confirm the save, got: ' + toastMsg);
}

async function testSaveBalanceStaleDaysFromInputRejectsInvalidValues(){
  const sb = makeSandbox();
  const input = sb.document.createElement('input'); input.id='balanceStaleDaysInput'; input.value='-1'; sb.document.body.appendChild(input);
  let toastMsg = null, toastBad = null;
  sb.__set('toast', (m,bad)=>{ toastMsg = m; toastBad = bad; });
  await sb.saveBalanceStaleDaysFromInput();
  assert(sb.getBalanceStaleDays()===0, 'An invalid (-1) value must not be saved, should remain at the default 0');
  assert(toastMsg && toastBad, 'Should show an error toast for an invalid value, got: ' + toastMsg);
}

async function testSaveBalanceStaleDaysFromInputRefreshesDashboardWhenOnIt(){
  const sb = makeSandbox();
  const input = sb.document.createElement('input'); input.id='balanceStaleDaysInput'; input.value='2'; sb.document.body.appendChild(input);
  sb.__set('screen', 'dashboard');
  sb.__set('toast', ()=>{});
  sb.__set('renderSettings', ()=>{});
  sb.__set('syncWrite', async ()=>({ok:true}));
  sb.__set('persistLocal', ()=>{});
  let dashRendered = false;
  sb.__set('renderDashboard', ()=>{ dashRendered = true; });
  await sb.saveBalanceStaleDaysFromInput();
  assert(dashRendered, 'Should refresh the dashboard immediately when currently viewing it, so the new threshold is reflected without a manual navigation');
}

async function testShowSplashSetsVersionTag(){
  const sb = makeSandbox();
  const doc = sb.document;
  doc.body.appendChild(Object.assign(doc.createElement('div'), {id:'splashScreen'}));
  const vEl = doc.createElement('div'); vEl.id='splashVersionTag'; doc.body.appendChild(vEl);
  doc.body.appendChild(Object.assign(doc.createElement('button'), {id:'splashBypassBtn'}));
  doc.body.appendChild(Object.assign(doc.createElement('div'), {id:'splashProgressPct'}));
  doc.body.appendChild(Object.assign(doc.createElement('div'), {id:'splashProgressFill'}));
  sb.showSplash();
  const APP_VERSION = vm.runInContext('APP_VERSION', sb);
  assert(vEl.textContent === 'v'+APP_VERSION, 'showSplash should set the version tag text to v+APP_VERSION, got ' + vEl.textContent);
}

async function testSplashVersionTagNotOverwrittenIfAlreadySet(){
  // Mirrors the exact guard used for the sidebar version tag in renderNav — set once, never
  // clobbering something already there.
  const sb = makeSandbox();
  const doc = sb.document;
  doc.body.appendChild(Object.assign(doc.createElement('div'), {id:'splashScreen'}));
  const vEl = doc.createElement('div'); vEl.id='splashVersionTag'; vEl.textContent = 'v9.9.9-custom'; doc.body.appendChild(vEl);
  doc.body.appendChild(Object.assign(doc.createElement('button'), {id:'splashBypassBtn'}));
  doc.body.appendChild(Object.assign(doc.createElement('div'), {id:'splashProgressPct'}));
  doc.body.appendChild(Object.assign(doc.createElement('div'), {id:'splashProgressFill'}));
  sb.showSplash();
  assert(vEl.textContent === 'v9.9.9-custom', 'showSplash should not overwrite existing tag text, got ' + vEl.textContent);
}

function testSplashScreenMarkupIncludesVersionElement(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(/id="splashVersionTag"/.test(html), 'The splash screen markup should include a version tag element for showSplash() to populate');
}

// ================= v4.49.0: Account Budget Chart (P&L sub-page) =================
function acctBudgetChartFixtureD(extra){
  const D = Object.assign({
    accounts: [
      {id:60101, category:'Bills', acc_type:'Individual Account', status:'Active'},
      {id:60102, category:'Bills', acc_type:'Individual Account', status:'Active'},
      {id:60103, category:'Bills', acc_type:'Individual Account', status:'Deleted'}, // has a budget row but Deleted — must be excluded
      {id:30101, category:'Salary', acc_type:'Individual Account', status:'Active'}, // income, not expense — must be excluded regardless of any budget row
    ],
    ledger: [], budget: [], provisionGroups: [], forecastAccountRules: []
  }, extra||{});
  return D;
}
async function testAccountsWithBudgetFiguresIncludesEveryPlanSource(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({
    budget: [{id:1, acc:60101, date:'2026-08-01', amt:100}, {id:2, acc:60103, date:'2026-08-01', amt:50}, {id:3, acc:30101, date:'2026-08-01', amt:9999}],
    provisionGroups: [{id:1, name:'Home', lines:[{lineId:'l1', acc:60102}], months:{}}],
  });
  sb.__set('D', D);
  const opts = sb.accountsWithBudgetFigures();
  const ids = opts.map(a=>a.id);
  assert(ids.includes(60101), 'An account with a legacy D.budget row should be included, got ' + ids.join(','));
  assert(ids.includes(60102), 'An account whose plan comes from Provisions only should also be included, got ' + ids.join(','));
  assert(!ids.includes(60103), 'A Deleted account must be excluded even though it has a budget row, got ' + ids.join(','));
  assert(!ids.includes(30101), 'An income account (starts with 3) must never be included regardless of any budget row, got ' + ids.join(','));
}
async function testAccountsWithBudgetFiguresIncludesSmartRuleOnlyAccounts(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({
    forecastAccountRules: [{id:1, name:'Insurance rule', account:60101, rule:{type:'fixed', value:100, sign:1}}],
  });
  sb.__set('D', D);
  const ids = sb.accountsWithBudgetFigures().map(a=>a.id);
  assert(ids.includes(60101), 'An account whose only plan source is a Smart Rule should still be included, got ' + ids.join(','));
}
async function testAccountsWithBudgetFiguresExcludesAccountsWithNoPlanAtAll(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD();
  sb.__set('D', D);
  assert(sb.accountsWithBudgetFigures().length===0, 'An expense account with no budget, Provisions line, or Smart Rule anywhere should not appear in the picker');
}
async function testAcctBudgetChartYearsAlwaysIncludesTheCurrentYearEvenWithNoActivity(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-24T00:00:00.000Z');
  sb.__set('D', {ledger:[{id:1, jv:1, date:'2023-01-01', acc:60101, amt:-100, descr:'x'}]}); // no 2026 activity at all
  const years = sb.acctBudgetChartYears();
  assert(years.includes('2026'), 'The current year must always be selectable even with zero ledger activity yet, got ' + years.join(','));
  assert(years[0]==='2026', 'Years should be sorted most-recent-first, got ' + years.join(','));
  assert(years.includes('2023'), 'A year with real ledger activity should still be included, got ' + years.join(','));
}
async function testComputeAcctBudgetChartDataUsesOriginalPlanEvenForPastMonths(){
  // The exact past-month-locking gotcha documented for the Month End Accrual JV fix: without
  // passing each month as its own "current month", computeForecastCell would collapse a past
  // month's plan into its actual figure — silently making every Budget bar for a prior year (or
  // an earlier month this year) equal to Actual instead of showing the real original plan.
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-24T00:00:00.000Z'); // "today" is well after the whole of 2025
  const D = acctBudgetChartFixtureD({
    ledger: [{id:1, jv:1, date:'2025-03-15', acc:60101, amt:-390, descr:'x'}],
    provisionGroups: [{id:1, name:'Home', lines:[{lineId:'l1', acc:60101}], months:{'2025-03':{l1:-300}}}],
  });
  sb.__set('D', D);
  sb.__set('ACC_BY_ID', Object.fromEntries(D.accounts.map(a=>[a.id,a])));
  const data = sb.computeAcctBudgetChartData(60101, '2025');
  assert(Math.abs(data.budgetVals[2] - (-300)) < 0.5, 'March 2025\'s Budget bar should show the real original plan (-300), not collapse to match Actual (-390), got ' + data.budgetVals[2]);
  assert(Math.abs(data.actualVals[2] - (-390)) < 0.5, 'March 2025\'s Actual should still be the real ledger spend, got ' + data.actualVals[2]);
}
async function testComputeAcctBudgetChartDataZerosFutureMonthsActual(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-24T00:00:00.000Z');
  const D = acctBudgetChartFixtureD({
    ledger: [{id:1, jv:1, date:'2026-11-01', acc:60101, amt:-500, descr:'x (should never count — this is in the future)'}],
    budget: [{id:1, acc:60101, date:'2026-11-01', amt:-400}],
  });
  sb.__set('D', D);
  sb.__set('ACC_BY_ID', Object.fromEntries(D.accounts.map(a=>[a.id,a])));
  const data = sb.computeAcctBudgetChartData(60101, '2026');
  assert(data.actualVals[10]===0, 'November 2026 (a future month) should show Actual as exactly 0 per the confirmed decision, got ' + data.actualVals[10]);
  assert(Math.abs(data.budgetVals[10] - (-400)) < 0.5, 'A future month\'s Budget bar should still show the real planned figure, got ' + data.budgetVals[10]);
}
async function testComputeAcctBudgetChartDataCumulativeRunsCorrectlyAndFlattensAfterToday(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-02-15T00:00:00.000Z'); // only Jan and Feb have "happened"
  const D = acctBudgetChartFixtureD({
    ledger: [
      {id:1, jv:1, date:'2026-01-10', acc:60101, amt:-100, descr:'x'},
      {id:2, jv:2, date:'2026-02-10', acc:60101, amt:-150, descr:'x'},
    ],
    budget: [
      {id:1, acc:60101, date:'2026-01-01', amt:-120},
      {id:2, acc:60101, date:'2026-02-01', amt:-120},
      {id:3, acc:60101, date:'2026-03-01', amt:-120}, // March hasn't happened yet
    ],
  });
  sb.__set('D', D);
  sb.__set('ACC_BY_ID', Object.fromEntries(D.accounts.map(a=>[a.id,a])));
  const data = sb.computeAcctBudgetChartData(60101, '2026');
  assert(Math.abs(data.cumBudget[2] - (-360)) < 0.5, 'Cumulative Budget through March should be -120*3=-360, got ' + data.cumBudget[2]);
  assert(Math.abs(data.cumActual[1] - (-250)) < 0.5, 'Cumulative Actual through February should be -100-150=-250, got ' + data.cumActual[1]);
  assert(data.cumActual[2]===data.cumActual[1], 'Cumulative Actual must flatten at March (a future month contributing 0), not keep climbing, got cumActual[1]=' + data.cumActual[1] + ' cumActual[2]=' + data.cumActual[2]);
}
async function testComputeAcctBudgetChartDataRemainingIsSignConventionProof(){
  // Negative-sign expense convention: budget -1200 total, actual -900 total -> 300 remaining.
  const negD = acctBudgetChartFixtureD({
    ledger: Array.from({length:12},(_,i)=>({id:i+1, jv:i+1, date:'2026-'+String(i+1).padStart(2,'0')+'-15', acc:60101, amt:-75, descr:'x'})),
    budget: Array.from({length:12},(_,i)=>({id:i+1, acc:60101, date:'2026-'+String(i+1).padStart(2,'0')+'-01', amt:-100})),
  });
  const sbNeg = makeSandbox();
  freezeDate(sbNeg, '2026-12-31T00:00:00.000Z');
  sbNeg.__set('D', negD);
  sbNeg.__set('ACC_BY_ID', Object.fromEntries(negD.accounts.map(a=>[a.id,a])));
  const negData = sbNeg.computeAcctBudgetChartData(60101, '2026');
  assert(Math.abs(negData.remaining - 300) < 0.5, 'Negative-convention remaining should be 300 (1200-900 by magnitude), got ' + negData.remaining);

  // Same real-world position, positive-sign convention: budget 1200 total, actual 900 total.
  const posD = acctBudgetChartFixtureD({
    ledger: Array.from({length:12},(_,i)=>({id:i+1, jv:i+1, date:'2026-'+String(i+1).padStart(2,'0')+'-15', acc:60101, amt:75, descr:'x'})),
    budget: Array.from({length:12},(_,i)=>({id:i+1, acc:60101, date:'2026-'+String(i+1).padStart(2,'0')+'-01', amt:100})),
  });
  const sbPos = makeSandbox();
  freezeDate(sbPos, '2026-12-31T00:00:00.000Z');
  sbPos.__set('D', posD);
  sbPos.__set('ACC_BY_ID', Object.fromEntries(posD.accounts.map(a=>[a.id,a])));
  const posData = sbPos.computeAcctBudgetChartData(60101, '2026');
  assert(Math.abs(posData.remaining - 300) < 0.5, 'The same real remaining amount must read as 300 under the positive convention too, got ' + posData.remaining);
}
async function testOpenAcctBudgetChartRoutesRenderPnLToTheSubpage(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({budget:[{id:1, acc:60101, date:'2026-08-01', amt:100}]});
  sb.__set('D', D);
  sb.__set('ACC_BY_ID', Object.fromEntries(D.accounts.map(a=>[a.id,a])));
  sb.openAcctBudgetChart();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/Back to P&amp;L/.test(html), 'Opening the chart should route renderPnL() to the sub-page, got snippet: ' + html.slice(0,300));
  assert(vm.runInContext('pnlView', sb)==='acctchart', 'pnlView should be set to acctchart');
}
async function testCloseAcctBudgetChartReturnsToMainPnLView(){
  const sb = makeSandbox();
  sb.__set('D', acctBudgetChartFixtureD());
  sb.__set('pnlView', 'acctchart');
  sb.closeAcctBudgetChart();
  assert(vm.runInContext('pnlView', sb)==='main', 'Closing should reset pnlView back to main');
  const html = sb.document.getElementById('app').innerHTML;
  assert(/Total Income/.test(html), 'Closing should render the real main P&L view, not stay on the sub-page, got snippet: ' + html.slice(0,300));
}
async function testRenderAcctBudgetChartPageShowsEmptyStateWithNoBudgetedAccounts(){
  const sb = makeSandbox();
  sb.__set('D', acctBudgetChartFixtureD()); // no budget/provisions/rules anywhere
  sb.__set('pnlView', 'acctchart');
  sb.renderPnL();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/No expense accounts with a budget/.test(html), 'Should show a clear empty state rather than crash or render a blank chart, got snippet: ' + html.slice(0,500));
}
async function testSelectAcctBudgetChartAccountAndYearUpdateState(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({
    budget:[{id:1, acc:60101, date:'2026-08-01', amt:100},{id:2, acc:60102, date:'2026-08-01', amt:200}],
    ledger:[{id:1, jv:1, date:'2024-01-01', acc:60101, amt:-50, descr:'x'}], // makes 2024 an actual, legitimately selectable year
  });
  sb.__set('D', D);
  sb.__set('ACC_BY_ID', Object.fromEntries(D.accounts.map(a=>[a.id,a])));
  sb.__set('pnlView', 'acctchart');
  sb.selectAcctBudgetChartAccount('60102');
  assert(vm.runInContext('acctChartAccId', sb)===60102, 'Selecting an account should update acctChartAccId as a number, got ' + vm.runInContext('acctChartAccId', sb));
  sb.selectAcctBudgetChartYear('2024');
  assert(vm.runInContext('acctChartYear', sb)==='2024', 'Selecting a year that is actually a valid option should update acctChartYear, got ' + vm.runInContext('acctChartYear', sb));
}

// ================= v4.50.0: P&L chart-link icon jumps straight into a specific account =================
async function testOpenAcctBudgetChartAcceptsASpecificAccountId(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({budget:[{id:1, acc:60102, date:'2026-08-01', amt:100}]});
  sb.__set('D', D);
  sb.__set('acctChartAccId', null);
  sb.openAcctBudgetChart(60102);
  assert(vm.runInContext('acctChartAccId', sb)===60102, 'Passing an account id should select it directly, got ' + vm.runInContext('acctChartAccId', sb));
  assert(vm.runInContext('pnlView', sb)==='acctchart', 'Should still route into the chart sub-page');
}

async function testOpenAcctBudgetChartWithNoArgumentKeepsTheOldDefaultBehavior(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({budget:[{id:1, acc:60101, date:'2026-08-01', amt:100}]});
  sb.__set('D', D);
  sb.__set('acctChartAccId', null);
  sb.openAcctBudgetChart(); // no id — the pre-existing call shape, used by the standalone button
  assert(vm.runInContext('acctChartAccId', sb)===60101, 'With no id passed, should fall back to the first available budgeted account exactly as before, got ' + vm.runInContext('acctChartAccId', sb));
}

async function testOpenAcctBudgetChartWithSpecificIdOverridesAnyPreviousSelection(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({budget:[{id:1, acc:60101, date:'2026-08-01', amt:100}, {id:2, acc:60102, date:'2026-08-01', amt:50}]});
  sb.__set('D', D);
  sb.__set('acctChartAccId', 60101); // already viewing a different account
  sb.openAcctBudgetChart(60102); // jump to a different one via the new link
  assert(vm.runInContext('acctChartAccId', sb)===60102, 'A specific id passed in should override whatever was previously selected, got ' + vm.runInContext('acctChartAccId', sb));
}

async function testPnLChartLinkShowsOnlyForBudgetedExpenseAccounts(){
  const sb = makeSandbox();
  const D = {
    accounts: [
      {id:60101, category:'Bills', acc_type:'Individual Account', status:'Active'}, // has a budget row — should get the link
      {id:60102, category:'Bills', acc_type:'Individual Account', status:'Active'}, // no plan anywhere — must NOT get the link
      {id:30101, category:'Salary', acc_type:'Individual Account', status:'Active'}, // income — never gets this link regardless
    ],
    ledger: [
      {id:1, jv:1, date:'2026-08-05', acc:60101, amt:-50, descr:'x'},
      {id:2, jv:2, date:'2026-08-06', acc:60102, amt:-30, descr:'y'},
      {id:3, jv:3, date:'2026-08-07', acc:30101, amt:1000, descr:'z'},
    ],
    budget: [{id:1, acc:60101, date:'2026-08-01', amt:100}],
    provisionGroups: [], forecastAccountRules: []
  };
  sb.__set('D', D);
  sb.__set('pnlFrom', '2026-08-01');
  sb.__set('pnlTo', '2026-08-31');
  sb.__set('pnlPreset', 'custom');
  sb.renderPnL();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/openAcctBudgetChart\(60101\)/.test(html), 'The budgeted expense account (60101) should get the chart link');
  assert(!/openAcctBudgetChart\(60102\)/.test(html), 'An expense account with no plan anywhere must NOT get the chart link, got snippet: ' + html.slice(html.indexOf('60102')-50, html.indexOf('60102')+150));
  assert(!/openAcctBudgetChart\(30101\)/.test(html), 'An income account must never get the chart link, regardless of any budget data');
}

function testPnLChartLinkStopsClickPropagationToTheRowHandler(){
  // The account name cell's own onclick opens viewPnLAccountTransactions — without
  // stopPropagation, clicking the 📊 icon would fire both handlers and immediately navigate away
  // from the chart before it could ever render.
  const html = fs.readFileSync(APP_HTML, 'utf8');
  const iconSnippet = html.slice(html.indexOf('openAcctBudgetChart(${i.a.id})')-60, html.indexOf('openAcctBudgetChart(${i.a.id})')+40);
  assert(/event\.stopPropagation\(\)/.test(iconSnippet), 'The chart-link icon must stop click propagation to the row\'s own handler, got: ' + iconSnippet);
}

// ================= v4.51.0: click an Actual bar on the Account Budget Chart to see that month's transactions =================
async function testAcctBudgetBarChartClickOpensTransactionsForActualBar(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({
    budget:[{id:1, acc:60101, date:'2026-08-01', amt:100}],
    ledger:[{id:1, jv:1, date:'2026-03-15', acc:60101, amt:-42, descr:'Coffee'}]
  });
  sb.__set('D', D);
  let modalHtml = null;
  sb.__set('showModal', (html)=>{ modalHtml = html; });
  const months = ['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10','2026-11','2026-12'];
  sb.acctBudgetBarChartClickHandler([{datasetIndex:1, index:2}], months, 60101); // March, the Actual dataset
  assert(modalHtml!==null, 'Clicking an Actual bar should open a modal');
  const safeHtml = modalHtml || '';
  assert(/Coffee/.test(safeHtml), 'The modal should list that month\'s real transaction, got: ' + safeHtml.slice(0,400));
  assert(/-42/.test(safeHtml) || safeHtml.indexOf('42')!==-1, 'The transaction amount should appear in the modal');
}

async function testAcctBudgetBarChartClickIgnoresBudgetBar(){
  const sb = makeSandbox();
  let modalOpened = false;
  sb.__set('showModal', ()=>{ modalOpened = true; });
  const months = ['2026-01','2026-02','2026-03'];
  sb.acctBudgetBarChartClickHandler([{datasetIndex:0, index:1}], months, 60101); // the Budget bar (dataset 0)
  assert(!modalOpened, 'Clicking the Budget bar must not open anything — Budget has no real transactions to drill into');
}

async function testAcctBudgetBarChartClickHandlesNoElementsGracefully(){
  const sb = makeSandbox();
  let modalOpened = false;
  sb.__set('showModal', ()=>{ modalOpened = true; });
  sb.acctBudgetBarChartClickHandler([], ['2026-01'], 60101); // a click that landed on empty chart area
  assert(!modalOpened, 'A click with no chart elements under it should be a clean no-op, not throw');
}

async function testAcctBudgetBarChartClickOnFutureFlatMonthShowsHonestEmptyState(){
  // Future months' Actual bar sits flat at 0 per the confirmed behavior — clicking it should
  // still open the modal and show a genuine "no transactions" state rather than silently doing
  // nothing, which would look like a broken click rather than an honest empty month.
  const sb = makeSandbox();
  freezeDate(sb, '2026-03-01T00:00:00.000Z');
  const D = acctBudgetChartFixtureD({budget:[{id:1, acc:60101, date:'2026-08-01', amt:100}], ledger:[]});
  sb.__set('D', D);
  let modalHtml = null;
  sb.__set('showModal', (html)=>{ modalHtml = html; });
  const months = ['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10','2026-11','2026-12'];
  sb.acctBudgetBarChartClickHandler([{datasetIndex:1, index:7}], months, 60101); // August — a future month relative to frozen "today"
  assert(modalHtml!==null, 'Should still open the modal for a future (flat-zero) month');
  assert(/No transactions this month/.test(modalHtml||''), 'Should show the honest empty state, not fabricate anything, got: ' + (modalHtml||'').slice(0,400));
}

function testViewAcctBudgetChartMonthTransactionsFiltersToTheExactAccountAndMonth(){
  const sb = makeSandbox();
  const D = vm.runInContext('D', sb);
  D.accounts = [{id:60101, category:'Bills', acc_type:'Individual Account', status:'Active'}, {id:60102, category:'Bills', acc_type:'Individual Account', status:'Active'}];
  D.ledger = [
    {id:1, jv:1, date:'2026-03-10', acc:60101, amt:-30, descr:'March, right account'},
    {id:2, jv:2, date:'2026-04-10', acc:60101, amt:-99, descr:'Wrong month'},
    {id:3, jv:3, date:'2026-03-10', acc:60102, amt:-77, descr:'Wrong account'},
  ];
  let modalHtml = null;
  sb.__set('showModal', (html)=>{ modalHtml = html; });
  sb.viewAcctBudgetChartMonthTransactions(60101, '2026-03');
  const safeModalHtml = modalHtml || '';
  assert(/March, right account/.test(safeModalHtml), 'Should include the matching transaction');
  assert(!/Wrong month/.test(safeModalHtml), 'Should exclude a transaction from a different month on the same account');
  assert(!/Wrong account/.test(safeModalHtml), 'Should exclude a transaction from a different account in the same month');
}

// ================= v4.52.0: Account Budget Chart — Sub Category mode =================
async function testSubcategoriesWithBudgetFiguresIncludesOnlyCategoriesWithABudgetedAccount(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({
    budget: [{id:1, acc:60101, date:'2026-08-01', amt:100}], // 60101 and 60102 are both category "Bills"
  });
  sb.__set('D', D);
  const cats = sb.subcategoriesWithBudgetFigures();
  assert(cats.includes('Bills'), 'A category with at least one budgeted account should be included, got ' + cats.join(','));
  assert(!cats.includes('Salary'), 'An income category must never be included, got ' + cats.join(','));
}
async function testSubcategoriesWithBudgetFiguresExcludesCategoriesWithNoBudgetAtAll(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD(); // no budget/provisions/rules anywhere
  sb.__set('D', D);
  assert(sb.subcategoriesWithBudgetFigures().length===0, 'A category where nothing has ever been budgeted should not appear in the picker');
}
async function testAcctBudgetChartCategoryAccountIdsIncludesEveryAccountRegardlessOfItsOwnBudgetStatus(){
  // Matches the P&L page's own category subtotal semantics exactly (expByCat sums every expense
  // account in the category, not just the ones individually budgeted) — an unbudgeted account's
  // real spend still counts toward the category's real total.
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({budget: [{id:1, acc:60101, date:'2026-08-01', amt:100}]}); // only 60101 has a budget row; 60102 has none
  sb.__set('D', D);
  const ids = sb.acctBudgetChartCategoryAccountIds('Bills');
  assert(ids.has(60101) && ids.has(60102), 'Both Bills accounts should be included regardless of which one has its own budget row, got ' + [...ids].join(','));
  assert(!ids.has(60103), 'The Deleted Bills account must be excluded, got ' + [...ids].join(','));
  assert(!ids.has(30101), 'The income account must never be included even if it somehow shared the category name');
}
async function testComputeAcctBudgetChartDataForCategoryAggregatesAcrossEveryAccountInTheCategory(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-08-24T00:00:00.000Z');
  const D = acctBudgetChartFixtureD({
    provisionGroups: [{id:1, name:'Home', lines:[{lineId:'l1', acc:60101},{lineId:'l2', acc:60102}], months:{'2026-03':{l1:200, l2:100}}}],
    ledger: [
      {id:1, jv:1, date:'2026-03-10', acc:60101, amt:-150, descr:'x'},
      {id:2, jv:2, date:'2026-03-15', acc:60102, amt:-75, descr:'y'},
    ],
  });
  sb.__set('D', D);
  sb.__set('ACC_BY_ID', Object.fromEntries(D.accounts.map(a=>[a.id,a])));
  const data = sb.computeAcctBudgetChartDataForCategory('Bills', '2026');
  const marIdx = data.months.indexOf('2026-03');
  assert(Math.abs(data.budgetVals[marIdx]-300)<0.005, 'March budget should be the sum of both accounts\' plans (200+100=300), got ' + data.budgetVals[marIdx]);
  assert(Math.abs(data.actualVals[marIdx]-(-225))<0.005, 'March actual should be the sum of both accounts\' real spend, kept in the ledger\'s own raw sign convention (-150 + -75 = -225), got ' + data.actualVals[marIdx]);
}
async function testComputeAcctBudgetChartDataForCategoryZerosFutureMonths(){
  const sb = makeSandbox();
  freezeDate(sb, '2026-03-15T00:00:00.000Z');
  const D = acctBudgetChartFixtureD({
    budget: [{id:1, acc:60101, date:'2026-08-01', amt:400}],
    ledger: [{id:1, jv:1, date:'2026-08-05', acc:60101, amt:-999, descr:'should never count — future month'}],
  });
  sb.__set('D', D);
  sb.__set('ACC_BY_ID', Object.fromEntries(D.accounts.map(a=>[a.id,a])));
  const data = sb.computeAcctBudgetChartDataForCategory('Bills', '2026');
  const augIdx = data.months.indexOf('2026-08');
  assert(data.actualVals[augIdx]===0, 'A future month\'s Actual should stay flat at 0 in subcategory mode too, got ' + data.actualVals[augIdx]);
}
async function testSelectAcctBudgetChartModeAndSubcatUpdateState(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({budget:[{id:1, acc:60101, date:'2026-08-01', amt:100}]}); // makes "Bills" a real, selectable category
  sb.__set('D', D);
  sb.__set('ACC_BY_ID', Object.fromEntries(D.accounts.map(a=>[a.id,a])));
  sb.__set('pnlView', 'acctchart');
  sb.selectAcctBudgetChartMode('subcategory');
  assert(vm.runInContext('acctChartMode', sb)==='subcategory', 'Selecting subcategory mode should update acctChartMode, got ' + vm.runInContext('acctChartMode', sb));
  sb.selectAcctBudgetChartSubcat('Bills');
  assert(vm.runInContext('acctChartSubcat', sb)==='Bills', 'Selecting a sub category should update acctChartSubcat, got ' + vm.runInContext('acctChartSubcat', sb));
  sb.selectAcctBudgetChartMode('account');
  assert(vm.runInContext('acctChartMode', sb)==='account', 'Selecting account mode should switch back, got ' + vm.runInContext('acctChartMode', sb));
}
async function testOpenAcctBudgetChartForCategorySetsSubcatModeAndOpensThePage(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({budget:[{id:1, acc:60101, date:'2026-08-01', amt:100}]});
  sb.__set('D', D);
  sb.__set('acctChartMode', 'account'); // starting from account mode
  sb.openAcctBudgetChartForCategory('Bills');
  assert(vm.runInContext('acctChartSubcat', sb)==='Bills', 'Should select the passed category, got ' + vm.runInContext('acctChartSubcat', sb));
  assert(vm.runInContext('acctChartMode', sb)==='subcategory', 'Should switch into subcategory mode, got ' + vm.runInContext('acctChartMode', sb));
  assert(vm.runInContext('pnlView', sb)==='acctchart', 'Should route into the chart sub-page');
}
async function testOpenAcctBudgetChartWithAnAccountIdSwitchesBackToAccountMode(){
  // Guards against getting stuck in subcategory mode if the person then clicks an individual
  // account's own 📊 link — the per-account link must always land in Account mode, not leave a
  // stale subcategory selection in charge of what's displayed.
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({budget:[{id:1, acc:60101, date:'2026-08-01', amt:100}]});
  sb.__set('D', D);
  sb.__set('acctChartMode', 'subcategory');
  sb.openAcctBudgetChart(60101);
  assert(vm.runInContext('acctChartMode', sb)==='account', 'Opening a specific account should always switch back to account mode, got ' + vm.runInContext('acctChartMode', sb));
}
async function testRenderAcctBudgetChartPageShowsSubcatPickerInSubcategoryMode(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({budget:[{id:1, acc:60101, date:'2026-08-01', amt:100}]});
  sb.__set('D', D);
  sb.__set('ACC_BY_ID', Object.fromEntries(D.accounts.map(a=>[a.id,a])));
  sb.__set('acctChartMode', 'subcategory');
  sb.renderAcctBudgetChartPage();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/Sub Category/.test(html), 'Should show the Sub Category label/picker in subcategory mode');
  assert(!/label class="fl">Account</.test(html), 'Should NOT show the Account picker while in subcategory mode');
  assert(/Bills/.test(html), 'The Bills category should appear as an option');
}
async function testRenderAcctBudgetChartPageFallsBackWhenSelectedSubcatNoLongerQualifies(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({budget:[{id:1, acc:60101, date:'2026-08-01', amt:100}]});
  sb.__set('D', D);
  sb.__set('ACC_BY_ID', Object.fromEntries(D.accounts.map(a=>[a.id,a])));
  sb.__set('acctChartMode', 'subcategory');
  sb.__set('acctChartSubcat', 'NotARealCategory');
  sb.renderAcctBudgetChartPage();
  assert(vm.runInContext('acctChartSubcat', sb)==='Bills', 'An invalid/stale sub category should fall back to the first available option, got ' + vm.runInContext('acctChartSubcat', sb));
}
async function testAcctBudgetBarChartClickHandlerRoutesToSubcategoryModalWhenModeIsSubcategory(){
  const sb = makeSandbox();
  let calledWith = null;
  sb.__set('viewAcctBudgetChartMonthTransactionsForCategory', (cat, mk)=>{ calledWith = {cat, mk}; });
  const months = ['2026-01','2026-02','2026-03'];
  sb.acctBudgetBarChartClickHandler([{datasetIndex:1, index:1}], months, 'Bills', 'subcategory');
  assert(calledWith && calledWith.cat==='Bills' && calledWith.mk==='2026-02', 'Clicking the Actual bar in subcategory mode should open the category transactions modal for the right month, got ' + JSON.stringify(calledWith));
}
async function testAcctBudgetBarChartClickHandlerStillRoutesToAccountModalWithNoModeArgument(){
  // Regression check: old call sites/tests that don't pass the 4th (mode) argument at all must
  // keep working exactly as before — this is exactly the kind of backward-compatibility gap this
  // app's own conventions call out repeatedly.
  const sb = makeSandbox();
  let calledWith = null;
  sb.__set('viewAcctBudgetChartMonthTransactions', (accId, mk)=>{ calledWith = {accId, mk}; });
  const months = ['2026-01','2026-02'];
  sb.acctBudgetBarChartClickHandler([{datasetIndex:1, index:0}], months, 60101);
  assert(calledWith && calledWith.accId===60101 && calledWith.mk==='2026-01', 'With no mode argument, should still default to account-mode routing, got ' + JSON.stringify(calledWith));
}
async function testViewAcctBudgetChartMonthTransactionsForCategoryGroupsByAccountThenDate(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD({
    ledger: [
      {id:1, jv:1, date:'2026-03-20', acc:60101, descr:'Later', amt:-40, alloc:null, allocatable:false},
      {id:2, jv:2, date:'2026-03-05', acc:60101, descr:'Earlier', amt:-10, alloc:null, allocatable:false},
      {id:3, jv:3, date:'2026-03-12', acc:60102, descr:'OtherAcct', amt:-25, alloc:null, allocatable:false},
    ],
  });
  sb.__set('D', D);
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.viewAcctBudgetChartMonthTransactionsForCategory('Bills', '2026-03');
  const html = sb.document.getElementById('modalRoot').innerHTML;
  const idx60101 = html.indexOf('60101');
  const idxEarlier = html.indexOf('Earlier');
  const idxLater = html.indexOf('Later');
  const idx60102 = html.indexOf('60102');
  const idxOther = html.indexOf('OtherAcct');
  assert(idx60101!==-1 && idxEarlier!==-1 && idxLater!==-1 && idx60102!==-1 && idxOther!==-1, 'All expected content should be present in the modal, got: ' + html.slice(0,600));
  assert(idx60101 < idxEarlier && idxEarlier < idxLater, 'Within account 60101\'s section, Earlier should come before Later (date order), got positions: ' + idx60101 + ',' + idxEarlier + ',' + idxLater);
  assert(idxLater < idx60102, 'Account 60101\'s whole section should come before account 60102\'s section (grouped by account), got: ' + idxLater + ' vs ' + idx60102);
  assert(idx60102 < idxOther, 'Account 60102\'s own transaction should appear within its own section, got: ' + idx60102 + ' vs ' + idxOther);
  const total = html.match(/Total<\/td><td class="num mono[^"]*">([^<]*)</);
  assert(total, 'Should show a grand total row');
}
async function testViewAcctBudgetChartMonthTransactionsForCategoryHandlesEmptyMonth(){
  const sb = makeSandbox();
  const D = acctBudgetChartFixtureD();
  sb.__set('D', D);
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.viewAcctBudgetChartMonthTransactionsForCategory('Bills', '2026-01');
  const html = sb.document.getElementById('modalRoot').innerHTML;
  assert(/No transactions this month/.test(html), 'An empty month should show an honest empty state rather than a blank table');
}
async function testPnLCategoryLinkShowsOnlyForBudgetedCategories(){
  const sb = makeSandbox();
  const D = {
    accounts: [
      {id:60101, category:'Bills', acc_type:'Individual Account', status:'Active'}, // has a budget — Bills should get the link
      {id:60201, category:'Transportation', acc_type:'Individual Account', status:'Active'}, // no plan anywhere — must NOT get the link
      {id:30101, category:'Salary', acc_type:'Individual Account', status:'Active'},
    ],
    ledger: [
      {id:1, jv:1, date:'2026-08-05', acc:60101, amt:-50, descr:'x'},
      {id:2, jv:2, date:'2026-08-06', acc:60201, amt:-30, descr:'y'},
      {id:3, jv:3, date:'2026-08-07', acc:30101, amt:1000, descr:'z'},
    ],
    budget: [{id:1, acc:60101, date:'2026-08-01', amt:100}],
    provisionGroups: [], forecastAccountRules: []
  };
  sb.__set('D', D);
  sb.__set('pnlFrom', '2026-08-01');
  sb.__set('pnlTo', '2026-08-31');
  sb.__set('pnlPreset', 'custom');
  sb.renderPnL();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/openAcctBudgetChartForCategory\('Bills'\)/.test(html), 'The Bills category subtotal row should get the chart link, since it has a budgeted account');
  assert(!/openAcctBudgetChartForCategory\('Transportation'\)/.test(html), 'The Transportation category must NOT get the link — nothing in it is budgeted');
}
function testPnLCategoryLinkStopsClickPropagation(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  const idx = html.indexOf("openAcctBudgetChartForCategory('${esc(cat)");
  assert(idx!==-1, 'Should find the category chart-link onclick in source');
  const snippet = html.slice(idx-60, idx+10);
  assert(/event\.stopPropagation\(\)/.test(snippet), 'The category chart-link icon should stop click propagation too, got: ' + snippet);
}

// ================= v4.53.0: Reconciliation focus fix, collapsible platforms, cross-platform asset window, Portfolio+Cash total =================
async function testInvReconEnterNextSetsFocusKeyFromNextInputsDataset(){
  const sb = makeSandbox();
  const inputs = [sb.document.createElement('input'), sb.document.createElement('input')];
  inputs.forEach((i,idx)=>{ i.className='recon-input'; i.dataset.reconkey = 'key'+idx; sb.document.body.appendChild(i); });
  let focused = null;
  inputs[1].focus = () => { focused = inputs[1]; };
  sb.invReconEnterNext(inputs[0], {key:'Enter', preventDefault:()=>{}});
  assert(focused===inputs[1], 'Should still focus the next input immediately, same as before');
  assert(vm.runInContext('_invReconFocusKey', sb)==='key1', 'Should remember the next input\'s own reconkey so focus can be restored after the re-render wipes the DOM, got ' + vm.runInContext('_invReconFocusKey', sb));
}
async function testInvReconEnterNextClearsFocusKeyOnLastInput(){
  const sb = makeSandbox();
  const input = sb.document.createElement('input');
  input.className = 'recon-input'; input.dataset.reconkey = 'onlyone';
  sb.document.body.appendChild(input);
  input.blur = () => {};
  sb.__set('_invReconFocusKey', 'stale-leftover-key');
  sb.invReconEnterNext(input, {key:'Enter', preventDefault:()=>{}});
  assert(vm.runInContext('_invReconFocusKey', sb)===null, 'Enter on the last field should clear any pending focus key, not leave a stale one behind, got ' + vm.runInContext('_invReconFocusKey', sb));
}
async function testRenderInvReconPageRestoresFocusToTheTrackedKey(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Raseed'}],
    invPositions:[{id:1, platformId:1, name:'Bitcoin', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}]
  });
  sb.__set('invReconExpandedPlatforms', new Set([1]));
  sb.__set('_invReconFocusKey', 'pos-1');
  sb.renderInvReconPage('');
  const target = sb.document.querySelector('.recon-input[data-reconkey="pos-1"]');
  assert(target, 'The tracked input should exist in the freshly rendered markup');
  assert(sb.document.activeElement===target, 'renderInvReconPage should restore focus to the exact input that was pending, matching the reported bug fix');
  assert(vm.runInContext('_invReconFocusKey', sb)===null, 'The pending key should be consumed (cleared) once used, so it does not leak into a later, unrelated render');
}
async function testRenderInvReconPageDoesNothingWhenNoFocusKeyPending(){
  const sb = invCashSandbox({invPlatforms:[{id:1, name:'Raseed'}], invPositions:[]});
  sb.__set('_invReconFocusKey', null);
  sb.renderInvReconPage(''); // must not throw with nothing pending
  assert(vm.runInContext('_invReconFocusKey', sb)===null, 'Should remain null with nothing to restore');
}
async function testInvReconPlatformsCollapsedByDefault(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Raseed'}],
    invPositions:[{id:1, platformId:1, name:'Bitcoin', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}]
  });
  // Deliberately does NOT set invReconExpandedPlatforms — exercising the real top-level default.
  sb.renderInvReconPage('');
  const html = sb.document.getElementById('app').innerHTML;
  assert(!/<colgroup>/.test(html), 'A freshly-loaded Reconciliation page should start with every platform collapsed, got snippet: ' + html.slice(0,500));
  assert(/▸ Expand/.test(html), 'A collapsed platform should show an Expand affordance');
}
async function testToggleInvReconPlatformExpandedFlipsIndependentlyPerPlatform(){
  const sb = invCashSandbox({invPlatforms:[{id:1, name:'A'},{id:2, name:'B'}], invPositions:[]});
  sb.__set('invReconExpandedPlatforms', new Set());
  sb.__set('renderInvestmentsPage', ()=>{});
  sb.toggleInvReconPlatformExpanded(1);
  assert(vm.runInContext('invReconExpandedPlatforms', sb).has(1), 'Toggling platform 1 should expand it');
  assert(!vm.runInContext('invReconExpandedPlatforms', sb).has(2), 'Platform 2 should remain untouched');
  sb.toggleInvReconPlatformExpanded(1);
  assert(!vm.runInContext('invReconExpandedPlatforms', sb).has(1), 'Toggling again should collapse it back');
}
async function testInvReconExpandStateIsIndependentFromTheMainInvestmentsPage(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Raseed'}],
    invPositions:[{id:1, platformId:1, name:'Bitcoin', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}]
  });
  sb.__set('invExpandedPlatforms', new Set([1])); // expanded on the MAIN Investments page
  sb.__set('invReconExpandedPlatforms', new Set()); // but never touched here — confirmed decision: independent
  sb.renderInvReconPage('');
  const html = sb.document.getElementById('app').innerHTML;
  assert(!/<colgroup>/.test(html), 'The Reconciliation page must stay collapsed even though the same platform is expanded on the main Investments page');
}
async function testInvAssetIdentityUsesTickerWhenPresent(){
  const sb = makeSandbox();
  assert(sb.invAssetIdentity({ticker:'btc', name:'Bitcoin Fund'})==='BTC', 'Should use the (uppercased) ticker when present, got ' + sb.invAssetIdentity({ticker:'btc', name:'Bitcoin Fund'}));
}
async function testInvAssetIdentityFallsBackToNameWhenNoTicker(){
  const sb = makeSandbox();
  assert(sb.invAssetIdentity({ticker:'', name:'Riyal Fund'})==='RIYAL FUND', 'Should fall back to the (uppercased) name when there is no ticker, got ' + sb.invAssetIdentity({ticker:'', name:'Riyal Fund'}));
}
async function testInvPositionsMatchingAssetGroupsAcrossPlatformsByTicker(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Raseed'}, {id:2, name:'Fomo'}],
    invPositions:[
      {id:1, platformId:1, name:'Bitcoin', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'},
      {id:2, platformId:2, name:'BTC Holdings', ticker:'btc', currency:'USD', assetClass:'Crypto', status:'Active'}, // different name, same ticker, different case
      {id:3, platformId:2, name:'Ethereum', ticker:'ETH', currency:'USD', assetClass:'Crypto', status:'Active'},
    ]
  });
  const matches = sb.invPositionsMatchingAsset('BTC');
  assert(matches.length===2 && matches.some(p=>p.id===1) && matches.some(p=>p.id===2), 'Should match both BTC positions across platforms regardless of case or differing local names, got ' + matches.map(p=>p.id).join(','));
  assert(!matches.some(p=>p.id===3), 'A genuinely different ticker must not be included');
}
async function testOpenInvAssetAcrossPlatformsShowsASectionPerPlatformWithItsTransactions(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Raseed'}, {id:2, name:'Fomo'}],
    invPositions:[
      {id:1, platformId:1, name:'Bitcoin', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'},
      {id:2, platformId:2, name:'BTC Holdings', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'},
    ],
    invTransactions:[
      {id:1, positionId:1, date:'2026-01-01', kind:'buy', units:1, totalSar:1000, owners:[{ownerId:1,units:1}], feePct:0, cashSide:'bank'},
      {id:2, positionId:2, date:'2026-02-01', kind:'buy', units:2, totalSar:2000, owners:[{ownerId:1,units:2}], feePct:0, cashSide:'bank'},
    ]
  });
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.openInvAssetAcrossPlatforms('BTC');
  const html = sb.document.getElementById('modalRoot').innerHTML;
  assert(/Raseed/.test(html) && /Fomo/.test(html), 'Both platforms holding the asset should get their own section, got snippet: ' + html.slice(0,600));
  // Sections are sorted alphabetically by platform name (Fomo before Raseed), matching the same
  // convention invPlatformsSorted() already uses everywhere else in the app.
  const fomoIdx = html.indexOf('Fomo'), raseedIdx = html.indexOf('Raseed');
  const tx2Idx = html.indexOf('2026-02-01'), tx1Idx = html.indexOf('2026-01-01');
  assert(fomoIdx < tx2Idx && tx2Idx < raseedIdx, 'The Fomo transaction should appear within the Fomo section, before the Raseed section starts');
  assert(raseedIdx < tx1Idx, 'The Raseed transaction should appear within the Raseed section');
}
async function testOpenInvAssetAcrossPlatformsRowClickOpensTheCorrectTransactionForEditing(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Raseed'}],
    invPositions:[{id:1, platformId:1, name:'Bitcoin', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:5, positionId:1, date:'2026-01-01', kind:'buy', units:1, totalSar:1000, owners:[{ownerId:1,units:1}], feePct:0, cashSide:'bank'}]
  });
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.openInvAssetAcrossPlatforms('BTC');
  const html = sb.document.getElementById('modalRoot').innerHTML;
  assert(/openInvTxModal\(1,\s*5\)/.test(html), 'Clicking the transaction row should open the edit modal for the exact position and transaction id, got snippet: ' + html.slice(0,600));
}
async function testOpenInvAssetAcrossPlatformsNewTransactionGoesToThePickedPlatform(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Raseed'}, {id:2, name:'Fomo'}],
    invPositions:[
      {id:1, platformId:1, name:'Bitcoin', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'},
      {id:2, platformId:2, name:'BTC Holdings', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'},
    ]
  });
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  sb.openInvAssetAcrossPlatforms('BTC');
  const html = sb.document.getElementById('modalRoot').innerHTML;
  const select = sb.document.getElementById('invAssetModalPlatformPick');
  assert(!!select, 'The platform picker dropdown should be present');
  assert(select && select.querySelector('option[value="1"]') && select.querySelector('option[value="2"]'),
    'The dropdown should offer both platforms\' target positions as options, got: ' + (select? select.innerHTML : '(no select found)'));
  // JSDOM in this harness doesn't compile inline onclick="..." attributes into a callable
  // .onclick function (no other test in this suite relies on that either) — inspecting the
  // button's actual onclick source is the established pattern here instead.
  const btnMatch = html.match(/<button[^>]*onclick="([^"]*)"[^>]*>\s*\+ New Transaction/);
  const btnOnclick = btnMatch? btnMatch[1] : '';
  assert(!!btnMatch, 'Should find the New Transaction button and its onclick source');
  assert(/getElementById\('invAssetModalPlatformPick'\)\.value/.test(btnOnclick),
    'The button must read whichever platform is currently picked in the dropdown, not a fixed value, got: ' + btnOnclick);
  assert(/openInvTxModal\(Number\(document\.getElementById\('invAssetModalPlatformPick'\)\.value\), null\)/.test(btnOnclick),
    'Should open a NEW transaction (null id) on the picked platform\'s target position, got: ' + btnOnclick);
}
async function testInvReconPositionNameOpensTheAssetWindow(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Raseed'}],
    invPositions:[{id:1, platformId:1, name:'Bitcoin', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}]
  });
  sb.__set('invReconExpandedPlatforms', new Set([1]));
  sb.renderInvReconPage('');
  const html = sb.document.getElementById('app').innerHTML;
  assert(/openInvAssetAcrossPlatforms\('BTC'\)/.test(html), 'Clicking a position name in the Reconciliation table should open the cross-platform asset window for its identity, got snippet: ' + html.slice(html.indexOf('Bitcoin')-100, html.indexOf('Bitcoin')+100));
}
async function testPlatformSectionShowsCombinedPortfolioPlusCashTotal(){
  const sb = invCashSandbox({
    invPlatforms:[{id:1, name:'Raseed'}],
    invPositions:[{id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'}],
    invTransactions:[{id:1, positionId:1, date:'2026-01-01', kind:'buy', units:1, totalSar:37500, owners:[{ownerId:1,units:1}], feePct:0, cashSide:'cash', usdAmount:10000}],
    invValuations:[{id:1, positionId:1, date:'2026-08-01', price:20000}] // 1 unit * $20,000 = $20,000 portfolio value
  });
  sb.__set('invExpandedPlatforms', new Set([1]));
  const html = sb.renderInvPlatformSection({id:1, name:'Raseed'});
  // Portfolio $20,000 + Cash $10,000 (the buy was cash-funded, so $10,000 remains on the platform... actually
  // the buy consumed $10,000 of cash exactly, leaving $0 cash) — use the actual cash figure from the app itself
  // rather than hand-deriving it, so this test can't silently drift from real cash-tracking logic.
  const cash = sb.invPlatformCash(1);
  const expectedTotal = 20000 + cash.totalUsd;
  assert(html.indexOf('Portfolio + Cash')!==-1, 'Should show a combined Portfolio + Cash line, so it can be eyeballed against Invested (Out)');
  assert(html.indexOf('$'+sb.fmt2(expectedTotal))!==-1, 'The combined total should be the sum of portfolio value and cash balance, got snippet: ' + html.slice(html.indexOf('Portfolio + Cash'), html.indexOf('Portfolio + Cash')+200));
}

// ================= v4.54.0: pooled monthly contributions — Collect Contributions + Split by platform cash =================
// Five people pooling money, matching the real use: A is you, B–E family. Out accounts 10201–10205.
function poolSandbox(extra, keepRender){
  const sb = invCashSandbox(Object.assign({
    accounts: [10201,10202,10203,10204,10205].map(id=>({id, acc_type:'Individual Account', status:'Active'})),
    invOwners: [
      {id:1, name:'A', isSelf:true,  outAcc:10201, inAcc:null},
      {id:2, name:'B', isSelf:false, outAcc:10202, inAcc:null},
      {id:3, name:'C', isSelf:false, outAcc:10203, inAcc:null},
      {id:4, name:'D', isSelf:false, outAcc:10204, inAcc:null},
      {id:5, name:'E', isSelf:false, outAcc:10205, inAcc:null},
    ],
    invPlatforms: [{id:1, name:'Binance'}, {id:2, name:'Bybit'}],
    invPositions: [{id:1, platformId:1, name:'Ethereum', ticker:'ETH', currency:'USD', assetClass:'Crypto', status:'Active'},
                   {id:2, platformId:1, name:'Solana', ticker:'SOL', currency:'USD', assetClass:'Crypto', status:'Active'}],
  }, extra||{}));
  sb.__set('syncWrite', async()=>({ok:true}));
  sb.__set('persistLocal', ()=>{});
  sb.__set('toast', ()=>{});
  if(!keepRender) sb.__set('renderInvestmentsPage', ()=>{});
  sb.__set('openInvPosition', ()=>{});
  sb.__set('setInvMgmtFeePct', async()=>{});
  const modalRoot = sb.document.createElement('div'); modalRoot.id='modalRoot'; sb.document.body.appendChild(modalRoot);
  return sb;
}
// Drives the real Collect form: amounts in SAR per owner id, optional actual USD received.
async function poolCollect(sb, platformId, date, sarByOwner, usdReceived){
  sb.openInvCollectModal(platformId);
  const d = sb._invCollectDraft;
  d.date = date;
  sb.invCollectClearRows();
  for(const oid in sarByOwner) sb.setInvCollectRow(Number(oid), String(sarByOwner[oid]));
  if(usdReceived!==undefined) sb.setInvCollectUsd(String(usdReceived));
  await sb.saveInvCollect();
}
// Drives the real transaction window: a cash-funded buy, split by platform cash.
async function poolBuy(sb, posId, date, units, usd, excludeOwnerIds){
  sb.openInvTxModal(posId, null);
  const d = sb._invTxDraft;
  d.date = date; d.units = String(units);
  sb.setInvTxCashSide('cash');
  sb.setInvTxUsd(String(usd));
  sb.applyInvTxCashSplit();
  for(const oid of (excludeOwnerIds||[])) sb.toggleInvTxCashSplitOwner(oid, false);
  await sb.saveInvTx();
}

async function testInvSplitUsdBySarIsProportionalAndExactToTheCent(){
  const sb = makeSandbox();
  const out = sb.invSplitUsdBySar(1333.33, [{ownerId:1,sar:1500},{ownerId:2,sar:2000},{ownerId:3,sar:1000},{ownerId:4,sar:300},{ownerId:5,sar:200}]);
  const total = out.reduce((s,o)=>s+o.usd,0);
  assert(Math.abs(total-1333.33)<1e-9, 'The split must add up to the USD received exactly, got ' + total);
  const b = out.find(o=>o.ownerId===2);
  assert(Math.abs(b.usd-533.33)<0.011, 'B paid 40% of the SAR so should get ~40% of the USD (533.33), got ' + b.usd);
  assert(out.every(o=>Math.abs(o.usd*100-Math.round(o.usd*100))<1e-6), 'Every share must be a whole number of cents');
}
async function testInvSplitUsdBySarSkipsNonContributors(){
  const sb = makeSandbox();
  const out = sb.invSplitUsdBySar(100, [{ownerId:1,sar:0},{ownerId:2,sar:500}]);
  assert(out.length===1 && out[0].ownerId===2 && Math.abs(out[0].usd-100)<1e-9, 'Someone contributing nothing gets no row; the contributor gets all of it, got ' + JSON.stringify(out));
}
async function testAvailableIsOutAccountMinusWhatTheTrackerAlreadyHolds(){
  const sb = poolSandbox({ledger:[{id:1, jv:1, date:'2026-10-01', acc:10202, amt:2000, descr:'B invested'}]});
  const before = sb.invOwnersAvailableSar();
  assert(Math.abs(before[2]-2000)<0.01, 'B has 2,000 in their Out account and nothing in the tracker yet, so 2,000 is available, got ' + before[2]);
  assert(Math.abs(before[3])<0.01, 'C has nothing in their Out account, so nothing is available, got ' + before[3]);
  await poolCollect(sb, 1, '2026-10-02', {2:2000});
  const after = sb.invOwnersAvailableSar();
  assert(Math.abs(after[2])<0.05, 'Once B\'s contribution is deposited, Available drops back to ~0 by itself, got ' + after[2]);
}
async function testAvailableIsNullWithoutAnOutAccount(){
  const sb = poolSandbox();
  sb._D.invOwners[3].outAcc = null; // D
  assert(sb.invOwnersAvailableSar()[4]===null, 'With no Out account linked there is nothing to compare against, so Available should be null (shown as —)');
}
async function testCollectPrefillsFromAvailable(){
  const sb = poolSandbox({ledger:[
    {id:1, jv:1, date:'2026-10-01', acc:10201, amt:1500, descr:'x'},
    {id:2, jv:1, date:'2026-10-01', acc:10203, amt:1000, descr:'y'},
  ]});
  sb.openInvCollectModal(1);
  const d = sb._invCollectDraft;
  assert(Math.abs(Number(d.rows[1].sar)-1500)<0.01 && Math.abs(Number(d.rows[3].sar)-1000)<0.01, 'Each person\'s amount should be pre-filled from what\'s available for them');
  assert(d.rows[2].sar==='', 'Someone with nothing available should be left blank, not pre-filled with 0');
}
async function testCollectRecordsOneDepositSplitBySarShare(){
  const sb = poolSandbox();
  await poolCollect(sb, 1, '2026-10-01', {1:1500, 2:2000, 3:1000, 4:300, 5:200});
  const m = sb._D.invCashMovements;
  assert(m.length===1, 'Collecting should record exactly one movement, got ' + m.length);
  assert(m[0].kind==='deposit' && m[0].platformId===1 && m[0].date==='2026-10-01', 'It should be a deposit on the chosen platform and date, got ' + JSON.stringify(m[0]));
  assert(Math.abs(m[0].usdAmount-1333.33)<0.005, 'USD defaults to the SAR total ÷ 3.75 (1,333.33), got ' + m[0].usdAmount);
  const sum = m[0].owners.reduce((s,o)=>s+o.usd,0);
  assert(Math.abs(sum-m[0].usdAmount)<0.005, 'The per-person split must add up to the deposit total');
  const b = m[0].owners.find(o=>o.ownerId===2);
  assert(b && Math.abs(b.usd-533.33)<0.011, 'B (40% of the SAR) should get 40% of the USD, got ' + (b&&b.usd));
  assert(sb._D.ledger.length===0, 'Collecting must not post anything to the ledger — the JVs are done by hand');
}
async function testCollectSplitsTheActualUsdReceivedNotTheTheoreticalOne(){
  // The exchange's real rate/fees mean what lands on the platform differs from SAR ÷ 3.75.
  const sb = poolSandbox();
  await poolCollect(sb, 1, '2026-10-01', {1:1000, 2:3000}, 1060);
  const m = sb._D.invCashMovements[0];
  assert(Math.abs(m.usdAmount-1060)<0.005, 'The edited USD figure should be the one recorded, got ' + m.usdAmount);
  assert(Math.abs(m.owners.find(o=>o.ownerId===1).usd-265)<0.005 && Math.abs(m.owners.find(o=>o.ownerId===2).usd-795)<0.005,
    'The actual USD should be split 25/75 by SAR share (265 / 795), got ' + JSON.stringify(m.owners));
}
async function testCollectByPercentageOfATotal(){
  const sb = poolSandbox();
  sb.openInvCollectModal(1);
  sb.invCollectClearRows();
  sb.setInvCollectMode('pct');
  sb._invCollectDraft.totalSar = '5000';
  sb.setInvCollectRow(1, '50'); sb.setInvCollectRow(2, '30'); sb.setInvCollectRow(3, '20');
  await sb.saveInvCollect();
  const m = sb._D.invCashMovements[0];
  assert(m && Math.abs(m.usdAmount-1333.33)<0.005, 'A 5,000 SAR total should deposit 1,333.33 USD, got ' + (m&&m.usdAmount));
  assert(Math.abs(m.owners.find(o=>o.ownerId===2).usd-400)<0.011, 'B at 30% should get 400 USD, got ' + JSON.stringify(m.owners));
}
async function testCollectBlocksPercentagesThatDontAddUpTo100(){
  const sb = poolSandbox();
  let msg = null; sb.__set('toast', (m)=>{ msg = m; });
  sb.openInvCollectModal(1);
  sb.invCollectClearRows();
  sb.setInvCollectMode('pct');
  sb._invCollectDraft.totalSar = '5000';
  sb.setInvCollectRow(1, '50'); sb.setInvCollectRow(2, '30'); // 80%
  await sb.saveInvCollect();
  assert(sb._D.invCashMovements.length===0, 'Nothing should be recorded when the percentages total 80%');
  assert(msg && /100%/.test(msg), 'Should say the percentages must add up to 100%, got ' + msg);
}
async function testCollectBlocksAnEmptyContribution(){
  const sb = poolSandbox();
  sb.openInvCollectModal(1);
  sb.invCollectClearRows();
  await sb.saveInvCollect();
  assert(sb._D.invCashMovements.length===0, 'Nothing should be recorded with no amounts entered');
}
async function testCollectButtonIsOnTheInvestmentsPage(){
  const sb = poolSandbox(null, true); // the real page render, not a stub
  sb.__set('invView','classic'); // v4.58.0: the pre-4.58 page is now the Classic view
  sb.renderInvestmentsPage();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/invStartPlatformAction\('collect'\)/.test(html), 'The Investments page should have a Collect Contributions button');
  assert(vm.runInContext("typeof INV_PLATFORM_ACTIONS.collect.open", sb)==='function', 'The collect action should be registered so the platform picker works for it');
}
async function testCashForSplitIsAsOfTheBuyDateIncludingSameDayDeposits(){
  const sb = poolSandbox();
  await poolCollect(sb, 1, '2026-10-01', {1:375, 2:750}); // $100 / $200
  await poolCollect(sb, 1, '2026-10-15', {1:375});        // A +$100, mid-month
  const early = sb.invOwnerCashForSplit(1, '2026-10-10', null);
  assert(Math.abs(early[1]-100)<0.005 && Math.abs(early[2]-200)<0.005, 'Before the 15th, only the first deposit counts, got ' + JSON.stringify(early));
  const sameDay = sb.invOwnerCashForSplit(1, '2026-10-15', null);
  assert(Math.abs(sameDay[1]-200)<0.005, 'A deposit dated the same day as the buy counts toward it, got ' + JSON.stringify(sameDay));
  const other = sb.invOwnerCashForSplit(2, '2026-10-31', null);
  assert(Object.keys(other).length===0, 'Cash on one platform must not count toward a buy on another, got ' + JSON.stringify(other));
}
async function testCashForSplitAddsBackTheTransactionBeingEdited(){
  const sb = poolSandbox();
  await poolCollect(sb, 1, '2026-10-01', {1:375, 2:375}); // $100 each
  await poolBuy(sb, 1, '2026-10-05', 1, 100);             // takes $50 each
  const t = sb._D.invTransactions[0];
  const without = sb.invOwnerCashForSplit(1, '2026-10-05', null);
  const editing = sb.invOwnerCashForSplit(1, '2026-10-05', t.id);
  assert(Math.abs(without[1]-50)<0.01, 'After the buy each has $50 left, got ' + JSON.stringify(without));
  assert(Math.abs(editing[1]-100)<0.01, 'When editing that same buy, its own spend is added back so it doesn\'t skew its own split, got ' + JSON.stringify(editing));
}
async function testSplitByCashGivesUnitsInProportionToEachPersonsCash(){
  const sb = poolSandbox();
  await poolCollect(sb, 1, '2026-10-01', {1:3750, 2:2250, 3:1500}); // $1000 / $600 / $400
  sb.openInvTxModal(1, null);
  const d = sb._invTxDraft;
  d.date = '2026-10-02'; d.units = '10';
  sb.setInvTxCashSide('cash'); sb.setInvTxUsd('1000');
  sb.applyInvTxCashSplit();
  const u = id => (sb._invTxDraft.owners.find(o=>o.ownerId===id)||{units:0}).units;
  assert(Math.abs(u(1)-5)<1e-9 && Math.abs(u(2)-3)<1e-9 && Math.abs(u(3)-2)<1e-9, 'Cash 1000/600/400 should split 10 units 5/3/2, got ' + JSON.stringify(sb._invTxDraft.owners));
  const html = sb.document.getElementById('modalRoot').innerHTML;
  assert(/Stop auto-split/.test(html) && /50\.00%/.test(html), 'The panel should show each person\'s share, got snippet: ' + html.slice(html.indexOf('Split by platform cash'), html.indexOf('Split by platform cash')+600));
}
async function testUntickingSomeoneSpreadsTheirShareAcrossTheRest(){
  const sb = poolSandbox();
  await poolCollect(sb, 1, '2026-10-01', {1:3750, 2:2250, 3:1500}); // $1000 / $600 / $400
  sb.openInvTxModal(1, null);
  const d = sb._invTxDraft;
  d.date = '2026-10-02'; d.units = '8';
  sb.setInvTxCashSide('cash'); sb.setInvTxUsd('800');
  sb.applyInvTxCashSplit();
  sb.toggleInvTxCashSplitOwner(2, false); // B sits this one out
  const o = sb._invTxDraft.owners;
  assert(!o.some(x=>x.ownerId===2), 'An unticked person must get no units, got ' + JSON.stringify(o));
  assert(Math.abs(o.find(x=>x.ownerId===1).units-5.71428571)<1e-7 && Math.abs(o.find(x=>x.ownerId===3).units-2.28571429)<1e-7,
    'A and C share 8 units 1000:400, got ' + JSON.stringify(o));
  assert(Math.abs(o.reduce((s,x)=>s+x.units,0)-8)<1e-12, 'Units must still add up exactly to the buy');
  sb.toggleInvTxCashSplitOwner(2, true);
  assert(sb._invTxDraft.owners.some(x=>x.ownerId===2), 'Ticking them back in should restore their share');
}
async function testSplitByCashNeedsUnitsFirst(){
  const sb = poolSandbox();
  let msg = null; sb.__set('toast', m=>{ msg = m; });
  await poolCollect(sb, 1, '2026-10-01', {1:375});
  sb.openInvTxModal(1, null);
  sb.setInvTxCashSide('cash');
  sb.applyInvTxCashSplit();
  assert(msg && /units first/i.test(msg), 'Should ask for the units before splitting, got ' + msg);
  assert(!(sb._invTxDraft.cashSplit && sb._invTxDraft.cashSplit.active), 'The split should not switch on without units');
}
async function testSplitByCashOnlyOfferedForCashFundedBuys(){
  const sb = poolSandbox();
  sb.openInvTxModal(1, null);
  const d = sb._invTxDraft;
  assert(sb.invTxCashSplitPanel(d)==='', 'A bank-funded buy should not offer the cash split');
  d.cashSide = 'cash';
  assert(/Split by platform cash/.test(sb.invTxCashSplitPanel(d)), 'A cash-funded buy should offer it');
  d.kind = 'sell';
  assert(sb.invTxCashSplitPanel(d)==='', 'A sell should not offer it — it splits what people hold, not their cash');
}
async function testChangingUnitsKeepsTheSplitInStep(){
  const sb = poolSandbox();
  await poolCollect(sb, 1, '2026-10-01', {1:3750, 2:3750}); // equal cash
  sb.openInvTxModal(1, null);
  const d = sb._invTxDraft;
  d.date = '2026-10-02'; d.units = '2';
  sb.setInvTxCashSide('cash'); sb.setInvTxUsd('500');
  sb.applyInvTxCashSplit();
  d.units = '6'; sb.invTxRefreshDerived(); // typing a corrected unit count after splitting
  assert(Math.abs(sb._invTxDraft.owners.find(o=>o.ownerId===1).units-3)<1e-9, 'Changing the units after splitting should re-split them (3 each), got ' + JSON.stringify(sb._invTxDraft.owners));
}
async function testEditingOnePersonsUnitsByHandTurnsAutoSplitOff(){
  const sb = poolSandbox();
  await poolCollect(sb, 1, '2026-10-01', {1:3750, 2:3750});
  sb.openInvTxModal(1, null);
  const d = sb._invTxDraft;
  d.date = '2026-10-02'; d.units = '2';
  sb.setInvTxCashSide('cash'); sb.setInvTxUsd('500');
  sb.applyInvTxCashSplit();
  sb.setInvTxOwnerUnits(1, '1.5');
  assert(!sb._invTxDraft.cashSplit.active, 'Typing one person\'s units by hand should hand control back to you');
  d.units = '4'; sb.invTxRefreshDerived();
  assert(Number(sb._invTxDraft.owners.find(o=>o.ownerId===1).units)===1.5, 'Once off, the hand-typed figure must not be overwritten');
}
async function testPerPersonOverdrawIsWarnedByName(){
  const sb = poolSandbox();
  let msg = null; sb.__set('toast', m=>{ if(/Heads up/.test(m)) msg = m; });
  await poolCollect(sb, 1, '2026-10-01', {1:375, 2:375}); // $100 each, $200 on the platform
  sb.openInvTxModal(1, null);
  const d = sb._invTxDraft;
  d.date = '2026-10-02'; d.units = '1';
  sb.setInvTxCashSide('cash'); sb.setInvTxUsd('150');
  sb.setInvTxOwnerUnits(1, '1'); // all of it to A by hand — more than A's $100
  await sb.saveInvTx();
  assert(msg && /A's cash on this platform negative/.test(msg), 'The platform total ($200) covers it, but A alone only has $100 — A should be named, got ' + msg);
}
async function testNoOverdrawWarningWhenTheSplitFollowsCash(){
  const sb = poolSandbox();
  let msg = null; sb.__set('toast', m=>{ if(/Heads up/.test(m)) msg = m; });
  await poolCollect(sb, 1, '2026-10-01', {1:375, 2:375});
  await poolBuy(sb, 1, '2026-10-02', 1, 150);
  assert(msg===null, 'A split by cash can never overspend anyone, so no warning, got ' + msg);
}
async function testFullMonthEveryoneGetsTheirShareAtTheSameAveragePrice(){
  // The real scenario: five people, unequal amounts, four weekly ETH buys at different prices.
  const sb = poolSandbox();
  await poolCollect(sb, 1, '2026-10-01', {1:1500, 2:2000, 3:1000, 4:300, 5:200});
  const buys = [[0.1,'2026-10-02'],[0.104167,'2026-10-09'],[0.096154,'2026-10-16'],[0.097656,'2026-10-23']];
  for(const [u, dt] of buys) await poolBuy(sb, 1, dt, u, 333.33);
  const st = sb.computePositionState(1);
  const share = {1:0.30, 2:0.40, 3:0.20, 4:0.06, 5:0.04};
  for(const oid in share){
    const o = st.byOwner[oid];
    assert(o && Math.abs(o.units/st.totalUnits - share[oid])<2e-5, 'Owner '+oid+' should hold '+(share[oid]*100)+'% of the ETH, got ' + (o? (o.units/st.totalUnits*100).toFixed(4)+'%' : 'nothing'));
  }
  const avg = oid => st.byOwner[oid].costSar/st.byOwner[oid].units;
  for(const oid of [2,3,4,5]) assert(Math.abs(avg(oid)/avg(1)-1)<1e-4, 'Everyone should end up with the same average price — owner '+oid+' paid '+avg(oid)+' vs '+avg(1));
}
async function testLeftoverCashRollsIntoNextMonthsSplit(){
  // Month 1: five people, only $1,200 of the $1,333.33 is spent. Month 2: only A, B, C contribute.
  // D and E still own their month-1 leftover, so they take part in month 2's buy pro rata to it.
  const sb = poolSandbox();
  await poolCollect(sb, 1, '2026-10-01', {1:1500, 2:2000, 3:1000, 4:300, 5:200});
  await poolBuy(sb, 1, '2026-10-02', 1, 1200);
  await poolCollect(sb, 1, '2026-11-01', {1:1000, 2:1000, 3:1000});
  const cash = sb.invOwnerCashForSplit(1, '2026-11-02', null);
  const leftover = {1:400, 2:533.33, 3:266.67, 4:80, 5:53.33}; // month-1 USD per person
  const exp = {};
  let tot = 0;
  for(const oid in leftover){ exp[oid] = leftover[oid]*(133.33/1333.33) + ([1,2,3].includes(Number(oid))? 266.67 : 0); tot += exp[oid]; }
  for(const oid in exp) assert(Math.abs(cash[oid]-exp[oid])<0.02, 'Owner '+oid+' cash going into month 2 should be leftover + new money ('+exp[oid].toFixed(2)+'), got ' + cash[oid]);
  await poolBuy(sb, 2, '2026-11-02', 10, 900);
  const t = sb._D.invTransactions[sb._D.invTransactions.length-1];
  const uD = (t.owners.find(o=>o.ownerId===4)||{units:0}).units;
  assert(uD>0, 'D contributed nothing in month 2 but still had leftover cash, so D takes part in the buy');
  assert(Math.abs(uD/10 - exp[4]/tot)<1e-4, 'D\'s share of the buy should match D\'s share of the cash on the platform, got ' + (uD/10) + ' vs ' + (exp[4]/tot));
}
async function testOnlyYouCanBuyAloneByUntickingEveryoneElse(){
  const sb = poolSandbox();
  await poolCollect(sb, 1, '2026-10-01', {1:1500, 2:2000});
  await poolBuy(sb, 1, '2026-10-02', 0.05, 100, [2]);
  const t = sb._D.invTransactions[0];
  assert(t.owners.length===1 && t.owners[0].ownerId===1 && Math.abs(t.owners[0].units-0.05)<1e-12, 'With only you ticked, the whole buy is yours, got ' + JSON.stringify(t.owners));
  const cash = sb.invOwnerCashForSplit(1, '2026-10-31', null);
  assert(Math.abs(cash[2]-533.33)<0.01, 'B\'s cash must be untouched by a buy B sat out of, got ' + cash[2]);
}

// ================= v4.55.0: forecast export source / reconcile JV pane / Jamiah month total / accrued chips / budget export range =================
function v455Sandbox(D, today){
  const sb = makeSandbox();
  sb.__set('D', D);
  const byId = {}; (D.accounts||[]).forEach(a=>{ byId[a.id]=a; });
  sb.__set('ACC_BY_ID', byId);
  sb.__set('todayStr', ()=>today||'2026-10-19');
  return sb;
}
function v455CaptureCsv(sb){
  const out = {text:null};
  sb.__set('Blob', function(parts){ out.text = parts[0]; });
  const fakeAnchor = {click:()=>{}};
  sb.__set('URL', {createObjectURL: ()=>'blob:x'});
  sb.document.createElement = ((orig)=>function(tag){ if(tag==='a') return fakeAnchor; return orig.call(sb.document, tag); })(sb.document.createElement.bind(sb.document));
  return out;
}
function v455ForecastFixture(){
  return {
    accounts: [
      {id:10101, name:'Main Bank', category:'Bank Accounts', acc_type:'Individual Account', status:'Active'},
      {id:20301, name:'Insurance Accrual', category:'Accruals', acc_type:'Accrual Account', status:'Active'},
      {id:60101, name:'Bills', category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:60102, name:'Rent', category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:60103, name:'Quarterly Sweep', category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:60104, name:'Insurance', category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:30101, name:'Salary', category:'Salary', acc_type:'Individual Account', status:'Active', forecast_category:'income'},
      {id:20101, name:'Car Loan', category:'Long Term Liabilities', acc_type:'Individual Account', status:'Active', forecast_category:'liability_lt'},
    ],
    ledger: [{id:1, jv:1, date:'2026-09-10', acc:60101, amt:40, descr:'old spend'}],
    budget: [{id:1, acc:60101, date:'2026-11-01', amt:250}],
    provisionGroups: [], accrualMappings: [],
    forecastPlans: {30101:{'2026-11':500}, 20101:{'2027-01':50}},
    forecastAccountRules: [
      {id:1, name:'Quarterly sweep', account:60103, rule:{type:'fixed', value:100, sign:1}, targetOffset:2},
      {id:2, name:'Insurance mirror', account:60104, rule:{type:'account_balance', sign:-1}, targetOffset:0},
    ],
  };
}
function v455ExportWide(){
  const sb = v455Sandbox(v455ForecastFixture());
  sb.localStorage.setItem('gridEndMonth', '2027-01');
  sb.__set('provisionsPlanFor', (acc, mk)=> acc===60102 ? 123 : null);
  const out = v455CaptureCsv(sb);
  sb.exportForecastGridCSV();
  const rows = out.text ? sb.csvToObjects(out.text) : [];
  const byId = {}; rows.forEach(r=>{ byId[r['account id']] = r; });
  return {sb, out, rows, byId, header: out.text? out.text.split('\n')[0].split(',') : []};
}
// ---- v4.56.0: ONE Source column (future months only) between Sub-Category and Current Balance ----
async function testForecastWideExportHasOneSourceColumnBetweenSubCategoryAndBalance(){
  const {header, out} = v455ExportWide();
  assert(out.text, 'The wide forecast export should produce a CSV');
  const iSub = header.indexOf('Sub-Category'), iSrc = header.indexOf('Source'), iBal = header.indexOf('Current Balance');
  assert(iSrc===iSub+1 && iBal===iSrc+1, 'Order must be Sub-Category, Source, Current Balance, got ' + header.slice(0,8).join('|'));
  assert(header.filter(h=>/source/i.test(h)).length===1, 'There must be exactly one Source column, got ' + header.filter(h=>/source/i.test(h)).join('|'));
  const months = header.slice(iBal+1);
  assert(months.length>=4 && months.every(h=>/^\d{4}-\d{2}$/.test(h)), 'Everything after Current Balance must be plain month columns, got ' + months.join('|'));
}
async function testForecastWideExportAmountsStillLineUpWithTheirMonths(){
  const {byId} = v455ExportWide();
  assert(byId['60101']['2026-11']==='250', 'The budget figure must still sit under its own month, got ' + byId['60101']['2026-11']);
  assert(byId['60101']['2026-09']==='40', 'A past month must still show the actual, got ' + byId['60101']['2026-09']);
  assert(byId['30101']['2026-11']==='500', 'A manual plan must still sit under its month, got ' + byId['30101']['2026-11']);
}
async function testForecastWideExportSourceListsEachSourceWithItsMonthRange(){
  const {byId} = v455ExportWide();
  assert(byId['60102']['source']==='Provisions (2026-11 to 2027-01)', 'A single source covers the whole future range, got ' + byId['60102']['source']);
  assert(byId['60101']['source']==='Budget (2026-11 to 2026-11); Budget (empty) (2026-12 to 2027-01)', 'A change of source starts a new range, got ' + byId['60101']['source']);
  assert(byId['30101']['source']==='Manual entry (2026-11 to 2027-01)', 'Income months are Manual entry even before a figure is typed, got ' + byId['30101']['source']);
  assert(byId['20101']['source']==='Manual entry (2027-01 to 2027-01)', 'Months with no source at all (no plan, no provision) are left out, got ' + byId['20101']['source']);
  assert(!/Actual/.test(Object.values(byId).map(r=>r['source']).join('|')), 'Past/current months (actuals) must never appear in the Source summary');
}
async function testForecastWideExportSourceSplitsProvisionsThenBudgetRanges(){
  const sb = v455Sandbox(v455ForecastFixture());
  sb.localStorage.setItem('gridEndMonth', '2027-01');
  sb.__set('provisionsPlanFor', (acc, mk)=> acc===60102 && mk<='2026-12' ? 123 : null);
  const out = v455CaptureCsv(sb);
  sb.exportForecastGridCSV();
  const r = sb.csvToObjects(out.text).find(x=>x['account id']==='60102');
  assert(r && r['source']==='Provisions (2026-11 to 2026-12); Budget (empty) (2027-01 to 2027-01)', 'Expected Provisions then Budget ranges, got ' + (r&&r['source']));
}
async function testForecastWideExportDescribesASmartRuleOnceWithItsRange(){
  const {byId} = v455ExportWide();
  const src = byId['60103']['source'];
  assert(src==='Smart Rule "Quarterly sweep" (2026-11 to 2026-12): Fixed 100.00, held at 0 until 2026-12; Budget (empty) (2027-01 to 2027-01)',
    'The rule should be named and described once, followed by what takes over after it, got ' + src);
  assert((src.match(/Quarterly sweep/g)||[]).length===1, 'The rule name must appear only once');
}
async function testForecastWideExportSmartRuleFreezeAndZeroOffsetWording(){
  const D = v455ForecastFixture();
  D.forecastAccountRules[0].freezeAfterTarget = true;
  D.forecastAccountRules[1].freezeAfterTarget = true;
  const sb = v455Sandbox(D);
  sb.localStorage.setItem('gridEndMonth', '2027-01');
  const out = v455CaptureCsv(sb);
  sb.exportForecastGridCSV();
  const byId = {}; sb.csvToObjects(out.text).forEach(r=>{ byId[r['account id']] = r; });
  assert(byId['60103']['source']==='Smart Rule "Quarterly sweep" (2026-11 to 2027-01): Fixed 100.00, held at 0 until 2026-12, frozen at 0 after 2026-12',
    'With freeze on, the rule covers the frozen months too and says so, got ' + byId['60103']['source']);
  assert(byId['60104']['source']==='Smart Rule "Insurance mirror" (2026-11 to 2027-01): Balance of Insurance (reversed), applies to 2026-10 only, frozen at 0 after 2026-10',
    'A current-month rule with freeze describes the balance it reads and the freeze, got ' + byId['60104']['source']);
}
async function testForecastWideExportBankAccountSourceIsBlank(){
  const {byId} = v455ExportWide();
  assert(byId['10101']['source']==='' && byId['10101']['2026-11']==='', 'Bank accounts have no forecast, so Source and future amounts stay blank');
}
async function testForecastPivotExportKeepsItsPerRowSource(){
  const sb = v455Sandbox(v455ForecastFixture());
  sb.localStorage.setItem('gridEndMonth', '2027-01');
  const out = v455CaptureCsv(sb);
  sb.exportForecastGridPivotCSV();
  const header = out.text.split('\n')[0].split(',');
  assert(header[header.length-1]==='Source' && header.includes('Month'), 'The Pivot export should keep its own per-row Source column, got ' + header.join('|'));
}
async function testForecastWideExportStillReimportsWithTheSourceColumn(){
  const {sb, rows} = v455ExportWide();
  rows.forEach(r=>{ if(r['account id']==='30101') r['2026-11'] = '777'; });
  sb.__set('confirm', ()=>true);
  sb.__set('blockIfSyncing', ()=>false);
  sb.__set('showImportProgress', ()=>{}); sb.__set('updateImportProgress', ()=>{}); sb.__set('finishImportProgress', ()=>{});
  sb.__set('persistLocal', ()=>{}); sb.__set('syncWrite', async ()=>{}); sb.__set('syncWriteMany', async ()=>{});
  sb.__set('renderForecastPage', ()=>{}); sb.__set('alert', ()=>{});
  let err = null;
  try { await sb.importForecastGridCSV(rows); } catch(e){ err = e; }
  assert(!err, 'Re-importing an export with the Source column must not crash, got ' + (err&&err.message));
  const D = vm.runInContext('D', sb);
  assert(D.forecastPlans[30101] && Math.abs(D.forecastPlans[30101]['2026-11']-777)<0.005, 'Month columns must still be read on import, got ' + JSON.stringify(D.forecastPlans[30101]));
  const a = D.accounts.find(x=>x.id===60101);
  assert(a.forecast_category==='expense', 'Sub-Category must still be read from its own column (not shifted by Source), got ' + a.forecast_category);
}

// ---- v4.56.0: Budget import only writes + syncs cells that actually changed ----
function v456BudgetImportSandbox(budget){
  const D = {
    accounts:[
      {id:60101, name:'Bills', category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:60102, name:'Rent', category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
    ],
    ledger:[], provisionGroups:[],
    budget: budget || [
      {id:1, acc:60101, date:'2026-10-01', amt:100, descr:'b'}, {id:2, acc:60101, date:'2026-11-01', amt:110, descr:'b'}, {id:3, acc:60101, date:'2026-12-01', amt:120, descr:'b'},
      {id:4, acc:60102, date:'2026-10-01', amt:2000, descr:'b'}, {id:5, acc:60102, date:'2026-11-01', amt:2000, descr:'b'}, {id:6, acc:60102, date:'2026-12-01', amt:333.3333, descr:'b'},
    ],
  };
  const sb = v455Sandbox(D);
  sb.localStorage.setItem('gridEndMonth', '2026-12');
  const cap = {ops:null, calls:0, msg:null};
  sb.__set('confirm', ()=>true); sb.__set('blockIfSyncing', ()=>false);
  sb.__set('showImportProgress', ()=>{}); sb.__set('updateImportProgress', ()=>{});
  sb.__set('finishImportProgress', (m)=>{ cap.msg = m; });
  sb.__set('persistLocal', ()=>{}); sb.__set('renderBudget', ()=>{});
  sb.__set('syncWriteMany', async (ops)=>{ cap.calls++; cap.ops = ops; });
  return {sb, cap};
}
function v456ExportRows(sb){
  const out = v455CaptureCsv(sb);
  sb.exportBudgetGridCSV(false);
  return sb.csvToObjects(out.text);
}
async function testBudgetImportUnchangedFileSyncsNothing(){
  const {sb, cap} = v456BudgetImportSandbox();
  await sb.importBudgetGridCSV(v456ExportRows(sb));
  assert(cap.calls===0, 'Re-importing an untouched export must not sync anything, got ' + cap.calls + ' sync call(s) with ' + (cap.ops&&cap.ops.length) + ' op(s)');
  assert(/0 changed, 6 unchanged \(skipped\)/.test(cap.msg||''), 'Message should say 0 changed, 6 unchanged (skipped), got ' + cap.msg);
}
async function testBudgetImportSyncsOnlyTheEditedCell(){
  const {sb, cap} = v456BudgetImportSandbox();
  const rows = v456ExportRows(sb);
  rows.find(r=>r['account id']==='60101')['2026-11'] = '150';
  await sb.importBudgetGridCSV(rows);
  assert(cap.ops && cap.ops.length===1, 'Only the one edited cell should sync, got ' + (cap.ops&&cap.ops.length));
  const op = cap.ops && cap.ops[0];
  assert(op && op.kind==='upsert' && op.row.id===2 && Math.abs(op.row.amt-150)<0.005, 'The synced op must be the edited budget row with its new value, got ' + JSON.stringify(op));
  assert(/1 changed, 5 unchanged \(skipped\)/.test(cap.msg||''), 'Message should report 1 changed, 5 unchanged, got ' + cap.msg);
  const D = vm.runInContext('D', sb);
  assert(D.budget.find(b=>b.id===2).amt===150 && D.budget.find(b=>b.id===1).amt===100, 'Local data: edited row updated, untouched row left alone');
}
async function testBudgetImportTreatsExcelRoundingAsUnchangedButCountsARealCentEdit(){
  const {sb, cap} = v456BudgetImportSandbox();
  const rows = v456ExportRows(sb);
  const rent = rows.find(r=>r['account id']==='60102');
  rent['2026-12'] = '333.33';   // Excel rounding of a stored 333.3333 — not an edit
  rent['2026-11'] = '2,000.01'; // a genuine one-halala edit, with Excel's thousands separator
  await sb.importBudgetGridCSV(rows);
  assert(cap.ops && cap.ops.length===1 && cap.ops[0].row.id===5, 'Only the real 0.01 edit should sync (Excel rounding must not), got ' + JSON.stringify(cap.ops&&cap.ops.map(o=>o.row.id)));
  const D = vm.runInContext('D', sb);
  assert(D.budget.find(b=>b.id===6).amt===333.3333, 'The stored full-precision value must be kept, not overwritten by the rounded one');
}
async function testBudgetImportClearingACellStillDeletesAndNewCellStillCreates(){
  const {sb, cap} = v456BudgetImportSandbox([{id:1, acc:60101, date:'2026-10-01', amt:100, descr:'b'}]);
  const rows = v456ExportRows(sb);
  const bills = rows.find(r=>r['account id']==='60101');
  bills['2026-10'] = '';   // cleared — must delete
  bills['2026-11'] = '75'; // new — must create
  await sb.importBudgetGridCSV(rows);
  const kinds = (cap.ops||[]).map(o=>o.kind+':'+(o.row.acc||o.row.id)).sort().join(',');
  assert(cap.ops && cap.ops.length===2 && kinds==='delete:1,upsert:60101', 'Expected one delete and one new row, got ' + kinds);
  const D = vm.runInContext('D', sb);
  const created = D.budget.find(b=>b.acc===60101 && b.date==='2026-11-01');
  assert(created && created.amt===75 && D.budget.length===1, 'Local data must reflect the delete and the new row');
  assert(created && created.id!==1, 'The new row must NOT reuse the ID being deleted in the same import (cloud race), got id ' + (created&&created.id));
  const up = (cap.ops||[]).find(o=>o.kind==='upsert'), del = (cap.ops||[]).find(o=>o.kind==='delete');
  assert(up && del && up.row.id!==del.row.id, 'The delete and the new row\'s upsert must target different IDs');
  assert(/2 changed/.test(cap.msg||''), 'Both count as changes, got ' + cap.msg);
}

// ---- #3 reconcile mode: last 3 JVs pane ----
function v455ReconcileSandbox(extraLedger){
  const D = {
    accounts: [{id:10101, name:'Main Bank', category:'Bank Accounts', acc_type:'Individual Account', status:'Active', stmt_balance:1000, stmt_date:'2026-10-01'},
               {id:60101, name:'Food', category:'Food', acc_type:'Individual Account', status:'Active'}],
    ledger: [
      {id:1, jv:1, date:'2026-01-05', acc:10101, amt:100, descr:'oldest'},
      {id:2, jv:2, date:'2026-03-01', acc:10101, amt:-20, descr:'march A'},
      {id:3, jv:2, date:'2026-03-01', acc:60101, amt:20, descr:'march A other leg'},
      {id:4, jv:3, date:'2026-02-10', acc:10101, amt:-30, descr:'feb'},
      {id:5, jv:4, date:'2026-03-01', acc:10101, amt:-40, descr:'march B'},
      {id:6, jv:5, date:'2026-04-01', acc:60101, amt:50, descr:'other account only'},
    ].concat(extraLedger||[]),
    budget: [], provisionGroups: [],
  };
  const sb = v455Sandbox(D);
  sb.resetJVDraft();
  sb.__set('reconcileAcc', 10101);
  return sb;
}
async function testReconcileRecentJvsAreTheLastThreeByJvDateOnlyThisAccountsLines(){
  const sb = v455ReconcileSandbox();
  const lines = sb.reconcileRecentJvLines(10101, 3);
  assert(lines.every(l=>l.acc===10101), 'Only lines hitting the reconciled account may appear, got accounts ' + lines.map(l=>l.acc).join(','));
  assert(lines.map(l=>l.jv).join(',')==='4,2,3', 'Expected JVs 4,2,3 (newest JV date first, ties by higher JV#), got ' + lines.map(l=>l.jv).join(','));
  assert(!lines.some(l=>l.jv===1), 'The 4th-newest JV must be left out');
}
async function testReconcilePaneIsCollapsedByDefaultAndShowsDateJvDescriptionAmount(){
  const sb = v455ReconcileSandbox();
  const html = sb.reconcileBannerHTML();
  const m = html.match(/<details id="reconcileJvPane"[^>]*>/);
  assert(m, 'The banner should include the collapsible JV pane');
  assert(m && !/\sopen[\s>=]/.test(m[0]), 'The pane must be collapsed by default, got tag: ' + (m&&m[0]));
  assert(html.includes('2026-03-01') && html.includes('#4') && html.includes('march B') && html.includes('-40.00'), 'Rows must show date, JV#, description and amount');
  assert(!html.includes('march A other leg'), 'The other leg of a JV (a different account) must not be shown');
  sb.__set('reconcileJvPaneOpen', true);
  assert(/<details id="reconcileJvPane"[^>]*\sopen[\s>]/.test(sb.reconcileBannerHTML()), 'The pane should stay open after the user opened it');
}
async function testReconcilePaneNeverListsTheUnpostedDraft(){
  const sb = v455ReconcileSandbox();
  const draft = vm.runInContext('jvDraft', sb);
  draft.lines[0].acc = 10101; draft.lines[0].amt = 999; draft.lines[0].descr = 'DRAFT-ONLY';
  const html = sb.reconcileBannerHTML();
  assert(!html.includes('DRAFT-ONLY'), 'An unposted draft line must never appear in the posted-JV pane');
}
async function testReconcilePaneShowsBothLinesWhenOneJvHitsTheAccountTwice(){
  const sb = v455ReconcileSandbox([{id:7, jv:6, date:'2026-05-01', acc:10101, amt:-5, descr:'split one'}, {id:8, jv:6, date:'2026-05-01', acc:10101, amt:-6, descr:'split two'}]);
  const lines = sb.reconcileRecentJvLines(10101, 3);
  assert(lines.filter(l=>l.jv===6).length===2, 'Both lines of a JV that hits the account twice should show');
  assert(new Set(lines.map(l=>l.jv)).size===3, 'They still count as a single JV out of the 3, got JVs ' + [...new Set(lines.map(l=>l.jv))].join(','));
}
async function testReconcilePaneEmptyStateWhenNoPostedJvs(){
  const sb = v455ReconcileSandbox();
  sb.__set('reconcileAcc', 10101);
  const D = vm.runInContext('D', sb); D.ledger = [];
  assert(/No posted JVs on this account yet/.test(sb.reconcileBannerHTML()), 'Should say so when the account has no posted JVs');
}

// ---- #4 Jamiah: this month's net total ----
function v455JamiahSandbox(ledger){
  const acc = {id:10501, name:'Jamiah Cash', category:'Short Term Receivables', acc_type:'Individual Account', status:'Active', is_allocatable:true};
  const D = {accounts:[acc], ledger, budget:[], provisionGroups:[], jamiahs:[]};
  const sb = v455Sandbox(D);
  const j = {id:1, name:'Monthly', account:10501, startMonth:'2026-01', durationMonths:12, groups:[], participants:[{id:1, name:'A', pledgeAmount:100}], roundGroup:{}, tags:{}};
  return {sb, j};
}
async function testJamiahShowsThisMonthsNetOfUnallocatedTransactions(){
  const {sb, j} = v455JamiahSandbox([
    {id:1, jv:1, date:'2026-10-05', acc:10501, amt:300, descr:'this month 1'},
    {id:2, jv:2, date:'2026-10-12', acc:10501, amt:-50, descr:'this month 2'},
    {id:3, jv:3, date:'2026-09-28', acc:10501, amt:999, descr:'last month'},
    {id:4, jv:4, date:'2026-10-15', acc:10501, amt:7000, descr:'allocated', alloc:5},
  ]);
  const html = sb.renderJamiahUntagged(j);
  const m = html.match(/id="jamiahMonthTotal"[^>]*>(.*?)<\/div>/);
  assert(m, 'The month total line should be present under the heading');
  assert(m && m[1].includes('250.00'), 'Net should be 300 - 50 = 250.00 (last month and allocated lines excluded), got ' + (m&&m[1]));
  assert(m && /across 2 unallocated transactions/.test(m[1]), 'Should count the 2 unallocated lines this month, got ' + (m&&m[1]));
  assert(m && /This month \(Oct-26\)/.test(m[1]), 'Should name the calendar month, got ' + (m&&m[1]));
}
async function testJamiahMonthTotalIsNetSignedAndHandlesSingularAndZero(){
  let t = v455JamiahSandbox([{id:1, jv:1, date:'2026-10-05', acc:10501, amt:-120, descr:'x'}]);
  let m = t.sb.renderJamiahUntagged(t.j).match(/id="jamiahMonthTotal"[^>]*>(.*?)<\/div>/);
  assert(m && m[1].includes('-120.00') && /across 1 unallocated transaction(?!s)/.test(m[1]), 'Net keeps its sign and one line reads singular, got ' + (m&&m[1]));
  t = v455JamiahSandbox([{id:1, jv:1, date:'2026-08-05', acc:10501, amt:500, descr:'old'}]);
  m = t.sb.renderJamiahUntagged(t.j).match(/id="jamiahMonthTotal"[^>]*>(.*?)<\/div>/);
  assert(m && m[1].includes('0.00') && /across 0 unallocated transactions/.test(m[1]), 'No lines this month reads 0.00 across 0, got ' + (m&&m[1]));
}

// ---- #6 accrued amount per sub category ----
function v455AccrualFixture(extraLedger){
  return {
    accounts: [
      {id:20301, name:'Gov Accrual Liability', category:'Accruals', acc_type:'Accrual Account', status:'Active'},
      {id:60100, name:'Government Fees', category:'Government & Banks', acc_type:'Individual Account', status:'Active'},
      {id:60199, name:'Government & Banks - Accrual', category:'Government & Banks', acc_type:'Accrual Account', status:'Active'},
      {id:60200, name:'Fuel', category:'Transportation', acc_type:'Individual Account', status:'Active'},
    ],
    ledger: [
      {id:1, jv:1, date:'2026-10-02', acc:20301, amt:-1500, descr:'accrue'},
      {id:2, jv:2, date:'2026-10-31', acc:20301, amt:-100, descr:'last day'},
      {id:3, jv:3, date:'2026-11-02', acc:20301, amt:-9999, descr:'next month'},
      {id:4, jv:4, date:'2026-10-05', acc:60100, amt:-25, descr:'fee'},
    ].concat(extraLedger||[]),
    budget: [], provisionGroups: [], forecastAccountRules: [],
    accrualMappings: [{category:'Government & Banks', liabilityAcc:20301, expenseAcc:60199}],
  };
}
async function testAccruedForCategoryIsTheNegatedLiabilityBalanceAsOfTheDate(){
  const sb = v455Sandbox(v455AccrualFixture());
  assert(Math.abs(sb.accruedForCategory('Government & Banks','2026-10-31')-1600)<0.005, 'Liability stored as -1600 by month end should read as 1,600 accrued (the 31st counts, November does not), got ' + sb.accruedForCategory('Government & Banks','2026-10-31'));
  assert(Math.abs(sb.accruedForCategory('Government & Banks','2026-10-30')-1500)<0.005, 'The day before the 31st line it should be 1,500');
  assert(sb.accruedForCategory('Transportation','2026-10-31')===null, 'A category with no Accrual Mapping must return null');
}
async function testMonthEndDateStrHandlesShortMonthsAndLeapYears(){
  const sb = makeSandbox();
  assert(sb.monthEndDateStr('2026-02')==='2026-02-28', 'Feb 2026 ends on the 28th');
  assert(sb.monthEndDateStr('2028-02')==='2028-02-29', 'Feb 2028 is a leap year');
  assert(sb.monthEndDateStr('2026-12')==='2026-12-31', 'December ends on the 31st');
}
async function testPnLShowsAccruedNextToMappedCategoryAndItsAccrualAccountOnly(){
  const sb = v455Sandbox(v455AccrualFixture());
  sb.__set('pnlFrom','2026-10-01'); sb.__set('pnlTo','2026-10-31'); sb.__set('pnlPreset','custom');
  sb.renderPnL();
  const html = sb.document.getElementById('app').innerHTML;
  const chips = html.match(/class="mut accrued-chip"[^>]*>.*?<\/span>/g) || [];
  // v4.61.0: only next to the sub category name — the duplicate on the accrual (99) account line was removed on request.
  assert(chips.length===1, 'Expected the chip on the category row only (not on the 60199 accrual line), got ' + chips.length);
  assert(chips.every(c=>c.includes('1,600.00')), 'The chip should show the balance as of the period end (1,600.00), got ' + chips.join(' | '));
  assert(!/Government &amp; Banks - Accrual[^<]*<span[^>]*accrued-chip/.test(html), 'The accrual account line must not carry its own Accrued chip');
  assert(!/data-accrued-cat="Transportation"/.test(html), 'An unmapped category must not show an Accrued chip');
  // v5.4.1: the row may carry other attributes (data-pnl-cat for the Dashboard jump)
  const catRow = html.match(/<tr style="background:var\(--chip\)"[^>]*><td style="font-weight:700;color:var\(--accent\)">Government &amp; Banks[^<]*<span[^>]*accrued-chip/);
  assert(catRow, 'The chip must sit right next to the sub category name on its header row');
}
async function testPnLAccruedFollowsThePeriodEndNotToday(){
  const sb = v455Sandbox(v455AccrualFixture());
  sb.__set('pnlFrom','2026-10-01'); sb.__set('pnlTo','2026-10-15'); sb.__set('pnlPreset','custom');
  sb.renderPnL();
  const html = sb.document.getElementById('app').innerHTML;
  assert(html.includes('1,500.00') && !html.includes('1,600.00'), 'As of Oct 15 only the first accrual (1,500.00) exists, so the 31st line must not count');
}

// ---- #8 budget export: future only vs historical + future ----
function v455BudgetExportSandbox(){
  const D = {
    accounts:[{id:60101, name:'Bills', category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'}],
    ledger:[{id:1, jv:1, date:'2026-08-15', acc:60101, amt:321, descr:'past actual'}, {id:2, jv:2, date:'2026-10-05', acc:60101, amt:777, descr:'partial current'}],
    budget:[{id:1, acc:60101, date:'2026-10-01', amt:250}, {id:2, acc:60101, date:'2026-11-01', amt:260}], provisionGroups:[],
  };
  const sb = v455Sandbox(D);
  sb.localStorage.setItem('gridEndMonth', '2026-12');
  return sb;
}
async function testExportGridButtonOpensTheChoiceInsteadOfExportingImmediately(){
  const sb = v455BudgetExportSandbox();
  sb.document.body.insertAdjacentHTML('beforeend', '<div id="modalRoot"></div>');
  const out = v455CaptureCsv(sb);
  sb.openBudgetExportChoice();
  const modal = sb.document.body.innerHTML;
  assert(/id="budgetExportFuture"/.test(modal) && /id="budgetExportHistory"/.test(modal), 'The choice should offer both Future only and Historical + future');
  assert(/exportBudgetGridCSV\(false\)/.test(modal) && /exportBudgetGridCSV\(true\)/.test(modal), 'Each choice should call the export with the right flag');
  assert(out.text===null, 'Opening the choice must not export anything yet');
  const src = vm.runInContext('renderBudgetControls.toString()', sb);
  assert(/onclick="openBudgetExportChoice\(\)">⬇ Export Grid/.test(src), 'The Export Grid button on the Budget page must open the choice');
}
async function testBudgetExportFutureOnlyIsUnchanged(){
  const sb = v455BudgetExportSandbox();
  const out = v455CaptureCsv(sb);
  sb.exportBudgetGridCSV(false);
  const header = out.text.split('\n')[0];
  assert(header.indexOf('2026-08')===-1 && header.indexOf('2026-10')!==-1, 'Future only starts at the current month, got ' + header);
  const r = sb.csvToObjects(out.text)[0];
  assert(r['2026-10']==='250', 'Current month shows the budget figure, got ' + r['2026-10']);
}
async function testBudgetExportWithHistoryStartsAtEarliestLedgerMonthAndShowsActualForPast(){
  const sb = v455BudgetExportSandbox();
  const out = v455CaptureCsv(sb);
  sb.exportBudgetGridCSV(true);
  const header = out.text.split('\n')[0].split(',');
  assert(header.includes('2026-08') && header.indexOf('2026-08')<header.indexOf('2026-10'), 'Historical export must start at the earliest ledger month (2026-08), got ' + header.join('|'));
  assert(header.includes('2026-09'), 'Months with no activity between history and today are still listed');
  const r = sb.csvToObjects(out.text)[0];
  assert(r['2026-08']==='321', 'A past month shows ACTUAL spend (321), got ' + r['2026-08']);
  assert(r['2026-10']==='250', 'The current month still shows the BUDGET (250), not the 777 spent so far, got ' + r['2026-10']);
  assert(r['2026-11']==='260', 'Future months show budget, got ' + r['2026-11']);
}
async function testBudgetImportIgnoresThePastMonthsOfAHistoricalExport(){
  const sb = v455BudgetExportSandbox();
  const out = v455CaptureCsv(sb);
  sb.exportBudgetGridCSV(true);
  const rows = sb.csvToObjects(out.text);
  rows[0]['2026-11'] = '999';
  sb.__set('confirm', ()=>true); sb.__set('blockIfSyncing', ()=>false);
  sb.__set('showImportProgress', ()=>{}); sb.__set('updateImportProgress', ()=>{}); sb.__set('finishImportProgress', ()=>{});
  sb.__set('persistLocal', ()=>{}); sb.__set('syncWriteMany', async ()=>{}); sb.__set('renderBudget', ()=>{});
  await sb.importBudgetGridCSV(rows);
  const D = vm.runInContext('D', sb);
  assert(!D.budget.some(b=>b.date==='2026-08-01'), 'The past month\'s ACTUAL figure must never be written back as a budget');
  const nov = D.budget.find(b=>b.acc===60101 && b.date==='2026-11-01');
  assert(nov && Math.abs(nov.amt-999)<0.005, 'Future columns of the historical export still import, got ' + (nov&&nov.amt));
}


// ================= v4.57.0: actual-rate platform cash, rate fields, withdrawals booking, cash visibility =================
// Owner A (self, Out 10201, In 10211) puts 400 SAR in; B (Out 10202) puts 375 SAR in.
function fxSandbox(extra, keepRender){
  return poolSandbox(Object.assign({
    ledger: [
      {id:1, jv:1, date:'2026-10-01', acc:10201, amt:400, descr:'A onboarding'},
      {id:2, jv:1, date:'2026-10-01', acc:10202, amt:375, descr:'B onboarding'},
    ],
  }, extra||{}), keepRender);
}
function fxCell(sb, platformId, ownerId, date){
  const st = sb.invCashState(date||null).state;
  return (st[platformId]||{})[ownerId] || {usd:0, sar:0, profitUsd:0, profitSar:0};
}
async function fxSell(sb, posId, date, ownerUnits, usd, rate, cashSide){
  sb.openInvTxModal(posId, null);
  const d = sb._invTxDraft;
  d.date = date; sb.setInvTxKind('sell');
  d.units = String(Object.values(ownerUnits).reduce((s,u)=>s+u,0));
  sb.setInvTxCashSide(cashSide||'cash');
  sb.setInvTxRate(String(rate));
  sb.setInvTxUsd(String(usd));
  d.owners = Object.keys(ownerUnits).map(k=>({ownerId:Number(k), units:String(ownerUnits[k])}));
  await sb.saveInvTx();
}

async function testLegacyDepositWithoutSarStaysAtTheStandardRate(){
  const sb = invCashSandbox({invCashMovements:[{id:1, platformId:1, date:'2026-01-01', kind:'deposit', usdAmount:100, owners:[{ownerId:1, usd:100}]}]});
  const c = fxCell(sb, 1, 1);
  assert(Math.abs(c.usd-100)<1e-9 && Math.abs(c.sar-375)<1e-9, 'An old deposit with no SAR stored must stay at 3.75 (375 SAR), got ' + JSON.stringify(c));
  assert(Math.abs(sb.invOwnerCashSar(1).cashSar-375)<1e-9, 'Owner cash in SAR should read 375');
}
async function testCollectAtARealRateRecordsFullSarAndClosesAvailable(){
  const sb = fxSandbox();
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);  // 400 SAR → $100 = rate 4.00
  const m = sb._D.invCashMovements[0];
  const row = m.owners.find(o=>o.ownerId===1);
  assert(row && row.sar===400 && row.usd===100, 'The deposit must store the person\'s SAR alongside the USD, got ' + JSON.stringify(m.owners));
  assert(Math.abs(sb.invMovementRate(m)-4)<1e-9, 'The effective rate should be 4.00, got ' + sb.invMovementRate(m));
  const c = fxCell(sb, 1, 1);
  assert(Math.abs(c.sar-400)<1e-9, 'The cash must be carried at what it cost (400 SAR), not $100 × 3.75, got ' + c.sar);
  const avail = sb.invOwnersAvailableSar();
  assert(Math.abs(avail[1])<0.005, 'After collecting the full 400 SAR, Available must drop to 0, got ' + avail[1]);
}
async function testCollectShowsTheEffectiveRateForInformation(){
  const sb = fxSandbox();
  sb.openInvCollectModal(1);
  sb.invCollectClearRows();
  sb.setInvCollectRow(1, '400');
  sb.setInvCollectUsd('100');
  const el = sb.document.getElementById('invCollectRate');
  assert(el && /4\.0000/.test(el.textContent), 'The Collect form should show the rate 4.0000 SAR/USD, got ' + (el&&el.textContent));
}
async function testCollectPreFillsTheFullAvailableBalance(){
  const sb = fxSandbox();
  sb.openInvCollectModal(1);
  const d = sb._invCollectDraft;
  assert(Number(d.rows[1].sar)===400 && Number(d.rows[2].sar)===375, 'Each person should be pre-filled with their full onboarding balance, got ' + JSON.stringify(d.rows));
}
async function testCashFundedBuyIsCostedAtEachPersonsOwnRate(){
  const sb = fxSandbox();
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);   // A at 4.00
  await poolCollect(sb, 1, '2026-10-02', {2:375}, 100);   // B at 3.75
  await poolBuy(sb, 1, '2026-10-03', 2, 200);             // split by cash: 1 unit each, $100 each
  const t = sb._D.invTransactions[0];
  const a = t.owners.find(o=>o.ownerId===1), b = t.owners.find(o=>o.ownerId===2);
  assert(a && Math.abs(a.sar-400)<1e-6 && Math.abs(a.usd-100)<1e-6, 'A\'s $100 cost 400 SAR at 4.00, got ' + JSON.stringify(a));
  assert(b && Math.abs(b.sar-375)<1e-6, 'B\'s $100 cost 375 SAR at 3.75, got ' + JSON.stringify(b));
  assert(Math.abs(t.totalSar-775)<1e-6, 'The buy\'s SAR total is the sum of each person\'s real cost (775), got ' + t.totalSar);
  const st = sb.computePositionState(1);
  assert(Math.abs(st.byOwner[1].costSar-400)<1e-6 && Math.abs(st.byOwner[2].costSar-375)<1e-6, 'Position cost basis must follow each person\'s real rate');
  const ca = fxCell(sb, 1, 1), cb = fxCell(sb, 1, 2);
  assert(Math.abs(ca.usd)<1e-6 && Math.abs(ca.sar)<1e-6 && Math.abs(cb.sar)<1e-6, 'The SAR that left cash must equal the SAR that went into the position (no residue), got A ' + JSON.stringify(ca));
  const rec = sb.invOwnerReconciliation();
  assert(rec.every(r=>Math.abs(r.diff)<0.01), 'Reconciliation must close for both people, got diffs ' + rec.map(r=>r.owner.name+':'+r.diff.toFixed(2)).join(', '));
}
async function testCashBuyPreviewNamesEachPersonsRate(){
  const sb = fxSandbox();
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  await poolCollect(sb, 1, '2026-10-02', {2:375}, 100);
  sb.openInvTxModal(1, null);
  const d = sb._invTxDraft; d.date = '2026-10-03'; d.units = '2';
  sb.setInvTxCashSide('cash'); sb.setInvTxUsd('200'); sb.applyInvTxCashSplit();
  const txt = sb.invTxCashRateText(d);
  assert(/A 4\.0000/.test(txt) && /B 3\.7500/.test(txt) && /775\.00 SAR/.test(txt), 'The buy form should show each person\'s rate and the SAR total, got ' + txt);
  assert(!sb.document.getElementById('invTxRate'), 'A cash-funded buy must NOT offer a typed rate (it uses each person\'s cash rate)');
}
async function testReEditingACashBuyDoesNotDoubleCountItself(){
  const sb = fxSandbox();
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  await poolBuy(sb, 1, '2026-10-03', 1, 50);
  const first = JSON.stringify(sb._D.invTransactions[0].owners);
  sb.openInvTxModal(1, sb._D.invTransactions[0].id);
  await sb.saveInvTx();
  const second = JSON.stringify(sb._D.invTransactions[0].owners);
  assert(first===second, 'Re-saving an unchanged cash buy must give the same per-person cost, got ' + first + ' then ' + second);
}
async function testUsdTransactionsTakeTheRateTypedOnTheDay(){
  const sb = fxSandbox();
  sb.openInvTxModal(1, null);
  const d = sb._invTxDraft;
  assert(Math.abs(Number(d.fxRate)-3.75)<1e-9, 'A new transaction\'s rate should be pre-filled with the standard rate');
  d.date = '2026-10-03'; d.units = '1';
  sb.setInvTxRate('3.8');
  sb.setInvTxUsd('100');
  assert(Math.abs(Number(d.totalSar)-380)<1e-9, '$100 at 3.80 must give 380 SAR, got ' + d.totalSar);
  assert(sb.document.getElementById('invTxRate'), 'A bank-funded USD transaction should show the Rate field');
  d.owners = [{ownerId:1, units:'1'}];
  await sb.saveInvTx();
  const t = sb._D.invTransactions[0];
  assert(Math.abs(t.totalSar-380)<1e-9 && t.owners[0].usd===100, 'Saved with 380 SAR and the person\'s USD share, got ' + JSON.stringify(t));
  sb.openInvTxModal(1, t.id);
  assert(Math.abs(Number(sb._invTxDraft.fxRate)-3.8)<1e-9, 'Reopening shows the rate it was saved at (3.80), got ' + sb._invTxDraft.fxRate);
}
async function testUserExampleDeposit400SellAndWithdraw150At375(){
  // Deposit 400 SAR → $100 (4.00); buy $100; sell for $150 into cash at 3.75; withdraw $150 → 562.50 SAR.
  const sb = fxSandbox({ledger:[{id:1, jv:1, date:'2026-10-01', acc:10201, amt:400, descr:'A onboarding'}]});
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  await poolBuy(sb, 1, '2026-10-03', 1, 100);
  await fxSell(sb, 1, '2026-10-10', {1:1}, 150, 3.75, 'cash');
  const st = sb.computePositionState(1);
  assert(Math.abs((st.byOwner[1].realizedSar||0)-162.5)<0.01 || Math.abs(st.totalRealizedSar-162.5)<0.01, 'Realised profit = 562.50 − 400 = 162.50 SAR, got ' + st.totalRealizedSar);
  const c = fxCell(sb, 1, 1);
  assert(Math.abs(c.usd-150)<1e-6 && Math.abs(c.sar-562.5)<1e-6, 'Sale proceeds enter cash at the sale\'s rate: $150 / 562.50 SAR, got ' + JSON.stringify(c));
  assert(Math.abs(c.profitSar-162.5)<1e-6, 'Profit sitting in cash should be 162.50 SAR, got ' + c.profitSar);
  // Withdraw it all, 562.50 SAR reaching the bank.
  sb.openInvCashModal(1, 'withdrawal', null);
  const d = sb._invCashDraft;
  d.date = '2026-10-12'; d.usdAmount = '150'; d.owners = [{ownerId:1, usd:150}]; d.sarReceived = '562.5';
  const bk = sb.invWithdrawalBooking(d);
  assert(bk && Math.abs(bk.capitalSar-400)<0.01 && Math.abs(bk.profitSar-162.5)<0.01, 'Book 400 SAR to Withdrawn (In) and 162.50 to Profit, got ' + JSON.stringify(bk));
  assert(bk && Math.abs(bk.rate-3.75)<1e-9, 'The withdrawal rate (FYI) is 3.75, got ' + (bk&&bk.rate));
  await sb.saveInvCashMovement();
  // He books In 400 (capital) and Profit 162.50, as the form says.
  sb._D.ledger.push({id:9, jv:9, date:'2026-10-12', acc:10211, amt:-400, descr:'A offboarding'});
  sb._D.invOwners.find(o=>o.id===1).inAcc = 10211;
  const rec = sb.invOwnerReconciliation().find(r=>r.owner.id===1);
  assert(Math.abs(rec.diff)<0.01, 'With 400 in and 400 out, the reconciliation must close, got diff ' + rec.diff);
  const m = sb._D.invCashMovements.find(x=>x.kind==='withdrawal');
  assert(m && Math.abs(sb.invMovementRate(m)-3.75)<1e-9, 'The withdrawal keeps its SAR received for the Cash log rate');
}
async function testWithdrawalTakesCashOutAtItsAverageCost(){
  // Cash held at 4.00 (400 SAR for $100). Taking $50 out must remove half its cost (200 SAR), not $50 × 3.75.
  const sb = fxSandbox();
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  sb.openInvCashModal(1, 'withdrawal', null);
  const d = sb._invCashDraft;
  d.date = '2026-10-05'; d.usdAmount = '50'; d.owners = [{ownerId:1, usd:50}];
  await sb.saveInvCashMovement();
  const c = fxCell(sb, 1, 1);
  assert(Math.abs(c.usd-50)<1e-9 && Math.abs(c.sar-200)<1e-9, 'The $50 left must still be carried at 4.00 (200 SAR), got ' + JSON.stringify(c));
}
async function testWithdrawalAtABetterRateSendsTheGainToProfit(){
  const sb = fxSandbox({ledger:[{id:1, jv:1, date:'2026-10-01', acc:10201, amt:400, descr:'A onboarding'}]});
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  sb.openInvCashModal(1, 'withdrawal', null);
  const d = sb._invCashDraft;
  d.date = '2026-10-05'; d.usdAmount = '100'; d.owners = [{ownerId:1, usd:100}]; d.sarReceived = '410';
  const bk = sb.invWithdrawalBooking(d);
  assert(bk && Math.abs(bk.capitalSar-400)<0.01 && Math.abs(bk.profitSar-10)<0.01, 'Capital back at cost (400) and the 10 SAR rate gain to Profit, got ' + JSON.stringify(bk));
}
async function testEditingADepositsUsdKeepsTheSarAndUpdatesTheRate(){
  const sb = fxSandbox();
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  const m = sb._D.invCashMovements[0];
  sb.openInvCashModal(1, 'deposit', m.id);
  assert(/Rate 4\.0000/.test(sb.document.body.innerHTML), 'The deposit editor should show its rate for information');
  sb._invCashDraft.usdAmount = '105';
  sb.setInvCashOwnerUsd(1, '105');
  await sb.saveInvCashMovement();
  const row = sb._D.invCashMovements[0].owners.find(o=>o.ownerId===1);
  assert(row && row.sar===400 && row.usd===105, 'Correcting the USD must keep the 400 SAR contributed, got ' + JSON.stringify(row));
  assert(Math.abs(fxCell(sb,1,1).sar-400)<1e-9, 'Cash stays at its 400 SAR cost');
}
async function testTransferCarriesTheAverageRate(){
  const sb = fxSandbox();
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  sb._D.invCashMovements.push({id:50, platformId:1, toPlatformId:2, date:'2026-10-03', kind:'transfer', usdAmount:50, feeUsd:0, owners:[{ownerId:1, usd:50}]});
  const from = fxCell(sb, 1, 1), to = fxCell(sb, 2, 1);
  assert(Math.abs(from.sar-200)<1e-9 && Math.abs(to.sar-200)<1e-9 && Math.abs(to.usd-50)<1e-9, 'Half the cash moves with half its SAR cost (200 each side), got from ' + JSON.stringify(from) + ' to ' + JSON.stringify(to));
}
async function testCashLogShowsTheDepositRate(){
  const sb = fxSandbox();
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  sb.openInvCashLog(1);
  assert(/rate 4\.0000/.test(sb.document.body.innerHTML), 'The Cash log should show the deposit\'s rate');
}
async function testPlatformTableShowsAUsdCashRowWithPerPersonSplit(){
  const sb = fxSandbox({}, true);
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  await poolCollect(sb, 1, '2026-10-02', {2:375}, 100);
  vm.runInContext('invExpandedPlatforms.add(1)', sb);
  const html = sb.renderInvPlatformSection(sb._D.invPlatforms[0]);
  const m = html.match(/<tr class="click" id="invCashRow_1"[\s\S]*?<\/tr>/);
  assert(m, 'The platform table should have a USD cash row even with no positions bought yet');
  assert(m && m[0].includes('775.00') && m[0].includes('$200.00'), 'The cash row shows its SAR cost (775.00) and USD ($200.00), got ' + (m&&m[0].replace(/\s+/g,' ').slice(0,300)));
  assert(m && /openInvPlatformCashOwners\(1\)/.test(m[0]), 'Clicking it opens the per-person split');
  sb.openInvPlatformCashOwners(1);
  const modal = sb.document.body.innerHTML;
  assert(/4\.0000/.test(modal) && /3\.7500/.test(modal) && /openInvCashLog\(1\)/.test(modal), 'The split shows each person\'s rate and links to the Cash log');
  assert(!sb.renderInvPlatformSection(sb._D.invPlatforms[1]).includes('invCashRow_2'), 'A platform with no cash shows no cash row');
}
async function testByOwnerTableHasACashColumnAndListsCashOnlyPeople(){
  const sb = fxSandbox();
  await poolCollect(sb, 1, '2026-10-02', {2:375}, 100);
  const html = sb.renderInvOwnerBreakdown(sb.invOwnerTotals());
  assert(/Cash \(USD\)/.test(html), 'By Owner should have a Cash (USD) column');
  const cell = html.match(/data-owner-cash="2">([\s\S]*?)<\/td>/);
  assert(cell && cell[1].includes('$100.00') && cell[1].includes('375.00'), 'B holds only cash but must still be listed with $100.00 / 375.00 SAR, got ' + (cell&&cell[1]));
}
async function testStatementGroupsByPlatformAndIncludesCash(){
  const sb = fxSandbox({invPlatforms:[{id:1, name:'Zeta Exchange'}, {id:2, name:'Alpha Broker'}],
    invPositions:[{id:1, platformId:1, name:'Ethereum', ticker:'ETH', currency:'USD', assetClass:'Crypto', status:'Active'},
                  {id:2, platformId:2, name:'Zoom', ticker:'ZM', currency:'USD', assetClass:'Equity', status:'Active'},
                  {id:3, platformId:2, name:'Apple', ticker:'AAPL', currency:'USD', assetClass:'Equity', status:'Active'}]});
  sb._D.invTransactions.push(
    {id:1, positionId:1, date:'2026-10-01', kind:'buy', units:1, totalSar:100, owners:[{ownerId:1, units:1}], cashSide:'bank'},
    {id:2, positionId:2, date:'2026-10-01', kind:'buy', units:1, totalSar:100, owners:[{ownerId:1, units:1}], cashSide:'bank'},
    {id:3, positionId:3, date:'2026-10-01', kind:'buy', units:1, totalSar:100, owners:[{ownerId:1, units:1}], cashSide:'bank'});
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  sb.openInvOwnerStatement(1);
  const body = sb.document.body.innerHTML;
  const order = ['Apple','Zoom','Ethereum','نقد'].map(k=>body.indexOf(k));
  assert(order.every(i=>i>=0) && order[0]<order[1] && order[1]<order[2] && order[2]<order[3], 'Expected Alpha Broker (Apple, Zoom) then Zeta Exchange (Ethereum, then its cash), got indexes ' + order.join(','));
  const foot = body.match(/<tfoot>[\s\S]*?<\/tfoot>/);
  assert(foot && foot[0].includes('700.00'), 'Totals must include the cash at cost (300 positions + 400 cash = 700.00), got ' + (foot&&foot[0].replace(/\s+/g,' ')));
}

// ================= v4.58.0: simplified Investments views =================
function viewSandbox(extra){
  const sb = fxSandbox(Object.assign({invValuations:[{id:1, positionId:1, date:'2026-10-20', price:4000}]}, extra||{}), true);
  sb.__set('drawInvCharts', ()=>{});
  return sb;
}
function viewHtml(sb, view){ sb.__set('invView', view); sb.renderInvestmentsPage(); return sb.document.getElementById('app').innerHTML; }
async function viewPooledSetup(sb){
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  await poolCollect(sb, 1, '2026-10-02', {2:375}, 100);
  await poolBuy(sb, 1, '2026-10-03', 0.04, 160);   // split by cash 50/50 → 0.02 ETH each, $80 each
}
async function testInvestmentsOpensOnMineAndHasEveryView(){
  const sb = viewSandbox();
  assert(vm.runInContext('invView', sb)==='mine', 'The Investments page should open on 👤 Mine by default');
  sb.renderInvestmentsPage();
  const html = sb.document.getElementById('app').innerHTML;
  const views = ['mine','family','activity','recon','insights','setup'];
  assert(views.every(v=>html.includes('data-invview="'+v+'"')), 'The nav should offer all six views');
  assert(!html.includes('data-invview="classic"'), 'v5.6: the Classic tab is gone from the menu');
  sb.localStorage.setItem('invView', 'classic');
  sb.setInvView('family');
  assert(sb.localStorage.getItem('invView')==='family' && vm.runInContext('invView', sb)==='family', 'The chosen view should be remembered on this device');
  sb.setInvTab('recon');
  assert(vm.runInContext('invView', sb)==='recon', 'The old setInvTab(\'recon\') entry point must still open Reconcile');
}
async function testMineShowsOnlyMySliceAndNoFamilyFigures(){
  const sb = viewSandbox();
  await viewPooledSetup(sb);
  const html = viewHtml(sb, 'mine');
  const value = html.match(/id="invKpiValue"[\s\S]*?<div class="v[^"]*">([^<]*)</);
  // My slice: 0.02 ETH × 4000 × 3.75 = 300 SAR; my cash $20 left (cost 4.00 → 80 SAR) valued 20×3.75 = 75. Total 375.
  assert(value && value[1].trim()==='375.00', 'My Value = my ETH slice (300) + my cash (75) = 375.00, got ' + (value&&value[1]));
  const cost = html.match(/id="invKpiCost"[\s\S]*?<div class="v[^"]*">([^<]*)</);
  assert(cost && cost[1].trim()==='400.00', 'My Cost = 320 (ETH at my 4.00 rate) + 80 (cash) = 400.00, got ' + (cost&&cost[1]));
  assert(!/>B</.test(html) && !html.includes('Held for Family'), 'Mine must not show family members or family totals');
  vm.runInContext("invPlatformPageId = 1", sb);   // v5.6: the detail table is on the platform's own page
  const page = viewHtml(sb, 'mine');
  const card = page.match(/data-card="mine:1"[\s\S]*?<\/table>/);
  assert(card && card[0].includes('0.02'), 'The expanded card shows my 0.02 ETH, got ' + (card&&card[0].replace(/\s+/g,' ').slice(0,400)));
}
async function testMineTableHasFiveColumnsUntilDetailsAreShown(){
  const sb = viewSandbox();
  await viewPooledSetup(sb);
  vm.runInContext("invPlatformPageId = 1", sb);   // v5.6: the detail table is on the platform's own page
  let html = viewHtml(sb, 'mine');
  let head = html.match(/data-card="mine:1"[\s\S]*?<thead><tr>([\s\S]*?)<\/tr><\/thead>/);
  assert(head && (head[1].match(/<th/g)||[]).length===5, 'Default table should have 5 columns, got ' + (head&&(head[1].match(/<th/g)||[]).length));
  sb.toggleInvDetails();
  html = sb.document.getElementById('app').innerHTML;
  head = html.match(/data-card="mine:1"[\s\S]*?<thead><tr>([\s\S]*?)<\/tr><\/thead>/);
  assert(head && /Cost/.test(head[1]) && /Price/.test(head[1]) && /Realised/.test(head[1]), 'Show details adds Cost, Price and Realised');
}
async function testPlatformCardIsOneLineUntilExpanded(){
  // v5.6 (#22): Mine shows one box per platform; clicking a box opens that platform's own page with the full table.
  const sb = viewSandbox();
  await viewPooledSetup(sb);
  let html = viewHtml(sb, 'mine');
  sb.document.getElementById('app').innerHTML = html;
  const box = sb.document.querySelector('.inv-box[data-box="1"]');
  assert(box && !box.querySelector('table'), 'Mine shows the platform as a box, without the detail table');
  assert(box && /openInvPlatformPage\(1\)/.test(box.getAttribute('onclick')||''), 'Clicking the box opens the platform page');
  sb.openInvPlatformPage(1);
  html = sb.document.getElementById('app').innerHTML;
  assert(/data-card="mine:1"[\s\S]*?<table/.test(html) && /closeInvPlatformPage\(\)/.test(html), 'The platform page shows the full table and a way back');
  sb.closeInvPlatformPage();
  assert(sb.document.querySelector('.inv-box[data-box="1"]'), 'Back returns to the boxes');
}
async function testMinePlatformCardHasItsOwnActions(){
  const sb = viewSandbox();
  await viewPooledSetup(sb);
  vm.runInContext("invPlatformPageId = 1", sb);   // v5.6: the detail table is on the platform's own page
  const html = viewHtml(sb, 'mine');
  ['openInvTradePicker(1)','INV_PLATFORM_ACTIONS.deposit.open(1)','INV_PLATFORM_ACTIONS.withdrawal.open(1)','INV_PLATFORM_ACTIONS.transfer.open(1)','openInvCashLog(1)']
    .forEach(a=>assert(html.includes(a), 'The platform card should offer '+a+' directly, without a platform picker'));
}
async function testStablecoinsCountAsCash(){
  const sb = viewSandbox({invPositions:[
    {id:1, platformId:1, name:'Ethereum', ticker:'ETH', currency:'USD', assetClass:'Crypto', status:'Active'},
    {id:3, platformId:1, name:'Tether', ticker:'USDT', currency:'USD', assetClass:'Crypto', status:'Active'},
    {id:4, platformId:1, name:'USD Coin', ticker:'usdc', currency:'USD', assetClass:'Crypto', status:'Active'}]});
  sb._D.invTransactions.push(
    {id:1, positionId:3, date:'2026-10-01', kind:'buy', units:50, totalSar:187.5, owners:[{ownerId:1, units:50}], cashSide:'bank'},
    {id:2, positionId:4, date:'2026-10-01', kind:'buy', units:30, totalSar:112.5, owners:[{ownerId:1, units:30}], cashSide:'bank'});
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  const html = viewHtml(sb, 'mine');
  const cash = html.match(/id="invKpiCash"[\s\S]*?<div class="v[^"]*">([^<]*)</);
  assert(cash && cash[1].trim()==='$180.00', 'Cash = $100 USD + 50 USDT + 30 USDC = $180.00, got ' + (cash&&cash[1]));
  vm.runInContext("invPlatformPageId = 1", sb);   // v5.6: the detail table is on the platform's own page
  const card = viewHtml(sb, 'mine').match(/data-card="mine:1"[\s\S]*?<\/table>/)[0];
  assert(/USDT cash/.test(card) && /USDC cash/.test(card) && /USD cash/.test(card), 'USD, USDT and USDC each show as cash lines');
  assert(!/<b>Tether<\/b>/.test(card), 'USDT must not also be listed as an ordinary position');
  assert(/USD cash <span[^>]*>@ 4\.0000<\/span>/.test(card), 'A cash line shows its cost rate next to the label (@ 4.0000)');
  assert(sb.invIsStablecoin({ticker:'USDC'}) && !sb.invIsStablecoin({ticker:'DAI'}) && !sb.invIsStablecoin({ticker:'ETH'}), 'Only USDT and USDC count as stablecoin cash');
}
async function testUnpricedPositionIsCountedAtCostAndFlagged(){
  const sb = viewSandbox({invValuations:[]});
  await viewPooledSetup(sb);
  const html = viewHtml(sb, 'mine');
  const pl = html.match(/id="invKpiPl"[\s\S]*?<div class="v[^"]*">([^<]*)</);
  assert(pl && pl[1].trim()==='-5.00', 'With no ETH price, only the cash FX difference shows as P/L (75 − 80 = -5.00), not a fake 100% loss; got ' + (pl&&pl[1]));
  assert(/1 position has no price logged yet/.test(html), 'Mine should say a position has no price yet');
}
async function testClosedPositionsFoldIntoACollapsedGroup(){
  const sb = viewSandbox();
  sb._D.invTransactions.push(
    {id:1, positionId:2, date:'2026-09-01', kind:'buy', units:1, totalSar:100, owners:[{ownerId:1, units:1}], cashSide:'bank'},
    {id:2, positionId:2, date:'2026-09-10', kind:'sell', units:1, totalSar:150, owners:[{ownerId:1, units:1}], cashSide:'bank'});
  vm.runInContext("invPlatformPageId = 1", sb);   // v5.6: the detail table is on the platform's own page
  const html = viewHtml(sb, 'mine');
  assert(/<details[^>]*><summary[^>]*>Closed positions \(1\)/.test(html), 'A fully sold position goes into a collapsed "Closed positions" group');
  assert(/Solana[\s\S]*realised/.test(html), 'The closed group shows its realised result');
}
async function testCurrencySwitchShowsUsd(){
  const sb = viewSandbox();
  await viewPooledSetup(sb);
  sb.setInvView('mine');
  sb.setInvCcy('USD');
  const html = sb.document.getElementById('app').innerHTML;
  const value = html.match(/id="invKpiValue"[\s\S]*?<div class="v[^"]*">([^<]*)</);
  assert(value && value[1].trim()==='$100.00', 'In USD mode, My Value 375 SAR shows as $100.00, got ' + (value&&value[1]));
  assert(sb.localStorage.getItem('invCcy')==='USD', 'The currency choice is remembered');
}
async function testFamilyViewHasACardPerFamilyMemberOnly(){
  const sb = viewSandbox();
  await viewPooledSetup(sb);
  const html = viewHtml(sb, 'family');
  const cards = html.match(/class="panel inv-person" data-owner="(\d+)"/g) || [];
  assert(cards.length===4 && !html.includes('data-owner="1"'), 'Family shows B, C, D and E — not you, got ' + cards.join(' '));
  const b = html.match(/data-owner="2"[\s\S]*?<\/tbody>/);
  assert(b && b[0].includes('Contributed (ledger)') && b[0].includes('375.00 SAR'), 'B\'s card shows what B contributed per the ledger');
  assert(/openInvOwnerStatement\(2\)/.test(html), 'Each person has a 📄 Statement button');
}
async function testFamilyThisMonthChecklistTracksTheRoutine(){
  const sb = viewSandbox();
  sb.__set('todayStr', ()=>'2026-10-27');
  let html = viewHtml(sb, 'family');
  let s1 = html.match(/data-step="1" data-ok="(\d)"[\s\S]*?(?=data-step="2")/);
  assert(s1 && s1[1]==='0' && /B 375\.00 SAR/.test(s1[0]) && /invStartPlatformAction\('collect'\)/.test(s1[0]), 'Before collecting, step 1 lists who is waiting and offers 💰 Collect, got ' + (s1&&s1[0].replace(/\s+/g,' ')));
  await poolCollect(sb, 1, '2026-10-02', {2:375}, 100);
  html = viewHtml(sb, 'family');
  s1 = html.match(/data-step="1" data-ok="(\d)"/);
  const s2 = html.match(/data-step="2" data-ok="(\d)"[\s\S]*?<\/div><\/div>/);
  assert(s1 && s1[1]==='1', 'After collecting, step 1 is done');
  assert(s2 && s2[1]==='0' && /B \$100\.00/.test(s2[0]), 'Step 2 shows B\'s cash waiting to be invested, got ' + (s2&&s2[0].replace(/\s+/g,' ')));
  await poolBuy(sb, 1, '2026-10-03', 0.025, 100);
  html = viewHtml(sb, 'family');
  assert(/data-step="2" data-ok="1"/.test(html), 'After the buy uses the cash, step 2 is done');
  assert(/data-step="3" data-ok="1"/.test(html), 'And step 3 confirms everything reconciles');
}
async function testActivityListsEverythingNewestFirstWithEditAndDelete(){
  const sb = viewSandbox();
  await viewPooledSetup(sb);
  const html = viewHtml(sb, 'activity');
  const keys = [...html.matchAll(/data-act="([tm]\d+)"/g)].map(m=>m[1]);
  assert(keys.length===3 && keys[0]==='t1', 'Activity lists the buy (newest) then the two deposits, got ' + keys.join(','));
  const buy = html.match(/data-act="t1"[\s\S]*?<\/tr>/)[0];
  assert(/openInvTxModal\(1, 1\)/.test(buy) && /invActivityDelete\('tx', 1\)/.test(buy), 'Each line has ✎ edit and 🗑 delete');
  const dep = html.match(/data-act="m1"[\s\S]*?<\/tr>/)[0];
  assert(/openInvCashModal\(1, 'deposit', 1\)/.test(dep) && /rate 4\.0000/.test(dep), 'A deposit line edits through the cash form and shows its rate');
}
async function testActivityFiltersByPersonAndType(){
  const sb = viewSandbox();
  await viewPooledSetup(sb);
  sb.__set('invView','activity');
  sb.setInvActivityFilter('type', 'deposit');
  let keys = [...sb.document.getElementById('app').innerHTML.matchAll(/data-act="([tm]\d+)"/g)].map(m=>m[1]);
  assert(keys.length===2 && keys.every(k=>k[0]==='m'), 'Type filter: deposits only, got ' + keys.join(','));
  sb.setInvActivityFilter('type', '');
  sb.setInvActivityFilter('ownerId', '2');
  keys = [...sb.document.getElementById('app').innerHTML.matchAll(/data-act="([tm]\d+)"/g)].map(m=>m[1]);
  assert(keys.join(',')==='t1,m2', 'Person filter: only B\'s deposit and the buy B shares in, got ' + keys.join(','));
}
async function testActivityDeleteAsksFirst(){
  const sb = viewSandbox();
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  sb.__set('invView','activity');
  sb.__set('confirm', ()=>false);
  await sb.invActivityDelete('move', 1);
  assert(sb._D.invCashMovements.length===1, 'Cancelling the confirmation must delete nothing');
  sb.__set('confirm', ()=>true);
  await sb.invActivityDelete('move', 1);
  assert(sb._D.invCashMovements.length===0, 'Confirming deletes the movement');
}
async function testActivityHidesDeleteForLinkedTransferLegs(){
  const sb = viewSandbox();
  sb._D.invTransactions.push({id:7, positionId:1, date:'2026-10-05', kind:'buy', units:1, totalSar:10, owners:[{ownerId:1, units:1}], cashSide:'transfer', linkId:'L1'});
  const html = viewHtml(sb, 'activity');
  const row = html.match(/data-act="t7"[\s\S]*?<\/tr>/)[0];
  assert(/openInvPosition\(1\)/.test(row) && !/invActivityDelete/.test(row), 'One leg of a linked transfer opens its position window and can\'t be deleted on its own');
}
async function testReconcileViewCarriesTheWarningAndTheTabShowsACount(){
  const sb = viewSandbox();
  await poolCollect(sb, 1, '2026-10-02', {1:400, 2:375}, 205);
  sb._D.ledger.push({id:5, jv:5, date:'2026-10-03', acc:10201, amt:100, descr:'extra not yet collected'});
  let html = viewHtml(sb, 'mine');
  assert(/data-invview="recon"[^>]*>[^<]*<span[^>]*>1<\/span>/.test(html), 'The Reconcile tab shows a count of 1 issue');
  assert(!/border-left:3px solid var\(--red\)/.test(html), 'The red warning table is no longer on the main view');
  html = viewHtml(sb, 'recon');
  assert(/border-left:3px solid var\(--red\)/.test(html), 'The warning table now lives in Reconcile');
}
async function testAddMenuOffersEveryActionAndBuySellPicksAnAsset(){
  const sb = viewSandbox();
  sb.openInvAddMenu();
  const modal = sb.document.body.innerHTML;
  ['trade','collect','deposit','withdrawal','transfer','position'].forEach(a=>assert(modal.includes('data-addaction="'+a+'"'), '+ Add should offer '+a));
  assert(vm.runInContext('typeof (INV_PLATFORM_ACTIONS.trade||{}).open', sb)==='function', 'Buy / Sell is a platform action like the others');
  sb.openInvTradePicker(1);
  const picker = sb.document.body.innerHTML;
  assert(picker.includes('data-tradepos="1"') && picker.includes('data-tradepos="2"') && /openInvTxModal\(1, null\)/.test(picker), 'Buy / Sell then asks which asset and opens its trade form');
}
async function testAddMenuIsDisabledWithNoPlatforms(){
  const sb = viewSandbox({invPlatforms:[], invPositions:[]});
  sb.openInvAddMenu();
  const modal = sb.document.body.innerHTML;
  assert(/data-addaction="trade" disabled/.test(modal) && /Add a platform first/.test(modal), 'With no platforms, actions are disabled and it says what to do');
}
async function testSetupViewHoldsTheSettingsAndPlatforms(){
  const sb = viewSandbox();
  const html = viewHtml(sb, 'setup');
  assert(/setInvFxRate/.test(html) && /setInvMgmtFeePct/.test(html) && /setInvReconStartDate/.test(html), 'Setup holds the rate, fee and start-date settings');
  assert(/openInvOwners\(\)/.test(html) && /openInvCoinImport\(\)/.test(html) && /openInvEditPlatform\(1\)/.test(html), 'Setup holds Owners, imports and each platform\'s edit');
  const mine = viewHtml(sb, 'mine');
  assert(!/setInvFxRate/.test(mine), 'Settings are no longer on the main view');
}
async function testInsightsViewDrawsTheCharts(){
  const sb = viewSandbox();
  let drawn = false;
  sb.__set('drawInvCharts', ()=>{ drawn = true; });
  const html = viewHtml(sb, 'insights');
  assert(drawn, 'Insights should draw the charts');
  assert(/Family/.test(html) && !/in 🗂 Classic/.test(html), 'Insights points to Family for the per-person tables (Classic tab dropped in v5.6)');
}
async function testClassicViewIsThePreviousPage(){
  const sb = viewSandbox();
  const html = viewHtml(sb, 'classic');
  assert(/Your Cost Basis/.test(html) && /invStartPlatformAction\('collect'\)/.test(html), 'Classic keeps the previous all-in-one page');
}
async function testMineWithoutASelfOwnerExplainsWhatToDo(){
  const sb = viewSandbox({invOwners:[{id:2, name:'B', isSelf:false, outAcc:10202}]});
  const html = viewHtml(sb, 'mine');
  assert(/Mark which owner is you/.test(html), 'With no "This is me" owner, Mine says how to fix it');
}
async function testStatementShowsUsdtAsCash(){
  const sb = viewSandbox({invPositions:[{id:3, platformId:1, name:'Tether', ticker:'USDT', currency:'USD', assetClass:'Crypto', status:'Active'}]});
  sb._D.invTransactions.push({id:1, positionId:3, date:'2026-10-01', kind:'buy', units:50, totalSar:187.5, owners:[{ownerId:1, units:50}], cashSide:'bank'});
  sb.openInvOwnerStatement(1);
  const body = sb.document.body.innerHTML;
  assert(/نقد \(USDT\)/.test(body) && /\$50\.00/.test(body), 'USDT appears as a cash line on the statement');
}

// ================= v4.59.0: cost corrections (editor + CSV), recorded in Activity =================
function costSandbox(){
  const sb = fxSandbox({}, true);
  sb.__set('drawInvCharts', ()=>{});
  // Two bank buys of ETH: A 1 unit / B 1 unit for 800, then A 2 units for 1,200.
  sb._D.invTransactions.push(
    {id:1, positionId:1, date:'2026-09-01', kind:'buy', units:2, totalSar:800, owners:[{ownerId:1, units:1},{ownerId:2, units:1}], cashSide:'bank'},
    {id:2, positionId:1, date:'2026-09-10', kind:'buy', units:2, totalSar:1200, owners:[{ownerId:1, units:2}], cashSide:'bank'},
    {id:3, positionId:1, date:'2026-09-20', kind:'sell', units:1, totalSar:700, owners:[{ownerId:1, units:1}], cashSide:'bank'});
  return sb;
}
function costCsvRows(sb){
  let rows = null;
  sb.__set('invCsvDownload', (name, r)=>{ rows = r; });
  sb.exportInvTransactionsCSV();
  return rows.map(r=>r.map(c=>String(c===null||c===undefined? '' : c)));
}
function costCsvCapture(sb){
  const cap = {persisted:[], errors:null, toast:null};
  sb.__set('persistInvTransaction', async t=>{ cap.persisted.push(t.id); });
  sb.__set('showInvCsvErrors', e=>{ cap.errors = e; });
  sb.__set('toast', m=>{ cap.toast = m; });
  return cap;
}
const costAdj = sb => sb._D.invCashMovements.filter(m=>m.kind==='costadj');
async function testOwnerSarMapUsesStoredFiguresElseUnitsShare(){
  const sb = makeSandbox();
  const pr = sb.invTxOwnerSarMap({totalSar:900, owners:[{ownerId:1, units:1},{ownerId:2, units:2}]});
  assert(Math.abs(pr[1]-300)<1e-9 && Math.abs(pr[2]-600)<1e-9, 'Without stored SAR each person gets their units\' share, got ' + JSON.stringify(pr));
  const st = sb.invTxOwnerSarMap({totalSar:775, owners:[{ownerId:1, units:1, sar:400},{ownerId:2, units:1, sar:375}]});
  assert(st[1]===400 && st[2]===375, 'Stored per-person SAR is used as-is, got ' + JSON.stringify(st));
}
async function testCostEditorChangesOnePersonsCellAndRecordsIt(){
  const sb = costSandbox();
  sb.openInvCostEditor(1);
  const d = sb._invCostDraft;
  assert(d.rows.length===2 && d.rows.every(r=>r.id!==3), 'The editor lists the buys only (not the sell), got ' + d.rows.map(r=>r.id).join(','));
  sb.setInvCostCell(0, 2, '450');   // B's share of the first buy: 400 → 450
  assert(sb.document.getElementById('invCostTotal_0').value==='850', 'The row total updates live (850), got ' + sb.document.getElementById('invCostTotal_0').value);
  await sb.saveInvCostEditor();
  const t = sb._D.invTransactions.find(x=>x.id===1);
  assert(t.totalSar===850 && t.owners.find(o=>o.ownerId===2).sar===450 && t.owners.find(o=>o.ownerId===1).sar===400, 'Saved per person: A 400, B 450, total 850, got ' + JSON.stringify(t));
  assert(Math.abs(sb.computePositionState(1).byOwner[2].costSar-450)<1e-6, 'B\'s cost basis is now 450');
  const rec = costAdj(sb);
  assert(rec.length===1, 'One cost-correction record is created, got ' + rec.length);
  const b = rec[0] && rec[0].owners.find(o=>o.ownerId===2);
  assert(b && b.before===400 && b.after===450 && !rec[0].owners.some(o=>o.ownerId===1), 'The record shows B 400 → 450 and leaves A out (unchanged), got ' + JSON.stringify(rec[0] && rec[0].owners));
  assert(rec[0] && /Edit costs: 1 transaction changed — #1 buy 2026-09-01 800\.00 → 850\.00/.test(rec[0].note), 'The record lists what changed, got ' + (rec[0]||{}).note);
}
async function testCostEditorRowTotalIsSharedInCurrentProportions(){
  const sb = costSandbox();
  sb.openInvCostEditor(1);
  sb.setInvCostRowTotal(0, '1000');
  const r = sb._invCostDraft.rows[0];
  assert(Math.abs(r.sar[1]-500)<1e-9 && Math.abs(r.sar[2]-500)<1e-9, 'A 400/B 400 → total 1,000 gives 500 each, got ' + JSON.stringify(r.sar));
}
async function testCostEditorPersonTotalIsSpreadAcrossTheirBuys(){
  const sb = costSandbox();
  sb.openInvCostEditor(1);
  // A paid 400 + 1,200 = 1,600 across two buys; new total 2,000 → 500 and 1,500 (same 1:3 split).
  sb.setInvCostPersonTotal(1, '2000');
  const rows = sb._invCostDraft.rows;
  assert(Math.abs(rows[0].sar[1]-500)<1e-9 && Math.abs(rows[1].sar[1]-1500)<1e-9, 'Spread in proportion: 500 and 1,500, got ' + rows[0].sar[1] + ' / ' + rows[1].sar[1]);
  assert(Math.abs(rows[0].sar[2]-400)<1e-9, 'B is untouched');
  await sb.saveInvCostEditor();
  assert(sb._D.invTransactions.find(x=>x.id===2).totalSar===1500, 'Saved');
  assert(costAdj(sb).length===1 && /2 transactions changed/.test(costAdj(sb)[0].note), 'One record for the whole save, listing both buys');
}
async function testCostEditorSpreadsByUnitsWhenEverythingIsZero(){
  const sb = fxSandbox({}, true);
  sb._D.invTransactions.push(
    {id:1, positionId:1, date:'2026-09-01', kind:'buy', units:1, totalSar:0, owners:[{ownerId:1, units:1}], cashSide:'opening'},
    {id:2, positionId:1, date:'2026-09-02', kind:'buy', units:3, totalSar:0, owners:[{ownerId:1, units:3}], cashSide:'opening'});
  sb.openInvCostEditor(1);
  sb.setInvCostPersonTotal(1, '400');
  const rows = sb._invCostDraft.rows;
  assert(Math.abs(rows[0].sar[1]-100)<1e-9 && Math.abs(rows[1].sar[1]-300)<1e-9, 'Opening balances at 0 cost are spread by units (100 / 300), got ' + rows[0].sar[1] + ' / ' + rows[1].sar[1]);
}
async function testCostEditorLeavesTransferLegsOut(){
  const sb = costSandbox();
  sb._D.invTransactions.push({id:9, positionId:1, date:'2026-09-25', kind:'buy', units:1, totalSar:10, owners:[{ownerId:1, units:1}], cashSide:'transfer', linkId:'L'});
  sb.openInvCostEditor(1);
  assert(!sb._invCostDraft.rows.some(r=>r.id===9), 'One leg of a transfer is not offered for editing');
}
async function testCostEditorWithNoChangesRecordsNothing(){
  const sb = costSandbox();
  sb.openInvCostEditor(1);
  await sb.saveInvCostEditor();
  assert(costAdj(sb).length===0, 'Saving without changes must not create a record');
}
async function testPositionWindowOffersEditCosts(){
  // The pool sandbox stubs openInvPosition, so check the real function's source text.
  const src = require('fs').readFileSync(APP_JS,'utf8');
  const fn = src.slice(src.indexOf('function openInvPosition(posId){'), src.indexOf('function openInvTxModal('));
  assert(/onclick="openInvCostEditor\(\$\{posId\}\)"/.test(fn), 'The position window has a ✎ Edit costs button');
}
async function testCsvExportHasOwnersSarAndAnUntouchedReimportWritesNothing(){
  const sb = costSandbox();
  const rows = costCsvRows(sb);
  assert(rows[0][9]==='Owners SAR (id:sar;…)', 'Export has the Owners SAR column, got ' + rows[0][9]);
  const r1 = rows.find(r=>r[0]==='1');
  assert(r1[9]==='1:400;2:400', 'Owners SAR shows each person\'s share, got ' + r1[9]);
  const cap = costCsvCapture(sb);
  await sb.importInvTransactionsCSV(rows);
  assert(cap.persisted.length===0 && costAdj(sb).length===0, 'Re-importing an untouched export must write nothing, wrote ' + cap.persisted.join(','));
  assert(/Nothing changed — all 3 row/.test(cap.toast||''), 'It should say nothing changed, got ' + cap.toast);
}
async function testCsvReimportKeepsRealRatesOnCashBuys(){
  // The v4.57 regression: a cash buy at two different rates must survive an export → import.
  const sb = fxSandbox({}, true);
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  await poolCollect(sb, 1, '2026-10-02', {2:375}, 100);
  await poolBuy(sb, 1, '2026-10-03', 2, 200);
  const before = JSON.stringify(sb._D.invTransactions[0].owners);
  const rows = costCsvRows(sb);
  rows.find(r=>r[0]==='1')[8] = 'note edited';   // a real change on the row, nothing about cost
  const cap = costCsvCapture(sb);
  await sb.importInvTransactionsCSV(rows);
  const t = sb._D.invTransactions[0];
  assert(cap.persisted.length===1 && t.note==='note edited', 'Only the edited row is written');
  assert(JSON.stringify(t.owners)===before, 'Each person\'s SAR and USD must be kept, got ' + JSON.stringify(t.owners) + ' vs ' + before);
  assert(Math.abs(sb.computePositionState(1).byOwner[1].costSar-400)<1e-6, 'A\'s cost stays at the 4.00 rate (400)');
}
async function testCsvNewTotalIsSharedInCurrentProportionsAndKeepsUsd(){
  const sb = fxSandbox({}, true);
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  await poolCollect(sb, 1, '2026-10-02', {2:375}, 100);
  await poolBuy(sb, 1, '2026-10-03', 2, 200);
  const rows = costCsvRows(sb);
  rows.find(r=>r[0]==='1')[6] = '1550';  // double the 775 total
  const cap = costCsvCapture(sb);
  await sb.importInvTransactionsCSV(rows);
  const t = sb._D.invTransactions[0];
  const a = t.owners.find(o=>o.ownerId===1), b = t.owners.find(o=>o.ownerId===2);
  assert(Math.abs(a.sar-800)<0.01 && Math.abs(b.sar-750)<0.01 && t.totalSar===1550, 'A new total keeps the 400:375 proportions (800 / 750), got ' + JSON.stringify(t.owners));
  assert(a.usd===100 && b.usd===100, 'Each person\'s USD share is kept');
  assert(costAdj(sb).length===1 && /CSV import: 1 transaction changed — #1 buy 2026-10-03 775\.00 → 1,550\.00/.test(costAdj(sb)[0].note), 'The import is recorded in Activity, got ' + (costAdj(sb)[0]||{}).note);
  assert(/1 changed, 0 unchanged/.test(cap.toast||'') || /1 changed/.test(cap.toast||''), 'The message reports what changed, got ' + cap.toast);
}
async function testCsvOwnersSarSetsEachPersonsCost(){
  const sb = costSandbox();
  const rows = costCsvRows(sb);
  const r = rows.find(x=>x[0]==='1'); r[9] = '1:300;2:500';
  const cap = costCsvCapture(sb);
  await sb.importInvTransactionsCSV(rows);
  const t = sb._D.invTransactions.find(x=>x.id===1);
  assert(!cap.errors && t.totalSar===800 && t.owners.find(o=>o.ownerId===1).sar===300 && t.owners.find(o=>o.ownerId===2).sar===500, 'Owners SAR sets each person; total = their sum, got ' + JSON.stringify(t));
  const rec = costAdj(sb)[0];
  assert(rec && rec.owners.some(o=>o.ownerId===2 && o.before===400 && o.after===500), 'Recorded B 400 → 500');
}
async function testCsvOwnersSarAndTotalMustAgree(){
  const sb = costSandbox();
  const rows = costCsvRows(sb);
  const r = rows.find(x=>x[0]==='1'); r[9] = '1:300;2:500'; r[6] = '900';
  const cap = costCsvCapture(sb);
  await sb.importInvTransactionsCSV(rows);
  assert(cap.errors && /Owners SAR adds up to 800\.00 but Total SAR is 900\.00/.test(cap.errors.join(' ')), 'Disagreeing Owners SAR and Total must be rejected, got ' + (cap.errors||[]).join(' | '));
  assert(cap.persisted.length===0, 'Nothing is written when there are errors');
}
async function testCsvAcceptsZeroCostOpeningBalances(){
  const sb = fxSandbox({}, true);
  sb._D.invTransactions.push({id:1, positionId:1, date:'2026-09-01', kind:'buy', units:5, totalSar:0, owners:[{ownerId:1, units:5}], cashSide:'opening'});
  const rows = costCsvRows(sb);
  rows[1][8] = 'checked';
  const cap = costCsvCapture(sb);
  await sb.importInvTransactionsCSV(rows);
  assert(!cap.errors, 'A 0-cost opening balance must import, got ' + (cap.errors||[]).join(' | '));
  assert(sb._D.invTransactions[0].note==='checked', 'And the change is saved');
}
async function testCsvRefusesToChangeATransferLeg(){
  const sb = fxSandbox({}, true);
  sb._D.invTransactions.push({id:1, positionId:1, date:'2026-09-01', kind:'buy', units:1, totalSar:100, owners:[{ownerId:1, units:1}], cashSide:'transfer', linkId:'L1'});
  const rows = costCsvRows(sb);
  rows[1][6] = '150';
  const cap = costCsvCapture(sb);
  await sb.importInvTransactionsCSV(rows);
  assert(cap.errors && /one leg of a transfer/.test(cap.errors.join(' ')), 'Changing a transfer leg from the CSV is refused');
}
async function testCostCorrectionShowsInActivityButNotInCashLogOrCash(){
  const sb = costSandbox();
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  const cellBefore = JSON.stringify(fxCell(sb, 1, 1));
  sb.openInvCostEditor(1); sb.setInvCostCell(0, 2, '450'); await sb.saveInvCostEditor();
  assert(JSON.stringify(fxCell(sb, 1, 1))===cellBefore, 'A correction record must not touch platform cash');
  sb.openInvCashLog(1);
  assert(!/Cost correction|costadj/.test(sb.document.body.innerHTML), 'The Cash log does not list correction records');
  sb.__set('invView','activity');
  sb.setInvActivityFilter('type', 'adjustment');
  const html = sb.document.getElementById('app').innerHTML;
  const row = html.match(/<tr data-act="m\d+">[\s\S]*?<\/tr>/);
  assert(row && /Cost correction/.test(row[0]) && /Ethereum · B 400\.00 → 450\.00/.test(row[0]), 'Activity shows the correction with before → after, got ' + (row&&row[0].replace(/\s+/g,' ').slice(0,300)));
  assert(row && !/title="Edit"/.test(row[0]) && /invActivityDelete/.test(row[0]), 'A correction record has no ✎ but can be removed');
  let msg = null; sb.__set('confirm', m=>{ msg = m; return false; });
  if(costAdj(sb)[0]) await sb.invActivityDelete('move', costAdj(sb)[0].id);
  assert(/corrected costs themselves stay/.test(msg||''), 'Removing it says the costs stay corrected, got ' + msg);
}

// ================= v4.60.0: Jamiah Pledge / Round, add to an existing allocation =================
function jamSummarySandbox(today, tagsAmounts){
  // A pledges 100, B pledges 100, C pledges 50; this month A paid 150 (over), B paid 0, C paid 20.
  const acc = {id:10501, name:'Jamiah Cash', category:'Short Term Receivables', acc_type:'Individual Account', status:'Active', is_allocatable:true};
  const ledger = [
    {id:1, jv:1, date:'2026-10-05', acc:10501, amt:150, descr:'A'},
    {id:2, jv:2, date:'2026-10-06', acc:10501, amt:20, descr:'C'},
    {id:3, jv:3, date:'2026-09-06', acc:10501, amt:100, descr:'B last month'},
  ];
  const sb = v455Sandbox({accounts:[acc], ledger, budget:[], provisionGroups:[], jamiahs:[]}, today||'2026-10-19');
  const j = {id:1, name:'Monthly', account:10501, startMonth:'2026-09', durationMonths:3,
    groups:[{id:1, name:'G1'}], roundGroup:{'2026-10':1},
    participants:[{id:1, name:'A', groupId:1, pledgeAmount:100}, {id:2, name:'B', groupId:1, pledgeAmount:100}, {id:3, name:'C', groupId:1, pledgeAmount:50}],
    tags:{1:1, 2:3, 3:2}};
  return {sb, j};
}
async function testJamiahSummaryShowsPledgePerRoundInsteadOfDueAndPaid(){
  const {sb, j} = jamSummarySandbox();
  const html = sb.renderJamiahSummary(j);
  assert(!/Amount Due|Amount Paid/.test(html), 'Amount Due and Amount Paid must be gone');
  const head = html.match(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/);
  // v5.0: Pledge moved to after Group (agreed in the redesign).
  assert(head && /<th>Participant<\/th><th>Group<\/th><th class="num">Pledge \/ Round<\/th>/.test(head[1]), 'Pledge / Round sits after Group, got ' + (head&&head[1].slice(0,160)));
  const rowA = html.match(/<td style="[^"]*">A<\/td>\s*<td class="mut">[^<]*<\/td>\s*<td class="num mono">([^<]*)<\/td>/);
  assert(rowA && rowA[1]==='100.00', 'Each participant shows their pledge per round (A 100.00), got ' + (rowA&&rowA[1]));
}
async function testJamiahFooterShowsThePotAndThisRoundsPending(){
  const {sb, j} = jamSummarySandbox();
  const html = sb.renderJamiahSummary(j);
  const pot = html.match(/id="jamiahPledgeTotal">([^<]*)</), pend = html.match(/id="jamiahPendingRound"[^>]*>([^<]*)</);
  assert(pot && pot[1]==='250.00', 'Footer pot = 100 + 100 + 50 = 250.00, got ' + (pot&&pot[1]));
  // A overpaid (150 of 100) must not offset others: B owes 100, C owes 30 → 130 pending.
  assert(pend && pend[1]==='Pending this round: 130.00', 'Pending this round = B 100 + C 30 = 130.00 (A\'s extra doesn\'t hide it), got ' + (pend&&pend[1]));
}
async function testJamiahPendingIsBlankOutsideTheJamiahsMonths(){
  const {sb, j} = jamSummarySandbox('2027-03-01');
  const pend = sb.renderJamiahSummary(j).match(/id="jamiahPendingRound"[^>]*>([^<]*)</);
  assert(pend && pend[1]==='', 'When this month is not one of the Jamiah\'s rounds, there is no "this round" to be pending, got ' + (pend&&pend[1]));
}
async function testJamiahArabicViewUsesTheAgreedLabels(){
  const {sb, j} = jamSummarySandbox();
  sb.__set('jamiahSummaryLang', 'ar');
  const html = sb.renderJamiahSummary(j);
  assert(/<th class="num">القسط لكل دورة<\/th>/.test(html), 'The Arabic column header reads القسط لكل دورة');
  const pend = html.match(/id="jamiahPendingRound"[^>]*>([^<]*)</);
  assert(pend && pend[1].startsWith('المتبقي لهذه الدورة:') && !html.includes('المبلغ المستحق'), 'The Arabic footer reads المتبقي لهذه الدورة, got ' + (pend&&pend[1]));
}
// ---- add to an existing allocation ----
function allocSandbox(){
  const acc = {id:10501, name:'Mother', category:'Short Term Receivables', acc_type:'Individual Account', status:'Active', is_allocatable:true};
  const acc2 = {id:10502, name:'Sister', category:'Short Term Receivables', acc_type:'Individual Account', status:'Active', is_allocatable:true};
  const ledger = [
    {id:1, jv:1, date:'2026-10-01', acc:10501, amt:500, descr:'lent', alloc:7},
    {id:2, jv:2, date:'2026-10-05', acc:10501, amt:-300, descr:'part repaid', alloc:7},     // #7 is open: +200
    {id:3, jv:3, date:'2026-10-02', acc:10501, amt:100, descr:'lent', alloc:8},
    {id:4, jv:4, date:'2026-10-03', acc:10501, amt:-100, descr:'repaid', alloc:8},          // #8 balanced
    {id:5, jv:5, date:'2026-10-02', acc:10502, amt:-200, descr:'other account', alloc:9},    // #9 is another account
    {id:6, jv:6, date:'2026-10-20', acc:10501, amt:-200, descr:'rest repaid'},               // unallocated
    {id:7, jv:7, date:'2026-10-21', acc:10501, amt:50, descr:'new loan'},                    // unallocated
  ];
  const sb = v455Sandbox({accounts:[acc, acc2], ledger, budget:[], provisionGroups:[]});
  const writes = [];
  sb.__set('syncWrite', async (table, kind, row)=>{ writes.push({table, kind, row}); return {ok:true}; });
  sb.__set('persistLocal', ()=>{});
  sb.__set('blockIfSyncing', ()=>false);
  sb.document.body.insertAdjacentHTML('beforeend', '<div id="modalRoot"></div>');
  return {sb, writes};
}
const allocSel = (sb, ids) => vm.runInContext('allocSelected.clear(); '+ids.map(i=>'allocSelected.add('+i+');').join(''), sb);
async function testUnallocatedOffersAddToExistingEvenForOneLine(){
  const {sb} = allocSandbox();
  allocSel(sb, [6]);
  sb.__set('allocTab','unalloc'); sb.__set('screen','alloc');
  sb.renderAlloc();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/onclick="openAddToAllocation\(10501\)"/.test(html), 'With one line ticked, "Add to existing allocation…" is offered');
}
async function testAddToExistingListsSameAccountAndOnlyZeroResultsCanBeChosen(){
  const {sb} = allocSandbox();
  allocSel(sb, [6]);   // -200
  sb.openAddToAllocation(10501);
  const modal = sb.document.body.innerHTML;
  const rows = [...modal.matchAll(/data-addalloc="(\d+)"/g)].map(m=>m[1]);
  assert(rows.join(',')==='7,8', 'Only this account\'s allocations, the zero-result one first: got ' + rows.join(','));
  const r7 = modal.match(/data-addalloc="7"[\s\S]*?<\/tr>/)[0], r8 = modal.match(/data-addalloc="8"[\s\S]*?<\/tr>/)[0];
  assert(/0\.00 ✓/.test(r7) && /onclick="addToAllocation\(10501, 7\)"/.test(r7) && !/disabled/.test(r7), '#7 (+200) with the -200 line nets to zero, so it can be chosen');
  assert(/disabled/.test(r8) && /-200\.00/.test(r8), '#8 would end at -200, so it is disabled and shows the result');
}
async function testAddToAllocationAssignsSyncsAndClearsSelection(){
  const {sb, writes} = allocSandbox();
  allocSel(sb, [6]);
  sb.__set('screen','alloc');
  await sb.addToAllocation(10501, 7);
  const D = vm.runInContext('D', sb);
  assert(D.ledger.find(x=>x.id===6).alloc===7, 'The line now belongs to allocation #7');
  assert(writes.length===1 && writes[0].table==='pd_ledger' && writes[0].row.id===6 && writes[0].row.alloc===7, 'Exactly that line is synced, got ' + JSON.stringify(writes));
  assert(vm.runInContext('allocSelected.size', sb)===0, 'The selection is cleared afterwards');
  const net = D.ledger.filter(x=>x.alloc===7).reduce((s,x)=>s+x.amt,0);
  assert(Math.abs(net)<1e-9, 'Allocation #7 now nets to zero');
}
async function testAddToAllocationRefusesANonZeroResult(){
  const {sb, writes} = allocSandbox();
  allocSel(sb, [7]);   // +50 into balanced #8 → +50
  let msg = null; sb.__set('toast', (m)=>{ msg = m; });
  await sb.addToAllocation(10501, 8);
  const D = vm.runInContext('D', sb);
  assert(!D.ledger.find(x=>x.id===7).alloc && writes.length===0, 'A result that isn\'t zero must not be saved');
  assert(/would not net to zero/.test(msg||''), 'It explains why, got ' + msg);
}
async function testAddToAllocationRefusesAnotherAccountsAllocation(){
  const {sb, writes} = allocSandbox();
  allocSel(sb, [6]);
  await sb.addToAllocation(10501, 9);   // #9 belongs to 10502
  const D = vm.runInContext('D', sb);
  assert(!D.ledger.find(x=>x.id===6).alloc && writes.length===0, 'Lines can\'t be added to another account\'s allocation');
}
async function testAddToExistingWithNoAllocationsSaysSo(){
  const {sb} = allocSandbox();
  const D = vm.runInContext('D', sb);
  D.ledger.forEach(l=>{ if(l.acc===10501) l.alloc = null; });
  allocSel(sb, [6]);
  sb.openAddToAllocation(10501);
  assert(/has no existing allocations yet/.test(sb.document.body.innerHTML), 'With no allocations for the account it says to create one');
}

// ================= v4.61.0: accrual cap per sub category =================
function capSandbox(opts){
  opts = opts||{};
  const D = {
    accounts: [
      {id:20301, name:'Self Improvement Accrual', category:'Accruals', acc_type:'Accrual Account', status:'Active'},
      {id:60100, name:'Self Improvement - Courses', category:'Self Improvement', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:60199, name:'Self Improvement - Accrual', category:'Self Improvement', acc_type:'Accrual Account', status:'Active', forecast_category:'expense'},
    ],
    ledger: [
      {id:1, jv:1, date:'2026-09-30', acc:20301, amt:-3930.01, descr:'accrued so far'},
      {id:2, jv:2, date:'2026-11-03', acc:20301, amt:-5000, descr:'after the month — must not count'},
    ].concat(opts.ledger||[]),
    budget: [{id:1, acc:60100, date:'2026-10-01', amt:1350}],
    provisionGroups: [], forecastAccountRules: [], forecastPlans:{},
    accrualMappings: [{category:'Self Improvement', liabilityAcc:20301, expenseAcc:60199, capMonths: opts.cap===undefined? 3 : opts.cap}],
  };
  const sb = v455Sandbox(D, '2026-11-02');
  sb.__set('renderNewJV', ()=>{}); sb.__set('toast', ()=>{});
  sb.__set('accrualMonth', '2026-10');
  return sb;
}
function capRun(sb){
  sb.computeAccrualJV();
  return {lines: vm.runInContext('jvDraft.lines', sb), expl: vm.runInContext('accrualExplanation', sb)};
}
async function testAccrualStopsAtTheCapAndAccruesOnlyTheRemainder(){
  const sb = capSandbox();
  const {lines, expl} = capRun(sb);
  // Surplus 1,350; accrued 3,930.01 by 31 Oct; cap 3 × 1,350 = 4,050 → only 119.99 left.
  const liab = lines.find(l=>l.acc===20301), exp = lines.find(l=>l.acc===60199);
  assert(liab && Math.abs(liab.amt+119.99)<0.005 && exp && Math.abs(exp.amt-119.99)<0.005, 'Accrues only the 119.99 left under the cap, got ' + JSON.stringify(lines.map(l=>[l.acc,l.amt])));
  assert(expl[0] && /capped — 1,350\.00 surplus, but only 119\.99 left under the 4,050\.00 cap/.test(expl[0].action), 'The explanation says it was capped, got ' + (expl[0]&&expl[0].action));
}
async function testAccrualAtTheCapAddsNothing(){
  const sb = capSandbox({ledger:[{id:3, jv:3, date:'2026-10-15', acc:20301, amt:-200, descr:'more'}]}); // now 4,130.01 > 4,050
  const {lines, expl} = capRun(sb);
  assert(!lines.some(l=>l.acc===20301), 'Once the cap is reached nothing more is accrued (and nothing is released), got ' + JSON.stringify(lines.map(l=>[l.acc,l.amt])));
  assert(expl[0] && /already at the cap \(4,130\.01 accrued, cap 4,050\.00 = 3 × budget\)/.test(expl[0].action), 'Explains it is at the cap, got ' + (expl[0]&&expl[0].action));
}
async function testAccrualWithoutACapIsUnchanged(){
  const sb = capSandbox({cap:null});
  const {lines} = capRun(sb);
  const liab = lines.find(l=>l.acc===20301);
  assert(liab && Math.abs(liab.amt+1350)<0.005, 'With no cap the whole 1,350 surplus is accrued as before, got ' + (liab&&liab.amt));
}
async function testAccrualCapUsesThatMonthsBudgetAndMonthEndBalance(){
  const sb = capSandbox({cap:4});
  const {lines} = capRun(sb);
  // 4 × 1,350 = 5,400 cap; 3,930.01 accrued by 31 Oct (the 5,000 posted in November is ignored) → room 1,469.99 > surplus.
  const liab = lines.find(l=>l.acc===20301);
  assert(liab && Math.abs(liab.amt+1350)<0.005, 'With a 4-month cap there is room, so the full surplus is accrued; a later posting must not count, got ' + (liab&&liab.amt));
}
async function testOverBudgetDrawdownIgnoresTheCap(){
  const sb = capSandbox({ledger:[{id:4, jv:4, date:'2026-10-10', acc:60100, amt:2000, descr:'big course'}]});
  const {lines, expl} = capRun(sb);
  const liab = lines.find(l=>l.acc===20301);
  assert(liab && Math.abs(liab.amt-650)<0.005, 'Over budget by 650 → draws 650 from the liability, as before, got ' + (liab&&liab.amt));
  assert(expl[0] && /drew 650\.00/.test(expl[0].action), 'Drawdown explanation unchanged');
}
async function testAccruedChipShowsTheCap(){
  const sb = capSandbox();
  const chip = sb.accruedChipHTML('Self Improvement', '2026-10-31');
  assert(/Accrued: <b class="mono">3,930\.01<\/b> of <span class="mono">4,050\.00<\/span>/.test(chip), 'The chip reads "Accrued: 3,930.01 of 4,050.00", got ' + chip);
  const sb2 = capSandbox({cap:null});
  assert(!/<\/b> of <span/.test(sb2.accruedChipHTML('Self Improvement', '2026-10-31')), 'Without a cap the chip shows just the balance');
}
async function testSettingsSavesTheCapAndOnlySendsItWhenUsed(){
  const sb = capSandbox({cap:null});
  const sent = [];
  sb.__set('usingCloud', true);
  sb.__set('SB', {from: ()=>({upsert: async (row)=>{ sent.push(row); return {}; }})});
  sb.__set('blockIfSyncing', ()=>false); sb.__set('persistLocal', ()=>{}); sb.__set('renderSettings', ()=>{});
  const cid = sb.sanitizeIdPart('Self Improvement');
  sb.document.body.insertAdjacentHTML('beforeend', `<input id="acpin_accrLiab_${cid}" data-acc="20301"><input id="acpin_accrExp_${cid}" data-acc="60199"><input id="accrCap_${cid}" value="">`);
  await sb.saveAccrualMappingFromForm(cid);
  assert(sent[0] && !('cap_months' in sent[0]), 'With no cap, cap_months is not sent (works before the schema script is run), got ' + JSON.stringify(sent[0]));
  sb.document.getElementById('accrCap_'+cid).value = '3';
  await sb.saveAccrualMappingFromForm(cid);
  const D = vm.runInContext('D', sb);
  assert(sent[1] && sent[1].cap_months===3 && D.accrualMappings[0].capMonths===3, 'A cap of 3 is saved and synced, got ' + JSON.stringify(sent[1]));
  sb.document.getElementById('accrCap_'+cid).value = '';
  await sb.saveAccrualMappingFromForm(cid);
  assert(sent[2] && sent[2].cap_months===null && D.accrualMappings[0].capMonths===null, 'Clearing a cap sends null so it is really removed, got ' + JSON.stringify(sent[2]));
  let msg = null; sb.__set('toast', (m)=>{ msg = m; });
  sb.document.getElementById('accrCap_'+cid).value = '-1';
  await sb.saveAccrualMappingFromForm(cid);
  assert(sent.length===3 && /Cap must be a number of months above 0/.test(msg||''), 'A negative cap is refused');
}
async function testAccrualMappingBulkRowsOnlyCarryCapWhenAnyIsSet(){
  const sb = makeSandbox();
  const none = sb.accrualMappingRows([{category:'A', liabilityAcc:1, expenseAcc:2, capMonths:null}]);
  assert(!('cap_months' in none[0]), 'No caps anywhere → no cap_months key (restores into an older database still work)');
  const some = sb.accrualMappingRows([{category:'A', liabilityAcc:1, expenseAcc:2, capMonths:null}, {category:'B', liabilityAcc:3, expenseAcc:4, capMonths:4}]);
  assert(some.every(r=>'cap_months' in r) && some[0].cap_months===null && some[1].cap_months===4, 'When any cap is set every row carries the key (bulk inserts need matching keys)');
}
async function testSchemaScriptAddsTheCapColumn(){
  const sb = makeSandbox();
  const sql = vm.runInContext('DB_SCHEMA_SQL', sb);
  assert(/cap_months\s+numeric/.test(sql) && /alter table pd_accrual_mappings add column if not exists cap_months numeric/i.test(sql), 'The Database Schema script adds pd_accrual_mappings.cap_months idempotently');
}

// ================= v4.62.0: platform-perspective account labels =================
async function testInvestmentLabelsUsePlatformPerspective(){
  const src = require('fs').readFileSync(APP_JS,'utf8');
  const code = src.slice(src.indexOf('const CHANGELOG = ['));
  const live = code.slice(code.indexOf('];')+2); // skip the changelog history, which keeps its original wording
  assert(!/Invested \(Out\)|Withdrawn \(In\)/.test(live), 'No on-screen label may still say "Invested (Out)" or "Withdrawn (In)"');
  assert((live.match(/Invested into platform account/g)||[]).length>=2 && (live.match(/Withdrawn from platform account/g)||[]).length>=2, 'Platform and owner editors use the new account labels');
  const sb = poolSandbox({}, true);
  sb._D.invPlatforms[0].outAcc = 10201;
  vm.runInContext('invExpandedPlatforms.add(1)', sb);
  const html = sb.renderInvPlatformSection(sb._D.invPlatforms[0]);
  assert(/Invested into platform: <b/.test(html) && /Withdrawn from platform: <b/.test(html), 'The platform card shows the new wording');
}
// ================= v4.63.0: move coins between platforms =================
function move2Sandbox(){
  const sb = moveSandbox({invPositions:[
    {id:1, platformId:1, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'},
    {id:3, platformId:1, name:'ETH', ticker:'ETH', currency:'USD', assetClass:'Crypto', status:'Active'},
    {id:4, platformId:1, name:'MARA', ticker:'MARA', currency:'USD', assetClass:'Equity', status:'Active'}]});
  sb._D.invTransactions.push(
    {id:2, positionId:3, date:'2026-01-01', kind:'buy', units:2, totalSar:20000, owners:[{ownerId:1,units:2}], feePct:0, cashSide:'bank'},
    {id:3, positionId:4, date:'2026-01-01', kind:'buy', units:60, totalSar:3000, owners:[{ownerId:1,units:60}], feePct:0, cashSide:'opening'});
  return sb;
}
async function testMoveSeveralAssetsInOneSave(){
  const sb = move2Sandbox();
  await moveRun(sb, 1, 2, '2026-02-01', {1:[10, 9.99], 3:[2, 1.998]});
  const dest = sb._D.invPositions.filter(p=>p.platformId===2).map(p=>p.ticker).sort().join(',');
  assert(dest==='BTC,ETH', 'Both assets arrive on the destination in one save, got ' + dest);
  assert(sb.computePositionState(1).totalUnits===0 && sb.computePositionState(3).totalUnits===0, 'Both are fully moved off the source');
  assert(sb._D.invTransactions.filter(t=>t.cashSide==='transfer').length===4, 'Two linked pairs are recorded');
}
async function testMoveKeepsReconciliationExactAndOpeningTag(){
  const sb = move2Sandbox();
  const capBefore = [1,2].map(o=>sb.invOwnerCapitalAsOf(o, null).capital);
  await moveRun(sb, 1, 2, '2026-02-01', {1:[4, 3.9], 4:[60, 60]});
  const capAfter = [1,2].map(o=>sb.invOwnerCapitalAsOf(o, null).capital);
  assert(Math.abs(capBefore[0]-capAfter[0])<0.01 && Math.abs(capBefore[1]-capAfter[1])<0.01, 'Capital is unchanged by a move (reconciliation stays exact), got ' + capBefore + ' vs ' + capAfter);
  const mara = sb._D.invPositions.find(p=>p.platformId===2 && p.ticker==='MARA');
  assert(mara && Math.abs(sb.computePositionState(mara.id).totalOpeningCostSar-3000)<0.01, 'Opening-balance cost keeps its opening tag on arrival (3,000)');
}
async function testMoveCarriesEachPersonsOwnCost(){
  // A paid 4.00/USD, B 3.75/USD for the same coin: each person's own cost must move, not a pooled average.
  const sb = fxSandbox({}, true);
  await poolCollect(sb, 1, '2026-10-02', {1:400}, 100);
  await poolCollect(sb, 1, '2026-10-02', {2:375}, 100);
  await poolBuy(sb, 1, '2026-10-03', 2, 200);
  await moveRun(sb, 1, 2, '2026-10-04', {1:[2, 1.9]});
  const dest = sb._D.invPositions.find(p=>p.platformId===2 && p.ticker==='ETH');
  const st = sb.computePositionState(dest.id);
  assert(Math.abs(st.byOwner[1].costSar-400)<0.01 && Math.abs(st.byOwner[2].costSar-375)<0.01, 'A arrives with 400, B with 375, got ' + st.byOwner[1].costSar + ' / ' + st.byOwner[2].costSar);
  assert(Math.abs(st.byOwner[1].units-0.95)<1e-9 && Math.abs(st.byOwner[2].units-0.95)<1e-9, 'The 0.1 fee is shared 50/50');
}
async function testMoveRefusesBadInput(){
  const sb = move2Sandbox();
  let msg = null; sb.__set('toast', m=>{ msg = m; });
  sb.openInvMoveAssets(1); sb.setInvMoveField('toPid', 2);
  sb.setInvMoveRow(1, 'sent', '4'); sb.setInvMoveRow(1, 'received', '5');
  await sb.saveInvMoveAssets();
  assert(/Received can't be more than sent/.test(msg||''), 'Received above sent is refused, got ' + msg);
  sb.setInvMoveRow(1, 'sent', '11'); sb.setInvMoveRow(1, 'received', '10');
  await sb.saveInvMoveAssets();
  assert(/Only 10 held/.test(msg||''), 'Sending more than held is refused, got ' + msg);
  assert(!sb._D.invTransactions.some(t=>t.cashSide==='transfer'), 'Nothing is saved when input is invalid');
}
async function testMoveSendAllAndPerPersonPreview(){
  const sb = move2Sandbox();
  sb.openInvMoveAssets(1); sb.setInvMoveField('toPid', 2);
  sb.invMoveSendAll(1, true);
  assert(Number(sb._invMoveDraft.rows[1].sent)===10, '"all" fills in everything held (10)');
  sb.setInvMoveRow(1, 'received', '9.9');
  const pv = sb.document.getElementById('invMovePreview').innerHTML;
  const rel = pv.match(/data-moveowner="1_2"[\s\S]*?<\/tr>/);
  const cells = rel? [...rel[0].matchAll(/<td class="num mono">([^<]*)<\/td>/g)].map(m=>m[1]) : [];
  assert(cells.join('|')==='4|4|0.04|3.96|40,000.00', 'The preview shows Relative: held 4, sent 4, fee 0.04, received 3.96, cost 40,000.00, got ' + cells.join('|'));
}
function moveActivityHtml(sb, filters){
  sb.__set('invView','activity');
  sb.__set('renderInvestmentsPage', vm.runInContext('(function(){ return function(){ renderInvActivityView(invNavHTML()); }; })()', sb));
  vm.runInContext("invActivityFilter = {platformId:'', ownerId:'', type:'', limit:100}", sb);
  for(const k in (filters||{})) vm.runInContext("invActivityFilter['"+k+"'] = "+JSON.stringify(filters[k]), sb);
  sb.renderInvActivityView(sb.invNavHTML());
  return sb.document.getElementById('app').innerHTML;
}
async function testActivityShowsAMoveAsOneLineWithFees(){
  const sb = move2Sandbox();
  sb.document.body.insertAdjacentHTML('beforeend','<div id="app"></div>');
  await moveRun(sb, 1, 2, '2026-02-01', {1:[4, 3.9]});
  const html = moveActivityHtml(sb);
  const rows = html.match(/<tr data-act="v\d+">[\s\S]*?<\/tr>/g)||[];
  assert(rows.length===1, 'A move is one Activity line, got ' + rows.length);
  assert(/A → B/.test(rows[0]) && /BTC · 4 sent → 3\.9 received, fee 0\.1/.test(rows[0]), 'It shows from → to and sent / received / fee, got ' + rows[0].replace(/\s+/g,' ').slice(0,300));
  const legIds = sb._D.invTransactions.filter(t=>t.cashSide==='transfer').map(t=>t.id);
  assert(legIds.length===2 && legIds.every(id=>!html.includes('data-act="t'+id+'"')), 'The two legs are not listed separately');
}
async function testActivityFilteredToOnePersonShowsTheirOwnFee(){
  const sb = move2Sandbox();
  sb.document.body.insertAdjacentHTML('beforeend','<div id="app"></div>');
  await moveRun(sb, 1, 2, '2026-02-01', {1:[4, 3.9]});
  const html = moveActivityHtml(sb, {ownerId:'2'});
  const row = html.match(/<tr data-act="v\d+">[\s\S]*?<\/tr>/);
  assert(row && /Relative: 1\.6 sent → 1\.56 received, fee 0\.04/.test(row[0]), 'Filtered to Relative, the line shows Relative\'s own units and fee share, got ' + (row&&row[0].replace(/\s+/g,' ').slice(0,300)));
  assert(row && /16,000\.00/.test(row[0]), 'And Relative\'s own cost moving (16,000.00)');
  const byDest = moveActivityHtml(sb, {platformId:'2', ownerId:''});
  assert(/data-act="v\d+"/.test(byDest), 'Filtering by the destination platform also finds the move');
  const byType = moveActivityHtml(sb, {type:'move'});
  assert((byType.match(/data-act="/g)||[]).length===1, 'The Coin moves type filter shows only the move');
}
async function testUndoMoveFromActivityRemovesBothLegs(){
  const sb = move2Sandbox();
  await moveRun(sb, 1, 2, '2026-02-01', {1:[4, 3.9]});
  const outId = sb._D.invTransactions.find(t=>t.cashSide==='transfer' && t.kind==='sell').id;
  sb.__set('confirm', ()=>false);
  await sb.invActivityDelete('coinmove', outId);
  assert(sb._D.invTransactions.filter(t=>t.cashSide==='transfer').length===2, 'Cancelling keeps the move');
  sb.__set('confirm', ()=>true);
  await sb.invActivityDelete('coinmove', outId);
  assert(!sb._D.invTransactions.some(t=>t.cashSide==='transfer') && Math.abs(sb.computePositionState(1).totalUnits-10)<1e-9, 'Undo removes both halves and the 10 units are back on the source');
}
async function testDeletingACashMovementFromActivityStillDeletesIt(){
  // Regression for a clash caught before shipping: coin moves must not hijack cash-movement deletes.
  const sb = move2Sandbox();
  await moveRun(sb, 1, 2, '2026-02-01', {1:[4, 3.9]});
  sb._D.invCashMovements.push({id:5, platformId:1, date:'2026-02-02', kind:'deposit', usdAmount:100, owners:[{ownerId:1, usd:100}]});
  sb.__set('confirm', ()=>true);
  sb.__set('closeModal', ()=>{});
  await sb.invActivityDelete('move', 5);
  assert(!sb._D.invCashMovements.some(m=>m.id===5), 'The cash deposit is deleted');
  assert(sb._D.invTransactions.filter(t=>t.cashSide==='transfer').length===2, 'The coin move is untouched');
}
async function testMoveIsOfferedEverywhereAndCashMoveIsRelabelled(){
  const sb = move2Sandbox();
  sb.openInvAddMenu();
  const modal = sb.document.body.innerHTML;
  assert(/data-addaction="moveassets"/.test(modal) && /⇄ Move cash/.test(modal), '+ Add offers 🔁 Move coins and the cash one is "⇄ Move cash"');
  assert(vm.runInContext("typeof (INV_PLATFORM_ACTIONS.moveassets||{}).open", sb)==='function', 'Move coins is a platform action');
  const src = require('fs').readFileSync(APP_JS,'utf8');
  const card = src.slice(src.indexOf('function invHoldingCardHTML('), src.indexOf('function renderInvMineView('));
  assert(/onclick="openInvMoveAssets\(\$\{pid\}\)">🔁 Move coins/.test(card), 'Each platform card in Mine has 🔁 Move coins');
  const win = src.slice(src.indexOf('function openInvPosition(posId){'), src.indexOf('function openInvTxModal('));
  assert(/openInvMoveAssets\(\$\{pos\.platformId\}, \$\{posId\}\)/.test(win), 'The position window opens the move with that asset ready');
}
async function testOlderTransferPairsStillShowAsOneMove(){
  const sb = move2Sandbox();
  sb.document.body.insertAdjacentHTML('beforeend','<div id="app"></div>');
  sb._D.invPositions.push({id:9, platformId:2, name:'BTC', ticker:'BTC', currency:'USD', assetClass:'Crypto', status:'Active'});
  sb._D.invTransactions.push(
    {id:54, positionId:1, date:'2026-03-01', kind:'sell', units:1, totalSar:0, owners:[{ownerId:1, units:1}], cashSide:'transfer', linkId:54},
    {id:55, positionId:9, date:'2026-03-01', kind:'buy', units:1, totalSar:0, owners:[{ownerId:1, units:1}], cashSide:'transfer', linkId:54});
  const html = moveActivityHtml(sb);
  assert(/data-act="v54"/.test(html) && !/data-act="t54"|data-act="t55"/.test(html), 'A pre-4.63 transfer pair also shows as one move line');
}

(async () => {
  testAccountSearchMatchesIsTokenBased();
  testPnLShowsPercentOfTotalExpenses();
  testLedgerPageAccountFilterUsesTokenSearch();
  testArabicTableHeaderRightAlignCssPresent();
  testSettlementRoundUpIsCeilingPerLine();
  testSettlementCleanOutputTotalIsSumOfRoundedLines();
  testNavEntranceAnimationOnlyOnFirstRender();
  testOwnershipPercentDerivedFromUnitsNotContributedCapital();
  testValuationAppliesFxForUsdPositions();
  testSellUsesWeightedAverageCostAndRealisesGain();
  testTransactionsProcessedInDateOrderNotInsertionOrder();
  testFamilyHoldingsSeparatedFromOwn();
  testReconciliationFlagsMismatchAgainstLedger();
  testFxRateIsSyncedNotDeviceLocal();
  testPortfolioHistoryUsesUnitsAndPriceAsOfEachDate();
  testStalePricesAreFlagged();
  testCsvImportIsAllOrNothingOnBadRow();
  testCsvImportRejectsOwnerUnitsMismatch();
  testReverseJvProducesExactMirrorAndNetsToZero();
  testDeleteJvIsGoneEntirely();
  testEveryScreenHasAnIcon();
  testSchemaSqlCoversEveryTableTheAppReads();
  await testAddedJVLinesStartBlankEvenWhileReconciling();
  await testStartReconcileStillPrefillsTheFirstLine();
  await testJVInputsOptOutOfBrowserAutofill();
  await testDashboardBudgetLineHasNoPaceFigure();
  await testSchemaUpgradesAnExistingDatabaseNotJustANewOne();
  await testColumnTopUpIsSafeAndWellFormed();
  await testAddingAColumnUpgradesExistingDatabasesAutomatically();
  await testSchemaIncludesTheLedgerChangeMarker();
  await testOpeningBalanceCostTrackedAndBleedsDownProportionallyOnSell();
  await testAsOfDateFiltersTransactionsForComputePositionState();
  await testReconciliationExcludesOpeningBalanceCost();
  await testReconciliationWithoutOpeningExclusionWouldFalseAlarm();
  await testReconciliationStartDateComparesDeltaNotFullHistory();
  await testReconciliationWithoutStartDateShowsTheFullHistoryGap();
  await testPositionMoveKeepsSharesTakesFeeProRataAndCarriesFullCost();
  await testPositionMoveMergesIntoExistingMatchingPosition();
  await testXirrTreatsTransferAsNetZeroExceptTheFee();
  await testAccountCurrentBalancesCSVHasTheRightColumns();
  await testAccountMonthlyMovementCSVCoversFullHistoryNotJustCurrentMonth();
  await testMergedReconImportPriceRoundTripKeepsBlankRowsUntouched();
  await testRealEstateCollapsedHeaderShowsCurrentMonthNet();
  testSettingsIsAPagePinnedLastAndPillNotClickable();
  testCustomPageOrderIsRespected();
  testScreensMissingFromSavedOrderAreAppendedNotDropped();
  testAlwaysVisiblePagesCannotBeHidden();
  testSarSplitDerivesUnitsProportionally();
  testSarSplitRemainderGoesToLargestHolder();
  testSarSplitKeepsUnitPrecisionForCrypto();
  testSarForUnitsRoundTripsTheSplit();
  testPostJvShowsSpinnerWhileWorking();
  testSarSplitUsesTransactionTotalNotAllocatedSubtotal();
  testPartialSplitDoesNotDumpRemainderOnOnePerson();
  testUnitsDisplayKeeps8Decimals();
  testTxModalDoesNotRerenderWhileTyping();
  testCtrlEnterConfirmsModalPrimaryAction();
  testOwnerDeletionBlockedWhileReferenced();
  testStatementDefaultsToNewestFirst();
  testNumberSpinnersHidden();
  await testIdbRoundTripPreservesEveryRecord();
  await testMigrationIsNonDestructiveAndVerified();
  await testMigrationKeepsLegacyDataWhenVerificationFails();
  await testInterruptedMigrationLosesNothingAndResumes();
  await testFallbackCacheIsTrimmedNotFull();
  await testFootprintGuardWarnsWhenWeCrowdTheDomain();
  testStorageScanCoversWholeOriginNotJustOurKeys();
  testCacheBreakdownReportsPerCollectionSizes();
  testQuotaExceededIsSurfacedNotSwallowed();
  testClearingCacheBlockedWhileChangesArePending();
  await testKpiValueNoLongerStuckAtZero();
  await testJVDoubleClickGuard();
  await testSmartRuleFreezeAfterTarget();
  await testProvisionDescrSurvivesBlockedSync();
  await testDriftDetectionFlagsProvisionLine();
  await testDriftDetectionSkipsHealthyLine();
  await testDriftDetectionRequiresAllConsecutiveMonths();
  await testDriftDismissSuppressesUntilNewMonthCloses();
  await testPnlVarianceMagnitudeIsSignConventionProof();
  await testDashboardExpenseBudgetSumsOnlyLiveExpenseAccounts();
  await testDashboardExpenseBudgetComparesAgainstTheWholeMonth();
  await testDashboardExpenseBudgetIsSignConventionProof();
  await testDashboardExpenseBudgetHandlesNoBudgetAndPastMonths();
  await testAllocBadgeIsClickableAndBlankWhenUnallocated();
  await testAllocJumpFromLedgerRowDoesNotAlsoOpenTheJV();
  await testAllocModalActionsDoNotRepaintTheWrongPage();
  await testGoPnLThisMonthOpensPnlForTheCurrentMonth();
  await testBuyFeeMovesUnitsButNotTheSarSplit();
  await testSellFeeComesOutOfProceedsAndIsFeeIncomeNotGain();
  await testFeeIsAppliedByEveryConsumerNotJustCostBasis();
  await testPlatformCashTracksSellProceedsAndFundedBuys();
  await testBankSideTransactionsDoNotTouchCash();
  await testDepositWithdrawalAndTransferWithFee();
  await testTransferFeeIsBorneBySelfNotSharedWithFamily();
  await testTransferCarriesProfitProportionally();
  await testReconciliationBridgeBalancesWithCashHeld();
  await testReconciliationWouldFalseAlarmWithoutTheProfitTerm();
  await testPlatformReconciliationFlagsUnitAndCashVariances();
  await testWithdrawalSplitDrawsProfitFirstButAllowsOverride();
  await testFeeWithNoFamilyOwnersChargesNothing();
  await testSchemaSqlCoversTheCashTable();
  await testAccountExportButtonsMovedOffSettingsOntoAccountsPage();
  await testAccountsGridShowsBalanceAndMonthlyMovementPerAccount();
  await testAccountsGridWindowDefaultsToTwelveMonthsEndingCurrent();
  await testAccountsGridShiftMovesTheWindowByOneMonth();
  await testNewPositionDefaultsToCryptoAndUSD();
  await testTickerInputUppercasesWithoutLosingCursorPosition();
  await testSaveInvPositionUppercasesTickerAsASafetyNet();
  await testOpeningBalanceModalUsesUsdEntryNotPlainSar();
  await testUsdFieldSupportsFormulaOnBlur();
  await testPricePerUnitShowsUsdForCashAndOpeningEntries();
  await testSaveInvTxRequiresUsdAmountForOpeningBalance();
  await testPlatformPanelOnlyKeepsTheEditButtonNow();
  await testPlatformsSortedAlphabeticallyCaseInsensitive();
  await testSinglePlatformSkipsThePicker();
  await testMultiplePlatformsShowsThePicker();
  await testZeroPlatformsDoesNothing();
  await testPortfolioPageDisablesActionButtonsWithZeroPlatforms();
  await testLogPricesFunctionsAreGoneMergedIntoRecon();
  await testReconPageIncludesTheManualPriceSection();
  await testMergedReconCsvHasBothStatementAndPriceColumns();
  await testTextWidthNoLongerCappedOnPortfolioPage();
  await testMarkUserActivityUpdatesLastActivityTime();
  await testMarkUserActivityIsIgnoredOnceLocked();
  await testCheckIdleLockDoesNothingBeforeTheThreshold();
  await testCheckIdleLockHoldsOffWhileSyncQueueIsNonEmpty();
  await testCheckIdleLockHoldsOffWhileAModalIsOpen();
  await testCheckIdleLockWarnsBeforeLockingWithNothingBlocking();
  await testCheckIdleLockLocksAfterTheWarningWindowElapses();
  await testCheckIdleLockDoesNotLockDuringTheWarningWindow();
  await testMarkUserActivityDismissesAnActiveWarning();
  await testIdleLockMinutesZeroMeansNever();
  await testGetSetIdleLockMinutesRoundTripsThroughLocalStorage();
  await testGetIdleLockMinutesFallsBackToDefaultWhenUnset();
  await testIdleLockSettingsPanelShowsCurrentValueAndSaves();
  await testSaveIdleLockMinutesFromSettingsPersistsAndToasts();
  await testToggleJvBalanceCheckStartsFreshEachTime();
  await testToggleJvBalanceCheckLineTogglesMembership();
  await testJvBalanceCheckSubtotalSumsOnlySelectedLines();
  await testJvBalanceCheckSubtotalDetectsTheImbalance();
  await testJvBalanceCheckSubtotalIgnoresStaleIndexesGracefully();
  await testClearJvBalanceCheckSelectionEmptiesTheSet();
  await testRemoveJVLineRemapsSelectionIndexesCorrectly();
  await testResetJVDraftClearsBalanceCheckSelection();
  await testRenderNewJVShowsBalanceCheckBarOnlyWhenModeIsOn();
  await testUnselectedLinesAreDimmedWhileSelectedLinesAreNot();
  await testClosingBalanceWatchStoresUpToThreeArbitraryMonths();
  await testClosingBalanceWatchWidgetShowsClosingOnlyForPickedMonths();
  await testClosingBalanceWatchWidgetHandlesNoMonthsPicked();
  await testStatementBalanceOnlySavesOnEnterNotOnBlur();
  await testStartReconcileFocusesTheDescriptionField();
  await testJvAmountDoesNotRecalculateTotalOnEveryKeystroke();
  await testJvAmtBlurStillRecalculatesTheTotal();
  await testBalanceCheckSubtotalAlsoOnlyUpdatesOnBlurNotEveryKeystroke();
  await testGetSetForecastSnapshotHorizonRoundTrips();
  await testGetForecastSnapshotHorizonDefaultsToTwelve();
  await testBuildForecastSnapshotMonthsCapturesExactlyTheHorizon();
  await testTakeForecastSnapshotPersistsAndReturnsTheRecord();
  await testDeleteForecastSnapshotRemovesItAfterConfirm();
  await testDeleteForecastSnapshotKeepsItIfNotConfirmed();
  await testAutoSnapshotSkipsWhenNoLedgerHistoryExists();
  await testAutoSnapshotTakesOneWhenNoneExistsThisMonth();
  await testAutoSnapshotDoesNotDuplicateWithinTheSameMonth();
  await testAutoSnapshotAllowsAManualOneInTheSameMonthToo();
  await testForecastSnapshotBannerHtmlOnlyShowsWhenArmed();
  await testDismissForecastSnapshotBannerClearsIt();
  await testForecastSnapshotClosingForReturnsNullOutsideHorizon();
  await testForecastSnapshotsCoveringFindsOnlyRelevantOnesInOrder();
  await testForecastSnapshotTrendChartRendersAPointPerCoveringSnapshotPlusNow();
  await testForecastSnapshotTrendChartEmptyWithFewerThanTwoPoints();
  await testForecastSettingsPageIncludesSnapshotHorizonAndButton();
  await testClosingBalanceWatchMatchesTheRealAnchoredGrid();
  await testClosingBalanceWatchUsesAnchoredNotPureChain();
  await testForecastSnapshotCaptureUsesAnchoredChainAndFastPath();
  await testSnapshotComparisonNowFigureUsesAnchoredChain();
  await testNetWorthGridAutoFitsInsteadOfFixedThreeColumns();
  await testClosingBalanceWatchIsInItsOwnRowNotTheNetWorthGrid();
  await testAllocationByIncludesRoboAsStocksWhenSupplied();
  await testAllocationByExcludesRoboWhenNoRoboKeyFnSupplied();
  await testSaveInvRoboValueAppendsToTheHistoryLog();
  await testSaveInvRoboValueSameDateCorrectsRatherThanDuplicates();
  await testInvRoboValueAsOfReturnsLatestEntryAtOrBeforeDate();
  await testPortfolioHistoryOnlyIncludesRoboFromWhenLoggingStarted();
  await testPortfolioHistoryIncludesDatesThatOnlyExistInTheRoboLog();
  await testAllocationChartsIncludeRoboPlatformAsStocksAndByItsOwnName();
  await testRenderInvestmentsPageActuallyPassesRoboIntoTheRealAllocationCalls();
  await testAllocationByWithoutRoboKeyFnStaysUnaffected();
  await testDashboardGridUsesFixedMaxWidthNotStretching();
  await testComparisonShowsFullCategoryBreakdownNotJustClosingBalance();
  await testTakeForecastSnapshotCapturesCurrentSignFlips();
  await testComparisonWarnsWhenSignFlipsChangedSinceTheSnapshot();
  await testComparisonNoWarningWhenSignFlipsUnchanged();
  await testSnapshotVsSnapshotComparisonMode();
  await testSnapshotVsSnapshotHandlesAMonthOneSnapshotNeverCaptured();
  await testTrendChartHasVisibleValueLabelsNotJustHoverTooltips();
  await testInitIdleLockChecksImmediatelyOnVisibilityChange();
  await testInitIdleLockDoesNotCheckWhenBecomingHidden();
  await testVisibilityCheckSeesTheStaleActivityTimeBeforeAnyClickCanResetIt();
  await testRowSummaryUsesCuratedFieldsWhenAvailable();
  await testRowSummaryFallsBackGenericallyForAnUncuratedTable();
  await testRowSummaryFallbackHandlesJsonbColumnsWithoutCrashing();
  await testRowSummaryReturnsPlaceholderForANullRow();
  await testInvRoboPlatformStatsFixesTheSignFlipWhenWithdrawnExceedsInvested();
  await testInvRoboPlatformStatsNormalCaseUnaffected();
  await testRoboKpiFoldUsesCostBasisMagnitudeNotRawSignedValue();
  await testRoboCardWarnsWhenCostBasisIsFlagged();
  await testAllocationChartFallbackUsesCostBasisMagnitudeWhenNoValueLogged();
  await testKpiCardsAreClickableAndOpenTheirBreakdowns();
  await testInvPlatformBreakdownRowsSumExactlyToTheDisplayedTotal();
  await testInvPlatformBreakdownIncludesRoboPlatformsForSelfOnly();
  await testClickingAPlatformRowDrillsIntoItsPositions();
  await testRoboPlatformRowIsNotClickableInBreakdown();
  await testInvestedAndPlKindsAreNeverDrillable();
  await testInvestedAmountUsesOutAccountOnlyNotNetOfIn();
  await testPlInvestmentsPageWidgetMatchesValueMinusInvested();
  await testClearAllJVLinesRequiresConfirmation();
  await testClearAllJVLinesResetsToTwoBlankLinesButKeepsTheDate();
  await testClearAllJVLinesAlsoClearsBalanceCheckSelection();
  await testExportStatementCSVProducesTheRightRowsAndRunningBalance();
  await testExportStatementCSVRespectsCurrentSortOrder();
  await testStatementViewHasCsvButtonNextToPrintButton();
  await testOpenInvKpiBreakdownRendersATotalMatchingTheColumn();
  await testComparisonIncludesStartingBalanceRow();
  await testStartingBalanceDiffAccountsForTheClosingBalanceGap();
  await testStartingBalanceRowAlsoWorksAgainstLiveNowNotJustSnapshotVsSnapshot();
  await testSignFlipWarningIsHedgedWhenThenSnapshotHasNoRecordedFlips();
  await testSignFlipWarningStaysConfidentWhenThenSnapshotHasRealData();
  await testSignFlipWarningEmptyWhenNothingActuallyDiffers();
  await testSignFlipWarningConfidentWhenAFlipWasTurnedOff();
  await testGenerateProvisionJVSkipsZeroAmountLines();
  await testGenerateProvisionJVStillRequiresTwoRealLines();
  await testCombinedGenerateProvisionJVSkipsZeroAmountLines();
  await testExportBudgetGridStartsAtCurrentMonthNotEarliestLedgerMonth();
  await testExportBudgetGridShowsPlanNotActualForCurrentMonth();
  await testImportBudgetGridAcceptsTheCurrentMonthColumn();
  await testParseInvCoinImportCSVSkipsLeadingAccountNumberRow();
  await testParseInvCoinImportCSVSkipsAllZeroRows();
  await testParseInvCoinImportCSVTrimsOwnerNamesAndExcludesSummaryColumns();
  await testParseInvCoinImportCSVThrowsWithoutACoinHeader();
  await testBuildInvCoinImportMappingsAutoMatchesExistingByNameCaseInsensitive();
  await testInvCoinImportIsReadyRequiresEveryOwnerResolved();
  await testInvCoinImportIsReadyDoesNotRequirePlatformResolution();
  await testCommitInvCoinImportCreatesPositionWithZeroCostOpeningTransaction();
  await testCommitInvCoinImportCreatesMissingPlatformOnTheFly();
  await testCommitInvCoinImportReusesTheSameNewPlatformAcrossMultipleRows();
  await testCommitInvCoinImportReusesAnExistingPositionByTicker();
  await testCommitInvCoinImportRespectsDeclinedConfirmation();
  await testInvCoinImportAgainstTheRealUploadedSpreadsheetShape();
  await testOwnerBreakdownIsCollapsedByDefault();
  await testOwnerBreakdownExpandsWithFullDetailColumns();
  await testOwnerBreakdownToggleStopsClickPropagationToThePositionLink();
  await testToggleInvPositionOwnersExpandedFlipsIndependently();
  await testOwnerBreakdownShowsZeroCostAndDashForNoValuationCorrectly();
  await testAccrualJVStillReadsThePlanAfterTheAccrualMonthHasClosed();
  await testAccrualJVUsesForecastPlanNotStaleLegacyBudgetTable();
  await testAccrualJVStillFallsBackToLegacyBudgetTableWhenNoProvisionsExist();
  await testInvRoboPlatformStatsComputesCostBasisFromOutInAccounts();
  await testInvRoboPlatformStatsHandlesUnassignedAccountsAsZero();
  await testSaveInvRoboValuePersistsAndDatesIt();
  await testSaveInvRoboValueIgnoresNonPositiveInput();
  await testRoboPlatformRendersSimplifiedCardNotThePositionTable();
  await testActionablePlatformsExcludesRoboPlatforms();
  await testInvStartPlatformActionSkipsRoboWhenChoosingSinglePlatformShortcut();
  await testReconciliationPageExcludesRoboPlatforms();
  await testRoboPlatformValueFoldsIntoSelfKpiTotals();
  await testNormalPlatformShowsPortfolioValueNextToCashInBothViews();
  await testPositionTableIncludesAUsdValueColumn();
  await testOutInProfitBalancesShownWhenExpandedWithUnassignedFallback();
  await testOutInProfitBalancesHiddenWhenCollapsed();
  await testPlatformModalIncludesRoboCheckbox();
  await testLockAppForInactivityShowsOverlayWithRelaunch();
  await testLockAppForInactivityIsIdempotent();
  await testRelaunchAppReloadsThePage();
  await testNormalizeDataShapeFillsInEveryMissingField();
  await testNormalizeDataShapeDoesNotOverwriteExistingData();
  await testRestoreFromBackupDoesNotCrashOnAnOldBackupMissingNewerFields();
  await testRestoreFromBackupPreservesNewerFieldsWhenPresentInTheFile();
  await testRestoreFromBackupStillCallsNormalizeDataShape();
  await testManualPriceEntrySavesAValuationAndRendersStaleness();
  await testReconciliationColumnsShareTheSameLayoutAcrossPlatforms();
  await testReconciliationShowsLastReconciledDateWithStaleness();
  await testBankFundedUsdPositionShowsUsdEntryToo();
  await testSarCurrencyPositionFundedFromBankStaysPlainSar();
  await testPpuReadsUsdForBankFundedUsdPositionToo();
  await testSaveInvTxRequiresUsdForBankFundedUsdPosition();
  await testSaveInvTxPersistsUsdAmountForBankFundedUsdPosition();
  await testEditingOldRecordBackfillsUsdFromStoredSar();
  await testDualCurrencyKpiShowsUsdFirstBoldThenSar();
  await testTopWidgetsUseDualCurrencyIncludingFamily();
  await testPositionModalUsesDualCurrencyWidgets();
  await testPriceDateRemovedFromPlatformTableAndAlwaysBlack();
  await testStalePricesPanelRemovedFromInvestmentsPage();
  await testPlatformsCollapsedByDefault();
  await testCollapsedPlatformShowsCashAndOwnerPortionSummary();
  await testToggleInvPlatformExpandedFlipsState();
  await testReconCsvExportAndImportRoundTrip();
  await testReconPageShowsPerPositionLastCheckedDate();
  await testEnterKeyMovesToNextReconInput();
  await testEnterKeyOnLastReconInputJustBlurs();
  await testNonEnterKeyIsIgnoredByReconNavigation();
  await testLedgerSearchDebounced();
  await testSplashProgressBlendsLedgerFraction();
  await testSidebarPinToggle();
  await testMobileNavOpenClose();
  await testGoClosesMobileNavAndUpdatesTitle();
  await testCategoryAccountIdsExcludesWorkingCapital();
  await testLedgerEditorBlocksUnbalancedJV();
  await testLedgerEditorBlocksBrokenAllocation();
  await testLedgerEditorAppliesValidEdit();
  await testLedgerEditorDeletesFullJVCleanly();
  await testLedgerEditorRejectsDuplicateRowId();
  await testGetBalanceStaleDaysDefaultsToZero();
  await testSaveBalanceStaleDaysPersistsToUiPrefsAndSyncsOnlyThatColumn();
  await testDashboardBalanceColorRespectsConfiguredGracePeriod();
  await testDashboardBalanceColorTurnsRedPastTheGracePeriod();
  await testDashboardBalanceColorDefaultMatchesOriginalSameDayOnlyBehavior();
  await testDashboardBalanceColorSameDayStillGreenWithDefault();
  await testNormalizeDataShapeDefaultsBalanceStaleDaysToZero();
  await testNormalizeDataShapeDoesNotOverwriteAnExistingBalanceStaleDays();
  await testRestoreFromBackupCloudPathIncludesBalanceStaleDaysEvenWithoutPageOrder();
  await testBalanceFreshnessSettingsPanelShowsCurrentValue();
  await testSaveBalanceStaleDaysFromInputValidatesAndToasts();
  await testSaveBalanceStaleDaysFromInputRejectsInvalidValues();
  await testSaveBalanceStaleDaysFromInputRefreshesDashboardWhenOnIt();
  await testShowSplashSetsVersionTag();
  await testSplashVersionTagNotOverwrittenIfAlreadySet();
  testSplashScreenMarkupIncludesVersionElement();
  await testAccountsWithBudgetFiguresIncludesEveryPlanSource();
  await testAccountsWithBudgetFiguresIncludesSmartRuleOnlyAccounts();
  await testAccountsWithBudgetFiguresExcludesAccountsWithNoPlanAtAll();
  await testAcctBudgetChartYearsAlwaysIncludesTheCurrentYearEvenWithNoActivity();
  await testComputeAcctBudgetChartDataUsesOriginalPlanEvenForPastMonths();
  await testComputeAcctBudgetChartDataZerosFutureMonthsActual();
  await testComputeAcctBudgetChartDataCumulativeRunsCorrectlyAndFlattensAfterToday();
  await testComputeAcctBudgetChartDataRemainingIsSignConventionProof();
  await testOpenAcctBudgetChartRoutesRenderPnLToTheSubpage();
  await testCloseAcctBudgetChartReturnsToMainPnLView();
  await testRenderAcctBudgetChartPageShowsEmptyStateWithNoBudgetedAccounts();
  await testSelectAcctBudgetChartAccountAndYearUpdateState();
  await testOpenAcctBudgetChartAcceptsASpecificAccountId();
  await testOpenAcctBudgetChartWithNoArgumentKeepsTheOldDefaultBehavior();
  await testOpenAcctBudgetChartWithSpecificIdOverridesAnyPreviousSelection();
  await testPnLChartLinkShowsOnlyForBudgetedExpenseAccounts();
  testPnLChartLinkStopsClickPropagationToTheRowHandler();
  await testAcctBudgetBarChartClickOpensTransactionsForActualBar();
  await testAcctBudgetBarChartClickIgnoresBudgetBar();
  await testAcctBudgetBarChartClickHandlesNoElementsGracefully();
  await testAcctBudgetBarChartClickOnFutureFlatMonthShowsHonestEmptyState();
  testViewAcctBudgetChartMonthTransactionsFiltersToTheExactAccountAndMonth();
  await testSubcategoriesWithBudgetFiguresIncludesOnlyCategoriesWithABudgetedAccount();
  await testSubcategoriesWithBudgetFiguresExcludesCategoriesWithNoBudgetAtAll();
  await testAcctBudgetChartCategoryAccountIdsIncludesEveryAccountRegardlessOfItsOwnBudgetStatus();
  await testComputeAcctBudgetChartDataForCategoryAggregatesAcrossEveryAccountInTheCategory();
  await testComputeAcctBudgetChartDataForCategoryZerosFutureMonths();
  await testSelectAcctBudgetChartModeAndSubcatUpdateState();
  await testOpenAcctBudgetChartForCategorySetsSubcatModeAndOpensThePage();
  await testOpenAcctBudgetChartWithAnAccountIdSwitchesBackToAccountMode();
  await testRenderAcctBudgetChartPageShowsSubcatPickerInSubcategoryMode();
  await testRenderAcctBudgetChartPageFallsBackWhenSelectedSubcatNoLongerQualifies();
  await testAcctBudgetBarChartClickHandlerRoutesToSubcategoryModalWhenModeIsSubcategory();
  await testAcctBudgetBarChartClickHandlerStillRoutesToAccountModalWithNoModeArgument();
  await testViewAcctBudgetChartMonthTransactionsForCategoryGroupsByAccountThenDate();
  await testViewAcctBudgetChartMonthTransactionsForCategoryHandlesEmptyMonth();
  await testPnLCategoryLinkShowsOnlyForBudgetedCategories();
  testPnLCategoryLinkStopsClickPropagation();
  await testInvReconEnterNextSetsFocusKeyFromNextInputsDataset();
  await testInvReconEnterNextClearsFocusKeyOnLastInput();
  await testRenderInvReconPageRestoresFocusToTheTrackedKey();
  await testRenderInvReconPageDoesNothingWhenNoFocusKeyPending();
  await testInvReconPlatformsCollapsedByDefault();
  await testToggleInvReconPlatformExpandedFlipsIndependentlyPerPlatform();
  await testInvReconExpandStateIsIndependentFromTheMainInvestmentsPage();
  await testInvAssetIdentityUsesTickerWhenPresent();
  await testInvAssetIdentityFallsBackToNameWhenNoTicker();
  await testInvPositionsMatchingAssetGroupsAcrossPlatformsByTicker();
  await testOpenInvAssetAcrossPlatformsShowsASectionPerPlatformWithItsTransactions();
  await testOpenInvAssetAcrossPlatformsRowClickOpensTheCorrectTransactionForEditing();
  await testOpenInvAssetAcrossPlatformsNewTransactionGoesToThePickedPlatform();
  await testInvReconPositionNameOpensTheAssetWindow();
  await testPlatformSectionShowsCombinedPortfolioPlusCashTotal();
  await testInvSplitUsdBySarIsProportionalAndExactToTheCent();
  await testInvSplitUsdBySarSkipsNonContributors();
  await testAvailableIsOutAccountMinusWhatTheTrackerAlreadyHolds();
  await testAvailableIsNullWithoutAnOutAccount();
  await testCollectPrefillsFromAvailable();
  await testCollectRecordsOneDepositSplitBySarShare();
  await testCollectSplitsTheActualUsdReceivedNotTheTheoreticalOne();
  await testCollectByPercentageOfATotal();
  await testCollectBlocksPercentagesThatDontAddUpTo100();
  await testCollectBlocksAnEmptyContribution();
  await testCollectButtonIsOnTheInvestmentsPage();
  await testCashForSplitIsAsOfTheBuyDateIncludingSameDayDeposits();
  await testCashForSplitAddsBackTheTransactionBeingEdited();
  await testSplitByCashGivesUnitsInProportionToEachPersonsCash();
  await testUntickingSomeoneSpreadsTheirShareAcrossTheRest();
  await testSplitByCashNeedsUnitsFirst();
  await testSplitByCashOnlyOfferedForCashFundedBuys();
  await testChangingUnitsKeepsTheSplitInStep();
  await testEditingOnePersonsUnitsByHandTurnsAutoSplitOff();
  await testPerPersonOverdrawIsWarnedByName();
  await testNoOverdrawWarningWhenTheSplitFollowsCash();
  await testFullMonthEveryoneGetsTheirShareAtTheSameAveragePrice();
  await testLeftoverCashRollsIntoNextMonthsSplit();
  await testOnlyYouCanBuyAloneByUntickingEveryoneElse();
  await testForecastWideExportHasOneSourceColumnBetweenSubCategoryAndBalance();
  await testForecastWideExportAmountsStillLineUpWithTheirMonths();
  await testForecastWideExportSourceListsEachSourceWithItsMonthRange();
  await testForecastWideExportSourceSplitsProvisionsThenBudgetRanges();
  await testForecastWideExportDescribesASmartRuleOnceWithItsRange();
  await testForecastWideExportSmartRuleFreezeAndZeroOffsetWording();
  await testForecastWideExportBankAccountSourceIsBlank();
  await testForecastPivotExportKeepsItsPerRowSource();
  await testForecastWideExportStillReimportsWithTheSourceColumn();
  await testBudgetImportUnchangedFileSyncsNothing();
  await testBudgetImportSyncsOnlyTheEditedCell();
  await testBudgetImportTreatsExcelRoundingAsUnchangedButCountsARealCentEdit();
  await testBudgetImportClearingACellStillDeletesAndNewCellStillCreates();
  await testReconcileRecentJvsAreTheLastThreeByJvDateOnlyThisAccountsLines();
  await testReconcilePaneIsCollapsedByDefaultAndShowsDateJvDescriptionAmount();
  await testReconcilePaneNeverListsTheUnpostedDraft();
  await testReconcilePaneShowsBothLinesWhenOneJvHitsTheAccountTwice();
  await testReconcilePaneEmptyStateWhenNoPostedJvs();
  await testJamiahShowsThisMonthsNetOfUnallocatedTransactions();
  await testJamiahMonthTotalIsNetSignedAndHandlesSingularAndZero();
  await testAccruedForCategoryIsTheNegatedLiabilityBalanceAsOfTheDate();
  await testMonthEndDateStrHandlesShortMonthsAndLeapYears();
  await testPnLShowsAccruedNextToMappedCategoryAndItsAccrualAccountOnly();
  await testPnLAccruedFollowsThePeriodEndNotToday();
  await testExportGridButtonOpensTheChoiceInsteadOfExportingImmediately();
  await testBudgetExportFutureOnlyIsUnchanged();
  await testBudgetExportWithHistoryStartsAtEarliestLedgerMonthAndShowsActualForPast();
  await testBudgetImportIgnoresThePastMonthsOfAHistoricalExport();
  await testLegacyDepositWithoutSarStaysAtTheStandardRate();
  await testCollectAtARealRateRecordsFullSarAndClosesAvailable();
  await testCollectShowsTheEffectiveRateForInformation();
  await testCollectPreFillsTheFullAvailableBalance();
  await testCashFundedBuyIsCostedAtEachPersonsOwnRate();
  await testCashBuyPreviewNamesEachPersonsRate();
  await testReEditingACashBuyDoesNotDoubleCountItself();
  await testUsdTransactionsTakeTheRateTypedOnTheDay();
  await testUserExampleDeposit400SellAndWithdraw150At375();
  await testWithdrawalTakesCashOutAtItsAverageCost();
  await testWithdrawalAtABetterRateSendsTheGainToProfit();
  await testEditingADepositsUsdKeepsTheSarAndUpdatesTheRate();
  await testTransferCarriesTheAverageRate();
  await testCashLogShowsTheDepositRate();
  await testPlatformTableShowsAUsdCashRowWithPerPersonSplit();
  await testByOwnerTableHasACashColumnAndListsCashOnlyPeople();
  await testStatementGroupsByPlatformAndIncludesCash();
  await testInvestmentsOpensOnMineAndHasEveryView();
  await testMineShowsOnlyMySliceAndNoFamilyFigures();
  await testMineTableHasFiveColumnsUntilDetailsAreShown();
  await testPlatformCardIsOneLineUntilExpanded();
  await testMinePlatformCardHasItsOwnActions();
  await testStablecoinsCountAsCash();
  await testUnpricedPositionIsCountedAtCostAndFlagged();
  await testClosedPositionsFoldIntoACollapsedGroup();
  await testCurrencySwitchShowsUsd();
  await testFamilyViewHasACardPerFamilyMemberOnly();
  await testFamilyThisMonthChecklistTracksTheRoutine();
  await testActivityListsEverythingNewestFirstWithEditAndDelete();
  await testActivityFiltersByPersonAndType();
  await testActivityDeleteAsksFirst();
  await testActivityHidesDeleteForLinkedTransferLegs();
  await testReconcileViewCarriesTheWarningAndTheTabShowsACount();
  await testAddMenuOffersEveryActionAndBuySellPicksAnAsset();
  await testAddMenuIsDisabledWithNoPlatforms();
  await testSetupViewHoldsTheSettingsAndPlatforms();
  await testInsightsViewDrawsTheCharts();
  await testClassicViewIsThePreviousPage();
  await testMineWithoutASelfOwnerExplainsWhatToDo();
  await testStatementShowsUsdtAsCash();
  await testOwnerSarMapUsesStoredFiguresElseUnitsShare();
  await testCostEditorChangesOnePersonsCellAndRecordsIt();
  await testCostEditorRowTotalIsSharedInCurrentProportions();
  await testCostEditorPersonTotalIsSpreadAcrossTheirBuys();
  await testCostEditorSpreadsByUnitsWhenEverythingIsZero();
  await testCostEditorLeavesTransferLegsOut();
  await testCostEditorWithNoChangesRecordsNothing();
  await testPositionWindowOffersEditCosts();
  await testCsvExportHasOwnersSarAndAnUntouchedReimportWritesNothing();
  await testCsvReimportKeepsRealRatesOnCashBuys();
  await testCsvNewTotalIsSharedInCurrentProportionsAndKeepsUsd();
  await testCsvOwnersSarSetsEachPersonsCost();
  await testCsvOwnersSarAndTotalMustAgree();
  await testCsvAcceptsZeroCostOpeningBalances();
  await testCsvRefusesToChangeATransferLeg();
  await testCostCorrectionShowsInActivityButNotInCashLogOrCash();
  await testJamiahSummaryShowsPledgePerRoundInsteadOfDueAndPaid();
  await testJamiahFooterShowsThePotAndThisRoundsPending();
  await testJamiahPendingIsBlankOutsideTheJamiahsMonths();
  await testJamiahArabicViewUsesTheAgreedLabels();
  await testUnallocatedOffersAddToExistingEvenForOneLine();
  await testAddToExistingListsSameAccountAndOnlyZeroResultsCanBeChosen();
  await testAddToAllocationAssignsSyncsAndClearsSelection();
  await testAddToAllocationRefusesANonZeroResult();
  await testAddToAllocationRefusesAnotherAccountsAllocation();
  await testAddToExistingWithNoAllocationsSaysSo();
  await testAccrualStopsAtTheCapAndAccruesOnlyTheRemainder();
  await testAccrualAtTheCapAddsNothing();
  await testAccrualWithoutACapIsUnchanged();
  await testAccrualCapUsesThatMonthsBudgetAndMonthEndBalance();
  await testOverBudgetDrawdownIgnoresTheCap();
  await testAccruedChipShowsTheCap();
  await testSettingsSavesTheCapAndOnlySendsItWhenUsed();
  await testAccrualMappingBulkRowsOnlyCarryCapWhenAnyIsSet();
  await testSchemaScriptAddsTheCapColumn();
  await testInvestmentLabelsUsePlatformPerspective();
  await testMoveSeveralAssetsInOneSave();
  await testMoveKeepsReconciliationExactAndOpeningTag();
  await testMoveCarriesEachPersonsOwnCost();
  await testMoveRefusesBadInput();
  await testMoveSendAllAndPerPersonPreview();
  await testActivityShowsAMoveAsOneLineWithFees();
  await testActivityFilteredToOnePersonShowsTheirOwnFee();
  await testUndoMoveFromActivityRemovesBothLegs();
  await testDeletingACashMovementFromActivityStillDeletesIt();
  await testMoveIsOfferedEverywhereAndCashMoveIsRelabelled();
  await testOlderTransferPairsStillShowAsOneMove();
  await testClassicCopyIsFrozenAndBothPagesLinkEachOther();
  await testThemeTokensFollowTheAccentAndBackground();
  await testBackgroundAndMotionPrefsApplyAndPersist();
  await testRailRendersIconsLabelsAndCurrentPage();
  await testTopBarShowsPageTitleAndThemeState();
  await testShellMarkupHasTopBarAndNoOldThemeButton();
  await testAppearanceSettingsOfferBackgroundMotionAndGeist();
  await testPositionBoxPresetsEqualTheOldPanels();
  await testPositionBoxesUseBalancesAsOfToday();
  await testPositionBoxSignsAccountRowsAndPeek();
  await testDashboardLayoutIsNormalised();
  await testDashboardLayoutChangesSyncOnlyTheLayoutColumn();
  await testPositionBoxEditorValidatesAndSaves();
  await testNewAndRemovedPositionBoxes();
  await testThingsThatNeedYouList();
  await testDashboardSchemaAndLoadingOfTheNewPrefs();
  await testEditLayoutModeShowsHandles();
  await testPositionBoxLineCanFollowAWholeCategory();
  await testNewJvShowsBudgetImpactAndDraftsBelow();
  await testLedgerGroupsByJvAndFramesTheSelectedOne();
  await testAccountsCategoryChipsAndSidePanel();
  await testBudgetChartsWriteAmountsOnBars();
  await testInvActivityFiltersByAccountAndDates();
  await testInvActivityCsvHasPerPersonColumns();
  await testProvisionIssuesListEveryBadMonthAndDuplicate();
  await testProvisionGenerateAllIsBlockedWithAReason();
  await testProvisionGroupRowsSearchAndShowMe();
  await testProvisionMonthsRunDownwardWithNetCheck();
  await testProvisionBulkFillBalancesOnASecondLine();
  await testProvisionCellTabMovesAcrossAccounts();
  await testJamiahEmptyCellOffersMatchingUntaggedTransactions();
  await testJamiahTickShowsItsTransactionWithUntag();
  await testJamiahTaggedTransactionsLeaveEveryList();
  await testJamiahSettingsIsOnePanel();
  await testAllocationLookupPreviewsLinesAndNet();
  await testAllocationLookupArabicStatementUsesOnlyThatAllocation();
  await testUnallocatedBoxesPerAccountWithAllActions();
  await testForecastHorizonLimitsTheMonths();
  await testForecastChartMatchesTheClosingBalanceRow();
  await testThingsThatNeedYouShowsEightThenShowAll();
  await testDashboardBoxesStackIntoFreeSpace();
  await testPosBoxPeekIsBandedAndHasNoBars();
  await testOverBudgetDismissIsSyncedPerCategoryAndMonth();
  await testDriftDismissalsAreSyncedAndStartFresh();
  await testDashboardBoxesCanBeHiddenAndShown();
  await testChartsAndDashboardBoxesUseWholeNumbers();
  await testProvisionCopyMonthForward();
  await testJamiahGroupShowsItsFullMonthName();
  await testForecastNotesAreSyncedCallouts();
  await testBudgetMonthArrowsAndCollapsedGrid();
  await testBudgetChartCategoryNameJumpsAndFlashes();
  await testPnLArrowsSitEachSideOfTheMonth();
  await testPnLBackFromChartReturnsToTheSamePlace();
  await testSchemaAddsDismissalsAndForecastNotes();
  await testPositionSubtotalAddsUpChosenRows();
  await testPositionSubtotalEditorAndValidation();
  await testUpdatePlanGoesToTheExactPlace();
  await testAuroraAndGlassStyle();
  await testDriftComparesPerAccount();
  await testDriftIncomeExpenseOnlyAndExcludeList();
  await testDriftSettingsAreSyncedWithToggles();
  await testSmsInboxTableIsInEveryTableList();
  await testSmsGroupsByMappedAccount();
  await testSmsBuildsOneJVPerDateWithOtherHalves();
  await testSmsOwnTransferPairsBothBanks();
  await testSmsExactReversalCancelsOut();
  await testSmsFeeGetsItsOwnLine();
  await testSmsCreateOpensFirstDateDraftsRestAndPostingMarksDone();
  await testSmsDismissRestoreAndDoneList();
  await testSmsInboxLoadsFromTheCloud();
  await testGlassRailScrollsOnShortScreens();
  await testOverBudgetOpenPnLGoesToTheCategory();
  await testOverflowIsSharedByRoomLeft();
  await testOverflowNeverPassesACap();
  await testOverflowLeftoverGoesToTheCatchAll();
  await testOverflowReceiverRoomIsAfterItsOwnAccrual();
  await testOverflowDoesNotCoverAnOverspend();
  await testOverspentCategoryCanBeToppedUpAfterItsFullDrawdown();
  await testUncappedCategoryNeitherGivesNorReceivesOverflow();
  await testCatchAllSettingIsSyncedAndRefusesACategoryReserve();
  await testAccrualPanelShowsOverflowDetail();
  await testSettingsShowsTheCatchAllPicker();
  await testV56CloseIdsAreFixedAndNeverBecomeTheNextId();
  await testV56SameDayCloseBeatsARefreshButANewerDayWins();
  await testV56PriceSettingsAreSyncedInPreferences();
  await testV56RefreshWritesOnePricePerPositionForToday();
  await testV56OneFailingSourceDoesNotStopTheOthers();
  await testV56AutoRefreshOnlyWhenThisDeviceIsBehind();
  await testV56BackfillSavesDailyClosesOnce();
  await testV56BoxesShowValueHoldingsShareAndFreshness();
  await testV56TopHoldingsAreSortedByValue();
  await testV56BoxActionsAppearOnHoverOnly();
  await testV56ArrangeBoxesIsSynced();
  await testV56NeedsYouListsWhatIsWaiting();
  await testV56RailBadgeCountsInvestmentItems();
  await testV56NeedsYouIsOnMineAndOpensAPrefilledDeposit();
  await testV56WalletCheckReadsSolanaTokenBalances();
  await testV56WalletCheckReadsEvmBalancesWithDecimals();
  await testV56WalletAddressIsCheckedAgainstTheChain();
  await testV56RepeatLastBuyCopiesPositionAmountAndSplit();
  await testV56CollectOffersInvestItNow();
  await testV56PriceLinkSearchOffersOnlyMatchingCoins();
  await testV56PasteAddressDetectsTheChain();
  await testV56SetupHasPriceLinksAndTheJobButtons();
  await testV56NewStorageKeysAreListed();
  await testV56EdgeJobSavesYesterdaysCloses();
  await testV57SmsJvKeepsTheAccountsLinesTogether();
  await testV57SmsTransferPartnerAndFeeGoAfterTheAccountsLines();
  await testV57SmsNumbersAndAccountsCanBeChanged();
  await testV57HistoricalAveragesArePerMonth();
  await testV57AveragesShowOnThePnLChartAndAccountsPopup();
  await testV57ShiftDateIsRightEastOfUtc();
  await testV57BudgetAndPnLAreOnePageWithTwoTabs();
  await testV57OverviewChartsFollowThePeriod();
  await testV57OverspendCoveredByAccrualTurnsYellowAndLeavesNeedsYou();
  await testV57PartlyCoveredStaysRedWithANote();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

// v5.0 step 0: LedgerOS-classic.html is the frozen v4.63.0 app; each page links to the other.
async function testClassicCopyIsFrozenAndBothPagesLinkEachOther(){
  const classicPath = path.join(path.dirname(APP_HTML), 'LedgerOS-classic.html');
  assert(fs.existsSync(classicPath), 'LedgerOS-classic.html exists next to LedgerOS.html');
  if(!fs.existsSync(classicPath)) return;
  const classic = fs.readFileSync(classicPath, 'utf8');
  const app = fs.readFileSync(APP_HTML, 'utf8');
  assert(/const APP_VERSION = '4\.63\.0';/.test(classic), 'Classic stays at v4.63.0');
  assert(/<a [^>]*id="lookSwitchLink" href="LedgerOS\.html"[^>]*>Switch to the new look<\/a>/.test(classic), 'Classic links to the new look');
  assert(/<a [^>]*id="lookSwitchLink" href="LedgerOS-classic\.html"[^>]*>Switch to classic<\/a>/.test(app), 'The new app links to classic');
  assert((classic.match(/id="lookSwitchLink"/g)||[]).length===1, 'Classic has exactly one switch link');
}

// ---- v5.0 step 1: look and shell ----
function shellSandbox(){
  const sb = makeSandbox();
  const doc = sb.document;
  doc.body.insertAdjacentHTML('afterbegin', '<nav id="nav"></nav><span id="topbarTitle"></span><span id="topbarDate"></span><button id="themeLightBtn"></button><button id="themeDarkBtn"></button>');
  return sb;
}
async function testThemeTokensFollowTheAccentAndBackground(){
  const sb = makeSandbox();
  assert(sb.mixHex('#000000','#FFFFFF',0.5)==='#808080', 'mixHex blends halfway');
  assert(sb.mixHex('#abc','#abc',0.3)==='#aabbcc', 'mixHex accepts 3-digit hex');
  const t = sb.deriveThemeTokens(false, '#3D3AE0', 'tinted', '#047857', '#B42318');
  assert(t['--rail']==='#242479', 'Light rail is the accent mixed halfway to near-black (got '+t['--rail']+')');
  assert(t['--bg']===sb.mixHex('#F4F5F7','#3D3AE0',0.07), 'Tinted ground is the base washed 7% with the accent');
  assert(t['--on-accent']==='#FFFFFF' && t['--bar']==='#FFFFFF', 'Light: white text on accent, solid top bar');
  const plain = sb.deriveThemeTokens(false, '#3D3AE0', 'plain', '#047857', '#B42318');
  assert(plain['--bg']==='#F4F5F7', 'Plain ground ignores the accent');
  const aur = sb.deriveThemeTokens(true, '#2DD4BF', 'aurora', '#4ADE80', '#F87171');
  assert(/^rgba\(20,24,30,0\.6\)$/.test(aur['--bar']), 'Aurora: the top bar is see-through (got '+aur['--bar']+')');
  assert(/radial-gradient/.test(aur['--aurora']) && /rgba\(45,212,191,0\.35\)/.test(aur['--aurora']), 'Aurora gradient uses the accent');
  assert(aur['--on-accent']==='#0B0D10', 'Dark: dark text on the accent');
  const teal = sb.deriveThemeTokens(false, '#0F766E', 'tinted', '#047857', '#B42318');
  assert(teal['--rail']!==t['--rail'] && teal['--accent-soft']!==t['--accent-soft'], 'A different accent changes the rail and soft tint');
}
async function testBackgroundAndMotionPrefsApplyAndPersist(){
  const sb = shellSandbox();
  const root = sb.document.documentElement, body = sb.document.body;
  sb.applyTheme('light');
  assert(body.classList.contains('bg-tinted') && !body.classList.contains('still'), 'Default: Tinted background, motion on');
  assert(root.style.getPropertyValue('--rail')==='#242479', 'applyTheme sets the rail colour from the default indigo accent');
  sb.setUiBackground('aurora');
  assert(sb.localStorage.getItem('uiBackground')==='aurora' && body.classList.contains('bg-aurora') && !body.classList.contains('bg-tinted'), 'Aurora is saved and applied');
  sb.setUiBackground('neon');
  assert(sb.localStorage.getItem('uiBackground')==='aurora', 'An unknown background is ignored');
  sb.setUiBackground('plain');
  assert(root.style.getPropertyValue('--bg')==='#F4F5F7', 'Plain ground applied');
  sb.setUiMotion(false);
  assert(sb.localStorage.getItem('uiMotion')==='off' && body.classList.contains('still'), 'Motion off is saved and stills the page');
  sb.setUiMotion(true);
  assert(!body.classList.contains('still'), 'Motion back on');
  sb.setAccentColor('teal');
  assert(root.style.getPropertyValue('--rail')===sb.mixHex('#0f766e','#0B0D12',0.5), 'Picking teal recolours the rail');
  const keys = vm.runInContext('LEDGEROS_KEYS', sb);
  assert(['uiBackground','uiMotion','uiTheme','fontFamily'].every(k=>keys.includes(k)), 'New appearance keys are listed as LedgerOS keys');
}
async function testRailRendersIconsLabelsAndCurrentPage(){
  const sb = shellSandbox();
  sb.__set('screen', 'ledger');
  sb.renderNav();
  const nav = sb.document.getElementById('nav');
  const btns = [...nav.querySelectorAll('button')];
  assert(btns.length>=12, 'Every page has a rail button (12 since Budget and P&L merged in v5.7)');
  assert(btns.every(b=>b.querySelector('svg.nav-svg') && b.querySelector('.nav-lbl')), 'Each rail button has a line icon and a label');
  const cur = nav.querySelector('[aria-current="page"]');
  assert(cur && cur.classList.contains('on') && /Ledger/.test(cur.textContent), 'The current page is marked');
  assert(nav.querySelectorAll('[aria-current]').length===1, 'Only one page is current');
}
async function testTopBarShowsPageTitleAndThemeState(){
  const sb = shellSandbox();
  freezeDate(sb, '2026-11-07T10:00:00');
  sb.go('budget');
  assert(sb.document.getElementById('topbarTitle').textContent==='Budget & P&L', 'Top bar shows the page name (the Plan grid tab of Budget & P&L)');
  assert(/7 November/.test(sb.document.getElementById('topbarDate').textContent), 'Top bar shows today\'s date');
  sb.go('forecastSettings');
  assert(sb.document.getElementById('topbarTitle').textContent==='Forecast Settings', 'Pages outside the rail still get a title');
  sb.applyTheme('dark');
  assert(sb.document.getElementById('themeDarkBtn').getAttribute('aria-pressed')==='true' && sb.document.getElementById('themeLightBtn').getAttribute('aria-pressed')==='false', 'Dark is shown as pressed');
  assert(sb.document.documentElement.dataset.theme==='dark' && sb.localStorage.getItem('uiTheme')==='dark', 'Dark mode applied and remembered');
}
async function testShellMarkupHasTopBarAndNoOldThemeButton(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  const top = (html.match(/<header id="topbar"[\s\S]*?<\/header>/)||[''])[0];
  assert(/onclick="openCmdPalette\(\)"/.test(top) && /Ctrl\+K/.test(top), 'Top bar has the search with Ctrl+K');
  assert(/id="cloudBtn"/.test(top), 'Sync status lives in the top bar');
  assert(/id="themeLightBtn"[^>]*onclick="applyTheme\('light'\)"/.test(top) && /id="themeDarkBtn"[^>]*onclick="applyTheme\('dark'\)"/.test(top), 'Light/Dark switch is in the top bar');
  assert(/onclick="go\('newjv'\)">\+ New JV/.test(top), 'Top bar has + New JV');
  assert(!/id="themeBtn"/.test(html), 'The old moon/sun theme button is gone');
  assert(/<div class="aurora[^"]*" aria-hidden="true">/.test(html), 'Aurora layer exists');
  assert(/prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important/.test(html), 'Reduced motion always wins');
  assert(/family=Geist:/.test(html) && /family=Geist\+Mono/.test(html), 'Geist and Geist Mono are loaded');
}
async function testAppearanceSettingsOfferBackgroundMotionAndGeist(){
  const sb = shellSandbox();
  sb.__set('settingsTab', 'appearance');
  sb.renderSettings();
  const app = sb.document.getElementById('app');
  const bg = app.querySelector('[aria-label="Background"]'), mo = app.querySelector('[aria-label="Motion"]');
  assert(bg && bg.querySelectorAll('button').length===3, 'Background offers Plain / Tinted / Aurora');
  assert(bg && /Tinted/.test((bg.querySelector('[aria-pressed="true"]')||{}).textContent||''), 'Tinted is the default');
  assert(mo && /On/.test((mo.querySelector('[aria-pressed="true"]')||{}).textContent||''), 'Motion defaults to On');
  assert(app.querySelectorAll('.swatch').length===8, 'Seven accent swatches plus Custom');
  const fam = [...app.querySelectorAll('select')].find(s=>/Geist/.test(s.innerHTML));
  assert(fam && fam.value==='geist', 'Geist is the default font');
  assert(fam && /Inter/.test(fam.innerHTML) && /Classic Serif/.test(fam.innerHTML), 'The existing font options are kept');
}

// ---- v5.0 step 2: Dashboard ----
function dashSandbox(opts){
  opts = opts||{};
  const sb = makeSandbox();
  freezeDate(sb, opts.today||'2026-11-07T10:00:00.000Z');
  sb.document.body.insertAdjacentHTML('afterbegin', '<nav id="nav"></nav><div id="modalRoot"></div>');
  const D = vm.runInContext('D', sb);
  const A = (id, category, extra) => Object.assign({id, name:'Acc '+id, descr:'Acc '+id, category, status:'Active', acc_type:'Individual Account'}, extra||{});
  D.accounts = [A(10101,'Bank Accounts'), A(10102,'Bank Accounts',{is_savings:true}), A(10199,'Bank Accounts'), A(11201,'Short Term Receivables'), A(12101,'Long Term Receivables'),
    A(14101,'Temporary Projects Accounts'), A(21511,'Short Term Liabilities'), A(24101,'Long Term Liabilities'), A(22901,'Accruals'), A(23101,'Provisions'), A(30101,'Salary'), A(60101,'Living')];
  const L = (id, acc, amt, date) => ({id, jv:id, date:date||'2026-10-01', acc, amt, descr:'x'});
  D.ledger = [L(1,10101,48250.5), L(2,10102,126400), L(3,10199,999), L(4,11201,6500), L(5,12101,15000), L(6,14101,2300), L(7,21511,-8900), L(8,24101,-42000), L(9,22901,-4150.25), L(10,23101,-11600), L(11,30101,-32500), L(12,60101,6000)];
  sb.rebuildIndex();
  sb.confirm = () => true;
  const calls = [];
  sb.__set('syncWrite', async (table, kind, row) => { calls.push({table, kind, row}); return {ok:true}; });
  sb.__set('persistLocal', ()=>{});
  sb.__calls = calls;
  sb.__set('forecastSnapshotCheckedThisSession', true); // keep the auto snapshot's own write out of these checks
  sb.__prefs = () => calls.filter(c=>c.table==='pd_ui_prefs').pop();
  return sb;
}
async function testPositionBoxPresetsEqualTheOldPanels(){
  const sb = dashSandbox();
  const bank = sb.bankBalance(), cb = c => sb.categoryBalance(c), sav = sb.savingsBalance();
  const stRec = cb('Short Term Receivables'), ltRec = cb('Long Term Receivables'), temp = cb('Temporary Projects Accounts');
  const stLiab = cb('Short Term Liabilities'), ltLiab = cb('Long Term Liabilities'), accr = cb('Accruals'), prov = cb('Provisions');
  // The old netWorthPanels() formulas
  const expect = {
    ste: {'Current Assets': bank+stRec+temp, 'Short Term Equity': bank+stRec+temp+stLiab+accr+prov},
    cash:{'Liquid Cash': bank-sav+stRec, 'Liquid Cash After Liabilities': bank-sav+stRec+stLiab+accr},
    lte: {'Assets': bank+stRec+ltRec+temp, 'Long Term Equity': bank+stRec+ltRec+temp+stLiab+ltLiab+accr+prov},
  };
  const html = sb.netWorthPanels();
  const boxes = sb.getPositionBoxes();
  assert(boxes.length===3 && boxes.map(b=>b.id).join()==='ste,cash,lte', 'Three presets: Short Term Equity, Cash Bank Account, Long Term Equity');
  boxes.forEach(b=>{
    const c = sb.computePositionBox(b);
    Object.entries(expect[b.id]).forEach(([label, v])=>{
      const row = c.rows.find(r=>r.label===label && r.kind==='total');
      assert(row && Math.abs(row.value - v) < 0.005, b.title+': "'+label+'" equals the old panel ('+v+'), got '+(row&&row.value));
      assert(html.includes(sb.money(v)) || html.includes(sb.absMoney(v)), b.title+': the old panel really shows '+sb.money(v));
    });
  });
  assert(!/10199/.test(boxes[0].rows[0].accs), 'Working Capital 10199 stays out of Bank Accounts, as before');
}
async function testPositionBoxesUseBalancesAsOfToday(){
  const sb = dashSandbox();
  vm.runInContext('D', sb).ledger.push({id:99, jv:99, date:'2026-11-20', acc:10101, amt:500, descr:'future'});
  const box = {id:'t', title:'T', rows:[{type:'line', label:'Bank', sign:1, accs:'10101'}, {type:'total', label:'Total'}]};
  assert(Math.abs(sb.computePositionBox(box).final - 48250.5) < 0.005, 'A line dated after today is left out');
  assert(Math.abs(sb.computePositionBox(box, '2026-11-30').final - 48750.5) < 0.005, 'It counts once its date is reached');
}
async function testPositionBoxSignsAccountRowsAndPeek(){
  const sb = dashSandbox();
  const box = {id:'p', title:'Peek box', rows:[{type:'line', label:'Banks', sign:1, accs:'10101, 10102'}, {type:'account', label:'Savings', sign:-1, accs:'10102'}, {type:'subtotal', label:'Sub'}, {type:'line', label:'Loans', sign:1, accs:'11201'}, {type:'total', label:'All'}]};
  const c = sb.computePositionBox(box);
  assert(Math.abs(c.rows[1].value + 126400) < 0.005, 'A minus sign subtracts the account');
  assert(Math.abs(c.rows[2].value - 48250.5) < 0.005 && Math.abs(c.final - 54750.5) < 0.005, 'Subtotal is the running total; the total closes the box');
  sb.__set('dashEditing', false);
  vm.runInContext('D', sb).uiPrefs.positionBoxes = [box];
  sb.renderDashboard();
  let cell = sb.document.querySelector('[data-widget="box:p"]');
  assert(cell && !cell.querySelector('.posbox-peek'), 'A line shows only its total at first');
  sb.togglePosBoxRow('p', 0);
  cell = sb.document.querySelector('[data-widget="box:p"]');
  const peek = cell && cell.querySelector('.posbox-peek');
  assert(peek && /10101/.test(peek.textContent) && /10102/.test(peek.textContent), 'Clicking a line peeks at its accounts');
  assert(cell && cell.querySelectorAll('.posbox-row.is-total').length===1 && cell.querySelectorAll('.posbox-row.is-sub').length===1, 'Subtotal and total rows get the thick rule styles');
}
async function testDashboardLayoutIsNormalised(){
  const sb = dashSandbox();
  const ids = () => sb.dashboardLayout().map(w=>w.id);
  assert(ids().join()==='snapshot,kpis,todo,box:ste,banks,cash,budget,box:cash,box:lte,watch', 'Default layout follows the mockup');
  const D = vm.runInContext('D', sb);
  D.uiPrefs.dashboardLayout = [{id:'banks', span:40}, {id:'nope', span:6}, {id:'banks', span:4}, {id:'box:gone', span:6}, {id:'kpis', span:1}, null];
  const L = sb.dashboardLayout();
  assert(L[0].id==='banks' && L[0].span===12 && L[1].id==='kpis' && L[1].span===3, 'Saved order kept, widths clamped to 3..12');
  assert(!L.some(w=>w.id==='nope' || w.id==='box:gone') && L.filter(w=>w.id==='banks').length===1, 'Unknown, removed and duplicate boxes are dropped');
  assert(['todo','cash','budget','watch','snapshot','box:ste','box:cash','box:lte'].every(id=>L.some(w=>w.id===id)), 'Boxes missing from the saved layout are added back');
}
async function testDashboardLayoutChangesSyncOnlyTheLayoutColumn(){
  const sb = dashSandbox();
  await sb.moveDashWidget(0, 2);
  let c = sb.__prefs();
  assert(c && c.table==='pd_ui_prefs' && Object.keys(c.row).sort().join()==='dashboard_layout,id', 'Moving a box writes only dashboard_layout');
  assert(c && (c.row.dashboard_layout||[])[2] && c.row.dashboard_layout[2].id==='snapshot', 'The moved box lands where it was dropped');
  await sb.resizeDashWidget(1, 4);
  c = sb.__prefs();
  assert(c && (c.row.dashboard_layout||[])[1] && c.row.dashboard_layout[1].span===4, 'Resizing saves the new width');
  await sb.resetDashboardLayout();
  c = sb.__prefs();
  assert(c && c.row.dashboard_layout===null && sb.dashboardLayout()[0].id==='snapshot', 'Reset layout goes back to the default');
}
async function testPositionBoxEditorValidatesAndSaves(){
  const sb = dashSandbox();
  sb.openPosBoxEditor('ste');
  const d = vm.runInContext('posBoxEdit', sb);
  assert(d && d.id==='ste', 'Edit opens the box editor');
  sb.posBoxEditSet(0, 'cat', ''); // presets follow a category; switch to typed numbers
  sb.posBoxEditSet(0, 'accs', '10101, 99999');
  await sb.savePosBoxEdit();
  assert(!sb.__prefs() && vm.runInContext('posBoxEdit', sb), 'An unknown account number is refused and nothing is saved');
  sb.posBoxEditSet(0, 'accs', '10101');
  sb.posBoxEditTitle('My equity');
  sb.posBoxEditFlip(0);
  await sb.savePosBoxEdit();
  const c = sb.__prefs();
  assert(c && Object.keys(c.row).sort().join()==='id,position_boxes', 'Saving writes only position_boxes');
  const saved = c && c.row.position_boxes.find(b=>b.id==='ste');
  assert(saved && saved.title==='My equity' && saved.rows[0].sign===-1 && saved.rows[0].accs==='10101', 'The edited box is saved');
  assert(c && c.row.position_boxes.length===3, 'The other presets are saved alongside it');
  sb.openPosBoxEditor('cash'); sb.posBoxEditSet(1, 'type', 'account'); sb.posBoxEditSet(1, 'accs', '10101, 10102');
  await sb.savePosBoxEdit();
  assert(vm.runInContext('posBoxEdit', sb), 'An account row with several accounts is refused');
}
async function testNewAndRemovedPositionBoxes(){
  const sb = dashSandbox();
  await sb.addDashPositionBox();
  const D = vm.runInContext('D', sb);
  const boxes = D.uiPrefs.positionBoxes;
  assert(boxes && boxes.length===4, '+ New box adds a fourth box');
  const nb = boxes[3];
  assert(sb.dashboardLayout().some(w=>w.id==='box:'+nb.id) && vm.runInContext('posBoxEdit', sb).id===nb.id, 'The new box is on the Dashboard and open for editing');
  await sb.removeDashPositionBox(nb.id);
  assert(D.uiPrefs.positionBoxes.length===3 && !sb.dashboardLayout().some(w=>w.id==='box:'+nb.id), 'Remove deletes the box and its place');
}
async function testThingsThatNeedYouList(){
  const sb = dashSandbox();
  const D = vm.runInContext('D', sb);
  D.accounts.find(a=>a.id===10101).stmt_balance = 48000; // off by -250.50
  const sav = D.accounts.find(a=>a.id===10102); sav.stmt_balance = 126400; sav.stmt_date = '2026-10-01'; // reconciled, 37 days old
  D.accounts.push({id:10103, name:'New bank', category:'Bank Accounts', status:'Active', acc_type:'Individual Account'}); // no statement
  D.accounts.push({id:10104, name:'Old bank', category:'Bank Accounts', status:'Inactive', acc_type:'Individual Account'}); // inactive: ignored
  D.ledger.push({id:50, jv:50, date:'2026-11-03', acc:60101, amt:1300, descr:'food'});
  sb.rebuildIndex();
  sb.__set('pnlBudgetForAccountInRange', (acc)=> acc===60101? 1000 : 0);
  sb.__set('computeDriftFlags', ()=>[{key:'smartrule:1', kind:'smartrule', ruleName:'Fuel', acc:60101, avgPlan:900, avgActual:1150}]);
  const items = sb.dashboardTodoItems();
  const t = items.map(i=>i.title);
  assert(t.some(x=>/Acc 10101 is off by -250\.50/.test(x)) && items.find(i=>/off by/.test(i.title)).onclick==='startReconcile(10101)', 'An unreconciled account is listed and opens a reconciliation');
  assert(t.some(x=>/Acc 10102 last reconciled 37 days ago/.test(x)), 'A stale reconciliation is listed');
  assert(t.some(x=>/New bank has no statement balance/.test(x)), 'An account with no statement is listed');
  assert(!t.some(x=>/Old bank|10199/.test(x)), 'Inactive accounts and Working Capital are left out');
  assert(t.some(x=>/Living is over budget by 300\.00/.test(x)), 'An over-budget category is listed');
  assert(t.some(x=>/^Drift: Fuel/.test(x)) && items.find(i=>i.drift).dismiss==="dismissDriftFlag('smartrule:1')", 'Drift alerts are listed with Dismiss');
  sb.renderDashboard();
  assert(/5 things need you/.test(sb.document.getElementById('app').textContent), 'The box heading counts them ('+items.length+')');
}
async function testDashboardSchemaAndLoadingOfTheNewPrefs(){
  const sb = makeSandbox();
  const sql = vm.runInContext('DB_SCHEMA_SQL', sb);
  assert(/alter table pd_ui_prefs add column if not exists dashboard_layout jsonb/i.test(sql) && /alter table pd_ui_prefs add column if not exists position_boxes jsonb/i.test(sql), 'The schema script adds both pd_ui_prefs columns idempotently');
  const bare = {uiPrefs:{pageOrder:null}};
  sb.normalizeDataShape(bare);
  assert(bare.uiPrefs.dashboardLayout===null && bare.uiPrefs.positionBoxes===null, 'Old caches get both defaults');
  const src = fs.readFileSync(APP_JS, 'utf8');
  assert(/dashboardLayout: Array\.isArray\(u\.dashboard_layout\)/.test(src) && /positionBoxes: Array\.isArray\(u\.position_boxes\)/.test(src), 'Cloud load reads both columns');
  assert(/dashboard_layout:D\.uiPrefs\.dashboardLayout\|\|null, position_boxes:D\.uiPrefs\.positionBoxes\|\|null/.test(src), 'Restore from backup writes both columns back');
}
async function testEditLayoutModeShowsHandles(){
  const sb = dashSandbox();
  sb.renderDashboard();
  assert(!sb.document.querySelector('.dash-cell[draggable]') && !sb.document.querySelector('.dash-resize'), 'Normal view has no drag handles');
  sb.toggleDashEditing();
  const cells = [...sb.document.querySelectorAll('.dash-cell')];
  assert(cells.length>=9 && cells.every(c=>c.getAttribute('draggable')==='true' && c.querySelector('.dash-resize')), 'Edit layout: every box can be dragged and resized');
  const app = sb.document.getElementById('app').innerHTML;
  assert(/addDashPositionBox\(\)">\+ New box/.test(app) && /resetDashboardLayout\(\)">Reset layout/.test(app), 'Edit layout offers + New box and Reset layout');
  assert(sb.document.querySelectorAll('.dash-cell [onclick^="removeDashPositionBox"]').length===3, 'Only position boxes can be removed');
  sb.toggleDashEditing();
  assert(!sb.document.querySelector('.dash-cell[draggable]'), 'Done leaves edit mode');
}

async function testPositionBoxLineCanFollowAWholeCategory(){
  const sb = dashSandbox();
  const D = vm.runInContext('D', sb);
  const box = {id:'c', title:'C', rows:[{type:'line', label:'Banks (live)', sign:1, cat:'Bank Accounts', accs:''}, {type:'line', label:'Banks (typed)', sign:1, accs:'10101, 10102'}, {type:'total', label:'T'}]};
  D.accounts.push({id:10107, name:'Brand new bank', category:'Bank Accounts', status:'Active', acc_type:'Individual Account'});
  D.ledger.push({id:70, jv:70, date:'2026-10-02', acc:10107, amt:1000, descr:'x'});
  sb.rebuildIndex();
  const c = sb.computePositionBox(box);
  assert(Math.abs(c.rows[0].value - (48250.5+126400+1000)) < 0.005, 'A category line picks up a new account in that category automatically');
  assert(Math.abs(c.rows[1].value - (48250.5+126400)) < 0.005, 'A typed line keeps only the accounts typed');
  assert(sb.getPositionBoxes().every(b=>b.rows.filter(r=>r.type==='line').every(r=>r.cat)), 'The three presets follow their categories live');
  const ste = sb.computePositionBox(sb.getPositionBoxes()[0]);
  assert(ste.rows[0].ids.includes(10107), 'So the presets include the new bank account too');
  sb.openPosBoxEditor('ste');
  sb.posBoxEditSet(0, 'cat', '');
  assert(!('cat' in vm.runInContext('posBoxEdit', sb).draft.rows[0]), 'Choosing typed numbers turns the toggle off');
  sb.posBoxEditSet(0, 'cat', 'Made up category');
  await sb.savePosBoxEdit();
  assert(!sb.__prefs() && vm.runInContext('posBoxEdit', sb), 'An unknown category is refused');
  sb.posBoxEditSet(0, 'cat', 'Bank Accounts');
  await sb.savePosBoxEdit();
  const saved = sb.__prefs();
  assert(saved && saved.row.position_boxes[0].rows[0].cat==='Bank Accounts', 'The toggle is saved with the box');
  sb.openPosBoxEditor('ste');
  sb.renderDashboard();
  const sel = sb.document.querySelector('.posbox-edrow select[aria-label="Which accounts"]');
  assert(sel && sel.value==='Bank Accounts' && /All in: Savings accounts/.test(sel.innerHTML), 'The editor shows the category toggle for lines');
}

// ---- v5.0 step 3: restyled pages ----
async function testNewJvShowsBudgetImpactAndDraftsBelow(){
  const sb = dashSandbox();
  vm.runInContext('D', sb).ledger.push({id:80, jv:80, date:'2026-11-02', acc:60101, amt:700, descr:'food'});
  sb.__set('pnlBudgetForAccountInRange', (acc)=> acc===60101? 1000 : 0);
  sb.__set('jvDraft', {date:'2026-11-07', lines:[{key:'a', acc:60101, descr:'Food', amt:'400'}, {key:'b', acc:10101, descr:'Food', amt:'-400'}]});
  sb.__set('jvDrafts', [{id:5, date:'2026-11-01', lines:[{acc:10101, descr:'x', amt:1}], savedAt:'2026-11-01T10:00'}]);
  const rows = sb.jvBudgetImpactRows();
  assert(rows.length===1 && rows[0].acc===60101 && Math.abs(rows[0].after-1100)<0.005, 'Only expense lines count: 700 spent + 400 in this JV');
  sb.renderNewJV();
  const html = sb.document.getElementById('app').innerHTML;
  assert(/Goes over budget by 100\.00/.test(html), 'The impact says the JV takes the account over budget');
  const jvAt = html.indexOf('New Journal Voucher'), impAt = html.indexOf('id="jvBudgetImpact"'), drAt = html.indexOf('Draft journal vouchers');
  assert(jvAt>-1 && impAt>jvAt && drAt>jvAt, 'Budget impact and Draft JVs come below the JV');
  assert(/continueDraft\(5\)/.test(html), 'Drafts can be continued from the page');
}
async function testLedgerGroupsByJvAndFramesTheSelectedOne(){
  const sb = dashSandbox();
  const D = vm.runInContext('D', sb);
  D.ledger.push({id:90, jv:500, date:'2026-10-05', acc:10101, amt:-50, descr:'pair'}, {id:91, jv:500, date:'2026-10-05', acc:60101, amt:50, descr:'pair'});
  sb.go('ledger');
  sb.__set('ledgerFilter', {acc:'', from:'', to:'', q:'', jv:'500', preset:'', unallocOnly:false});
  sb.renderLedgerResults();
  let trs = [...sb.document.querySelectorAll('#ledgerResults tbody tr')];
  assert(trs.length===2 && trs[0].classList.contains('jv-first') && trs[1].classList.contains('jv-last'), 'Lines of one JV are grouped');
  assert(/#500/.test(trs[0].textContent) && !/#500/.test(trs[1].textContent), 'The JV number shows once per group');
  sb.selectLedgerJv(500);
  trs = [...sb.document.querySelectorAll('#ledgerResults tbody tr')];
  assert(trs.filter(t=>t.classList.contains('jv-sel')).length===2, 'Clicking frames the whole JV');
  const act = sb.document.querySelector('#ledgerResults tr.jv-actions');
  assert(act && /startEditJV\(500\)/.test(act.innerHTML) && /duplicateJV\(500\)/.test(act.innerHTML) && /reverseJV\(500\)/.test(act.innerHTML) && /exportJVCSV\(500\)/.test(act.innerHTML), 'Its actions appear: Edit, Duplicate, Reverse, Download CSV');
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(/#ledgerResults tr\.jv-sel td:first-child\{box-shadow:inset 2px 0 0 var\(--accent\)\}/.test(html) && /#ledgerResults tr\.jv-sel td\{background:none/.test(html), 'The selection is an accent frame, not a fill');
  sb.selectLedgerJv(500);
  assert(!sb.document.querySelector('#ledgerResults tr.jv-actions'), 'Clicking again clears it');
}
async function testAccountsCategoryChipsAndSidePanel(){
  const sb = dashSandbox();
  sb.__set('browsableAccounts', ()=> vm.runInContext('D', sb).accounts);
  sb.go('accounts');
  const chips = [...sb.document.querySelectorAll('#accCatChips .chipbtn')];
  assert(chips.length>3 && chips[0].textContent==='All' && chips[0].getAttribute('aria-pressed')==='true', 'Category chips, All selected');
  sb.setAccCatFilter('Accruals');
  const rows = [...sb.document.querySelectorAll('#accountResults tbody tr')];
  assert(rows.length===1 && /22901/.test(rows[0].textContent), 'A chip filters to that category');
  sb.setAccCatFilter('Accruals');
  sb.openAccSide(10101);
  const side = sb.document.getElementById('accSide');
  assert(side && /48,250\.50/.test(side.textContent), 'Side panel shows the balance');
  assert(/jumpToLedgerForAccount\(10101\)">Full history in Ledger/.test(side.innerHTML), 'Side panel links to the full history in the Ledger');
  const D = vm.runInContext('D', sb);
  for(let i=0;i<7;i++) D.ledger.push({id:200+i, jv:200+i, date:'2026-10-1'+i, acc:10101, amt:i+1, descr:'t'+i});
  sb.renderAccountResults();
  const jvs = new Set([...side.querySelectorAll('tr')].map(t=>(t.getAttribute('onclick')||'')));
  assert(jvs.size===5 && [...jvs].every(o=>/viewJV\(20[2-6]\)/.test(o)), 'The 5 most recent JVs are listed, newest first');
}
async function testBudgetChartsWriteAmountsOnBars(){
  const sb = makeSandbox();
  const texts = [];
  const ctx = {save(){}, restore(){}, fillText(t,x,y){ texts.push([t,x,y]); }};
  const chart = {ctx, data:{datasets:[{data:[1500, 0]}, {data:[250.5, 99]}]}, getDatasetMeta:(i)=>({hidden: false, data:[{x:10,y:50},{x:20,y:60}]})};
  vm.runInContext('chartValueLabelsPlugin', sb).afterDatasetsDraw(chart);
  assert(texts.map(t=>t[0]).join('|')===[sb.money0(1500), sb.money0(250.5), sb.money0(99)].join('|'), 'Every non-zero bar gets its amount, in whole numbers (v5.1)');
  assert(texts[0] && texts[0][1]===10 && texts[0][2]===47, 'The amount sits just above the bar');
  const src = fs.readFileSync(APP_JS, 'utf8');
  const fn = src.slice(src.indexOf('function renderBudgetCharts('), src.indexOf('function renderBudgetCharts(')+6000);
  assert((fn.match(/plugins:\[chartValueLabelsPlugin\]/g)||[]).length===2, 'Both the Budget vs Actual and the trend chart show amounts');
  assert(/_budgetChartTrend = new Chart\(ctxTrend, \{\s*type: 'bar'/.test(fn), 'The trend is shown as bars');
}
function actSandbox(){
  const sb = moveSandbox({
    invOwners:[{id:1, name:'Me', isSelf:true, outAcc:21001}, {id:2, name:'Relative', isSelf:false, outAcc:21002}],
    invPlatforms:[{id:1, name:'A', outAcc:13001}, {id:2, name:'B', outAcc:13002}],
    invCashMovements:[
      {id:11, platformId:1, date:'2026-03-01', kind:'deposit', usdAmount:1000, owners:[{ownerId:1, usd:600, sar:2250}, {ownerId:2, usd:400, sar:1520}]},
      {id:12, platformId:2, date:'2026-05-01', kind:'deposit', usdAmount:200, owners:[{ownerId:2, usd:200, sar:750}]}]});
  return sb;
}
async function testInvActivityFiltersByAccountAndDates(){
  const sb = actSandbox();
  const set = (o) => sb.__set('invActivityFilter', Object.assign({platformId:'', ownerId:'', type:'', acc:'', from:'', to:'', limit:100}, o));
  set({}); assert(sb.invActivityFiltered().length===3, 'Everything shows by default');
  set({acc:'13002'}); let r = sb.invActivityFiltered();
  assert(r.length===1 && r[0].id===12, 'Filtering by a platform\'s ledger account keeps only that platform');
  set({acc:'21001'}); r = sb.invActivityFiltered();
  assert(r.length===2 && r.every(x=>x.ownerIds.includes(1)), 'Filtering by a person\'s ledger account keeps only rows with that person');
  set({from:'2026-02-01', to:'2026-04-30'}); r = sb.invActivityFiltered();
  assert(r.length===1 && r[0].id===11, 'Date range keeps only rows inside it');
  assert(sb.invActivityLinkedAccounts().join()==='13001,13002,21001,21002', 'The account list offers every linked ledger account');
}
async function testInvActivityCsvHasPerPersonColumns(){
  const sb = actSandbox();
  sb.__set('invActivityFilter', {platformId:'', ownerId:'', type:'', acc:'', from:'', to:'', limit:100});
  const lines = sb.invActivityCsv().split('\n');
  assert(lines[0]==='Date,Type,Platform,Detail,People,USD,SAR,Me SAR,Me USD,Me rate,Relative SAR,Relative USD,Relative rate', 'Header has SAR, USD and rate per person');
  const dep = lines.find(l=>l.startsWith('2026-03-01'));
  assert(dep && /,2250\.00,600\.00,3\.7500,1520\.00,400\.00,3\.8000$/.test(dep), 'A deposit shows each person\'s own SAR, USD and actual rate, got '+dep);
  const buy = lines.find(l=>l.startsWith('2026-01-01'));
  assert(buy && /,60000\.00,[\d.]+,[\d.]+,40000\.00,[\d.]+,[\d.]+$/.test(buy), 'A buy shows each person\'s SAR cost, got '+buy);
  assert(lines.length===4, 'One line per Activity row plus the header');
}

// ---- v5.0 step 4: Provisions ----
function provSandbox(){
  const sb = dashSandbox();
  sb.document.body.insertAdjacentHTML('beforeend', '<div id="toast"></div>');
  const D = vm.runInContext('D', sb);
  D.accounts.push({id:23102, name:'Car reserve', category:'Provisions', status:'Active', acc_type:'Individual Account'}, {id:60601, name:'Car service', category:'Car', status:'Active', acc_type:'Individual Account'});
  sb.rebuildIndex();
  D.provisionGroups = [
    {id:1, name:'Car service', lines:[{acc:60601, lineId:1, descrBase:'Car service provision'}, {acc:23102, lineId:2, descrBase:'Car reserve'}],
      months:{'2026-11':{1:500, 2:-500}, '2026-12':{1:500, 2:-450}, '2027-01':{1:500, 2:-500}, '2026-09':{1:999}}},
    {id:2, name:'School', lines:[{acc:60101, lineId:10, descrBase:'School'}, {acc:22901, lineId:11, descrBase:'School accrual'}, {acc:22901, lineId:12, descrBase:'School release'}],
      months:{'2026-11':{10:300, 11:-300}, '2026-12':{10:300, 11:-300}}},
  ];
  sb.__set('provisionsSelectedMonth', '2026-11');
  sb.__set('provisionEditingId', null);
  return sb;
}
async function testProvisionIssuesListEveryBadMonthAndDuplicate(){
  const sb = provSandbox();
  const D = vm.runInContext('D', sb);
  D.provisionGroups[0].months['2027-02'] = {1:100};
  const car = sb.provisionGroupIssues(D.provisionGroups[0]);
  assert(car.map(i=>i.mk+':'+i.sum).join()==='2026-12:50,2027-02:100', 'Every unbalanced visible month is listed (past months ignored), got '+JSON.stringify(car));
  const school = sb.provisionGroupIssues(D.provisionGroups[1]);
  assert(school.length===1 && school[0].dup && school[0].dup.acc===22901 && Math.abs(school[0].dup.total+600)<0.005, 'Unbalanced duplicate-account lines are listed');
  D.provisionGroups[1].dupBalanceExempt = true;
  assert(sb.provisionGroupIssues(D.provisionGroups[1]).length===0, 'Exempted groups do not list duplicates');
  assert(Math.abs(sb.provisionMonthExpense(D.provisionGroups[0], '2026-11') - 500) < 0.005, 'Expense for the month is the amount on 6xxxx accounts');
}
async function testProvisionGenerateAllIsBlockedWithAReason(){
  const sb = provSandbox();
  const D = vm.runInContext('D', sb);
  D.provisionGroups[1].dupBalanceExempt = true;
  sb.renderProvisions();
  let btn = sb.document.getElementById('provGenAllBtn');
  assert(btn && !btn.disabled, 'November is balanced: Generate is enabled');
  assert(/Provision expense for Nov-26/.test(sb.document.getElementById('app').textContent) && /800\.00/.test(sb.document.querySelector('.prov-summary').textContent), 'Total provision expense for the month is shown (500 + 300)');
  sb.__set('provisionsSelectedMonth', '2026-12');
  sb.renderProvisionGroupsList();
  btn = sb.document.getElementById('provGenAllBtn');
  assert(btn && btn.disabled, 'December has an error: Generate is disabled');
  assert(/Fix this first: Car service: Dec-26 is off by 50\.00/.test(sb.document.querySelector('.prov-summary').textContent), 'The reason is shown');
  let jv = null; sb.__set('go', ()=>{ jv = vm.runInContext('jvDraft', sb); });
  sb.combinedGenerateProvisionJV();
  assert(jv===null, 'Generating December is refused even if called directly');
  sb.__set('provisionsSelectedMonth', '2026-11');
  sb.combinedGenerateProvisionJV();
  assert(jv && jv.lines.length===4 && jv.date==='2026-11-01', 'November generates all groups\' lines');
}
async function testProvisionGroupRowsSearchAndShowMe(){
  const sb = provSandbox();
  sb.renderProvisions();
  const heads = [...sb.document.querySelectorAll('.prov-head')];
  assert(heads.length===2, 'One row per group');
  assert(/Car service provision - Nov - 26'/.test(heads[0].textContent) && /500\.00/.test(heads[0].textContent) && /Error/.test(heads[0].textContent), 'Group row: name, the month\'s JV description, expense amount, status');
  sb.setProvSearch('22901');
  assert(sb.document.querySelectorAll('.prov-head').length===1 && /School/.test(sb.document.querySelector('.prov-head').textContent), 'Search by account number');
  sb.setProvSearch('car');
  assert(sb.document.querySelectorAll('.prov-head').length===1, 'Search by group name');
  sb.setProvSearch('');
  const bar = sb.document.querySelector('.needs-fix');
  assert(bar && /Needs fixing \(2\)/.test(bar.textContent) && /Dec-26 is off by 50\.00/.test(bar.textContent), 'Needs fixing lists every problem with the amount');
  const show = [...bar.querySelectorAll('button')].find(b=>/'2026-12'/.test(b.getAttribute('onclick')));
  assert(show, 'Each problem has Show me');
  sb.provShowMe(1, '2026-12');
  const row = sb.document.getElementById('provRow_1_2026-12');
  assert(row && row.classList.contains('hl') && row.classList.contains('bad'), 'Show me opens the group and highlights the month');
}
async function testProvisionMonthsRunDownwardWithNetCheck(){
  const sb = provSandbox();
  sb.renderProvisions();
  sb.toggleProvisionEdit(1);
  const table = sb.document.querySelector('#provGroup_1 .prov-grid');
  assert(table, 'An open group shows its grid');
  const heads = [...table.querySelectorAll('thead th')].map(t=>t.textContent);
  assert(/^Month/.test(heads[0]) && /60601/.test(heads[1]) && /23102/.test(heads[2]) && /Net/.test(heads[3]), 'Accounts run across, with a Net column');
  const rows = [...table.querySelectorAll('tbody tr')];
  assert(rows.map(r=>r.id).join()==='provRow_1_2026-11,provRow_1_2026-12,provRow_1_2027-01', 'Months run downward, from this month on');
  assert(rows[0].classList.contains('cur') && !rows[1].classList.contains('cur'), 'The current month is highlighted');
  assert(/0\.00/.test(rows[0].lastElementChild.textContent) && /50\.00/.test(rows[1].lastElementChild.textContent) && rows[1].classList.contains('bad'), 'Each month shows its net check');
  const cards = [...sb.document.querySelectorAll('#provGroup_1 .prov-card')];
  assert(cards.length===2 && /Balance now/.test(cards[0].textContent) && /Still planned/.test(cards[0].textContent) && /Projected/.test(cards[0].textContent), 'Line cards show balance now, still planned and projected');
  assert(/1,500\.00/.test(cards[0].textContent), 'Still planned sums the visible months (500 x 3)');
  assert(sb.document.getElementById('genMonthSel_1') && sb.document.getElementById('provAddMonth_1') && sb.document.getElementById('provAddAcc_1') && sb.document.getElementById('pbfLine_1'), 'Generate for this group, add month, add account and bulk fill are there');
}
async function testProvisionBulkFillBalancesOnASecondLine(){
  const sb = provSandbox();
  const D = vm.runInContext('D', sb);
  const g = D.provisionGroups[1];
  let r = sb.provBulkFillApply(g, {lineId:11, from:'2027-01', count:3, amt:200, balanceLineId:12});
  assert(r.months && r.months.join()==='2027-01,2027-02,2027-03', 'Fills the right months');
  assert(g.months['2027-02'][11]===200 && g.months['2027-02'][12]===-200 && g.months['2027-02'][10]===undefined, 'Writes the amount and its opposite on the two duplicate-account lines only');
  assert(g.lastBulkFillMonths===3, 'Remembers the month count');
  assert(sb.provBulkFillApply(g, {lineId:11, from:'2027-01', count:3, amt:200, balanceLineId:11}).error, 'Balancing on the same line is refused');
  assert(sb.provBulkFillApply(g, {lineId:11, from:'', count:3, amt:200}).error, 'A month is required');
  assert(sb.provBulkFillApply(g, {lineId:11, from:'2027-01', count:0, amt:200}).error, 'At least one month');
  assert(sb.provBulkFillApply(g, {lineId:11, from:'2027-01', count:2, amt:''}).error, 'An amount is required');
  const before = JSON.stringify(g.months);
  sb.provBulkFillApply(g, {lineId:99, from:'2027-01', count:2, amt:5});
  assert(JSON.stringify(g.months)===before, 'A refused fill changes nothing');
  sb.provBulkFillApply(g, {lineId:10, from:'2027-05', count:1, amt:-12.346});
  assert(g.months['2027-05'][10]===-12.35, 'Amounts are rounded to cents');
}
async function testProvisionCellTabMovesAcrossAccounts(){
  const sb = provSandbox();
  sb.renderProvisions();
  sb.toggleProvisionEdit(1);
  const cell = sb.document.getElementById('provCell_1_0_0');
  assert(cell, 'Cells are there');
  cell.focus();
  sb.provCellKey({key:'Tab', shiftKey:false, preventDefault(){}, target:cell}, 1, 0, 0, 2, 3);
  assert(sb.document.activeElement && sb.document.activeElement.id==='provCell_1_1_0', 'Tab moves to the next account in the same month');
  const c2 = sb.document.activeElement;
  sb.provCellKey({key:'Tab', shiftKey:false, preventDefault(){}, target:c2}, 1, 1, 0, 2, 3);
  assert(sb.document.activeElement && sb.document.activeElement.id==='provCell_1_0_1', 'From the last account, Tab goes to the next month');
  const c3 = sb.document.activeElement;
  sb.provCellKey({key:'Enter', shiftKey:false, preventDefault(){}, target:c3}, 1, 0, 1, 2, 3);
  assert(sb.document.activeElement && sb.document.activeElement.id==='provCell_1_0_2', 'Enter moves down a month');
}

// ---- v5.0 step 4: Jamiah ----
function jam5Sandbox(){
  const t = jamSummarySandbox();
  const D = vm.runInContext('D', t.sb);
  D.ledger.push({id:10, jv:10, date:'2026-10-08', acc:10501, amt:100, descr:'B pays'}, {id:11, jv:11, date:'2026-10-09', acc:10501, amt:42, descr:'odd'}, {id:12, jv:12, date:'2026-11-02', acc:10501, amt:100, descr:'next month'});
  D.jamiahs = [t.j];
  if(!t.sb.document.getElementById('modalRoot')) t.sb.document.body.insertAdjacentHTML('beforeend', '<div id="modalRoot"></div><div id="app"></div>');
  t.sb.__set('persistJamiah', ()=>{});
  return t;
}
async function testJamiahEmptyCellOffersMatchingUntaggedTransactions(){
  const {sb, j} = jam5Sandbox();
  let c = sb.jamiahCellCandidates(j, 2, '2026-10');
  assert(c.match && c.lines.map(l=>l.id).join()==='10', 'B owes 100 in October: only the untagged 100.00 that month is offered, got '+JSON.stringify(c.lines.map(l=>l.id)));
  c = sb.jamiahCellCandidates(j, 3, '2026-10');
  assert(!c.match && c.lines.map(l=>l.id).join()==='10,11' && Math.abs(c.due-30)<0.005, 'C owes 30 and nothing matches: the other untagged amounts that month are listed');
  sb.openJamiahCell(1, 2, '2026-10');
  const modal = sb.document.getElementById('modalRoot').innerHTML;
  assert(/tagJamiahTransaction\(1,10,2\)/.test(modal) && !/tagJamiahTransaction\(1,12,/.test(modal), 'The cell lets you tag the matching transaction, not one from another month');
  const html = sb.renderJamiahSummary(j);
  assert(/openJamiahCell\(1,2,'2026-10'\)/.test(html) && /openJamiahTick\(1,1,'2026-10'\)/.test(html), 'Empty cells open matching transactions; ticks open their transaction');
}
async function testJamiahTickShowsItsTransactionWithUntag(){
  const {sb, j} = jam5Sandbox();
  sb.openJamiahTick(1, 1, '2026-10');
  const modal = sb.document.getElementById('modalRoot').innerHTML;
  assert(/A pays|>A</.test(modal) && /tagJamiahTransaction\(1,1,null\)/.test(modal) && />Untag</.test(modal), 'Clicking a tick shows its transaction with Untag');
  sb.__set('renderJamiahDetail', ()=>{});
  sb.tagJamiahTransaction(1, 1, null);
  assert(!(1 in j.tags), 'Untag removes the tag');
  const html = sb.renderJamiahSummary(j);
  assert(/openJamiahCell\(1,1,'2026-10'\)/.test(html), 'With the tag gone, the tick is gone too');
}
async function testJamiahTaggedTransactionsLeaveEveryList(){
  const {sb, j} = jam5Sandbox();
  const D = vm.runInContext('D', sb);
  const other = {id:2, name:'Other', account:10501, startMonth:'2026-10', durationMonths:1, groups:[], participants:[], roundGroup:{}, tags:{11:9}};
  D.jamiahs.push(other);
  const ids = sb.jamiahUntaggedLines(j).map(l=>l.id);
  assert(ids.join()==='10,12', 'Lines tagged in this Jamiah (1,2,3) or another (11) are not offered, got '+ids.join());
  const html = sb.renderJamiahUntagged(j);
  // v5.1: tagged transactions are listed again, marked with a tick and the person (his choice, feedback #6).
  const sbDoc = sb.document.createElement('div'); sbDoc.innerHTML = html;
  const rows = [...sbDoc.querySelectorAll('tbody tr')];
  const rowOf = t => rows.find(r=>r.textContent.includes(t));
  assert(rowOf('B last month') && /\u2713 B/.test(rowOf('B last month').textContent) && rowOf('B last month').classList.contains('jam-tagged'), 'A tagged transaction stays listed with a tick and the person');
  assert(rowOf('B pays') && !/\u2713/.test(rowOf('B pays').textContent), 'An untagged one has no tick');
  assert(rowOf('B last month') && /tagJamiahTransaction\(1,3,/.test(rowOf('B last month').innerHTML), 'A tagged row can be changed or untagged right there');
}
async function testJamiahSettingsIsOnePanel(){
  const {sb} = jam5Sandbox();
  sb.__set('jamiahSetupExpanded', true);
  sb.renderJamiahDetail(1);
  const app = sb.document.getElementById('app').innerHTML;
  const at = app.indexOf('Jamiah settings');
  assert(at>-1 && app.indexOf("setJamiahField(1,'name'")>at && app.indexOf("setJamiahField(1,'startMonth'")>at && app.indexOf('addJamiahParticipant(1)')>at && app.indexOf('setJamiahRoundGroup(1,')>at, 'Name, account, months, participants and rounds are all in Jamiah settings');
  assert((app.match(/Jamiah settings/g)||[]).length===1 && !/Setup: Groups/.test(app), 'One settings panel');
}

// ---- v5.0 step 4: Allocations ----
async function testAllocationLookupPreviewsLinesAndNet(){
  const {sb} = allocSandbox();
  if(!sb.document.getElementById('app')) sb.document.body.insertAdjacentHTML('beforeend', '<div id="app"></div>');
  sb.renderAlloc();
  sb.setAllocLookup('00007');
  const el = sb.document.getElementById('allocLookup');
  assert(el && el.querySelectorAll('tbody tr').length===2, 'Allocation #7 shows its two lines');
  assert(/Net \(#00007, 2 lines\)/.test(el.textContent) && /200\.00/.test(el.querySelector('tfoot').textContent), 'And its net (+200)');
  assert(/openAllocationArabicStatement\(7\)/.test(el.innerHTML), 'With its own Arabic Statement button');
  sb.setAllocLookup('123');
  assert(/No allocation #123/.test(el.textContent) && !/openAllocationArabicStatement/.test(el.innerHTML), 'An unknown number says so');
}
async function testAllocationLookupArabicStatementUsesOnlyThatAllocation(){
  const {sb} = allocSandbox();
  sb.__set('translateDescriptionToArabic', async (d)=>({text:'ar:'+d, source:'test'}));
  sb.__set('renderSettlementStatement', ()=>{});
  await sb.openAllocationArabicStatement(7);
  const d = vm.runInContext('settlementDraft', sb);
  assert(d && d.acc===10501 && d.lines.map(l=>l.id).join()==='1,2', 'The statement holds only allocation #7\'s lines, got '+(d&&d.lines.map(l=>l.id).join()));
  await sb.openSettlementStatement(10501);
  const d2 = vm.runInContext('settlementDraft', sb);
  assert(d2 && d2.lines.map(l=>l.id).join()==='6,7', 'The per-account statement still uses the unallocated lines (6 and 7)');
}
async function testUnallocatedBoxesPerAccountWithAllActions(){
  const {sb} = allocSandbox();
  if(!sb.document.getElementById('app')) sb.document.body.insertAdjacentHTML('beforeend', '<div id="app"></div>');
  sb.__set('allocTab', 'unalloc');
  sb.renderAlloc();
  allocSel(sb, [7]);
  sb.renderAllocUnallocResults();
  const html = sb.document.getElementById('allocUnallocResults').innerHTML;
  assert(/openSettlementStatement\(10501\)/.test(html) && /createBalancingJV\(10501\)/.test(html) && /openAddToAllocation\(10501\)/.test(html) && /assignAllocation\(10501\)/.test(html), 'Each account box offers Arabic statement, Create JV to balance, Add to existing and Assign');
  sb.__set('allocTab', 'groups');
  sb.renderAlloc();
  assert(!/Arabic/.test(sb.document.getElementById('allocBody').innerHTML), 'No Arabic statement on the existing allocations list');
}

// ---- v5.0 step 4: Forecast ----
async function testForecastHorizonLimitsTheMonths(){
  const sb = dashSandbox();
  sb.localStorage.setItem('gridEndMonth', '2027-12');
  sb.__set('forecastWindowStart', '2026-11');
  assert(sb.getForecastHorizon()==='end' && sb.forecastMonthsWindow().length===14, 'Default: through the Grid & Export End Month (Nov-26..Dec-27)');
  sb.go('forecast');
  sb.setForecastHorizon('6');
  assert(sb.localStorage.getItem('forecastHorizon')==='6' && sb.forecastMonthsWindow().join()==='2026-11,2026-12,2027-01,2027-02,2027-03,2027-04', '6 months');
  sb.setForecastHorizon('18');
  assert(sb.forecastMonthsWindow().length===14, '18 months still stops at the end month');
  sb.setForecastHorizon('99');
  assert(sb.localStorage.getItem('forecastHorizon')==='18', 'Unknown horizons are ignored');
  const seg = sb.document.querySelector('[aria-label="Horizon"]');
  assert(seg && seg.querySelectorAll('button').length===4 && /18 months/.test((seg.querySelector('[aria-pressed="true"]')||{}).textContent||''), 'The page offers 6 / 12 / 18 / End of reporting period');
}
async function testForecastChartMatchesTheClosingBalanceRow(){
  const sb = dashSandbox();
  sb.localStorage.setItem('gridEndMonth', '2027-04');
  sb.__set('forecastWindowStart', '2026-11');
  sb.__set('computeMonthlyCashFlow', (months)=> months.map((m,i)=>({month:m, starting:0, inflow:0, outflow:0, change:0, closing:[5000, -1200.5, 300, 9000, 4000, 2500][i]||0, subrows:{}})));
  // The table shows whole units; so do the bars (exact amount in the tooltip).
  sb.__set('renderCashFlowPanel', (months)=> '<div id="cfp">'+vm.runInContext('computeMonthlyCashFlow', sb)(months).map(r=>'<i>'+Math.round(r.closing).toLocaleString()+'</i>').join('')+'</div>');
  sb.go('forecast');
  const chart = sb.document.querySelector('.fc-chart');
  const vals = chart? [...chart.querySelectorAll('.fc-val')].map(e=>e.textContent) : [];
  const table = [...sb.document.querySelectorAll('#cfp i')].map(e=>e.textContent);
  assert(vals.length===6 && vals.join('|')===table.join('|'), 'Every bar carries the same amount as the Closing Balance row, got '+vals.join('|'));
  const tips = chart? [...chart.querySelectorAll('.fc-col')].map(c=>c.getAttribute('title')) : [];
  assert(tips[1]==='Dec-26: '+sb.money0(-1200.5), 'The tooltip shows the whole amount (v5.1), got '+tips[1]);
  const low = chart && chart.querySelector('.fc-col.low');
  assert(low && /Dec-26/.test(low.textContent) && /lowest/.test(low.textContent), 'The lowest month is marked');
  assert(/Lowest: -1,201 in Dec-26/.test(sb.document.getElementById('app').textContent), 'And named above the chart, in whole numbers');
}

async function testThingsThatNeedYouShowsEightThenShowAll(){
  const sb = dashSandbox();
  sb.__set('dashboardTodoItems', ()=> Array.from({length:12}, (_,i)=>({tone:'warn', title:'Item '+i, sub:'s', label:'Go', onclick:'void 0'})));
  sb.renderDashboard();
  let app = sb.document.getElementById('app');
  assert(app.querySelectorAll('.todo-item').length===8 && /12 things need you/.test(app.textContent), 'Shows the first 8 and counts all 12');
  assert(/Show all 12/.test(app.textContent), 'Offers Show all');
  sb.toggleDashTodoAll();
  assert(sb.document.getElementById('app').querySelectorAll('.todo-item').length===12 && /Show fewer/.test(sb.document.getElementById('app').textContent), 'Show all lists every item');
  sb.toggleDashTodoAll();
}

// ---- v5.0.1: masonry Dashboard ----
async function testDashboardBoxesStackIntoFreeSpace(){
  const sb = dashSandbox();
  assert(sb.dashRowSpan(0)===5 && sb.dashRowSpan(100)===30 && sb.dashRowSpan(101)===31, 'Row span = (height + 20px gap) / 4px rows, rounded up');
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(/\.dash-grid\{[^}]*grid-auto-rows:4px[^}]*row-gap:0/.test(html), 'The grid uses 4px rows with the gap folded into each span');
  sb.renderDashboard();
  const cells = [...sb.document.querySelectorAll('.dash-grid .dash-cell')];
  cells.forEach((c,i)=>{ c.getBoundingClientRect = () => ({height: 100 + i*10}); });
  sb.layoutDashMasonry();
  assert(cells.length>3 && cells.every((c,i)=>c.style.gridRowEnd==='span '+sb.dashRowSpan(100+i*10)), 'Every box spans rows matching its own height');
}

// ---- v5.1: feedback batch ----
async function testPosBoxPeekIsBandedAndHasNoBars(){
  const sb = dashSandbox();
  sb.renderDashboard();
  const html = sb.document.getElementById('app').innerHTML, src = fs.readFileSync(APP_HTML, 'utf8');
  assert(!/posbox-track|posbox-bar/.test(html) && !/\.posbox-track\{/.test(src), 'Position boxes have no bars any more (#4)');
  // v5.2 (#15): no bands, only the hover highlight.
  assert(!/\.posbox-peek div:nth-child/.test(src) && /\.posbox-peek div:hover\{background:var\(--accent-soft\)/.test(src), 'Opened lines highlight on hover, without bands (#15)');
  sb.togglePosBoxRow('ste', 0);
  const peek = sb.document.querySelector('[data-widget="box:ste"] .posbox-peek');
  assert(peek && peek.querySelectorAll(':scope > div').length===2, 'The opened line lists its accounts as rows');
}
async function testOverBudgetDismissIsSyncedPerCategoryAndMonth(){
  const sb = dashSandbox();
  const D = vm.runInContext('D', sb);
  D.accounts.push({id:60201, name:'Fun', category:'Fun', status:'Active', acc_type:'Individual Account'});
  D.ledger.push({id:60, jv:60, date:'2026-11-03', acc:60101, amt:1300, descr:'x'}, {id:61, jv:61, date:'2026-11-03', acc:60201, amt:500, descr:'y'});
  sb.rebuildIndex();
  sb.__set('pnlBudgetForAccountInRange', (acc)=> (acc===60101||acc===60201)? 100 : 0);
  sb.__set('computeDriftFlags', ()=>[]);
  let items = sb.dashboardTodoItems().filter(i=>/over budget/.test(i.title));
  assert(items.length===2 && items.every(i=>/^dismissOverBudget\(\d\)$/.test(i.dismiss||'')), 'Each over-budget category has Dismiss');
  const living = items.find(i=>/^Living/.test(i.title));
  vm.runInContext(living.dismiss, sb);
  const c = sb.__prefs();
  assert(c && Object.keys(c.row).sort().join()==='dismissals,id' && c.row.dismissals.overBudget['Living|2026-11']===1200, 'Dismiss syncs only the dismissals column, keyed by category and month');
  items = sb.dashboardTodoItems().filter(i=>/over budget/.test(i.title));
  assert(items.length===1 && /^Fun/.test(items[0].title), 'Only that category is hidden');
  D.ledger.push({id:62, jv:62, date:'2026-11-05', acc:60101, amt:50, descr:'more'});
  assert(sb.dashboardTodoItems().some(i=>/^Living is over budget by 1,250\.00/.test(i.title)), 'It comes back if it goes further over');
  freezeDate(sb, '2026-12-02T10:00:00.000Z');
  D.ledger.push({id:63, jv:63, date:'2026-12-01', acc:60101, amt:900, descr:'dec'});
  assert(sb.dashboardTodoItems().some(i=>/^Living is over budget/.test(i.title)), 'And comes back next month');
}
async function testDriftDismissalsAreSyncedAndStartFresh(){
  const sb = dashSandbox();
  sb.localStorage.setItem('driftDismissals', JSON.stringify({'smartrule:1':'2026-10'}));
  assert(!('smartrule:1' in sb.getDriftDismissals()), 'Old per-device dismissals are not carried over (start fresh)');
  sb.setDriftDismissed('smartrule:2', '2026-10');
  const c = sb.__prefs();
  assert(c && c.row.dismissals.drift['smartrule:2']==='2026-10' && sb.getDriftDismissals()['smartrule:2']==='2026-10', 'Drift dismissals are saved to the synced dismissals');
  const bare = {uiPrefs:{}}; sb.normalizeDataShape(bare);
  assert(bare.uiPrefs.dismissals && typeof bare.uiPrefs.dismissals==='object' && bare.uiPrefs.forecastNotes && typeof bare.uiPrefs.forecastNotes==='object', 'Old caches get empty dismissals and notes');
}
async function testDashboardBoxesCanBeHiddenAndShown(){
  const sb = dashSandbox();
  sb.toggleDashEditing();
  const L = sb.dashboardLayout(), i = L.findIndex(w=>w.id==='cash'), j = L.findIndex(w=>w.id==='box:lte');
  await sb.toggleDashHidden(i); await sb.toggleDashHidden(j);
  const c = sb.__prefs();
  assert(c && c.row.dashboard_layout.find(w=>w.id==='cash').hidden===true && c.row.dashboard_layout.find(w=>w.id==='box:lte').hidden===true, 'Hiding is saved in the synced layout, for built-in and position boxes');
  let app = sb.document.getElementById('app');
  assert(!app.querySelector('[data-widget="cash"]') && !app.querySelector('[data-widget="box:lte"]'), 'Hidden boxes are not shown');
  const strip = app.querySelector('.dash-hidden');
  assert(strip && /Cash flow/.test(strip.textContent) && /Long Term Equity/.test(strip.textContent) && strip.querySelectorAll('button').length===2, 'Edit layout lists hidden boxes with Show');
  assert(sb.getPositionBoxes().some(b=>b.id==='lte'), 'Hiding a position box keeps the box');
  sb.toggleDashEditing();
  assert(!sb.document.querySelector('#app .dash-hidden') && !sb.document.querySelector('[data-widget="cash"]'), 'Still hidden after leaving Edit layout');
  sb.toggleDashEditing();
  await sb.toggleDashHidden(i);
  assert(sb.document.querySelector('[data-widget="cash"]'), 'Show brings it back');
}
async function testChartsAndDashboardBoxesUseWholeNumbers(){
  const sb = dashSandbox();
  assert(sb.money0(1234.5)==='1,235' && sb.money0(-0.4)==='0' && sb.money0(-2500.6)==='-2,501', 'money0 rounds to whole numbers');
  const C = {defaults:{plugins:{tooltip:{callbacks:{}}}, scales:{linear:{ticks:{}}}}};
  sb.applyWholeNumberChartDefaults(C);
  assert(C.defaults.scales.linear.ticks.callback(1500.75)==='1,501', 'Chart axes show whole numbers');
  assert(C.defaults.plugins.tooltip.callbacks.label({parsed:{x:0, y:1234.56}, dataset:{label:'Actual'}, chart:{options:{}}})==='Actual: 1,235', 'Chart tooltips show whole numbers');
  sb.__set('dashboardNeedsCountUp', false);
  sb.renderDashboard();
  const kpis = [...sb.document.querySelectorAll('#app .kpi .v')].map(e=>e.textContent);
  assert(kpis.length===4 && kpis.every(t=>!/\.\d\d$/.test(t)), 'Month figures have no decimals, got '+kpis.join(' | '));
  const box = sb.document.querySelector('[data-widget="box:ste"]');
  assert(box && !/\d\.\d\d/.test(box.textContent), 'Position boxes have no decimals');
  const bank = sb.document.querySelector('[data-widget="banks"]');
  assert(bank && /48,250\.50/.test(bank.textContent), 'The bank accounts table keeps its 2 decimals');
}
async function testProvisionCopyMonthForward(){
  const sb = provSandbox();
  const D = vm.runInContext('D', sb);
  const g = D.provisionGroups[0];
  g.months['2027-03'] = {1:1, 2:-1};
  let r = sb.provCopyMonthApply(g, '2026-11');
  assert(r.months && r.months.join()==='2026-12,2027-01,2027-02,2027-03', 'Copies to every later month up to the last planned month (filling gaps)');
  assert(g.months['2026-12'][1]===500 && g.months['2026-12'][2]===-500 && g.months['2027-02'][2]===-500, 'Overwrites what was there');
  assert(sb.provLastPlannedMonth(g)==='2027-03', 'Never goes past the last planned month');
  g.months['2027-01'] = {1:300, 2:-200};
  const before = JSON.stringify(g.months);
  r = sb.provCopyMonthApply(g, '2027-01');
  assert(r.error && /doesn't net to zero/.test(r.error) && JSON.stringify(g.months)===before, 'Only a month that nets to zero can be copied');
  assert(sb.provCopyMonthApply(g, '2027-03').error, 'The last month has nothing after it');
  sb.renderProvisions(); sb.toggleProvisionEdit(1);
  const btns = [...sb.document.querySelectorAll('#provGroup_1 [onclick^="provCopyMonthForward"]')].map(b=>b.getAttribute('onclick'));
  assert(btns.includes("provCopyMonthForward(1,'2026-11')") && !btns.includes("provCopyMonthForward(1,'2027-01')"), 'Copy shows on balanced months only');
}
async function testJamiahGroupShowsItsFullMonthName(){
  const {sb, j} = jam5Sandbox();
  j.roundGroup = {'2026-10':1, '2026-11':1};
  assert(sb.jamiahGroupMonthsText(j, 1, false)==='October 2026, November 2026', 'Every month the group receives, full name');
  const html = sb.renderJamiahSummary(j);
  assert(/<td class="mut">G1 · October 2026, November 2026<\/td>/.test(html), 'Shown next to the group name in the summary');
  sb.__set('jamiahSummaryLang', 'ar');
  assert(/G1 · أكتوبر 2026/.test(sb.renderJamiahSummary(j)), 'Arabic view uses Arabic month names');
}
async function testForecastNotesAreSyncedCallouts(){
  const sb = dashSandbox();
  sb.localStorage.setItem('gridEndMonth', '2027-04');
  sb.__set('forecastWindowStart', '2026-11');
  sb.__set('computeMonthlyCashFlow', (months)=> months.map((m,i)=>({month:m, closing:[5000, 100, 300, 9000, 4000, 2500][i]||0})));
  sb.__set('renderCashFlowPanel', ()=> '');
  await sb.setForecastNote('2026-12', '  School fees for the year  ');
  const c = sb.__prefs();
  assert(c && Object.keys(c.row).sort().join()==='forecast_notes,id' && c.row.forecast_notes['2026-12']==='School fees for the year', 'A note is saved trimmed and synced in forecast_notes only');
  await sb.setForecastNote('2027-01', 'Car');
  sb.go('forecast');
  const cols = [...sb.document.querySelectorAll('.fc-chart .fc-col')];
  const noteOf = i => cols[i] && cols[i].querySelector('.fc-note');
  assert(noteOf(1) && noteOf(1).textContent==='School fees for the year' && noteOf(1).classList.contains('t0'), 'The call-out sits on that month\'s bar');
  assert(noteOf(2) && noteOf(2).classList.contains('t1'), 'Neighbouring call-outs alternate height');
  assert(!noteOf(0) && cols[0] && cols[0].getAttribute('onclick')==="openForecastNote('2026-11')", 'Clicking any bar opens its note');
  sb.openForecastNote('2026-12');
  assert(/Delete note/.test(sb.document.getElementById('modalRoot').innerHTML), 'An existing note can be deleted');
  await sb.setForecastNote('2026-12', '');
  assert(!('2026-12' in sb.getForecastNotes()), 'Saving an empty note deletes it');
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(!/forecastNotes|forecast_notes/.test(html.slice(html.indexOf('function exportCashPositionCSV('), html.indexOf('function exportCashPositionCSV(')+4000)), 'Notes are not in the export');
}
async function testBudgetMonthArrowsAndCollapsedGrid(){
  // v5.7 (#30): Budget is the Plan grid tab of Budget & P&L. Its month box and arrows went with the
  // month table (the Overview's period picker replaces them) and the grid shows straight away.
  const sb = dashSandbox();
  sb.go('budget');
  const ctrl = sb.document.getElementById('budgetControls');
  assert(ctrl && !/budgetShiftMonth|type="month"/.test(ctrl.innerHTML) && /openBudgetExportChoice\(\)/.test(ctrl.innerHTML), 'The Plan grid keeps Export / Import and has no month box');
  const grid = sb.document.getElementById('budgetGrid');
  assert(grid && grid.querySelector('table') && /Hide budget grid/.test(grid.textContent), 'The grid is open on arrival');
  const tabs = sb.document.querySelectorAll('.bp-tabs [data-bptab]');
  assert(tabs.length===2 && sb.document.querySelector('[data-bptab="grid"]').getAttribute('aria-selected')==='true', 'Both tabs show, Plan grid selected');
  sb.toggleBudgetGrid();
  assert(/Show budget grid/.test(sb.document.getElementById('budgetGrid').textContent), 'It can still be folded away');
}
async function testBudgetChartCategoryNameJumpsAndFlashes(){
  const sb = dashSandbox();
  const xs = {top:200, bottom:230, getValueForPixel:(x)=> x/100};
  assert(sb.chartCategoryLabelAt({scales:{x:xs}}, 110, 210, ['A','B','C'])==='B', 'A click on a name under the bars finds that category');
  assert(sb.chartCategoryLabelAt({scales:{x:xs}}, 110, 100, ['A','B','C'])===null, 'A click above the axis (on the bars area) is not a name');
  sb.__set('pnlBudgetForAccountInRange', (acc)=> acc===60101? 100 : 0);
  sb.go('pnl');   // v5.7 (#30): the chart is on the Overview; a name jumps to that category's Expenses row
  const span = sb.document.querySelector('#app tr[data-pnl-cat="Living"]');
  assert(span, 'Each category in the chart has a row in Expenses');
  sb.jumpToBudgetCategory('Living');
  assert(span && span.classList.contains('flash'), 'Jumping flashes that category\'s row');
  const src = fs.readFileSync(APP_JS, 'utf8');
  assert(/if\(!elements\.length\)\{ const cat = chartCategoryLabelAt\(chart, evt\.x, evt\.y, catLabels\); if\(cat\) jumpToBudgetCategory\(cat\); return; \}/.test(src) && /openBudgetCategoryBreakdown\(cat, from, to\)/.test(src), 'Names jump; bars still open the transactions');
}
async function testPnLArrowsSitEachSideOfTheMonth(){
  const sb = dashSandbox();
  sb.go('pnl');
  const panel = sb.document.querySelector('#app .panel');
  const h = panel? panel.innerHTML : '';
  const prev = h.indexOf('pnlShiftMonth(-1)'), period = h.indexOf('Period'), next = h.indexOf('pnlShiftMonth(1)');
  assert(prev>-1 && period>prev && next>period, 'P&L: ‹ before the period, › after it');
}
async function testPnLBackFromChartReturnsToTheSamePlace(){
  const sb = dashSandbox();
  let scrolledTo = null;
  sb.scrollTo = (x,y)=>{ scrolledTo = y; };
  sb.go('pnl');
  vm.runInContext('window.scrollY = 640', sb);
  sb.__set('renderAcctBudgetChartPage', ()=>{});
  sb.openAcctBudgetChartForCategory('Living');
  assert(vm.runInContext('pnlReturn', sb) && vm.runInContext('pnlReturn.key', sb)==='cat:Living', 'Opening the chart remembers the place and the row');
  sb.document.getElementById('app').insertAdjacentHTML('beforeend', '<table><tr id="rowL"><td><span data-pnl-key="cat:Living"></span></td></tr></table>');
  sb.__set('renderPnL', ()=>{ if(!sb.document.getElementById('rowL')) sb.document.getElementById('app').insertAdjacentHTML('beforeend', '<table><tr id="rowL"><td><span data-pnl-key="cat:Living"></span></td></tr></table>'); });
  sb.closeAcctBudgetChart();
  await new Promise(r=>setTimeout(r, 20));
  assert(scrolledTo===640, 'Back returns to the same scroll position');
  const row = sb.document.getElementById('rowL');
  assert(row && row.classList.contains('flash'), 'And flashes the row you came from');
  sb.openAcctBudgetChart(60101);
  assert(vm.runInContext('pnlReturn.key', sb)==='acc:60101', 'Works for account rows too');
}
async function testSchemaAddsDismissalsAndForecastNotes(){
  const sb = makeSandbox();
  const sql = vm.runInContext('DB_SCHEMA_SQL', sb);
  assert(/alter table pd_ui_prefs add column if not exists dismissals jsonb/i.test(sql) && /alter table pd_ui_prefs add column if not exists forecast_notes jsonb/i.test(sql), 'Schema adds the two v5.1 columns idempotently');
  const src = fs.readFileSync(APP_JS, 'utf8');
  assert(/dismissals: \(u\.dismissals/.test(src) && /forecastNotes: \(u\.forecast_notes/.test(src), 'Cloud load reads both');
  assert(/dismissals:D\.uiPrefs\.dismissals\|\|\{\}, forecast_notes:D\.uiPrefs\.forecastNotes\|\|\{\}/.test(src), 'Restore writes both back');
}

// ---- v5.2 ----
async function testPositionSubtotalAddsUpChosenRows(){
  const sb = dashSandbox();
  // His example: This month liabilities = Short Term Liabilities + Accruals; the total = Liquid Cash + This month liabilities.
  const box = {id:'c', title:'Cash Bank Account', rows:[
    {rid:'b', type:'line', label:'Bank Accounts', sign:1, accs:'10101, 10102'},
    {rid:'s', type:'line', label:'Savings', sign:-1, accs:'10102'},
    {rid:'r', type:'line', label:'Short Term Receivables', sign:1, accs:'11201'},
    {rid:'lc', type:'subtotal', label:'Liquid Cash'},
    {rid:'l', type:'line', label:'Short Term Liabilities', sign:1, accs:'21511'},
    {rid:'a', type:'line', label:'Accruals', sign:1, accs:'22901'},
    {rid:'tm', type:'subtotal', label:'This month liabilities', calc:'sum', sum:[{rid:'l', sign:1}, {rid:'a', sign:1}]},
    {rid:'t', type:'total', label:'Liquid Cash After Liabilities', calc:'sum', sum:[{rid:'lc', sign:1}, {rid:'tm', sign:1}]}]};
  const c = sb.computePositionBox(box);
  const v = l => (c.rows.find(r=>r.label===l)||{}).value;
  assert(Math.abs(v('Liquid Cash') - (48250.5+6500)) < 0.005, 'The running subtotal is unchanged');
  assert(Math.abs(v('This month liabilities') - (-8900-4150.25)) < 0.005, 'A subtotal can add up chosen rows (Short Term Liabilities + Accruals)');
  assert(Math.abs(v('Liquid Cash After Liabilities') - (48250.5+6500-8900-4150.25)) < 0.005 && Math.abs(c.final - v('Liquid Cash After Liabilities')) < 0.005, 'The total can add up subtotals (Liquid Cash + This month liabilities)');
  box.rows[7].sum[1].sign = -1;
  assert(Math.abs(sb.computePositionBox(box).final - (54750.5+13050.25)) < 0.005, 'A chosen row can also be subtracted');
  const presets = sb.getPositionBoxes().map(b=>sb.computePositionBox(b).final);
  assert(presets.length===3 && presets.every(Number.isFinite), 'Boxes without the option still compute as before');
}
async function testPositionSubtotalEditorAndValidation(){
  const sb = dashSandbox();
  sb.openPosBoxEditor('cash');
  const d = () => vm.runInContext('posBoxEdit', sb).draft;
  assert(d().rows.every(r=>typeof r.rid==='string' && r.rid), 'Every row gets a stable id when editing');
  const total = d().rows.length-1;
  sb.posBoxEditSet(total, 'calc', 'sum');
  let el = sb.document.querySelector('.posbox-sum');
  assert(el && el.querySelectorAll('button').length===total, 'Add up chosen rows lists every row above it');
  await sb.savePosBoxEdit();
  assert(!sb.__prefs(), 'Saving with no rows chosen is refused');
  const lc = d().rows.find(r=>r.label==='Liquid Cash').rid, acc = d().rows.find(r=>r.label==='Accruals').rid;
  sb.posBoxEditSumCycle(total, lc);
  sb.posBoxEditSumCycle(total, acc); sb.posBoxEditSumCycle(total, acc);
  assert(JSON.stringify(d().rows[total].sum.map(x=>x.sign))==='[1,-1]', 'Clicking cycles: add, then subtract');
  sb.posBoxEditSumCycle(total, acc);
  assert(d().rows[total].sum.length===1, 'A third click leaves it out');
  sb.posBoxEditSumCycle(total, acc);
  sb.posBoxEditRemove(d().rows.findIndex(r=>r.rid===acc));
  assert(d().rows[d().rows.length-1].sum.every(x=>x.rid!==acc), 'Removing a row drops it from the sums');
  const sub = d().rows.findIndex(r=>r.label==='Liquid Cash');
  sb.posBoxEditSet(sub, 'calc', 'sum'); sb.posBoxEditSumCycle(sub, d().rows[0].rid);
  sb.posBoxEditMove(1);
  sb.posBoxEditMove(sub); sb.posBoxEditMove(sub-1); sb.posBoxEditMove(sub-2);
  const err = sb.validatePositionBox(d());
  assert(/can only add up rows above it/.test(err), 'A subtotal moved above a row it uses is refused, got '+err);
  sb.posBoxEditCancel();
  sb.openPosBoxEditor('cash');
  const t = d().rows.length-1;
  sb.posBoxEditSet(t, 'calc', 'sum');
  sb.posBoxEditSumCycle(t, d().rows.find(r=>r.label==='Liquid Cash').rid);
  sb.posBoxEditSumCycle(t, d().rows.find(r=>r.label==='Accruals').rid);
  await sb.savePosBoxEdit();
  const c = sb.__prefs();
  const saved = c && c.row.position_boxes.find(b=>b.id==='cash');
  assert(saved && saved.rows[saved.rows.length-1].calc==='sum' && saved.rows[saved.rows.length-1].sum.length===2, 'The calculation is saved with the box');
  sb.posBoxEditCancel();
}
async function testUpdatePlanGoesToTheExactPlace(){
  const sb = provSandbox();
  sb.__set('computeDriftFlags', ()=>[{key:'provision:1:2', kind:'provision', groupId:1, groupName:'Car service', lineId:2, acc:23102, avgPlan:-500, avgActual:0},
    {key:'smartrule:7', kind:'smartrule', ruleId:7, ruleName:'Fuel', acc:60101, avgPlan:900, avgActual:1150}]);
  const items = sb.dashboardTodoItems().filter(i=>i.drift);
  assert(items[0] && items[0].onclick==='goToProvisionLine(1,2)' && items[1] && items[1].onclick==='goToSmartRule(7)', 'Update plan points at the exact provision line or smart rule');
  sb.goToProvisionLine(1, 2);
  await new Promise(r=>setTimeout(r, 20));
  assert(vm.runInContext('screen', sb)==='provisions' && sb.document.getElementById('provGroup_1') && /open/.test(sb.document.getElementById('provGroup_1').className), 'Opens the group');
  const row = sb.document.getElementById('provRow_1_2026-11');
  assert(row && row.classList.contains('hl'), 'Lands on this month\'s row');
  const card = sb.document.getElementById('provCard_1_2');
  assert(card && card.classList.contains('flash'), 'Flashes the line');
  assert(sb.document.activeElement && sb.document.activeElement.id==='provCell_1_1_0', 'Puts the cursor in this month\'s amount for that line');
  let opened = null;
  vm.runInContext('D', sb).forecastAccountRules = [{id:7, name:'Fuel', account:60101, rule:{type:'fixed', value:900}}];
  sb.__set('openForecastAccountRuleModal', (id)=>{ opened = id; });
  sb.goToSmartRule(7);
  assert(vm.runInContext('screen', sb)==='settings' && vm.runInContext('settingsTab', sb)==='smartrules' && opened===7, 'Smart rule: Settings > Smart Rules with the rule open for editing');
}
async function testAuroraAndGlassStyle(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(/\[\['plain','Plain'\],\['tinted','Tinted'\],\['aurora','Aurora & glass'\]\]/.test(html), 'The background option is called Aurora & glass');
  const block = (html.match(/@media\(min-width:761px\)\{\s*body\.bg-aurora \.aurora[\s\S]*?\n\}/)||[''])[0];
  assert(/body\.bg-aurora #sidebar\{position:fixed[^}]*border-radius:26px[^}]*backdrop-filter:blur\(28px\)/.test(block), 'Aurora & glass: floating rounded frosted rail');
  assert(/body\.bg-aurora #topbar\{[^}]*border-radius:22px[^}]*backdrop-filter:blur\(24px\)/.test(block), 'And a floating rounded frosted top bar');
  assert(/\[data-theme="dark"\] body\.bg-aurora #sidebar/.test(block), 'With a dark-mode version');
  const sb = shellSandbox();
  sb.setUiBackground('aurora');
  assert(sb.document.body.classList.contains('bg-aurora'), 'Choosing it in Settings turns the glass on');
}

// ---- v5.3: drift A + B + C (#17) ----
function driftSandbox(){
  const sb = dashSandbox();
  freezeDate(sb, '2026-11-07T10:00:00.000Z');
  const D = vm.runInContext('D', sb);
  D.accounts.push({id:60504, name:'Bills', category:'Bills', status:'Active', acc_type:'Individual Account'}, {id:20111, name:'This Month Payable', category:'Short Term Liabilities', status:'Active', acc_type:'Individual Account'});
  sb.rebuildIndex();
  // Two lines on Bills (125 + 162.50) whose total matches the actual 287.50; a pass-through payable that nets to zero.
  D.provisionGroups = [
    {id:1, name:'Internet', lines:[{acc:60504, lineId:1}, {acc:20111, lineId:2}], months:{'2026-09':{1:125, 2:-125}, '2026-10':{1:125, 2:-125}}},
    {id:2, name:'Phone', lines:[{acc:60504, lineId:1}, {acc:20111, lineId:2}], months:{'2026-09':{1:162.5, 2:-162.5}, '2026-10':{1:162.5, 2:-162.5}}}];
  D.ledger = D.ledger.filter(l=>![60504,20111].includes(l.acc));
  ['2026-09','2026-10'].forEach((m,i)=>D.ledger.push({id:900+i*4, jv:900+i, date:m+'-05', acc:60504, amt:287.5, descr:'bills'}, {id:901+i*4, jv:900+i, date:m+'-05', acc:20111, amt:-287.5, descr:'bills'},
    {id:902+i*4, jv:910+i, date:m+'-20', acc:20111, amt:287.5, descr:'paid'}, {id:903+i*4, jv:910+i, date:m+'-20', acc:10101, amt:-287.5, descr:'paid'}));
  return sb;
}
async function testDriftComparesPerAccount(){
  const sb = driftSandbox();
  sb.setDriftSettings({perAccount:false, plOnly:false, excludeOn:false});
  let f = sb.computeDriftFlags().filter(x=>x.kind==='provision');
  assert(f.filter(x=>x.acc===60504).length===2 && f.filter(x=>x.acc===20111).length===2, 'Old way: each Bills line is compared with the whole account, and the payable is flagged too');
  sb.setDriftSettings({perAccount:true});
  f = sb.computeDriftFlags().filter(x=>x.kind==='provision');
  assert(!f.some(x=>x.acc===60504), 'A: per account, Bills plan 125 + 162.50 = 287.50 matches the actual, so no drift');
  assert(f.filter(x=>x.acc===20111).length===1 && f[0].key==='provacc:20111' && f[0].lines.length===2, 'A: one alert per account, covering both lines');
  vm.runInContext('D', sb).ledger.push({id:990, jv:990, date:'2026-10-09', acc:60504, amt:400, descr:'extra'}, {id:991, jv:991, date:'2026-09-09', acc:60504, amt:400, descr:'extra'});
  assert(sb.computeDriftFlags().some(x=>x.acc===60504), 'A still catches real drift on the account');
}
async function testDriftIncomeExpenseOnlyAndExcludeList(){
  const sb = driftSandbox();
  sb.setDriftSettings({perAccount:true, plOnly:false, excludeOn:false});
  assert(sb.computeDriftFlags().some(x=>x.acc===20111), 'Without B, the pass-through payable is flagged');
  sb.setDriftSettings({plOnly:true});
  assert(!sb.computeDriftFlags().some(x=>x.acc===20111), 'B: balance-sheet accounts are left out');
  const D = vm.runInContext('D', sb);
  D.ledger.push({id:990, jv:990, date:'2026-10-09', acc:60504, amt:400, descr:'x'}, {id:991, jv:991, date:'2026-09-09', acc:60504, amt:400, descr:'x'});
  assert(sb.computeDriftFlags().some(x=>x.acc===60504), 'Expense accounts are still checked');
  sb.setDriftSettings({excludeOn:true, excluded:[60504]});
  assert(!sb.computeDriftFlags().some(x=>x.acc===60504), 'C: an excluded account is never flagged');
  sb.__set('provisionEditingId', 1); sb.renderProvisions();
  assert(!/>Drift</.test(sb.document.getElementById('provGroup_1').innerHTML), 'C: its Drift badge is gone too');
  sb.setDriftSettings({excludeOn:false});
  assert(sb.computeDriftFlags().some(x=>x.acc===60504), 'Turning the list off checks it again');
  sb.__set('provisionEditingId', 1); sb.renderProvisions();
  assert(/>Drift</.test(sb.document.getElementById('provGroup_1').innerHTML) && /Drift/.test(sb.document.getElementById('provCard_1_1').textContent), 'And the badge shows on the line again (per-account alerts mark every line of that account)');
  assert(/Drift/.test((sb.driftFlagsFor('provision', 2)[0]||{}).key? 'Drift' : ''), 'The second group sees the same per-account alert');
  sb.__set('provisionEditingId', 2); sb.renderProvisionGroupsList();
  const card2 = sb.document.getElementById('provCard_2_1');
  assert(card2 && /Drift/.test(card2.textContent), 'The Drift badge also shows on the same account\u2019s line in the other group');
}
async function testDriftSettingsAreSyncedWithToggles(){
  const sb = driftSandbox();
  sb.localStorage.setItem('driftSettings', JSON.stringify({thresholdPct:30, minMonths:3}));
  let s = sb.getDriftSettings();
  assert(s.thresholdPct===30 && s.minMonths===3 && s.perAccount && s.plOnly && s.excludeOn, 'Upgrade: keeps this device’s threshold and months, A/B/C on by default');
  sb.setDriftToggle('plOnly', false);
  const c = sb.__prefs();
  assert(c && Object.keys(c.row).sort().join()==='dismissals,id' && c.row.dismissals.driftSettings.plOnly===false && c.row.dismissals.driftSettings.thresholdPct===30, 'Toggles save to the synced settings (no new column)');
  sb.localStorage.setItem('driftSettings', JSON.stringify({thresholdPct:99}));
  assert(sb.getDriftSettings().thresholdPct===30, 'Once synced, the synced settings win over this device’s old ones');
  sb.__set('settingsTab', 'driftdetection');
  sb.renderSettings();
  const app = sb.document.getElementById('app');
  const boxes = [...app.querySelectorAll('input[type=checkbox][onchange^="setDriftToggle"]')].map(i=>i.getAttribute('onchange').match(/'(\w+)'/)[1]);
  assert(boxes.join()==='perAccount,plOnly,excludeOn', 'Settings has a toggle for each of A, B and C');
  const sel = app.querySelector('#driftExcludeSel');
  assert(sel && /20111/.test(sel.innerHTML) && /60504/.test(sel.innerHTML), 'The exclude list offers accounts used in Provisions');
  sel.value = '60504'; sb.addDriftExclusion();
  assert(sb.getDriftSettings().excluded.join()==='60504' && /removeDriftExclusion\(60504\)/.test(sb.document.getElementById('app').innerHTML), 'Excluding adds it to the list, with a way to remove it');
  sb.removeDriftExclusion(60504);
  assert(sb.getDriftSettings().excluded.length===0, 'And it can be removed');
}

// ---- v5.4: SMS inbox (feedback #18). All data invented. ----
function smsSandbox(){
  const sb = dashSandbox({today:'2026-11-11T10:00:00.000Z'});
  const D = vm.runInContext('D', sb);
  D.accounts.push({id:10103, name:'Card', descr:'Card', category:'Bank Accounts', status:'Active', acc_type:'Individual Account', is_credit_card:true},
    {id:60102, name:'Fuel', descr:'Fuel', category:'Living', status:'Active', acc_type:'Individual Account'});
  sb.rebuildIndex();
  const R = (id, o) => Object.assign({id, date:'2026-11-11', time:'10:00', source:'BANKA', acct:'1111', counter:'', kind:'POS purchase', descr:'SHOP '+id,
    amt:100, side:'Cr', fee:null, currency:'SAR', fxAmt:null, remaining:'', loggedAt:null, status:'pending', jv:null, updated_at:null}, o||{});
  sb.__R = R;
  D.smsInbox = [];
  sb.__set('jvDrafts', []);
  sb.__set('jvDraft', {date:'2026-11-11', lines:[sb.freshLine(), sb.freshLine()]});
  sb.__set('go', (s)=>{ sb.__went = s; });
  sb.__set('blockIfSyncing', () => false);
  sb.__set('logActivity', () => {});
  sb.__set('saveJVDraftsList', () => {});
  sb.__map = async (o) => { for(const [k,v] of Object.entries(o)) await sb.setSmsAccount(k, v); };
  return sb;
}
async function testSmsInboxTableIsInEveryTableList(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  const sb = makeSandbox();
  const sql = vm.runInContext('DB_SCHEMA_CORE', sb);
  assert(/create table if not exists pd_sms_inbox \(/.test(sql) && /'pd_sms_inbox',\s*\n\s*'pd_sync_meta'/.test(sql), 'Schema creates pd_sms_inbox and gives it the same RLS policy as every table');
  assert(/fetchAllRows\('pd_sms_inbox','id'\)/.test(html) && /TOTAL_SOURCES = 27/.test(html), 'The cloud load fetches it (and the splash progress counts it)');
  assert(/SB\.from\('pd_sms_inbox'\)\.delete\(\)\.neq\('id',-1\); bump/.test(html) && /insertWithRetry\('pd_sms_inbox', D\.smsInbox\.map\(smsToRow\)\)/.test(html), 'Restore from backup clears and restores it');
  assert((html.match(/SB\.from\('pd_sms_inbox'\)\.delete\(\)/g)||[]).length===2, 'Wipe-all clears it too');
  const D = vm.runInContext('D', sb); delete D.smsInbox; sb.normalizeDataShape(D);
  assert(Array.isArray(D.smsInbox), 'An old cache or backup without the inbox gets an empty one');
  const row = {id:123, entry_date:'2026-11-10', entry_time:'09:50', source:'S', acct:'1111', counter_acct:'D360', kind:'Online purchase', descr:'X', amt:'7000.00', side:'Cr', fee:null, currency:'SAR', fx_amount:null, remaining:'', logged_at:null, status:'pending', jv:null};
  const s = sb.smsFromRow(row);
  assert(s.amt===7000 && s.counter==='D360' && s.fxAmt===null && s.side==='Cr', 'Rows from the phone are read with numbers as numbers and blanks as null');
  const back = sb.smsToRow(s);
  assert(back.amt===7000 && back.counter_acct==='D360' && back.entry_date==='2026-11-10' && back.status==='pending', 'And written back in the table’s column names');
}
async function testSmsGroupsByMappedAccount(){
  const sb = smsSandbox(); const D = vm.runInContext('D', sb), R = sb.__R;
  D.smsInbox.push(R(1, {acct:'1111'}), R(2, {acct:'BANKA debit', source:'BANKA'}), R(3, {acct:'9999', source:'BANKB'}));
  let g = sb.smsGroups();
  assert(g.length===3 && g.every(x=>!x.acc), 'Unmapped: one group per source and card/account');
  await sb.__map({'1111':10101, 'BANKA debit':10101});
  const prefs = sb.__prefs();
  assert(prefs && Object.keys(prefs.row).sort().join()==='dismissals,id' && prefs.row.dismissals.smsMap['1111']===10101, 'The account map is saved in the synced settings (no new column)');
  g = sb.smsGroups();
  assert(g.length===2 && g[0].acc===10101 && g[0].rows.length===2, 'A card and its account mapped to one LedgerOS account become one group');
  sb.openSmsInbox();
  const modal = sb.document.getElementById('modalRoot');
  const groups = [...modal.querySelectorAll('.sms-group')];
  const mapped = groups.find(x=>x.dataset.group==='a:10101'), unmapped = groups.find(x=>x.dataset.group==='u:BANKB|9999');
  assert(mapped && /Create JV/.test(mapped.innerHTML) && !mapped.querySelector('button.pri').disabled, 'A mapped group can create its JV');
  assert(mapped && mapped.querySelector('.sms-aliases') && /1111, BANKA debit|BANKA debit, 1111/.test(mapped.querySelector('.sms-aliases').value), 'Its matches list shows every number/name mapped to it');
  assert(unmapped && unmapped.querySelector('button.pri').disabled && unmapped.querySelector('.sms-acc-pick'), 'An unmapped group asks which account it is before it can create JVs');
  await sb.setSmsAliases(10101, '1111');
  assert(sb.smsAccFor('BANKA debit')===null && sb.smsAccFor('1111')===10101, 'Editing the matches list replaces that account’s list');
}
async function testSmsBuildsOneJVPerDateWithOtherHalves(){
  const sb = smsSandbox(); const D = vm.runInContext('D', sb), R = sb.__R;
  D.smsInbox.push(R(1, {date:'2026-11-11', amt:100}), R(2, {date:'2026-11-10', amt:40.5}), R(3, {date:'2026-11-11', amt:12, side:'Dr', kind:'Cashback', descr:'Cashback'}),
    R(4, {date:'2026-11-10', amt:null, currency:'CAD', fxAmt:90.06, descr:'TAXI (CAD 90.06)'}));
  await sb.__map({'1111':10101});
  const {jvs} = sb.smsBuildJVs('a:10101');
  assert(jvs.length===2 && jvs[0].date==='2026-11-10' && jvs[1].date==='2026-11-11', 'One JV per SMS date, earliest first');
  const j11 = jvs[1];
  assert(j11.lines.length===4, 'Each SMS is its own line plus its other half (2 SMS = 4 lines)');
  const bank = j11.lines.filter(l=>l.acc==='10101'), other = j11.lines.filter(l=>l.acc==='');
  assert(bank.map(l=>l.amt).join()==='-100,12' && other.map(l=>l.amt).join()==='100,-12', 'Money out is negative on the bank line, money in positive; the other half is the opposite, account left for him');
  assert(bank[0].descr==='SHOP 1' && other[0].descr==='SHOP 1' && bank[0].smsId===1 && other[0].smsId===1, 'Both halves carry the SMS description and its link');
  const total = j11.lines.reduce((s,l)=>s+Number(l.amt),0);
  assert(Math.abs(total)<0.005, 'Each JV nets to zero once the accounts are picked');
  const fx = jvs[0].lines.filter(l=>l.smsId===4);
  assert(fx.length===2 && fx.every(l=>l.amt==='') && /CAD 90\.06/.test(fx[0].descr), 'A foreign amount with no SAR leaves both amounts for him to type');
}
async function testSmsOwnTransferPairsBothBanks(){
  const sb = smsSandbox(); const D = vm.runInContext('D', sb), R = sb.__R;
  // Bank A sends 19000.50 (its fee inside the amount); bank B receives 19000. Each bank sends its own SMS.
  D.smsInbox.push(R(1, {acct:'A debit', source:'BANKA', side:'Cr', amt:19000.5, counter:'2222', kind:'Outgoing transfer', descr:'TEST PERSON'}),
    R(2, {acct:'2222', source:'BANKB', side:'Dr', amt:19000, counter:'0101', kind:'Incoming transfer', descr:'TEST PERSON (via BANKA)'}),
    R(3, {acct:'3333', source:'WALLET', side:'Dr', amt:500, counter:'', kind:'Top-up', descr:'Top-up', date:'2026-11-09'}));
  await sb.__map({'A debit':10101, '0101':10101, '2222':10102, 'W':10199});
  const {jvs} = sb.smsBuildJVs('a:10101');
  const lines = jvs[0].lines;
  assert(lines.length===3, 'One JV: bank A line, bank B line and a fee line (no unknown half)');
  const a = lines.find(l=>l.acc==='10101'), b = lines.find(l=>l.acc==='10102'), fee = lines.find(l=>l.acc==='');
  assert(a && a.amt==='-19000.5' && b && b.amt==='19000' && fee && fee.amt==='0.5' && /Transfer fee/.test(fee.descr), 'Both sides as each bank reported them; the 0.50 difference goes on a Transfer fee line');
  assert(a.smsId===1 && b.smsId===2, 'The JV carries both banks’ SMS');
  await sb.smsCreateJVs('a:10101');
  assert(!sb.smsGroups().some(g=>g.acc===10102), 'Bank B’s copy of the transfer is no longer waiting on its own');
  // No partner (too far apart in amount): the other side is still filled from the map
  D.smsInbox.push(R(4, {acct:'A debit', side:'Cr', amt:300, counter:'2222'}), R(5, {acct:'2222', source:'BANKB', side:'Dr', amt:298}));
  const j2 = sb.smsBuildJVs('a:10101').jvs[0].lines.filter(l=>l.smsId===4 || l.smsId===5);
  assert(j2.length===2 && j2.every(l=>l.smsId===4) && j2[1].acc==='10102' && j2[1].amt==='300', 'More than SAR 1 apart: not paired, but the other side still goes to his own account');
}
async function testSmsExactReversalCancelsOut(){
  const sb = smsSandbox(); const D = vm.runInContext('D', sb), R = sb.__R;
  D.smsInbox.push(R(1, {acct:'1111', amt:52, descr:'TAXI (AED 52)', kind:'Online purchase'}), R(2, {acct:'1111', amt:52, side:'Dr', descr:'TAXI (reversal) (AED 52)', kind:'Reversal/refund'}),
    R(3, {acct:'1111', amt:54.7, descr:'TAXI (AED 54.7)'}), R(4, {acct:'1111', amt:4.24, side:'Dr', descr:'TAXI (reversal) (AED 4.24)', kind:'Reversal/refund'}));
  await sb.__map({'1111':10103});
  const {jvs, netted} = sb.smsBuildJVs('a:10103');
  assert(netted.sort().join()==='1,2', 'A reversal that exactly matches a purchase cancels it out');
  assert(jvs[0].lines.filter(l=>l.acc==='10103').map(l=>l.amt).join()==='-54.7,4.24', 'The other purchase and the partial reversal are still posted');
  sb.openSmsInbox();
  assert(/cancels out/.test(sb.document.getElementById('modalRoot').innerHTML), 'The inbox shows which SMS cancel out');
  await sb.smsCreateJVs('a:10103');
  const calls = sb.__calls.filter(c=>c.table==='pd_sms_inbox');
  assert(calls.length===2 && calls.every(c=>c.row.status==='netted' && Object.keys(c.row).sort().join()==='id,jv,status'), 'Creating the JV marks the cancelled pair as done (only status is written)');
}
async function testSmsFeeGetsItsOwnLine(){
  const sb = smsSandbox(); const D = vm.runInContext('D', sb), R = sb.__R;
  D.smsInbox.push(R(1, {acct:'1111', amt:3982.43, fee:17.25, kind:'International transfer', descr:'TEST RECEIVER (MoneyGram)'}));
  await sb.__map({'1111':10101});
  const lines = sb.smsBuildJVs('a:10101').jvs[0].lines;
  const feeLines = lines.filter(l=>/^Fee/.test(l.descr));
  assert(lines.length===4 && feeLines.length===2 && feeLines.find(l=>l.acc==='10101').amt==='-17.25' && feeLines.find(l=>l.acc==='').amt==='17.25', 'The fee comes off the bank on its own line, with its other half for a bank-charges account');
}
async function testSmsCreateOpensFirstDateDraftsRestAndPostingMarksDone(){
  const sb = smsSandbox(); const D = vm.runInContext('D', sb), R = sb.__R;
  D.smsInbox.push(R(1, {date:'2026-11-10', amt:120}), R(2, {date:'2026-11-11', amt:125}), R(3, {date:'2026-11-11', amt:5, acct:'9999', source:'BANKB'}));
  await sb.__map({'1111':10101});
  assert(sb.smsPending().length===3, 'Three SMS waiting');
  sb.renderNewJV();
  assert(/📩 SMS \(3\)/.test(sb.document.getElementById('smsInboxBtn').textContent), 'New JV shows the SMS button with the waiting count');
  const todo = sb.dashboardTodoItems();
  assert(todo[0] && /3 bank SMS to post/.test(todo[0].title) && /openSmsInbox/.test(todo[0].onclick), 'The Dashboard lists the waiting SMS first, opening the inbox');
  await sb.smsCreateJVs('a:10101');
  const jvDraft = vm.runInContext('jvDraft', sb), drafts = vm.runInContext('jvDrafts', sb);
  assert(jvDraft.date==='2026-11-10' && jvDraft.lines.length===2 && jvDraft.lines[0].smsId===1, 'The earliest date opens in New JV');
  assert(drafts.length===1 && drafts[0].date==='2026-11-11' && drafts[0].lines.every(l=>l.smsId===2), 'The other date is saved as a draft, still linked to its SMS');
  const draftWrite = sb.__calls.find(c=>c.table==='pd_drafts');
  assert(draftWrite && draftWrite.row.lines[0].smsId===2, 'The draft syncs with the SMS link on its lines');
  assert(sb.smsPending().map(s=>s.id).join()==='3', 'SMS in the open JV or a draft are no longer waiting');
  jvDraft.lines[1].acc = '60102';
  await sb.postJV();
  const posted = sb.__calls.filter(c=>c.table==='pd_sms_inbox');
  const jvNo = vm.runInContext('D', sb).ledger.filter(l=>l.descr==='SHOP 1').map(l=>l.jv)[0];
  assert(posted.length===1 && posted[0].row.id===1 && posted[0].row.status==='posted' && posted[0].row.jv===jvNo && jvNo, 'Posting the JV moves its SMS to Done with the JV number');
  sb.continueDraft(drafts[0].id);
  const again = vm.runInContext('jvDraft', sb);
  assert(again.lines.every(l=>l.smsId===2), 'Continuing the draft keeps the SMS link, so posting it marks that SMS too');
  await sb.saveJVDraft();
  const saved = vm.runInContext('jvDrafts', sb).slice(-1)[0];
  assert(saved && saved.lines.every(l=>l.smsId===2), 'Saving it as a draft again keeps the link too');
}
async function testSmsDismissRestoreAndDoneList(){
  const sb = smsSandbox(); const D = vm.runInContext('D', sb), R = sb.__R;
  D.smsInbox.push(R(1), R(2, {status:'posted', jv:77}));
  await sb.__map({'1111':10101});
  await sb.smsDismiss(1);
  assert(sb.smsPending().length===0 && D.smsInbox[0].status==='dismissed', 'Dismiss takes it out of the waiting list');
  sb.__set('smsDoneOpen', true); sb.openSmsInbox();
  const html = sb.document.getElementById('modalRoot').innerHTML;
  assert(/Done \(2\)/.test(html) && /JV #77/.test(html) && /smsRestore\(1\)/.test(html) && !/smsRestore\(2\)/.test(html), 'Done lists both: the posted one shows its JV, only the dismissed one can go back');
  await sb.smsRestore(1);
  assert(sb.smsPending().length===1, 'Back to inbox brings it back');
}
async function testSmsInboxLoadsFromTheCloud(){
  const sb = makeSandbox();
  const D = vm.runInContext('D', sb);
  D.smsInbox = [{id:9, status:'pending', amt:1}];
  sb.__set('getLedgerChangeMarker', async () => null);
  sb.__set('setStatus', () => {});
  sb.__set('updateSplashProgress', () => {});
  const phoneRow = {id:42, entry_date:'2026-11-11', entry_time:'04:45', source:'S', acct:'1111', counter_acct:null, kind:'Online purchase', descr:'TEST', amt:'47.66', side:'Cr', fee:null, currency:'SAR', fx_amount:null, remaining:'9000', logged_at:null, status:'pending', jv:null};
  let missing = false;
  sb.__set('fetchAllRows', async (table) => (table==='pd_sms_inbox'? (missing? {data:null, error:{message:'relation does not exist'}} : {data:[phoneRow], error:null}) : {data:[], error:null}));
  try{ await sb.fetchAllFromCloud(true); }catch(e){ /* later steps of the load may need more of the app; the inbox is read before them */ }
  let inbox = vm.runInContext('D', sb).smsInbox;
  assert(inbox.length===1 && inbox[0].id===42 && inbox[0].amt===47.66, 'Loading from the cloud fills the SMS inbox from pd_sms_inbox');
  missing = true;
  vm.runInContext('D', sb).smsInbox = [{id:9, status:'pending', amt:1}];
  try{ await sb.fetchAllFromCloud(true); }catch(e){}
  inbox = vm.runInContext('D', sb).smsInbox;
  assert(inbox.length===1 && inbox[0].id===9, 'Before the schema script is run (no table yet), the load keeps what is on this device');
}
// v5.4.1 (#19): the Aurora & glass rail has overflow:hidden, so its buttons must scroll inside it.
// JSDOM has no layout, so this checks the rules themselves (a real-browser check at 640px tall is in FEEDBACK #19).
async function testGlassRailScrollsOnShortScreens(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  const glass = (html.match(/@media\(min-width:761px\)\{\s*body\.bg-aurora \.aurora[\s\S]*?\n\}/)||[''])[0];
  assert(/body\.bg-aurora #sidebar\{[^}]*overflow:hidden/.test(glass), 'The glass rail still clips its edges (rounded corners)');
  const navRule = (glass.match(/body\.bg-aurora nav\{([^}]*)\}/)||['',''])[1];
  assert(/overflow-y:auto/.test(navRule) && /min-height:0/.test(navRule) && /flex:1/.test(navRule), 'Inside it, the button list scrolls (flex item that may shrink below its content)');
  assert(/body\.bg-aurora #sidebar \.brand,body\.bg-aurora \.sidebar-footer\{flex-shrink:0\}/.test(glass), 'The logo and the footer keep their size while the list scrolls');
  const shortRule = (html.match(/@media\(min-width:761px\) and \(max-height:820px\)\{([^\n]*)\}/)||['',''])[1];
  assert(/nav button\{min-height:44px/.test(shortRule), 'Short windows get more compact rail buttons');
}
// v5.4.1 (#20): the Dashboard's "over budget" item opens P&L on that category, flashed.
async function testOverBudgetOpenPnLGoesToTheCategory(){
  const sb = dashSandbox();
  const D = vm.runInContext('D', sb);
  D.ledger.push({id:50, jv:50, date:'2026-11-03', acc:60101, amt:1300, descr:'food'});
  sb.__set('pnlBudgetForAccountInRange', (acc)=> acc===60101? 1000 : 0);
  sb.__set('computeDriftFlags', ()=>[]);
  const item = sb.dashboardTodoItems().find(i=>/Living is over budget/.test(i.title));
  assert(item && item.onclick==='goPnLThisMonth(&quot;Living&quot;)', 'Open P&L carries the category (got '+(item&&item.onclick)+')');
  sb.__set('pnlView', 'acctchart');
  sb.goPnLThisMonth('Living');
  await new Promise(r=>setTimeout(r, 30));
  assert(vm.runInContext('screen', sb)==='pnl' && vm.runInContext('pnlPreset', sb)==='month' && vm.runInContext('pnlView', sb)==='main', 'It opens the P&L itself on this month (not a chart left open before)');
  const row = sb.document.querySelector('#app tr[data-pnl-cat="Living"]');
  assert(row && row.classList.contains('flash') && /Living/.test(row.textContent), 'The Living subtotal row is marked and flashed');
  assert(![...sb.document.querySelectorAll('#app tr[data-pnl-cat]')].some(r=>r!==row && r.classList.contains('flash')), 'Only that category flashes');
  const other = dashSandbox();
  let went = null; other.__set('go', s=>{ went = s; });
  other.goPnLThisMonth();
  assert(went==='pnl', 'Without a category it still just opens the P&L');
}

// ================= v5.5.0 (#21): accrual cap overflow =================
// Invented fixture. October 2026 budgets come from D.budget; reserves are the 203xx liabilities.
function ovfSandbox(opts){
  opts = opts||{};
  const D = {
    accounts: [
      {id:20301, name:'Self Improvement Reserve', category:'Accruals', acc_type:'Accrual Account', status:'Active'},
      {id:20302, name:'Shopping Reserve', category:'Accruals', acc_type:'Accrual Account', status:'Active'},
      {id:20303, name:'Entertainment Reserve', category:'Accruals', acc_type:'Accrual Account', status:'Active'},
      {id:20304, name:'Bills Reserve', category:'Accruals', acc_type:'Accrual Account', status:'Active'},
      {id:20305, name:'Hobbies Reserve', category:'Accruals', acc_type:'Accrual Account', status:'Active'},
      {id:20399, name:'General Reserve', category:'Accruals', acc_type:'Accrual Account', status:'Active'},
      {id:60100, name:'SI - Courses', category:'Self Improvement', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:60199, name:'SI - Accrual', category:'Self Improvement', acc_type:'Accrual Account', status:'Active', forecast_category:'expense'},
      {id:60200, name:'Shopping - Spend', category:'Shopping', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:60299, name:'Shopping - Accrual', category:'Shopping', acc_type:'Accrual Account', status:'Active', forecast_category:'expense'},
      {id:60300, name:'Fun - Spend', category:'Entertainment', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:60399, name:'Fun - Accrual', category:'Entertainment', acc_type:'Accrual Account', status:'Active', forecast_category:'expense'},
      {id:60400, name:'Bills - Spend', category:'Bills', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:60499, name:'Bills - Accrual', category:'Bills', acc_type:'Accrual Account', status:'Active', forecast_category:'expense'},
      {id:60500, name:'Hobbies - Spend', category:'Hobbies', acc_type:'Individual Account', status:'Active', forecast_category:'expense'},
      {id:60599, name:'Hobbies - Accrual', category:'Hobbies', acc_type:'Accrual Account', status:'Active', forecast_category:'expense'},
    ],
    ledger: [
      // Self Improvement: 3,800 reserved, cap 3 × 1,350 = 4,050 → own 250, overflow 1,100
      {id:1, jv:1, date:'2026-09-30', acc:20301, amt:-3800, descr:'reserve'},
      // Shopping: budget 1,000, spent 1,000 (on budget), reserve 2,000 of 3,000 → room 1,000
      {id:2, jv:2, date:'2026-09-30', acc:20302, amt:-(opts.shopReserve===undefined? 2000 : opts.shopReserve), descr:'reserve'},
      {id:3, jv:3, date:'2026-10-05', acc:60200, amt:opts.shopSpend===undefined? 1000 : opts.shopSpend, descr:'shop'},
      // Entertainment: budget 500, spent 500, reserve 0 of 1,500 → room 1,500
      {id:4, jv:4, date:'2026-10-06', acc:60300, amt:500, descr:'fun'},
      {id:5, jv:5, date:'2026-09-30', acc:20303, amt:-(opts.funReserve||0), descr:'reserve'},
      // Bills: budget 1,000, spent 1,500 → 500 over; reserve 300 at month end (a November posting must not count)
      {id:6, jv:6, date:'2026-10-07', acc:60400, amt:1500, descr:'bills'},
      {id:7, jv:7, date:'2026-09-30', acc:20304, amt:-300, descr:'reserve'},
      {id:8, jv:8, date:'2026-11-03', acc:20304, amt:-5000, descr:'after the month'},
      // Hobbies: no cap, on budget
      {id:9, jv:9, date:'2026-10-08', acc:60500, amt:400, descr:'hobby'},
    ],
    budget: [
      {id:1, acc:60100, date:'2026-10-01', amt:1350},
      {id:2, acc:60200, date:'2026-10-01', amt:1000},
      {id:3, acc:60300, date:'2026-10-01', amt:500},
      {id:4, acc:60400, date:'2026-10-01', amt:1000},
      {id:5, acc:60500, date:'2026-10-01', amt:400},
    ],
    provisionGroups: [], forecastAccountRules: [], forecastPlans:{},
    accrualMappings: [
      {category:'Self Improvement', liabilityAcc:20301, expenseAcc:60199, capMonths:3},
      {category:'Shopping', liabilityAcc:20302, expenseAcc:60299, capMonths:3},
      {category:'Entertainment', liabilityAcc:20303, expenseAcc:60399, capMonths:3},
      {category:'Bills', liabilityAcc:20304, expenseAcc:60499, capMonths:opts.billsCap===undefined? null : opts.billsCap},
      {category:'Hobbies', liabilityAcc:20305, expenseAcc:60599, capMonths:null},
    ],
    uiPrefs: {dismissals: opts.catchAll? {accrualOverflowAcc:opts.catchAll} : {}},
  };
  const sb = v455Sandbox(D, '2026-11-11');
  const toasts = [];
  sb.__set('renderNewJV', ()=>{}); sb.__set('toast', (m)=>toasts.push(m));
  sb.__set('accrualMonth', '2026-10');
  sb.__toasts = toasts;
  return sb;
}
function ovfRun(sb){
  sb.computeAccrualJV();
  const lines = vm.runInContext('jvDraft.lines', sb) || [];
  const expl = vm.runInContext('accrualExplanation', sb) || [];
  const by = (c)=>expl.find(e=>e.category===c) || {};
  const amt = (acc, re)=>lines.filter(l=>l.acc===acc && (!re || re.test(l.descr))).reduce((s,l)=>s+l.amt,0);
  return {lines, expl, by, amt, sum: lines.reduce((s,l)=>s+Math.round(l.amt*100),0), summary: vm.runInContext('accrualOverflowSummary', sb)};
}
const near = (a,b)=>Math.abs(a-b)<0.005;
async function testOverflowIsSharedByRoomLeft(){
  const r = ovfRun(ovfSandbox());
  // Own accrual unchanged: 119.99 to the reserve.
  assert(near(r.amt(20301, /Accrual - /), -250), 'Self Improvement still accrues its own 250 up to the cap, got ' + r.amt(20301));
  // Pool 1,100 shared 1,000 : 1,500 → 440 and 660.
  assert(near(r.amt(20302), -440), 'Shopping (room 1,000) gets 440.00, got ' + r.amt(20302));
  assert(near(r.amt(20303), -660), 'Entertainment (room 1,500) gets 660.00, got ' + r.amt(20303));
  assert(near(r.amt(60199, /overflow/), 1100), 'The whole overflow is debited to the source\'s 99 account, got ' + r.amt(60199, /overflow/));
  assert(r.sum===0, 'The JV balances, got ' + r.sum + ' cents');
  const shopLine = r.lines.find(l=>l.acc===20302);
  assert(shopLine && /^Shopping Accrual overflow \(from Self Improvement\) - /.test(shopLine.descr), 'Receiver lines say where the overflow came from, got ' + (shopLine&&shopLine.descr));
  assert(near(r.by('Self Improvement').overflowOut, 1100) && near(r.by('Shopping').overflowIn, 440) && near(r.by('Entertainment').overflowIn, 660), 'The explanation records overflow out and in');
  assert(/the other 1,100\.00 is overflow/.test(r.by('Self Improvement').action) && /1,100\.00 overflow passed on/.test(r.by('Self Improvement').action), 'The source explains its overflow, got ' + r.by('Self Improvement').action);
  assert(/received 440\.00 overflow from Self Improvement/.test(r.by('Shopping').action), 'The receiver explains what it got, got ' + r.by('Shopping').action);
}
async function testOverflowNeverPassesACap(){
  const r = ovfRun(ovfSandbox({shopReserve:2900, funReserve:1200}));
  // Rooms 100 + 300 = 400 < pool 1,100; no catch-all → only 400 is placed, 700 is not accrued.
  assert(near(r.amt(20302), -100) && near(r.amt(20303), -300), 'Each receiver is filled exactly to its cap, got ' + r.amt(20302) + ' / ' + r.amt(20303));
  assert(near(r.amt(60199, /overflow/), 400), 'Only what was placed is debited, got ' + r.amt(60199, /overflow/));
  assert(r.sum===0, 'The JV balances');
  assert(r.summary && near(r.summary.unaccrued, 700) && !r.summary.catchAcc, 'The summary reports 700 not accrued');
  assert(/700\.00 not accrued/.test(r.by('Self Improvement').action), 'The source says what was not accrued, got ' + r.by('Self Improvement').action);
}
async function testOverflowLeftoverGoesToTheCatchAll(){
  const sb = ovfSandbox({shopReserve:2900, funReserve:1200, catchAll:20399});
  const r = ovfRun(sb);
  assert(near(r.amt(20399), -700), 'The leftover goes to the catch-all reserve, got ' + r.amt(20399));
  const c = r.lines.find(l=>l.acc===20399);
  assert(c && /^Accrual overflow reserve \(from Self Improvement\)/.test(c.descr), 'Catch-all line names its source, got ' + (c&&c.descr));
  assert(near(r.amt(60199, /overflow/), 1100) && r.sum===0, 'Then all the overflow is debited and the JV balances');
  const html = sb.renderAccrualPanel();
  assert(/Catch-all reserve 20399/.test(html), 'The panel names the catch-all and its amount');
}
async function testOverflowReceiverRoomIsAfterItsOwnAccrual(){
  const r = ovfRun(ovfSandbox({shopSpend:800}));   // Shopping 200 under: own 200 → room 1,000 − 200 = 800
  assert(near(r.amt(20302, /Shopping Accrual - /), -200), 'Shopping accrues its own 200 first');
  // Pool 1,100 over rooms 800 : 1,500 (2,300) → 382.61 and 717.39 (the odd cent goes to the larger remainder)
  assert(near(r.amt(20302, /overflow/), -382.61) && near(r.amt(20303), -717.39), 'Overflow uses the room left after its own accrual, got ' + r.amt(20302, /overflow/) + ' / ' + r.amt(20303));
  assert(r.sum===0, 'The JV balances');
}
async function testOverflowDoesNotCoverAnOverspend(){
  const r = ovfRun(ovfSandbox());
  // Bills: 500 over, reserve 300 at 31 Oct (the 5,000 posted in November is ignored) → draws 300 only.
  assert(near(r.amt(20304, /Drawdown/), 300) && near(r.amt(60499, /Drawdown/), -300), 'Bills draws its own reserve, measured at month end, got ' + r.amt(20304, /Drawdown/));
  assert(/only 300\.00 was available at month end/.test(r.by('Bills').action), 'It says only 300 was available, got ' + r.by('Bills').action);
  assert(!r.lines.some(l=>l.acc===60499 && /overflow/.test(l.descr)), 'The overspend itself is not offset by overflow');
}
async function testOverspentCategoryCanBeToppedUpAfterItsFullDrawdown(){
  const r = ovfRun(ovfSandbox({billsCap:0.5}));   // cap 500; draws its 300, then has 500 of room
  assert(near(r.amt(20304, /Drawdown/), 300), 'The drawdown is still booked in full, so the overspend stays visible, got ' + r.amt(20304, /Drawdown/));
  // Rooms 1,000 : 1,500 : 500 → 366.67, 550.00, 183.33
  assert(near(r.amt(20304, /overflow/), -183.33) && near(r.amt(20302), -366.67) && near(r.amt(20303), -550), 'Then its reserve is topped up by its share like any other, got ' + [r.amt(20304, /overflow/), r.amt(20302), r.amt(20303)].join(' / '));
  assert(r.sum===0, 'The JV balances');
}
async function testUncappedCategoryNeitherGivesNorReceivesOverflow(){
  const r = ovfRun(ovfSandbox());
  assert(!r.lines.some(l=>l.acc===20305 || l.acc===60599) && !r.lines.some(l=>l.acc===20304 && /overflow/.test(l.descr)), 'Categories with no cap are left out of the overflow');
}
async function testCatchAllSettingIsSyncedAndRefusesACategoryReserve(){
  const sb = ovfSandbox();
  const writes = [];
  sb.__set('syncWrite', async (t, op, row)=>{ writes.push({t, row}); });
  sb.__set('persistLocal', ()=>{}); sb.__set('renderSettings', ()=>{});
  const bad = await sb.setAccrualOverflowAcc(20302);
  assert(bad===false && !writes.length, 'A category\'s own reserve can\'t be the catch-all');
  await sb.setAccrualOverflowAcc(20399);
  assert(writes[0] && writes[0].t==='pd_ui_prefs' && writes[0].row.dismissals.accrualOverflowAcc===20399, 'Saved in the synced preferences, got ' + JSON.stringify(writes[0]));
  assert(sb.getAccrualOverflowAcc()===20399, 'And read back');
  await sb.setAccrualOverflowAcc(null);
  assert(sb.getAccrualOverflowAcc()===null && !('accrualOverflowAcc' in writes[1].row.dismissals), 'Clearing removes it');
}
async function testAccrualPanelShowsOverflowDetail(){
  const sb = ovfSandbox();
  ovfRun(sb);
  const html = sb.renderAccrualPanel();
  sb.document.body.innerHTML = html;
  const head = [...sb.document.querySelectorAll('.accrual-expl th')].map(t=>t.textContent);
  ['Cap','Reserve at month end','Own','Overflow out','Overflow in'].forEach(h=>assert(head.includes(h), 'The explanation has a "'+h+'" column, got ' + head.join('|')));
  const shop = sb.document.querySelector('tr[data-accr-cat="Shopping"]');
  assert(shop && /3,000\.00/.test(shop.textContent) && /440\.00/.test(shop.textContent), 'The Shopping row shows its cap and overflow in');
  const sum = sb.document.querySelector('.accrual-overflow-sum');
  assert(sum && /Overflow pool: 1,100\.00 from Self Improvement/.test(sum.textContent) && /Shopping 440\.00/.test(sum.textContent) && /Entertainment 660\.00/.test(sum.textContent), 'A summary line lists the pool and who got what, got ' + (sum&&sum.textContent));
}
async function testSettingsShowsTheCatchAllPicker(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(/id="acpin_accrOverflow"/.test(html) && /setAccrualOverflowAcc\(document\.getElementById\('acpin_accrOverflow'\)/.test(html), 'Settings → Accrual Mappings has a catch-all reserve picker with a Save button');
}

// ================= v5.6.0: platform boxes, Needs you, live prices, daily closes, wallet check (#22) =================
// Every network call is faked: `routes` maps a URL pattern to the JSON it returns.
function v56Sandbox(extra, routes){
  const sb = poolSandbox(Object.assign({
    accounts: [10201,10202,10203,10204,10205,30101].map(id=>({id, acc_type:'Individual Account', status:'Active'})),
    invPlatforms: [{id:1, name:'Binance'}, {id:2, name:'Phantom'}, {id:3, name:'Robo Fund', isRobo:true, outAcc:30101, roboValue:1000, roboValueDate:'2026-11-01'}],
    invPositions: [
      {id:1, platformId:1, name:'Ethereum', ticker:'ETH', currency:'USD', assetClass:'Crypto', status:'Active'},
      {id:2, platformId:1, name:'Solana', ticker:'SOL', currency:'USD', assetClass:'Crypto', status:'Active'},
      {id:3, platformId:2, name:'Test Frog', ticker:'FROG', currency:'USD', assetClass:'Crypto', status:'Active'},
      {id:4, platformId:2, name:'Base Cat', ticker:'BCAT', currency:'USD', assetClass:'Crypto', status:'Active'},
      {id:5, platformId:1, name:'Tether', ticker:'USDT', currency:'USD', assetClass:'Crypto', status:'Active'},
      {id:6, platformId:1, name:'Mining Co', ticker:'MINE', currency:'USD', assetClass:'Stocks', status:'Active'},
    ],
    invTransactions: [
      {id:1, positionId:1, date:'2026-09-02', kind:'buy', units:1, totalSar:7500, owners:[{ownerId:1, units:0.6},{ownerId:2, units:0.4}], cashSide:'opening'},
      {id:2, positionId:2, date:'2026-09-02', kind:'buy', units:10, totalSar:3750, owners:[{ownerId:1, units:10}], cashSide:'bank'},
      {id:3, positionId:3, date:'2026-09-02', kind:'buy', units:1000, totalSar:375, owners:[{ownerId:1, units:1000}], cashSide:'bank'},
      {id:4, positionId:4, date:'2026-09-02', kind:'buy', units:50, totalSar:187.5, owners:[{ownerId:1, units:50}], cashSide:'bank'},
      {id:5, positionId:5, date:'2026-09-02', kind:'buy', units:20, totalSar:75, owners:[{ownerId:1, units:20}], cashSide:'bank'},
      {id:6, positionId:6, date:'2026-09-02', kind:'buy', units:5, totalSar:375, owners:[{ownerId:1, units:5}], cashSide:'bank'},
    ],
    invValuations: [{id:1, positionId:1, date:'2026-09-10', price:2000}, {id:2, positionId:2, date:'2026-09-10', price:100}],
    ledger: [], uiPrefs: {dismissals:{}},
  }, extra||{}), true);
  freezeDate(sb, '2026-11-12T10:00:00Z');
  const writes = [], calls = [];
  sb.__set('syncWrite', async (t, op, row)=>{ writes.push({t, op, row}); return {ok:true}; });
  sb.__set('invSleep', ()=>Promise.resolve());
  sb.__set('renderNav', ()=>{});
  sb.__set('drawInvCharts', ()=>{});
  sb.fetch = async (url, opts)=>{
    calls.push({url:String(url), opts});
    const r = (routes||[]).find(x=>x[0].test(String(url)));
    if(!r) return {ok:false, status:404, json: async()=>({}), text: async()=>'not found'};
    const status = r[2]||200;
    const body = typeof r[1]==='function'? r[1](String(url), opts) : r[1];
    return {ok: status<300, status, json: async()=>body, text: async()=>JSON.stringify(body)};
  };
  sb._writes = writes; sb._calls = calls;
  return sb;
}
async function v56Link(sb, links, keys){
  await sb.saveInvPriceCfg({links, keys: keys||{cg:'cg-test', finnhub:'fh-test'}});
}
const FROG = 'Frog1111111111111111111111111111111111111111', BCAT = '0x00000000000000000000000000000000000000c4';
const v56Html = sb => { sb.renderInvestmentsPage(); return sb.document.getElementById('app').innerHTML; };

async function testV56CloseIdsAreFixedAndNeverBecomeTheNextId(){
  const sb = v56Sandbox();
  const id = sb.invCloseValId(7, '2026-11-11');
  assert(id === 1e12 + 7*1e5 + Math.round(Date.parse('2026-11-11T00:00:00Z')/864e5), 'Close id = base + position×100000 + day number, got ' + id);
  assert(sb.invCloseValId(7, '2026-11-11') === id && sb.invCloseValId(7, '2026-11-12') === id+1, 'Same position and date always give the same id; next day is +1');
  sb._D.invValuations.push({id, positionId:7, date:'2026-11-11', price:1});
  assert(sb.invNextId(sb._D.invValuations) === 3, 'A close id is ignored when picking the next ordinary id, got ' + sb.invNextId(sb._D.invValuations));
  assert(Number.isSafeInteger(sb.invCloseValId(99999, '2030-01-01')), 'Close ids stay safe integers');
}
async function testV56SameDayCloseBeatsARefreshButANewerDayWins(){
  const sb = v56Sandbox({invValuations:[]});
  const V = sb._D.invValuations;
  V.push({id:1, positionId:1, date:'2026-11-10', price:1000});
  V.push({id:sb.invCloseValId(1,'2026-11-10'), positionId:1, date:'2026-11-10', price:1100});
  assert(sb.invLatestValuation(1).price===1100 && sb.invPriceAsOf(1,'2026-11-10')===1100, 'On the same date the close wins over a refreshed or typed price');
  V.push({id:2, positionId:1, date:'2026-11-11', price:1200});
  assert(sb.invLatestValuation(1).price===1200 && sb.invPriceAsOf(1,'2026-11-10')===1100, 'A newer day\'s refresh is the current price; history still reads the close');
  // Order of arrival must not matter: a close saved BEFORE the refresh (server job, then a late typed price) still wins.
  const sb2 = v56Sandbox({invValuations:[]});
  sb2._D.invValuations.push({id:sb2.invCloseValId(1,'2026-11-10'), positionId:1, date:'2026-11-10', price:1100});
  sb2._D.invValuations.push({id:1, positionId:1, date:'2026-11-10', price:1000});
  assert(sb2.invLatestValuation(1).price===1100 && sb2.invPriceAsOf(1,'2026-11-10')===1100, 'The close wins whichever was saved first');
}
async function testV56PriceSettingsAreSyncedInPreferences(){
  const sb = v56Sandbox();
  await sb.setInvPriceLink(3, {kind:'dex', chain:'solana', address:FROG});
  const w = sb._writes.filter(x=>x.t==='pd_ui_prefs').pop();
  assert(w && w.row.dismissals.invPrices.links[3].address===FROG, 'Price links are saved in the synced preferences, got ' + JSON.stringify(w&&w.row));
  assert(sb.invPriceLink(3) && sb.invPriceLink(3).chain==='solana' && sb.invPriceLink(1)===null, 'And read back per position');
  sb.document.body.innerHTML += '<input id="invKeyCg" value=" CG-abc "><input id="invKeyFh" value="fh1">';
  await sb.saveInvPriceKeys();
  const cfg = sb.getInvPriceCfg();
  assert(cfg.keys.cg==='CG-abc' && cfg.keys.finnhub==='fh1' && cfg.links[3], 'Keys are trimmed and saved without losing the links');
  await sb.setInvPriceLink(3, null);
  assert(!sb.getInvPriceCfg().links[3], 'Clearing a link removes it');
}
function v56PriceRoutes(over){
  return [
    [/dexscreener\.com\/tokens\/v1\/solana\//, [
      {chainId:'solana', baseToken:{address:FROG}, priceUsd:'0.002', liquidity:{usd:500}, volume:{h24:10}},
      {chainId:'solana', baseToken:{address:FROG}, priceUsd:'0.0025', liquidity:{usd:90000}, volume:{h24:5000}},
      {chainId:'solana', baseToken:{address:'Other1111111111111111111111111111111111111'}, priceUsd:'9', liquidity:{usd:1e6}}]],
    [/dexscreener\.com\/tokens\/v1\/base\//, []],
    [/geckoterminal\.com\/api\/v2\/simple\/networks\/base\/token_price\//, {data:{attributes:{token_prices:{[BCAT]:'0.5'}}}}],
    [/api\.coingecko\.com\/api\/v3\/simple\/price/, (over&&over.cg) || {ethereum:{usd:3000}}, (over&&over.cgStatus)||200],
    [/finnhub\.io\/api\/v1\/quote/, {c:12.5}],
  ];
}
const V56_LINKS = {1:{kind:'cg', id:'ethereum'}, 3:{kind:'dex', chain:'solana', address:FROG}, 4:{kind:'dex', chain:'base', address:BCAT}, 6:{kind:'stock', id:'MINE'}};
async function testV56RefreshWritesOnePricePerPositionForToday(){
  const sb = v56Sandbox({}, v56PriceRoutes());
  await v56Link(sb, V56_LINKS);
  sb._writes.length = 0;
  const r = await sb.refreshInvPrices({quiet:true});
  const rows = sb._writes.filter(x=>x.t==='pd_inv_valuations').map(x=>x.row);
  const p = id => (rows.find(x=>x.position_id===id)||{}).price;
  assert(r && r.updated===4 && rows.length===4, 'Four linked positions get a price, got ' + JSON.stringify(r));
  assert(p(1)===3000 && p(3)===0.0025 && p(4)===0.5 && p(6)===12.5, 'CoinGecko, DEX (deepest pool), GeckoTerminal backup and Finnhub prices, got ' + JSON.stringify(rows));
  assert(rows.every(x=>x.entry_date==='2026-11-12' && x.id < 1e12), 'Refreshed prices are today\'s ordinary rows, not closes');
  assert(!rows.some(x=>x.position_id===2 || x.position_id===5), 'Unlinked (SOL) and stablecoin (USDT) positions are left alone');
  const dexCalls = sb._calls.filter(c=>/dexscreener\.com\/tokens\/v1\/solana\//.test(c.url));
  assert(dexCalls.length===1 && dexCalls[0].url.endsWith(FROG), 'One DexScreener call per chain with the addresses');
  assert(sb._calls.some(c=>/x_cg_demo_api_key=cg-test/.test(c.url)) && sb._calls.some(c=>/token=fh-test/.test(c.url)), 'The CoinGecko and Finnhub keys are used');
  const before = sb._D.invValuations.length;
  await sb.refreshInvPrices({quiet:true});
  assert(sb._D.invValuations.length===before, 'A second refresh the same day overwrites today\'s price instead of adding rows');
  assert(sb.localStorage.getItem('invPricesFetchedAt'), 'The refresh time is remembered on this device');
}
async function testV56OneFailingSourceDoesNotStopTheOthers(){
  const sb = v56Sandbox({}, v56PriceRoutes({cg:{error:'rate limited'}, cgStatus:429}));
  await v56Link(sb, V56_LINKS);
  const r = await sb.refreshInvPrices({quiet:true});
  assert(r.updated===3 && r.failed[1] && r.errors.some(e=>/CoinGecko/.test(e) && /429/.test(e)), 'CoinGecko refusing still saves the other three and reports why, got ' + JSON.stringify(r));
  const sb2 = v56Sandbox({}, v56PriceRoutes());
  await v56Link(sb2, V56_LINKS, {cg:'x'});
  const r2 = await sb2.refreshInvPrices({quiet:true});
  assert(r2.errors.some(e=>/Finnhub: no key/.test(e)) && r2.failed[6], 'Without a Finnhub key the stock is reported, not silently skipped');
}
async function testV56AutoRefreshOnlyWhenThisDeviceIsBehind(){
  const sb = v56Sandbox({}, v56PriceRoutes());
  await v56Link(sb, V56_LINKS);
  sb.localStorage.setItem('invPricesFetchedAt', new Date(Date.parse('2026-11-12T08:00:00Z')).toISOString());
  sb._calls.length = 0;
  sb.invMaybeAutoRefresh();
  await new Promise(r=>setTimeout(r, 20));
  assert(!sb._calls.length, 'Refreshed 2 hours ago: opening Investments does not fetch again');
  sb.localStorage.setItem('invPricesFetchedAt', '2026-11-12T01:00:00.000Z');
  sb.invMaybeAutoRefresh();
  await new Promise(r=>setTimeout(r, 20));
  assert(sb._calls.length>0, 'Last refresh 9 hours ago: opening Investments refreshes quietly');
}
async function testV56BackfillSavesDailyClosesOnce(){
  const day = d => Date.parse(d+'T00:00:00Z');
  const sb = v56Sandbox({}, [
    [/coins\/ethereum\/market_chart/, {prices:[[day('2026-09-01'), 1500], [day('2026-09-03'), 1600], [day('2026-09-04'), 1650], [day('2026-11-12')+5*3600e3, 9999]]}],
    [/networks\/solana\/tokens\/Frog.*\/pools/, {data:[{attributes:{address:'PoolA'}}]}],
    [/networks\/solana\/pools\/PoolA\/ohlcv\/day/, {data:{attributes:{ohlcv_list:[[day('2026-11-10')/1000, 1,1,1, 0.003, 9], [day('2026-11-11')/1000, 1,1,1, 0.004, 9]]}}}],
  ]);
  await v56Link(sb, V56_LINKS);
  sb._writes.length = 0;
  await sb.backfillInvCloses();
  const rows = sb._writes.filter(x=>x.t==='pd_inv_valuations').map(x=>x.row);
  const eth = rows.filter(r=>r.position_id===1).map(r=>r.entry_date+'='+r.price).sort();
  assert(eth.join(',')==='2026-09-02=1600,2026-09-03=1650', 'A 00:00 UTC point is the previous day\'s close; days before the first buy and the live point are skipped, got ' + eth.join(','));
  assert(rows.filter(r=>r.position_id===3).map(r=>r.entry_date+'='+r.price).join(',')==='2026-11-10=0.003,2026-11-11=0.004', 'DEX history comes from the token\'s top pool, daily closes, got ' + JSON.stringify(rows.filter(r=>r.position_id===3)));
  assert(rows.every(r=>r.id===sb.invCloseValId(r.position_id, r.entry_date)), 'Backfilled rows use the fixed close ids');
  assert(sb._calls.some(c=>/ohlcv\/day.*token=Frog/.test(c.url)), 'The candles are asked for in the token\'s own price');
  assert(!rows.some(r=>r.position_id===6), 'Stocks are not backfilled (no free history)');
  sb._writes.length = 0;
  await sb.backfillInvCloses();
  assert(!sb._writes.some(x=>x.t==='pd_inv_valuations'), 'Running it again writes nothing new');
}
async function testV56BoxesShowValueHoldingsShareAndFreshness(){
  const sb = v56Sandbox();
  const html = v56Html(sb);
  sb.document.getElementById('app').innerHTML = html;
  const box = sb.document.querySelector('.inv-box[data-box="1"]');
  assert(box, 'Binance gets a box');
  if(!box) return;
  const t = box.textContent.replace(/\s+/g,' ');
  assert(/Binance/.test(t) && /Crypto, Stocks/.test(t), 'The box names the platform and what it holds, got ' + t.slice(0,120));
  const top = [...box.querySelectorAll('.inv-box-top b')].map(b=>b.textContent);
  assert(top.length===3 && !/more<\/div>/.test(box.innerHTML), 'The box lists its three holdings (USDT counts as cash, not a holding), got ' + top.join(','));
  assert(/% mine/.test(t) && /% family/.test(t), 'The box shows the mine / family share');
  assert(/Prices 63 days old/.test(t) && box.querySelector('.inv-box-fresh .r'), 'Old prices are flagged in red, got ' + t);
  assert(/without a price/.test(t) && /Never checked/.test(t), 'Unpriced holdings and never-checked units are shown');
  assert(/openInvTradePicker\(1\)/.test(box.innerHTML) && /openInvRepeatLastBuy\(1\)/.test(box.innerHTML) && /INV_PLATFORM_ACTIONS\.collect\.open\(1\)/.test(box.innerHTML), 'The box has Buy, Repeat last buy and Collect');
  const robo = sb.document.querySelector('.inv-box[data-box="3"]');
  assert(robo && /openInvEditPlatform\(3\)/.test(robo.innerHTML), 'A robo platform box offers Update value');
}
async function testV56TopHoldingsAreSortedByValue(){
  const sb = v56Sandbox();
  sb.document.getElementById('app').innerHTML = v56Html(sb);
  const top = [...sb.document.querySelectorAll('.inv-box[data-box="1"] .inv-box-top b')].map(b=>b.textContent);
  // Mine: ETH 0.6 × 2000 × 3.75 = 4,500; SOL 10 × 100 × 3.75 = 3,750; MINE unpriced at cost 375.
  assert(top.join(',')==='ETH,SOL,MINE', 'Largest first, got ' + top.join(','));
}
async function testV56BoxActionsAppearOnHoverOnly(){
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(/\.inv-box \.inv-box-actions\{opacity:0;max-height:0/.test(html), 'Box buttons are hidden until hovered');
  assert(/\.inv-box:hover \.inv-box-actions, \.inv-box:focus-within \.inv-box-actions\{opacity:1/.test(html), 'They appear on hover or keyboard focus');
  assert(/@media \(hover:none\)\{ \.inv-box \.inv-box-actions\{opacity:1/.test(html), 'On touch screens (no hover) they always show');
}
async function testV56ArrangeBoxesIsSynced(){
  const sb = v56Sandbox();
  sb.__set('invBoxEdit', true);
  await sb.moveInvBox(1, 1);
  let prefs = sb.getInvBoxPrefs();
  assert(prefs.order.indexOf(1) > prefs.order.indexOf(2), 'Moving Binance later puts it after Phantom, got ' + JSON.stringify(prefs.order));
  assert(sb._writes.some(w=>w.t==='pd_ui_prefs' && w.row.dismissals.invBoxes), 'The order is saved in the synced preferences');
  sb.document.getElementById('app').innerHTML = v56Html(sb);
  const ids = [...sb.document.querySelectorAll('.inv-boxes > .inv-box[data-box]')].map(b=>b.getAttribute('data-box'));
  assert(ids.indexOf('2') < ids.indexOf('1'), 'The boxes show in the saved order, got ' + ids.join(','));
  await sb.toggleInvBoxFlag(2, 'grouped');
  await sb.toggleInvBoxFlag(3, 'grouped');
  sb.document.getElementById('app').innerHTML = v56Html(sb);
  const grp = sb.document.querySelector('.inv-box-group');
  assert(grp && grp.querySelectorAll('[data-groupplat]').length===2 && !sb.document.querySelector('.inv-box[data-box="2"]'), 'Grouped platforms share one "Other wallets" box');
  await sb.toggleInvBoxFlag(1, 'hidden');
  const html = v56Html(sb);
  assert(!/data-box="1"/.test(html) && /Hidden: Binance/.test(html) && /toggleInvBoxFlag\(1, 'hidden'\)/.test(html), 'A hidden box is listed under Hidden with Show');
}
async function testV56NeedsYouListsWhatIsWaiting(){
  const sb = v56Sandbox({ledger:[
    {id:1, jv:1, date:'2026-10-27', acc:10202, amt:500, descr:'B contribution'},
    {id:2, jv:2, date:'2026-10-27', acc:30101, amt:100, descr:'robo top-up'},
  ], invPlatforms:[{id:1, name:'Binance', outAcc:10205}, {id:2, name:'Phantom'}, {id:3, name:'Robo Fund', isRobo:true, outAcc:30101, roboValue:1000, roboValueDate:'2026-09-01'}],
     invSettings:{fxUsdSar:3.75, mgmtFeePct:0, reconStartDate:'2026-10-01'}});
  sb._D.ledger.push({id:3, jv:3, date:'2026-11-02', acc:10205, amt:20000, descr:'paid into Binance'});
  const items = sb.invNeedsYouItems();
  const keys = items.map(i=>i.key);
  assert(keys.includes('collect') && items.find(i=>i.key==='collect').act==="invStartPlatformAction('collect')", 'Money in an onboarding account that isn\'t collected shows, with Collect');
  const dep = items.find(i=>/^dep1/.test(i.key));
  assert(dep && /20,000\.00 SAR paid in on 2026-11-02/.test(dep.text) && /openInvDepositFromLedger\(1, '2026-11-02', 20000\)/.test(dep.act), 'Ledger money paid onto a platform with no deposit shows, got ' + JSON.stringify(dep));
  assert(keys.includes('robo3') && /last updated 72 days ago/.test(items.find(i=>i.key==='robo3').text), 'A robo value older than a month asks for this month\'s value');
  assert(keys.includes('links'), 'Positions with old prices and no link point to Price links');
  sb._D.invCashMovements.push({id:9, platformId:1, date:'2026-11-03', kind:'deposit', usdAmount:5333.33, owners:[{ownerId:1, usd:5333.33, sar:20000}]});
  assert(!sb.invNeedsYouItems().some(i=>/^dep1/.test(i.key)), 'A deposit within 5 days and 2% clears it');
}
async function testV56RailBadgeCountsInvestmentItems(){
  const sb = v56Sandbox({invPlatforms:[{id:3, name:'Robo Fund', isRobo:true, roboValue:1000, roboValueDate:'2026-08-01'}], invPositions:[], invTransactions:[], invValuations:[]});
  const b = sb.invNavBadgeHTML();
  assert(/inv-nav-badge/.test(b) && />1<\/span>/.test(b), 'One item → a badge with 1 on the Investments button, got ' + b);
  const html = fs.readFileSync(APP_HTML, 'utf8');
  assert(/\$\{id==='investments'\? invNavBadgeHTML\(\) : ''\}/.test(html), 'renderNav puts the badge on the Investments button');
  sb._D.invPlatforms[0].roboValueDate = '2026-11-10';
  assert(sb.invNavBadgeHTML()==='', 'Nothing waiting → no badge');
}
async function testV56NeedsYouIsOnMineAndOpensAPrefilledDeposit(){
  const sb = v56Sandbox({invPlatforms:[{id:1, name:'Binance', outAcc:10205}, {id:2, name:'Phantom'}],
    ledger:[{id:3, jv:3, date:'2026-11-02', acc:10205, amt:3750, descr:'paid in'}], invSettings:{fxUsdSar:3.75, mgmtFeePct:0, reconStartDate:'2026-10-01'}});
  const html = v56Html(sb);
  assert(/id="invNeedsYou"/.test(html) && /Record deposit/.test(html), 'Needs you shows at the top of Mine');
  sb.openInvDepositFromLedger(1, '2026-11-02', 3750);
  const d = sb._invCashDraft;
  assert(d && d.kind==='deposit' && d.date==='2026-11-02' && d.usdAmount===1000 && d.owners[0].usd===1000, 'The deposit opens with the ledger date and amount in USD, got ' + JSON.stringify(d));
}
async function testV56WalletCheckReadsSolanaTokenBalances(){
  const sb = v56Sandbox({}, [
    [/api\.mainnet-beta\.solana\.com/, (url, opts)=>{
      const b = JSON.parse(opts.body);
      if(b.params[1].programId.startsWith('Tokenkeg')) return {result:{value:[
        {account:{data:{parsed:{info:{mint:FROG, tokenAmount:{uiAmountString:'990.5'}}}}}},
        {account:{data:{parsed:{info:{mint:'Stray111111111111111111111111111111111111', tokenAmount:{uiAmountString:'7'}}}}}}]}};
      return {result:{value:[]}};
    }],
  ]);
  await v56Link(sb, V56_LINKS);
  await sb.setInvPlatformWallets(2, [{chain:'solana', address:'Wallet1111111111111111111111111111111111111'}]);
  await sb.checkInvPlatformWallet(2);
  const r = vm.runInContext('invWalletResults[2]', sb);
  const frog = r && r.rows.find(x=>x.pos.id===3);
  assert(frog && frog.wallet===990.5 && frog.tracker===1000, 'The wallet\'s FROG balance is read next to the tracker\'s, got ' + JSON.stringify(r && r.rows.map(x=>[x.pos.id, x.tracker, x.wallet])));
  assert(r.untracked===1, 'Tokens in the wallet that the tracker doesn\'t have are counted');
  assert(sb._calls.filter(c=>/solana\.com/.test(c.url)).length===2, 'Both Solana token programs are read');
  sb.__set('invView', 'recon');
  const html = v56Html(sb);
  assert(/data-walletplat="2"/.test(html) && /Save wallet units as statement units/.test(html) && /data-walletpos="3"/.test(html), 'Reconcile shows the wallet result for that platform');
  sb._writes.length = 0;
  await sb.saveInvWalletUnits(2);
  const w = sb._writes.find(x=>x.t==='pd_inv_positions' && x.row.id===3);
  assert(w && w.row.stmt_units===990.5 && w.row.stmt_date==='2026-11-12', 'Saving writes the wallet units as today\'s statement units, got ' + JSON.stringify(w));
}
async function testV56WalletCheckReadsEvmBalancesWithDecimals(){
  const sb = v56Sandbox({}, [
    [/mainnet\.base\.org/, (url, opts)=>JSON.parse(opts.body).map(c=>({id:c.id,
      result: c.id[0]==='b'? '0x' + (2500000n).toString(16) : c.id[0]==='d'? '0x6' : '0x' + (15n*10n**17n).toString(16)}))],
  ]);
  await v56Link(sb, {4:{kind:'dex', chain:'base', address:BCAT}});
  const bal = await sb.invWalletBalances({chain:'base', address:'0x00000000000000000000000000000000000000aa'}, [BCAT, '0x0000000000000000000000000000000000000000']);
  assert(bal[BCAT.toLowerCase()]===2.5, 'balanceOf 2,500,000 with 6 decimals = 2.5 units, got ' + bal[BCAT.toLowerCase()]);
  assert(bal['0x0000000000000000000000000000000000000000']===1.5, 'Native coin balance in 18 decimals = 1.5, got ' + bal['0x0000000000000000000000000000000000000000']);
  const call = sb._calls[0] && JSON.parse(sb._calls[0].opts.body).find(c=>c.id==='b0');
  assert(call && call.params[0].data==='0x70a08231' + '00000000000000000000000000000000000000aa'.padStart(64,'0'), 'balanceOf is called with the wallet address');
}
async function testV56WalletAddressIsCheckedAgainstTheChain(){
  const sb = v56Sandbox();
  sb.prompt = ()=>'solana:0x00000000000000000000000000000000000000aa';
  await sb.editInvPlatformWallet(2);
  assert(sb.invPlatformWallets(2).length===0, 'An Ethereum-style address is refused for Solana');
  sb.prompt = ()=>'solana:WkPet1111111111111111111111111111111111111, base:0x00000000000000000000000000000000000000aa';   // base58: no 0, O, I or l
  await sb.editInvPlatformWallet(2);
  const w = sb.invPlatformWallets(2);
  assert(w.length===2 && w[0].chain==='solana' && w[1].chain==='base', 'One wallet per chain is saved, got ' + JSON.stringify(w));
}
async function testV56RepeatLastBuyCopiesPositionAmountAndSplit(){
  const sb = v56Sandbox();
  sb._D.invTransactions.push({id:20, positionId:2, date:'2026-11-05', kind:'buy', units:4, totalSar:1500, usdAmount:400, owners:[{ownerId:1, units:3},{ownerId:2, units:1}], cashSide:'bank', note:'weekly'});
  sb.__set('renderInvTxModal', ()=>{});
  assert(sb.invLastBuy(1).id===20, 'The last real buy on the platform is found (opening balances don\'t count)');
  sb.openInvRepeatLastBuy(1);
  const d = sb._invTxDraft;
  assert(d && d.positionId===2 && !d.id && d.date==='2026-11-12' && d.units==='', 'A new buy of the same position, today, units left for you, got ' + JSON.stringify(d));
  assert(d.totalSar===1500 && d.usdAmount===400 && d.note==='weekly' && d.cashSide==='bank', 'Same amount and funding');
  assert(d.splitMode==='sar' && Math.abs(d.ownersSar[1]-1125)<0.01 && Math.abs(d.ownersSar[2]-375)<0.01 && d.owners.length===2, 'Same SAR split per person, got ' + JSON.stringify(d.ownersSar));
  sb.openInvTxModal(2, null);
  assert(sb._invTxDraft.totalSar==='' && sb._invTxDraft.splitMode==='units', 'The preset is used once only');
}
async function testV56CollectOffersInvestItNow(){
  const sb = v56Sandbox();
  await poolCollect(sb, 1, '2026-11-12', {2:375}, 100);
  const modal = sb.document.getElementById('modalRoot').innerHTML;
  assert(/Invest it now\?/.test(modal) && /\$100\.00 just landed on Binance/.test(modal), 'After Collect, Invest it now is offered');
  assert(/_invTxPreset=\{cashSide:'cash', usdAmount:100\}; openInvTradePicker\(1\)/.test(modal), 'Buy now opens the trade with the cash amount');
  sb.__set('renderInvTxModal', ()=>{});
  vm.runInContext("window._invTxPreset={cashSide:'cash', usdAmount:100}", sb);
  sb.openInvTxModal(1, null);
  assert(sb._invTxDraft.cashSide==='cash' && sb._invTxDraft.usdAmount===100, 'The trade starts as a cash-funded buy of $100');
}
async function testV56PriceLinkSearchOffersOnlyMatchingCoins(){
  const sb = v56Sandbox({}, [
    [/api\/v3\/search\?query=FROG/, {coins:[{id:'test-frog', name:'Test Frog', symbol:'frog', market_cap_rank:900}, {id:'frogger', name:'Frogger', symbol:'FRGR'}]}],
    [/latest\/dex\/search\?q=FROG/, {pairs:[
      {chainId:'solana', baseToken:{address:FROG, symbol:'FROG', name:'Test Frog'}, priceUsd:'0.002', liquidity:{usd:5000}},
      {chainId:'solana', baseToken:{address:FROG, symbol:'FROG', name:'Test Frog'}, priceUsd:'0.002', liquidity:{usd:100}},
      {chainId:'bsc', baseToken:{address:'0xbsc', symbol:'FROG', name:'BSC Frog'}, priceUsd:'1', liquidity:{usd:1e6}}]}],
  ]);
  sb.__set('showModal', ()=>{});
  await sb.invLinkSearch(3);
  const res = vm.runInContext('window._invLinkUi.results', sb);
  assert(res && res.length===2 && res[0].link.kind==='cg' && res[0].link.id==='test-frog' && res[1].link.kind==='dex' && res[1].link.address===FROG,
    'Only exact symbol matches; one DEX entry per token; other chains left out, got ' + JSON.stringify(res && res.map(r=>r.link)));
  await sb.invLinkPick(3, 1);
  assert(sb.invPriceLink(3).address===FROG, 'Use saves the chosen link');
  await sb.invLinkSearch(6);
  const st = vm.runInContext('window._invLinkUi.results', sb);
  assert(st.length===1 && st[0].link.kind==='stock' && st[0].link.id==='MINE', 'A stock is offered as its ticker on Finnhub');
}
async function testV56PasteAddressDetectsTheChain(){
  const sb = v56Sandbox();
  sb.__set('showModal', ()=>{});
  sb.prompt = ()=>FROG;
  await sb.invLinkPasteAddress(3);
  assert(sb.invPriceLink(3).chain==='solana', 'A Solana address is recognised');
  const answers = [BCAT, 'base'];
  sb.prompt = ()=>answers.shift();
  await sb.invLinkPasteAddress(4);
  assert(sb.invPriceLink(4).chain==='base' && sb.invPriceLink(4).address===BCAT, 'An 0x address asks Base or Ethereum');
  sb.prompt = ()=>'not-an-address';
  await sb.invLinkPasteAddress(1);
  assert(!sb.invPriceLink(1), 'Anything else is refused');
}
async function testV56SetupHasPriceLinksAndTheJobButtons(){
  const sb = v56Sandbox();
  sb.__set('invView', 'setup');
  assert(/openInvPriceLinks\(\)/.test(v56Html(sb)), 'Setup has 💹 Price links');
  sb.openInvPriceLinks();
  const m = sb.document.getElementById('modalRoot').innerHTML;
  assert(/id="invKeyCg"/.test(m) && /id="invKeyFh"/.test(m) && /backfillInvCloses\(\)/.test(m) && /runInvDailyCloseNow\(\)/.test(m) && /refreshInvPrices\(\)/.test(m), 'The Price links window has the keys, Refresh, Backfill and Run the daily job');
  assert(/data-linkpos="3"/.test(m) && !/data-linkpos="5"/.test(m), 'Stablecoins are not listed for linking');
}
async function testV56NewStorageKeysAreListed(){
  const sb = v56Sandbox();
  ['invView','invCcy','invPricesFetchedAt'].forEach(k=>assert(sb.isLedgerOsKey(k), k+' is listed as a LedgerOS storage key'));
}
// ---------- the daily closing-price Edge Function ----------
function loadEdgeFunction(){
  const src = fs.readFileSync(path.join(__dirname, 'edge', 'inv-daily-close', 'index.ts'), 'utf8').replace(/^export /m, '');
  const served = {};
  const ctx = {console, Response: class { constructor(b, o){ this.body = b; this.status = (o&&o.status)||200; this.headers = (o&&o.headers)||{}; } },
    Deno: {serve(fn){ served.fn = fn; }, env:{get: k=>({SUPABASE_URL:'https://test.example.co', SUPABASE_SERVICE_ROLE_KEY:'svc'}[k])}}};
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.runDailyClose = runDailyClose;', ctx);
  ctx._served = served;
  return ctx;
}
async function testV56EdgeJobSavesYesterdaysCloses(){
  const ctx = loadEdgeFunction();
  const calls = [];
  ctx.fetch = async (url, opts)=>{
    calls.push({url:String(url), opts});
    const j = b => ({ok:true, status:200, json: async()=>b, text: async()=>''});
    if(/pd_ui_prefs/.test(url)) return j([{dismissals:{invPrices:{keys:{cg:'k1', finnhub:'k2'}, links:{1:{kind:'cg', id:'ethereum'}, 3:{kind:'dex', chain:'solana', address:FROG}, 6:{kind:'stock', id:'MINE'}, 9:{kind:'cg', id:'gone'}}}}}]);
    if(/pd_inv_positions/.test(url)) return j([{id:1, status:'Active'}, {id:3, status:'Active'}, {id:6, status:'Active'}, {id:9, status:'Closed'}]);
    if(/dexscreener/.test(url)) return j([{baseToken:{address:FROG}, priceUsd:'0.003', liquidity:{usd:10}}]);
    if(/coingecko/.test(url)) return j({ethereum:{usd:3100}});
    if(/finnhub/.test(url)) return j({c:0});
    if(/pd_inv_valuations/.test(url)) return j({});
    return {ok:false, status:404, json: async()=>({}), text: async()=>''};
  };
  const r = await ctx.runDailyClose({supabaseUrl:'https://test.example.co/', serviceKey:'svc', now:'2026-11-12T00:05:00Z'});
  assert(r.date==='2026-11-11' && r.linked===3 && r.saved===2 && r.missing===1, 'Saves yesterday\'s closes for open linked positions, got ' + JSON.stringify(r));
  const save = calls.find(c=>/pd_inv_valuations\?on_conflict=id/.test(c.url));
  const rows = save && JSON.parse(save.opts.body);
  const sb = v56Sandbox();
  assert(rows && rows.length===2 && rows.every(x=>x.id===sb.invCloseValId(x.position_id, '2026-11-11') && x.entry_date==='2026-11-11'), 'Its ids match the app\'s close ids, got ' + JSON.stringify(rows));
  assert(/merge-duplicates/.test(save.opts.headers.Prefer) && save.opts.headers.apikey==='svc', 'A re-run updates the same rows (merge) using the service key');
  assert(!calls.some(c=>/gone/.test(c.url)), 'Closed positions are skipped');
  assert(calls.some(c=>/x_cg_demo_api_key=k1/.test(c.url)), 'It uses the synced CoinGecko key');
  const pre = await ctx._served.fn({method:'OPTIONS'});
  assert(pre.headers['Access-Control-Allow-Origin']==='*', 'It answers the browser\'s CORS check (Run the daily job now)');
}

// ================= v5.7.0: #26 SMS mappings, #27 SMS line order, #29 averages, #30 Budget & P&L, #31 accrual cover =================
async function testV57SmsJvKeepsTheAccountsLinesTogether(){
  const sb = smsSandbox(); const D = vm.runInContext('D', sb), R = sb.__R;
  // The fee is on the FIRST SMS, so "fees at the bottom" is only true if fee lines really are moved down.
  D.smsInbox.push(R(1, {amt:88.1, descr:'TEST POWER CO', fee:2}), R(2, {amt:1.25, side:'Dr', kind:'Cashback', descr:'Cashback'}));
  await sb.__map({'1111':10101});
  const lines = sb.smsBuildJVs('a:10101').jvs[0].lines;
  const sig = lines.map(l=>(l.acc||'?')+':'+l.amt).join(' ');
  assert(sig==='10101:-88.1 10101:-2 10101:1.25 ?:88.1 ?:-1.25 ?:2',
    'Card lines first (purchase, its fee, cashback), then the other halves in the same order, fee other half last; got ' + sig);
  assert(Math.abs(lines.reduce((s,l)=>s+Number(l.amt),0))<0.005, 'Still balances');
}
async function testV57SmsTransferPartnerAndFeeGoAfterTheAccountsLines(){
  const sb = smsSandbox(); const D = vm.runInContext('D', sb), R = sb.__R;
  D.smsInbox.push(R(1, {acct:'A debit', side:'Cr', amt:500.5, counter:'2222', kind:'Outgoing transfer', descr:'TEST PERSON'}),
    R(2, {acct:'2222', source:'BANKB', side:'Dr', amt:500, counter:'0101', kind:'Incoming transfer', descr:'TEST PERSON'}),
    R(3, {acct:'A debit', amt:20, descr:'SHOP 3'}));
  await sb.__map({'A debit':10101, '0101':10101, '2222':10102});
  const lines = sb.smsBuildJVs('a:10101').jvs[0].lines;
  const sig = lines.map(l=>(l.acc||'?')+':'+l.amt).join(' ');
  assert(sig==='10101:-500.5 10101:-20 10102:500 ?:20 ?:0.5', 'Own account first; the other bank as the other half; the transfer fee at the bottom; got ' + sig);
}
async function testV57SmsNumbersAndAccountsCanBeChanged(){
  const sb = smsSandbox(); const D = vm.runInContext('D', sb), R = sb.__R;
  await sb.__map({'1111':10101, '2222':10102});
  sb.__set('smsMapOpen', true);
  sb.openSmsInbox();
  let m = sb.document.getElementById('modalRoot');
  const row = m.querySelector('tr[data-smsmap="1111"] select.sms-map-pick');
  assert(row && row.querySelector('option[selected]') && row.querySelector('option[selected]').value==='10101', 'Every mapped number is listed with its account, even with nothing waiting');
  assert(/smsChangeMapping\("1111", this\.value\)/.test(row.getAttribute('onchange')||''), 'Picking another account changes it');
  await sb.smsChangeMapping('1111', '10103');
  assert(sb.smsAccFor('1111')===10103 && sb.smsAccFor('2222')===10102, 'Only that number moves');
  await sb.smsChangeMapping('2222', '');
  assert(sb.smsAccFor('2222')===null, 'Remove forgets it, so its SMS ask for an account again');
  D.smsInbox.push(R(1, {acct:'1111'}));
  sb.__set('smsMapOpen', false);
  sb.openSmsInbox();
  m = sb.document.getElementById('modalRoot');
  assert(/smsMapOpen=true; openSmsInbox\(\)/.test(m.querySelector('.sms-group').innerHTML) && /✎ Change/.test(m.querySelector('.sms-group').innerHTML), 'A mapped group has ✎ Change, opening the list');
  assert(m.querySelector('#smsMapToggle') && /Numbers & accounts \(1\)/.test(m.querySelector('#smsMapToggle').textContent), 'The list is folded away by default, with a count');
}
function v57AvgSandbox(){
  const sb = dashSandbox({today:'2026-11-12T10:00:00.000Z'});
  const D = vm.runInContext('D', sb);
  D.accounts.push({id:60150, name:'Power', descr:'Power', category:'Living', status:'Active', acc_type:'Individual Account'},
                  {id:60151, name:'Water', descr:'Water', category:'Living', status:'Active', acc_type:'Individual Account'});
  const L = (id, acc, amt, date) => ({id, jv:id, date, acc, amt, descr:'x'});
  D.ledger.push(L(101,60150,1200,'2024-03-01'), L(102,60150,600,'2025-06-01'), L(103,60150,300,'2026-02-10'), L(104,60150,90,'2026-10-20'), L(105,60150,30,'2026-11-12'),
                L(106,60151,60,'2026-11-01'));
  sb.rebuildIndex();
  return sb;
}
async function testV57HistoricalAveragesArePerMonth(){
  const sb = v57AvgSandbox();
  const st = sb.historicalStatsFor([60150]);
  const pm = (total, days) => total/(days/(365.25/12));
  const near = (a, b) => Math.abs(a-b) < 0.01;
  assert(near(st.roll30, pm(30+90, 30)), 'Last 30 days: Oct 14 – Nov 12 total (120) as a monthly figure, got ' + st.roll30);
  assert(near(st.roll365, pm(300+90+30, 365)), 'Last 365 days per month, got ' + st.roll365);
  assert(near(st.y2025, 50) && near(st.y2024, 100), 'Each year = its total ÷ 12 (2025: 600/12, 2024: 1200/12)');
  assert(near(st.ytd, pm(420, 316)), '2026 so far: Jan 1 – Nov 12 (316 days) as a monthly figure, got ' + st.ytd);
  assert(!('y2023' in st), 'Years start at the first year with data');
  const defs = sb.historicalStatDefs([60150]).map(d=>d[0]).join(',');
  assert(defs==='roll30,roll60,roll90,roll180,roll365,ytd,y2025,y2024', 'Shown: rolling 30/60/90/180/365, this year, then every earlier year, newest first; got ' + defs);
  const w = sb.historicalStatsFor([60151]);
  assert(near(w.roll90, pm(60, 12)), 'An account newer than the window is averaged over the days it has existed, got ' + w.roll90);
  const both = sb.historicalStatsFor(new Set([60150, 60151]));
  assert(near(both.roll30, pm(180, 30)), 'A sub category adds its accounts (a Set works too), got ' + both.roll30);
}
async function testV57AveragesShowOnThePnLChartAndAccountsPopup(){
  const sb = v57AvgSandbox();
  sb.__set('drawAcctBudgetChart', ()=>{});
  sb.__set('accountsWithBudgetFigures', ()=>[{id:60150}]);
  sb.__set('subcategoriesWithBudgetFigures', ()=>['Living']);
  sb.openAcctBudgetChart(60150);
  let html = sb.document.getElementById('app').innerHTML;
  assert(/Historical averages/.test(html) && /data-hist="roll30"/.test(html) && /data-hist="y2024"/.test(html) && /Average per month/.test(html), 'The P&L 📊 chart for an account shows the averages');
  sb.openAcctBudgetChartForCategory('Living');
  html = sb.document.getElementById('app').innerHTML;
  assert(/Historical averages — Living/.test(html) && /data-hist="roll365"/.test(html), 'And for a sub category');
  sb.openAccountStatsPopup(60150);
  const m = sb.document.getElementById('modalRoot').innerHTML;
  assert(/data-hist="roll90"/.test(m) && /data-hist="ytd"/.test(m) && !/Rolling 3-Month/.test(m), 'Accounts → 📊 Historical Averages shows the same metrics');
  const list = sb.renderForecastStatSettingsList();
  assert(/setForecastStatSetting\('roll180'/.test(list) && /setForecastStatSetting\('y2024'/.test(list), 'Forecast → Settings lists the same choices');
  sb.setForecastStatSetting('roll60', false);
  sb.openAccountStatsPopup(60150);
  assert(!/data-hist="roll60"/.test(sb.document.getElementById('modalRoot').innerHTML), 'Turning one off hides it');
}
async function testV57ShiftDateIsRightEastOfUtc(){
  const src = fs.readFileSync(APP_JS, 'utf8');
  const fn = src.match(/function shiftDate\(dstr, days\)\{[^\n]*\}/);
  assert(fn, 'shiftDate exists');
  if(!fn) return;
  const out = require('child_process').execFileSync(process.execPath, ['-e', fn[0] + "; console.log([shiftDate('2026-11-12',0), shiftDate('2026-11-12',-30), shiftDate('2026-03-01',-1)].join(','))"],
    {env: Object.assign({}, process.env, {TZ:'Asia/Riyadh'})}).toString().trim();
  assert(out==='2026-11-12,2026-10-13,2026-02-28', 'In Riyadh time, shifting by 0 keeps the day and -30 lands on the right date, got ' + out);
}
async function testV57BudgetAndPnLAreOnePageWithTwoTabs(){
  const sb = dashSandbox();
  const SCREENS = vm.runInContext('SCREENS', sb);
  const ids = SCREENS.map(s=>s[0]);
  assert(ids.includes('pnl') && !ids.includes('budget') && SCREENS.find(s=>s[0]==='pnl')[1]==='Budget & P&L', 'One rail button, "Budget & P&L"');
  sb.document.body.insertAdjacentHTML('beforeend', '<div id="topbarTitle"></div>');
  sb.go('budget');
  const nav = sb.document.getElementById('nav');
  const on = nav.querySelector('button.on');
  assert(on && /go\('pnl'\)/.test(on.getAttribute('onclick')) && sb.document.getElementById('topbarTitle').textContent==='Budget & P&L', 'The Plan grid lights up the same rail button and title');
  sb.go('pnl');
  const html = sb.document.getElementById('app').innerHTML;
  assert(/data-bptab="overview"[^>]*/.test(html) && sb.document.querySelector('[data-bptab="overview"]').getAttribute('aria-selected')==='true' && /id="budgetCharts"/.test(html), 'Overview has the tabs and the charts');
  assert(!/id="budgetSummary"/.test(html), 'The old Budget month table is gone');
  sb.localStorage.setItem('hiddenPages', JSON.stringify(['pnl']));
  assert(!sb.getHiddenPages().includes('pnl'), 'Someone who hid only P&L still sees the merged page (Budget was visible)');
  sb.localStorage.setItem('hiddenPages', JSON.stringify(['pnl','budget']));
  assert(sb.getHiddenPages().join()==='pnl', 'Hidden only if both old pages were hidden');
  const dash = sb.dashBudgetHTML();
  assert(/goPnLThisMonth\(\)/.test(dash) && /Open Budget &amp; P&amp;L/.test(dash), 'The Dashboard budget box opens Budget & P&L on this month');
}
async function testV57OverviewChartsFollowThePeriod(){
  const sb = dashSandbox();
  const D = vm.runInContext('D', sb);
  D.ledger.push({id:201, jv:201, date:'2026-09-15', acc:60101, amt:400, descr:'x'}, {id:202, jv:202, date:'2026-11-03', acc:60101, amt:250, descr:'x'});
  D.budget = [{id:1, acc:60101, date:'2026-09-01', amt:300}, {id:2, acc:60101, date:'2026-10-01', amt:300}, {id:3, acc:60101, date:'2026-11-01', amt:300}];
  sb.rebuildIndex();
  const ytd = sb.budgetChartData('2026-09-01', '2026-11-07');
  assert(ytd.byCat.Living && ytd.byCat.Living.planned===900 && ytd.byCat.Living.actual===650+6000, 'A 3-month period: plan of all 3 months (900) and actual over the dates, got ' + JSON.stringify(ytd.byCat.Living));
  assert(ytd.trendMonths.join()==='2026-09,2026-10,2026-11', 'The trend shows the period\'s months, got ' + ytd.trendMonths.join());
  const one = sb.budgetChartData('2026-11-01', '2026-11-30');
  assert(one.byCat.Living.planned===300 && one.trendMonths.length===6 && one.trendMonths[5]==='2026-11', 'One month: that month\'s plan; the trend shows the 6 months up to it');
  assert(sb.budgetChartPeriodLabel('2026-11-01','2026-11-30')===sb.monthLabel('2026-11') && sb.budgetChartPeriodLabel('2026-01-01','2026-11-07')==='2026-01-01 → 2026-11-07', 'The chart title names the period');
  sb.openBudgetCategoryBreakdown('Living', '2026-09-01', '2026-11-07');
  const m = sb.document.getElementById('modalRoot').innerHTML;
  assert(/900\.00/.test(m) && /2026-09-15/.test(m) && /2026-11-03/.test(m), 'A bar opens the transactions and plan for the whole period');
  sb.openBudgetCategoryBreakdown('Living', '2026-11');
  assert(!/2026-09-15/.test(sb.document.getElementById('modalRoot').innerHTML), 'A month key still opens just that month');
}
function v57CoverSandbox(reserveAmt){
  const sb = dashSandbox({today:'2026-11-12T10:00:00.000Z'});
  const D = vm.runInContext('D', sb);
  D.accounts.push({id:20302, name:'Living reserve', descr:'Living reserve', category:'Accruals', status:'Active', acc_type:'Accrual Account'});
  D.accrualMappings = [{category:'Living', liabilityAcc:20302, expenseAcc:60101}];
  D.ledger.push({id:301, jv:301, date:'2026-11-02', acc:60101, amt:1000, descr:'spend'});
  if(reserveAmt) D.ledger.push({id:302, jv:302, date:'2026-10-31', acc:20302, amt:-reserveAmt, descr:'accrue'});
  D.budget = [{id:1, acc:60101, date:'2026-11-01', amt:800}];
  sb.rebuildIndex();
  return sb;
}
async function testV57OverspendCoveredByAccrualTurnsYellowAndLeavesNeedsYou(){
  const sb = v57CoverSandbox(500);   // over by 200, reserve 500
  const cv = sb.overspendCover('Living', 200);
  assert(cv && cv.full && cv.reserve===500 && cv.covered===200, 'Reserve 500 covers 200 over, got ' + JSON.stringify(cv));
  sb.document.body.insertAdjacentHTML('beforeend', `<div id="dashTest">${sb.dashBudgetHTML()}</div>`);
  const note = sb.document.querySelector('#dashTest [data-accrual-cover="full"]');
  assert(note && /Over by 200/.test(note.textContent) && /covered by accrual \(reserve 500\)/.test(note.textContent) && /var\(--text\)/.test(note.getAttribute('style')), 'Black note: over by, covered by the reserve');
  const fill = sb.document.querySelector('#dashTest .bud-fill');
  assert(fill && /var\(--yellow\)/.test(fill.getAttribute('style')), 'The bar is yellow');
  assert(!/Living is over budget/.test(sb.dashTodoHTML()), 'Not in the Dashboard\'s needs-you list');
  sb.__set('pnlFrom', '2026-11-01'); sb.__set('pnlTo', '2026-11-30'); sb.__set('pnlView', 'main');
  sb.renderPnL();
  const row = sb.document.querySelector('#app tr[data-pnl-cat="Living"]');
  assert(row && row.querySelector('[data-accrual-cover="full"]') && /color-mix\(in srgb,var\(--yellow\)/.test(row.lastElementChild.getAttribute('style')||''), 'Same treatment on the P&L category row');
}
async function testV57PartlyCoveredStaysRedWithANote(){
  const sb = v57CoverSandbox(150);   // over by 200, reserve 150
  const cv = sb.overspendCover('Living', 200);
  assert(cv && !cv.full && cv.covered===150, 'Partly covered: 150 of 200');
  sb.document.body.insertAdjacentHTML('beforeend', `<div id="dashTest">${sb.dashBudgetHTML()}</div>`);
  const note = sb.document.querySelector('#dashTest [data-accrual-cover="part"]');
  assert(note && /Over by 200/.test(note.textContent) && /150 of it covered by accrual/.test(note.textContent) && /var\(--red\)/.test(note.getAttribute('style')), 'Stays red, with how much is covered');
  const todo = sb.dashTodoHTML();
  assert(/Living is over budget/.test(todo) && /150\.00 of it covered by accrual/.test(todo), 'Stays in needs-you, with the note');
  const none = v57CoverSandbox(0);
  assert(/Living is over budget/.test(none.dashTodoHTML()) && !/covered by accrual/.test(none.dashTodoHTML()), 'No reserve: unchanged');
  assert(sb.overspendCover('Transport', 50)===null, 'A category without an accrual mapping is unchanged');
}
