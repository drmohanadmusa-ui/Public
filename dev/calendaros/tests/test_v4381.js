/* v4.38.1 — the All Tasks search crash.

   matchesFilters(item, dateStr) was passed point-free to .filter(), so the
   array index arrived where the date belonged. Reproduces the exact conditions:
   a weekend location rule exists, the page is searching or location-filtering,
   and there is more than one task. */
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }

function appWithRules(ruleCount = 1) {
  const win = loadApp();
  const t = win.__t;
  t.state.settings.locations = ['Site A', 'Site B'];
  t.state.settings.silos = ['Alpha', 'Beta'];
  t.state.settings.weekendDays = ['Fri', 'Sat'];
  t.state.settings.locationDayRules = ruleCount ? [{ from: 'Site A', to: 'Site B' }] : [];
  // More than one task: index 0 is falsy and returned early, so a single task
  // never triggered it. The second task is what breaks.
  t.state.tasks.oneTime = [
    { id: 'T1', name: 'Pay invoice', location: 'Site A', silo: 'Alpha', priority: 'High', due: '2026-09-04', done: false, doneDate: null, notes: '', dueHistory: [] },
    { id: 'T2', name: 'Send invoice reminder', location: 'Site A', silo: 'Alpha', priority: 'Medium', due: '2026-09-05', done: false, doneDate: null, notes: '', dueHistory: [] },
    { id: 'T3', name: 'Unrelated errand', location: 'Site B', silo: 'Beta', priority: 'Low', due: '2026-09-06', done: false, doneDate: null, notes: '', dueHistory: [] },
  ];
  t.state.tasks.recurring = [
    { id: 'R1', name: 'Weekly invoice report', detail: 'Weekly on Mon', location: 'Site A', silo: 'Alpha', priority: 'High', notes: '', rescheduleExceptions: [], start: '2026-01-05' },
    { id: 'R2', name: 'Water the plants', detail: 'Every 3 days', location: 'Site B', silo: 'Beta', priority: 'Low', notes: '', rescheduleExceptions: [], start: '2026-01-05' },
  ];
  t.state.view = 'tasks';
  t.state.tasksTab = 'oneTime';
  win.document.getElementById('app').classList.remove('hidden');
  return win;
}

// render() catches errors and swaps in the "This page hit a snag" panel, so a
// thrown error shows up as that panel rather than as an exception here.
function renderedSnag(win) {
  win.render();
  return win.document.getElementById('app').innerHTML.includes('hit a snag');
}

/* ---------- 1. The crash ---------- */
function searchDoesNotCrash() {
  section('1. Searching All Tasks with a weekend location rule set');
  const win = appWithRules();
  check('renders without a search term', !renderedSnag(win));
  win.__t.state.searchQuery = 'invoice';
  check('renders WITH a search term', !renderedSnag(win));
  win.__t.state.tasksTab = 'recurring';
  check('the recurring tab renders while searching', !renderedSnag(win));
}

/* ---------- 2. The same bug via the location filter ---------- */
function locationFilterDoesNotCrash() {
  section('2. Filtering by location — the same call, the same crash');
  const win = appWithRules();
  win.__t.state.searchQuery = '';
  win.__t.state.locationFilter = 'Site A';
  check('renders when filtering by location', !renderedSnag(win));
  win.__t.state.tasksTab = 'recurring';
  check('the recurring tab renders when filtering', !renderedSnag(win));
}

/* ---------- 3. The results are still correct ---------- */
function searchStillFilters() {
  section('3. Search still returns the right tasks');
  const win = appWithRules();
  const t = win.__t;
  t.state.searchQuery = 'invoice';
  t.state.tasksTab = 'oneTime';
  win.render();
  const html = win.document.getElementById('app').innerHTML;
  check('matching task is shown', html.includes('Pay invoice'));
  check('second matching task is shown', html.includes('Send invoice reminder'));
  check('non-matching task is hidden', !html.includes('Unrelated errand'));

  t.state.tasksTab = 'recurring';
  win.render();
  const html2 = win.document.getElementById('app').innerHTML;
  check('matching recurring task is shown', html2.includes('Weekly invoice report'));
  check('non-matching recurring task is hidden', !html2.includes('Water the plants'));
}

