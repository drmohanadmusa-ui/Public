/* v4.39.0 — shift the next occurrence of a recurring task by N days.

   Built on the existing rescheduleExceptions mechanism. The interesting
   properties are that only ONE occurrence moves, that the original date stops
   being due (rather than being papered over with a 'missed' mark), and that
   existing history keeps rendering exactly as it did. */
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }

/* A weekly Monday task. Dates are derived from the app's own todayStr() so
   nothing here hardcodes a date and rots. */
function appWithWeekly() {
  const win = loadApp();
  const t = win.__t;
  t.state.settings.locations = ['Site A', 'Site B'];
  t.state.settings.silos = ['Alpha', 'Beta'];
  // Walk forward to the next Monday so the fixture is deterministic.
  let d = win.todayStr();
  for (let i = 0; i < 8; i++) {
    const cand = win.addDays(win.todayStr(), i);
    if (win.parseDate(cand).getDay() === 1) { d = cand; break; }
  }
  t.state.tasks.recurring = [{
    id: 'R1', name: 'Weekly report', type: 'Weekly', detail: 'Monday',
    location: 'Site A', silo: 'Alpha', priority: 'High', notes: '',
    start: win.addDays(win.todayStr(), -60), end: '', rescheduleExceptions: [],
  }];
  t.state.tasks.completions = {};
  win.document.getElementById('app').classList.remove('hidden');
  return { win, task: t.state.tasks.recurring[0], nextMonday: d };
}
const task = win => win.__t.state.tasks.recurring[0];

/* ---------- 1. The shift itself ---------- */
async function shiftMovesOnlyOne() {
  section('1. Shifting moves exactly one occurrence');
  const { win, nextMonday } = appWithWeekly();
  const before = win.nextOccurrenceDate(task(win));
  check('the next occurrence is the coming Monday', before === nextMonday, `${before} vs ${nextMonday}`);

  const res = await win.shiftNextOccurrence('R1', 2);
  check('the shift reports the move', res && res.from === before && res.to === win.addDays(before, 2),
        JSON.stringify(res));
  check('the next occurrence is now two days later',
        win.nextOccurrenceDate(task(win)) === win.addDays(before, 2),
        win.nextOccurrenceDate(task(win)));
  check('the original date is no longer due',
        win.isEffectivelyDueOn(task(win), before) === false);
  check('the moved-to date IS due',
        win.isEffectivelyDueOn(task(win), win.addDays(before, 2)) === true);
  check('the following week is untouched',
        win.isEffectivelyDueOn(task(win), win.addDays(before, 7)) === true);
  check('exactly one exception is stored', task(win).rescheduleExceptions.length === 1,
        JSON.stringify(task(win).rescheduleExceptions));
}

/* ---------- 2. A future shift must not count as missed ---------- */
async function futureShiftIsNotMissed() {
  section('2. A future occurrence is not marked missed');
  const { win } = appWithWeekly();
  const before = win.nextOccurrenceDate(task(win));
  await win.shiftNextOccurrence('R1', 3);
  check('no completion record was written for the original date',
        !win.isMissedOn('R1', before), JSON.stringify(win.__t.state.tasks.completions));
  check('on-time stats are unaffected', win.computeOnTimeStats(task(win)) === null,
        JSON.stringify(win.computeOnTimeStats(task(win))));
}

/* ---------- 3. Repeated shifts do not chain ---------- */
async function repeatedShiftsCollapse() {
  section('3. Shifting repeatedly rewrites the move rather than stacking');
  const { win } = appWithWeekly();
  const original = win.nextOccurrenceDate(task(win));
  await win.shiftNextOccurrence('R1', 2);
  await win.shiftNextOccurrence('R1', 1);
  await win.shiftNextOccurrence('R1', 1);
  const ex = task(win).rescheduleExceptions;
  check('still only one exception', ex.length === 1, JSON.stringify(ex));
  check('it still points back at the original date', ex[0].from === original, JSON.stringify(ex[0]));
  check('the next occurrence is four days on',
        win.nextOccurrenceDate(task(win)) === win.addDays(original, 4),
        win.nextOccurrenceDate(task(win)));
  check('the task shows on exactly one date in the window', (() => {
    let count = 0;
    for (let i = 0; i < 7; i++) if (win.isEffectivelyDueOn(task(win), win.addDays(original, i))) count++;
    return count === 1;
  })());
}

