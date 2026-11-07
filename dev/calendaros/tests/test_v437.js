/* v4.37.0 — per-domain dirty tracking.

   The defect being closed: a startup with the global dirty flag set pushed the
   ENTIRE local state with no pull and no comparison, so a stale phone reverted
   work done on the desktop. See test_crossdevice.js for the proof of the old
   behaviour; this suite proves the new one. */
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* See the note in test_v436.js: poll for the condition rather than betting on
   a fixed duration, so a loaded machine cannot produce a random failure. */
async function waitFor(fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

function configured(win) {
  win.__t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
  // The harness starts from a fresh install, where ensureCoreMetricDefs() does
  // a legitimate one-time seed and writes settings. That is correct behaviour,
  // but it is first-run noise: these scenarios are about an established device
  // that has been in use for months.
  win.__t.state.settings.healthCoreMetricsSeeded = true;
}
function seedTask(win, done) {
  win.__t.state.tasks.oneTime = [{
    id: 'T1', name: 'Pay invoice', location: 'Site A', silo: 'Alpha',
    priority: 'High', due: '2026-09-01', done: !!done, doneDate: null, notes: '', dueHistory: [],
  }];
}
const posts = win => win.__calls.filter(c => c.method === 'POST');
const gets = win => win.__calls.filter(c => c.method === 'GET');
const postedTables = win => posts(win).map(c => c.url.split('/rest/v1/')[1].split('?')[0]);

/* ---------- 1. The original defect is closed ---------- */
async function trainingFailureNoLongerTouchesTasks() {
  section('1. A training-only failure no longer re-pushes tasks');
  // The server holds the DESKTOP's version: the task is done. The phone holds
  // a day-old copy saying it isn't. A populated server also means the pull
  // takes its normal path rather than seeding an empty project from local.
  const serverTask = {
    id: 'T1', pin: '1234', name: 'Pay invoice', location: 'Site A', silo: 'Alpha',
    priority: 'High', due: '2026-09-01', done: true, done_date: '2026-09-01',
    notes: '', due_history: [],
  };
  const win = loadApp({
    fetchHandler: (url, method) => {
      if (method === 'GET' && url.includes('/one_time_tasks')) return { status: 200, rows: [serverTask] };
      return { status: 200, rows: [] };
    },
  });
  const t = win.__t;
  configured(win);
  seedTask(win, false);
  // Only training is outstanding — exactly what a failed gym sync leaves behind.
  t.state.syncMeta.dirtyDomains = ['training'];
  t.state.syncMeta.dirty = true;
  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];
  t.state.training.logs = [{ date: '2026-09-01', exerciseId: 'E1', completed: true, sets: 3, reps: '10', weight: 40 }];

  await win.runBackgroundSync();
  const tables = postedTables(win);

  check('training IS pushed', tables.includes('training_logs'), tables.join(','));
  check('one_time_tasks is NOT pushed', !tables.includes('one_time_tasks'), tables.join(','));
  check('lists are NOT pushed', !tables.includes('lists'), tables.join(','));
  check('app_settings is NOT pushed', !tables.includes('app_settings'), tables.join(','));
  check('the stale done=false never leaves the device',
        !JSON.stringify(posts(win).map(c => c.body)).includes('"Pay invoice"'));
  // The point of the whole exercise: the desktop's work survives, and the
  // phone ends the launch agreeing with it.
  check("the desktop's completion survives on the device",
        t.state.tasks.oneTime[0] && t.state.tasks.oneTime[0].done === true,
        JSON.stringify(t.state.tasks.oneTime[0]));
}

/* ---------- 2. Push then pull ---------- */
async function pushThenPull() {
  section('2. A dirty startup pushes, then pulls');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const t = win.__t;
  configured(win);
  t.state.syncMeta.dirtyDomains = ['training'];
  t.state.syncMeta.dirty = true;
  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];

  await win.runBackgroundSync();
  const firstPost = win.__calls.findIndex(c => c.method === 'POST');
  const firstGet = win.__calls.findIndex(c => c.method === 'GET');
  check('a push happens', firstPost >= 0);
  check('a pull happens too', firstGet >= 0);
  check('the push comes BEFORE the pull', firstPost < firstGet, `push@${firstPost} get@${firstGet}`);
  check('the device ends clean', t.state.syncMeta.dirty === false && t.state.syncMeta.dirtyDomains.length === 0,
        JSON.stringify(t.state.syncMeta.dirtyDomains));
}

