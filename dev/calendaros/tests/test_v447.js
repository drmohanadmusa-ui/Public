/* v4.47.0 regression suite.

   Covers:
     F1  exMuscleGroups(): prefers the new array, falls back to the old
         singular field, never throws on a missing exercise
     F2  Row mapping writes ONLY muscle_groups (array) going forward, reads
         either shape
     F3  Volume computation credits a set fully to EVERY targeted muscle,
         not a fractional split
     F4  defaultRestSec: compound if ANY targeted group is a compound group
     F5  Import resolution: captures muscleGroups from either shape, and
         critically does NOT wipe existing groups when an import doesn't
         mention them
     F6  Add/Edit exercise modals: multi-select pills read back correctly,
         and saving through Edit clears the legacy field so an intentional
         "zero groups" selection isn't resurrected by the fallback
     F7  Lats: new muscle group present everywhere it needs to be, with its
         own dedicated body-map shapes separate from the traps diamond
*/
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }

/* ---------- 1. exMuscleGroups compatibility helper ---------- */
function compatHelper() {
  section('1. exMuscleGroups(): primary/secondary split, old fields as fallback (all read as primary)');
  const win = loadApp();
  check('new primary array used when populated', JSON.stringify(win.exMuscleGroups({ muscleGroupsPrimary: ['chest', 'triceps'] }, 'primary')) === '["chest","triceps"]');
  check('falls back to old flat muscleGroups array, read as primary', JSON.stringify(win.exMuscleGroups({ muscleGroups: ['chest'] }, 'primary')) === '["chest"]');
  check('falls back to old singular field when nothing else is set', JSON.stringify(win.exMuscleGroups({ muscleGroup: 'chest' }, 'primary')) === '["chest"]');
  check('v4.50.0: "back" is remapped to "traps" at read time, not rewritten in storage', JSON.stringify(win.exMuscleGroups({ muscleGroup: 'back' }, 'primary')) === '["traps"]');
  check('secondary array read independently of primary', JSON.stringify(win.exMuscleGroups({ muscleGroupsPrimary: ['chest'], muscleGroupsSecondary: ['triceps'] }, 'secondary')) === '["triceps"]');
  check('no mode given returns the union of primary + secondary', JSON.stringify(win.exMuscleGroups({ muscleGroupsPrimary: ['chest'], muscleGroupsSecondary: ['triceps'] }).sort()) === '["chest","triceps"]');
  check('new primary array is used as-is, ignoring any stale old field', JSON.stringify(win.exMuscleGroups({ muscleGroupsPrimary: ['chest'], muscleGroup: 'back' }, 'primary')) === '["chest"]');
  check('the real "save with zero groups" state (all fields cleared together) reads as empty, not a fallback',
        JSON.stringify(win.exMuscleGroups({ muscleGroupsPrimary: [], muscleGroups: null, muscleGroup: null })) === '[]');
  check('neither field set → empty array', JSON.stringify(win.exMuscleGroups({})) === '[]');
  check('null/undefined exercise → empty array, no throw', JSON.stringify(win.exMuscleGroups(null)) === '[]');
}

