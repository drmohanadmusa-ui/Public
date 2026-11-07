/* v4.72.0: Weekdays repeat, Health Log Alt+arrow day shortcut, weekly set
   targets per muscle (+ Review Pack), muscle-specific rest tips.
   All data invented. */
const fs = require('fs');
const { loadApp } = require('./harness');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) pass++; else { fail++; console.log('  FAIL', n, d === undefined ? '' : d); } };

function setup(opts) {
  const win = loadApp(opts); const t = win.__t;
  win.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {} });
  if (!win.document.getElementById('mainContent')) { const m = win.document.createElement('div'); m.id = 'mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = () => {};
  t.state.settings.healthCoreMetricsSeeded = true;
  return { win, t };
}
// First date on/after `from` whose weekday abbreviation is `abbr`.
function nextDow(win, from, abbr) {
  for (let i = 0; i < 7; i++) { const d = win.addDays(from, i); if (win.DOW_ABBR ? false : true) {} const dow = new Date(d + 'T12:00:00').getDay(); if (['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow] === abbr) return d; }
  return null;
}

(async () => {
  // ================= 1. Weekdays repeat =================
  { const { win, t } = setup();
    t.state.settings.weekendDays = ['Fri', 'Sat'];
    const base = '2026-03-01';
    const task = { id: 'w1', name: 'AlphaTask', location: 'Home', silo: 'Alpha', priority: 'Medium', type: 'Weekdays', detail: '', start: '2026-01-01', end: null, notes: '' };
    const due = {};
    ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(a => { due[a] = win.isDueOn(task, nextDow(win, base, a)); });
    check('weekdays: due Sun-Thu with Fri/Sat weekend', due.Sun && due.Mon && due.Tue && due.Wed && due.Thu, JSON.stringify(due));
    check('weekdays: not due Fri/Sat', !due.Fri && !due.Sat, JSON.stringify(due));
    t.state.settings.weekendDays = ['Sat', 'Sun'];
    check('weekdays: follows the Weekend days setting (Sat/Sun weekend -> Fri due, Sun not)',
      win.isDueOn(task, nextDow(win, base, 'Fri')) === true && win.isDueOn(task, nextDow(win, base, 'Sun')) === false);
    check('weekdays: respects start date', win.isDueOn({ ...task, start: '2026-06-01' }, nextDow(win, '2026-05-01', 'Mon')) === false);
    check('weekdays: respects end date', win.isDueOn({ ...task, end: '2026-02-01' }, nextDow(win, base, 'Mon')) === false);
    const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
    const rt = src.match(/const RECUR_TYPES = \[([^\]]*)\]/);
    check('weekdays: listed in RECUR_TYPES (drives dropdown + Frequency filter)', !!rt && rt[1].includes("'Weekdays'"), rt && rt[1]);
    check('weekdays: has a default colour', /'Weekdays':\s*'#[0-9A-Fa-f]{6}'/.test(src));
    t.state.settings.weekendDays = ['Fri', 'Sat'];
    const detailHtml = win.recurDetailInputHtml('Weekdays', '');
    check('weekdays: detail field is disabled and names the days', /disabled/.test(detailHtml) && detailHtml.includes('Sun, Mon, Tue, Wed, Thu'), detailHtml);
    check('daily-like: Weekdays and Daily yes, Days of Week no',
      win.isDailyLikeRecur({ type: 'Weekdays' }) && win.isDailyLikeRecur({ type: 'Daily' }) && !win.isDailyLikeRecur({ type: 'Days of Week' }));
    // Overdue: a missed Weekdays occurrence is not pinned; a Days of Week one still is (control).
    const today = win.todayStr();
    t.state.settings.weekendDays = [];
    t.state.tasks.recurring = [
      { id: 'wk', name: 'WeekdayTask', location: 'Home', silo: 'Alpha', priority: 'Medium', type: 'Weekdays', detail: '', start: win.addDays(today, -5), end: null, notes: '' },
      { id: 'dw', name: 'DowTask', location: 'Home', silo: 'Alpha', priority: 'Medium', type: 'Days of Week', detail: 'Sun,Mon,Tue,Wed,Thu,Fri,Sat', start: win.addDays(today, -5), end: null, notes: '' },
    ];
    t.state.tasks.completions = {};
    const od = win.getOverdueRecurring().map(r => r.task.id);
    check('overdue: Weekdays not pinned as overdue (like Daily)', !od.includes('wk'), od.join(','));
    check('overdue: Days of Week still pinned (control)', od.includes('dw'), od.join(','));
  }

  // ================= 2. Health Log Alt+arrow =================
  { const { win, t } = setup();
    const today = win.todayStr();
    const d0 = win.addDays(today, -3);
    t.state.healthMetricDefs = [
      { id: 'mA', name: 'Steps', type: 'number', sortOrder: 0, visible: true },
      { id: 'mB', name: 'Mood', type: 'text', sortOrder: 1, visible: true },
    ];
    t.state.health = [];
    t.state.view = 'health';
    t.state.healthViewDate = d0;
    win.renderMain();
    const html = win.document.getElementById('mainContent').innerHTML;
    check('health: keyboard hint shown', html.includes('kbd-hint') && html.includes('Alt+'));
    let inp = win.document.querySelector('.health-input-card input[data-metric-id="mA"]');
    check('health: number input carries its metric id', !!inp);
    if (inp) {
      inp.focus(); inp.value = '4321';
      await win.healthDateShortcut(-1);
      const e0 = t.state.health.find(h => h.date === d0);
      const e1 = t.state.health.find(h => h.date === win.addDays(d0, -1));
      const v0 = e0 ? win.getMetricValue(e0, t.state.healthMetricDefs[0]) : undefined;
      check('health: typed value saved to the day it was typed for', v0 === 4321, JSON.stringify(e0));
      check('health: nothing written to the new day', !e1 || win.getMetricValue(e1, t.state.healthMetricDefs[0]) == null, JSON.stringify(e1));
      check('health: moved one day back', t.state.healthViewDate === win.addDays(d0, -1), t.state.healthViewDate);
      const act = win.document.activeElement;
      check('health: cursor back in the same metric box', !!act && act.dataset && act.dataset.metricId === 'mA', act && act.outerHTML && act.outerHTML.slice(0, 80));
      // old element's on-change is detached: firing change on a detached old input must not write anywhere
      inp.dispatchEvent(new win.Event('change'));
      const e1b = t.state.health.find(h => h.date === win.addDays(d0, -1));
      check('health: old box cannot save into the new day', !e1b || win.getMetricValue(e1b, t.state.healthMetricDefs[0]) == null);
    }
    // Moving without typing writes no values. (Showing a date always creates an
    // empty in-memory entry for it; that is existing behaviour, same as the buttons.)
    let txt = win.document.querySelector('.health-input-card input[data-metric-id="mB"]');
    if (txt) { txt.focus(); await win.healthDateShortcut(-1); }
    const valued = t.state.health.filter(h => h.date !== d0 && t.state.healthMetricDefs.some(m => { const v = win.getMetricValue(h, m); return v !== null && v !== undefined && v !== ''; }));
    check('health: moving without typing writes no values', valued.length === 0, JSON.stringify(valued));
    check('health: text box focus kept', !!win.document.activeElement && win.document.activeElement.dataset.metricId === 'mB');
    // Forward stops at today.
    t.state.healthViewDate = today; win.renderMain();
    await win.healthDateShortcut(1);
    check('health: next stops at today', t.state.healthViewDate === today, t.state.healthViewDate);
    // Real key events.
    t.state.healthViewDate = d0; win.renderMain();
    const ev = new win.KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
    win.document.dispatchEvent(ev);
    await new Promise(r => setTimeout(r, 20));
    check('health: Alt+Left moves back a day', t.state.healthViewDate === win.addDays(d0, -1), t.state.healthViewDate);
    check('health: Alt+Left does not trigger browser Back', ev.defaultPrevented === true);
    const ev2 = new win.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true });
    win.document.dispatchEvent(ev2);
    await new Promise(r => setTimeout(r, 20));
    check('health: Alt+Right moves forward a day', t.state.healthViewDate === d0, t.state.healthViewDate);
    const ev3 = new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    win.document.dispatchEvent(ev3);
    await new Promise(r => setTimeout(r, 20));
    check('health: plain Left arrow does nothing', t.state.healthViewDate === d0 && !ev3.defaultPrevented);
    t.state.view = 'dashboard';
    const ev4 = new win.KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
    win.document.dispatchEvent(ev4);
    await new Promise(r => setTimeout(r, 20));
    check('health: shortcut only on the Health Log page', t.state.healthViewDate === d0 && !ev4.defaultPrevented);
  }

  // ================= 3. Weekly set targets per muscle =================
  { const { win, t } = setup({ fetchHandler: () => ({ status: 200, rows: [] }) });
    t.state.settings.muscleBand = { min: 10, max: 20 };
    const sug = { chest: [10, 16], lats: [10, 18], shoulders: [10, 16], quads: [10, 16], biceps: [8, 14], triceps: [8, 14],
      hamstrings: [8, 14], glutes: [8, 14], traps: [6, 12], abs: [6, 12], lower_back: [4, 8] };
    const allSug = Object.entries(sug).every(([mg, [a, b]]) => { const r = win.muscleBandFor(mg); return r.min === a && r.max === b; });
    check('targets: suggested defaults used when nothing edited', allSug, JSON.stringify(win.allMuscleTargets()));
    check('targets: all 11 muscle groups covered', Object.keys(win.allMuscleTargets()).length === 11);
    check('targets: colour uses the muscle\'s own range (6 sets: traps in range, chest under)',
      win.muscleVolumeColour(6, win.muscleBandFor('traps')) === 'var(--teal)' && win.muscleVolumeColour(6, win.muscleBandFor('chest')) === '#E9B84A');
    t.state.settings.sync = { url: 'https://proj.example.test', anonKey: 'anon', pin: '1234' };
    win.setMuscleTarget('chest', 'min', 12);
    const pm = t.state.settings.muscleBand.perMuscle;
    check('targets: edit stored per muscle', pm && pm.chest && pm.chest.min === 12 && pm.chest.max === 16, JSON.stringify(pm && pm.chest));
    check('targets: first edit freezes the other muscles at their current values', pm && pm.traps && pm.traps.min === 6 && pm.lower_back.max === 8);
    check('targets: old shared min/max kept for older app versions', t.state.settings.muscleBand.min === 10 && t.state.settings.muscleBand.max === 20);
    win.setMuscleTarget('chest', 'min', 20);
    check('targets: min above max lifts max', win.muscleBandFor('chest').min === 20 && win.muscleBandFor('chest').max === 20);
    win.setMuscleTarget('abs', 'max', 3);
    check('targets: max below min lowers min', win.muscleBandFor('abs').min === 3 && win.muscleBandFor('abs').max === 3);
    let toast = '';
    win.showToast = (m) => { toast = m; };
    win.setMuscleTarget('biceps', 'min', 'abc');
    check('targets: invalid value rejected', win.muscleBandFor('biceps').min === 8 && /whole number/.test(toast), toast);
    win.setMuscleTarget('biceps', 'max', 99);
    check('targets: above 50 rejected', win.muscleBandFor('biceps').max === 14);
    await new Promise(r => setTimeout(r, 200));
    const pushes = win.__calls.filter(c => c.method === 'POST' && c.url.includes('app_settings'));
    const body = pushes.length ? pushes[pushes.length - 1].body[0] : null;
    check('targets: per-muscle values sync inside muscle_band', !!body && body.muscle_band && body.muscle_band.perMuscle && body.muscle_band.perMuscle.chest.min === 20,
      JSON.stringify(body && body.muscle_band));
    win.confirm = () => true;
    win.resetMuscleTargets();
    check('targets: reset restores suggested', win.muscleBandFor('chest').min === 10 && win.muscleBandFor('abs').max === 12);
    // Bad stored data falls back safely.
    t.state.settings.muscleBand.perMuscle.glutes = { min: 9, max: 'x' };
    check('targets: malformed stored range falls back to suggested', win.muscleBandFor('glutes').min === 8 && win.muscleBandFor('glutes').max === 14);
    // Panel: editor rows + range next to names.
    t.state.muscleTargetsOpen = false;
    let panel = win.renderWeeklyVolumePanel();
    check('panel: range shown next to each muscle name', panel.includes('muscle-target-range') && panel.includes('10–16'));
    check('panel: editor closed by default', panel.includes('Weekly targets per muscle') && !panel.includes('muscle-target-row'));
    check('panel: old single Band row gone', !panel.includes("setMuscleBand('min'"));
    t.state.muscleTargetsOpen = true;
    panel = win.renderWeeklyVolumePanel();
    const rows = (panel.match(/class="muscle-target-row"/g) || []).length;
    check('panel: one editor row per muscle', rows === 11, rows);
    check('panel: reset button and reasons', panel.includes('resetMuscleTargets()') && panel.includes('Why these numbers'));
    // Review Pack.
    win.setMuscleTarget('glutes', 'min', 9);
    let txt = '';
    win.navigator.clipboard = { writeText: (x) => { txt = x; return Promise.resolve(); } };
    win.copyTrainingReviewPack();
    check('pack: prompt produced', txt.length > 5000, txt.length);
    check('pack: targets table present', txt.includes('WEEKLY SET TARGETS PER MUSCLE') && txt.includes('- Chest (chest): MIN 10, MAX 16 sets/week'));
    check('pack: user edits marked', txt.includes('- Glutes (glutes): MIN 9, MAX 14 sets/week (my own setting)'));
    check('pack: every muscle listed', ['Chest','Traps','Lats','Lower Back','Shoulders','Biceps','Triceps','Quads','Hamstrings','Glutes','Abs'].every(l => txt.includes(`- ${l} (`)));
    check('pack: rationale included', txt.includes('WHY THESE RANGES') && txt.includes('calorie deficit') && txt.includes('Pelland') && txt.includes('Roth'));
    check('pack: per-muscle floor wording', txt.includes('AT LEAST its own MIN from the WEEKLY SET TARGETS table'));
    check('pack: no single shared band left in the prompt', !/AT LEAST \d+ sets\/week/.test(txt) && !/vs the \d+\D\d+ set band/.test(txt));
    const sumMin = Object.values(win.allMuscleTargets()).reduce((a, r) => a + r.min, 0);
    check('pack: capacity check with the real sum', txt.includes(`the MINs add up to ${sumMin} sets/week`), sumMin);
    check('pack: data pack carries weeklySetTargets', /"weeklySetTargets":\s*\{/.test(txt) && txt.includes('"lower_back": {'));
    // Capacity warning when there is not enough room.
    t.state.settings.weekendDays = ['Sun','Mon','Tue','Wed','Thu','Fri'];
    const block = win.buildWeeklySetTargetsPromptBlock(1);
    check('pack: warns when MINs do not fit', block.includes('LESS than the MINs need'));
    check('pack: no warning when they fit', !win.buildWeeklySetTargetsPromptBlock(5).includes('LESS than the MINs need'));
  }

  // ================= 4. Rest tips =================
  { const { win, t } = setup();
    t.state.training.exercises = [
      { id: 'exC', name: 'Machine Press', category: 'strength', muscleGroupsPrimary: ['chest'], muscleGroupsSecondary: ['triceps'] },
      { id: 'exN', name: 'Mystery Move', category: 'strength', muscleGroupsPrimary: [], muscleGroupsSecondary: [] },
      { id: 'exQ', name: 'Leg Press', category: 'strength', muscleGroupsPrimary: ['quads', 'glutes'], muscleGroupsSecondary: [] },
    ];
    t.state.training.exercises.push({ id: 'exAll', name: 'All', category: 'strength',
      muscleGroupsPrimary: ['chest','traps','lats','lower_back','shoulders','biceps','triceps','quads','hamstrings','glutes','abs'], muscleGroupsSecondary: [] });
    const allMuscleTips = new Set(win.restTipPoolForExercise('exAll'));
    const isGeneral = (x) => typeof x === 'string' && x.length > 5 && !allMuscleTips.has(x);
    check('tips: muscle tip list loaded for the checks below', allMuscleTips.size >= 44, allMuscleTips.size);
    const box = win.document.createElement('div'); box.id = 'restTimerDisplay'; win.document.body.appendChild(box);
    win.startRestTimer(90, 'exC');
    const first = win.currentRestTip();
    check('tips: first tip is for the primary muscle', first.startsWith('Chest:'), first);
    const el = win.document.getElementById('restTimerTip');
    check('tips: shown in the timer box', !!el && el.textContent === first, el && el.textContent);
    win._rotateTip();
    const second = win.currentRestTip();
    check('tips: second tip is general', isGeneral(second), second);
    win._rotateTip();
    check('tips: then a muscle tip again', win.currentRestTip().startsWith('Chest:'), win.currentRestTip());
    const pool = win.restTipPoolForExercise('exC');
    check('tips: secondary muscle not used for muscle tips', pool.length >= 4 && pool.every(x => x.startsWith('Chest:')), pool.length);
    // A fresh exercise has a fresh shuffle bag, so one full lap must show every tip once.
    t.state.training.exercises.push({ id: 'exC2', name: 'Cable Fly', category: 'strength', muscleGroupsPrimary: ['chest'], muscleGroupsSecondary: [] });
    const seen = new Set();
    for (let i = 0; i < pool.length; i++) { const p = win._nextMuscleTip('exC2'); if (p) seen.add(p); }
    check('tips: muscle tips do not repeat within a lap', seen.size === pool.length, `${seen.size}/${pool.length}`);
    const pq = win.restTipPoolForExercise('exQ');
    check('tips: two primary muscles share one pool', pq.some(x => x.startsWith('Quads:')) && pq.some(x => x.startsWith('Glutes:')));
    win.stopRestTimer();
    win.startRestTimer(90, 'exN');
    check('tips: no muscle -> general tip', isGeneral(win.currentRestTip()), win.currentRestTip());
    win.stopRestTimer();
    const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
    const groups = (src.match(/const MUSCLE_GROUPS = \[([^\]]*)\]/) || [, ''])[1].match(/'[a-z_]+'/g) || [];
    const ok = groups.length === 11 && groups.every(g => { const k = g.slice(1, -1); const r = win.restTipPoolForExercise; return true; });
    const missing = groups.map(g => g.slice(1, -1)).filter(mg => {
      t.state.training.exercises.push({ id: 'p_' + mg, name: mg, category: 'strength', muscleGroupsPrimary: [mg] });
      return win.restTipPoolForExercise('p_' + mg).length < 4;
    });
    check('tips: every tracked muscle has at least 4 tips', ok && missing.length === 0, missing.join(','));
    check('tips: phone bottom bar shows the same tip element', /body\.mw-focus \.rest-timer-tip\{/.test(fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8')));
  }

  // ================= 5. Version =================
  { const { t } = setup();
    check('changelog 4.72.0', t.CHANGELOG.some(c => c.v === '4.72.0'));
    const e = t.CHANGELOG.find(c => c.v === '4.72.0');
    check('changelog 4.72.0 says no SQL', !!e && /No SQL migration needed/.test(e.changes[0]));
  }

  console.log(`test_v4720: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed:', e && e.stack || e); console.log(`test_v4720: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
