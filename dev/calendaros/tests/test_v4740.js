/* v4.74.0: "too easy" sets count, big-jump check (app + Review Pack), AI vs
   app differences at import, phone new-weight banner, louder chime, Training
   -> Progress tab (weight/volume double graph + strength index).
   All data invented. */
const { loadApp } = require('./harness');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) pass++; else { fail++; console.log('  FAIL', n, d === undefined ? '' : d); } };

function setup(mobile) {
  const win = loadApp(); const t = win.__t;
  win.matchMedia = (q) => ({ matches: !!mobile, media: q, addListener() {}, removeListener() {} });
  if (!win.document.getElementById('mainContent')) { const m = win.document.createElement('div'); m.id = 'mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = () => {};
  t.state.settings.healthCoreMetricsSeeded = true;
  t.state.training.exercises = [
    { id: 'LP', name: 'Leg Press', category: 'strength', muscleGroupsPrimary: ['quads'], weightIncrementKg: 10, tags: [], tagIds: [] },
    { id: 'CP', name: 'Chest Press', category: 'strength', muscleGroupsPrimary: ['chest'], weightIncrementKg: 2.5, tags: [], tagIds: [] },
  ];
  return { win, t, today: win.todayStr() };
}
const sets = (n, reps, kg, rir, extra) => Array.from({ length: n }, (_, i) => Object.assign({ setNo: i + 1, reps, weightKg: kg, rir, isWarmup: false, toFailure: false, done: true }, extra || {}));
const T = { repsMin: 8, repsMax: 12 };

(async () => {
  // ---- 1. too-easy sets count
  { const { win } = setup();
    const easy = win.doubleProgressionSuggestion('CP', T, sets(3, 12, 40, 4));
    check('rule: top of range at RIR 4 adds weight', easy && easy.type === 'addWeight' && easy.newWeightKg === 42.5, JSON.stringify(easy));
    const unknown = win.doubleProgressionSuggestion('CP', T, sets(3, 12, 40, null));
    check('rule: top of range with RIR not logged adds weight', unknown && unknown.type === 'addWeight');
    const mid = win.doubleProgressionSuggestion('CP', T, sets(3, 10, 40, 4));
    check('rule: under the top still adds a rep (unchanged)', mid && mid.type === 'addRep' && mid.repsTarget === 11);
    const low = win.doubleProgressionSuggestion('CP', T, [...sets(2, 12, 40, 1), { setNo: 3, reps: 7, weightKg: 40, rir: 0, isWarmup: false }]);
    check('rule: a set under the bottom still holds (unchanged)', low && low.type === 'hold');
  }

  // ---- 2. big-jump check
  { const { win } = setup();
    const p = win.predictedRepsAtWeight(sets(3, 12, 70, 2), 70, 80);
    check('predict: 70x12 @RIR2 -> about 6.5 reps at 80 kg', Math.abs(p - 6.5) < 0.05, p);
    const a = win.doubleProgressionSuggestion('LP', T, sets(3, 12, 70, 2));
    check('big jump: 10 kg step too early -> build reps', a && a.type === 'addRep' && a.bigJump === true && a.newWeightKg === 70 && a.repsTarget === 13, JSON.stringify(a));
    check('big jump: message explains', a && /big jump/.test(a.message) && /13 reps/.test(a.message), a && a.message);
    const b = win.doubleProgressionSuggestion('LP', T, sets(3, 14, 70, 2));
    check('big jump: 70x14 @RIR2 -> go to 80 kg', b && b.type === 'addWeight' && b.newWeightKg === 80 && b.repsTarget === 8, JSON.stringify(b));
    const c = win.doubleProgressionSuggestion('LP', T, sets(3, 15, 70, 0));
    check('big jump: at the cap (top + 3) the weight goes up anyway', c && c.type === 'addWeight' && c.newWeightKg === 80, JSON.stringify(c));
    const d = win.doubleProgressionSuggestion('LP', T, sets(3, 13, 70, 2));
    check('big jump: target never above top + 3', d && d.repsTarget <= 15, JSON.stringify(d));
    const weakest = win.doubleProgressionSuggestion('LP', T, [...sets(2, 14, 70, 2), { setNo: 3, reps: 12, weightKg: 70, rir: 1, isWarmup: false }]);
    check('big jump: judged on the weakest set', weakest && weakest.type === 'addRep', JSON.stringify(weakest));
    const small = win.doubleProgressionSuggestion('CP', T, sets(3, 12, 40, 1));
    check('big jump: a 2.5 kg step on 40 kg is unaffected', small && small.type === 'addWeight' && small.newWeightKg === 42.5);
  }

  // ---- 3. Next time screen uses it
  { const { win, t, today } = setup(true);
    t.state.training.sets = sets(3, 12, 70, 2, { date: today, exerciseId: 'LP' });
    const s = win.mwSummaryData(today, ['LP'], { LP: { reps: '8-12' } });
    check('next time: leg press stays at 70 (build reps)', s.rows[0].next && s.rows[0].next.type === 'addRep' && s.rows[0].next.to === 70, JSON.stringify(s.rows[0].next));
  }

  // ---- 4. Review Pack carries the same rules
  { const { win } = setup();
    let txt = '';
    win.navigator.clipboard = { writeText: (x) => { txt = x; return Promise.resolve(); } };
    win.copyTrainingReviewPack();
    check('pack: too-easy sets count', txt.includes('a set that felt too easy counts too'));
    check('pack: big-jump check with formula', txt.includes('BIG-JUMP CHECK') && txt.includes('30 × (e1RM / new weight − 1) − 2') && txt.includes('at most 3 reps above the top of the range'));
    check('pack: worked leg press example', txt.includes('70 kg × 12 at RIR 2'));
    check('pack: the decision is spelled out (add if it fits, else build reps, cap)', txt.includes('If that is at least the bottom of the rep range, add the increment and drop back to the bottom of the range') && txt.includes('keep the weight and raise the rep target by one instead') && txt.includes('once I reach that cap, add the increment anyway'));
    check('pack: old RIR-2-or-lower wording gone', !txt.includes('top of the range at RIR 2 or lower'));
  }

  // ---- 5. AI vs app at import
  { const { win, t, today } = setup();
    const past = win.addDays(today, -3), next = win.addDays(today, 2), later = win.addDays(today, 9);
    t.state.training.sets = [...sets(3, 12, 70, 2, { date: past, exerciseId: 'LP' }), ...sets(3, 12, 40, 1, { date: past, exerciseId: 'CP' })];
    const res = { exercises: [], exerciseSuggestions: [],
      sessions: [{ importedId: 's1', fields: { name: 'Legs ' + next, blocks: [
        { exerciseId: 'LP', sets: 3, reps: '8-12', notes: 'suggested starting weight: 80kg' },
        { exerciseId: 'CP', sets: 3, reps: '8-12', notes: 'suggested starting weight: 42.5kg' }] } },
        { importedId: 's2', fields: { name: 'Legs ' + later, blocks: [{ exerciseId: 'LP', sets: 3, reps: '8-12', notes: 'suggested starting weight: 90kg' }] } }],
      calendar: [{ date: later, sessionId: 's2' }, { date: next, sessionId: 's1' }] };
    const diffs = win.computeImportRuleDifferences(res);
    check('import: one difference (leg press), chest press agrees', diffs.length === 1 && diffs[0].exId === 'LP', JSON.stringify(diffs));
    check('import: first planned day compared, AI 80 vs app 70', diffs[0] && diffs[0].date === next && diffs[0].ai === 80 && diffs[0].app === 70, JSON.stringify(diffs[0]));
    // Only differences -> the weight check still opens, with a plain Continue.
    let applied = null;
    win.applyTrainingImportResolution = (r) => { applied = r; };
    win.proceedWithImportApply(res);
    const ov = win.document.getElementById('weightCorrectionsOverlay');
    const h = ov ? ov.innerHTML : '';
    check('import: weight check opens for differences alone', !!ov && h.includes('AI vs the app') && h.includes('rule-diff-row'));
    check('import: AI weight shown first, app second', /AI <b>80 kg<\/b> · App 70 kg/.test(h), h.slice(h.indexOf('rule-diff-row'), h.indexOf('rule-diff-row') + 300));
    check('import: no corrections -> plain Continue button', h.includes('Continue import') && !h.includes('Apply corrections'));
    win.resolveImportWeightCorrections('asis');
    check('import: continue imports the AI weights unchanged', !!applied && /80kg/.test(applied.sessions[0].fields.blocks[0].notes));
    // No history -> nothing to compare.
    t.state.training.sets = [];
    check('import: no history -> no differences', win.computeImportRuleDifferences(res).length === 0);
  }

  // ---- 6. phone new-weight banner
  { const { win, t, today } = setup(true);
    t.state.training.sets = sets(3, 12, 35, 2, { date: win.addDays(today, -4), exerciseId: 'CP' });
    const up = win.mwNewWeightBanner('CP', today, 37.5, false);
    check('banner: heavier', /mw-up/.test(up) && up.includes('New weight') && up.includes('37.5 kg') && up.includes('last time 35 kg'), up);
    const down = win.mwNewWeightBanner('CP', today, 30, false);
    check('banner: lighter', /mw-down/.test(down) && down.includes('Lighter'), down);
    check('banner: same weight -> none', win.mwNewWeightBanner('CP', today, 35, false) === '');
    check('banner: no plan weight -> none', win.mwNewWeightBanner('CP', today, null, false) === '');
    check('banner: walking -> none', win.mwNewWeightBanner('CP', today, 37.5, true) === '');
    check('banner: first time ever -> none', win.mwNewWeightBanner('LP', today, 80, false) === '');
    // In the real phone screen.
    t.state.training.sessions = [{ id: 'S1', name: 'Push', type: 'strength', blocks: [{ exerciseId: 'CP', sets: 3, reps: '8-12', notes: 'suggested starting weight: 37.5kg' }] }];
    t.state.training.calendar = [{ date: today, sessionId: 'S1' }];
    t.state.trainingSelectedDate = today; t.state.trainingSection = 'today'; t.state.view = 'training';
    t.state.settings.mobileWorkoutBeta = true;
    const html = win.renderTrainingView();
    check('banner: shown on the phone workout screen', html.includes('mw-newweight') && html.includes('37.5 kg'));
  }

  // ---- 7. chime 3x louder
  { const { win } = setup();
    const gains = [];
    win._playTone = (f, ms, when, g) => gains.push(g);
    win.playRestTimerTick(); win.playRestTimerDone();
    check('chime: about 3x louder (0.36 / 0.48 / 0.54)', JSON.stringify(gains) === '[0.36,0.48,0.54]', JSON.stringify(gains));
    check('chime: stays under the 1.0 maximum', gains.every(g => g <= 1));
  }

  // ---- 8. Progress tab
  { const { win, t, today } = setup();
    const d = (k) => win.addDays(today, -k);
    t.state.training.sets = [
      ...sets(3, 12, 60, 2, { date: d(40), exerciseId: 'LP' }),
      ...sets(3, 12, 70, 2, { date: d(5), exerciseId: 'LP' }),
      { date: d(5), exerciseId: 'LP', setNo: 0, reps: 10, weightKg: 40, isWarmup: true, done: true },
      { date: d(5), exerciseId: 'LP', setNo: 9, reps: 12, weightKg: 100, isWarmup: false, done: false },
      ...sets(3, 10, 40, 2, { date: d(40), exerciseId: 'CP' }),
      ...sets(3, 10, 40, 2, { date: d(5), exerciseId: 'CP' }),
    ];
    const rows = win.exerciseSessionStats('LP');
    check('stats: one row per day', rows.length === 2, rows.length);
    check('stats: warm-ups and not-done sets excluded', rows[1].topKg === 70 && rows[1].volume === 3 * 12 * 70, JSON.stringify(rows[1]));
    const idx = win.strengthIndexAt(today);
    // LP: 70*1.4 / 60*1.4 - 1 = +16.7%; CP: 0%  -> average 8.3%
    check('index: average change vs 4 weeks earlier', idx && idx.n === 2 && Math.abs(idx.pct - 8.3) < 0.05, JSON.stringify(idx));
    t.state.trainingTrendExId = 'LP';
    const page = win.renderTrainingTrendsSubpage();
    check('page: strength index shown', page.includes('Strength index') && page.includes('+8.3%'));
    check('page: double graph (bars + line)', page.includes('wv-chart') && /<rect[^>]*fill="var\(--teal\)"/.test(page) && /<polyline[^>]*stroke="var\(--brass\)"/.test(page));
    check('page: says warm-ups excluded', page.includes('warm-ups excluded'));
    t.state.view = 'training'; t.state.trainingSection = 'trends';
    const view = win.renderTrainingView();
    check('nav: Progress tab on the Training page', view.includes("'trends'") || view.includes('"trends"') || /Progress/.test(view));
    check('nav: Progress tab renders its page', view.includes('Strength index'));
    t.state.training.sets = [];
    check('page: empty state with no sets', win.renderTrainingTrendsSubpage().includes('Log sets on the Training page'));
  }

  // ---- 9. version
  { const { t } = setup();
    const e = t.CHANGELOG.find(c => c.v === '4.74.0');
    check('changelog 4.74.0', !!e && /No SQL migration needed/.test(e.changes[0]));
  }

  console.log(`test_v4740: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed:', e && e.stack || e); console.log(`test_v4740: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
