/* v4.71.0 move undo, hide missed/moved, health metric groups + SQL */
const fs = require('fs');
const { loadApp } = require('./harness');
let pass=0, fail=0; const check=(n,c,d)=>{ if(c) pass++; else { fail++; console.log('  FAIL',n,d||''); } };
function setup(){
  const win = loadApp(); const t = win.__t; const today = win.todayStr();
  win.matchMedia = (q)=>({ matches:false, media:q, addListener(){}, removeListener(){} });
  if(!win.document.getElementById('mainContent')){ const m=win.document.createElement('div'); m.id='mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = ()=>{};
  return { win, t, today };
}
(async()=>{
  // ---- SQL + sync wiring (source level)
  const built = fs.readFileSync('./CalendarOS.html','utf8');
  check('SQL: health_metric_defs.group_id in Copy SQL block', built.includes("alter table health_metric_defs add column if not exists group_id text;"));
  check('SQL: app_settings.metric_groups in Copy SQL block', built.includes("alter table app_settings add column if not exists metric_groups jsonb default '[]';"));
  check('settings upsert sends metric_groups (both places)', (built.match(/metric_groups: state\.settings\.metricGroups\|\|\[\]/g)||[]).length===2);
  check('settings pull reads metric_groups', built.includes('settingsRows[0].metric_groups'));
  { const { win, t } = setup();
    t.state.settings.sync = { pin:'1234' };
    check('metricDefToRow has group_id', win.metricDefToRow({ id:'m', name:'x', type:'number', groupId:'g1' }).group_id==='g1');
    check('metricDefToRow null when none', win.metricDefToRow({ id:'m', name:'x', type:'number' }).group_id===null);
    check('rowToMetricDef reads group_id', win.rowToMetricDef({ id:'m', name:'x', type:'number', group_id:'g1' }).groupId==='g1'); }

  // ---- move undo
  { const { win, t, today } = setup();
    const r = { id:'r1', name:'Gym', location:'Home', silo:'Alpha', priority:'Medium', type:'Daily', detail:'', start:win.addDays(today,-10), end:null, notes:'' };
    t.state.tasks.recurring = [r]; t.state.tasks.completions = {}; t.state.undoStack.length = 0;
    const from = win.addDays(today,-1), to = win.addDays(today,2);
    await win.rescheduleOccurrence('r1', from, to);
    check('move recorded exception', r.rescheduleExceptions.length===1 && r.rescheduleExceptions[0].to===to);
    check('move marked missed', win.isMissedOn('r1', from));
    check('undo entry pushed', t.state.undoStack.length===1 && t.state.undoStack[0].action==='move_occurrence');
    await win.undoLast();
    check('undo removed exception', r.rescheduleExceptions.length===0);
    check('undo cleared missed', !win.isMissedOn('r1', from));
    // chained: move then move again (inbound rewrite), undo twice
    await win.rescheduleOccurrence('r1', from, to);
    await win.rescheduleOccurrence('r1', to, win.addDays(to,3));
    check('chain collapsed to one exception', r.rescheduleExceptions.length===1 && r.rescheduleExceptions[0].to===win.addDays(to,3));
    await win.undoLast();
    check('first undo restores first move', r.rescheduleExceptions.length===1 && r.rescheduleExceptions[0].to===to);
    await win.undoLast();
    check('second undo restores original', r.rescheduleExceptions.length===0 && !win.isMissedOn('r1', from));
    // a previously-done from-date keeps its status through undo
    win.setOccurrenceStatus('r1', from, 'done');
    await win.rescheduleOccurrence('r1', from, to, { markMissed:false });
    await win.undoLast();
    check('done status preserved by undo', win.isCompletedOn('r1', from));
    // shift path
    const fut = win.nextOccurrenceDate(r, today);
    const res = await win.shiftNextOccurrence('r1', 2);
    check('shift moved', !!res);
    await win.undoLast();
    check('Ctrl+Z undoes a Shift too', r.rescheduleExceptions.length===0); }

  // ---- hide missed / moved
  { const { win, t, today } = setup();
    t.state.settings.silos=['Alpha']; t.state.settings.locations=['Home'];
    t.state.tasks.completions = {};
    t.state.tasks.oneTime = [
      { id:'o1', name:'PlainOne', location:'Home', silo:'Alpha', priority:'Medium', due:today, done:false, dueHistory:[] },
      { id:'o2', name:'MovedOne', location:'Home', silo:'Alpha', priority:'Medium', due:today, done:false, dueHistory:[win.addDays(today,-1)] },
    ];
    t.state.tasks.recurring = [
      { id:'r1', name:'PlainRec', location:'Home', silo:'Alpha', priority:'Medium', type:'Daily', detail:'', start:win.addDays(today,-5), end:null, notes:'' },
      { id:'r2', name:'MissedRec', location:'Home', silo:'Alpha', priority:'Medium', type:'Daily', detail:'', start:win.addDays(today,-5), end:null, notes:'' },
      { id:'r3', name:'MovedInRec', location:'Home', silo:'Alpha', priority:'Medium', type:'Daily', detail:'', start:win.addDays(today,-30), end:null, notes:'', rescheduleExceptions:[{ from:win.addDays(today,-3), to:today }] },
    ];
    win.setOccurrenceStatus('r2', today, 'missed');
    let html = win.renderDashboard();
    check('all visible when toggle off', ['PlainOne','MovedOne','PlainRec','MissedRec'].every(n=>html.includes(n)));
    await win.toggleHideMissedMoved();
    html = win.renderDashboard();
    check('plain remain', html.includes('PlainOne') && html.includes('PlainRec'));
    check('only missed hidden; moved-in and rescheduled-earlier stay visible', html.includes('MovedOne') && html.includes('MovedInRec') && !html.includes('MissedRec'));
    check('moved away from the shown date counts as moved', win.isRowMissedOrMoved({ kind:'recurring', task:{ id:'x', rescheduleExceptions:[{ from:today, to:win.addDays(today,2) }] }, dueOn:today }));
    check('one-time never hidden by this switch', !win.isRowMissedOrMoved({ kind:'oneTime', task:{ dueHistory:['2026-01-01'] }, dueOn:today }));
    check('toggle has switch label', html.includes('Hide missed / moved'));
    check('stored locally in settings', t.state.settings.hideMissedMoved===true); }

  // ---- groups
  { const { win, t } = setup();
    t.state.healthMetricDefs = [
      { id:'a', name:'Protein', type:'number', sortOrder:0, visible:true },
      { id:'b', name:'Carbs', type:'number', sortOrder:1, visible:true },
      { id:'c', name:'Waist', type:'number', sortOrder:2, visible:true },
      { id:'d', name:'Sleep', type:'number', sortOrder:3, visible:true },
    ];
    t.state.settings.metricGroups = []; t.state.settings.healthCoreMetricsSeeded = true;
    let html = win.renderHealthView();
    check('no groups: no group headings', !html.includes('metric-group-head') && !html.includes('mg-row'));
    check('Add group button present', html.includes('addMetricGroup()'));
    const answers = ['Macros','Body'];
    win.prompt = ()=> answers.shift();
    await win.addMetricGroup(); await win.addMetricGroup();
    const gs = t.state.settings.metricGroups;
    check('two groups added in order', gs.length===2 && gs[0].name==='Macros' && gs[1].name==='Body');
    win.prompt = ()=>'macros';
    await win.addMetricGroup();
    check('duplicate name rejected', t.state.settings.metricGroups.length===2);
    // assign via modal
    win.openMetricModal('a');
    check('modal has group select', !!win.document.getElementById('metricGroup'));
    win.document.getElementById('metricGroup').value = gs[0].id; await win.submitMetricModal();
    win.openMetricModal('b'); win.document.getElementById('metricGroup').value = gs[0].id; await win.submitMetricModal();
    win.openMetricModal('c'); win.document.getElementById('metricGroup').value = gs[1].id; await win.submitMetricModal();
    const byId = id=>t.state.healthMetricDefs.find(m=>m.id===id);
    check('groupIds stored', byId('a').groupId===gs[0].id && byId('c').groupId===gs[1].id && !byId('d').groupId);
    const order = ()=>win.metricsInDisplayOrder(false).map(m=>m.id).join(',');
    check('display order: group by group, then none', order()==='a,b,c,d', order());
    html = win.renderHealthView();
    const iM = html.indexOf('>Macros<'), iB = html.indexOf('>Body<'), iN = html.indexOf('>No group<');
    check('headings in group order + No group', iM>0 && iM<iB && iB<iN, [iM,iB,iN].join());
    check('History group header row', html.includes('mg-row') && html.includes('colspan="2"'));
    // arrows stay inside group
    await win.moveMetric('b', 1);   // b is last in Macros; next is Body's c -> must not cross
    check('arrow does not cross group', order()==='a,b,c,d' && byId('b').groupId===gs[0].id);
    await win.moveMetric('b', -1);
    check('arrow reorders inside group', order()==='b,a,c,d', order());
    // drag across groups ignored
    win.__t; win.onMetricDragStart({ currentTarget:{ dataset:{ metricId:'a' }, classList:{ add(){} } }, dataTransfer:{} });
    await win.onMetricDrop({ preventDefault(){}, currentTarget:{ dataset:{ metricId:'c' } } });
    check('drag across groups ignored', order()==='b,a,c,d', order());
    // group order
    await win.moveMetricGroup(gs[1].id, -1);
    check('group moved up -> Body first', win.metricsInDisplayOrder(false).map(m=>m.id).join(',')==='c,b,a,d');
    // collapse
    await win.toggleMetricGroupCollapse(gs[0].id);
    html = win.renderHealthView();
    check('collapsed group hides its cards', !html.includes('health-input-card') || !/>Protein</.test(html.split('Manage Metrics')[0]));
    await win.toggleMetricGroupCollapse(gs[0].id);
    // rename
    win.prompt = ()=>'Macronutrients'; await win.renameMetricGroup(gs[0].id);
    check('rename', t.state.settings.metricGroups.find(g=>g.id===gs[0].id).name==='Macronutrients');
    // delete group keeps metrics
    win.confirm = ()=>true;
    await win.deleteMetricGroup(gs[0].id);
    check('delete group: metrics kept, ungrouped', t.state.healthMetricDefs.length===4 && !byId('a').groupId && !byId('b').groupId && t.state.settings.metricGroups.length===1);
    check('deleted group metrics now in No group', win.metricSections(false).slice(-1)[0].metrics.map(m=>m.id).sort().join(',')==='a,b,d');
    // orphan groupId (deleted on another device) is treated as no group
    byId('d').groupId = 'ghost';
    check('orphan groupId treated as ungrouped', win.metricSections(false).slice(-1)[0].metrics.some(m=>m.id==='d'));
    // value entry still works with grouped cards
    t.state.healthViewDate = win.todayStr();
    await win.setMetricValue('c', '88');
    check('setMetricValue works with groups', win.getMetricValue(win.getHealthEntry(win.todayStr()), byId('c'))===88); }

  const { t } = setup();
  check('changelog 4.71.0', t.CHANGELOG.some(c=>c.v==='4.71.0'));
  console.log(`test_v4710: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