/* ---------- 3. A failed push suppresses the pull ---------- */
async function failedPushSkipsPull() {
  section('3. If a push fails, the pull is skipped and local data is left alone');
  const win = loadApp({
    fetchHandler: (url, method) =>
      (method === 'POST' && url.includes('/training_')) ? { status: 500, rows: [] } : { status: 200, rows: [] },
  });
  const t = win.__t;
  configured(win);
  t.state.syncMeta.dirtyDomains = ['training'];
  t.state.syncMeta.dirty = true;
  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];
  t.state.training.logs = [{ date: '2026-09-01', exerciseId: 'E1', completed: true, weight: 40 }];

  await win.runBackgroundSync();
  check('no pull was performed', gets(win).length === 0, `${gets(win).length} GETs`);
  check('training stays dirty', t.state.syncMeta.dirtyDomains.includes('training'),
        JSON.stringify(t.state.syncMeta.dirtyDomains));
  check('the unsynced log is still in local state', t.state.training.logs.length === 1);
}

/* ---------- 4. Cross-clearing bug ---------- */
async function noCrossClearing() {
  section('4. A success in one area does not clear another area\'s failure');
  const win = loadApp({
    fetchHandler: (url, method) =>
      (method === 'POST' && url.includes('/one_time_tasks')) ? { status: 500, rows: [] } : { status: 200, rows: [] },
  });
  const t = win.__t;
  configured(win);
  seedTask(win, true);
  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];

  await win.saveTasks();        // fails
  await waitFor(() => t.state.syncMeta.dirtyDomains.includes('tasks'));
  check('tasks are dirty after the failure', t.state.syncMeta.dirtyDomains.includes('tasks'),
        JSON.stringify(t.state.syncMeta.dirtyDomains));

  await win.saveTraining();     // succeeds
  await waitFor(() => !win.__t.syncScheduled.training);
  check('training is clean after succeeding', !t.state.syncMeta.dirtyDomains.includes('training'),
        JSON.stringify(t.state.syncMeta.dirtyDomains));
  check('tasks are STILL dirty — the failure was not forgotten',
        t.state.syncMeta.dirtyDomains.includes('tasks'), JSON.stringify(t.state.syncMeta.dirtyDomains));
  check('the derived boolean still reports unsynced work', t.state.syncMeta.dirty === true);
}

/* ---------- 5. Migration, both directions ---------- */
async function migration() {
  section('5. Upgrade is safe in both directions');

  const legacy = loadApp();
  legacy.__store.set('dispatch:syncmeta', JSON.stringify({ status: 'error', dirty: true, lastSyncedAt: null, lastError: 'boom' }));
  await legacy.loadAll();
  check('a legacy dirty flag becomes ALL domains',
        legacy.__t.state.syncMeta.dirtyDomains.length === legacy.__t.state.syncMeta.dirtyDomains.length &&
        legacy.__t.state.syncMeta.dirtyDomains.includes('tasks') &&
        legacy.__t.state.syncMeta.dirtyDomains.includes('training') &&
        legacy.__t.state.syncMeta.dirtyDomains.includes('hydration'),
        JSON.stringify(legacy.__t.state.syncMeta.dirtyDomains));
  check('a legacy dirty flag keeps dirty = true', legacy.__t.state.syncMeta.dirty === true);

  const legacyClean = loadApp();
  legacyClean.__store.set('dispatch:syncmeta', JSON.stringify({ status: 'synced', dirty: false }));
  await legacyClean.loadAll();
  check('a legacy clean flag stays clean',
        legacyClean.__t.state.syncMeta.dirtyDomains.length === 0 && legacyClean.__t.state.syncMeta.dirty === false);

  // Forward compat: an older cached build reads `dirty` directly, so it must
  // still be present and correct in whatever we persist.
  const win = loadApp({ fetchHandler: (url, method) =>
    (method === 'POST' && url.includes('/one_time_tasks')) ? { status: 500, rows: [] } : { status: 200, rows: [] } });
  configured(win);
  seedTask(win, true);
  await win.saveTasks();
  await waitFor(() => {
    const raw = win.__store.get('dispatch:syncmeta');
    return raw && JSON.parse(raw).dirty === true;
  });
  const persisted = JSON.parse(win.__store.get('dispatch:syncmeta'));
  check('the persisted shape still carries the plain dirty boolean',
        persisted.dirty === true, JSON.stringify(persisted));
  check('the persisted shape also carries the domain detail',
        Array.isArray(persisted.dirtyDomains) && persisted.dirtyDomains.includes('tasks'),
        JSON.stringify(persisted.dirtyDomains));

  const unknown = loadApp();
  unknown.__store.set('dispatch:syncmeta', JSON.stringify({ dirty: true, dirtyDomains: ['tasks', 'nonsense'] }));
  await unknown.loadAll();
  check('unknown domain names are dropped',
        !unknown.__t.state.syncMeta.dirtyDomains.includes('nonsense'),
        JSON.stringify(unknown.__t.state.syncMeta.dirtyDomains));
}

