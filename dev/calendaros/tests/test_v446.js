/* v4.46.0 regression suite.

   Covers:
     F1  Body map: muscleVolumeOpacity floor raised for any nonzero volume
         (was nearly indistinguishable from zero at low set counts)
     F2  Body map: lats path resized to a proportionate scale (regression
         guard on the bounding box, not exact pixels — the shapes may be
         tuned again later)
     F3  Location/silo defaults are generic — no personal city or numbering
     F4  exerciseIsUnused(): AND logic across future-plan and logged-history,
         using the "staged via Plan Day/+Add Exercise" definition of planned
*/
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }

/* ---------- 1. Body map opacity contrast ---------- */
function opacityContrast() {
  section('1. muscleVolumeOpacity: any nonzero volume is clearly distinguishable from zero');
  const win = loadApp();
  const band = { min: 10, max: 20 };
  const zero = win.muscleVolumeOpacity(0, band);
  const low = win.muscleVolumeOpacity(2, band);
  const mid = win.muscleVolumeOpacity(10, band);
  const high = win.muscleVolumeOpacity(20, band);
  check('zero stays low', zero <= 0.2, zero);
  check('even 2 sets jumps to a clearly visible floor (>=0.5)', low >= 0.5, low);
  check('the gap between zero and any activity is large (>=0.3)', low - zero >= 0.3, `${low} - ${zero}`);
  check('opacity still climbs toward the top of the band', high > mid && mid > low, `${low} < ${mid} < ${high}`);
  check('never exceeds 1', high <= 1, high);
}

/* ---------- 2. Lats proportions ---------- */
function latsProportion() {
  section('2. Lats are sized proportionately to the front pecs (not ~3x the area)');
  const win = loadApp();
  const t = win.__t;
  t.state.training.exercises = [{ id: 'e1', name: 'Bench', muscleGroup: 'chest', category: 'strength' }];
  const html = win.renderWeeklyVolumePanel();

  function bbox(pathD) {
    const nums = pathD.match(/-?\d+(\.\d+)?/g).map(Number);
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  // Pull one pec path and one lat path out of the rendered markup directly,
  // rather than hardcoding coordinates here — this only asserts the
  // RELATIONSHIP (lats no longer dwarfing the pecs), so future shape tweaks
  // don't need to touch this test unless the proportion problem comes back.
  const pecMatch = html.match(/<path d="([^"]+)" style="\$\{fs\('chest'\)\}"/) || html.match(/onclick="filterExercisesByMuscle\('chest'\)"[^>]*>/);
  // Simpler: grab the raw path 'd' attributes preceding each chest/back onclick in source.
  const pecPaths = [...html.matchAll(/<path d="([^"]+)"[^>]*onclick="filterExercisesByMuscle\('chest'\)"/g)].map(m => m[1]);
  // v4.47.0: lats split out from 'back' into their own muscle group — these
  // are now tagged filterExercisesByMuscle('lats') directly, so the old
  // "back minus the traps diamond" heuristic isn't needed (and would now
  // wrongly grab the traps diamond itself instead, since that heuristic's
  // exclusion string never actually matched the diamond's path data).
  const latPaths = [...html.matchAll(/<path d="([^"]+)"[^>]*onclick="filterExercisesByMuscle\('lats'\)"/g)].map(m => m[1]);

  check('found pec paths', pecPaths.length >= 1, pecPaths.length);
  check('found lat paths (excluding the traps diamond)', latPaths.length >= 1, latPaths.length);
  if (pecPaths.length && latPaths.length) {
    const pecArea = bbox(pecPaths[0]).w * bbox(pecPaths[0]).h;
    const latArea = bbox(latPaths[0]).w * bbox(latPaths[0]).h;
    check('lat bounding-box area is not wildly larger than a pec\'s (within 2x)',
          latArea <= pecArea * 2, `pec ${pecArea.toFixed(0)} vs lat ${latArea.toFixed(0)}`);
  }
}

/* ---------- 3. Generic location/silo defaults ---------- */
function genericDefaults() {
  section('3. Location/silo defaults have no personal city name or numeric prefixes');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  check('no numbered location prefixes remain', !/'\d\.[A-Za-z]+'/.test(js));
  // Not a blanket "that city never appears" check — the changelog entry
  // documenting this fix legitimately names it, same as past entries
  // reference an invented family name. What matters is it's gone from the actual default
  // VALUES, checked directly below via completeSettingsObject's real output.
  const win = loadApp();
  win.__t.state.settings = { locations: [], silos: [], lastActiveDate: null, sync: null };
  // Simulate a true first run by calling completeSettingsObject with nothing.
  const built = win.completeSettingsObject({});
  check('default locations are plain names', JSON.stringify(built.locations) === JSON.stringify(['Office','Errand','Home','Other']), JSON.stringify(built.locations));
  check('default silos have no personal name', !built.silos.includes('Layla'), JSON.stringify(built.silos));
  check('default silos still has a sensible starter set', built.silos.length >= 5, built.silos.length);
}

/* ---------- 4. exerciseIsUnused ---------- */
function unusedMarker() {
  section('4. exerciseIsUnused(): AND logic — flags only when neither planned nor logged');
  const win = loadApp();
  const t = win.__t;
  const today = win.todayStr();
  const future = win.addDays ? win.addDays(today, 3) : today;
  t.state.training.exercises = [
    { id: 'planned_only', name: 'Planned Only' },
    { id: 'logged_only', name: 'Logged Only' },
    { id: 'both', name: 'Both' },
    { id: 'neither', name: 'Neither' },
  ];
  t.state.trainingPendingAdds = { [future]: ['planned_only', 'both'] };
  t.state.training.sets = [
    { date: today, exerciseId: 'logged_only', setNo: 1, done: true },
    { date: today, exerciseId: 'both', setNo: 1, done: true },
  ];

  const ex = id => t.state.training.exercises.find(e => e.id === id);
  check('planned-only is NOT flagged unused', win.exerciseIsUnused(ex('planned_only')) === false);
  check('logged-only is NOT flagged unused', win.exerciseIsUnused(ex('logged_only')) === false);
  check('both planned and logged is NOT flagged unused', win.exerciseIsUnused(ex('both')) === false);
  check('neither planned nor logged IS flagged unused', win.exerciseIsUnused(ex('neither')) === true);

  // A plan staged for a PAST date shouldn't count as "planned."
  t.state.trainingPendingAdds = { '2020-01-01': ['neither'] };
  check('a stale past-dated pending add does not count as a future plan',
        win.exerciseIsUnused(ex('neither')) === true);

  // The badge should actually render for the unused one and not the others.
  t.state.trainingPendingAdds = { [future]: ['planned_only'] };
  const html = win.renderTrainingExercisesSubpage();
  const idxNeither = html.indexOf('Neither');
  const idxPlanned = html.indexOf('Planned Only');
  check('badge text appears near the unused exercise', html.slice(idxNeither, idxNeither+400).includes('Unused'));
  check('badge text does NOT appear near a planned exercise', !html.slice(idxPlanned, idxPlanned+250).includes('Unused'));
}

/* ---------- 5. Version discipline ---------- */
function versionDiscipline() {
  section('5. Version and changelog');
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
  opacityContrast();
  latsProportion();
  genericDefaults();
  unusedMarker();
  versionDiscipline();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
