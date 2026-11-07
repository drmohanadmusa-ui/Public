/* v4.36.0 regression suite.

   Covers:
     - training draft persistence across a simulated tab discard
     - the 24h staleness cap
     - drafts never entering the sync path
     - the cancelled-delete draft bug
     - today's card staying open after save
     - the CSS rules that stop iOS zoom / enlarge touch targets

   Deliberately reads the version from the source rather than hardcoding it
   (check-tests.sh forbids hardcoded versions, and three suites rotted that way
   before it existed). */
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }

function configured(win) {
  win.__t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Waits for a condition instead of guessing at a duration.

   The draft write is debounced (400ms) and then async, so a fixed sleep is a
   bet on how loaded the machine is. That produced exactly one unreproducible
   failure across ~50 runs — the worst kind, because a suite that fails at
   random teaches you to ignore it, and these assertions have already caught
   real bugs. Polling keeps the assertion identical and removes the bet. */
async function waitFor(fn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

/* ---------- 1. Drafts survive a reload ---------- */
async function draftsSurviveReload() {
  section('1. Unsaved training entry survives a tab discard');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const t = win.__t;
  const today = win.todayStr();

  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];
  win.setTrainingDraftField(today, 'E1', 'sets', 3);
  win.setTrainingDraftField(today, 'E1', 'reps', '10');
  win.setTrainingDraftField(today, 'E1', 'weight', 42.5);

  check('nothing written before the debounce elapses',
        !win.__store.has('dispatch:trainingdrafts'));
  check('the draft is written after the debounce',
        await waitFor(() => win.__store.has('dispatch:trainingdrafts')));

  // Simulate the discard: brand-new app instance, same storage contents.
  const win2 = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  win2.__store.set('dispatch:trainingdrafts', win.__store.get('dispatch:trainingdrafts'));
  await win2.loadAll();

  const d = win2.getTrainingDraft(today, 'E1');
  check('sets restored', d && d.sets === 3, JSON.stringify(d));
  check('reps restored', d && d.reps === '10', JSON.stringify(d));
  check('weight restored', d && d.weight === 42.5, JSON.stringify(d));
}

/* ---------- 2. Staleness cap ---------- */
async function stalenessCap() {
  section('2. Stale drafts are discarded, not resumed');
  const today = '2026-09-01';

  const fresh = loadApp();
  fresh.__store.set('dispatch:trainingdrafts', JSON.stringify({
    savedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h old
    drafts: { [`${today}::E1`]: { weight: 40 } }, pendingAdds: {},
  }));
  await fresh.loadAll();
  check('a 1-hour-old draft IS restored', !!fresh.getTrainingDraft(today, 'E1'));

  const stale = loadApp();
  stale.__store.set('dispatch:trainingdrafts', JSON.stringify({
    savedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), // 30h old
    drafts: { [`${today}::E1`]: { weight: 40 } }, pendingAdds: {},
  }));
  await stale.loadAll();
  check('a 30-hour-old draft is NOT restored', !stale.getTrainingDraft(today, 'E1'));

  const broken = loadApp();
  broken.__store.set('dispatch:trainingdrafts', '{not json');
  await broken.loadAll();
  check('corrupt draft storage does not break startup',
        Object.keys(broken.__t.state.trainingDraftValues).length === 0);

  const noStamp = loadApp();
  noStamp.__store.set('dispatch:trainingdrafts', JSON.stringify({
    drafts: { [`${today}::E1`]: { weight: 40 } }, pendingAdds: {},
  }));
  await noStamp.loadAll();
  check('a draft with no timestamp is NOT restored', !noStamp.getTrainingDraft(today, 'E1'));
}

/* ---------- 3. Drafts never reach Supabase ---------- */
async function draftsNeverSync() {
  section('3. Drafts stay on the device');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const t = win.__t;
  configured(win);
  const today = win.todayStr();

  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];
  win.setTrainingDraftField(today, 'E1', 'weight', 42.5);
  await waitFor(() => win.__store.has('dispatch:trainingdrafts'));
  await win.saveTraining();
  await waitFor(() => win.__calls.some(c => c.method === 'POST'));

  const bodies = JSON.stringify(win.__calls.filter(c => c.method === 'POST').map(c => c.body));
  check('the drafted weight is not in any outbound request', !bodies.includes('42.5'), bodies.slice(0, 300));
  check('no request mentions the drafts key', !win.__calls.some(c => c.url.includes('trainingdraft')));
  check('the drafts key is not a synced table',
        !t.SYNCED_TABLES.some(x => x.includes('draft')));
}

/* ---------- 4. Saving clears the stored draft ---------- */
async function savingClearsDrafts() {
  section('4. Saving a day clears its stored draft');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const t = win.__t;
  const today = win.todayStr();
  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];
  win.setTrainingDraftField(today, 'E1', 'weight', 42.5);
  check('draft is stored while unsaved',
        await waitFor(() => win.__store.has('dispatch:trainingdrafts')));

  // In v4.40.0 weight lives on training_sets rows rather than the log header.
  win.upsertTrainingSet({ date: today, exerciseId: 'E1', setNo: 1,
    reps: 10, weightKg: 42.5, done: false, rir: null, toFailure: false, isWarmup: false });
  t.state.trainingPendingAdds[today] = ['E1'];
  t.state.view = 'training';
  t.state.trainingSection = 'today';
  t.state.trainingSelectedDate = today;
  win.document.getElementById('app').classList.remove('hidden');
  win.render();
  await win.saveTrainingDayLogs(today);
  check('the stored draft is removed after saving',
        await waitFor(() => !win.__store.has('dispatch:trainingdrafts')));
  const setRows = win.getSetsForExercise(today, 'E1');
  check('the weight landed in the set rows', setRows.length > 0 && setRows[0].weightKg === 42.5,
        JSON.stringify(setRows));
}

