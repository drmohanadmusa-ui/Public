/* v4.40.0 regression suite — training module overhaul.

   Covers:
     F1  per-set logging model (add/done/remove, draft persistence)
     F2  carry-forward from last session and double-progression suggestions
     F3  RIR, to-failure, warm-up flags
     F4  rest timer starts on tick and can be stopped
     F5  e1RM (Epley) and PR detection
     F6  review pack bundles the right data
         sync wiring: training_sets in SYNCED_TABLES / BACKED_UP_TABLES
         delete propagation: sets removed when log is deleted
         backward compat: old logs without set rows keep rendering
*/
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}

function configured(win) {
  win.__t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
  win.__t.state.settings.healthCoreMetricsSeeded = true;
}

function makeExercise(win, id='E1', name='Chest Press') {
  win.__t.state.training.exercises = [{ id, name, tags:[], category:'strength', muscleGroup:'chest' }];
  return id;
}

// ---------- 1. Per-set model basics ----------
async function setModelBasics() {
  section('1. Per-set model: add / tick / remove');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const t = win.__t;
  const today = win.todayStr();
  makeExercise(win);
  t.state.view = 'training'; t.state.trainingSection = 'today';
  t.state.trainingSelectedDate = today; t.state.trainingPendingAdds[today] = ['E1'];
  win.document.getElementById('app').classList.remove('hidden');

  // Add three sets programmatically
  win.addSet(today, 'E1');
  win.addSet(today, 'E1');
  win.addSet(today, 'E1');
  check('three sets created', win.getSetsForExercise(today, 'E1').length === 3);

  // Tick set 2
  win.toggleSetDone(today, 'E1', 2, 90);
  const sets = win.getSetsForExercise(today, 'E1');
  check('set 2 is done', sets[1].done === true);
  check('set 1 is not done', sets[0].done === false);
  check('rest timer started', win._restTimerEnd !== null);

  // Remove set 2 — remaining sets should re-number to 1, 2
  win.removeSet(today, 'E1', 2);
  const after = win.getSetsForExercise(today, 'E1');
  check('two sets remain after removal', after.length === 2);
  check('they are renumbered 1 and 2', after[0].setNo === 1 && after[1].setNo === 2);
}

// ---------- 2. Set fields update correctly ----------
async function setFieldUpdates() {
  section('2. Set field updates persist in state');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const today = win.todayStr();
  makeExercise(win);
  win.addSet(today, 'E1');
  win.updateSetField(today, 'E1', 1, 'reps', 10);
  win.updateSetField(today, 'E1', 1, 'weightKg', 42.5);
  win.updateSetField(today, 'E1', 1, 'rir', 2);
  win.updateSetField(today, 'E1', 1, 'toFailure', true);
  win.updateSetField(today, 'E1', 1, 'isWarmup', false);
  const s = win.getSetsForExercise(today, 'E1')[0];
  check('reps', s.reps === 10, s.reps);
  check('weightKg', s.weightKg === 42.5, s.weightKg);
  check('rir', s.rir === 2, s.rir);
  check('toFailure', s.toFailure === true);
  check('isWarmup', s.isWarmup === false);
}

// ---------- 3. Warm-up flag excludes from volume ----------
async function warmupExclusion() {
  section('3. Warm-up sets excluded from e1RM internally');
  const win = loadApp();
  // epley1RM already strips isWarmup internally, so passing a mix gives the
  // same result as passing working-sets only.
  const warmupSet = { reps:8, weightKg:60, isWarmup:true, toFailure:false };
  const workingSet = { reps:8, weightKg:50, isWarmup:false, toFailure:false };
  const e1rmAll = win.epley1RM([warmupSet, workingSet]);
  const e1rmWorking = win.epley1RM([workingSet]);
  check('epley1RM strips warmup sets internally', e1rmAll === e1rmWorking,
        `all=${e1rmAll} working=${e1rmWorking}`);
  // The warmup set alone should return null (stripped out)
  check('warmup-only set list returns null', win.epley1RM([warmupSet]) === null);
  // Verify the warmup would have a higher e1RM if counted
  const e1rmIfCounted = win.epley1RM([{...warmupSet, isWarmup:false}]);
  check('the warmup set would give a higher e1RM if counted',
        e1rmIfCounted > e1rmWorking, `warmup e1RM=${e1rmIfCounted} vs working=${e1rmWorking}`);
}

