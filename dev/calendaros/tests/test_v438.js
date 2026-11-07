/* v4.38.0 — reconcile tasks/lists instead of blind-pushing them.

   v4.37.0 stopped a training failure from dragging tasks up with it, but a
   dirty TASKS domain was still pushed with no comparison. Tasks and lists have
   divergence detection; it just never ran on the dirty path. Now it does.

   REWRITTEN in v4.44.0: the interactive "which copy do you want to keep?"
   modal is gone. The owner works across three devices daily, so a real
   difference between the local and online copy is the common case, not a
   rare exception — the modal fired on nearly every launch. Default behavior
   is now "online always wins": a divergence is still detected and logged,
   but resolved automatically and immediately in favor of what the pull just
   put in memory, no prompt, no waiting. The underlying per-item 'local'
   override still exists as an internal primitive (applyDivergenceChoices()
   with a choice explicitly set to 'local') in case a manual recovery screen
   is ever added — section 3 below tests that primitive directly, since
   nothing in the app currently drives it. */
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  win.__t.state.settings.healthCoreMetricsSeeded = true; // established install, not first run
}
const posts = win => win.__calls.filter(c => c.method === 'POST');
const postedTables = win => posts(win).map(c => c.url.split('/rest/v1/')[1].split('?')[0]);

// The desktop's version, on the server.
const remoteTaskRow = (over = {}) => Object.assign({
  id: 'T1', pin: '1234', name: 'Pay invoice', location: 'Site A', silo: 'Alpha',
  priority: 'High', due: '2026-09-01', done: true, done_date: '2026-09-01',
  notes: '', due_history: [],
}, over);
// This device's older copy.
const localTask = (over = {}) => Object.assign({
  id: 'T1', name: 'Pay invoice', location: 'Site A', silo: 'Alpha',
  priority: 'High', due: '2026-09-01', done: false, doneDate: null,
  notes: '', dueHistory: [],
}, over);

function serverWith(rows) {
  return (url, method) => {
    if (method !== 'GET') return { status: 200, rows: [] };
    for (const table of Object.keys(rows)) {
      if (url.includes('/' + table + '?')) return { status: 200, rows: rows[table] };
    }
    return { status: 200, rows: [] };
  };
}

/* ---------- 1. A dirty tasks domain is reconciled and auto-resolved online ---------- */
async function dirtyTasksAutoResolvesOnline() {
  section('1. Unsent task changes are reconciled, then auto-resolved to ONLINE — no prompt');
  const win = loadApp({ fetchHandler: serverWith({ one_time_tasks: [remoteTaskRow()] }) });
  const t = win.__t;
  configured(win);
  t.state.tasks.oneTime = [localTask({ done: false })];
  t.state.syncMeta.dirtyDomains = ['tasks'];
  t.state.syncMeta.dirty = true;

  await win.runBackgroundSync();

  check('a pull happened', win.__calls.some(c => c.method === 'GET'));
  check('one_time_tasks was NOT blind-pushed', !postedTables(win).includes('one_time_tasks'),
        postedTables(win).join(','));
  check('the divergence is fully resolved by the time runBackgroundSync returns — no pending prompt',
        t.pendingDivergence === null);
  check('tasks are settled immediately, not left dirty waiting on an answer',
        !t.state.syncMeta.dirtyDomains.includes('tasks'), JSON.stringify(t.state.syncMeta.dirtyDomains));
  check("the online copy won: local state now shows the desktop's completion",
        t.state.tasks.oneTime[0].done === true, JSON.stringify(t.state.tasks.oneTime[0]));
  const diagEntry = t.diagLog.find(e => e.message.includes('auto-resolved keeping ONLINE'));
  check('the resolution is logged for troubleshooting, naming the task domain',
        diagEntry && diagEntry.data && diagEntry.data.domains.includes('tasks'), JSON.stringify(diagEntry));
}