/* ---------- 2. Row mapping ---------- */
function rowMapping() {
  section('2. Row mapping: primary → muscle_groups, secondary → muscle_groups_secondary, reads either shape');
  const win = loadApp();
  const t = win.__t;
  t.state.settings.sync = { url: 'https://p.example.test', anonKey: 'a', pin: '1' };

  const newStyle = { id: 'e1', name: 'Bench', muscleGroupsPrimary: ['chest'], muscleGroupsSecondary: ['triceps', 'shoulders'] };
  const rowNew = win.trainingExerciseToRow(newStyle);
  check('writes primary to muscle_groups', JSON.stringify(rowNew.muscle_groups) === '["chest"]', JSON.stringify(rowNew.muscle_groups));
  check('writes secondary to the new muscle_groups_secondary column', JSON.stringify(rowNew.muscle_groups_secondary) === '["triceps","shoulders"]', JSON.stringify(rowNew.muscle_groups_secondary));
  check('does not write the old singular column', rowNew.muscle_group === undefined);

  const oldStyle = { id: 'e2', name: 'Row', muscleGroup: 'back' };
  const rowOld = win.trainingExerciseToRow(oldStyle);
  check('an exercise still on the old singular field is migrated into muscle_groups (as "traps") on write', JSON.stringify(rowOld.muscle_groups) === '["traps"]', JSON.stringify(rowOld.muscle_groups));
  check('nothing on the secondary side for an old-shape exercise', JSON.stringify(rowOld.muscle_groups_secondary) === '[]');

  const restoredFromNewRow = win.rowToTrainingExercise({ id: 'e1', name: 'Bench', muscle_groups: ['chest'], muscle_groups_secondary: ['triceps'] });
  check('reads primary from muscle_groups', JSON.stringify(restoredFromNewRow.muscleGroupsPrimary) === '["chest"]');
  check('reads secondary from muscle_groups_secondary', JSON.stringify(restoredFromNewRow.muscleGroupsSecondary) === '["triceps"]');

  const restoredFromOldRow = win.rowToTrainingExercise({ id: 'e2', name: 'Row', muscle_group: 'back' });
  check('reads a row written before this version (old column only) via exMuscleGroups fallback, remapped to traps',
        JSON.stringify(win.exMuscleGroups(restoredFromOldRow)) === '["traps"]', JSON.stringify(restoredFromOldRow));
}

/* ---------- 3. Volume credits: primary full, secondary fractional ---------- */
function volumeCreditsEveryGroup() {
  section('3. Primary muscles credited fully; secondary muscles not counted at all (v4.5x: fractional credit removed)');
  const win = loadApp();
  const t = win.__t;
  t.state.training.exercises = [{ id: 'e1', name: 'Bench Press', muscleGroupsPrimary: ['chest'], muscleGroupsSecondary: ['triceps', 'shoulders'] }];
  const today = win.todayStr();
  t.state.training.sets = [
    { date: today, exerciseId: 'e1', setNo: 1, done: true, isWarmup: false },
    { date: today, exerciseId: 'e1', setNo: 2, done: true, isWarmup: false },
  ];
  const vol = win.computeWeeklyVolumeByMuscle();
  check('primary muscle credited fully (2)', vol.chest === 2, vol.chest);
  check('secondary muscle not counted at all', !vol.triceps, vol.triceps);
  check('secondary muscle not counted at all', !vol.shoulders, vol.shoulders);
  check('an untargeted muscle stays at zero', !vol.lats);

  // A muscle that's (unusually) in both lists gets primary's full credit, not double.
  t.state.training.exercises = [{ id: 'e2', name: 'Odd Exercise', muscleGroupsPrimary: ['biceps'], muscleGroupsSecondary: ['biceps'] }];
  t.state.training.sets = [{ date: today, exerciseId: 'e2', setNo: 1, done: true, isWarmup: false }];
  const vol2 = win.computeWeeklyVolumeByMuscle();
  check('a muscle in both lists gets primary\'s full credit once, not double-counted', vol2.biceps === 1, vol2.biceps);
}

/* ---------- 4. defaultRestSec: compound if ANY group is compound ---------- */
function restSecAnyCompound() {
  section('4. defaultRestSec: compound if ANY targeted muscle group is a compound group');
  const win = loadApp();
  check('all-isolation groups → 60s', win.defaultRestSec({ muscleGroups: ['biceps', 'triceps'] }) === 60);
  check('one compound group among isolation groups → 90s',
        win.defaultRestSec({ muscleGroups: ['triceps', 'chest'] }) === 90);
  check('liftType still overrides the muscle-group guess entirely',
        win.defaultRestSec({ muscleGroups: ['chest', 'shoulders'], liftType: 'isolation' }) === 60);
}

