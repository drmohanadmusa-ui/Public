/* v4.75.0: phone notes, missed-day reasons, health metric meanings + checks,
   "rested longer?", actual rest, goals out of the code, Review Pack data and
   prompt changes. All data invented. */
const { loadApp } = require('./harness');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) pass++; else { fail++; console.log('  FAIL', n, d === undefined ? '' : d); } };

function setup() {
  const win = loadApp(); const t = win.__t;
  win.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {} });
  if (!win.document.getElementById('mainContent')) { const m = win.document.createElement('div'); m.id = 'mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = () => {};
  t.state.settings.healthCoreMetricsSeeded = true;
  t.state.settings.sync = { pin: '1234' };   // row mapping only, no url so nothing syncs
  t.state.training.exercises = [
    { id: 'LP', name: 'Leg Press', category: 'strength', muscleGroupsPrimary: ['quads'], weightIncrementKg: 10, notes: 'feet high', tags: [], tagIds: [] },
    { id: 'CP', name: 'Chest Press', category: 'strength', muscleGroupsPrimary: ['chest'], weightIncrementKg: 2.5, tags: [], tagIds: [] },
  ];
  let txt = '';
  win.navigator.clipboard = { writeText: (x) => { txt = x; return Promise.resolve(); } };
  return { win, t, today: win.todayStr(), prompt: () => { win.copyTrainingReviewPack(); return txt; } };
}
const set = (setNo, reps, extra) => Object.assign({ setNo, reps, weightKg: 40, rir: 2, isWarmup: false, toFailure: false, done: false }, extra || {});

