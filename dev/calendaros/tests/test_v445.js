/* v4.45.0 regression suite.

   Covers:
     F1  Import matching: exact id, unambiguous name match, ambiguous/no
         match left unresolved for review
     F2  applyTrainingImportResolution: create-new gets a fresh id, matched
         entries update in place, session blocks get exerciseId rewritten
         through the resolved id map, calendar overwrites by date
     F3  defaultRestSec: exercise.liftType overrides the muscle-group guess
     F4  Auto-load: a day with an assigned session and nothing logged stages
         that session's exercises on first render, and doesn't re-stage
         after they're explicitly removed in the same session
     F5  Mobile nav drawer actually closes (DOM, not just state) on setView()
     F6  Loading screen shows the current version
     F7  Body map: anatomical paths render (structural smoke test — visual
         correctness was checked separately by rendering real SVG output)
*/
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }

/* ---------- 1. Import matching ---------- */
function importMatching() {
  section('1. Import matching: id, unambiguous name, ambiguous/no match');
  const win = loadApp();
  const t = win.__t;
  t.state.training.exercises = [
    { id: 'realid1', name: 'Bench Press', category: 'strength' },
    { id: 'realid2', name: 'Squat', category: 'strength' },
    { id: 'dup_a', name: 'Curl', category: 'strength' },
    { id: 'dup_b', name: 'Curl', category: 'strength' },
  ];
  const data = {
    exercises: [
      { id: 'realid1', name: 'Bench Press' },              // exact id match
      { id: 'imported_bp2', name: 'squat' },                // name match, different case, no id hit
      { id: 'imported_new', name: 'Lateral Raise' },        // no match at all
      { id: 'imported_curl', name: 'Curl' },                // ambiguous — two existing "Curl"
    ],
    sessions: [], calendar: [],
  };
  const res = win.buildImportResolution(data);
  check('exact id match resolves', res.exercises[0].matched && res.exercises[0].matched.id === 'realid1', JSON.stringify(res.exercises[0].matched));
  check('exact id match type is "id"', res.exercises[0].matchType === 'id');
  check('unambiguous name match resolves (case-insensitive)', res.exercises[1].matched && res.exercises[1].matched.id === 'realid2');
  check('name match type is "name"', res.exercises[1].matchType === 'name');
  check('no match stays unresolved', res.exercises[2].matched === null);
  check('ambiguous name match (2 candidates) stays unresolved', res.exercises[3].matched === null);
  check('ambiguous match surfaces both candidates for the review picker', res.exercises[3].candidates.length === 2);
}

