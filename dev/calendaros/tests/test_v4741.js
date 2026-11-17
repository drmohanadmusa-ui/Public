/* v4.74.1: Progress charts: fixed size, axes from 0 (line axis to 1.5 x max),
   hover / tap figures. All data invented. */
const { loadApp } = require('./harness');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) pass++; else { fail++; console.log('  FAIL', n, d === undefined ? '' : d); } };

function setup() {
  const win = loadApp(); const t = win.__t;
  win.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {} });
  if (!win.document.getElementById('mainContent')) { const m = win.document.createElement('div'); m.id = 'mainContent'; win.document.body.appendChild(m); }
  win.window.scrollTo = () => {};
  t.state.settings.healthCoreMetricsSeeded = true;
  return { win, t };
}
const rows = [['2026-09-20', 15, 690], ['2026-09-27', 15, 540], ['2026-10-04', 17.5, 630], ['2026-10-11', 17.5, 770]]
  .map(([date, topKg, volume]) => ({ date, topKg, volume }));
const labelsOf = (h) => [...h.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);

(async () => {
  { const { win } = setup();
    win.innerWidth = 1280;
    const h = win.svgWeightVolumeChart(rows);
    check('size: fixed 680-wide drawing on a computer', /viewBox="0 0 680 220"/.test(h), (h.match(/viewBox="[^"]*"/) || [])[0]);
    check('size: capped by CSS at 680px', /\.pc-chart\{position:relative; max-width:680px;/.test(require('fs').readFileSync(__dirname + '/CalendarOS.html', 'utf8')));
    const labels = labelsOf(h);
    check('axis: weight axis starts at 0 kg', labels.includes('0 kg'), labels.join(','));
    check('axis: weight axis tops out at >= 1.5 x max (17.5 -> 30 kg)', labels.includes('30 kg') && !labels.includes('40 kg'), labels.join(','));
    check('axis: lowest weight is not the bottom of the axis', !labels.includes('15 kg'));
    check('axis: volume axis starts at 0', labels.includes('0'));
    check('labels: first and last dates shown', labels.includes('09-20') && labels.includes('10-11'), labels.join(','));
    check('chart: bars + line kept (wv-chart)', h.includes('wv-chart') && /<rect class="pc-bar"[^>]*fill="var\(--teal\)"/.test(h) && /<polyline[^>]*stroke="var\(--brass\)"/.test(h));
    check('hover: one hit column per session', (h.match(/class="pc-hit"/g) || []).length === 4);
    check('hover: tip carries date, weight and volume', /data-tip="[^"]*17.5 kg[^"]*770 kg/.test(h));
    check('too few: message instead of a chart', win.svgWeightVolumeChart(rows.slice(0, 1)).includes('at least 2 days'));
  }
  // Phone width scales the drawing down instead of shrinking the text.
  { const { win } = setup();
    win.innerWidth = 390;
    const h = win.svgWeightVolumeChart(rows);
    check('size: phone drawing matches the screen width', /viewBox="0 0 326 220"/.test(h), (h.match(/viewBox="[^"]*"/) || [])[0]);
  }
  // Interaction in the DOM.
  { const { win } = setup();
    win.innerWidth = 1280;
    const host = win.document.createElement('div'); host.innerHTML = win.svgWeightVolumeChart(rows); win.document.body.appendChild(host);
    const hit = host.querySelectorAll('.pc-hit')[2];
    win.progressChartShow(hit);
    const tip = host.querySelector('.pc-tip');
    check('hover: tip shows the figures', !tip.hidden && tip.innerHTML.includes('17.5 kg') && tip.innerHTML.includes('630 kg'), tip.innerHTML);
    check('hover: guide line shown', host.querySelector('.pc-guide').getAttribute('visibility') === 'visible');
    check('hover: point highlighted', host.querySelectorAll('.pc-dot')[2].getAttribute('r') === '6' && host.querySelectorAll('.pc-dot')[0].getAttribute('r') === '3.5');
    win.progressChartHide(host.querySelector('svg'));
    check('leave: tip hidden again', tip.hidden && host.querySelector('.pc-guide').getAttribute('visibility') === 'hidden');
  }
  // Strength index chart and negative values.
  { const { win } = setup();
    win.innerWidth = 1280;
    const h = win.svgProgressChart({ labels: ['10-13', '10-20', '10-27'], line: [12, 18.9, 15.6], unit: '%', colour: 'var(--teal)', area: true, aria: 'x', tips: ['a', 'b', 'c'] });
    const l = labelsOf(h);
    check('index: axis from 0% to >= 1.5 x max', l.includes('0%') && l.includes('30%'), l.join(','));
    const neg = labelsOf(win.svgProgressChart({ labels: ['a', 'b'], line: [-4, 6], unit: '%', colour: 'x', aria: 'x', tips: ['', ''] }));
    check('index: a negative week extends the axis below 0', neg.some(x => /^-/.test(x)) && neg.includes('0%'), neg.join(','));
  }
  // Page uses the new charts.
  { const { win, t } = setup();
    const today = win.todayStr(); const d = (k) => win.addDays(today, -k);
    t.state.training.exercises = [{ id: 'CP', name: 'Chest Press', category: 'strength', muscleGroupsPrimary: ['chest'], tags: [], tagIds: [] }];
    const mk = (date, kg) => [1, 2, 3].map(n => ({ date, exerciseId: 'CP', setNo: n, reps: 10, weightKg: kg, done: true, isWarmup: false, rir: 2 }));
    t.state.training.sets = [...mk(d(50), 30), ...mk(d(40), 30), ...mk(d(20), 32.5), ...mk(d(5), 35)];
    t.state.trainingTrendExId = 'CP';
    const page = win.renderTrainingTrendsSubpage();
    check('page: both charts interactive', (page.match(/class="pc-chart"/g) || []).length === 2 && page.includes('si-chart') && page.includes('wv-chart'));
    check('page: hint to hover or tap', page.includes('Hover or tap a session'));
  }
  { const { t } = setup();
    const e = t.CHANGELOG.find(c => c.v === '4.74.1');
    check('changelog 4.74.1', !!e && /No SQL migration needed/.test(e.changes[0]));
  }
  console.log(`test_v4741: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed:', e && e.stack || e); console.log(`test_v4741: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