/* ---------- 4. Undo ---------- */
async function undoRestores() {
  section('4. Undo puts the occurrence back');
  const { win } = appWithWeekly();
  const original = win.nextOccurrenceDate(task(win));
  await win.shiftNextOccurrence('R1', 3);
  const moved = win.nextOccurrenceDate(task(win));
  const ex = await win.clearRescheduleForOccurrence('R1', moved);
  check('undo reports the exception it removed', ex && ex.from === original, JSON.stringify(ex));
  check('no exceptions remain', task(win).rescheduleExceptions.length === 0);
  check('the next occurrence is back on the original date',
        win.nextOccurrenceDate(task(win)) === original);
  check('the moved-to date is no longer due',
        win.isEffectivelyDueOn(task(win), moved) === false);
}

/* ---------- 5. Guards ---------- */
async function guards() {
  section('5. Refused shifts');
  const { win } = appWithWeekly();
  const original = win.nextOccurrenceDate(task(win));

  const past = await win.shiftNextOccurrence('R1', -400);
  check('a shift into the past is refused', past === null);
  check('nothing was stored', task(win).rescheduleExceptions.length === 0);

  const zero = await win.shiftNextOccurrence('R1', 0);
  check('a zero-day shift is refused', zero === null);
  const nan = await win.shiftNextOccurrence('R1', 'abc');
  check('a non-numeric shift is refused', nan === null);

  task(win).end = win.addDays(original, 1);
  const pastEnd = await win.shiftNextOccurrence('R1', 5);
  check('a shift past the end date is refused', pastEnd === null);
  check('still nothing stored', task(win).rescheduleExceptions.length === 0);

  const missing = await win.shiftNextOccurrence('NOPE', 1);
  check('an unknown task is refused', missing === null);
}

/* ---------- 6. Existing history keeps rendering as before ---------- */
async function existingHistoryUnchanged() {
  section('6. Reschedules that already logged a result are untouched');
  const { win } = appWithWeekly();
  const t = task(win);
  // Use the actual last Monday — today-7 can be any day of the week, and
  // isDueOn('Weekly on Monday') is correctly false on a non-Monday date.
  let lastMonday = win.todayStr();
  for(let i=0;i<14;i++){
    const d=win.addDays(win.todayStr(),-i);
    if(win.parseDate(d).getDay()===1){ lastMonday=d; break; }
  }
  // An old-style reschedule: exception recorded AND the origin marked missed.
  t.rescheduleExceptions = [{ from: lastMonday, to: win.addDays(lastMonday, 2) }];
  win.__t.state.tasks.completions = { R1: { [lastMonday]: { status: 'missed', loggedAt: new Date().toISOString() } } };

  check('the origin still reports as due, as it did before',
        win.isEffectivelyDueOn(t, lastMonday) === true,
        `lastMonday=${lastMonday} dow=${win.parseDate(lastMonday).getDay()}`);
  check('it still reads as missed', win.isMissedOn('R1', lastMonday) === true);
  check('the missed record still counts in the stats',
        win.computeOnTimeStats(t) && win.computeOnTimeStats(t).total === 1,
        JSON.stringify(win.computeOnTimeStats(t)));
}

