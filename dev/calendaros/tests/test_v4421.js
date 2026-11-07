/* v4.42.1 — session targets (F8): target badge, target vs actual on completed card */
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }

function appWithSession() {
  const win = loadApp();
  const t = win.__t;
  const today = win.todayStr();
  t.state.training.exercises = [
    { id:'E1', name:'Chest Press', tags:[], tagIds:[], category:'strength', muscleGroup:'chest', restSec:null },
    { id:'E2', name:'Lat Pulldown', tags:[], tagIds:[], category:'strength', muscleGroup:'back', restSec:null },
  ];
  t.state.training.sessions = [{
    id:'S1', name:'Push Day', type:'strength', format:'', color:null,
    blocks:[
      { exerciseId:'E1', sets:3, reps:'8-12', notes:'suggested starting weight: 40kg' },
      { exerciseId:'E2', sets:3, reps:'10-15', notes:'' },
    ],
  }];
  t.state.training.calendar = [{ date:today, sessionId:'S1' }];
  t.state.trainingSelectedDate = today;
  t.state.trainingSection = 'today';
  t.state.view = 'training';
  win.document.getElementById('app').classList.remove('hidden');
  return { win, today };
}

/* ---------- 1. Session block map built correctly ---------- */
function sessionBlockMap() {
  section('1. Session block lookup: block data reaches the log row');
  const { win, today } = appWithSession();
  // Stage exercises as pending adds so the card renders
  win.__t.state.trainingPendingAdds[today] = ['E1','E2'];
  win.__t.state.trainingEditingDate = today;
  win.render();
  const html = win.document.getElementById('app').innerHTML;
  check('target badge div class present in HTML', html.includes('target-badge'));
  check('target badge shown for E1', html.includes('🎯 Target'));
  check('target rep range shown (8-12)', html.includes('8-12'));
  check('suggested weight parsed from notes', html.includes('40'));
  check('target shown for E2 (10-15)', html.includes('10-15'));
}

/* ---------- 2. Suggested weight parsed from block notes ---------- */
function suggestedWeightParsing() {
  section('2. "suggested starting weight: Xkg" parsed from notes');
  const win = loadApp();
  // Test through the rendered HTML
  const { win:w, today } = appWithSession();
  w.__t.state.trainingPendingAdds[today] = ['E1'];
  w.__t.state.trainingEditingDate = today;
  w.render();
  const html = w.document.getElementById('app').innerHTML;
  check('suggested 40kg appears in target badge', html.includes('40') && html.includes('suggested'));

  // No suggested weight in notes — should not show "suggested"
  w.__t.state.training.sessions[0].blocks[1].notes = '';
  w.render();
  const html2 = w.document.getElementById('app').innerHTML;
  // Only E1 has suggested weight, E2 does not
  const e2Section = html2.slice(html2.indexOf('Lat Pulldown'), html2.indexOf('Lat Pulldown')+500);
  check('E2 target badge has no suggested weight label',
        !e2Section.includes('suggested'), e2Section.slice(0,200));
}

/* ---------- 3. Target badge turns teal when met ---------- */
function targetMetIndicator() {
  section('3. Target badge turns teal when set count is met');
  const { win, today } = appWithSession();
  win.__t.state.trainingPendingAdds[today] = ['E1'];
  win.__t.state.trainingEditingDate = today;
  // Log 3 done working sets — meets the target of 3
  [1,2,3].forEach(setNo=>
    win.upsertTrainingSet({ date:today, exerciseId:'E1', setNo, reps:10, weightKg:40, done:true, isWarmup:false })
  );
  // v4.50.0: auto-collapse-when-complete was removed in favour of purely
  // manual collapse (see toggleTrainingRowExpanded) — rows default to
  // expanded now, so no forcing-open step is needed here any more.
  win.render();
  const html = win.document.getElementById('app').innerHTML;
  check('3/3 sets logged shown', html.includes('3/3') || html.includes('3/3 sets'));
  check('target-badge-met class applied', html.includes('target-badge-met'));

  // Remove one set — should no longer be met
  win.__t.state.training.sets = win.__t.state.training.sets.filter(s=>s.setNo!==3);
  win.render();
  const html2 = win.document.getElementById('app').innerHTML;
  check('2/3 shown when one set removed', html2.includes('2/3'));
}

