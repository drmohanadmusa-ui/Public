/* v4.48.0 regression suite.

   Covers:
     F1  Body map head/neck stroke matches the muscle-region stroke color
     F2  muscleVolumeTextColour(): a separate, darker color set for the
         legend numbers, distinct from the small-swatch colors
     F3  Collapsible completed exercises: auto-collapses when all working
         sets are done, expands on tap, and — critically — saving while
         collapsed does NOT wipe notes/other fields it can't see in the DOM
     F4  Seat/Machine Setting: field round-trips through Add/Edit modals and
         Supabase row mapping, and displays on the log card
     F5  Failure-day scheduling: isolation-only, history-gated, cooldown
         respected, "most overdue" preferred, decided once per date and
         remembered, banner shown only on the chosen exercise
*/
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }

/* ---------- 1. Body map head/neck color ---------- */
function headColorMatches() {
  section('1. Body map head/neck outline matches the muscle-region stroke color');
  const win = loadApp();
  const html = win.renderWeeklyVolumePanel();
  const headTags = [...html.matchAll(/<circle[^>]*r="11"[^>]*>/g)].map(m => m[0]);
  check('found both head circles', headTags.length === 2, headTags.length);
  headTags.forEach((tag, i) => {
    check(`head circle ${i + 1} uses the darkened stroke`, tag.includes('stroke="var(--ink-soft)"'), tag);
    check(`head circle ${i + 1} does NOT use the old pale stroke`, !tag.includes('stroke="var(--line)"'), tag);
  });
}

/* ---------- 2. Legend number text contrast ---------- */
function legendTextContrast() {
  section('2. muscleVolumeTextColour: separate, darker color set for the legend numbers');
  const win = loadApp();
  const band = { min: 10, max: 20 };
  check('zero sets uses a legible muted color, not the barely-there paper-dim fill',
        win.muscleVolumeTextColour(0, band) === 'var(--ink-soft)', win.muscleVolumeTextColour(0, band));
  check('under-band text is a darker amber than the swatch color',
        win.muscleVolumeTextColour(5, band) !== win.muscleVolumeColour(5, band));
  check('in-band text still uses the same teal (already legible)',
        win.muscleVolumeTextColour(15, band) === win.muscleVolumeColour(15, band));
  check('over-band text is a darker red than the swatch color',
        win.muscleVolumeTextColour(25, band) !== win.muscleVolumeColour(25, band));
}

/* ---------- 3. Collapsible completed exercises ---------- */
async function collapsibleExercises() {
  section('3. Collapsible exercises (v4.50.0: manual-only) + save-safety guard');
  const win = loadApp();
  const t = win.__t;
  const today = win.todayStr();
  t.state.training.exercises = [{ id: 'e1', name: 'Bench Press' }];
  t.state.view = 'training'; t.state.trainingSection = 'today';
  t.state.trainingSelectedDate = today; t.state.trainingPendingAdds[today] = ['e1'];
  win.document.getElementById('app').classList.remove('hidden');

  win.addSet(today, 'e1');
  win.render();
  let html = win.document.getElementById('app').innerHTML;
  check('an incomplete exercise is NOT collapsed', html.includes('+ Set') && html.includes('Bench Press'));

  win.toggleSetDone(today, 'e1', 1, 60);
  win.render();
  html = win.document.getElementById('app').innerHTML;
  // v4.50.0: auto-collapse-when-complete is gone — a fully-done exercise
  // stays expanded by default until manually collapsed. This replaces the
  // v4.48.0 "a fully-done exercise IS collapsed" check with its opposite.
  check('a fully-done exercise stays expanded by default (auto-collapse removed)',
        html.includes('Notes for this exercise') && !html.includes('tap to expand'));
  check('the expanded card still shows the set count', html.includes('1/1 sets'));

  // Manually collapse it via the ▾ button.
  win.toggleTrainingRowExpanded(today, 'e1');
  win.render();
  html = win.document.getElementById('app').innerHTML;
  check('manually collapsing shows the one-line summary', html.includes('tap to expand') && !html.includes('Notes for this exercise'));
  check('the collapsed summary still shows the set count', html.includes('1/1 sets'));

  // Set draft notes BEFORE it was ever expanded again this render, simulating
  // notes that were typed in an earlier session and are now just sitting in
  // the log — nothing in the current DOM represents them while collapsed.
  const log = t.state.training.logs.find(l => l.exerciseId === 'e1') || { date: today, exerciseId: 'e1' };
  log.notes = 'Felt strong today';
  if (!t.state.training.logs.includes(log)) t.state.training.logs.push(log);

  // The critical check (still applies to MANUAL collapse the same way it did
  // to the old auto-collapse): saving while collapsed must NOT wipe those notes.
  await win.saveTrainingDayLogs(today);
  const savedLog = t.state.training.logs.find(l => l.exerciseId === 'e1');
  check('saving while manually collapsed does NOT wipe existing notes (the bug this session found and fixed)',
        savedLog.notes === 'Felt strong today', savedLog.notes);

  // Now expand it and confirm the full card (and its notes field) comes back.
  win.toggleTrainingRowExpanded(today, 'e1');
  win.render();
  html = win.document.getElementById('app').innerHTML;
  check('tapping expands the full card again', html.includes('Notes for this exercise'));
  check('the expanded notes field shows the preserved value', html.includes('Felt strong today'));

  // Collapsing again (toggle back on) should show the summary again.
  win.toggleTrainingRowExpanded(today, 'e1');
  win.render();
  html = win.document.getElementById('app').innerHTML;
  check('toggling again re-collapses it', html.includes('tap to expand'));
}