/* ---------- 7. The Next tag honours reschedules ---------- */
async function nextTagHonoursReschedules() {
  section('7. The "Next" tag reflects a moved occurrence');
  const { win } = appWithWeekly();
  const t = win.__t;
  t.state.view = 'tasks';
  t.state.tasksTab = 'recurring';
  const original = win.nextOccurrenceDate(task(win));
  await win.shiftNextOccurrence('R1', 2);
  win.render();
  const html = win.document.getElementById('app').innerHTML;
  check('the row shows the moved date',
        html.includes(win.humanDate(win.addDays(original, 2))),
        win.humanDate(win.addDays(original, 2)));
  check('the row no longer advertises the original date',
        !html.includes(`Next: ${win.humanDate(original)}`));
  check('an Undo control is offered while shifted', html.includes('undoNextOccurrenceShift'));
}

/* ---------- 8. UI wiring ---------- */
async function uiWiring() {
  section('8. Shift controls render and are wired up');
  const { win } = appWithWeekly();
  const t = win.__t;
  t.state.view = 'tasks';
  t.state.tasksTab = 'recurring';
  win.render();
  const html = win.document.getElementById('app').innerHTML;
  check('the shift row is present', html.includes('next-shift-row'));
  check('the input exists with the expected id', !!win.document.getElementById('shiftDays_R1'));
  check('the Shift button calls the handler', html.includes("shiftNextOccurrenceFromInput('R1'"));
  check('no Undo is offered when nothing is shifted', !html.includes('undoNextOccurrenceShift'));
  check('the shift row stops the click from opening the edit modal',
        html.includes('next-shift-row" onclick="event.stopPropagation();'));

  // Drive it through the input, the way the button does.
  const original = win.nextOccurrenceDate(task(win));
  win.document.getElementById('shiftDays_R1').value = '4';
  await win.shiftNextOccurrenceFromInput('R1', 'shiftDays_R1');
  check('shifting via the input works',
        win.nextOccurrenceDate(task(win)) === win.addDays(original, 4),
        win.nextOccurrenceDate(task(win)));

  // One-time tasks must not grow a shift row.
  t.state.tasksTab = 'oneTime';
  t.state.tasks.oneTime = [{ id: 'T1', name: 'Pay invoice', location: 'Site A', silo: 'Alpha', priority: 'High', due: win.todayStr(), done: false, doneDate: null, notes: '', dueHistory: [] }];
  win.render();
  check('one-time tasks have no shift row',
        !win.document.getElementById('app').innerHTML.includes('next-shift-row'));
}

/* ---------- 9. Sync shape is unchanged ---------- */
async function syncShapeUnchanged() {
  section('9. Nothing new is stored or synced');
  const { win } = appWithWeekly();
  win.__t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
  await win.shiftNextOccurrence('R1', 2);
  const row = win.recurringToRow(task(win));
  check('the exception travels in the existing column',
        Array.isArray(row.reschedule_exceptions) && row.reschedule_exceptions.length === 1,
        JSON.stringify(row.reschedule_exceptions));
  const back = win.rowToRecurring(row);
  check('it round-trips back', back.rescheduleExceptions.length === 1,
        JSON.stringify(back.rescheduleExceptions));
  check('no new synced table was introduced', win.__t.SYNCED_TABLES.length === 18, String(win.__t.SYNCED_TABLES.length));
  check('backup coverage is still complete',
        win.__t.SYNCED_TABLES.every(x => win.__t.BACKED_UP_TABLES.includes(x)));
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
  check('no duplicate next-occurrence helper was left behind',
        (js.match(/function nextOccurrence\w*\(/g) || []).length === 1,
        JSON.stringify(js.match(/function nextOccurrence\w*\(/g)));
}

(async () => {
  await shiftMovesOnlyOne();
  await futureShiftIsNotMissed();
  await repeatedShiftsCollapse();
  await undoRestores();
  await guards();
  await existingHistoryUnchanged();
  await nextTagHonoursReschedules();
  await uiWiring();
  await syncShapeUnchanged();
  versionDiscipline();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