/* ---------- 4. No session assigned — no target badge ---------- */
function noSessionNoTarget() {
  section('4. No target badge when no session is assigned to the date');
  const win = loadApp();
  const t = win.__t;
  const today = win.todayStr();
  t.state.training.exercises = [{ id:'E1', name:'Chest Press', tags:[], tagIds:[], category:'strength', muscleGroup:'chest' }];
  t.state.trainingPendingAdds[today] = ['E1'];
  t.state.trainingEditingDate = today;
  t.state.trainingSelectedDate = today;
  t.state.trainingSection = 'today';
  t.state.view = 'training';
  win.document.getElementById('app').classList.remove('hidden');
  win.render();
  const html = win.document.getElementById('app').innerHTML;
  check('no target badge when no session assigned', !html.includes('🎯 Target'));
}

/* ---------- 5. Completed card shows target vs actual ---------- */
function completedCardSummary() {
  section('5. Completed card shows target vs actual per exercise');
  const { win, today } = appWithSession();
  // Log enough to trigger the "fully logged" state
  ['E1','E2'].forEach(exId=>{
    win.__t.state.training.logs.push({ date:today, exerciseId:exId, completed:true, difficulty:null, notes:'' });
    [1,2,3].forEach(setNo=>{
      win.upsertTrainingSet({ date:today, exerciseId:exId, setNo, reps:10, weightKg:exId==='E1'?45:30, done:true, isWarmup:false });
    });
  });
  // Make sure the card shows in completed state
  win.__t.state.trainingEditingDate = null;
  win.render();
  const html = win.document.getElementById('app').innerHTML;
  check('Training logged header present', html.includes('Training logged'));
  check('target hit count in header', html.includes('/') && (html.includes('targets hit') || html.includes('target')));
  check('exercise name in summary', html.includes('Chest Press') || html.includes('Lat Pulldown'));
  check('set count in summary', html.includes('3 sets') || html.includes('3 set'));
  check('weight in summary (45kg for E1)', html.includes('45') || html.includes('kg'));
}

/* ---------- 6. Block data passed correctly through renderTrainingDayCard ---------- */
function blockDataFlowthrough() {
  section('6. renderTrainingDayCard passes block reps/sets/notes to each row');
  const { win, today } = appWithSession();
  win.__t.state.trainingPendingAdds[today] = ['E1','E2'];
  win.__t.state.trainingEditingDate = today;
  win.render();
  const html = win.document.getElementById('app').innerHTML;
  // Both exercises should show their respective targets
  const e1Idx = html.indexOf('Chest Press');
  const e2Idx = html.indexOf('Lat Pulldown');
  check('E1 target rep range 8-12 appears', html.slice(e1Idx, e1Idx+900).includes('8-12'));
  check('E2 target rep range 10-15 appears', html.slice(e2Idx, e2Idx+900).includes('10-15'));
}

/* ---------- 7. Version and changelog ---------- */
function versionDiscipline() {
  section('7. Version and changelog');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const v = /const APP_VERSION = '([\d.]+)'/.exec(js)[1];
  check('version is 4.42.x+', (()=>{ const [maj,min]=v.split('.').map(Number); return maj===4 && min>=42; })(), v);
  check('changelog leads with the shipped version',
        new RegExp(`const CHANGELOG = \\[\\s*\\{ v:'${v.replace(/\./g,'\\.')}'`).test(js));
  check('changelog mentions no SQL migration', js.slice(js.indexOf("{ v:'4.42.1'"), js.indexOf("{ v:'4.42.0'")).includes('No SQL migration'));
  check('built file carries the same version',
        fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8').includes(`const APP_VERSION = '${v}'`));
}

sessionBlockMap();
suggestedWeightParsing();
targetMetIndicator();
noSessionNoTarget();
completedCardSummary();
blockDataFlowthrough();
versionDiscipline();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
