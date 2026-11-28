/* v4.78.0: Start set timer (exact rest, rest keeps counting after the timer),
   Review Pack lists sessions lower than last time and asks for the reason,
   the pack plans 7 days, and import removes every exercise without a done set
   (on every device) plus old sessions on days the new plan leaves empty.
   All data invented. */
const { loadApp } = require('./harness');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) pass++; else { fail++; console.log('  FAIL', n, d === undefined ? '' : d); } };

function setup() {
  const win = loadApp(); const t = win.__t;
  win.matchMedia = (q) => ({ matches: true, media: q, addListener() {}, removeListener() {} });
  if (!win.document.getElementById('mainContent')) { const m = win.document.createElement('div'); m.id = 'mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = () => {};
  win.confirm = () => true; win.window.confirm = () => true;
  t.state.settings.healthCoreMetricsSeeded = true;
  t.state.training.exercises = [
    { id: 'LP', name: 'Leg Press', category: 'strength', muscleGroupsPrimary: ['quads'], weightIncrementKg: 10, tagIds: [] },
    { id: 'CP', name: 'Chest Press', category: 'strength', muscleGroupsPrimary: ['chest'], weightIncrementKg: 2.5, tagIds: [] },
    { id: 'PU', name: 'Push Up', category: 'strength', muscleGroupsPrimary: ['chest'], tagIds: [] },
  ];
  let txt = '';
  win.navigator.clipboard = { writeText: (x) => { txt = x; return Promise.resolve(); } };
  return { win, t, today: win.todayStr(), prompt: () => { win.copyTrainingReviewPack(); return txt; } };
}
const mk = (o) => Object.assign({ reps: 10, weightKg: 40, done: false, rir: null, toFailure: false, isWarmup: false, restTakenSec: null, loggedAt: null }, o);

// ---- 1. Start set: the set's start and the exact rest
{ const { win, t, today } = setup();
  let now = Date.parse(today + 'T10:00:00');
  const RealDate = win.Date; // fake clock for both Date.now() and new Date()
  win.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
  t.state.training.sets = [mk({ date: today, exerciseId: 'CP', setNo: 1 }), mk({ date: today, exerciseId: 'CP', setNo: 2 }), mk({ date: today, exerciseId: 'CP', setNo: 3 })];
  const box = win.document.createElement('div'); box.className = 'mw';
  const disp = win.document.createElement('div'); disp.id = 'restTimerDisplay'; box.appendChild(disp); win.document.body.appendChild(box);
  win._updateRestTimerUI();
  check('idle phone box offers Start set', disp.innerHTML.includes('Start set') && disp.innerHTML.includes('data-mode="idle"'), disp.innerHTML);
  win.startSetTimer();
  now += 40000;
  win._updateRestTimerUI();
  check('set running: box counts the set up', disp.innerHTML.includes('data-mode="set"') && (win.document.getElementById('restTimerCount') || {}).textContent === '0:40', disp.innerHTML);
  win.setSetMode(today, 'CP', 1, 'rir', 2);
  const s1 = t.state.training.sets.find(s => s.setNo === 1);
  check('set 1 started at the Start set tap', s1.done && s1.startedAt && Date.parse(s1.startedAt) === Date.parse(today + 'T10:00:00'), s1.startedAt);
  check('first set of a workout: no rest', s1.restTakenSec == null, s1.restTakenSec);
  check('after the set: rest counts down', disp.innerHTML.includes('data-mode="rest"'), disp.innerHTML);
  now += 200000; // past the 90 s timer
  win._updateRestTimerUI();
  check('rest timer ran out: keeps counting the rest', disp.innerHTML.includes('data-mode="over"') && (win.document.getElementById('restTimerCount') || {}).textContent === '3:20' && disp.innerHTML.includes('Start set'), disp.innerHTML);
  win.startSetTimer();
  now += 30000;
  win.setSetMode(today, 'CP', 2, 'rir', 1);
  const s2 = t.state.training.sets.find(s => s.setNo === 2);
  check('set 2: rest = previous set end to Start set (200 s)', s2.restTakenSec === 200, s2.restTakenSec);
  check('set 2: start = the Start set tap', Date.parse(s2.startedAt) === Date.parse(today + 'T10:00:00') + 240000, s2.startedAt);
  // without Start set the old way still works: rest = gap between ticks
  now += 100000;
  win.setSetMode(today, 'CP', 3, 'rir', 1);
  const s3 = t.state.training.sets.find(s => s.setNo === 3);
  check('no Start set: rest is still the gap between ticks', s3.done && s3.restTakenSec === 100, s3.restTakenSec);
  win.stopRestTimer();
  check('timer stopped: phone box back to Start set', disp.innerHTML.includes('data-mode="idle"'), disp.innerHTML);
  // a desktop box (not inside the phone workout) stays empty when idle
  box.remove();
  const d2 = win.document.createElement('div'); d2.id = 'restTimerDisplay'; win.document.body.appendChild(d2);
  win._updateRestTimerUI();
  check('desktop: idle box stays empty', d2.innerHTML === '', d2.innerHTML);
}

// ---- 2. Lower than last time
{ const { win, t, today, prompt } = setup();
  const d = (n) => win.addDays(today, n);
  t.state.training.sets = [
    // Leg Press: 100x10 then 100x9 (one rep fewer = about 2.5% lower): listed
    mk({ date: d(-10), exerciseId: 'LP', setNo: 1, weightKg: 100, reps: 10, done: true, rir: 1, restTakenSec: 120 }),
    mk({ date: d(-3), exerciseId: 'LP', setNo: 1, weightKg: 100, reps: 9, done: true, rir: 1, restTakenSec: 60 }),
    mk({ date: d(-3), exerciseId: 'LP', setNo: 2, weightKg: 100, isWarmup: true, reps: 12, done: true }),
    // Chest Press: same best set, fewer sets (volume lower, performance not): not listed
    mk({ date: d(-9), exerciseId: 'CP', setNo: 1, weightKg: 40, reps: 10, done: true }),
    mk({ date: d(-9), exerciseId: 'CP', setNo: 2, weightKg: 40, reps: 10, done: true }),
    mk({ date: d(-2), exerciseId: 'CP', setNo: 1, weightKg: 40, reps: 10, done: true }),
    mk({ date: d(-2), exerciseId: 'CP', setNo: 2, weightKg: 42.5, reps: 0, done: false }),
    // Push Up (bodyweight): 20 reps then 15: listed by reps
    mk({ date: d(-8), exerciseId: 'PU', setNo: 1, weightKg: null, reps: 20, done: true }),
    mk({ date: d(-1), exerciseId: 'PU', setNo: 1, weightKg: null, reps: 15, done: true }),
    // a drop before the review window is not listed
    mk({ date: d(-60), exerciseId: 'CP', setNo: 1, weightKg: 50, reps: 10, done: true }),
    mk({ date: d(-50), exerciseId: 'CP', setNo: 1, weightKg: 40, reps: 10, done: true }),
  ];
  const list = win.lowerThanLastTime(d(-30));
  const lp = list.find(x => x.exercise === 'Leg Press');
  check('drop listed: one rep fewer on the best set', !!lp && lp.date === d(-3) && lp.previousDate === d(-10) && lp.changePct <= -2, JSON.stringify(list));
  check('drop carries both best sets and rests', !!lp && lp.bestSet.reps === 9 && lp.previousBestSet.reps === 10 && lp.avgRestSec === 60 && lp.previousAvgRestSec === 120, JSON.stringify(lp));
  check('warm-ups ignored', !!lp && lp.workingSets === 1, JSON.stringify(lp));
  check('fewer sets at the same best set is not a drop', !list.some(x => x.exercise === 'Chest Press'), JSON.stringify(list));
  const pu = list.find(x => x.exercise === 'Push Up');
  check('bodyweight drop compared by reps', !!pu && pu.measure === 'best set reps' && pu.changePct === -25, JSON.stringify(pu));
  const p = prompt();
  check('pack carries lowerThanLastTime', p.includes('"lowerThanLastTime"') && p.includes('"previousBestSet"'));
  check('prompt asks for the reason and patterns', p.includes('Lower than last time: find the reason') && p.includes('no clear reason in the data') && p.includes('resting heart rate'));
  check('prompt: 7-day plan', p.includes('actual next 7 days') && p.includes('7-day plan as a CalendarOS import file') && !p.includes('two-week plan'));
  check('changelog has 4.78.0 with the SQL line', t.CHANGELOG.some(c => c.v === '4.78.0' && /No SQL migration needed/.test(c.changes[0])));
}

// ---- 3. Pack window: 7 days
{ const { win, t, today } = setup();
  t.state.training.sessions = [{ id: 'S1', name: 'Push', type: 'strength', blocks: [{ exerciseId: 'CP', sets: 3, reps: '8-12' }] },
    { id: 'S2', name: 'Legs', type: 'strength', blocks: [{ exerciseId: 'LP', sets: 3, reps: '8-12' }] }];
  t.state.training.calendar = [{ date: win.addDays(today, 6), sessionId: 'S1' }, { date: win.addDays(today, 7), sessionId: 'S2' }];
  const pack = win.buildTrainingReviewPack();
  check('schedule: today and the next 6 days', pack.trainingSchedule.length === 7 && pack.trainingSchedule[6].date === win.addDays(today, 6));
  check('plan: a session 6 days ahead is in, 7 days ahead is out', pack.currentPlan.some(x => x.name === 'Push') && !pack.currentPlan.some(x => x.name === 'Legs'), JSON.stringify(pack.currentPlan));
}

// ---- 4. Import clean-up
{ const { win, t, today } = setup();
  const d = (n) => win.addDays(today, n);
  t.state.training.sessions = [{ id: 'OLD', name: 'Old', type: 'strength', blocks: [{ exerciseId: 'CP', sets: 3, reps: '8-12' }] },
    { id: 'NEW', name: 'New', type: 'strength', blocks: [{ exerciseId: 'LP', sets: 3, reps: '8-12' }] }];
  t.state.training.calendar = [{ date: d(1), sessionId: 'OLD' }, { date: d(2), sessionId: 'OLD' }, { date: d(3), sessionId: 'OLD' }, { date: d(10), sessionId: 'OLD' }, { date: d(-2), sessionId: 'OLD' }];
  t.state.training.sets = [
    mk({ date: d(1), exerciseId: 'CP', setNo: 1 }), mk({ date: d(1), exerciseId: 'CP', setNo: 2 }),
    mk({ date: d(1), exerciseId: 'PU', setNo: 1, done: true, loggedAt: new Date().toISOString() }),
    mk({ date: d(2), exerciseId: 'CP', setNo: 1 }),
    mk({ date: d(3), exerciseId: 'CP', setNo: 1, done: true, loggedAt: new Date().toISOString() }),
    mk({ date: d(-2), exerciseId: 'CP', setNo: 1 }),
  ];
  t.state.training.logs = [{ date: d(1), exerciseId: 'LP', completed: false }]; // logged row, no done set
  t.state.trainingPendingAdds[d(1)] = ['CP', 'LP'];
  t.pendingTrainingDeletes.length = 0;
  const res = win.buildImportResolution({ exercises: [], sessions: [{ id: 'NEW', name: 'New', type: 'strength', blocks: [{ exerciseId: 'LP', sets: 3, reps: '8-12' }] }],
    calendar: [{ date: d(1), sessionId: 'NEW' }] });
  win.applyTrainingImportResolution(res);
  const sets = t.state.training.sets;
  check('covered date: not-done sets removed', !sets.some(s => s.date === d(1) && !s.done), JSON.stringify(sets.filter(s => s.date === d(1))));
  check('covered date: done set kept', sets.some(s => s.date === d(1) && s.exerciseId === 'PU' && s.done));
  check('covered date: logged exercise with no done set removed', !t.state.training.logs.some(l => l.date === d(1) && l.exerciseId === 'LP'));
  check('covered date: staged exercises cleared', !(t.state.trainingPendingAdds[d(1)] || []).length);
  check('covered date: deletes queued for the cloud', t.pendingTrainingDeletes.some(x => x.table === 'training_sets' && x.match.log_date === d(1) && x.match.exercise_id === 'CP'), JSON.stringify(t.pendingTrainingDeletes));
  check('covered date: new session mapped', (t.state.training.calendar.find(c => c.date === d(1)) || {}).sessionId === 'NEW');
  check('empty day in the window: old session and sets removed', !t.state.training.calendar.some(c => c.date === d(2)) && !sets.some(s => s.date === d(2))
    && t.pendingTrainingDeletes.some(x => x.table === 'training_calendar' && x.match.cal_date === d(2)));
  check('empty day with a done set: session kept', t.state.training.calendar.some(c => c.date === d(3) && c.sessionId === 'OLD') && sets.some(s => s.date === d(3) && s.done));
  check('day after the 7-day window: untouched', t.state.training.calendar.some(c => c.date === d(10) && c.sessionId === 'OLD'));
  check('past day: untouched', t.state.training.calendar.some(c => c.date === d(-2)) && sets.some(s => s.date === d(-2)));
}

console.log(`test_v4780: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