/* ---------- 5. Import resolution: captures groups, never wipes silently ---------- */
function importResolutionMuscleGroups() {
  section('5. Import: captures muscleGroups from either shape, never wipes existing groups when unspecified');
  const win = loadApp();
  const t = win.__t;
  t.state.training.exercises = [{ id: 'existing', name: 'Bench Press', muscleGroups: ['chest', 'triceps'] }];

  const data = {
    exercises: [
      { id: 'existing', name: 'Bench Press' }, // no muscleGroups mentioned at all
      { id: 'new1', name: 'Lat Pulldown', muscleGroups: ['lats', 'biceps'] },
      { id: 'new2', name: 'Squat', muscleGroup: 'quads' }, // legacy singular shape
    ],
    sessions: [], calendar: [],
  };
  const res = win.buildImportResolution(data);
  check('unspecified groups on a matched exercise are simply absent from fields (not an empty array)',
        !('muscleGroups' in res.exercises[0].fields), JSON.stringify(res.exercises[0].fields));
  check('new-shape array captured for a new exercise', JSON.stringify(res.exercises[1].fields.muscleGroups) === '["lats","biceps"]');
  check('legacy singular shape captured and wrapped into an array', JSON.stringify(res.exercises[2].fields.muscleGroups) === '["quads"]');

  win.applyTrainingImportResolution(res);
  const stillExisting = t.state.training.exercises.find(e => e.id === 'existing');
  check('the matched exercise\'s existing muscle groups were NOT wiped by the unspecified import',
        JSON.stringify(win.exMuscleGroups(stillExisting)) === '["chest","triceps"]', JSON.stringify(stillExisting));
}

/* ---------- 6. Modal pills + legacy-field clearing on save ---------- */
function modalPillsAndLegacyClear() {
  section('6. Edit modal: primary/secondary pills read back correctly, and saving clears the legacy fields');
  const win = loadApp();
  const t = win.__t;
  t.state.training.exercises = [{ id: 'e1', name: 'Row', muscleGroup: 'back' }]; // old-style only
  win.document.getElementById('app').classList.remove('hidden');
  win.openEditExerciseModal('e1');

  const primaryPillsHtml = win.document.getElementById('editExMuscleGroupPillsPrimary').outerHTML;
  check('the primary pill pre-selected from the old-field fallback is active (remapped to traps)',
        /data-val="traps"[^>]*active|active[^>]*data-val="traps"/.test(primaryPillsHtml), 'pills rendered');
  check('secondary pills exist as a separate row', !!win.document.getElementById('editExMuscleGroupPillsSecondary'));

  // Toggle traps OFF in primary, toggle lats ON in primary, and triceps ON in secondary.
  const trapsBtn = win.document.querySelector('#editExMuscleGroupPillsPrimary [data-val="traps"]');
  const latsBtn = win.document.querySelector('#editExMuscleGroupPillsPrimary [data-val="lats"]');
  const tricepsSecBtn = win.document.querySelector('#editExMuscleGroupPillsSecondary [data-val="triceps"]');
  if (trapsBtn) win.toggleMuscleGroupPill('editExMuscleGroupPillsPrimary', trapsBtn);
  if (latsBtn) win.toggleMuscleGroupPill('editExMuscleGroupPillsPrimary', latsBtn);
  if (tricepsSecBtn) win.toggleMuscleGroupPill('editExMuscleGroupPillsSecondary', tricepsSecBtn);

  win.document.getElementById('editExName').value = 'Row';
  win.submitEditExercise('e1');
  const saved = t.state.training.exercises[0];
  check('new primary selection saved to muscleGroupsPrimary', JSON.stringify(saved.muscleGroupsPrimary) === '["lats"]', JSON.stringify(saved.muscleGroupsPrimary));
  check('new secondary selection saved to muscleGroupsSecondary', JSON.stringify(saved.muscleGroupsSecondary) === '["triceps"]', JSON.stringify(saved.muscleGroupsSecondary));
  check('legacy flat field cleared on save (migration moment)', saved.muscleGroups === null, saved.muscleGroups);
  check('legacy singular field cleared on save (migration moment)', saved.muscleGroup === null, saved.muscleGroup);

  // Cross-exclusion: picking a muscle as secondary while it's already primary
  // elsewhere should clear it from primary (and vice versa) — verified via a
  // fresh modal open rather than reusing the DOM state mutated above.
  win.openEditExerciseModal('e1');
  const chestPrimaryBtn = win.document.querySelector('#editExMuscleGroupPillsPrimary [data-val="chest"]');
  if (chestPrimaryBtn) win.toggleMuscleGroupPill('editExMuscleGroupPillsPrimary', chestPrimaryBtn);
  const chestSecondaryBtn = win.document.querySelector('#editExMuscleGroupPillsSecondary [data-val="chest"]');
  if (chestSecondaryBtn) win.toggleMuscleGroupPill('editExMuscleGroupPillsSecondary', chestSecondaryBtn);
  check('selecting chest as secondary clears it from primary', chestPrimaryBtn && !chestPrimaryBtn.classList.contains('active'));
  check('chest is now active in secondary', chestSecondaryBtn && chestSecondaryBtn.classList.contains('active'));
}