/* ---------- 4. Seat / Machine Setting ---------- */
function seatSetting() {
  section('4. Seat/Machine Setting field');
  const win = loadApp();
  const t = win.__t;
  t.state.settings.sync = { url: 'https://p.example.test', anonKey: 'a', pin: '1' };
  const ex = { id: 'e1', name: 'Chest Press', seatSetting: '5' };
  const row = win.trainingExerciseToRow(ex);
  check('writes seat_setting to the row', row.seat_setting === '5', row.seat_setting);
  const restored = win.rowToTrainingExercise({ id: 'e1', name: 'Chest Press', seat_setting: '5' });
  check('reads seat_setting back', restored.seatSetting === '5', restored.seatSetting);
  check('null when never set', win.trainingExerciseToRow({ id: 'e2', name: 'X' }).seat_setting === null);

  // Displays on the log card.
  const today = win.todayStr();
  t.state.training.exercises = [ex];
  t.state.view = 'training'; t.state.trainingSection = 'today';
  t.state.trainingSelectedDate = today; t.state.trainingPendingAdds[today] = ['e1'];
  win.document.getElementById('app').classList.remove('hidden');
  win.render();
  const html = win.document.getElementById('app').innerHTML;
  check('seat setting shown on the log card', html.includes('Seat 5'), 'card rendered');
}