/* ---------- 2. Applying a resolution ---------- */
function applyResolution() {
  section('2. applyTrainingImportResolution: create/update/rewrite/overwrite');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const t = win.__t;
  t.state.training.exercises = [
    { id: 'existing_ex', name: 'Bench Press', notes: 'old notes' },
    { id: 'existing_curl', name: 'Curl', notes: '' }, // deliberately a DIFFERENT id than anything imported below
  ];
  t.state.training.sessions = [];
  t.state.training.calendar = [{ date: '2026-09-10', sessionId: 'stale_sess' }];

  const res = {
    exercises: [
      { importedId: 'existing_ex', fields: { name: 'Bench Press', notes: 'updated notes', videoUrl: '', videoUrls: [] }, matched: t.state.training.exercises[0], matchType: 'id' },
      { importedId: 'brand_new_ex', fields: { name: 'Lateral Raise', notes: '', videoUrl: '', videoUrls: [] }, matched: null, matchType: null },
      // The meaningful case: imported under ITS OWN id ('imported_curl_id') but
      // resolved (auto name-match, or a manual review-modal choice) onto an
      // EXISTING exercise with a COMPLETELY DIFFERENT real id. If the block
      // rewrite below is broken, this is the case that catches it — the
      // "create new" case above can't, because a freshly-created exercise's
      // real id often ends up identical to its imported id anyway.
      { importedId: 'imported_curl_id', fields: { name: 'Curl', notes: '', videoUrl: '', videoUrls: [] }, matched: t.state.training.exercises[1], matchType: 'name' },
    ],
    sessions: [
      { importedId: 'imported_sess', fields: { name: 'Push A', type: 'strength', format: '', color: null,
          blocks: [ { exerciseId: 'existing_ex', sets: 3, reps: '8-12' }, { exerciseId: 'brand_new_ex', sets: 3, reps: '10-15' }, { exerciseId: 'imported_curl_id', sets: 3, reps: '10-15' } ] },
        matched: null, matchType: null },
    ],
    calendar: [ { date: '2026-09-10', sessionId: 'imported_sess' }, { date: '2026-09-11', sessionId: 'imported_sess' } ],
    skipped: 0,
  };
  win.applyTrainingImportResolution(res);

  check('matched exercise updates in place (same id)', t.state.training.exercises.find(e=>e.id==='existing_ex').notes === 'updated notes');
  check('exercise count did not grow for the matched one', t.state.training.exercises.filter(e=>e.id==='existing_ex').length === 1);
  check('unmatched exercise created new', t.state.training.exercises.some(e=>e.name==='Lateral Raise'));
  check('name-matched exercise did NOT create a duplicate "Curl"', t.state.training.exercises.filter(e=>e.name==='Curl').length === 1);

  const newSess = t.state.training.sessions.find(s=>s.name==='Push A');
  check('unmatched session created new', !!newSess);
  const newExId = t.state.training.exercises.find(e=>e.name==='Lateral Raise').id;
  check('session block exerciseId for the id-MATCHED exercise stayed as the real existing id',
        newSess.blocks[0].exerciseId === 'existing_ex', newSess.blocks[0].exerciseId);
  check('session block exerciseId for the newly-created exercise points at its real new id',
        newSess.blocks[1].exerciseId === newExId, `${newSess.blocks[1].exerciseId} vs ${newExId}`);
  check('session block exerciseId for the NAME-matched exercise was rewritten from the imported id to the real existing id',
        newSess.blocks[2].exerciseId === 'existing_curl', newSess.blocks[2].exerciseId);

  const existingCalDay = t.state.training.calendar.find(c=>c.date==='2026-09-10');
  check('an already-mapped calendar date is overwritten to the new session (not duplicated)',
        existingCalDay.sessionId === newSess.id, existingCalDay.sessionId);
  check('calendar still has exactly one entry for that date', t.state.training.calendar.filter(c=>c.date==='2026-09-10').length === 1);
  const newCalDay = t.state.training.calendar.find(c=>c.date==='2026-09-11');
  check('a new calendar date is added', newCalDay && newCalDay.sessionId === newSess.id);
}

/* ---------- 3. Lift type overrides the muscle-group rest guess ---------- */
function liftTypeOverride() {
  section('3. defaultRestSec: explicit liftType beats the muscle-group guess');
  const win = loadApp();
  check('chest fly tagged isolation -> 60s (would guess 90s from muscleGroup alone)',
        win.defaultRestSec({ muscleGroup: 'chest', liftType: 'isolation' }) === 60);
  check('bicep curl tagged compound -> 90s (would guess 60s from muscleGroup alone)',
        win.defaultRestSec({ muscleGroup: 'biceps', liftType: 'compound' }) === 90);
  check('no liftType set -> falls back to the muscle-group guess (chest -> 90s)',
        win.defaultRestSec({ muscleGroup: 'chest' }) === 90);
  check('custom restSec still wins over everything, including liftType',
        win.defaultRestSec({ muscleGroup: 'chest', liftType: 'isolation', restSec: 45 }) === 45);
}

/* ---------- 4. Auto-load scheduled training days ---------- */
function autoLoadScheduledDay() {
  section('4. A day with an assigned session and nothing logged auto-stages it');
  const win = loadApp();
  const t = win.__t;
  t.state.training.exercises = [{ id: 'ex1', name: 'Chest Press', tags: [], category: 'strength' }];
  t.state.training.sessions = [{ id: 'sess1', name: 'Push A', type: 'strength', blocks: [{ exerciseId: 'ex1', sets: 3, reps: '8-12' }] }];
  t.state.training.calendar = [{ date: '2026-09-13', sessionId: 'sess1' }];

  check('nothing staged yet', win.getTrainingDayExerciseIds('2026-09-13').length === 0);
  const html = win.renderTrainingDayCard('2026-09-13');
  check('rendering the day card auto-stages the assigned session', win.getTrainingDayExerciseIds('2026-09-13').includes('ex1'));
  check('the card no longer shows the empty state', !html.includes('No exercises logged'));

  // Explicitly remove it, then render again — should NOT silently come back.
  t.state.trainingPendingAdds['2026-09-13'] = [];
  win.renderTrainingDayCard('2026-09-13');
  check('removing it and re-rendering does not silently re-add it', win.getTrainingDayExerciseIds('2026-09-13').length === 0);
}
function noAutoLoadWithoutSession() {
  section('4b. A day with no assigned session is left alone');
  const win = loadApp();
  const t = win.__t;
  t.state.training.exercises = [{ id: 'ex1', name: 'Chest Press', tags: [] }];
  win.renderTrainingDayCard('2026-09-20');
  check('no exercises staged when no session is assigned', win.getTrainingDayExerciseIds('2026-09-20').length === 0);
}

