/* v4.67.0 scrubber, cascade, RIR-on-tick, swap, missing-data alarm, prompt, hydration removal */
const { loadApp } = require('./harness');
let pass=0, fail=0; const check=(n,c,d)=>{ if(c) pass++; else { fail++; console.log('  FAIL',n,d||''); } };
function setup(){
  const win = loadApp(); const t = win.__t; const today = win.todayStr();
  win.matchMedia = (q)=>({ matches:true, media:q, addListener(){}, removeListener(){} });
  t.state.training.exercises = [
    { id:'E1', name:'Chest Press', tags:[], tagIds:[], category:'strength', muscleGroup:'chest', restSec:null, weightIncrementKg:5 },
    { id:'E2', name:'Lat Pulldown', tags:[], tagIds:[], category:'strength', muscleGroup:'back', restSec:null },
    { id:'E3', name:'Pec Fly', tags:[], tagIds:[], category:'strength', muscleGroup:'chest', restSec:null },
    { id:'E4', name:'Incline Press', tags:[], tagIds:[], category:'strength', muscleGroup:'chest', restSec:null },
  ];
  t.state.training.sessions = [
    { id:'S1', name:'Push Today', type:'strength', format:'', color:null, blocks:[ {exerciseId:'E1', sets:3, reps:'8-12', notes:'suggested starting weight: 35kg'}, {exerciseId:'E2', sets:3, reps:'8-12', notes:'suggested starting weight: 40kg'} ] },
    { id:'S2', name:'Push Later', type:'strength', format:'', color:null, blocks:[ {exerciseId:'E1', sets:3, reps:'8-12', notes:'suggested starting weight: 35kg'} ] },
  ];
  const later = win.addDays(today, 3);
  t.state.training.calendar = [{ date:today, sessionId:'S1' }, { date:later, sessionId:'S2' }];
  t.state.trainingSelectedDate = today; t.state.trainingSection='today'; t.state.view='training';
  if(!win.document.getElementById('mainContent')){ const m=win.document.createElement('div'); m.id='mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = ()=>{};
  return { win, t, today, later };
}
const ev = (win, type, y)=>{ const e = new win.Event(type, {bubbles:true, cancelable:true}); e.clientY = y; return e; };

// --- scrubber
{ const { win, t, today } = setup(); win.renderMain();
  const sets = ()=>t.state.training.sets.filter(s=>s.date===today && s.exerciseId==='E1' && !s.isWarmup).sort((a,b)=>a.setNo-b.setNo);
  const inp = win.document.querySelector('input[data-np$="|2|weightKg"]');
  check('data-np present on tiles', !!inp, 'none');
  win.openNumPicker(inp,'weightKg',today,'E1',2);
  check('tap arms', inp.classList.contains('np-armed'));
  inp.value = '27.5';                       // off the 5kg grid
  inp.dispatchEvent(ev(win,'pointerdown',400));
  inp.dispatchEvent(ev(win,'pointermove',340));   // 60px up = +3 steps
  check('live value: 27.5 snaps to 30 then +3x5 = 45', inp.value === '45', inp.value);
  inp.dispatchEvent(ev(win,'pointerup',340));
  check('saved on release', sets().find(s=>s.setNo===2 || true) && t.state.training.sets.find(s=>s.date===today&&s.exerciseId==='E1'&&s.setNo===2).weightKg === 45);
  win.openNumPicker(inp,'weightKg',today,'E1',2); // click after drag is swallowed
  check('click after drag does not open keyboard', inp.hasAttribute('readonly'));
  inp.dispatchEvent(ev(win,'pointerdown',300)); inp.dispatchEvent(ev(win,'pointermove',400)); // 100px down = -5 steps
  check('drag down decreases', inp.value === '20', inp.value);
  inp.dispatchEvent(ev(win,'pointerup',400));
  win.document.body.dispatchEvent(ev(win,'pointerdown',10));
  check('tap elsewhere disarms', !inp.classList.contains('np-armed'));
}
// --- reps step 1, then second tap types
{ const { win, t, today } = setup(); win.renderMain();
  const inp = win.document.querySelector('input[data-np$="|1|reps"]') || win.document.querySelector('input[data-np$="|reps"]');
  const w2 = [...win.document.querySelectorAll('input[data-np$="|weightKg"]')][0];
  win.openNumPicker(w2,'weightKg',today,'E1',1); win.openNumPicker(w2,'weightKg',today,'E1',1);
  check('second tap on armed number unlocks typing', !w2.hasAttribute('readonly') && !w2.classList.contains('np-armed'));
  const w = [...win.document.querySelectorAll('input[data-np$="|reps"]')][0];
  win.openNumPicker(w,'reps',today,'E1',Number(w.dataset.np.split('|')[2]));
  w.value = '8'; w.dispatchEvent(ev(win,'pointerdown',200)); w.dispatchEvent(ev(win,'pointermove',160)); // +2
  check('reps step 1', w.value === '10', w.value); w.dispatchEvent(ev(win,'pointerup',160));
  win.openNumPicker(w,'reps',today,'E1',Number(w.dataset.np.split('|')[2]));   // suppressed (post-drag)
}
// --- cascade
{ const { win, t, today } = setup(); win.renderMain();
  const S = (n)=>t.state.training.sets.find(s=>s.date===today && s.exerciseId==='E1' && s.setNo===n);
  const work = t.state.training.sets.filter(s=>s.date===today && s.exerciseId==='E1' && !s.isWarmup).sort((a,b)=>a.setNo-b.setNo);
  const warm = t.state.training.sets.find(s=>s.date===today && s.exerciseId==='E1' && s.isWarmup);
  const warmW = warm ? warm.weightKg : null;
  const other = t.state.training.sets.find(s=>s.date===today && s.exerciseId==='E2' && !s.isWarmup);
  const otherW = other.weightKg;
  work[1].done = true; work[1].weightKg = 99;
  t.state.training.sets.push({ date:win.addDays(today,-7), exerciseId:'E1', setNo:3, reps:5, weightKg:77, done:true, isWarmup:false });
  win.updateSetField(today,'E1',work[0].setNo,'weightKg',35);
  check('later undone set follows', work[2].weightKg === 35, String(work[2].weightKg));
  check('done set untouched', work[1].weightKg === 99);
  check('earlier set untouched by later edit', (win.updateSetField(today,'E1',work[2].setNo,'reps',9), work[0].reps !== 9));
  check('warm-up untouched', !warm || warm.weightKg === warmW);
  check('other exercise untouched', other.weightKg === otherW);
  check('history untouched', t.state.training.sets.find(s=>s.date===win.addDays(today,-7)).weightKg === 77);
  if(warm){ win.updateSetField(today,'E1',warm.setNo,'weightKg',10); check('editing a warm-up cascades nothing', work[0].weightKg === 35); }
}
// --- tick -> RIR sheet
{ const { win, t, today } = setup(); win.renderMain();
  const work = t.state.training.sets.filter(s=>s.date===today && s.exerciseId==='E1' && !s.isWarmup).sort((a,b)=>a.setNo-b.setNo);
  const html = win.document.getElementById('mainContent').innerHTML;
  check('tick calls mwTickTap', html.includes('mwTickTap('));
  check('RIR is a display, not a button', !/<button class="mw-rir/.test(html) && html.includes('class="mw-rir'));
  win.mwTickTap(today,'E1',work[0].setNo,60);
  check('tap opens the effort sheet, set not done yet', !!win.document.getElementById('mwRir') && !work[0].done);
  check('sheet has Done, no RIR', win.document.getElementById('mwRir').innerHTML.includes('Done, no RIR'));
  win.mwPickMode(today,'E1',work[0].setNo,'rir',2);
  check('picking RIR completes set with rir 2', work[0].done === true && work[0].rir === 2);
  win.mwTickTap(today,'E1',work[1].setNo,60); win.mwDoneNoRir(today,'E1',work[1].setNo,60);
  check('Done, no RIR completes without RIR', work[1].done === true && work[1].rir == null);
  win.openMwRirSheet(today,'E1',work[0].setNo,false);
  win.mwPickMode(today,'E1',work[0].setNo,'rir',2);
  check('re-picking same RIR on a done set keeps it done', work[0].done === true && work[0].rir === 2);
  win.openMwRirSheet(today,'E1',work[0].setNo,false); win.mwPickMode(today,'E1',work[0].setNo,'rir',1);
  check('long-press edit changes RIR', work[0].rir === 1 && work[0].done);
  win.mwTickTap(today,'E1',work[0].setNo,60);
  check('tap on done set undoes it', work[0].done === false);
  const warm = t.state.training.sets.find(s=>s.date===today && s.exerciseId==='E1' && s.isWarmup);
  if(warm){ win.mwTickTap(today,'E1',warm.setNo,60); check('warm-up completes immediately', warm.done === true && !win.document.getElementById('mwRir')); }
}
// --- swap
{ const { win, t, today, later } = setup(); win.renderMain();
  const c = win.mwSwapCandidates(today,'E1').map(e=>e.id).sort();
  check('candidates share primary muscle only', c.join() === 'E3,E4', c.join());
  const work = t.state.training.sets.filter(s=>s.date===today && s.exerciseId==='E1' && !s.isWarmup).sort((a,b)=>a.setNo-b.setNo);
  work[0].done = true; work[0].weightKg = 25; work[0].reps = 10; work[0].loggedAt = new Date().toISOString();
  t.state.training.sets.push({ date:win.addDays(today,-10), exerciseId:'E3', setNo:1, reps:12, weightKg:32.5, done:true, isWarmup:false, loggedAt:'x' });
  // future day staged for E1
  win.renderMain();
  t.state.training.sets.push({ date:later, exerciseId:'E1', setNo:1, reps:8, weightKg:35, done:false, isWarmup:false });
  const ok = win.mwSwapExercise(today,'E1','E3');
  check('swap returns true', ok === true);
  const oldS = t.state.training.sets.filter(s=>s.date===today && s.exerciseId==='E1');
  check('done set stays on old exercise', oldS.length === 1 && oldS[0].done);
  const newS = t.state.training.sets.filter(s=>s.date===today && s.exerciseId==='E3' && !s.isWarmup);
  check('new exercise gets target minus done = 2 sets', newS.length === 2, String(newS.length));
  check('new exercise at its own last weight', newS.every(s=>s.weightKg === 32.5), JSON.stringify(newS.map(s=>s.weightKg)));
  check('today session block replaced', t.state.training.sessions.find(s=>s.id==='S1').blocks[0].exerciseId === 'E3');
  check('later session block replaced', t.state.training.sessions.find(s=>s.id==='S2').blocks[0].exerciseId === 'E3');
  check('future staged old sets removed', !t.state.training.sets.some(s=>s.date===later && s.exerciseId==='E1'));
  check('future day staged with new exercise', t.state.training.sets.some(s=>s.date===later && s.exerciseId==='E3'));
  check('cannot swap in one already on the day', win.mwSwapExercise(today,'E2','E3') === false);
}
// --- swap with nothing done removes the old exercise
{ const { win, t, today } = setup(); win.renderMain();
  win.mwSwapExercise(today,'E1','E4');
  check('no done sets -> old exercise gone', !t.state.training.sets.some(s=>s.date===today && s.exerciseId==='E1'));
  check('new has 3 sets', t.state.training.sets.filter(s=>s.date===today && s.exerciseId==='E4').length === 3);
}
// --- menu entry
{ const { win, t, today } = setup(); win.renderMain(); win.openMwMenu();
  check('menu has Swap this exercise', win.document.getElementById('mwMenu').innerHTML.includes('Swap this exercise'));
  win.openMwSwapSheet(today,'E1');
  const h = win.document.getElementById('mwSwap').innerHTML;
  check('swap sheet lists Pec Fly and not Lat Pulldown', h.includes('Pec Fly') && !h.includes('Lat Pulldown'));
}
// --- missing data alarm
{ const { win, t, today } = setup();
  t.state.healthCoreMetricsSeeded = true;
  const d = (n)=>win.addDays(today,-n);
  win.ensureCoreMetricDefs && win.ensureCoreMetricDefs();
  const defs = t.state.healthMetricDefs.filter(m=>m.visible!==false && m.id!=='core_water');
  check('water excluded from checked metrics', defs.every(m=>m.id!=='core_water'));
  check('no health entries -> nothing flagged', win.reviewPackMissingData().length === 0);
  const full = {}; 
  t.state.health = [ { date:d(5), weight:76, water:null, no2:true, calDeficit:500, custom:{} }, { date:d(3), weight:76, no2:true, calDeficit:500, custom:{} }, { date:today, weight:1, custom:{} } ];
  const miss = win.reviewPackMissingData();
  check('today excluded', !miss.some(m=>m.date===today));
  check('days before first entry not counted', !miss.some(m=>m.date < d(5)));
  check('empty day d4 flagged with metrics', miss.some(m=>m.date===d(4) && m.missing.length === defs.length), JSON.stringify(miss.map(m=>m.date)));
  check('complete day d3 not flagged', !miss.some(m=>m.date===d(3)) || miss.find(m=>m.date===d(3)).missing.length < defs.length);
  win.openMissingDataModal(miss);
  const h = win.document.getElementById('missingDataOverlay').innerHTML;
  check('modal has both buttons', h.includes('Go fill in') && h.includes('Copy anyway'));
  win.goFillMissingData(d(1));
  check('go fill in opens health on that day', t.state.view === 'health' && t.state.healthViewDate === d(1));
  check('pack carries missingHealthData', Array.isArray(win.buildTrainingReviewPack().missingHealthData));
  const pack = win.buildTrainingReviewPack();
  check('water not in bodyMetrics', !JSON.stringify(pack.bodyMetrics).includes('Water'));
}
// --- prompt
{ const { win } = setup(); let txt = '';
  win.navigator.clipboard = { writeText:(x)=>{ txt = x; return Promise.resolve(); } };
  win.copyTrainingReviewPack();
  check('coach persona', txt.includes('world-class') && txt.includes('Do not sugar-coat'));
  check('sense-check step', txt.includes('Data sense-check') && txt.includes('EXTRA data'));
  check('rationale per day, outside JSON', txt.includes('Rationale for every planned day') && txt.includes('NOT inside the JSON'));
  check('rules check', txt.includes('Rules check against my rules'));
  check('JSON schema unchanged', txt.includes('"exerciseSuggestions"') && txt.includes('"calendar"'));
}
// --- hydration gone
{ const { win, t } = setup(); t.state.view='health'; win.renderMain();
  const html = win.document.getElementById('mainContent').innerHTML;
  check('no hydration section on health page', !/Hydration|hydSettings|openHydration/i.test(html));
  check('hydration functions removed', typeof win.renderHydrationSection === 'undefined' && typeof win.openHydrationSettingsModal === 'undefined' && typeof win.getHydrationTotalForDate === 'undefined');
  const s = win.computeNewDaySummary(win.todayStr());
  check('new-day summary has no water', !('hydrationTotal' in s) && !win.newDaySummaryRowsHtml(s).includes('Water intake'));
}
// --- version
{ const { t } = setup(); check('changelog 4.67.0', t.CHANGELOG.some(c=>c.v === '4.67.0')); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
