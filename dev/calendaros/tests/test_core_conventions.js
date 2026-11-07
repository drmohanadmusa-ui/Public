/* Core conventions (added at the move to Claude Code, 2026-11).
   Guards standing rules that had no direct test:
   1. A failed Supabase read must THROW, never return partial data (partial data looks like deletions).
   2. Weekend location rules are display-only: they never rewrite a task's stored location.
   3. Shared browser storage: CalendarOS only touches localStorage keys with its own cos_ prefix
      and never clears the whole store (LedgerOS lives on the same web address).
   4. The newest CHANGELOG entry matches APP_VERSION (read from the app, never hardcoded).
   All data here is invented. */
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? ' — ' + detail : ''}`); }
}
function syncedApp(fetchHandler) {
  const win = loadApp({ fetchHandler });
  win.__t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
  return win;
}
async function throwsWith(fn) {
  try { await fn(); return null; } catch (e) { return String(e && e.message || e); }
}

(async () => {
  // ---- 1. Supabase reads
  {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const win = syncedApp(() => ({ status: 200, rows, total: 3 }));
    const err = await throwsWith(() => win.supaSelectAll('lists'));
    check('read: a complete read succeeds (control case)', err === null, err);
    const got = err === null ? await win.supaSelectAll('lists') : [];
    check('read: a complete read returns every row', Array.isArray(got) && got.length === 3, got && got.length);
  }
  {
    const win = syncedApp(() => ({ status: 500, rows: [] }));
    const err = await throwsWith(() => win.supaSelectAll('lists'));
    check('read: HTTP 500 throws', err !== null && /select failed/.test(err), err);
  }
  {
    const win = syncedApp(() => ({ status: 401, rows: [] }));
    const err = await throwsWith(() => win.supaSelectAll('training_sets'));
    check('read: HTTP 401 throws', err !== null, err);
  }
  {
    // Server reports 5 rows but only 3 arrive: silent truncation must throw.
    const win = syncedApp(() => ({ status: 200, rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], total: 5 }));
    const err = await throwsWith(() => win.supaSelectAll('recurring_tasks'));
    check('read: a short read (3 of 5) throws', err !== null, err);
  }
  {
    const win = syncedApp(() => ({ status: 200, rows: { message: 'not a list' }, total: 0 }));
    const err = await throwsWith(() => win.supaSelectAll('lists'));
    check('read: a non-array payload throws', err !== null, err);
  }

  // ---- 2. Weekend location rules are display-only
  {
    const win = loadApp();
    const t = win.__t;
    t.state.settings.weekendDays = ['Fri', 'Sat'];
    t.state.settings.locationDayRules = [{ id: 'r1', from: 'Site A', to: 'Site B' }];
    const task = { id: 'x1', name: 'AlphaTask', location: 'Site A', silo: 'Alpha', priority: 'Medium', due: '2026-01-02', done: false };
    t.state.tasks.oneTime = [task];
    let weekend = null, weekday = null;
    for (let i = 0; i < 7; i++) {
      const d = win.addDays('2026-01-05', i);
      if (win.isWeekendDate(d)) { weekend = weekend || d; } else { weekday = weekday || d; }
    }
    check('location: test found a weekend and a weekday date', !!weekend && !!weekday, `${weekend} ${weekday}`);
    const before = JSON.stringify(t.state.tasks);
    check('location: shown under the rule target on a weekend', win.taskLocationFor(task, weekend) === 'Site B', win.taskLocationFor(task, weekend));
    check('location: shown under its own location on a weekday', win.taskLocationFor(task, weekday) === 'Site A', win.taskLocationFor(task, weekday));
    check('location: remap is flagged so it is visible', win.isLocationRemapped(task, weekend) === true);
    check('location: stored location is unchanged after resolving', task.location === 'Site A', task.location);
    check('location: stored task data is byte-identical after resolving', JSON.stringify(t.state.tasks) === before);
  }

  // ---- 3. Shared browser storage (source level: the shim is not installed under the harness)
  {
    const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
    check('storage: never calls localStorage.clear()', !/localStorage\s*\.\s*clear\s*\(/.test(js));
    check('storage: never calls sessionStorage.clear()', !/sessionStorage\s*\.\s*clear\s*\(/.test(js));
    const removes = js.match(/localStorage\s*\.\s*removeItem\s*\(([^)]*)\)/g) || [];
    check('storage: at least one removeItem call found (control case)', removes.length >= 1, removes.length);
    const badRemoves = removes.filter(c => !/removeItem\s*\(\s*'cos_'\s*\+/.test(c));
    check('storage: every localStorage.removeItem uses the cos_ prefix', badRemoves.length === 0, badRemoves.join(' | '));
    const sets = js.match(/localStorage\s*\.\s*setItem\s*\(([^,)]*)/g) || [];
    const badSets = sets.filter(c => !/setItem\s*\(\s*'cos_'\s*\+/.test(c));
    check('storage: every localStorage.setItem uses the cos_ prefix', sets.length >= 1 && badSets.length === 0, badSets.join(' | '));
    check('storage: no bracket or property writes to localStorage', !/localStorage\s*\[[^\]]+\]\s*=(?!=)/.test(js) && !/localStorage\.(?!getItem|setItem|removeItem|key|length|clear)\w+\s*=(?!=)/.test(js));
    check('storage: no IndexedDB deleteDatabase call', !/deleteDatabase\s*\(/.test(js));
  }

  // ---- 4. Version and changelog agree (no version number hardcoded here)
  {
    const win = loadApp();
    const t = win.__t;
    check('version: APP_VERSION is semver', /^\d+\.\d+\.\d+$/.test(t.APP_VERSION), t.APP_VERSION);
    check('version: newest CHANGELOG entry matches APP_VERSION', t.CHANGELOG[0] && t.CHANGELOG[0].v === t.APP_VERSION,
      `${t.CHANGELOG[0] && t.CHANGELOG[0].v} vs ${t.APP_VERSION}`);
    const first = t.CHANGELOG[0] && t.CHANGELOG[0].changes && t.CHANGELOG[0].changes[0];
    check('version: newest entry starts with the SQL status line', typeof first === 'string' && /SQL migration/.test(first), first);
    const html = fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8');
    check('version: the built file carries the same APP_VERSION', html.includes(`const APP_VERSION = '${t.APP_VERSION}'`));
  }

  console.log(`\ntest_core_conventions: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed:', e && e.stack || e); console.log(`\ntest_core_conventions: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
