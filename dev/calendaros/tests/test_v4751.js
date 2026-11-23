/* v4.75.1: sleep score / resting heart rate meanings, "Sleep Score" guess fix,
   "swapped days" missed-day reason. All data invented. */
const { loadApp } = require('./harness');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) pass++; else { fail++; console.log('  FAIL', n, d === undefined ? '' : d); } };

function setup() {
  const win = loadApp(); const t = win.__t;
  win.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {} });
  if (!win.document.getElementById('mainContent')) { const m = win.document.createElement('div'); m.id = 'mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = () => {};
  t.state.settings.healthCoreMetricsSeeded = true;
  t.state.settings.sync = { pin: '1234' };
  return { win, t, today: win.todayStr() };
}

(async () => {
  // ---- guesses
  { const { win } = setup();
    check('Sleep Score -> sleep_score', win.guessMetricRole('Sleep Score') === 'sleep_score');
    check('Sleep Hours still -> sleep', win.guessMetricRole('Sleep Hours') === 'sleep');
    check('Resting Heart Rate -> resting_hr', win.guessMetricRole('Resting Heart Rate') === 'resting_hr');
    check('Daily Steps unchanged', win.guessMetricRole('Daily Steps') === 'steps');
    check('Mood -> none', win.guessMetricRole('Mood') === '');
  }

  // ---- stale "none" offered the new meaning once, labels shown
  { const { win, t } = setup();
    t.state.healthMetricDefs = [
      { id: 'm_sh', name: 'Sleep Hours', type: 'number', unit: 'min', role: 'sleep' },
      { id: 'm_ss', name: 'Sleep Score', type: 'number', role: '' },
      { id: 'm_hr', name: 'Resting Heart Rate', type: 'number', role: '' },
      { id: 'm_mood', name: 'Mood', type: 'text', role: '' },
    ];
    t.state.health = [];
    check('banner back for the new meanings', win.healthRolesNeedConfirm() === true);
    win.openMetricRolesModal();
    const sel = id => win.document.querySelector(`#metricRolesOverlay [data-role-metric="${id}"]`);
    check('sleep score prefilled with its guess', sel('m_ss') && sel('m_ss').value === 'sleep_score');
    check('resting HR prefilled with its guess', sel('m_hr') && sel('m_hr').value === 'resting_hr');
    check('mood stays none', sel('m_mood') && sel('m_mood').value === '');
    check('sleep hours keeps sleep', sel('m_sh') && sel('m_sh').value === 'sleep');
    const html = win.document.getElementById('metricRolesOverlay').innerHTML;
    check('readable labels', html.includes('>resting heart rate<') && html.includes('>sleep score<'));
    await win.saveMetricRoles();
    check('saved new meanings', t.state.healthMetricDefs.find(m => m.id === 'm_ss').role === 'sleep_score' && t.state.healthMetricDefs.find(m => m.id === 'm_hr').role === 'resting_hr');
    check('banner gone after save', win.healthRolesNeedConfirm() === false);
    // a deliberate "none" for a new meaning is not asked about forever once another metric holds it
    t.state.healthMetricDefs.push({ id: 'm_hr2', name: 'Heart rate (watch)', type: 'number', role: '' });
    check('no banner when the meaning is already held', win.healthRolesNeedConfirm() === false);
  }

  // ---- weekly averages
  { const { win, t } = setup();
    t.state.healthMetricDefs = [
      { id: 'm_sh', name: 'Sleep Hours', type: 'number', unit: 'min', role: 'sleep' },
      { id: 'm_ss', name: 'Sleep Score', type: 'number', role: 'sleep_score' },
      { id: 'm_hr', name: 'Resting Heart Rate', type: 'number', role: 'resting_hr' },
    ];
    const ws = win.getCalendarWeekBounds(-1).weekStart;
    t.state.health = [{ date: ws, custom: { m_sh: 420, m_ss: 80, m_hr: 60 } }, { date: win.addDays(ws, 1), custom: { m_sh: 480, m_ss: '70', m_hr: 64 } }];
    const w = win.buildTrainingReviewPack().weeklyHistory[0];
    check('avg sleep minutes', w.avgSleepMin === 450, JSON.stringify(w));
    check('avg sleep score (text normalised)', w.avgSleepScore === 75);
    check('avg resting HR', w.avgRestingHr === 62);
    check('weight average still there', 'avgWeightKg' in w);
  }

  // ---- swapped days
  { const { win, t, today } = setup();
    const d = win.addDays(today, -1);
    t.state.training.exercises = [{ id: 'LP', name: 'Leg Press', category: 'strength', muscleGroupsPrimary: ['quads'], tagIds: [] }];
    t.state.training.sessions = [{ id: 'S1', name: 'Legs', blocks: [{ exerciseId: 'LP', sets: 3, reps: '8-12' }] }];
    t.state.training.calendar = [{ date: d, sessionId: 'S1' }];
    t.state.settings.trainingSkipReasons = {};
    win.maybeShowMissedTrainingSheet();
    const ov = win.document.getElementById('missedTrainingOverlay');
    check('swapped days offered', ov && ov.innerHTML.includes('swapped days'));
    check('other reasons kept', ov && ['work', 'sleep', 'energy', 'travel', 'other'].every(r => ov.innerHTML.includes(`'${r}')`)));
    win.setTrainingSkipReason(d, 'swapped days');
    const p = win.buildTrainingReviewPack();
    check('swapped days in pack', p.skipReasons.some(r => r.date === d && r.reason === 'swapped days'));
    let txt = ''; win.navigator.clipboard = { writeText: x => { txt = x; return Promise.resolve(); } };
    win.copyTrainingReviewPack();
    check('prompt explains swapped days', txt.includes('"swapped days" = I moved that session to another day'));
  }

  check('changelog 4.75.1', loadApp().__t.CHANGELOG.some(c => c.v === '4.75.1'));
  console.log(`test_v4751: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed:', e && e.stack || e); console.log(`test_v4751: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