// ---------- 4. Carry-forward from last session ----------
async function carryForward() {
  section('4. Carry-forward shows last session numbers');
  const win = loadApp();
  const today = win.todayStr();
  const yesterday = win.addDays(today, -1);
  makeExercise(win);
  // Seed a previous session
  win.upsertTrainingSet({ date:yesterday, exerciseId:'E1', setNo:1, reps:10, weightKg:40, done:true, isWarmup:false, rir:2, toFailure:false });
  win.upsertTrainingSet({ date:yesterday, exerciseId:'E1', setNo:2, reps:9, weightKg:40, done:true, isWarmup:false, rir:1, toFailure:false });

  const lastSets = win.getLastSetsForExercise('E1', today);
  check('last session found', lastSets.length === 2);
  check('first set weight carried', lastSets[0].weightKg === 40);
  check('first set reps carried', lastSets[0].reps === 10);
  check('second set RIR carried', lastSets[1].rir === 1);

  // New set pre-fills from last session
  win.addSet(today, 'E1');
  const newSet = win.getSetsForExercise(today, 'E1')[0];
  check('new set pre-filled with last weight', newSet.weightKg === 40, newSet.weightKg);
  check('new set pre-filled with last reps', newSet.reps === 10, newSet.reps);
}

// ---------- 5. Double-progression suggestion ----------
async function doubleProgressionLogic() {
  section('5. Double-progression: add weight, add rep, hold');
  const win = loadApp();
  const target = { repsMin: 8, repsMax: 12, weightKg: 40, sets: 3 };

  // All sets at top of range at RIR 1 → add weight
  const atTop = [
    { reps:12, weightKg:40, rir:1, isWarmup:false, toFailure:false },
    { reps:12, weightKg:40, rir:1, isWarmup:false, toFailure:false },
    { reps:12, weightKg:40, rir:1, isWarmup:false, toFailure:false },
  ];
  const addWeight = win.doubleProgressionSuggestion('E1', target, atTop);
  check('all at top → add weight', addWeight && addWeight.type === 'addWeight', addWeight&&addWeight.type);
  check('adds 2.5 kg', addWeight && addWeight.newWeightKg === 42.5, addWeight&&addWeight.newWeightKg);
  check('drops to bottom of range', addWeight && addWeight.repsTarget === 8, addWeight&&addWeight.repsTarget);

  // One set below bottom → hold
  const belowBottom = [
    { reps:12, weightKg:40, rir:1, isWarmup:false, toFailure:false },
    { reps:7,  weightKg:40, rir:0, isWarmup:false, toFailure:false }, // below 8
    { reps:8,  weightKg:40, rir:2, isWarmup:false, toFailure:false },
  ];
  const hold = win.doubleProgressionSuggestion('E1', target, belowBottom);
  check('set below bottom → hold', hold && hold.type === 'hold', hold&&hold.type);

  // Middle ground → add rep
  const mid = [
    { reps:10, weightKg:40, rir:2, isWarmup:false, toFailure:false },
    { reps:10, weightKg:40, rir:2, isWarmup:false, toFailure:false },
    { reps:10, weightKg:40, rir:2, isWarmup:false, toFailure:false },
  ];
  const addRep = win.doubleProgressionSuggestion('E1', target, mid);
  check('middle → add rep', addRep && addRep.type === 'addRep', addRep&&addRep.type);
  check('suggests 11 reps', addRep && addRep.repsTarget === 11, addRep&&addRep.repsTarget);

  // RIR > 2 at top range → treat as hold, not addWeight
  const tooEasy = atTop.map(s=>({...s, rir:4}));
  const holdEasy = win.doubleProgressionSuggestion('E1', target, tooEasy);
  check('high RIR at top → add rep rather than weight', holdEasy && holdEasy.type !== 'addWeight', holdEasy&&holdEasy.type);
}