/* ---------- 2. Auto-resolution persists the online copy to disk ---------- */
async function autoResolvePersistsOnlineToDisk() {
  section('2. Auto-resolving to online replaces the pre-pull local copy on disk too');
  const win = loadApp({ fetchHandler: serverWith({ one_time_tasks: [remoteTaskRow()] }) });
  const t = win.__t;
  configured(win);
  t.state.tasks.oneTime = [localTask({ done: false })];
  // What was on disk before this launch: this device's stale local copy.
  win.__store.set('dispatch:tasks', JSON.stringify({ oneTime: [localTask({ done: false })], recurring: [] }));
  t.state.syncMeta.dirtyDomains = ['tasks'];
  t.state.syncMeta.dirty = true;

  await win.runBackgroundSync();
  await waitFor(() => !win.__t.state.syncMeta.dirtyDomains.includes('tasks'));

  const onDisk = JSON.parse(win.__store.get('dispatch:tasks'));
  check('disk now holds the ONLINE copy (auto-resolved, not left as the stale local one)',
        onDisk.oneTime[0].done === true, JSON.stringify(onDisk.oneTime[0]));
}

/* ---------- 3. The manual per-item 'local' override still functions if invoked directly ---------- */
async function manualLocalOverrideStillWorks() {
  section('3. The local-restore primitive still works if something calls it directly (no UI drives this today)');
  const win = loadApp({
    fetchHandler: serverWith({
      one_time_tasks: [remoteTaskRow()],
      training_exercises: [{ id: 'E1', pin: '1234', name: 'Chest Press', tags: [], video_urls: [] }],
      recipes: [{ id: 'RC1', pin: '1234', name: 'Chicken bowl', meal_type: 'lunch', base_servings: 2 }],
    }),
  });
  const t = win.__t;
  configured(win);
  t.state.tasks.oneTime = [localTask({ done: false, notes: 'chased twice' })];
  // pullFromSupabase() directly, NOT runBackgroundSync(): this is the
  // lower-level function that actually detects the divergence.
  // runBackgroundSync() is what now auto-applies it; bypassing that lets a
  // test (or a future manual-override UI) inspect and override the choice
  // before anything is applied.
  await win.pullFromSupabase();
  check('a divergence was detected and is inspectable', t.pendingDivergence !== null);
  const before = posts(win).length;
  if (t.pendingDivergence) {
    t.pendingDivergence.categories.tasks.items.forEach(i => { i.choice = 'local'; });
  }
  await win.applyDivergenceChoices();
  await waitFor(() => postedTables(win).slice(before).includes('one_time_tasks'));

  check('the local version is restored in state',
        t.state.tasks.oneTime[0].done === false && t.state.tasks.oneTime[0].notes === 'chased twice',
        JSON.stringify(t.state.tasks.oneTime[0]));
  const after = postedTables(win).slice(before);
  check('tasks are pushed', after.includes('one_time_tasks'), after.join(','));
  check('training is NOT pushed as a side effect', !after.some(x => x.startsWith('training_')), after.join(','));
  check('recipes are NOT pushed as a side effect', !after.includes('recipes'), after.join(','));
}

/* ---------- 4. No disagreement, no auto-resolution needed ---------- */
async function noDisagreementNothingToResolve() {
  section('4. When the copies agree, nothing is resolved and nothing is re-pushed');
  const win = loadApp({ fetchHandler: serverWith({ one_time_tasks: [remoteTaskRow({ done: false, done_date: null })] }) });
  const t = win.__t;
  configured(win);
  t.state.tasks.oneTime = [localTask({ done: false })];
  t.state.syncMeta.dirtyDomains = ['tasks'];
  t.state.syncMeta.dirty = true;

  await win.runBackgroundSync();
  check('nothing pending', t.pendingDivergence === null);
  check('tasks are marked settled', !t.state.syncMeta.dirtyDomains.includes('tasks'),
        JSON.stringify(t.state.syncMeta.dirtyDomains));
  check('identical rows are not rewritten', !postedTables(win).includes('one_time_tasks'),
        postedTables(win).join(','));
  check('the pull did persist, since there was nothing to resolve',
        !!win.__store.get('dispatch:tasks'));
}