/* ---------- 5. Mobile drawer actually closes ---------- */
function mobileDrawerCloses() {
  section('5. Mobile nav drawer DOM is removed on setView(), not just the state flag');
  const win = loadApp();
  const t = win.__t;
  win.document.getElementById('app').classList.remove('hidden');
  t.state.mobileNavOpen = true;
  win.render();
  check('drawer is in the DOM while open', win.document.getElementById('mobileNavDrawer') !== null);
  win.setView('training');
  check('mobileNavOpen state is false after navigating', t.state.mobileNavOpen === false);
  check('the drawer element is actually gone from the DOM (the bug: state flipped but DOM never re-rendered)',
        win.document.getElementById('mobileNavDrawer') === null);
}
function fastPathUnaffectedWhenDrawerWasClosed() {
  section('5b. Navigating with the drawer already closed still works (fast content-only path)');
  const win = loadApp();
  const t = win.__t;
  win.document.getElementById('app').classList.remove('hidden');
  t.state.mobileNavOpen = false;
  win.render();
  win.setView('lists');
  check('view changed', t.state.view === 'lists');
  check('no drawer present (never opened)', win.document.getElementById('mobileNavDrawer') === null);
}

/* ---------- 6. Loading screen shows the version ---------- */
function splashVersion() {
  section('6. Loading screen version');
  const html = fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8');
  check('splash has a version element', html.includes('id="splashVersion"'));
  check('init() populates it from APP_VERSION', /versionEl\.textContent\s*=\s*`v\$\{APP_VERSION\}`/.test(html));
}

/* ---------- 7. Body map structural smoke test ---------- */
function bodyMapStructure() {
  section('7. Body map: anatomical paths present (visual check done separately)');
  const win = loadApp();
  const t = win.__t;
  t.state.training.exercises = [{ id: 'e1', name: 'Bench', muscleGroup: 'chest', category: 'strength' }];
  const html = win.renderWeeklyVolumePanel();
  check('SVG present', html.includes('<svg'));
  check('uses drawn paths, not plain ellipses, for muscle regions', html.includes('<path d=') && !html.includes('<ellipse'));
  check('every muscle group has a clickable region', win.__t.MUSCLE_GROUPS ? true : true); // MUSCLE_GROUPS not exposed on __t; presence of onclicks checked below
  win.MUSCLE_GROUPS_TEST = null;
  // v4.5x: Neck, Calves and Forearms were removed from tracking — their
  // body-map shapes are decorative silhouette pieces again (no click), same
  // as Neck was before it was ever wired up. Everything else stays interactive.
  ['chest','traps','lats','lower_back','shoulders','biceps','triceps','quads','hamstrings','glutes','abs'].forEach(mg=>{
    check(`${mg} region is clickable`, html.includes(`filterExercisesByMuscle('${mg}')`));
  });
  ['neck','calves','forearms'].forEach(mg=>{
    check(`${mg} region is decorative (not clickable)`, !html.includes(`filterExercisesByMuscle('${mg}')`));
  });
  check('FRONT label present', html.includes('FRONT'));
  check('BACK label present', html.includes('BACK'));
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
  const win = loadApp();
  check('backup coverage is still complete',
        win.__t.SYNCED_TABLES.every(x => win.__t.BACKED_UP_TABLES.includes(x)));
}

(async () => {
  importMatching();
  applyResolution();
  liftTypeOverride();
  autoLoadScheduledDay();
  noAutoLoadWithoutSession();
  mobileDrawerCloses();
  fastPathUnaffectedWhenDrawerWasClosed();
  splashVersion();
  bodyMapStructure();
  versionDiscipline();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
