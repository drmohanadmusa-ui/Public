/* v4.42.0 — Training tab on the Progress page */
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }

function seedTraining(win) {
  const today = win.todayStr();
  win.__t.state.training.exercises = [
    { id:'E1', name:'Chest Press', tags:[], tagIds:[], category:'strength', muscleGroup:'chest', restSec:null },
    { id:'E2', name:'Lat Pulldown', tags:[], tagIds:[], category:'strength', muscleGroup:'back', restSec:null },
  ];
  // Three sessions over the last two weeks
  const d1 = win.addDays(today, -10);
  const d2 = win.addDays(today, -5);
  const d3 = today;
  [d1, d2, d3].forEach(d => {
    win.__t.state.training.logs.push(
      { date:d, exerciseId:'E1', completed:true, difficulty:null, notes:'' },
      { date:d, exerciseId:'E2', completed:true, difficulty:null, notes:'' },
    );
  });
  // Working sets: Chest Press getting stronger each session
  [[d1,40],[d2,42.5],[d3,45]].forEach(([d,w]) => {
    [1,2,3].forEach(setNo => {
      win.upsertTrainingSet({ date:d, exerciseId:'E1', setNo, reps:8, weightKg:w, done:true, isWarmup:false, rir:1, toFailure:false });
    });
  });
  // Lat Pulldown: flat
  [d1, d2, d3].forEach(d => {
    [1,2,3].forEach(setNo => {
      win.upsertTrainingSet({ date:d, exerciseId:'E2', setNo, reps:10, weightKg:30, done:true, isWarmup:false, rir:2, toFailure:false });
    });
  });
  // One failure set on Chest Press
  win.upsertTrainingSet({ date:d3, exerciseId:'E1', setNo:4, reps:6, weightKg:45, done:true, isWarmup:false, rir:0, toFailure:true });
}

/* ---------- 1. e1RMHistory ---------- */
function e1RMHistoryTest() {
  section('1. e1RM history only counts done sets');
  const win = loadApp();
  seedTraining(win);
  const today = win.todayStr();
  // Add an UNDONE set at a new date — should not appear in history
  const futureDate = win.addDays(today, 1);
  win.upsertTrainingSet({ date:futureDate, exerciseId:'E1', setNo:1, reps:8, weightKg:100, done:false, isWarmup:false, rir:null, toFailure:false });
  const hist = win.e1RMHistory('E1');
  check('history has 3 entries (3 done sessions, not 4)', hist.length === 3, hist.length);
  check('sorted newest-first', hist[0].date > hist[1].date);
  check('most recent e1RM is highest (progressing)', hist[0].e1rm > hist[2].e1rm,
        `${hist[0].e1rm} vs ${hist[2].e1rm}`);
  // The undone 100kg set must not inflate the most recent e1RM
  const epleyOf100x8 = 100 * (1 + 8/30);
  check('undone 100kg set does not appear in history', hist[0].e1rm < epleyOf100x8,
        `${hist[0].e1rm} should be < ${epleyOf100x8}`);
}

/* ---------- 2. weeklyVolumeHistory ---------- */
function weeklyVolumeHistoryTest() {
  section('2. Weekly volume excludes warmup and undone sets');
  const win = loadApp();
  seedTraining(win);
  const today = win.todayStr();
  // Add a warmup set — should be excluded
  win.upsertTrainingSet({ date:today, exerciseId:'E1', setNo:99, reps:15, weightKg:20, done:true, isWarmup:true });
  // Add an undone working set — should be excluded
  win.upsertTrainingSet({ date:today, exerciseId:'E1', setNo:98, reps:8, weightKg:45, done:false, isWarmup:false });
  const hist = win.weeklyVolumeHistory(4);
  check('returns 4 weeks', hist.length === 4);
  const thisWeek = hist[hist.length - 1];
  // Chest sets this week: 3 from d2 (5 days ago, within window) + 3 working + 1 failure from d3 = 7
  // The warmup (isWarmup=true) and undone (done=false) must NOT add to that count
  check('warmup and undone sets excluded (chest count unchanged at 7)',
        thisWeek.vol.chest === 7, `chest sets this week: ${thisWeek.vol.chest}`);
  const totalSets = hist.reduce((s,w)=>s+Object.values(w.vol).reduce((x,v)=>x+v,0), 0);
  check('total sets reasonable (warmup and undone excluded)', totalSets <= 22, totalSets);
}

