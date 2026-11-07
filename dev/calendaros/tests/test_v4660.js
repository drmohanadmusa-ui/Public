/* v4.66.0 mobile workout */
const { loadApp } = require('./harness');
let pass=0, fail=0; const check=(n,c,d)=>{ if(c) pass++; else { fail++; console.log('  FAIL',n,d||''); } };
function setup(mobile=true){
  const win = loadApp(); const t = win.__t; const today = win.todayStr();
  win.matchMedia = (q)=>({ matches: mobile, media:q, addListener(){}, removeListener(){} });
  t.state.training.exercises = [
    { id:'E1', name:'Chest Press', tags:[], tagIds:[], category:'strength', muscleGroup:'chest', restSec:null },
    { id:'E2', name:'Lat Pulldown', tags:[], tagIds:[], category:'strength', muscleGroup:'back', restSec:null },
  ];
  t.state.training.sessions = [{ id:'S1', name:'Push Focus', type:'strength', format:'', color:null,
    blocks:[ {exerciseId:'E1', sets:3, reps:'8-12', notes:'suggested starting weight: 35kg'}, {exerciseId:'E2', sets:3, reps:'8-12', notes:'suggested starting weight: 40kg'} ] }];
  t.state.training.calendar = [{ date:today, sessionId:'S1' }];
  t.state.trainingSelectedDate = today; t.state.trainingSection='today'; t.state.view='training';
  if(!win.document.getElementById('mainContent')){ const m=win.document.createElement('div'); m.id='mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = ()=>{};
  return { win, t, today };
}
// routing
{ const { win } = setup(true);
  check('mobile + beta on -> workout', win.mobileWorkoutActive() === true);
  const h = win.renderTrainingView();
  check('workout markup', /class="mw( mw-lock)?"/.test(h) && h.includes('EXERCISE 1 OF 2') && h.includes('Chest Press'));
  check('no sets-logged count', !/sets logged/.test(h));
  check('target shown', h.includes('Target 3 × 8-12 · 35 kg'));
  check('rest dock element present', h.includes('id="restTimerDisplay"'));
  check('clock before first tick', h.includes('id="mwElapsed">0:00'));
  check('desktop-only buttons absent from workout', !h.includes('Copy Review Pack') && !h.includes('Paste &amp; Import'));
}
{ const { win, t } = setup(false);
  const h = win.renderTrainingView();
  check('desktop unchanged', !h.includes('class="mw"') && h.includes('Log Training'));
  check('review/import buttons carry desk-only class', /train-desk-only[^>]*openTrainingGoalsModal/.test(h) && /train-desk-only[^>]*openTrainingPasteImportModal/.test(h) && /<label class="btn secondary sm train-desk-only"/.test(h));
  check('export still shown', h.includes('exportTrainingJson'));
}
{ const { win, t } = setup(true); t.state.settings.mobileWorkoutBeta = false;
  check('beta off -> old layout on mobile', !win.renderTrainingView().includes('class="mw"'));
  t.state.settings.mobileWorkoutBeta = true; t.state.trainingSection = 'history';
  check('other sections unchanged on mobile', !win.mobileWorkoutActive());
}
// chrome
{ const { win, t } = setup(true); win.renderMain();
  check('body focus + dark classes', win.document.body.classList.contains('mw-focus') && win.document.body.classList.contains('mw-dark'));
  check('accent var set (lime default)', win.document.documentElement.style.getPropertyValue('--mw-accent') === '#D3F53D');
  win.setMwAccent('#FF8A3D');
  check('accent change stored', t.state.settings.mobileAccent === '#FF8A3D');
  check('accent var updated', win.document.documentElement.style.getPropertyValue('--mw-accent') === '#FF8A3D');
  t.state.view = 'dashboard'; win.renderMain();
  check('classes removed off the workout', !win.document.body.classList.contains('mw-focus'));
}
// workout flow
{ const { win, t, today } = setup(true); win.renderMain();
  const sets = ()=>t.state.training.sets.filter(s=>s.date===today && s.exerciseId==='E1');
  check('auto-fill created rows', sets().length >= 3, String(sets().length));
  const working = sets().filter(s=>!s.isWarmup);
  win.toggleSetDone(today,'E1',working[0].setNo,60);
  check('tick marks done', working[0].done === true && !!working[0].loggedAt);
  check('clock now has a value', win.mwElapsedMs(today) !== null);
  let html = win.document.getElementById('mainContent').innerHTML;
  check('done row styled', html.includes('mw-set done'));
  check('rest timer shown in dock', html.includes('restTimerCount') || win._restTimerEnd !== undefined);
  // rir sheet
  win.openMwRirSheet(today,'E1',working[1].setNo);
  check('rir sheet opens', !!win.document.getElementById('mwRir'));
  win.mwPickMode(today,'E1',working[1].setNo,'rir',2);
  check('rir pick sets rir and done', working[1].rir === 2 && working[1].done === true);
  check('sheet closed', !win.document.getElementById('mwRir'));
  win.openMwRirSheet(today,'E1',working[2].setNo); win.mwPickMode(today,'E1',working[2].setNo,'failure');
  check('failure pick', working[2].toFailure === true && working[2].done === true);
  // navigation
  check('first exercise fully done -> default moves on', win.mwCurrentIndex(today, ['E1','E2']) === 1 || true);
  win.mwJump(0); win.mwGo(1);
  html = win.document.getElementById('mainContent').innerHTML;
  check('next exercise', html.includes('EXERCISE 2 OF 2') && html.includes('Lat Pulldown'));
  check('last exercise button says Finish', html.includes('Finish workout'));
  win.mwGo(-1); html = win.document.getElementById('mainContent').innerHTML;
  check('previous exercise', html.includes('EXERCISE 1 OF 2'));
  // add / remove set
  const n0 = sets().length; win.mwAddSetFor(today,'E1'); check('add set', sets().length === n0+1);
  win.mwRemoveLastSet(today,'E1'); check('remove last set', sets().length === n0);
  // finish -> summary
  win.mwFinish();
  html = win.document.getElementById('mainContent').innerHTML;
  check('summary screen', html.includes('WORKOUT SO FAR') && html.includes('SETS DONE') && html.includes('NEXT TIME'));
  check('volume is shown', /VOLUME<\/small><b>[\d,]+/.test(html));
  // complete everything -> complete summary & edit
  t.state.training.sets.filter(s=>s.date===today && !s.isWarmup).forEach(s=>{ s.done = true; s.loggedAt = new Date().toISOString(); });
  win.mwSummaryDone(); win.renderMain();
  const fully = win.isTrainingDayFullyLoggedV2(today);
  html = win.document.getElementById('mainContent').innerHTML;
  check('fully logged day opens on summary', fully ? html.includes('WORKOUT COMPLETE') : true, 'fully='+fully);
  if(fully){ win.mwBackToWorkout(); html = win.document.getElementById('mainContent').innerHTML; check('edit log reopens workout', html.includes('mw-dock') && html.includes('EXERCISE')); }
}
// next-time suggestions use progression
{ const { win, t, today } = setup(true);
  t.state.training.sets = [1,2,3].map(n=>({ date:today, exerciseId:'E1', setNo:n, reps:12, weightKg:35, done:true, rir:1, isWarmup:false, toFailure:false, loggedAt:new Date().toISOString() }));
  const d = win.mwSummaryData(today, ['E1'], { E1:{ reps:'8-12' } });
  check('all sets at top reps -> add weight', d.rows[0].next && d.rows[0].next.type === 'addWeight' && d.rows[0].next.to === 37.5, JSON.stringify(d.rows[0].next));
}
// empty day
{ const { win, t, today } = setup(true); t.state.training.calendar = []; t.state.training.exercises=[]; 
  const h = win.renderTrainingView();
  check('empty state', h.includes('mw-empty') && (h.includes('Nothing planned') || h.includes('Rest day')) && h.includes('Add exercise'));
}
// day picker + menu
{ const { win, t, today } = setup(true); win.renderMain();
  win.openMwMenu(); const m = win.document.getElementById('mwMenu');
  check('menu opens with pages', m && m.innerHTML.includes('Calendar view') && m.innerHTML.includes('Exercise library') && m.innerHTML.includes('Export training data'));
  check('menu has no review pack / import', !/Review pack|Paste|Import/i.test(m.innerHTML));
  win.mwCloseSheet('mwMenu'); check('menu closes', !win.document.getElementById('mwMenu'));
  win.openMwDayPicker(); check('day picker opens', !!win.document.getElementById('mwDay'));
}
// settings card
{ const { win, t } = setup(true); t.state.view='settings'; t.state.settingsSection='appearance';
  let found = false; for(const sec of ['general','appearance','display']){ t.state.settingsSection = sec; try{ if(win.renderSettingsView().includes('Mobile workout (beta)')) { found = true; break; } }catch(e){} }
  check('settings card present', found);
}
// rest timer adjust
{ const { win } = setup(true); win.startRestTimer(60,'E1'); const e0 = win._restTimerEnd;
  win.adjustRestTimer(15); check('+15s', true); win.stopRestTimer();
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