/* ---------- 6. Unattributed errors do not widen ---------- */
async function errorsDoNotWiden() {
  section('6. An unattributed error does not re-mark everything dirty');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const t = win.__t;
  configured(win);
  t.state.syncMeta.dirtyDomains = ['training'];
  t.state.syncMeta.dirty = true;
  await win.markSyncError('something went wrong somewhere');
  check('the dirty set is unchanged',
        t.state.syncMeta.dirtyDomains.length === 1 && t.state.syncMeta.dirtyDomains[0] === 'training',
        JSON.stringify(t.state.syncMeta.dirtyDomains));
}

/* ---------- 7. Domains are independent ---------- */
async function domainsIndependent() {
  section('7. One area failing does not stop the others');
  const win = loadApp({
    fetchHandler: (url, method) =>
      (method === 'POST' && url.includes('/one_time_tasks')) ? { status: 500, rows: [] } : { status: 200, rows: [] },
  });
  const t = win.__t;
  configured(win);
  seedTask(win, true);
  t.state.lists = [{ id: 'L1', title: 'Shopping', folder: null, items: [{ id: 'I1', text: 'Milk', done: false }] }];
  t.state.syncMeta.dirtyDomains = ['tasks', 'lists'];
  t.state.syncMeta.dirty = true;

  await win.runBackgroundSync();
  const tables = postedTables(win);
  check('lists were pushed despite the tasks failure', tables.includes('lists'), tables.join(','));
  check('tasks stay dirty', t.state.syncMeta.dirtyDomains.includes('tasks'),
        JSON.stringify(t.state.syncMeta.dirtyDomains));
  check('lists are now clean', !t.state.syncMeta.dirtyDomains.includes('lists'),
        JSON.stringify(t.state.syncMeta.dirtyDomains));
}

/* ---------- 8. Manual retry still reports failure ---------- */
async function manualRetryStillThrows() {
  section('8. The full push still throws, so manual sync cannot report a false success');
  const win = loadApp({
    fetchHandler: (url, method) =>
      (method === 'POST' && url.includes('/one_time_tasks')) ? { status: 500, rows: [] } : { status: 200, rows: [] },
  });
  configured(win);
  seedTask(win, true);
  let threw = false;
  try { await win.pushFullStateToSupabase(); } catch (e) { threw = true; }
  check('pushFullStateToSupabase throws when a domain fails', threw);

  const ok = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  configured(ok);
  seedTask(ok, true);
  let threw2 = false;
  try { await ok.pushFullStateToSupabase(); } catch (e) { threw2 = true; }
  check('and does not throw when everything succeeds', !threw2);
}

/* ---------- 9. Coverage of the domain map ---------- */
function domainMapComplete() {
  section('9. Every synced table is reachable from some domain');
  const win = loadApp();
  const t = win.__t;
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const start = js.indexOf('function syncStepsForDomain(domain){');
  const end = js.indexOf('async function pushDomainsToSupabase');
  const body = js.slice(start, end);
  const covered = [...body.matchAll(/supaUpsert\('([a-z_]+)'/g)].map(m => m[1]);
  const missing = t.SYNCED_TABLES.filter(x => !covered.includes(x));
  check('no synced table is unreachable from the domain map', missing.length === 0, missing.join(','));
  check('training_resources is now in the full push', covered.includes('training_resources'));
  check('backup coverage is still complete',
        t.SYNCED_TABLES.every(x => t.BACKED_UP_TABLES.includes(x)));
}

/* ---------- 10. Version discipline ---------- */
function versionDiscipline() {
  section('10. Version and changelog');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const v = /const APP_VERSION = '([\d.]+)'/.exec(js)[1];
  check('the changelog leads with the shipped version',
        new RegExp(`const CHANGELOG = \\[\\s*\\{ v:'${v.replace(/\./g, '\\.')}'`).test(js), v);
  check('the built file carries the same version',
        fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8').includes(`const APP_VERSION = '${v}'`));
  const entry = js.slice(js.indexOf('const CHANGELOG'), js.indexOf("{ v:'4.36.0'"));
  check('the entry states no SQL migration is needed', /No SQL migration needed/.test(entry));
}

(async () => {
  await trainingFailureNoLongerTouchesTasks();
  await pushThenPull();
  await failedPushSkipsPull();
  await noCrossClearing();
  await migration();
  await errorsDoNotWiden();
  await domainsIndependent();
  await manualRetryStillThrows();
  domainMapComplete();
  versionDiscipline();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