/* ---------- 3. sessionAdherenceHistory ---------- */
function sessionAdherenceTest() {
  section('3. Session adherence counts logged days');
  const win = loadApp();
  seedTraining(win);
  const today = win.todayStr();
  // Add 2 calendar entries in the current week
  win.__t.state.training.calendar = [
    { date: win.addDays(today, -1), sessionId:'S1' },
    { date: today, sessionId:'S1' },
  ];
  const hist = win.sessionAdherenceHistory(2); // last 2 weeks
  check('returns 2 weeks', hist.length === 2);
  const mostRecent = hist[hist.length-1];
  // Today is in the most recent week; we have a log for today
  check('logged count > 0 in most recent week', mostRecent.logged > 0, mostRecent.logged);
}

/* ---------- 4. failureRateByExercise ---------- */
function failureRateTest() {
  section('4. Failure rate computed correctly');
  const win = loadApp();
  seedTraining(win);
  const rates = win.failureRateByExercise();
  check('Chest Press appears (has failure sets)', rates.some(r=>r.exId==='E1'));
  const chest = rates.find(r=>r.exId==='E1');
  // Chest Press: 9 working sets + 1 failure = 10 total. Failure = 1. 10%
  check('failure set counted', chest && chest.failure === 1, chest && chest.failure);
  check('total includes failure set', chest && chest.total === 10, chest && chest.total);
  check('sorted by pct descending', rates.length < 2 || rates[0].pct >= rates[rates.length-1].pct);
  // failureRateByExercise requires ≥ 3 sets; add exercises with only 1-2 sets
  const win2 = loadApp();
  win2.__t.state.training.exercises = [
    { id:'EX', name:'Rare Exercise', tags:[], tagIds:[], category:'strength', muscleGroup:'chest' },
  ];
  win2.upsertTrainingSet({ date:win2.todayStr(), exerciseId:'EX', setNo:1, reps:8, weightKg:40, done:true, isWarmup:false, rir:null, toFailure:true });
  win2.upsertTrainingSet({ date:win2.todayStr(), exerciseId:'EX', setNo:2, reps:8, weightKg:40, done:true, isWarmup:false, rir:null, toFailure:false });
  const rares = win2.failureRateByExercise();
  check('exercise with only 2 sets is excluded (threshold is ≥3)', rares.length === 0, rares.length);
}

/* ---------- 5. SVG chart helpers ---------- */
function svgChartHelpers() {
  section('5. SVG chart helpers produce valid markup');
  const win = loadApp();
  const barData = [
    { label:'W1', value:5 },
    { label:'W2', value:8 },
    { label:'W3', value:12 },
  ];
  const bar = win.svgBarChart(barData, { width:300, height:100 });
  check('bar chart contains SVG', bar.includes('<svg'));
  check('bar chart has rect elements', bar.includes('<rect'));
  check('bar chart includes all labels', bar.includes('W1') && bar.includes('W3'));

  const lineData = [
    { label:'S1', value:55 },
    { label:'S2', value:58 },
    { label:'S3', value:61 },
  ];
  const line = win.svgLineChart(lineData, { width:300, height:120 });
  check('line chart contains SVG', line.includes('<svg'));
  check('line chart has polyline', line.includes('<polyline'));
  check('line chart has area polygon', line.includes('<polygon'));

  // Empty data
  const empty = win.svgBarChart([], {});
  check('empty data returns a message, not broken SVG', !empty.includes('<rect') && empty.includes('No data'));

  // Single point (needs ≥2 for line)
  const singlePt = win.svgLineChart([{label:'S1',value:50}], {});
  check('single point line chart returns message', !singlePt.includes('<polyline'));
}

