/* v4.77.1: a swap/move on one device carries to the others. Staged exercises
   from a day's old plan are cleared on pull (hand-added ones stay); empty,
   untouched sets the cloud no longer has are dropped before a push instead of
   being uploaded again. All data invented. */
const { loadApp } = require('./harness');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) pass++; else { fail++; console.log('  FAIL', n, d === undefined ? '' : d); } };
const mk = (o) => Object.assign({ reps: 10, weightKg: 40, done: false, rir: null, toFailure: false, isWarmup: false, restTakenSec: null, loggedAt: null }, o);
// a real account: the cloud already has exercises and sessions (an empty cloud is treated as a new project and seeded from the device)
const CLOUD_BASE = (url) => {
  if (url.includes('/training_exercises?')) return { status: 200, rows: [{ pin: '1234', id: 'A', name: 'Chest Press', category: 'strength', muscle_groups: ['chest'], tag_ids: [] }], total: 1 };
  if (url.includes('/training_sessions?')) return { status: 200, rows: [{ pin: '1234', id: 'S1', name: 'Push', type: 'strength', blocks: [{ exerciseId: 'A', sets: 3, reps: '8-12' }] }], total: 1 };
  return null;
};
const row = (o) => Object.assign({ pin: '1234', reps: 10, weight_kg: 40, done: false, rir: null, to_failure: false, is_warmup: false, rest_taken_sec: null, note: null, logged_at: null, edited_at: null, started_at: null }, o);

function setup(handler) {
  const base = handler || (() => ({ status: 200, rows: [], total: 0 }));
  // the cloud holds a list, as a real account does; with no tasks or lists at all the app treats it as new and uploads instead of pulling
  const withList = (url, method, init) => (method === 'GET' && url.includes('/lists?')) ? { status: 200, rows: [{ pin: '1234', id: 'L1', title: 'Groceries', sort_order: 0 }], total: 1 } : base(url, method, init);
  const win = loadApp({ fetchHandler: withList }); const t = win.__t;
  win.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {} });
  if (!win.document.getElementById('mainContent')) { const m = win.document.createElement('div'); m.id = 'mainContent'; win.document.body.appendChild(m); }
  win.confirm = () => true; win.window.confirm = () => true;
  t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
  t.state.syncMeta.lastSyncedAt = new Date(Date.now() - 3600000).toISOString(); // an established device, not a first sync
  t.state.training.exercises = [
    { id: 'A', name: 'Chest Press', category: 'strength', muscleGroupsPrimary: ['chest'], tagIds: [] },
    { id: 'B', name: 'Leg Press', category: 'strength', muscleGroupsPrimary: ['quads'], tagIds: [] },
    { id: 'H', name: 'Hand Added', category: 'strength', muscleGroupsPrimary: ['biceps'], tagIds: [] },
  ];
  t.state.training.sessions = [
    { id: 'S1', name: 'Push', type: 'strength', blocks: [{ exerciseId: 'A', sets: 3, reps: '8-12' }] },
    { id: 'S2', name: 'Legs', type: 'strength', blocks: [{ exerciseId: 'B', sets: 3, reps: '8-12' }] },
  ];
  return { win, t, today: win.todayStr() };
}