(async () => {
  // ---- 1. phone notes
  { const { win, t, today } = setup();
    t.state.training.sets = [Object.assign(set(1, 10), { date: today, exerciseId: 'LP' })];
    win.openMwNotesSheet(today, 'LP');
    const day = win.document.getElementById('mwDayNote'), exn = win.document.getElementById('mwExNote');
    check('notes sheet has both fields', !!day && !!exn);
    check('exercise note prefilled', exn && exn.value === 'feet high');
    if (day && exn) { day.value = 'knee felt odd'; exn.value = 'feet high, seat 4'; }
    win.saveMwNotes(today, 'LP');
    const log = t.state.training.logs.find(l => l.date === today && l.exerciseId === 'LP');
    check('day note saved to training log', log && log.notes === 'knee felt odd');
    check('exercise note saved', t.state.training.exercises[0].notes === 'feet high, seat 4');
    check('day note maps to training_logs.notes', win.trainingLogToRow(log).notes === 'knee felt odd');
    win.document.querySelectorAll('.modal-overlay').forEach(o => o.remove());
    const pack = win.buildTrainingReviewPack();
    t.state.training.sets[0].done = true;
    const pack2 = win.buildTrainingReviewPack();
    const sd = pack2.sessionDetail.find(x => x.exercise === 'Leg Press');
    check('pack: dayNote in session detail', sd && sd.dayNote === 'knee felt odd', JSON.stringify(sd));
    const { prompt } = (() => { const s = setup(); s.t.state.training.exercises[0].notes = 'feet high'; return s; })();
    check('prompt: library notes field', prompt().includes('"notes": "feet high"'));
    check('pack built', !!pack);
  }

  // ---- 2. missed days
  { const { win, t, today } = setup();
    const d1 = win.addDays(today, -2), d2 = win.addDays(today, -3), old = win.addDays(today, -20), done = win.addDays(today, -4);
    t.state.training.sessions = [{ id: 'S1', name: 'Legs', blocks: [{ exerciseId: 'LP', sets: 3, reps: '8-12', notes: 'suggested starting weight: 70kg' }] }];
    t.state.training.calendar = [d1, d2, old, done, today].map(d => ({ date: d, sessionId: 'S1' }));
    t.state.training.sets = [Object.assign(set(1, 10, { done: true }), { date: done, exerciseId: 'LP' })];
    t.state.settings.trainingSkipReasons = {};
    const m = win.missedTrainingDays();
    check('missed: unlogged past days in 14-day window', m.length === 2 && m.includes(d1) && m.includes(d2), JSON.stringify(m));
    win.maybeShowMissedTrainingSheet();
    check('missed: sheet shown', !!win.document.getElementById('missedTrainingOverlay'));
    win.setTrainingSkipReason(d1, 'work');
    check('missed: reason stored', t.state.settings.trainingSkipReasons[d1] === 'work');
    check('missed: answered day leaves the list', !win.missedTrainingDays().includes(d1));
    win.setTrainingSkipReason(d2, 'sleep');
    check('missed: sheet closes when all answered', !win.document.getElementById('missedTrainingOverlay'));
    const pack = win.buildTrainingReviewPack();
    check('pack: skip reasons', pack.skipReasons.length === 2 && pack.skipReasons.some(r => r.date === d1 && r.reason === 'work'));
    check('pack: planned vs done', pack.plannedVsDone.some(p => p.date === done && p.blocks[0].plannedWeightKg === 70 && p.blocks[0].doneSets === 1));
    check('pack: no plannedVsDone for today', !pack.plannedVsDone.some(p => p.date === today));
    const src = require('fs').readFileSync('./CalendarOS.html', 'utf8');
    ['training_skip_reasons jsonb', 'role text', 'day_complete boolean', 'note text'].forEach(c =>
      check('SQL block adds ' + c, src.includes('add column if not exists ' + c)));
    check('skip reasons in app_settings upsert', (src.match(/training_skip_reasons: state\.settings\.trainingSkipReasons/g) || []).length === 2);
  }

  // ---- 3. health meanings, calorie check, day complete, sleep/weight conversion
  { const { win, t, today } = setup();
    check('guess: calories', win.guessMetricRole('Calories') === 'calories');
    check('guess: deficit is not calories', win.guessMetricRole('Calorie Deficit') === '');
    check('guess: body fat is not fat', win.guessMetricRole('Body fat %') === '');
    check('guess: fat', win.guessMetricRole('Fat (g)') === 'fat');
    check('guess: sleep / weight / steps / fibre', win.guessMetricRole('Sleep') === 'sleep' && win.guessMetricRole('Weight') === 'weight' && win.guessMetricRole('Steps') === 'steps' && win.guessMetricRole('Fibre') === 'fiber');
    check('sleep: 6.34 = 6 h 34 min', win.normRoleValue('sleep', 6.34) === 394);
    check('sleep: "6.34" text = 394', win.normRoleValue('sleep', '6.34') === 394);
    check('sleep: "5:00" = 300', win.normRoleValue('sleep', '5:00') === 300);
    check('sleep: 6.5 (typed 6.50) = 6 h 50', win.normRoleValue('sleep', 6.5) === 410);
    check('sleep: minutes pass through', win.normRoleValue('sleep', 394) === 394);
    check('weight: "102 Kgs" = 102', win.normRoleValue('weight', '102 Kgs') === 102);
    check('weight: number unchanged', win.normRoleValue('weight', 101.4) === 101.4);

    t.state.healthMetricDefs = [
      { id: 'm_cal', name: 'Calories', type: 'number', unit: 'kcal' }, { id: 'm_pro', name: 'Protein', type: 'number', unit: 'g' },
      { id: 'm_fat', name: 'Fat', type: 'number', unit: 'g' }, { id: 'm_carb', name: 'Carbs', type: 'number', unit: 'g' },
      { id: 'm_sleep', name: 'Sleep', type: 'text' }, { id: 'm_wt', name: 'Weight', type: 'text' }, { id: 'm_mood', name: 'Mood', type: 'text' },
    ];
    const y = win.addDays(today, -1);
    t.state.health = [{ date: y, custom: { m_sleep: '6.34', m_wt: '102 Kgs', m_mood: 'ok' } }, { date: win.addDays(today, -2), custom: { m_sleep: 394, m_wt: 101 } }];
    check('roles: needs confirm before saving', win.healthRolesNeedConfirm() === true);
    check('roles: no conversion before confirm', win.migrateHealthRoleValues() === false && t.state.health[0].custom.m_sleep === '6.34');
    win.openMetricRolesModal();
    const sels = [...win.document.querySelectorAll('#metricRolesOverlay [data-role-metric]')];
    check('roles modal lists metrics with guesses', sels.length === 7 && sels.find(s => s.dataset.roleMetric === 'm_sleep').value === 'sleep');
    await win.saveMetricRoles();
    check('roles saved', t.state.healthMetricDefs.find(m => m.id === 'm_sleep').role === 'sleep' && t.state.healthMetricDefs.find(m => m.id === 'm_mood').role === '');
    check('roles: confirmed, banner gone', win.healthRolesNeedConfirm() === false);
    check('converted: sleep 6.34 -> 394 min', t.state.health[0].custom.m_sleep === 394);
    check('converted: sleep already minutes untouched', t.state.health[1].custom.m_sleep === 394);
    check('converted: weight text -> 102', t.state.health[0].custom.m_wt === 102);
    check('sleep metric is number, unit min', t.state.healthMetricDefs.find(m => m.id === 'm_sleep').type === 'number' && t.state.healthMetricDefs.find(m => m.id === 'm_sleep').unit === 'min');
    check('mood text untouched', t.state.health[0].custom.m_mood === 'ok');
    check('role maps to row and back', win.rowToMetricDef(win.metricDefToRow(t.state.healthMetricDefs[0])).role === 'calories');
    check('sleep shown as h + min', win.formatMetricValue(t.state.healthMetricDefs.find(m => m.id === 'm_sleep'), 394) === '6 h 34 min');

    // sleep entry
    t.state.healthViewDate = today;
    const card = win.renderMetricCard(t.state.healthMetricDefs.find(m => m.id === 'm_sleep'), { custom: { m_sleep: 394 } });
    check('sleep card has hours + minutes inputs', card.includes('sleepH_m_sleep') && card.includes('sleepM_m_sleep') && /value="6"/.test(card) && /value="34"/.test(card));

    // calorie check
    win.document.querySelectorAll('.modal-overlay').forEach(o => o.remove());
    await win.setMetricValue('m_cal', '2000');
    await win.setMetricValue('m_pro', '150');
    await win.setMetricValue('m_carb', '200');
    const e = () => t.state.health.find(h => h.date === today);
    check('macros within 10%: saved, no warning', e().custom.m_carb === 200 && !win.document.getElementById('macroWarnOverlay'));
    await win.setMetricValue('m_fat', '80');   // 600+800+720 = 2120 <= 2200
    check('2120 vs 2000 kcal is within 10%', e().custom.m_fat === 80 && !win.document.getElementById('macroWarnOverlay'));
    await win.setMetricValue('m_fat', '120');  // 600+800+1080 = 2480 > 2200
    check('over 10%: warning shown', !!win.document.getElementById('macroWarnOverlay'));
    check('over 10%: not saved yet', e().custom.m_fat === 80);
    await win.setMetricValue('m_fat', '120', true);
    check('Save anyway saves', e().custom.m_fat === 120);
    win.document.querySelectorAll('.modal-overlay').forEach(o => o.remove());

    // day complete
    win.setHealthDayComplete(true);
    check('day complete stored + mapped', e().dayComplete === true && win.healthToRow(e()).day_complete === true && win.rowToHealth({ day_complete: true }).dayComplete === true);
    t.state.health.push({ date: win.addDays(today, 1), custom: { m_mood: 'x' } });
    const pack = win.buildTrainingReviewPack();
    const bm = d => pack.bodyMetrics.find(b => b.date === d);
    check('pack: ticked day not partial', bm(today) && !bm(today).partial);
    check('pack: days before first tick not flagged', bm(y) && !bm(y).partial);
    check('pack: weekly history has 4 weeks with averages fields', pack.weeklyHistory.length === 4 && 'avgWeightKg' in pack.weeklyHistory[0] && 'avgProteinG' in pack.weeklyHistory[0]);
    // weekly average uses roles: put entries in last week
    const lastWeekStart = win.getCalendarWeekBounds(-1).weekStart;
    t.state.health = [{ date: lastWeekStart, custom: { m_wt: 100, m_cal: 2000 } }, { date: win.addDays(lastWeekStart, 1), custom: { m_wt: '101 kg', m_cal: 1800 } }];
    const w = win.buildTrainingReviewPack().weeklyHistory[0];
    check('weekly avg weight from role (text normalised)', w.avgWeightKg === 100.5, JSON.stringify(w));
    check('weekly avg calories', w.avgCalories === 1900);
  }

  // ---- 4 + 5. rested longer, actual rest
  { const { win, t, today } = setup();
    const t0 = Date.now() - 10 * 60000;
    t.state.training.sets = [
      Object.assign(set(1, 10, { done: true, toFailure: true, rir: null, loggedAt: new Date(t0).toISOString() }), { date: today, exerciseId: 'CP' }),
      Object.assign(set(2, 12), { date: today, exerciseId: 'CP' }),
      Object.assign(set(3, 9), { date: today, exerciseId: 'CP' }),
    ];
    win.toggleSetDone(today, 'CP', 2, 60);
    const s2 = t.state.training.sets[1];
    check('rest recorded (~600 s)', s2.restTakenSec >= 595 && s2.restTakenSec <= 605, s2.restTakenSec);
    check('rested-longer sheet shown', !!win.document.getElementById('mwRested'));
    win.setSetNote(today, 'CP', 2, 'rested longer');
    check('answer saved on the set', s2.note === 'rested longer' && !win.document.getElementById('mwRested'));
    check('note maps to training_sets row', win.trainingSetToRow(s2).note === 'rested longer' && win.rowToTrainingSet({ note: 'x' }).note === 'x');
    win.toggleSetDone(today, 'CP', 3, 60);
    check('fewer reps than failure set: no question', !win.document.getElementById('mwRested'));
    win.toggleSetDone(today, 'CP', 3, 60);
    check('undo clears rest', t.state.training.sets[2].restTakenSec === null);
    // RIR 0 counts like failure, asked once only
    t.state.training.sets = [
      Object.assign(set(1, 8, { done: true, rir: 0, loggedAt: new Date(Date.now() - 40 * 60000).toISOString() }), { date: today, exerciseId: 'CP' }),
      Object.assign(set(2, 9, { note: 'already answered' }), { date: today, exerciseId: 'CP' }),
      Object.assign(set(3, 9), { date: today, exerciseId: 'CP' }),
    ];
    win.toggleSetDone(today, 'CP', 2, 60);
    check('already answered: not asked again', !win.document.getElementById('mwRested'));
    check('gap over 30 min is not rest', t.state.training.sets[1].restTakenSec === null);
    win.setSetMode(today, 'CP', 3, 'rir', 1);
    check('RIR-0 earlier set triggers via RIR picker too', !!win.document.getElementById('mwRested'));
    win.document.querySelectorAll('.modal-overlay').forEach(o => o.remove());
    const pack = win.buildTrainingReviewPack();
    const ws = pack.sessionDetail.find(x => x.exercise === 'Chest Press').workingSets;
    check('pack: restTakenSec and note per set', 'restTakenSec' in ws[0] && ws[1].note === 'already answered');
    t.state.training.sets.push(Object.assign(set(4, 5, { done: true, toFailure: true, rir: null }), { date: today, exerciseId: 'LP' }));
    const fs = win.buildTrainingReviewPack().sessionDetail.find(x => x.exercise === 'Leg Press').workingSets[0];
    check('pack: failure set sent as RIR 0', fs.rir === 0 && fs.toFailure === true);
  }

  // ---- 6. goals out of the code
  { const { win, t, prompt } = setup();
    const src = win.buildTrainingReviewPack.toString();
    check('no hard-coded goal numbers', !/weightLossTargetKg:\s*\d/.test(src) && !/targetWeightKg:\s*\d/.test(src));
    t.state.settings.trainingGoals = { priorityMuscles: [], notes: '' };
    let p = win.buildTrainingReviewPack();
    check('goals null when unset', p.goals.targetWeightKg === null && p.goals.weightLossTargetKg === null);
    check('prompt: no goal numbers when unset', !/lose ~/.test(prompt()));
    t.state.settings.trainingGoals = { priorityMuscles: [], notes: '', targetWeightKg: 77, weightLossTargetKg: 9 };
    p = win.buildTrainingReviewPack();
    check('goals from settings', p.goals.targetWeightKg === 77 && p.goals.weightLossTargetKg === 9);
    check('prompt uses settings goals', prompt().includes('lose ~9kg') && prompt().includes('reach 77kg'));
    win.openTrainingGoalsModal();
    const tg = win.document.getElementById('trainingGoalsTargetKg');
    check('goals modal has target field prefilled', tg && tg.value === '77');
  }

  // ---- 7. current plan only used sessions
  { const { win, t, today } = setup();
    t.state.training.sessions = [{ id: 'A', name: 'Used past', blocks: [] }, { id: 'B', name: 'Used future', blocks: [] }, { id: 'C', name: 'Old template', blocks: [] }];
    t.state.training.calendar = [{ date: win.addDays(today, -5), sessionId: 'A' }, { date: win.addDays(today, 5), sessionId: 'B' }, { date: win.addDays(today, -60), sessionId: 'C' }];
    const names = win.buildTrainingReviewPack().currentPlan.map(s => s.name);
    check('currentPlan drops unused templates', names.length === 2 && !names.includes('Old template'), JSON.stringify(names));
  }

  // ---- 8. prompt
  { const { t, prompt } = setup();
    t.state.settings.trainingGoals = { priorityMuscles: [], notes: '' };
    let txt = prompt();
    const top = txt.indexOf('THIS PROMPT WINS'), rule = txt.indexOf('PROGRESSION RULE'), rev = txt.indexOf('You are reviewing');
    check('prompt wins line at the top', top > 0 && top < rev);
    check('progression rule at the top, stated once', rule > 0 && rule < rev && (txt.match(/BIG-JUMP CHECK before/g) || []).length === 1);
    check('rules list points to it', txt.includes('Progression follows the PROGRESSION RULE at the top'));
    check('no priorities: no priority wording', !/priority-muscle frequency/.test(txt) && !/priority muscle group above/.test(txt));
    t.state.settings.trainingGoals = { priorityMuscles: ['chest'], notes: '' };
    txt = prompt();
    check('with priorities: priority wording present', /priority-muscle frequency/.test(txt) && /priority muscle group above/.test(txt));
    check('single-exercise muscles may repeat 3x', txt.includes('only ONE exercise in my library may repeat that exercise up to 3 times a week'));
    check('variety rule waived for them', txt.includes('It does not apply to a muscle with only one primary exercise'));
    check('4th set as lower-fatigue option', txt.includes('LOWER-FATIGUE OPTION') && txt.includes('or why it was the lower-fatigue option'));
    check('data pack legend', txt.includes('weeklyHistory') && txt.includes('skipReasons'));
  }

  check('changelog 4.75.0', loadApp().__t.CHANGELOG.some(c => c.v === '4.75.0'));
  console.log(`test_v4750: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed:', e && e.stack || e); console.log(`test_v4750: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
