/* v4.69.0 duplicate task, top-of-range reps, RIR tap on done sets, lock class, tips */
const { loadApp } = require('./harness');
let pass=0, fail=0; const check=(n,c,d)=>{ if(c) pass++; else { fail++; console.log('  FAIL',n,d||''); } };
function setup(){
  const win = loadApp(); const t = win.__t; const today = win.todayStr();
  win.matchMedia = (q)=>({ matches:true, media:q, addListener(){}, removeListener(){} });
  t.state.training.exercises = [
    { id:'E1', name:'Chest Press', tags:[], tagIds:[], category:'strength', muscleGroup:'chest', restSec:null },
    { id:'E2', name:'Pec Fly', tags:[], tagIds:[], category:'strength', muscleGroup:'chest', restSec:null },
  ];
  t.state.training.sessions = [
    { id:'S1', name:'Push Today', type:'strength', format:'', color:null, blocks:[ {exerciseId:'E1', sets:3, reps:'8-12', notes:'suggested starting weight: 35kg'}, {exerciseId:'E2', sets:3, reps:'10-15', notes:'suggested starting weight: 15kg'} ] },
  ];
  t.state.training.calendar = [{ date:today, sessionId:'S1' }];
  t.state.trainingSelectedDate = today; t.state.trainingSection='today'; t.state.view='training';
  if(!win.document.getElementById('mainContent')){ const m=win.document.createElement('div'); m.id='mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = ()=>{};
  return { win, t, today };
}
(async()=>{
  // parseRepRange
  { const { win } = setup();
    const a = win.parseRepRange('8-12'), b = win.parseRepRange('12'), c = win.parseRepRange('10–15'), d = win.parseRepRange(null);
    check('range 8-12', a.min===8 && a.top===12); check('single 12', b.min===12 && b.top===12);
    check('en dash 10-15', c.min===10 && c.top===15); check('null', d.min===null && d.top===null); }
  // new day auto-fill: top of range, warm-up unchanged
  { const { win, t, today } = setup(); t.state.settings.repsTopMigrated469 = true;
    win.ensureSetsAutoFilled(today, ['E1','E2'], t.state.training.sessions[0]);
    const s1 = t.state.training.sets.filter(s=>s.exerciseId==='E1'&&!s.isWarmup), w1 = t.state.training.sets.find(s=>s.exerciseId==='E1'&&s.isWarmup);
    const s2 = t.state.training.sets.filter(s=>s.exerciseId==='E2'&&!s.isWarmup);
    check('E1 working sets = 12', s1.length===3 && s1.every(s=>s.reps===12), JSON.stringify(s1.map(s=>s.reps)));
    check('E2 working sets = 15', s2.length===3 && s2.every(s=>s.reps===15));
    check('warm-up reps unchanged (10)', w1 && w1.reps===10); }
  // one-time migration
  { const { win, t, today } = setup();
    const later = win.addDays(today, 2), past = win.addDays(today, -2);
    t.state.training.calendar.push({ date:later, sessionId:'S1' }, { date:past, sessionId:'S1' });
    const mk = (date, exId, setNo, reps, o)=>Object.assign({ date, exerciseId:exId, setNo, reps, weightKg:35, done:false, rir:null, toFailure:false, isWarmup:false }, o||{});
    t.state.training.sets = [
      mk(today,'E1',1,10,{isWarmup:true}), mk(today,'E1',2,8), mk(today,'E1',3,8,{done:true}), mk(today,'E1',4,9),
      mk(later,'E1',1,8), mk(later,'E2',1,10), mk(past,'E1',1,8),
    ];
    t.state.settings.repsTopMigrated469 = false;
    win.ensureSetsAutoFilled(today, ['E1'], t.state.training.sessions[0]);
    const g = (d,e,n)=>t.state.training.sets.find(s=>s.date===d&&s.exerciseId===e&&s.setNo===n).reps;
    check('not-done at bottom raised (today)', g(today,'E1',2)===12);
    check('done set untouched', g(today,'E1',3)===8);
    check('edited (9) untouched', g(today,'E1',4)===9);
    check('warm-up untouched', g(today,'E1',1)===10);
    check('future raised', g(later,'E1',1)===12 && g(later,'E2',1)===15);
    check('past untouched', g(past,'E1',1)===8);
    check('flag set', t.state.settings.repsTopMigrated469===true);
    t.state.training.sets.find(s=>s.date===today&&s.exerciseId==='E1'&&s.setNo===2).reps = 8;
    win.ensureSetsAutoFilled(today, ['E1'], t.state.training.sessions[0]);
    check('runs only once (manual 8 stays)', g(today,'E1',2)===8); }
  // mobile workout markup: lock class, RIR tap only on done working sets
  { const { win, t, today } = setup(); t.state.settings.repsTopMigrated469 = true;
    win.renderMain();
    let html = win.renderMobileWorkout();
    check('lock class on exercise screen', /class="mw mw-lock"/.test(html));
    check('no RIR tap while nothing done', !/onclick="openMwRirSheet/.test(html));
    const sets = t.state.training.sets.filter(s=>s.exerciseId==='E1');
    const w = sets.find(s=>!s.isWarmup&&s.setNo===2); w.done = true; w.rir = 2;
    sets.find(s=>s.isWarmup).done = true;
    html = win.renderMobileWorkout();
    const taps = html.match(/openMwRirSheet\('[^']*','E1',\d+,false\)/g)||[];
    check('exactly one RIR tap (done working set)', taps.length===1 && taps[0].includes(','+w.setNo+','), taps.join('|'));
    check('placeholder reps shows top', /placeholder="12"/.test(html));
    win.openMwRirSheet(today,'E1',w.setNo,false);
    win.mwPickMode(today,'E1',w.setNo,'rir',0);
    const after = t.state.training.sets.find(s=>s.date===today&&s.exerciseId==='E1'&&s.setNo===w.setNo);
    check('RIR changed, still done', after.rir===0 && after.done===true); }
  // duplicate
  { const { win, t, today } = setup();
    t.state.settings.locations=['Home']; t.state.settings.silos=['Alpha'];
    t.state.tasks.oneTime=[{ id:'o1', name:'Pay bill', location:'Home', silo:'Alpha', priority:'High', notes:'n1', due:'2026-11-05', done:false }];
    t.state.tasks.recurring=[{ id:'r1', name:'Gym', location:'Home', silo:'Alpha', priority:'Low', notes:'', type:'Weekly', detail:'Monday', start:'2026-10-01', end:null }];
    win.openTaskModal('oneTime','o1');
    check('edit modal has Duplicate', win.document.getElementById('modalOverlay').innerHTML.includes('duplicateTaskFromModal'));
    win.duplicateTaskFromModal();
    let ov = win.document.getElementById('modalOverlay').innerHTML;
    check('dup: new-task form', ov.includes('New One-Time Task') && ov.includes('Create Task') && !ov.includes('duplicateTaskFromModal'));
    check('dup: values copied', ov.includes('Pay bill (copy)') && ov.includes('value="2026-11-05"') && />n1</.test(ov) && /<option value="Home" selected(="")?>/.test(ov) && /<option value="High" selected(="")?>/.test(ov));
    await win.saveTaskModal();
    check('dup saved as new task', t.state.tasks.oneTime.length===2 && t.state.tasks.oneTime.some(x=>x.name==='Pay bill (copy)' && x.id!=='o1' && x.due==='2026-11-05' && x.priority==='High'));
    check('original untouched', t.state.tasks.oneTime.find(x=>x.id==='o1').name==='Pay bill');
    win.openTaskModal('recurring','r1');
    win.duplicateTaskFromModal();
    ov = win.document.getElementById('modalOverlay').innerHTML;
    check('recurring dup form', ov.includes('New Recurring Task') && ov.includes('Gym (copy)') && /<option value="Monday" selected(="")?>/.test(ov));
    await win.saveTaskModal();
    const rc = t.state.tasks.recurring.find(x=>x.name==='Gym (copy)');
    check('recurring dup saved', rc && rc.type==='Weekly' && rc.detail==='Monday' && rc.start==='2026-10-01' && t.state.tasks.recurring.length===2);
    win.openTaskModal('oneTime');
    check('new-task form has no Duplicate', !win.document.getElementById('modalOverlay').innerHTML.includes('duplicateTaskFromModal')); }
  // review pack + changelog
  { const { win, t } = setup();
    check('changelog 4.69.0 present', t.CHANGELOG.some(c=>c.v==='4.69.0')); }
  console.log(`test_v4690: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