/* ---------- 5. Mixed dirty set ---------- */
async function mixedDirtySet() {
  section('5. Mixed set: unguarded pushes first, guarded is auto-resolved online');
  const win = loadApp({ fetchHandler: serverWith({ one_time_tasks: [remoteTaskRow()] }) });
  const t = win.__t;
  configured(win);
  t.state.tasks.oneTime = [localTask({ done: false })];
  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];
  t.state.training.logs = [{ date: '2026-09-01', exerciseId: 'E1', completed: true, weight: 40 }];
  t.state.syncMeta.dirtyDomains = ['tasks', 'training'];
  t.state.syncMeta.dirty = true;

  await win.runBackgroundSync();
  const tables = postedTables(win);
  const firstGet = win.__calls.findIndex(c => c.method === 'GET');
  const firstTrainingPush = win.__calls.findIndex(c => c.method === 'POST' && c.url.includes('/training_'));

  check('training was pushed', tables.some(x => x.startsWith('training_')), tables.join(','));
  check('training was pushed BEFORE the pull', firstTrainingPush >= 0 && firstTrainingPush < firstGet,
        `push@${firstTrainingPush} get@${firstGet}`);
  check('tasks were not blind-pushed', !tables.includes('one_time_tasks'), tables.join(','));
  check('no prompt is left pending for tasks', t.pendingDivergence === null);
  check('training is settled', !t.state.syncMeta.dirtyDomains.includes('training'),
        JSON.stringify(t.state.syncMeta.dirtyDomains));
  check('tasks are ALSO settled — auto-resolved immediately, not left dirty pending an answer',
        !t.state.syncMeta.dirtyDomains.includes('tasks'), JSON.stringify(t.state.syncMeta.dirtyDomains));
}

/* ---------- 6. A failed unguarded push still suppresses the pull ---------- */
async function unguardedFailureStillBlocksPull() {
  section('6. A failed unguarded push still stops the pull');
  const win = loadApp({
    fetchHandler: (url, method) => {
      if (method === 'POST' && url.includes('/training_')) return { status: 500, rows: [] };
      if (method === 'GET' && url.includes('/one_time_tasks?')) return { status: 200, rows: [remoteTaskRow()] };
      return { status: 200, rows: [] };
    },
  });
  const t = win.__t;
  configured(win);
  t.state.tasks.oneTime = [localTask({ done: false })];
  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];
  t.state.syncMeta.dirtyDomains = ['tasks', 'training'];
  t.state.syncMeta.dirty = true;

  await win.runBackgroundSync();
  check('no pull was performed', !win.__calls.some(c => c.method === 'GET'));
  check('both domains stay dirty',
        t.state.syncMeta.dirtyDomains.includes('tasks') && t.state.syncMeta.dirtyDomains.includes('training'),
        JSON.stringify(t.state.syncMeta.dirtyDomains));
  check('the local task copy is untouched', t.state.tasks.oneTime[0].done === false);
}

