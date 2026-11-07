/* v4.68.0 dashboard silo filter, metric reorder, blank location/silo, date bubbles */
const { loadApp } = require('./harness');
let pass=0, fail=0; const check=(n,c,d)=>{ if(c) pass++; else { fail++; console.log('  FAIL',n,d||''); } };
function setup(){
  const win = loadApp(); const t = win.__t; const today = win.todayStr();
  win.matchMedia = (q)=>({ matches:false, media:q, addListener(){}, removeListener(){} });
  if(!win.document.getElementById('mainContent')){ const m=win.document.createElement('div'); m.id='mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = ()=>{};
  return { win, t, today };
}
// --- dashboard silo filter
{ const { win, t, today } = setup();
  t.state.settings.silos = ['Alpha','Beta'];
  t.state.tasks.oneTime = [
    { id:'a', name:'AlphaTask', location:'Home', silo:'Alpha', priority:'Medium', due:today, done:false },
    { id:'b', name:'BetaTask', location:'Home', silo:'Beta', priority:'Medium', due:today, done:false },
  ];
  t.state.tasks.recurring = [];
  let html = win.renderDashboard();
  check('All shows both', html.includes('AlphaTask') && html.includes('BetaTask'));
  check('chips: All + each silo', /data-silo="All"/.test(html) && /data-silo="Alpha"/.test(html) && /data-silo="Beta"/.test(html));
  win.setDashboardSilo('Alpha');
  html = win.renderDashboard();
  check('Alpha only', html.includes('AlphaTask') && !html.includes('BetaTask'));
  check('stat strip still overall (2 due today)', /<div class="stat-num">2<\/div>\s*<div class="stat-label">Due Today/.test(html));
  check('remembered in settings', t.state.settings.dashboardSilo === 'Alpha');
  t.state.settings.silos = ['Beta'];
  html = win.renderDashboard();
  check('removed silo falls back to All', html.includes('BetaTask'));
  win.setDashboardSilo('All');
  check('All clears', !t.state.settings.dashboardSilo);
}
// --- metric reorder
(async()=>{
  const { win, t } = setup();
  t.state.healthMetricDefs = [
    { id:'m1', name:'One', type:'number', sortOrder:-100, core:true, visible:true },
    { id:'m2', name:'Two', type:'number', sortOrder:5, visible:true },
    { id:'m3', name:'Three', type:'text', sortOrder:9, visible:true },
  ];
  const order = ()=>[...t.state.healthMetricDefs].sort((a,b)=>a.sortOrder-b.sortOrder).map(m=>m.id).join(',');
  await win.moveMetric('m3', -1);
  check('move up', order()==='m1,m3,m2', order());
  await win.moveMetric('m1', 1);
  check('built-in moves down', order()==='m3,m1,m2', order());
  await win.moveMetric('m3', -1);
  check('top stays top', order()==='m3,m1,m2', order());
  await win.reorderMetrics('m2', 0);
  check('drag m2 to top', order()==='m2,m3,m1', order());
  check('sortOrder renumbered 0..n-1', t.state.healthMetricDefs.map(m=>m.sortOrder).sort().join(',')==='0,1,2');
  const html = win.renderHealthView();
  const posCards = html.indexOf('Two'), posThree = html.indexOf('Three'), posOne = html.indexOf('One');
  check('cards follow new order', posCards>=0 && posCards<posThree && posThree<posOne);
  check('manage rows draggable + arrows', html.includes('draggable="true" data-metric-id="m2"') && html.includes('moveMetric(\'m2\',1)'));
  // --- task form blank defaults
  t.state.settings.locations = ['Home','Office']; t.state.settings.silos = ['Alpha','Beta'];
  let m = win.buildTaskModalHtml('oneTime', null);
  check('new: location placeholder selected', /<option value="" disabled selected>Select location/.test(m));
  check('new: silo placeholder selected', /<option value="" disabled selected>Select silo/.test(m));
  check('new: no real option pre-selected', !/<option value="Home" selected>/.test(m) && !/<option value="Alpha" selected>/.test(m));
  m = win.buildTaskModalHtml('oneTime', { id:'x', name:'E', location:'Office', silo:'Beta', priority:'High', due:'2026-11-01', notes:'' });
  check('edit keeps values', /<option value="Office" selected>/.test(m) && /<option value="Beta" selected>/.test(m) && !/disabled selected/.test(m));
  m = win.buildTaskModalHtml('oneTime', { id:'x', name:'E', location:'Gone', silo:'Alpha', priority:'Low', due:'2026-11-01', notes:'' });
  check('edit keeps value no longer in list', /<option value="Gone" selected>/.test(m));
  // save validation
  win.openTaskModal('oneTime');
  win.document.getElementById('f_name').value = 'New thing';
  await win.saveTaskModal();
  check('save blocked without location/silo', !t.state.tasks.oneTime.some(x=>x.name==='New thing'));
  win.document.getElementById('f_location').value = 'Home';
  await win.saveTaskModal();
  check('still blocked without silo', !t.state.tasks.oneTime.some(x=>x.name==='New thing'));
  win.document.getElementById('f_silo').value = 'Alpha';
  await win.saveTaskModal();
  check('saves once both chosen', t.state.tasks.oneTime.some(x=>x.name==='New thing' && x.location==='Home' && x.silo==='Alpha'));
  // recurring form too
  m = win.buildTaskModalHtml('recurring', null);
  check('recurring: placeholders too', /Select location/.test(m) && /Select silo/.test(m));
  // quick add unchanged
  await win.quickAddTask('Quick');
  const q = t.state.tasks.oneTime.find(x=>x.name==='Quick');
  check('quick-add unchanged', q && q.location==='Home' && q.silo==='Alpha');
  // --- bubbles above date
  m = win.buildTaskModalHtml('oneTime', null);
  check('due: bubbles before input', m.indexOf('quick-date-row') < m.indexOf('id="f_due"'));
  m = win.buildTaskModalHtml('recurring', { id:'r', name:'R', location:'Home', silo:'Alpha', priority:'Medium', type:'Daily', start:'2026-10-01' });
  win.modalOccurrenceDate = null;
  // reschedule block appears only with an occurrence; exercise via open
  win.openTaskModal('recurring','r','2026-10-25');
  const r = { id:'r', name:'R', location:'Home', silo:'Alpha', priority:'Medium', type:'Daily', start:'2026-10-01' };
  t.state.tasks.recurring = [r];
  win.closeModal && win.closeModal();
  win.openTaskModal('recurring','r','2026-10-25');
  const ov = win.document.getElementById('modalOverlay').innerHTML;
  check('reschedule: bubbles before input', ov.indexOf('quick-date-row') < ov.indexOf('id="f_reschedule_to"') && ov.includes('f_reschedule_to'));
  // version/changelog
  check('changelog has 4.68.0', t.CHANGELOG.some(c=>c.v==='4.68.0'));
  console.log(`test_v4680: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