(async () => {
  // ---- 1. pull: staged exercises from a day's old plan go, hand-added and logged ones stay
  { const { win, t, today } = setup();
    const SUN = win.addDays(today, 1), FRI = win.addDays(today, 3), OTHER = win.addDays(today, 5);
    t.state.training.calendar = [{ date: SUN, sessionId: 'S1' }, { date: OTHER, sessionId: 'S2' }];
    t.state.trainingPendingAdds = { [SUN]: ['A', 'H'], [OTHER]: ['B'] };
    const prev = new Map(t.state.training.calendar.map(c => [c.date, c.sessionId]));
    t.state.training.calendar = [{ date: FRI, sessionId: 'S1' }, { date: OTHER, sessionId: 'S2' }];   // swapped on the phone
    win.reconcileStagedAfterPull(prev);
    check('pull: old plan’s exercise cleared from the old date', !(t.state.trainingPendingAdds[SUN] || []).includes('A'), JSON.stringify(t.state.trainingPendingAdds));
    check('pull: a hand-added exercise stays', (t.state.trainingPendingAdds[SUN] || []).includes('H'));
    check('pull: an unchanged day is left alone', (t.state.trainingPendingAdds[OTHER] || []).join() === 'B');
    win.renderTrainingDayCard(FRI);
    check('pull: the new date loads the moved plan', win.getTrainingDayExerciseIds(FRI).includes('A'));
    // with sets on the old date the exercise stays (real work is never hidden)
    const prev2 = new Map([[SUN, 'S1']]);
    t.state.training.calendar = [];
    t.state.trainingPendingAdds = { [SUN]: ['A'] };
    t.state.training.sets = [mk({ date: SUN, exerciseId: 'A', setNo: 1, done: true, loggedAt: new Date().toISOString() })];
    win.reconcileStagedAfterPull(prev2);
    check('pull: an exercise with sets on that day stays', (t.state.trainingPendingAdds[SUN] || []).includes('A'));
  }

  // ---- 2. pull wiring: a real pull runs the cleanup and marks sets as known to the cloud
  { const D = '2026-02-02';
    const handler = (url, method) => {
      if (method !== 'GET') return { status: 200, rows: [] };
      if (CLOUD_BASE(url)) return CLOUD_BASE(url);
      if (url.includes('/training_sets?')) return { status: 200, rows: [row({ log_date: D, exercise_id: 'A', set_no: 1 })], total: 1 };
      if (url.includes('/training_calendar?')) return { status: 200, rows: [{ pin: '1234', cal_date: '2099-01-09', session_id: 'S1' }], total: 1 };
      return { status: 200, rows: [], total: 0 };
    };
    const { win, t } = setup(handler);
    t.state.training.calendar = [{ date: '2099-01-02', sessionId: 'S1' }];
    t.state.trainingPendingAdds = { '2099-01-02': ['A'] };
    await win.runBackgroundSync();
    check('pull: sets from the cloud are marked known', (t.state.training.sets || []).length === 1 && t.state.training.sets[0].synced === true, JSON.stringify(t.state.training.sets));
    check('pull: staged exercise from the moved plan cleared', !(t.state.trainingPendingAdds['2099-01-02'] || []).length, JSON.stringify(t.state.trainingPendingAdds));
  }

  // ---- 3. merge: empty untouched sets deleted elsewhere are dropped, not uploaded again
  { const D = '2026-02-03';
    const { win, t } = setup((url, method) => (method === 'GET' && url.includes('/training_sets?')) ? { status: 200, rows: [], total: 0 } : { status: 200, rows: [] });
    t.state.training.sets = [
      mk({ date: D, exerciseId: 'A', setNo: 1, synced: true }),                                  // cleared by a swap elsewhere
      mk({ date: D, exerciseId: 'A', setNo: 2, synced: true, editedAt: new Date().toISOString(), weightKg: 45 }), // edited here
      mk({ date: D, exerciseId: 'A', setNo: 3, synced: true, done: true, loggedAt: new Date().toISOString() }),   // done here
      mk({ date: D, exerciseId: 'B', setNo: 1 }),                                                // new here, never sent
    ];
    t.state.training.logs = [{ date: D, exerciseId: 'Z', completed: false }];
    win.resetSetSnapshot();
    await win.mergeServerTrainingSets();
    const has = (ex, n) => t.state.training.sets.some(s => s.date === D && s.exerciseId === ex && s.setNo === n);
    check('merge: empty untouched set deleted elsewhere is dropped', !has('A', 1));
    check('merge: a set edited here is kept', has('A', 2));
    check('merge: a done set is kept', has('A', 3));
    check('merge: a new set never sent is kept', has('B', 1));
  }

  // ---- 4. after a successful upload every sent set is known to the cloud; a failed one leaves them unmarked
  { let up = [];
    const { win, t } = setup((url, method, init) => {
      if (method === 'POST' && url.includes('/training_sets')) { up = JSON.parse(init.body); return { status: 200, rows: [] }; }
      if (method === 'GET' && url.includes('/training_sets?')) return { status: 200, rows: up, total: up.length };
      return { status: 200, rows: [], total: 0 };
    });
    t.state.training.sets = [mk({ date: '2026-02-04', exerciseId: 'A', setNo: 1 })];
    t.state.syncMeta.dirtyDomains = ['training']; t.state.syncMeta.dirty = true;
    await win.runBackgroundSync();
    check('upload: sets marked known after sending', t.state.training.sets.length === 1 && t.state.training.sets[0].synced === true, JSON.stringify(t.state.training.sets));
    const f = setup((url, method) => (method === 'POST' && url.includes('/training_sets')) ? { status: 500, rows: [] } : { status: 200, rows: [], total: 0 });
    f.t.state.training.sets = [mk({ date: '2026-02-04', exerciseId: 'A', setNo: 1 })];
    f.t.state.syncMeta.dirtyDomains = ['training']; f.t.state.syncMeta.dirty = true;
    await f.win.runBackgroundSync();
    check('upload failed: set not marked known', f.t.state.training.sets.length === 1 && !f.t.state.training.sets[0].synced);
    check('row: the known flag is not sent', !('synced' in f.win.trainingSetToRow(Object.assign({ synced: true }, f.t.state.training.sets[0]))));
  }

  // ---- 5. end to end: phone swaps, PC with an old copy and a pending change syncs, Sunday stays clear
  { const SUN = '2099-03-01', FRI = '2099-03-06';
    let cloudSets = [];   // the phone already cleared Sunday's empty sets in the cloud
    const handler = (url, method, init) => {
      if (method === 'GET' && url.includes('/training_sets?')) return { status: 200, rows: cloudSets, total: cloudSets.length };
      if (method === 'GET' && url.includes('/training_calendar?')) return { status: 200, rows: [{ pin: '1234', cal_date: FRI, session_id: 'S1' }], total: 1 };
      if (method === 'GET' && CLOUD_BASE(url)) return CLOUD_BASE(url);
      if (method === 'POST' && url.includes('/training_sets')) { cloudSets = cloudSets.concat(JSON.parse(init.body)); return { status: 200, rows: [] }; }
      return { status: 200, rows: [], total: 0 };
    };
    const { win, t } = setup(handler);
    t.state.training.calendar = [{ date: SUN, sessionId: 'S1' }];
    t.state.trainingPendingAdds = { [SUN]: ['A'] };
    t.state.training.sets = [1, 2, 3].map(n => mk({ date: SUN, exerciseId: 'A', setNo: n, synced: true }));
    win.resetSetSnapshot();
    t.state.syncMeta.dirtyDomains = ['training']; t.state.syncMeta.dirty = true;   // the PC has something to send
    await win.runBackgroundSync();
    check('end to end: Sunday’s empty sets not put back in the cloud', !cloudSets.some(r => r.log_date === SUN), JSON.stringify(cloudSets.map(r => r.log_date)));
    check('end to end: Sunday shows nothing on the PC', win.getTrainingDayExerciseIds(SUN).length === 0, win.getTrainingDayExerciseIds(SUN).join());
    check('end to end: Friday has the plan', (win.getTrainingCalEntry(FRI) || {}).sessionId === 'S1');
    check('changelog has 4.77.1, SQL line first', t.CHANGELOG.some(c => c.v === '4.77.1' && /No SQL migration needed/.test(c.changes[0])));
  }

  console.log(`test_v4771: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed:', e && e.stack || e); console.log(`test_v4771: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