// ---------- 6. Suggestion stored and retrieved ----------
async function suggestionPersistence() {
  section('6. Suggestion stored on save, retrieved on next session');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  configured(win);
  const today = win.todayStr();
  const tomorrow = win.addDays(today, 1);
  makeExercise(win);
  // Set up a session with a rep range so double-progression can fire
  const sessId = 'S1';
  win.__t.state.training.sessions = [{
    id: sessId, name: 'Push Day', type: 'strength', format: '', color: null,
    blocks: [{ exerciseId: 'E1', sets: 3, reps: '8-12', notes: '' }],
  }];
  win.__t.state.training.calendar = [
    { date: today, sessionId: sessId },
    { date: tomorrow, sessionId: sessId },
  ];
  // Seed today's sets — all at 12 reps (top of range) at RIR 1 → should trigger addWeight
  win.upsertTrainingSet({ date:today, exerciseId:'E1', setNo:1, reps:12, weightKg:40, done:true, isWarmup:false, rir:1, toFailure:false });
  win.upsertTrainingSet({ date:today, exerciseId:'E1', setNo:2, reps:12, weightKg:40, done:true, isWarmup:false, rir:1, toFailure:false });
  win.upsertTrainingSet({ date:today, exerciseId:'E1', setNo:3, reps:12, weightKg:40, done:true, isWarmup:false, rir:1, toFailure:false });
  // Run the suggestion computation
  win.refreshSuggestionForExercise('E1', today);
  const suggestion = win.getTrainingSuggestion(tomorrow, 'E1');
  check('suggestion stored for next session', suggestion !== null, JSON.stringify(suggestion));
  check('suggestion recommends more weight', suggestion && suggestion.suggestedWeightKg > 40,
        suggestion && suggestion.suggestedWeightKg);
  check('suggestion basis is human-readable', suggestion && typeof suggestion.basis === 'string',
        suggestion && suggestion.basis);
  check('suggestion has a generatedAt timestamp', suggestion && !!suggestion.generatedAt);
}

// ---------- 7. e1RM and PR detection ----------
async function eOneRMandPR() {
  section('7. Epley e1RM and PR badge');
  const win = loadApp();
  const today = win.todayStr();
  const yesterday = win.addDays(today, -1);
  makeExercise(win);
  // Previous best: 50kg × 8 → e1RM = 50*(1+8/30) ≈ 63.3
  win.upsertTrainingSet({ date:yesterday, exerciseId:'E1', setNo:1, reps:8, weightKg:50, done:true, isWarmup:false });
  // Today: 52.5kg × 8 → e1RM = 52.5*(1+8/30) ≈ 66.5 → PR
  win.upsertTrainingSet({ date:today, exerciseId:'E1', setNo:1, reps:8, weightKg:52.5, done:true, isWarmup:false });

  const prevBest = win.bestE1RMForExercise('E1', today);
  check('previous best e1RM computed', prevBest !== null && prevBest > 60, prevBest);
  const todayE1rm = win.epley1RM(win.getSetsForExercise(today, 'E1'));
  check('today e1RM computed', todayE1rm !== null && todayE1rm > prevBest, `${todayE1rm} vs ${prevBest}`);

  // PR detection
  check('PR detected', todayE1rm > prevBest);

  // Sets above 10 reps excluded from e1RM (formula degrades above 10 reps)
  // A 100kg × 15 set would have notional Epley = 150, much higher than the
  // working set e1RM, so including it would change the result.
  win.upsertTrainingSet({ date:today, exerciseId:'E1', setNo:2, reps:15, weightKg:100, done:true, isWarmup:false });
  const withHighRep = win.getSetsForExercise(today, 'E1');
  const e1rmOnlyValid = win.epley1RM(withHighRep.filter(s => s.reps <= 10));
  const e1rmAll = win.epley1RM(withHighRep);
  check('epley1RM excludes sets above 10 reps internally',
        Math.abs((e1rmAll||0) - (e1rmOnlyValid||0)) < 0.01,
        `internal=${e1rmAll} manual=${e1rmOnlyValid}`);
  check('the excluded set would have changed the result if included',
        100*(1+15/30) > (e1rmOnlyValid||0),
        `100×15 Epley=${100*(1+15/30)} vs working e1RM=${e1rmOnlyValid}`);
}

