/* v4.44.0 regression suite.

   Covers:
     F1  RIR/F/W are mutually exclusive and update their own DOM immediately
         (previously only refreshed on a full page re-render)
     F2  rest timer tip rotation slowed to 6s
     F3  quick-add-exercise picker closes and lands on the log instead of
         staying open for another add
     F4  mobile CSS: enlarged RIR/F/W + set-tick touch targets, fixed
         (not sticky) rest timer bar, dark-mode toggle contrast, pinned list
         panel no longer pushes mobile content off-screen

   Sync auto-resolve-to-online behavior (item #2 from the same request) has
   its own full suite: see the rewritten test_v438.js.
   Rest timer default durations (90s/60s) are covered in test_v441.js. */
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }

function makeExercise(win, id='E1', name='Chest Press', muscleGroup='chest') {
  win.__t.state.training.exercises = [{ id, name, tags:[], category:'strength', muscleGroup }];
  return id;
}
function renderTrainingToday(win) {
  const t = win.__t;
  const today = win.todayStr();
  t.state.view = 'training'; t.state.trainingSection = 'today';
  t.state.trainingSelectedDate = today; t.state.trainingPendingAdds[today] = ['E1'];
  win.document.getElementById('app').classList.remove('hidden');
  win.render();
  return today;
}

/* ---------- 1. RIR / F / W mutual exclusivity ---------- */
function mutualExclusivity() {
  section('1. RIR / F / W are mutually exclusive');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  makeExercise(win);
  const today = renderTrainingToday(win);
  win.addSet(today, 'E1');

  win.setSetMode(today, 'E1', 1, 'rir', 2);
  let s = win.getSetsForExercise(today, 'E1')[0];
  check('picking RIR 2 sets rir', s.rir === 2);

  win.setSetMode(today, 'E1', 1, 'failure');
  s = win.getSetsForExercise(today, 'E1')[0];
  check('picking F clears rir', s.rir === null, JSON.stringify(s));
  check('picking F sets toFailure', s.toFailure === true);

  win.setSetMode(today, 'E1', 1, 'warmup');
  s = win.getSetsForExercise(today, 'E1')[0];
  check('picking W clears toFailure', s.toFailure === false, JSON.stringify(s));
  check('picking W clears rir too', s.rir === null, JSON.stringify(s));
  check('picking W sets isWarmup', s.isWarmup === true);

  win.setSetMode(today, 'E1', 1, 'rir', 0);
  s = win.getSetsForExercise(today, 'E1')[0];
  check('picking RIR after W clears isWarmup', s.isWarmup === false, JSON.stringify(s));
  check('picking RIR after W sets rir', s.rir === 0);

  // Tapping the already-active choice clears it back to "none".
  win.setSetMode(today, 'E1', 1, 'rir', 0);
  s = win.getSetsForExercise(today, 'E1')[0];
  check('re-tapping the active RIR clears it to null', s.rir === null, JSON.stringify(s));

  win.setSetMode(today, 'E1', 1, 'failure');
  win.setSetMode(today, 'E1', 1, 'failure');
  s = win.getSetsForExercise(today, 'E1')[0];
  check('re-tapping the active F toggles it back off', s.toFailure === false, JSON.stringify(s));
}

