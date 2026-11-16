/* v4.73.0: night mode styles (Warm Charcoal default, True Black, Midnight
   Slate) + night-mode readability fixes. All data invented.
   The contrast itself was measured in a real browser (Chromium) when this
   shipped: 0 text items below 4.5:1 on 12 pages, computer and phone, for each
   style. These tests guard the wiring and the CSS that produced that result. */
const fs = require('fs');
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
const html = fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8');
const css = (() => { const i = html.indexOf('<style>'), j = html.indexOf('</style>'); return i >= 0 && j > i ? html.slice(i, j) : ''; })();
function block(sel) {
  const i = css.indexOf(sel + '{'); if (i < 0) return '';
  const j = css.indexOf('}', i); return j > i ? css.slice(i, j) : '';
}
const TOKENS = ['--ink', '--ink-soft', '--ink-faint', '--paper', '--paper-raised', '--paper-dim', '--line', '--sidebar',
  '--brass', '--brass-deep', '--on-accent', '--teal', '--teal-soft', '--flag', '--flag-soft', '--accent-soft', '--completed-color', '--completed-deep'];

(async () => {
  // ---- 1. CSS: every style defines the full token set (the old bug: only page + text were redefined)
  const styles = { charcoal: block('body.dark-mode'), black: block('body.dark-mode[data-dark-style="black"]'), slate: block('body.dark-mode[data-dark-style="slate"]') };
  Object.entries(styles).forEach(([k, b]) => {
    const missing = TOKENS.filter(tk => !new RegExp(tk + '\\s*:').test(b));
    check(`css: ${k} style defines every night token`, b.length > 0 && missing.length === 0, missing.join(','));
  });
  check('css: charcoal is the plain dark-mode palette (default)', /--paper:#15171B/.test(styles.charcoal));
  check('css: true black page is black', /--page-gradient:\s*#000000/.test(styles.black));
  // Component fixes must sit after the daytime rules they correct.
  const fixesAt = css.indexOf('NIGHT MODE COMPONENT FIXES (v4.73.0)');
  check('css: component fixes are at the end of the stylesheet', fixesAt > css.indexOf('.radio-pill.active{') && fixesAt > css.indexOf('.chip-select button.active{') && fixesAt > css.indexOf('table.log-table tr.log-row-active td{'));
  const fixes = fixesAt > 0 ? css.slice(fixesAt) : '';
  check('fix: selected pills use the accent with dark text', /body\.dark-mode \.chip-select button\.active,body\.dark-mode \.radio-pill\.active\{background:var\(--brass\);border-color:var\(--brass\);color:var\(--on-accent\);\}/.test(fixes));
  check('fix: main buttons use the accent with dark text', /body\.dark-mode \.btn:not\(\.secondary\):not\(\.ghost\):not\(\.brass\):not\(\.danger\)\{background:var\(--brass\)[^}]*color:var\(--on-accent\)/.test(fixes));
  check('fix: health history highlighted row readable', /body\.dark-mode table\.log-table tr\.log-row-active td\{background:var\(--accent-soft\);color:var\(--ink\);\}/.test(fixes));
  check('fix: completed titles lifted', /body\.dark-mode \.ticket\.done \.ticket-title\{color:var\(--ink-soft\);\}/.test(fixes));
  check('fix: overdue card gets dark tint, not pale stripe', /body\.dark-mode \.ticket\.overdue\{[^}]*var\(--flag-soft\)/.test(fixes));
  check('fix: Yes/No toggle and danger button use dark text', /\.toggle-yn button\.active\{color:var\(--on-accent\);\}/.test(fixes) && /\.btn\.danger\{color:var\(--on-accent\);\}/.test(fixes));
  check('fix: every fix only applies in night mode', fixes.split('\n').filter(l => /\{/.test(l) && !/^\s*\/\*/.test(l)).every(l => l.trim().startsWith('body.dark-mode')),
    fixes.split('\n').filter(l => /\{/.test(l) && !l.trim().startsWith('body.dark-mode')).slice(0, 2).join(' | '));
  check('css: stays out of @media so desktop rules keep their order', !/@media/.test(fixes));

  // ---- 2. Setting + body attribute
  { const { win, t } = setup();
    check('setting: default is Warm Charcoal', (t.state.settings.darkStyle || 'charcoal') === 'charcoal');
    t.state.settings.darkMode = true;
    win.applyDynamicTheme();
    check('body: charcoal has no data-dark-style', win.document.body.classList.contains('dark-mode') && !win.document.body.hasAttribute('data-dark-style'));
    win.setDarkStyle('black');
    check('body: True Black sets data-dark-style="black"', win.document.body.getAttribute('data-dark-style') === 'black' && t.state.settings.darkStyle === 'black');
    win.setDarkStyle('slate');
    check('body: Midnight Slate sets data-dark-style="slate"', win.document.body.getAttribute('data-dark-style') === 'slate');
    win.setDarkStyle('neon');
    check('setting: unknown style ignored', t.state.settings.darkStyle === 'slate');
    t.state.settings.darkStyle = 'garbage'; win.applyDynamicTheme();
    check('body: bad stored value falls back to charcoal', !win.document.body.hasAttribute('data-dark-style'));
    win.setDarkStyle('charcoal');
    check('body: back to charcoal removes the attribute', !win.document.body.hasAttribute('data-dark-style'));
    // Settings page shows the three choices, the current one selected.
    t.state.settings.darkStyle = 'black';
    const page = win.renderSettingsAppearance();
    const sw = (page.match(/dark-style-swatch/g) || []).length;
    check('settings: three Night Mode Style choices', page.includes('Night Mode Style') && sw === 3, sw);
    check('settings: labels', page.includes('Warm Charcoal') && page.includes('True Black') && page.includes('Midnight Slate'));
    check('settings: current one marked selected', /dark-style-swatch selected"[^>]*setDarkStyle\('black'\)/.test(page));
    // Not synced (device-only, like darkMode).
    const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
    check('sync: night style is not sent to Supabase', !/dark_style/.test(src));
  }

  // ---- 3. Tag colours: lighter at night, stored colours untouched
  { const { win, t } = setup();
    t.state.settings.siloColors = { Alpha: '#4C7A3D' };
    t.state.settings.silos = ['Alpha'];
    t.state.settings.darkMode = false;
    check('tags: daytime colour unchanged', win.tagDisplayColor('#4C7A3D') === '#4C7A3D');
    t.state.settings.darkMode = true;
    const night = win.tagDisplayColor('#4C7A3D');
    check('tags: night colour is lighter', /^#[0-9a-f]{6}$/i.test(night) && night.toLowerCase() !== '#4c7a3d' && parseInt(night.slice(1, 3), 16) > 0x4C, night);
    check('tags: non-hex values pass through', win.tagDisplayColor('var(--teal)') === 'var(--teal)');
    check('tags: stored silo colour not changed', t.state.settings.siloColors.Alpha === '#4C7A3D' && win.siloColor('Alpha') === '#4C7A3D');
    const task = { id: 'x', name: 'AlphaTask', location: 'Home', silo: 'Alpha', priority: 'Medium', type: 'Daily', detail: '', start: '2026-01-01' };
    t.state.tasks.recurring = [task];
    const settingsHtml = win.renderSettingsGeneral() + win.renderSettingsAppearance();
    check('settings: colour picker still shows the stored colour at night', settingsHtml.includes('value="#4C7A3D"'));
    check('settings: preview tag shows the night colour', settingsHtml.includes(`color:${night};`));
  }

  // ---- 4. Custom accent stays visible at night (lightened), default uses the style's gold
  { const { win, t } = setup();
    t.state.settings.darkMode = true; t.state.settings.accentColor = '#B9862F';
    win.applyDynamicTheme();
    const dyn = () => (win.document.getElementById('dynamicTheme') || {}).textContent || '';
    check('accent: default accent adds no night override', !/body\.dark-mode, body\.dark-mode\[data-dark-style\]/.test(dyn()));
    t.state.settings.accentColor = '#3E6491';
    win.applyDynamicTheme();
    check('accent: custom accent lightened for night', dyn().includes(`--brass:${win.nightTagColor('#3E6491')}`), dyn().slice(-160));
    t.state.settings.darkMode = false; win.applyDynamicTheme();
    check('accent: no night override in daytime', !/body\.dark-mode, body\.dark-mode\[data-dark-style\]/.test(dyn()));
  }

  // ---- 5. Version
  { const { t } = setup();
    const e = t.CHANGELOG.find(c => c.v === '4.73.0');
    check('changelog 4.73.0', !!e);
    check('changelog 4.73.0 says no SQL', !!e && /No SQL migration needed/.test(e.changes[0]));
  }

  console.log(`test_v4730: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL crashed:', e && e.stack || e); console.log(`test_v4730: ${pass} passed, ${fail + 1} failed`); process.exit(1); });