/* ---------- 4. matchesFilters gets a real date ---------- */
function filterReceivesADate() {
  section('4. The filter is handed a date, never an index');
  const win = appWithRules();
  const t = win.__t;
  const seen = [];
  const orig = win.matchesFilters;
  win.matchesFilters = function (item, dateStr) { seen.push(dateStr); return orig(item, dateStr); };
  t.state.searchQuery = 'invoice';
  t.state.tasksTab = 'oneTime';
  win.render();
  check('every call received a string', seen.length > 0 && seen.every(v => typeof v === 'string'),
        JSON.stringify(seen));
  check('no call received a number', !seen.some(v => typeof v === 'number'), JSON.stringify(seen));
  check('one-time tasks are resolved against their own due date',
        seen.includes('2026-09-04') && seen.includes('2026-09-05'), JSON.stringify(seen));
}

/* ---------- 5. No rules configured — the pre-existing safe case ---------- */
function noRulesStillFine() {
  section('5. With no weekend rules configured (how this stayed hidden)');
  const win = appWithRules(0);
  win.__t.state.searchQuery = 'invoice';
  check('renders fine', !renderedSnag(win));
}

/* ---------- 6. parseDate hardening ---------- */
function parseDateHardening() {
  section('6. The date parser fails visibly rather than fatally');
  const win = loadApp();
  // Wrapped, so removing the hardening reports a clean FAIL rather than
  // killing the whole suite with an uncaught throw — which is exactly what
  // happened the first time this break was tested.
  const safeParse = v => { try { return win.parseDate(v); } catch (e) { return `THREW: ${e.message}`; } };
  check('a number returns null instead of throwing', safeParse(1) === null, String(safeParse(1)));
  check('an object returns null instead of throwing', safeParse({}) === null, String(safeParse({})));
  check('an array returns null instead of throwing', safeParse([2026, 9, 1]) === null, String(safeParse([2026, 9, 1])));
  check('a real date string still parses',
        win.parseDate('2026-09-04') instanceof win.Date &&
        win.parseDate('2026-09-04').getFullYear() === 2026);
  check('empty input still returns null', win.parseDate('') === null && win.parseDate(null) === null);
  check('the misuse is recorded in the error log',
        win.__t.diagLog.some(e => /non-string/.test(e.message || '')),
        JSON.stringify(win.__t.diagLog.slice(-3)));
  let weekendOk;
  try { weekendOk = win.isWeekendDate(1) === false; } catch (e) { weekendOk = false; }
  check('isWeekendDate survives a bad argument', weekendOk);
}

/* ---------- 7. The class of bug, across the whole file ---------- */
function noPointFreeMultiArgCallbacks() {
  section('7. No multi-argument function is passed point-free to an iterator');
  const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const arity = {};
  for (const m of src.matchAll(/^(?:async )?function\s+(\w+)\s*\(([^)]*)\)/gm)) {
    arity[m[1]] = m[2].trim() ? m[2].split(',').length : 0;
  }
  const risky = [];
  for (const m of src.matchAll(/\.(filter|map|forEach|some|every|find|findIndex|flatMap)\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    if (arity[m[2]] >= 2) {
      risky.push(`line ${src.slice(0, m.index).split('\n').length}: .${m[1]}(${m[2]})`);
    }
  }
  check('none found anywhere in the app', risky.length === 0, risky.join('; '));
}

/* ---------- 8. Version discipline ---------- */
function versionDiscipline() {
  section('8. Version and changelog');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const v = /const APP_VERSION = '([\d.]+)'/.exec(js)[1];
  check('the changelog leads with the shipped version',
        new RegExp(`const CHANGELOG = \\[\\s*\\{ v:'${v.replace(/\./g, '\\.')}'`).test(js), v);
  check('the built file carries the same version',
        fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8').includes(`const APP_VERSION = '${v}'`));
}

searchDoesNotCrash();
locationFilterDoesNotCrash();
searchStillFilters();
filterReceivesADate();
noRulesStillFine();
parseDateHardening();
noPointFreeMultiArgCallbacks();
versionDiscipline();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
