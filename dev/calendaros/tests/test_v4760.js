/* v4.76.0: gym locations (library, pickers, Review Pack, sync), move/swap
   clears not-done training, Plan day removed, phone screen shows last time's
   numbers inside each box (Target line, "Exercise N of M" and the new-weight
   banner removed). All data invented. */
const fs = require('fs');
const { loadApp } = require('./harness');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) pass++; else { fail++; console.log('  FAIL', n, d === undefined ? '' : d); } };

function setup(mobile) {
  const win = loadApp(); const t = win.__t;
  win.matchMedia = (q) => ({ matches: !!mobile, media: q, addListener() {}, removeListener() {} });
  if (!win.document.getElementById('mainContent')) { const m = win.document.createElement('div'); m.id = 'mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = () => {};
  win.confirm = () => true; win.window.confirm = () => true;
  t.state.settings.healthCoreMetricsSeeded = true;
  t.state.training.exercises = [
    { id: 'CPA', name: 'Chest Press A', category: 'strength', muscleGroupsPrimary: ['chest'], weightIncrementKg: 2.5, tagIds: [], locationId: 'locA' },
    { id: 'CPB', name: 'Chest Press B', category: 'strength', muscleGroupsPrimary: ['chest'], weightIncrementKg: 5, tagIds: [], locationId: 'locB' },
    { id: 'PU', name: 'Push Up', category: 'strength', muscleGroupsPrimary: ['chest'], weightIncrementKg: 2.5, tagIds: [], locationId: 'everywhere' },
    { id: 'FLY', name: 'Cable Fly', category: 'strength', muscleGroupsPrimary: ['chest'], weightIncrementKg: 2.5, tagIds: [] },
  ];
  let txt = '';
  win.navigator.clipboard = { writeText: (x) => { txt = x; return Promise.resolve(); } };
  return { win, t, today: win.todayStr(), prompt: () => { win.copyTrainingReviewPack(); return txt; } };
}
const LOCS = (periods, defaultId) => ({ list: [{ id: 'locA', name: 'Site A' }, { id: 'locB', name: 'Site B' }], defaultId: defaultId === undefined ? 'locA' : defaultId, periods: periods || [] });

(async () => {
  // ---- 1. no locations set up: nothing filters, nothing warns
  { const { win, t } = setup();
    check('off: every exercise available', t.state.training.exercises.every(e => win.exerciseAtLocation(e, null)));
    check('off: no exercises flagged', win.exercisesWithoutLocation().length === 0);
    const h = win.renderTrainingExercisesSubpage();
    check('off: no warning or location chips', !h.includes('no location') && !h.includes('All locations'));
  }

  // ---- 2. helpers
  { const { win, t, today } = setup();
    t.state.settings.gymLocations = LOCS([{ from: win.addDays(today, 5), to: win.addDays(today, 9), locationId: 'locB' }]);
    check('usual location on other dates', win.locationForDate(today) === 'locA');
    check('away period wins inside its dates', win.locationForDate(win.addDays(today, 5)) === 'locB' && win.locationForDate(win.addDays(today, 9)) === 'locB');
    check('back to usual after the period', win.locationForDate(win.addDays(today, 10)) === 'locA');
    const ex = id => t.state.training.exercises.find(e => e.id === id);
    check('at location: own location yes', win.exerciseAtLocation(ex('CPA'), 'locA'));
    check('at location: other location no', !win.exerciseAtLocation(ex('CPB'), 'locA'));
    check('at location: Everywhere yes', win.exerciseAtLocation(ex('PU'), 'locB'));
    check('at location: no location never', !win.exerciseAtLocation(ex('FLY'), 'locA'));
    check('no-location list', win.exercisesWithoutLocation().map(e => e.id).join() === 'FLY');
    t.state.training.exercises.push({ id: 'X', name: 'Old', category: 'strength', muscleGroupsPrimary: ['chest'], locationId: 'deleted' });
    check('a deleted location counts as no location', win.exercisesWithoutLocation().some(e => e.id === 'X'));
    t.state.settings.gymLocations = LOCS([], null);
    check('no usual location -> date has none', win.locationForDate(today) === null);
  }

  // ---- 3. library: warning, badge, filter; locations manager
  { const { win, t } = setup();
    t.state.settings.gymLocations = LOCS();
    let h = win.renderTrainingExercisesSubpage();
    check('library: warning names the count', /1 exercise has no location/.test(h), h.slice(0, 600));
    check('library: location badge', h.includes('📍 Site A') && h.includes('📍 Everywhere'));
    check('library: No location badge', h.includes('>No location</span>'));
    check('library: filter chips', h.includes('All locations') && h.includes('>Site B<'));
    t.state.exerciseLocFilter = 'locB';
    h = win.renderTrainingExercisesSubpage();
    check('library: filter shows only that location', h.includes('Chest Press B') && !h.includes('Chest Press A') && !h.includes('Cable Fly'));
    t.state.exerciseLocFilter = 'none';
    h = win.renderTrainingExercisesSubpage();
    check('library: No location filter', h.includes('Cable Fly') && !h.includes('Push Up'));
    t.state.exerciseLocFilter = 'all';
    win.openGymLocationsModal();
    const m = win.document.getElementById('gymLocOverlay');
    check('manager: lists locations and the next 7 days', !!m && m.innerHTML.includes('Site B') && m.innerHTML.includes('Next 7 days'));
    win.document.getElementById('newGymLocName').value = 'Site C';
    await win.addGymLocation();
    check('manager: add location', win.gymLocs().list.some(l => l.name === 'Site C'));
    win.document.getElementById('newGymLocName').value = 'site c';
    await win.addGymLocation();
    check('manager: no duplicate names', win.gymLocs().list.filter(l => l.name.toLowerCase() === 'site c').length === 1);
    await win.deleteGymLocation('locA');
    check('manager: deleting the usual location picks another', win.gymLocs().defaultId === 'locB' && !win.gymLocs().list.some(l => l.id === 'locA'));
    check('manager: deleting a location leaves its exercises unlocated', win.exercisesWithoutLocation().some(e => e.id === 'CPA'));
  }

  // ---- 4. first location becomes the usual one
  { const { win, t } = setup();
    win.openGymLocationsModal();
    win.document.getElementById('newGymLocName').value = 'Site A';
    await win.addGymLocation();
    check('first location is the usual one', win.gymLocs().defaultId && win.gymLocs().list[0].id === win.gymLocs().defaultId);
  }

  // ---- 5. pickers: Add exercise and Swap use the day's location
  { const { win, t, today } = setup(true);
    t.state.settings.gymLocations = LOCS();
    win.openQuickAddExerciseModal(today);
    win.filterQuickAddExercisePicker(today);
    let r = win.document.getElementById('quickAddExResults').innerHTML;
    check('add: own location and Everywhere only', r.includes('Chest Press A') && r.includes('Push Up') && !r.includes('Chest Press B') && !r.includes('Cable Fly'), r.slice(0, 300));
    win.document.getElementById('quickAddAllLocs').checked = true;
    win.filterQuickAddExercisePicker(today);
    r = win.document.getElementById('quickAddExResults').innerHTML;
    check('add: show all locations', r.includes('Chest Press B') && r.includes('Cable Fly'));
    win.closeQuickAddExerciseModal();
    const ids = win.mwSwapCandidates(today, 'CPA').map(e => e.id).join();
    check('swap: same location + Everywhere', ids === 'PU', ids);
    check('swap: show all', win.mwSwapCandidates(today, 'CPA', true).length === 3);
  }

  // ---- 6. Review Pack
  { const { win, t, today, prompt } = setup();
    t.state.settings.gymLocations = LOCS();
    // the library the AI plans from sits between these two headings (usage data elsewhere stays complete)
    const lib = (x) => { const a = x.indexOf('MY EXERCISE LIBRARY'), b = x.indexOf('MY DATA PACK'); return a >= 0 && b > a ? x.slice(a, b) : ''; };
    let p = prompt();
    check('pack: LOCATIONS rule', p.includes('LOCATIONS (hard constraint)'));
    check('pack: every date has its location', (p.match(/"location": "Site A"/g) || []).length >= 14);
    check('pack: library section found', lib(p).length > 50);
    check('pack: other location left out', !lib(p).includes('Chest Press B'));
    check('pack: no-location exercise left out and counted', !lib(p).includes('Cable Fly') && p.includes('1 of my exercises have no location'));
    check('pack: Everywhere exercise kept', lib(p).includes('Push Up') && lib(p).includes('"location": "Everywhere"'));
    t.state.settings.gymLocations = LOCS([{ from: win.addDays(today, 3), to: win.addDays(today, 30), locationId: 'locB' }]);
    p = prompt();
    check('pack: away period in the next 7 days brings its machines', lib(p).includes('Chest Press B') && p.includes('"location": "Site B"'));
    t.state.settings.gymLocations = null;
    p = prompt();
    check('pack: no locations -> no rule, full library', !p.includes('LOCATIONS (hard constraint)') && lib(p).includes('Cable Fly') && !lib(p).includes('"location"'));
  }

  // ---- 7. move a day: not-done training cleared, done sets stay, new date loads its plan
  { const { win, t, today } = setup();
    const A = win.addDays(today, 1), B = win.addDays(today, 3);
    t.state.training.sessions = [{ id: 'S1', name: 'Push', type: 'strength', blocks: [{ exerciseId: 'CPA', sets: 3, reps: '8-12' }] }];
    t.state.training.calendar = [{ date: A, sessionId: 'S1' }];
    t.state.trainingPendingAdds = { [A]: ['CPA', 'PU'] };
    t.state.training.sets = [
      { date: A, exerciseId: 'CPA', setNo: 1, weightKg: 40, reps: 12, done: false, isWarmup: false },
      { date: A, exerciseId: 'PU', setNo: 1, weightKg: 0, reps: 15, done: true, isWarmup: false },
      { date: A, exerciseId: 'PU', setNo: 2, weightKg: 0, reps: 15, done: false, isWarmup: false },
    ];
    await win.moveTrainingDayMapping(A, B);
    const onA = t.state.training.sets.filter(s => s.date === A);
    check('move: not-done sets cleared from the old date', !onA.some(s => !s.done), JSON.stringify(onA));
    check('move: done set stays on the old date', onA.length === 1 && onA[0].exerciseId === 'PU');
    check('move: old date shows only what was done', win.getTrainingDayExerciseIds(A).join() === 'PU', win.getTrainingDayExerciseIds(A).join());
    check('move: calendar moved', !!win.getTrainingCalEntry(B) && !win.getTrainingCalEntry(A));
    win.renderTrainingDayCard(B);
    check('move: new date loads the moved plan', win.getTrainingDayExerciseIds(B).includes('CPA'));
  }

  // ---- 8. swap two days: both dates cleared and re-loaded
  { const { win, t, today } = setup();
    const A = win.addDays(today, 1), B = win.addDays(today, 2);
    t.state.training.sessions = [
      { id: 'S1', name: 'Push', type: 'strength', blocks: [{ exerciseId: 'CPA', sets: 3, reps: '8-12' }] },
      { id: 'S2', name: 'Other', type: 'strength', blocks: [{ exerciseId: 'PU', sets: 3, reps: '8-12' }] },
    ];
    t.state.training.calendar = [{ date: A, sessionId: 'S1' }, { date: B, sessionId: 'S2' }];
    t.state.trainingPendingAdds = { [A]: ['CPA'], [B]: ['PU'] };
    t.state.training.sets = [{ date: A, exerciseId: 'CPA', setNo: 1, weightKg: 40, reps: 12, done: false, isWarmup: false }];
    win.openSwapDaysModal();
    win.document.getElementById('swapDayA').value = A;
    win.document.getElementById('swapDayB').value = B;
    win.submitSwapDays();
    check('swap: old staged exercises gone', win.getTrainingDayExerciseIds(A).length === 0 && win.getTrainingDayExerciseIds(B).length === 0);
    check('swap: empty sets gone', !t.state.training.sets.some(s => s.date === A && !s.done));
    win.renderTrainingDayCard(A); win.renderTrainingDayCard(B);
    check('swap: each date shows its new plan', win.getTrainingDayExerciseIds(A).join() === 'PU' && win.getTrainingDayExerciseIds(B).join() === 'CPA',
      win.getTrainingDayExerciseIds(A).join() + '|' + win.getTrainingDayExerciseIds(B).join());
  }

  // ---- 9. Plan day removed
  { const { win } = setup();
    const src = fs.readFileSync('./CalendarOS.html', 'utf8');
    check('Plan day: no button or function left', !src.includes('openPlanDayModal') && typeof win.openPlanDayModal === 'undefined');
  }

  // ---- 10. phone screen: last time inside each box, removed lines gone
  { const { win, t, today } = setup(true);
    const last = win.addDays(today, -4);
    t.state.training.sets = [
      { date: last, exerciseId: 'CPA', setNo: 1, weightKg: 42.5, reps: 12, rir: 2, done: true, isWarmup: false },
      { date: last, exerciseId: 'CPA', setNo: 2, weightKg: 42.5, reps: 11, rir: 1, done: true, isWarmup: false },
      { date: last, exerciseId: 'CPA', setNo: 3, weightKg: 42.5, reps: 9, rir: 0, toFailure: true, done: true, isWarmup: false },
    ];
    t.state.training.sessions = [{ id: 'S1', name: 'Push', type: 'strength', blocks: [{ exerciseId: 'CPA', sets: 3, reps: '8-12', notes: 'suggested starting weight: 45kg' }] }];
    t.state.training.calendar = [{ date: today, sessionId: 'S1' }];
    t.state.trainingSelectedDate = today; t.state.trainingSection = 'today'; t.state.view = 'training';
    t.state.settings.mobileWorkoutBeta = true;
    const h = win.renderTrainingView();
    check('phone: no EXERCISE N OF M', !/EXERCISE \d+ OF \d+/.test(h));
    check('phone: no Target line', !h.includes('mw-target') && !h.includes('Target 3'));
    check('phone: no new-weight banner', !h.includes('mw-newweight'));
    check('phone: last weight in the box', h.includes('<small class="mw-last">last 42.5</small>'));
    check('phone: last reps per set', h.includes('last 12</small>') && h.includes('last 11</small>') && h.includes('last 9</small>'));
    check('phone: last RIR, F for a failure set', h.includes('last 2</small>') && h.includes('last 1</small>') && h.includes('last F</small>'));
    const rows = h.split('class="mw-set ').slice(1);
    const warm = rows.filter(r => r.startsWith('done warm') || / warm"/.test(r.slice(0, 20)) || r.slice(0, 15).includes('warm'));
    check('phone: warm-up rows show no last', warm.every(r => !r.split('</div>\n      </div>')[0].includes('mw-last')));
    check('phone: 3 working sets x 3 boxes', (h.match(/class="mw-last"/g) || []).length === 9, (h.match(/class="mw-last"/g) || []).length);
    const fresh = setup(true);
    fresh.t.state.training.sessions = t.state.training.sessions; fresh.t.state.training.calendar = t.state.training.calendar;
    Object.assign(fresh.t.state, { trainingSelectedDate: today, trainingSection: 'today', view: 'training' });
    check('phone: first time ever shows no last', !fresh.win.renderTrainingView().includes('mw-last'));
  }

  // ---- 11. sync + SQL + exercise modal
  { const { win, t } = setup();
    t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
    const row = win.trainingExerciseToRow(t.state.training.exercises[0]);
    check('sync: exercise row has location_id', row.location_id === 'locA');
    check('sync: row back to exercise', win.rowToTrainingExercise(row).locationId === 'locA');
    check('sync: no location -> null', win.trainingExerciseToRow(t.state.training.exercises[3]).location_id === null);
    const src = fs.readFileSync('./CalendarOS.html', 'utf8');
    check('SQL: gym_locations column', src.includes("alter table app_settings add column if not exists gym_locations jsonb"));
    check('SQL: location_id column', src.includes("alter table training_exercises add column if not exists location_id text"));
    check('sync: both settings upserts send gym_locations', (src.match(/gym_locations: state\.settings\.gymLocations\|\|null/g) || []).length === 2);
    check('changelog has 4.76.0 with SQL line first', t.CHANGELOG.some(c => c.v === '4.76.0' && /SQL migration required/.test(c.changes[0]) && /gym_locations/.test(c.changes[0])));
    t.state.settings.gymLocations = LOCS();
    win.openEditExerciseModal('FLY');
    const sel = win.document.getElementById('editExLocation');
    check('edit modal: location select with Everywhere and gyms', !!sel && sel.innerHTML.includes('Everywhere') && sel.innerHTML.includes('Site B'));
    sel.value = 'locB';
    await win.submitEditExercise('FLY');
    check('edit modal: saves the location', t.state.training.exercises.find(e => e.id === 'FLY').locationId === 'locB');
    win.openAddExerciseModal();
    check('add modal: preselects the day’s location', win.document.getElementById('newExLocation').value === 'locA');
  }

  console.log(`test_v4760: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed:', e && e.stack || e); console.log(`test_v4760: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