/* ---------- 6. Progress page renders both tabs ---------- */
function progressPageRenders() {
  section('6. Progress page renders Tasks and Training tabs without errors');
  const win = loadApp();
  seedTraining(win);
  win.__t.state.view = 'progress';
  win.document.getElementById('app').classList.remove('hidden');

  // Tasks tab
  win.__t.state.progressTab = 'tasks';
  let threw = false;
  try { win.render(); } catch(e) { threw = true; console.log('Tasks tab error:', e.message); }
  check('tasks tab renders without error', !threw);
  const tasksHtml = win.document.getElementById('app').innerHTML;
  check('tasks tab shows commitment rate', tasksHtml.includes('Commitment Rate'));
  check('training tab button present', tasksHtml.includes('Training'));

  // Training tab
  win.__t.state.progressTab = 'training';
  try { win.render(); } catch(e) { threw = true; console.log('Training tab error:', e.message); }
  check('training tab renders without error', !threw);
  const trainingHtml = win.document.getElementById('app').innerHTML;
  check('shows sessions logged', trainingHtml.includes('Sessions logged'));
  check('shows working sets done', trainingHtml.includes('Working sets done'));
  check('shows adherence section', trainingHtml.includes('Session Adherence'));
  check('shows weekly volume section', trainingHtml.includes('Weekly Volume'));
  check('shows e1RM section', trainingHtml.includes('1RM'));
  check('shows failure frequency section', trainingHtml.includes('Failure Frequency'));
  check('e1RM exercise picker present', trainingHtml.includes('<select'));
  check('Chest Press in exercise picker', trainingHtml.includes('Chest Press'));
}

/* ---------- 7. Empty state ---------- */
function emptyState() {
  section('7. Training tab shows empty state when no data');
  const win = loadApp();
  win.__t.state.view = 'progress';
  win.__t.state.progressTab = 'training';
  win.document.getElementById('app').classList.remove('hidden');
  let threw = false;
  try { win.render(); } catch(e) { threw = true; console.log('Empty state error:', e.message); }
  check('renders without error when no training data', !threw);
  const html = win.document.getElementById('app').innerHTML;
  check('shows empty state message', html.includes('No training data yet'));
}

/* ---------- 8. Tasks tab backwards compatible ---------- */
function tasksTabBackwardsCompat() {
  section('8. Tasks tab is unchanged from before');
  const win = loadApp();
  win.__t.state.view = 'progress';
  win.__t.state.progressTab = 'tasks';
  win.__t.state.progressRangeDays = 30;
  win.__t.state.progressKindFilter = 'all';
  win.document.getElementById('app').classList.remove('hidden');
  win.render();
  const html = win.document.getElementById('app').innerHTML;
  check('commitment rate shown', html.includes('Commitment Rate'));
  check('completed stat shown', html.includes('Completed'));
  check('activity log section present', html.includes('Activity Log'));
  check('range buttons present', html.includes('7 Days') && html.includes('30 Days'));
  // setProgressRange and setProgressKindFilter still work
  win.setProgressRange(7);
  check('progressRangeDays updated', win.__t.state.progressRangeDays === 7);
  win.setProgressKindFilter('recurring');
  check('progressKindFilter updated', win.__t.state.progressKindFilter === 'recurring');
}

/* ---------- 9. Version and changelog ---------- */
function versionDiscipline() {
  section('9. Version and changelog');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const v = /const APP_VERSION = '([\d.]+)'/.exec(js)[1];
  check('version is 4.4x', (()=>{ const [maj,min]=v.split('.').map(Number); return maj===4 && min>=40; })(), v);
  check('changelog leads with the shipped version',
        new RegExp(`const CHANGELOG = \\[\\s*\\{ v:'${v.replace(/\./g,'\\.')}'`).test(js));
  check('changelog says no SQL migration needed', js.slice(js.indexOf("{ v:'4.42.0'"), js.indexOf("{ v:'4.41.0'")).includes('No SQL migration'));
  check('built file carries the same version',
        fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8').includes(`const APP_VERSION = '${v}'`));
  const win = loadApp();
  check('backup coverage still complete',
        win.__t.SYNCED_TABLES.every(x => win.__t.BACKED_UP_TABLES.includes(x)));
}

e1RMHistoryTest();
weeklyVolumeHistoryTest();
sessionAdherenceTest();
failureRateTest();
svgChartHelpers();
progressPageRenders();
emptyState();
tasksTabBackwardsCompat();
versionDiscipline();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