/* ---------- 7. Lats: present everywhere, with its own body-map shapes ---------- */
function latsMuscleGroup() {
  section('7. Lats: new muscle group, with dedicated body-map shapes separate from traps');
  const win = loadApp();
  const t = win.__t;
  // MUSCLE_GROUPS is a top-level `const`, not reachable as win.MUSCLE_GROUPS
  // (the harness only exposes specific bindings via win.__t — see harness.js).
  // Checking indirectly via the rendered filter-chip row instead, which is
  // built directly from that list.
  const chipsHtml = win.renderTrainingExercisesSubpage();
  check('lats appears as a filter chip (confirms it is in MUSCLE_GROUPS)', chipsHtml.includes(">Lats"), 'chip row rendered');
  t.state.training.exercises = [{ id: 'e1', name: 'Lat Pulldown', muscleGroupsPrimary: ['lats'] }];
  const html = win.renderWeeklyVolumePanel();
  check('lats region is clickable on the body map', html.includes(`filterExercisesByMuscle('lats')`));
  check('traps (formerly the generic "back") region still exists separately', html.includes(`filterExercisesByMuscle('traps')`));
  // Scoped to <path> elements specifically — renderWeeklyVolumePanel() also
  // has a text legend below the SVG that references every muscle by name
  // (correctly, including lats), which would otherwise inflate this count.
  const pathTags = [...html.matchAll(/<path[^>]*>/g)].map(m => m[0]);
  const latShapeCount = pathTags.filter(p => p.includes("filterExercisesByMuscle('lats')")).length;
  const trapsShapeCount = pathTags.filter(p => p.includes("filterExercisesByMuscle('traps')")).length;
  check('lats has its own shapes (the former lat-wing paths), not zero', latShapeCount >= 1, latShapeCount);
  check('traps is still just the one diamond shape', trapsShapeCount === 1, trapsShapeCount);

  // Exercise library: filter and chip count both recognize lats.
  t.state.muscleGroupFilter = 'lats';
  const libHtml = win.renderTrainingExercisesSubpage();
  check('exercise library filter recognizes lats', libHtml.includes('Lat Pulldown'));
  check('exercise library shows a Lats badge', libHtml.includes('>lats<') || libHtml.includes('Lats'));
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
  check('SQL block has the new muscle_groups migration', js.includes("alter table training_exercises add column if not exists muscle_groups jsonb default '[]';"));
  const win = loadApp();
  check('backup coverage is still complete',
        win.__t.SYNCED_TABLES.every(x => win.__t.BACKED_UP_TABLES.includes(x)));
}

(async () => {
  compatHelper();
  rowMapping();
  volumeCreditsEveryGroup();
  restSecAnyCompound();
  importResolutionMuscleGroups();
  modalPillsAndLegacyClear();
  latsMuscleGroup();
  versionDiscipline();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
