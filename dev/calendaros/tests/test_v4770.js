/* v4.77.0: sets survive a reload, newer copy of each set wins before a push,
   weight step synced, set start times, untick asks first, heavier weight in
   red, volume-based new bests, workout times in History and the Review Pack,
   week/month summary on Progress, search shows a recurring task's occurrence
   date, "Done, Move It". All data invented. */
const fs = require('fs');
const { loadApp } = require('./harness');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) pass++; else { fail++; console.log('  FAIL', n, d === undefined ? '' : d); } };

function setup(opts) {
  opts = opts || {};
  const win = loadApp(opts.fetchHandler ? { fetchHandler: opts.fetchHandler } : undefined); const t = win.__t;
  win.matchMedia = (q) => ({ matches: !!opts.mobile, media: q, addListener() {}, removeListener() {} });
  if (!win.document.getElementById('mainContent')) { const m = win.document.createElement('div'); m.id = 'mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = () => {};
  let answer = true; win.confirm = () => answer; win.window.confirm = () => answer;
  t.state.settings.healthCoreMetricsSeeded = true;
  t.state.training.exercises = [
    { id: 'LP', name: 'Leg Press', category: 'strength', muscleGroupsPrimary: ['quads'], weightIncrementKg: 10, tagIds: [] },
    { id: 'CP', name: 'Chest Press', category: 'strength', muscleGroupsPrimary: ['chest'], weightIncrementKg: 2.5, tagIds: [] },
  ];
  let txt = '';
  win.navigator.clipboard = { writeText: (x) => { txt = x; return Promise.resolve(); } };
  return { win, t, today: win.todayStr(), setAnswer: (v) => { answer = v; }, prompt: () => { win.copyTrainingReviewPack(); return txt; } };
}
const mk = (o) => Object.assign({ reps: 10, weightKg: 40, done: false, rir: null, toFailure: false, isWarmup: false, restTakenSec: null, loggedAt: null }, o);
const row = (o) => Object.assign({ pin: '1234', reps: 10, weight_kg: 40, done: false, rir: null, to_failure: false, is_warmup: false, rest_taken_sec: null, note: null, logged_at: null, edited_at: null, started_at: null }, o);
const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

(async () => {
  // ---- 1. sets survive a reload (they were dropped before)
  { const { win, t } = setup();
    t.state.training.sets = [mk({ date: '2026-01-05', exerciseId: 'CP', setNo: 1, done: true, loggedAt: iso(5) })];
    await win.saveTraining();
    t.state.training.sets = [];
    await win.loadAll();
    check('reload: sets come back from the device', (t.state.training.sets || []).length === 1 && t.state.training.sets[0].done === true, JSON.stringify(t.state.training.sets));
  }

  // ---- 2. edit stamps
  { const { win, t } = setup();
    t.state.training.sets = [mk({ date: '2026-01-05', exerciseId: 'CP', setNo: 1 }), mk({ date: '2026-01-05', exerciseId: 'CP', setNo: 2 })];
    win.resetSetSnapshot();
    t.state.training.sets[0].weightKg = 42.5;
    t.state.training.sets.push(mk({ date: '2026-01-05', exerciseId: 'CP', setNo: 3 }));
    await win.saveTraining();
    check('stamp: edited set gets editedAt', !!t.state.training.sets[0].editedAt);
    check('stamp: untouched set has none', !t.state.training.sets[1].editedAt);
    check('stamp: set created by the app has none', !t.state.training.sets[2].editedAt);
    check('row: edited_at and started_at sent', 'edited_at' in win.trainingSetToRow(t.state.training.sets[0]) && 'started_at' in win.trainingSetToRow(t.state.training.sets[0]));
    const back = win.rowToTrainingSet(row({ log_date: '2026-01-05', exercise_id: 'CP', set_no: 1, edited_at: iso(1), started_at: iso(2) }));
    check('row: edited_at and started_at read back', !!back.editedAt && !!back.startedAt);
  }

  // ---- 3. merge before push: the newer copy of each set wins
  { const D = '2026-01-06';
    const server = [
      row({ log_date: D, exercise_id: 'CP', set_no: 1, done: true, weight_kg: 45, reps: 12, logged_at: iso(60) }),   // logged on the phone
      row({ log_date: D, exercise_id: 'CP', set_no: 2, done: true, weight_kg: 45, reps: 11, logged_at: iso(60) }),   // older than our edit
      row({ log_date: D, exercise_id: 'LP', set_no: 1, done: true, weight_kg: 80, reps: 10, logged_at: iso(50) }),   // only in the cloud
      row({ log_date: D, exercise_id: 'LP', set_no: 2, done: true, weight_kg: 80, reps: 9, logged_at: iso(90) }),    // we deleted it later
    ];
    const { win, t } = setup({ fetchHandler: (url, method) => (method === 'GET' && url.includes('/training_sets?')) ? { status: 200, rows: server, total: server.length } : { status: 200, rows: [] } });
    t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
    t.state.training.sets = [
      mk({ date: D, exerciseId: 'CP', setNo: 1, weightKg: 40, reps: 12 }),                                   // stale copy, never edited here
      mk({ date: D, exerciseId: 'CP', setNo: 2, weightKg: 45, reps: 9, done: true, loggedAt: iso(70), editedAt: iso(10) }), // edited here later
    ];
    win.__t.state.training.logs = [];
    win.resetSetSnapshot();
    t.pendingTrainingDeletes.push({ table: 'training_sets', match: { log_date: D, exercise_id: 'LP', set_no: 2 }, at: iso(30) });
    await win.mergeServerTrainingSets();
    const get = (ex, n) => t.state.training.sets.find(s => s.date === D && s.exerciseId === ex && s.setNo === n);
    check('merge: a done set from another device beats an older not-done copy', get('CP', 1) && get('CP', 1).done === true && get('CP', 1).weightKg === 45, JSON.stringify(get('CP', 1)));
    check('merge: a newer local edit is kept', get('CP', 2) && get('CP', 2).reps === 9);
    check('merge: a set only in the cloud is added', !!get('LP', 1));
    check('merge: a set deleted here after the cloud copy stays deleted', !get('LP', 2));
    check('merge: logs rebuilt for the sets that changed', t.state.training.logs.some(l => l.date === D && l.exerciseId === 'CP'));
    check('merge: the snapshot is updated (no fake edit stamp next save)', (await win.saveTraining(), !get('LP', 1).editedAt));
  }

  // ---- 4. merge read fails -> no training push at all (never push blind)
  { const { win, t } = setup({ fetchHandler: (url, method) => (method === 'GET' && url.includes('/training_sets?')) ? { status: 500, rows: [] } : { status: 200, rows: [] } });
    t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
    t.state.training.sets = [mk({ date: '2026-01-07', exerciseId: 'CP', setNo: 1 })];
    t.state.syncMeta.dirtyDomains = ['training']; t.state.syncMeta.dirty = true;
    await win.runBackgroundSync();
    check('failed read: no set upload', !win.__calls.some(c => c.method === 'POST' && c.url.includes('/training_sets')));
    check('failed read: training stays to be sent', (t.state.syncMeta.dirtyDomains || []).includes('training'), JSON.stringify(t.state.syncMeta.dirtyDomains));
  }

  // ---- 5. the merge read comes before every training upload
  { const { win, t } = setup({ fetchHandler: () => ({ status: 200, rows: [], total: 0 }) });
    t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
    t.state.training.sets = [mk({ date: '2026-01-07', exerciseId: 'CP', setNo: 1 })];
    t.state.syncMeta.dirtyDomains = ['training']; t.state.syncMeta.dirty = true;
    await win.runBackgroundSync();
    const c = win.__calls;
    const read = c.findIndex(x => x.method === 'GET' && x.url.includes('/training_sets?'));
    const firstTrainingPost = c.findIndex(x => x.method === 'POST' && x.url.includes('/training_'));
    check('order: set check before the first training upload', read >= 0 && firstTrainingPost > read, `${read} ${firstTrainingPost}`);
  }

  // ---- 5b. a normal save (saveTraining) also checks the cloud's sets before uploading
  { const { win, t } = setup({ fetchHandler: () => ({ status: 200, rows: [], total: 0 }) });
    t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
    t.state.training.sets = [mk({ date: '2026-01-08', exerciseId: 'CP', setNo: 1 })];
    await win.saveTraining();
    for (let i = 0; i < 40 && !win.__calls.some(x => x.method === 'POST' && x.url.includes('/training_sets')); i++) await new Promise(r => setTimeout(r, 50));
    const c = win.__calls;
    const read = c.findIndex(x => x.method === 'GET' && x.url.includes('/training_sets?'));
    const firstTrainingPost = c.findIndex(x => x.method === 'POST' && x.url.includes('/training_'));
    check('save: set check before the first training upload', read >= 0 && firstTrainingPost > read, `${read} ${firstTrainingPost}`);
  }

  // ---- 6. weight step synced; a cloud copy without it keeps the device's value
  { const { win, t } = setup();
    t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
    const r = win.trainingExerciseToRow(t.state.training.exercises[0]);
    check('step: sent to the cloud', Number(r.weight_increment_kg) === 10);
    check('step: read back', win.rowToTrainingExercise(Object.assign({}, r, { weight_increment_kg: '10' })).weightIncrementKg === 10);
    check('step: missing in the cloud reads as null', win.rowToTrainingExercise(Object.assign({}, r, { weight_increment_kg: null })).weightIncrementKg === null);
    const src = fs.readFileSync('./CalendarOS.html', 'utf8');
    check('step: pull keeps the device value when the cloud has none', /if\(e\.weightIncrementKg==null\)\{ const old = \(state\.training\.exercises\|\|\[\]\)\.find/.test(src));
    check('SQL: three new columns', ['training_exercises add column if not exists weight_increment_kg numeric', 'training_sets add column if not exists edited_at timestamptz', 'training_sets add column if not exists started_at timestamptz'].every(x => src.includes(x)));
    check('changelog has 4.77.0, SQL line first', t.CHANGELOG.some(c => c.v === '4.77.0' && /SQL migration required/.test(c.changes[0]) && /edited_at/.test(c.changes[0])));
    // end screen suggestion uses the 10 kg step
    const sug = win.doubleProgressionSuggestion('LP', { repsMin: 10, repsMax: 12 }, [1, 2, 3].map(n => mk({ setNo: n, weightKg: 70, reps: 15, rir: 3, done: true })));
    check('step: leg press suggests +10 kg, not +2.5', sug && sug.newWeightKg !== 72.5, JSON.stringify(sug));
  }

  // ---- 7. set start time, untick asks first
  { const { win, t, today, setAnswer } = setup();
    t.state.training.sets = [mk({ date: today, exerciseId: 'CP', setNo: 1 }), mk({ date: today, exerciseId: 'CP', setNo: 2 })];
    win.toggleSetDone(today, 'CP', 1, 60);
    const s1 = t.state.training.sets[0], s2 = t.state.training.sets[1];
    check('start: first set of the workout has no start', s1.done && !s1.startedAt);
    s1.loggedAt = iso(2);  // the first set was ticked 2 minutes ago
    win.stopRestTimer();   // rest skipped
    win.toggleSetDone(today, 'CP', 2, 60);
    check('start: next set starts when the rest ended', !!s2.startedAt && Date.parse(s2.startedAt) <= Date.parse(s2.loggedAt), JSON.stringify(s2));
    setAnswer(false);
    win.toggleSetDone(today, 'CP', 2, 60);
    check('untick: cancel keeps the set done', s2.done === true && !!s2.loggedAt);
    setAnswer(true);
    win.toggleSetDone(today, 'CP', 2, 60);
    check('untick: confirm unticks and clears its times', s2.done === false && !s2.loggedAt && !s2.startedAt);
    setAnswer(false);
    win.setSetMode(today, 'CP', 1, 'rir', null);
    t.state.training.sets[0].rir = 2;
    win.setSetMode(today, 'CP', 1, 'rir', 2);
    check('untick: tapping the active RIR asks first (cancel keeps it)', s1.done === true && s1.rir === 2);
  }

  // ---- 8. phone: heavier than last time in red; highlight room
  { const { win, t, today } = setup({ mobile: true });
    const last = win.addDays(today, -3);
    t.state.training.sets = [
      mk({ date: last, exerciseId: 'CP', setNo: 1, weightKg: 40, reps: 12, done: true, loggedAt: iso(4000) }),
      mk({ date: last, exerciseId: 'CP', setNo: 2, weightKg: 40, reps: 12, done: true, loggedAt: iso(3999) }),
      mk({ date: today, exerciseId: 'CP', setNo: 1, weightKg: 42.5 }),
      mk({ date: today, exerciseId: 'CP', setNo: 2, weightKg: 40 }),
    ];
    t.state.training.sessions = [{ id: 'S1', name: 'Push', type: 'strength', blocks: [{ exerciseId: 'CP', sets: 2, reps: '8-12' }] }];
    t.state.training.calendar = [{ date: today, sessionId: 'S1' }];
    Object.assign(t.state, { trainingSelectedDate: today, trainingSection: 'today', view: 'training' });
    t.state.settings.mobileWorkoutBeta = true;
    const h = win.renderTrainingView();
    const inputs = h.match(/<input type="number" class="num-pick mw-num[^>]*data-np="[^"]*weightKg"/g) || [];
    check('red: two weight boxes found', inputs.length === 2, inputs.length);
    check('red: heavier weight marked', inputs[0] && inputs[0].includes('mw-heavier'));
    check('red: same weight not marked', inputs[1] && !inputs[1].includes('mw-heavier'));
    const src = fs.readFileSync('./CalendarOS.html', 'utf8');
    check('ring: set list has room for the drag ring', src.includes('.mw.mw-lock > .mw-sets{ padding-top:3px;'));
  }

  // ---- 9. new best = volume
  { const { win, t, today } = setup();
    const last = win.addDays(today, -3);
    t.state.training.sets = [
      ...[1, 2, 3].map(n => mk({ date: last, exerciseId: 'CP', setNo: n, weightKg: 40, reps: 12, done: true })),   // 1440
      ...[1, 2, 3].map(n => mk({ date: today, exerciseId: 'CP', setNo: n, weightKg: 45, reps: 10, done: true })),  // 1350: heavier but less volume
      ...[1, 2, 3].map(n => mk({ date: last, exerciseId: 'LP', setNo: n, weightKg: 70, reps: 10, done: true })),   // 2100
      ...[1, 2, 3].map(n => mk({ date: today, exerciseId: 'LP', setNo: n, weightKg: 70, reps: 11, done: true })),  // 2310
    ];
    const d = win.mwSummaryData(today, ['CP', 'LP'], {});
    check('best: higher volume counts', d.rows.find(r => r.name === 'Leg Press').pr === true);
    check('best: heavier but less volume does not', d.rows.find(r => r.name === 'Chest Press').pr === false);
    check('best: count', d.bests === 1, d.bests);
    check('best: first session ever is not a best', win.bestSessionVolume('CP', last) === 0);
  }

  // ---- 10. workout times: History and Review Pack
  { const { win, t, today, prompt } = setup();
    const D = win.addDays(today, -1);
    const at = (h, m) => { const x = new Date(D + 'T00:00:00'); x.setHours(h, m, 0, 0); return x.toISOString(); };
    t.state.training.sets = [
      mk({ date: D, exerciseId: 'CP', setNo: 1, done: true, loggedAt: at(7, 5) }),
      mk({ date: D, exerciseId: 'CP', setNo: 2, done: true, startedAt: at(7, 7), loggedAt: at(7, 9) }),
      mk({ date: D, exerciseId: 'LP', setNo: 1, done: true, startedAt: at(7, 40), loggedAt: at(7, 50) }),
    ];
    const w = win.workoutTimes(D);
    check('times: start, end, minutes', w && win.fmtClockTime(w.start) === '07:05' && win.fmtClockTime(w.end) === '07:50' && w.minutes === 45, JSON.stringify(w));
    check('times: no sets -> none', win.workoutTimes(win.addDays(today, -9)) === null);
    const h = win.renderTrainingHistorySubpage();
    check('times: shown in Log History', h.includes('07:05–07:50') && h.includes('45 min'));
    const p = prompt();
    check('times: Review Pack has start and end', /"minutes": 45,\s*"start": "07:05",\s*"end": "07:50"/.test(p));
    check('times: Review Pack has each set’s start', p.includes('"startedAt": "07:07"'));
  }

  // ---- 11. Progress: week and month summary
  { const { win, t, today } = setup();
    const w0 = win.getCalendarWeekBounds(0), w1 = win.getCalendarWeekBounds(-1);
    t.state.training.sets = [
      mk({ date: w0.weekStart, exerciseId: 'CP', setNo: 1, weightKg: 50, reps: 10, done: true }),
      mk({ date: w1.weekStart, exerciseId: 'CP', setNo: 1, weightKg: 40, reps: 10, done: true }),
      mk({ date: w1.weekStart, exerciseId: 'CP', setNo: 2, weightKg: 20, reps: 10, done: true, isWarmup: true }),
    ];
    const rows = win.exerciseCompareRows();
    const cp = rows.find(r => r.ex.id === 'CP');
    check('summary: this week vs last week', cp && cp.tw.vol === 500 && cp.lw.vol === 400 && cp.tw.top === 50 && cp.lw.top === 40, JSON.stringify(cp));
    check('summary: warm-ups not counted', cp && cp.lw.vol === 400);
    check('summary: exercise with no sets left out', !rows.some(r => r.ex.id === 'LP'));
    const h = win.renderTrainingTrendsSubpage();
    check('summary: on the Progress page first', h.indexOf('Week and month summary') >= 0 && h.indexOf('Week and month summary') < h.indexOf('Strength index'));
    check('summary: change shown', h.includes('+25%'));
  }

  // ---- 12. search shows a recurring task's occurrence date; Done, Move It
  { const { win, t, today } = setup();
    const task = { id: 'R1', name: 'Water plants', location: 'Home', silo: 'Alpha', priority: 'Medium', type: 'Daily', detail: '', start: '2026-01-01' };
    t.state.tasks.recurring = [task];
    t.state.searchQuery = '';
    let h = win.renderTicket({ kind: 'recurring', task, dueOn: win.addDays(today, 2), overdue: false }, {});
    check('search: no date tag without a search', !h.includes(win.humanDate(win.addDays(today, 2))));
    t.state.searchQuery = 'water';
    h = win.renderTicket({ kind: 'recurring', task, dueOn: win.addDays(today, 2), overdue: false }, {});
    check('search: occurrence date shown while searching', h.includes(win.humanDate(win.addDays(today, 2))));
    t.state.searchQuery = '';
    const from = win.addDays(today, -1), to = today;
    win.openTaskModal('recurring', 'R1', from);
    const el = win.document.getElementById('f_reschedule_to');
    check('move: both buttons shown', !!el && win.document.body.innerHTML.includes('Done, Move It'));
    if (el) { el.value = to; await win.submitRescheduleOccurrence(true); }
    check('move: done on the new date', win.isCompletedOn('R1', to));
    check('move: original date marked missed', win.isMissedOn('R1', from));
    win.openTaskModal('recurring', 'R1', win.addDays(today, 3));
    const el2 = win.document.getElementById('f_reschedule_to');
    if (el2) { el2.value = win.addDays(today, 4); await win.submitRescheduleOccurrence(); }
    check('move: plain Move It does not mark done', !win.isCompletedOn('R1', win.addDays(today, 4)));
  }

  console.log(`test_v4770: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed:', e && e.stack || e); console.log(`test_v4770: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