/* ---------- 2. RIR / F / W update their own DOM immediately ---------- */
function immediateDomUpdate() {
  section('2. Clicking RIR/F/W updates the button colour right away, no full re-render needed');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  makeExercise(win);
  const today = renderTrainingToday(win);
  win.addSet(today, 'E1');
  win.render(); // build the set row markup once, same as opening the page

  const group = win.document.querySelector(`[data-setmode="${today}::E1::1"]`);
  check('the set-mode group renders in the DOM', !!group);
  if (!group) return;

  // Confirm nothing is active yet, then click RIR 3 and check the DOM
  // directly — WITHOUT calling render() again. If setSetMode() relied on a
  // full re-render (the old bug) this button would still show no
  // highlighting at this point.
  check('no RIR button starts active', !group.querySelector('.rir-active'));
  win.setSetMode(today, 'E1', 1, 'rir', 3);
  const activeBtn = group.querySelector('.rir-active');
  check('after the click, a button is active WITHOUT another render() call', !!activeBtn);
  check('it is the RIR 3 button', activeBtn && activeBtn.textContent.trim() === '3',
        activeBtn && activeBtn.textContent);

  // Switch to F and confirm the DOM reflects exactly one active button.
  win.setSetMode(today, 'E1', 1, 'failure');
  const activeBtns = group.querySelectorAll('.rir-active');
  check('exactly one button is active after switching to F', activeBtns.length === 1, activeBtns.length);
  check('it is the F button', activeBtns[0] && activeBtns[0].textContent.trim() === 'F');
}

/* ---------- 3. Tip rotation slowed to 6s ---------- */
function tipRotationInterval() {
  section('3. Rest-timer tip rotation is 6000ms (was 4500ms)');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  check('setInterval(_rotateTip, 6000)', /_tipRotationHandle\s*=\s*setInterval\(_rotateTip,\s*6000\)/.test(js));
}

/* ---------- 4. Quick-add-exercise picker closes after picking ---------- */
function quickAddClosesAfterPick() {
  section('4. Picking an exercise from quick-add closes the picker (was: stayed open)');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const t = win.__t;
  makeExercise(win);
  const today = win.todayStr();
  win.document.getElementById('app').classList.remove('hidden');
  t.state.view = 'training'; t.state.trainingSection = 'today';
  win.render();

  win.openQuickAddExerciseModal(today);
  check('the picker modal is open', !!win.document.getElementById('quickAddExOverlay'));
  win.afterQuickAddExPick(today);
  check('the picker modal is closed after a pick', !win.document.getElementById('quickAddExOverlay'));
}

/* ---------- 5. Mobile CSS fixes ---------- */
function mobileCssFixes() {
  section('5. Mobile CSS: touch targets, fixed rest-timer bar, dark-toggle contrast, pinned panel');
  const html = fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8');
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  const style = styleMatch[1];
  const mobile = style.split('@media (max-width: 860px)').slice(1).join('@media (max-width: 860px)');

  check('RIR/F/W pills enlarged on mobile', /\.rir-pill\{[^}]*min-width:38px/.test(mobile));
  check('set-done tick enlarged on mobile', /\.set-tick\{[^}]*width:44px/.test(mobile));
  check('rest timer becomes position:fixed on mobile', /#restTimerDisplay\{[^}]*position:fixed/.test(mobile));
  check('mobile dark-mode toggle uses theme-aware ink color, not the desktop-only white-on-dark styling',
        /\.mobile-dark-btn\{[^}]*color:var\(--ink\)/.test(mobile));
  check('pinned list panel goes full-width on mobile', /#pinnedListPanel\{[^}]*width:100vw/.test(mobile));
  check('the desktop margin-push for the pinned panel is cancelled on mobile',
        /\.main:has\(\+ #pinnedListPanel\.open\)\{\s*margin-right:0/.test(mobile));

  // Desktop must be unchanged: the original (unguarded) margin-push rule
  // still exists once, outside any @media block.
  const desktop = style.split('@media')[0];
  check('desktop still pushes .main when the panel is pinned open',
        /\.main:has\(\+ #pinnedListPanel\.open\)\{margin-right:360px/.test(desktop));
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
  const win = loadApp();
  check('backup coverage is still complete',
        win.__t.SYNCED_TABLES.every(x => win.__t.BACKED_UP_TABLES.includes(x)));
}

(async () => {
  mutualExclusivity();
  immediateDomUpdate();
  tipRotationInterval();
  quickAddClosesAfterPick();
  mobileCssFixes();
  versionDiscipline();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
