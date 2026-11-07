/* v4.46.1 — friendly sync-error messaging.

   Root cause of the reported sync failures: v4.45.0 started sending
   `lift_type` in every training_exercises upsert, but the person hadn't run
   that version's SQL migration yet, so every push failed with PGRST204
   ("could not find the column"). Since training_exercises is the FIRST step
   in the training domain's sync sequence, that one failure blocked every
   step after it (sessions, calendar, logs, sets, resources) on every sync
   attempt — visible only as a generic "Sync pending" badge whose real
   explanation was buried in a raw JSON tooltip, invisible on touch/mobile
   where tooltips don't exist. No data was lost (local storage always
   succeeds independently of the Supabase push), but nothing had synced
   since that version shipped.

   This suite covers the fix: PGRST204/205 errors are now translated into an
   actionable message, and that message is promoted to the badge's VISIBLE
   text (not just its tooltip) so it's actually seen on mobile. */
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }

/* ---------- 1. friendlySyncError translates known schema-mismatch patterns ---------- */
function translatesSchemaErrors() {
  section('1. friendlySyncError: known patterns translated, everything else passes through');
  const win = loadApp();
  const colMsg = "training_exercises upsert failed: 400 {\"code\":\"PGRST204\",\"details\":null,\"hint\":null,\"message\":\"Could not find the 'lift_type' column of 'training_exercises' in the schema cache\"}";
  const friendly = win.friendlySyncError(colMsg);
  check('names the table and column', friendly.includes('training_exercises.lift_type'), friendly);
  check('points at the fix (Copy SQL)', friendly.includes('Copy SQL'), friendly);
  check('does not leak the raw JSON', !friendly.includes('PGRST204'), friendly);

  const tblMsg = "recipes upsert failed: 404 {\"code\":\"PGRST205\",\"message\":\"Could not find the table 'public.recipes' in the schema cache\"}";
  const friendlyTbl = win.friendlySyncError(tblMsg);
  check('missing-table variant also translated', friendlyTbl.includes('Copy SQL'), friendlyTbl);

  check('an unrelated error passes through unchanged', win.friendlySyncError('Network request failed') === 'Network request failed');
  check('null/empty falls back to a generic waiting message', win.friendlySyncError(null) === 'Changes are waiting to sync');
  check('empty string also falls back', win.friendlySyncError('') === 'Changes are waiting to sync');
}

/* ---------- 2. The sync badge surfaces this VISIBLY, not just in a tooltip ---------- */
function badgeShowsVisibleFix() {
  section('2. Sync badge: schema errors get visible text, not just a tooltip (tooltips are invisible on mobile)');
  const win = loadApp();
  const t = win.__t;
  t.state.settings.sync = { url: 'https://x.example.test', anonKey: 'k', pin: '1' };

  t.state.syncMeta.status = 'error';
  t.state.syncMeta.lastError = "training_exercises upsert failed: 400 {\"code\":\"PGRST204\",\"message\":\"Could not find the 'lift_type' column of 'training_exercises' in the schema cache\"}";
  const schemaHtml = win.syncBadgeHtml();
  check('visible badge text calls out a DB/SQL update, not the generic label',
        schemaHtml.includes('DB needs SQL update'), schemaHtml);
  check('the full explanation is still available in the tooltip',
        schemaHtml.includes('Copy SQL'), schemaHtml);
  check('still clickable to retry', schemaHtml.includes('onclick="retrySync()"'));

  // A generic/unrelated error should NOT get the schema-specific label —
  // only the pattern we can actually act on gets promoted to visible text.
  t.state.syncMeta.lastError = 'Network request failed';
  const genericHtml = win.syncBadgeHtml();
  check('a generic error keeps the ordinary "Sync pending" label',
        genericHtml.includes('Sync pending'), genericHtml);
  check('a generic error does NOT falsely claim a DB update is needed',
        !genericHtml.includes('DB needs SQL update'), genericHtml);
}

/* ---------- 3. Blast-radius documentation: training_exercises really is first ---------- */
function exercisesStepIsFirst() {
  section('3. training_exercises really is the first upsert step in the training domain (confirms the blast radius)');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const m = js.match(/scheduleSync\('training', \(\)=>\[([\s\S]*?)\]\);/);
  check('found the training domain\'s step list', !!m);
  if (m) {
    const steps = m[1];
    const exIdx = steps.indexOf('training_exercises');
    const sessIdx = steps.indexOf('training_sessions');
    check('training_exercises is upserted before training_sessions (so a failure there blocks it)',
          exIdx !== -1 && sessIdx !== -1 && exIdx < sessIdx, `ex@${exIdx} sess@${sessIdx}`);
  }
}

/* ---------- 4. Version discipline ---------- */
function versionDiscipline() {
  section('4. Version and changelog');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const v = /const APP_VERSION = '([\d.]+)'/.exec(js)[1];
  check('the changelog leads with the shipped version',
        new RegExp(`const CHANGELOG = \\[\\s*\\{ v:'${v.replace(/\./g, '\\.')}'`).test(js), v);
  check('the built file carries the same version',
        fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8').includes(`const APP_VERSION = '${v}'`));
}

(async () => {
  translatesSchemaErrors();
  badgeShowsVisibleFix();
  exercisesStepIsFirst();
  versionDiscipline();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