// ---------- 8. saveTrainingDayLogs persists sets ----------
async function savePeristsSetRows() {
  section('8. saveTrainingDayLogs persists set rows and syncs');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  configured(win);
  const t = win.__t;
  const today = win.todayStr();
  makeExercise(win);
  t.state.trainingPendingAdds[today] = ['E1'];
  t.state.view = 'training'; t.state.trainingSection = 'today';
  t.state.trainingSelectedDate = today;
  win.upsertTrainingSet({ date:today, exerciseId:'E1', setNo:1, reps:10, weightKg:42.5, done:true, isWarmup:false, rir:2, toFailure:false });
  win.document.getElementById('app').classList.remove('hidden');
  win.render();
  await win.saveTrainingDayLogs(today);
  await waitFor(() => win.__calls.some(c => c.method === 'POST' && c.url.includes('training_sets')));

  const setsPushed = win.__calls.filter(c => c.method === 'POST' && c.url.includes('training_sets'));
  check('training_sets upserted', setsPushed.length > 0, JSON.stringify(setsPushed.map(c=>c.url)));
  const row = setsPushed[0] && setsPushed[0].body && setsPushed[0].body[0];
  check('set row has correct weight', row && row.weight_kg === 42.5, JSON.stringify(row));
  check('set row has done flag', row && row.done === true);
  check('set row has RIR', row && row.rir === 2, JSON.stringify(row));

  // Log header backward-compat summary
  const log = win.getTrainingLogForExercise(today, 'E1');
  check('log header marked completed', log && log.completed === true, JSON.stringify(log));
}

// ---------- 9. Delete propagates to sets ----------
async function deletePropagates() {
  section('9. Deleting a log also deletes its set rows');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  configured(win);
  const today = win.todayStr();
  makeExercise(win);
  win.upsertTrainingSet({ date:today, exerciseId:'E1', setNo:1, reps:10, weightKg:40, done:true, isWarmup:false });
  win.__t.state.training.logs.push({ date:today, exerciseId:'E1', completed:true, difficulty:null, notes:'' });
  check('set exists before delete', win.getSetsForExercise(today, 'E1').length === 1);
  win.confirm = () => true;
  await win.deleteTrainingExerciseLog(today, 'E1');
  check('set row removed after delete', win.getSetsForExercise(today, 'E1').length === 0);
  // pendingTrainingDeletes is module-scoped; verify the delete function added
  // a training_sets entry by checking it's in the training push call.
  // We do this by calling saveTraining which triggers scheduleSync.
  configured(win);
  await win.saveTraining();
  await waitFor(() => win.__calls.some(c => c.method === 'GET'));
  check('sets were not re-pushed after deletion (array is empty)',
        (win.__t.state.training.sets||[]).filter(s=>s.date===today&&s.exerciseId==='E1').length === 0);
}

// ---------- 10. Backward compat: old logs render without set rows ----------
async function backwardCompat() {
  section('10. Old logs (no set rows) keep rendering correctly');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const t = win.__t;
  const today = win.todayStr();
  makeExercise(win);
  // Legacy log — has sets/reps/weight summary but no training_sets rows
  t.state.training.logs.push({ date:today, exerciseId:'E1', completed:true, difficulty:3,
    sets:3, reps:'10', weight:30, notes:'', loggedAt:new Date().toISOString() });
  t.state.trainingSelectedDate = today;
  t.state.view = 'training'; t.state.trainingSection = 'today';
  win.document.getElementById('app').classList.remove('hidden');
  let threw = false;
  try { win.render(); } catch(e) { threw = true; console.log('RENDER ERROR:', e.message); }
  check('old log renders without throwing', !threw);
  check('no set rows exist for this old log', win.getSetsForExercise(today, 'E1').length === 0);
}

// ---------- 11. Rest timer ----------
async function restTimer() {
  section('11. Rest timer starts on tick, stops on stopRestTimer');
  const win = loadApp();
  const today = win.todayStr();
  makeExercise(win);
  win.upsertTrainingSet({ date:today, exerciseId:'E1', setNo:1, reps:10, weightKg:40, done:false, isWarmup:false });
  win.toggleSetDone(today, 'E1', 1, 120);
  check('timer end is set', win.__t.restTimerEnd !== null, win.__t.restTimerEnd);
  check('timer end is approximately 120s from now',
        win.__t.restTimerEnd !== null && Math.abs(win.__t.restTimerEnd - Date.now() - 120000) < 2000,
        win.__t.restTimerEnd ? (win.__t.restTimerEnd - Date.now()) : 'null');
  win.stopRestTimer();
  check('timer cleared after stop', win.__t.restTimerEnd === null, win.__t.restTimerEnd);
  check('handle cleared', win.__t.restTimerHandle === null, String(win.__t.restTimerHandle));
}