/* ---------- 7. The widened field comparison (still detected, just auto-resolved) ---------- */
async function widenedFieldComparison() {
  section('7. Every pushed field is still compared, not just four — checked via pullFromSupabase() directly');
  const cases = [
    ['notes', { notes: 'server note' }, { notes: 'device note' }],
    ['priority', { priority: 'Low' }, { priority: 'High' }],
    ['location', { location: 'Site B' }, { location: 'Site A' }],
    ['silo', { silo: 'Beta' }, { silo: 'Alpha' }],
  ];
  for (const [field, remoteOver, localOver] of cases) {
    const win = loadApp({ fetchHandler: serverWith({ one_time_tasks: [remoteTaskRow(Object.assign({ done: false, done_date: null }, remoteOver))] }) });
    const t = win.__t;
    configured(win);
    t.state.tasks.oneTime = [localTask(Object.assign({ done: false }, localOver))];
    // Direct pullFromSupabase(), not runBackgroundSync(): this test wants to
    // inspect the raw diff, and runBackgroundSync() would auto-resolve (and
    // null out) pendingDivergence before we could look at it.
    await win.pullFromSupabase();
    const raised = t.pendingDivergence !== null;
    check(`a ${field} difference is detected`, raised);
    if (raised) {
      const diffs = t.pendingDivergence.categories.tasks.items[0].diffs;
      check(`the ${field} difference is named`, diffs.some(d => d.key === field), JSON.stringify(diffs));
    }
  }

  // Recurring tasks used to compare only their completion history.
  const win = loadApp({
    fetchHandler: serverWith({
      recurring_tasks: [{ id: 'R1', pin: '1234', name: 'Weekly report', detail: 'Mon', location: 'Site A', silo: 'Alpha', priority: 'High', notes: 'server note', reschedule_exceptions: [] }],
      one_time_tasks: [remoteTaskRow({ done: false, done_date: null })],
    }),
  });
  const t = win.__t;
  configured(win);
  t.state.tasks.oneTime = [localTask({ done: false })];
  t.state.tasks.recurring = [{ id: 'R1', name: 'Weekly report', detail: 'Mon', location: 'Site A', silo: 'Alpha', priority: 'High', notes: 'device note', rescheduleExceptions: [] }];
  await win.pullFromSupabase();
  check('a recurring-task note difference is detected', t.pendingDivergence !== null);
  if (t.pendingDivergence) {
    const rec = t.pendingDivergence.categories.tasks.items.find(i => i.kind === 'recurring');
    check('the recurring difference is named', rec && rec.diffs.some(d => d.key === 'notes'),
          JSON.stringify(rec && rec.diffs));
  }
}

/* ---------- 8. Clean start is unaffected ---------- */
async function cleanStartUnaffected() {
  section('8. A clean start still auto-resolves a genuine difference to online, with no dirty domains');
  const win = loadApp({ fetchHandler: serverWith({ one_time_tasks: [remoteTaskRow()] }) });
  const t = win.__t;
  configured(win);
  t.state.tasks.oneTime = [localTask({ done: false })];
  t.state.syncMeta.dirtyDomains = [];
  t.state.syncMeta.dirty = false;

  await win.runBackgroundSync();
  check('a pull happened', win.__calls.some(c => c.method === 'GET'));
  check('a genuine difference is still detected and resolved (not left pending)',
        t.pendingDivergence === null);
  check('the online value won', t.state.tasks.oneTime[0].done === true);
  check('the device ends clean', t.state.syncMeta.dirty === false,
        JSON.stringify(t.state.syncMeta.dirtyDomains));
}

/* ---------- 9. Version discipline ---------- */
function versionDiscipline() {
  section('9. Version and changelog');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const v = /const APP_VERSION = '([\d.]+)'/.exec(js)[1];
  check('the changelog leads with the shipped version',
        new RegExp(`const CHANGELOG = \\[\\s*\\{ v:'${v.replace(/\./g, '\\.')}'`).test(js), v);
  check('the built file carries the same version',
        fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8').includes(`const APP_VERSION = '${v}'`));
  const win = loadApp();
  check('backup coverage is still complete',
        win.__t.SYNCED_TABLES.every(x => win.__t.BACKED_UP_TABLES.includes(x)));
  check('no leftover reference to the removed divergence modal',
        !js.includes('maybeShowDivergenceModal') && !js.includes('divergenceOverlay'));
}

(async () => {
  await dirtyTasksAutoResolvesOnline();
  await autoResolvePersistsOnlineToDisk();
  await manualLocalOverrideStillWorks();
  await noDisagreementNothingToResolve();
  await mixedDirtySet();
  await unguardedFailureStillBlocksPull();
  await widenedFieldComparison();
  await cleanStartUnaffected();
  versionDiscipline();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
