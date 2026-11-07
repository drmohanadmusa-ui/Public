/* v4.65.0 */
const { loadApp } = require('./harness');
let pass=0, fail=0; const check=(n,c,d)=>{ if(c) pass++; else { fail++; console.log('  FAIL',n,d||''); } };
function setup(){
  const win = loadApp(); const t = win.__t; const today = win.todayStr();
  t.state.training.exercises = [{ id:'E1', name:'Chest Press', tags:[], tagIds:[], category:'strength', muscleGroup:'chest', restSec:null }];
  t.state.training.sessions = [{ id:'S1', name:'Push', type:'strength', format:'', color:null, blocks:[{exerciseId:'E1', sets:3, reps:'8-12', notes:'suggested starting weight: 35kg'}] }];
  t.state.training.calendar = [{ date:today, sessionId:'S1' }];
  t.state.trainingSelectedDate = today; t.state.trainingSection='today'; t.state.view='training';
  if(!win.document.getElementById('mainContent')){ const m=win.document.createElement('div'); m.id='mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = ()=>{};
  return { win, t, today };
}
// 1. ice % uses in-place card redraw
{ const { win, t } = setup(); t.state.view='coffee'; t.state.coffeeSection='brew'; win.renderMain();
  const main = win.document.getElementById('mainContent');
  const card = win.document.getElementById('coffeeCalcCard');
  check('calc card has id', !!card);
  main.dataset.marker = 'x'; const before = card;
  let full = 0; const orig = win.renderMain; win.renderMain = ()=>{ full++; return orig(); };
  win.coffeeCalcSet('icePct', 30, true);
  check('ice % change does not rebuild the page', full === 0, String(full));
  const after = win.document.getElementById('coffeeCalcCard');
  check('card replaced in place', after && after !== before);
  check('state updated', t.state.coffeeCalc.icePct === 30);
  check('pill 30 now active', /radio-pill active[^>]*>30%/.test(after.innerHTML));
  win.coffeeCalcSet('ratio', 15, true); win.coffeeCalcSet('iced', false, true); win.coffeeCalcSet('basis','total',true);
  check('other pills also in place', full === 0);
  check('hot hides ice section', !win.document.getElementById('coffeeIceVal'));
}
// 2. brew form: no detailed toggle, aftertaste/balance sliders + notes present
{ const { win, t } = setup(); t.state.view='coffee'; t.state.coffeeSection='brew'; win.renderMain();
  const html = win.document.getElementById('mainContent').innerHTML;
  check('no Detailed section', !/Detailed section/.test(html) && typeof win.coffeeToggleDetail === 'undefined');
  check('aftertaste slider present', html.includes("coffeeSetSlider('aftertaste'"));
  check('balance slider present', html.includes("coffeeSetSlider('balance'"));
  check('notes field present', html.includes("coffeeSetDraft('notes'"));
  check('aftertaste after strength, before verdict', html.indexOf("coffeeSetSlider('strength'") < html.indexOf("coffeeSetSlider('aftertaste'") && html.indexOf("coffeeSetSlider('balance'") < html.indexOf('Overall verdict'));
}
// 3. target badge has no count
{ const { win, t, today } = setup(); win.renderMain(); win.toggleTrainingRowExpanded(today,'E1'); win.renderMain();
  const html = win.document.getElementById('mainContent').innerHTML;
  check('badge still shows target', html.includes('Target:'));
  check('no "sets logged" count', !/sets logged<\/span>/.test(html) && !/\d+\/\d+ sets logged/.test(html));
}
// 4. log history auto-fills
{ const { win, t, today } = setup();
  t.state.training.sets = [
    { date:'2026-09-14', exerciseId:'E1', setNo:1, reps:10, weightKg:35, done:true, isWarmup:false },
    { date:'2026-09-14', exerciseId:'E1', setNo:2, reps:9, weightKg:35, done:true, isWarmup:false },
    { date:'2026-09-15', exerciseId:'E1', setNo:1, reps:10, weightKg:35, done:false, isWarmup:false },
  ];
  t.state.training.logs = [];
  const html = win.renderTrainingHistorySubpage();
  check('log created for completed date', t.state.training.logs.some(l=>l.date==='2026-09-14' && l.completed));
  check('history lists the completed date', /Sep/.test(html) && html.includes('10/9'));
  check('no log for undone-only date', !t.state.training.logs.some(l=>l.date==='2026-09-15'));
}
// 5. picker
{ const { win, t, today } = setup();
  t.state.training.sets = [{ date:today, exerciseId:'E1', setNo:1, reps:null, weightKg:null, done:false, isWarmup:false }];
  win.renderMain(); if(!win.document.querySelector('.num-pick')){ win.toggleTrainingRowExpanded(today,'E1'); win.renderMain(); }
  const inputs = [...win.document.querySelectorAll('.set-row .num-pick')];
  check('two readonly picker inputs per set', inputs.length >= 2 && inputs.every(i=>i.hasAttribute('readonly') && i.getAttribute('inputmode')==='none'));
  win.matchMedia = (q)=>({ matches:true, media:q, addListener(){}, removeListener(){} });
  win.openNumPicker(inputs[1],'weightKg',today,'E1',1);
  check('tap arms the number (scrubber replaced the wheel in 4.67.0)', inputs[1].classList.contains('np-armed') && !win.document.getElementById('numPickOverlay'));
}
// 6. review pack 30 days
{ const { win, t, today } = setup();
  const d = (n)=>win.addDays(today, -n);
  t.state.training.sets = [
    { date:d(25), exerciseId:'E1', setNo:1, reps:10, weightKg:35, done:true, isWarmup:false },
    { date:d(31), exerciseId:'E1', setNo:1, reps:10, weightKg:35, done:true, isWarmup:false },
  ];
  const pack = win.buildTrainingReviewPack();
  check('period starts 30 days back', pack.reviewPeriod.from === d(30), pack.reviewPeriod.from);
  const txt = JSON.stringify(pack);
  check('25-day-old session included', txt.includes(d(25)));
  check('31-day-old session excluded', !txt.includes(d(31)));
  check('forward schedule still 14 days', pack.trainingSchedule.length === 14);
}
// 7. version/changelog
{ const { win, t } = setup(); check('changelog has 4.65.0', t.CHANGELOG.some(c=>c.v==='4.65.0')); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