/* ---------- 5. Failure-day scheduling ---------- */
function failureDayScheduling() {
  section('5. Failure-day scheduling: isolation-only, history-gated, cooldown, most-overdue, remembered');
  const win = loadApp();
  const t = win.__t;
  const today = win.todayStr();

  t.state.training.exercises = [
    { id: 'iso_ready', name: 'Leg Extension', liftType: 'isolation' },
    { id: 'iso_new', name: 'Cable Fly', liftType: 'isolation' },       // no history yet
    { id: 'iso_recent', name: 'Leg Curl', liftType: 'isolation' },     // failed to failure recently
    { id: 'compound', name: 'Squat', liftType: 'compound' },           // never eligible regardless of history
  ];

  // Build history: 5 prior logged sessions for each of the first three,
  // spaced well apart, none on/after `today`.
  const priorDates = ['2026-08-01','2026-08-08','2026-08-15','2026-08-22','2026-08-29'];
  t.state.training.sets = [];
  let setNo = 1;
  ['iso_ready','iso_new','iso_recent','compound'].forEach(exId=>{
    if (exId === 'iso_new') return; // deliberately no history
    priorDates.forEach(d=>{
      t.state.training.sets.push({ date: d, exerciseId: exId, setNo: setNo++, done: true, isWarmup: false });
    });
  });
  // iso_recent went to failure 5 days ago — inside the cooldown, not eligible yet.
  const recentFailureDate = win.addDays(today, -5);
  t.state.training.sets.push({ date: recentFailureDate, exerciseId: 'iso_recent', setNo: setNo++, done: true, isWarmup: false, toFailure: true });
  // iso_ready went to failure 20 days ago — outside the cooldown, eligible.
  const oldFailureDate = win.addDays(today, -20);
  t.state.training.sets.push({ date: oldFailureDate, exerciseId: 'iso_ready', setNo: setNo++, done: true, isWarmup: false, toFailure: true });

  const staged = ['iso_ready', 'iso_new', 'iso_recent', 'compound'];
  const pick = win.pickFailureExerciseForDay(today, staged);
  check('compound is never picked regardless of history', pick !== 'compound');
  check('an exercise with no history yet is not picked', pick !== 'iso_new');
  check('an exercise still within its cooldown is not picked', pick !== 'iso_recent');
  check('the eligible, established, out-of-cooldown isolation exercise is picked', pick === 'iso_ready', pick);

  // Decided once and remembered — calling ensureFailureDayPlanned again
  // must not recompute (e.g. if history changes later, the earlier decision
  // for this date should stand).
  win.ensureFailureDayPlanned(today, staged);
  check('plan recorded for today', t.state.settings.trainingFailurePlan[today] === 'iso_ready',
        JSON.stringify(t.state.settings.trainingFailurePlan));
  t.state.training.sets = t.state.training.sets.filter(s => s.exerciseId !== 'iso_ready'); // wipe its history
  win.ensureFailureDayPlanned(today, staged);
  check('does not recompute once already decided for this date',
        t.state.settings.trainingFailurePlan[today] === 'iso_ready');

  // A past date should never get a plan assigned retroactively.
  const pastDate = win.addDays(today, -1);
  win.ensureFailureDayPlanned(pastDate, staged);
  check('never plans for a past date', !(pastDate in t.state.settings.trainingFailurePlan));

  // No eligible candidates at all -> records null (decided: none), not left undecided.
  const win2 = loadApp();
  const t2 = win2.__t;
  const today2 = win2.todayStr();
  t2.state.training.exercises = [{ id: 'brandnew', name: 'New Machine', liftType: 'isolation' }];
  win2.ensureFailureDayPlanned(today2, ['brandnew']);
  check('records null when nothing is eligible (decided: none), rather than staying undecided',
        today2 in t2.state.settings.trainingFailurePlan && t2.state.settings.trainingFailurePlan[today2] === null,
        JSON.stringify(t2.state.settings.trainingFailurePlan));

  // Banner appears only on the chosen exercise's card.
  const win3 = loadApp();
  const t3 = win3.__t;
  const today3 = win3.todayStr();
  t3.state.training.exercises = [
    { id: 'picked', name: 'Picked Exercise', liftType: 'isolation' },
    { id: 'other', name: 'Other Exercise', liftType: 'isolation' },
  ];
  t3.state.settings.trainingFailurePlan = { [today3]: 'picked' };
  t3.state.view = 'training'; t3.state.trainingSection = 'today';
  t3.state.trainingSelectedDate = today3; t3.state.trainingPendingAdds[today3] = ['picked', 'other'];
  win3.document.getElementById('app').classList.remove('hidden');
  win3.render();
  const html3 = win3.document.getElementById('app').innerHTML;
  const pickedIdx = html3.indexOf('Picked Exercise');
  const otherIdx = html3.indexOf('Other Exercise');
  check('the picked exercise shows the failure-day banner', html3.slice(pickedIdx, pickedIdx + 900).includes('Failure day'));
  check('the other exercise does NOT show the banner', !html3.slice(otherIdx, otherIdx + 600).includes('Failure day'));
}

/* ---------- 6. Version discipline ---------- */
function versionDiscipline() {
  section('6. Version and changelog');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const v = /const APP_VERSION = '([\d.]+)'/.exec(js)[1];
  check('the changelog leads with the shipped version',
        new RegExp(`const CHANGELOG = \\[\\s*\\{ v:'${v.replace(/\./g, '\\.')}'`).test(js), v);
  check('the built file carries the same version',
        fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8').includes(`const APP_VERSION = '${v}'`));
  check('SQL block has the seat_setting migration', js.includes('alter table training_exercises add column if not exists seat_setting text;'));
  check('SQL block has the training_failure_plan migration', js.includes("alter table app_settings add column if not exists training_failure_plan jsonb default '{}';"));
  const win = loadApp();
  check('backup coverage is still complete',
        win.__t.SYNCED_TABLES.every(x => win.__t.BACKED_UP_TABLES.includes(x)));
}

(async () => {
  headColorMatches();
  legendTextContrast();
  await collapsibleExercises();
  seatSetting();
  failureDayScheduling();
  versionDiscipline();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