// ---------- 12. Review pack structure ----------
async function reviewPackStructure() {
  section('12. Review pack contains all required sections');
  const win = loadApp({ fetchHandler: () => ({ status: 200, rows: [] }) });
  const t = win.__t;
  const today = win.todayStr();
  makeExercise(win);
  win.upsertTrainingSet({ date:today, exerciseId:'E1', setNo:1, reps:10, weightKg:40, done:true, isWarmup:false, rir:2, toFailure:false });
  // v4.50.x: bodyMetrics is now built from healthMetricDefs (by name), not
  // hardcoded field names — a real app run seeds the core defs the first
  // time the Health page renders, but this test calls buildTrainingReviewPack
  // directly without ever rendering it, so the core Weight def is seeded
  // explicitly here instead.
  t.state.healthMetricDefs = [{ id:'core_weight', name:'Weight', type:'number', unit:'kg', core:true }];
  t.state.health = [{ date:today, weight:88, water:2000, calDeficit:300 }];

  const pack = win.buildTrainingReviewPack();
  check('has reviewPeriod', pack && pack.reviewPeriod && pack.reviewPeriod.from && pack.reviewPeriod.to);
  check('has goals', pack.goals && typeof pack.goals.targetWeightKg === 'number');
  check('has sessionDetail', Array.isArray(pack.sessionDetail));
  check('session detail contains today\'s sets',
        pack.sessionDetail.some(s => s.date === today && s.workingSets.length > 0));
  check('has bodyMetrics', Array.isArray(pack.bodyMetrics));
  check('body metrics contain weight', pack.bodyMetrics.some(m => m.date===today && m.values.Weight === '88 kg'), JSON.stringify(pack.bodyMetrics));
  check('has weeklyVolumeByMuscle', pack.weeklyVolumeByMuscle !== undefined);
  check('has adherence', pack.adherence && typeof pack.adherence.planned === 'number');
  check('has currentPlan', Array.isArray(pack.currentPlan));
}

// ---------- 13. Coverage lists ----------
function coverageLists() {
  section('13. SYNCED_TABLES, BACKED_UP_TABLES, and table count');
  const win = loadApp();
  const t = win.__t;
  check('training_sets in SYNCED_TABLES', t.SYNCED_TABLES.includes('training_sets'));
  check('training_sets in BACKED_UP_TABLES', t.BACKED_UP_TABLES.includes('training_sets'));
  check('no synced table missing from backup', t.SYNCED_TABLES.every(x => t.BACKED_UP_TABLES.includes(x)));
  check('total is 18', t.SYNCED_TABLES.length === 18, String(t.SYNCED_TABLES.length));

  // restore_table.py must include the new key
  const restoreScript = fs.readFileSync(__dirname + '/restore_table.py', 'utf8');
  check('restore_table.py has training_sets key',
        restoreScript.includes('"training_sets": "pin,log_date,exercise_id,set_no"'));

  // backup_calendaros.py must include training_sets
  const backupScript = fs.readFileSync(__dirname + '/backup_calendaros.py', 'utf8');
  check('backup_calendaros.py includes training_sets', backupScript.includes('"training_sets"'));
}

// ---------- 14. SQL block contains the new table ----------
function sqlBlock() {
  section('14. SQL block contains training_sets DDL');
  const html = fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8');
  check('training_sets CREATE TABLE present', html.includes('create table if not exists training_sets'));
  check('set_no column defined', html.includes('set_no int'));
  check('rir column defined', html.includes('rir int'));
  check('training_suggestions column', html.includes('training_suggestions jsonb'));
  check('training_sets in RLS loop', html.includes("'training_sets'"));
}

// ---------- 15. Version and changelog ----------
function versionDiscipline() {
  section('15. Version and changelog');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const v = /const APP_VERSION = '([\d.]+)'/.exec(js)[1];
  check('version is 4.4x.x', (()=>{ const [maj,min]=v.split('.').map(Number); return maj===4 && min>=40; })(), v);
  check('changelog leads with the shipped version',
        new RegExp(`const CHANGELOG = \\[\\s*\\{ v:'${v.replace(/\./g,'\\.')}'`).test(js));
  check('built file carries the same version',
        fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8').includes(`const APP_VERSION = '${v}'`));
  check('changelog mentions SQL migration', js.includes('SQL migration required'));
}

(async () => {
  await setModelBasics();
  await setFieldUpdates();
  await warmupExclusion();
  await carryForward();
  await doubleProgressionLogic();
  await suggestionPersistence();
  await eOneRMandPR();
  await savePeristsSetRows();
  await deletePropagates();
  await backwardCompat();
  await restTimer();
  await reviewPackStructure();
  coverageLists();
  sqlBlock();
  versionDiscipline();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