/* ---------- 5. Cancelled delete keeps the draft ---------- */
async function cancelledDeleteKeepsDraft() {
  section('5. Cancelling a log deletion keeps what was typed');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const t = win.__t;
  const today = win.todayStr();
  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];
  t.state.training.logs = [{ date: today, exerciseId: 'E1', completed: true, sets: 3, reps: '10', weight: 40 }];
  win.setTrainingDraftField(today, 'E1', 'weight', 45);

  win.confirm = () => false; // person cancels
  await win.removeExerciseFromDay(today, 'E1');
  const d = win.getTrainingDraft(today, 'E1');
  check('the typed weight is still there after cancelling', d && d.weight === 45, JSON.stringify(d));
  check('the log itself is untouched', t.state.training.logs.length === 1);

  win.confirm = () => true; // person confirms
  await win.removeExerciseFromDay(today, 'E1');
  check('confirming does clear the draft', !win.getTrainingDraft(today, 'E1'));
  check('confirming does remove the log', t.state.training.logs.length === 0);
}

/* ---------- 6. Today's card stays open after save ---------- */
async function cardStaysOpen() {
  section("6. Today's card stays open after saving; a past day collapses");
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const t = win.__t;
  const today = win.todayStr();
  const past = win.addDays(today, -3);
  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];
  t.state.view = 'training'; t.state.trainingSection = 'today';
  win.document.getElementById('app').classList.remove('hidden');

  t.state.trainingSelectedDate = today;
  t.state.trainingPendingAdds[today] = ['E1'];
  t.state.trainingEditingDate = today;
  win.render();
  await win.saveTrainingDayLogs(today);
  check('today stays open', t.state.trainingEditingDate === today,
        `editingDate = ${t.state.trainingEditingDate}`);

  t.state.trainingSelectedDate = past;
  t.state.trainingPendingAdds[past] = ['E1'];
  t.state.trainingEditingDate = past;
  win.render();
  await win.saveTrainingDayLogs(past);
  check('a past day collapses', t.state.trainingEditingDate === null,
        `editingDate = ${t.state.trainingEditingDate}`);
}

/* ---------- 7. Mobile CSS ---------- */
function mobileCss() {
  section('7. Mobile CSS: no iOS zoom, bigger touch targets');
  const html = fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8');
  const style = html.slice(html.indexOf('<style'), html.indexOf('</style>'));
  const mobile = style.split('@media (max-width: 860px)').slice(1).join('');

  check('a mobile block raises inputs to 16px', /input, select, textarea, \.train-input\{font-size:16px;\}/.test(mobile));
  // Look at the markup only. The CSS rule legitimately contains font-size;
  // what must not exist is an inline style on a .train-input element, because
  // that would outrank the media query and put iOS zoom back.
  const inlineStyles = [...html.matchAll(/class="train-input"\s+style="([^"]*)"/g)].map(m => m[1]);
  // v4.40.0: strength inputs are now per-set inputs rendered by JS, not inline-
  // styled class="train-input" elements in the static HTML. The only remaining
  // inline-style train-input elements are the walking metric fields (3 of them).
  check('walking metric inputs still use the class', inlineStyles.length === 3, String(inlineStyles.length));
  check('no training input keeps an inline font-size',
        inlineStyles.every(s => !s.includes('font-size')), inlineStyles.join(' | '));
  check('training inputs use the class', html.includes('class="train-input"'));
  check('the remove button no longer has a 20px inline size', !html.includes('width:20px;height:20px;font-size:11px;'));
  check('difficulty pills reach 44px on mobile', /\.radio-pill\{[^}]*min-height:44px/.test(mobile));
  check('the remove button is enlarged on mobile', /\.train-remove-btn\{width:38px/.test(mobile));
  check('narrow inline widths get a mobile min-width', /\.train-input\{[^}]*min-width:72px/.test(mobile));

  // Desktop must be unchanged.
  const desktop = style.split('@media')[0];
  check('desktop training inputs stay at 12.5px', /\.train-input\{[^}]*font-size:12\.5px/.test(desktop));
}

/* ---------- 8. Version / changelog discipline ---------- */
function versionDiscipline() {
  section('8. Version and changelog');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const v = /const APP_VERSION = '([\d.]+)'/.exec(js)[1];
  check('the changelog leads with the shipped version',
        new RegExp(`const CHANGELOG = \\[\\s*\\{ v:'${v.replace(/\./g, '\\.')}'`).test(js), v);
  const entry = js.slice(js.indexOf("const CHANGELOG"), js.indexOf("{ v:'4.35.0'"));
  check('the entry states no SQL migration is needed', /No SQL migration needed/.test(entry));
  check('the built file carries the same version',
        fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8').includes(`const APP_VERSION = '${v}'`));
}

/* ---------- 9. Backup coverage unchanged ---------- */
function coverageUnchanged() {
  section('9. Backup coverage still complete');
  const win = loadApp();
  const t = win.__t;
  const missing = t.SYNCED_TABLES.filter(x => !t.BACKED_UP_TABLES.includes(x));
  check('no synced table is missing from the backup list', missing.length === 0, missing.join(','));
  check('table count is 21 (training_sets added in v4.40.0)', t.SYNCED_TABLES.length === 21, String(t.SYNCED_TABLES.length));
}

(async () => {
  await draftsSurviveReload();
  await stalenessCap();
  await draftsNeverSync();
  await savingClearsDrafts();
  await cancelledDeleteKeepsDraft();
  await cardStaysOpen();
  mobileCss();
  versionDiscipline();
  coverageUnchanged();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
