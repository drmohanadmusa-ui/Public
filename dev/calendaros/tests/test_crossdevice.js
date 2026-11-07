/* Cross-device safety probe.

   Question being answered: can opening CalendarOS on the phone overwrite
   work that was completed on the desktop?

   The path under test is the startup branch in runBackgroundSync():
       if (dirty) push full state   else   pull
   A phone that failed to sync at the gym keeps dirty = true. On its next
   launch it therefore pushes its ENTIRE local state — including its stale
   copy of the task list — without pulling first and without any divergence
   check.
*/
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function configured(win) {
  win.__t.state.settings.sync = {
    url: 'https://proj.example.test', anonKey: 'anon', pin: '1234',
  };
}

async function scenarioDirtyStartup() {
  console.log('\nScenario A — phone launches with unsynced work (dirty)');
  const win = loadApp({
    fetchHandler: (url, method) => {
      if (method === 'GET' && url.includes('/one_time_tasks')) {
        return { status: 200, rows: [{ id: 'T1', pin: '1234', name: 'Pay invoice', done: true, done_date: '2026-09-01', due_history: [] }] };
      }
      return { status: 200, rows: [] };
    },
  });
  const t = win.__t;
  configured(win);
  t.state.settings.healthCoreMetricsSeeded = true; // established install, not first run
  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];

  // The phone's stale view: task T1 is NOT done. On the server (edited later
  // from the desktop) it IS done. The phone has never seen that.
  t.state.tasks.oneTime = [{
    id: 'T1', name: 'Pay invoice', location: 'Site A', silo: 'Alpha',
    priority: 'High', due: '2026-09-01', done: false, doneDate: null,
    notes: '', dueHistory: [],
  }];
  // Only training is outstanding — a failed gym sync, which is how this
  // device came to be dirty in the first place.
  t.state.syncMeta.dirtyDomains = ['training'];
  t.state.syncMeta.dirty = true;

  await win.runBackgroundSync();

  const calls = win.__calls;
  const selects = calls.filter(c => c.method === 'GET');
  const taskPushes = calls.filter(c => c.method === 'POST' && c.url.includes('/one_time_tasks'));

  // BEFORE v4.37.0 this scenario proved the DEFECT: no pull, a full push, and
  // the phone's stale done=false overwriting the server row the desktop had
  // set to done. Those assertions are kept here inverted, as the record of
  // what must never come back.
  check('a pull IS now performed as well as the push', selects.length > 0,
        `${selects.length} GET request(s)`);
  check('the push comes first (a pull first would destroy unsynced local work)',
        calls.findIndex(c => c.method === 'POST') < calls.findIndex(c => c.method === 'GET'));
  check('the stale task list is NOT pushed — only the dirty domain is',
        taskPushes.length === 0, `${taskPushes.length} push(es)`);
  check('the stale done=false never reaches the server',
        !JSON.stringify(calls.filter(c => c.method === 'POST').map(c => c.body)).includes('Pay invoice'));
  check('the device ends clean', t.state.syncMeta.dirty === false,
        JSON.stringify(t.state.syncMeta.dirtyDomains));
}

async function scenarioCleanStartup() {
  console.log('\nScenario B — phone launches clean (dirty = false), for contrast');
  const win = loadApp({
    fetchHandler: () => ({ status: 200, rows: [] }),
  });
  const t = win.__t;
  configured(win);
  t.state.tasks.oneTime = [{ id: 'T1', name: 'Pay invoice', done: false, dueHistory: [] }];
  t.state.syncMeta.dirty = false;

  await win.runBackgroundSync();
  const calls = win.__calls;
  check('a pull IS performed', calls.some(c => c.method === 'GET'));
  // The remote is empty in this scenario, so seeding it from local IS the
  // correct behaviour (`hasAnyRemoteData` guards the destructive direction).
  // What matters is that the pull ran first and could compare.
  const pullIndex = calls.findIndex(c => c.method === 'GET');
  const pushIndex = calls.findIndex(c => c.method === 'POST');
  check('the pull happens before any push', pullIndex >= 0 && (pushIndex === -1 || pullIndex < pushIndex),
        `pull@${pullIndex} push@${pushIndex}`);
}

async function scenarioTrainingFailureMarksGlobalDirty() {
  console.log('\nScenario C — a training-only sync failure sets the GLOBAL dirty flag');
  const win = loadApp({
    fetchHandler: (url, method) => {
      if (method === 'POST' && url.includes('/training_')) return { status: 500, rows: [] };
      return { status: 200, rows: [] };
    },
  });
  const t = win.__t;
  configured(win);
  t.state.training.exercises = [{ id: 'E1', name: 'Chest Press', tags: [] }];
  t.state.training.logs = [{ date: '2026-09-01', exerciseId: 'E1', completed: true, sets: 3, reps: '10', weight: 40 }];
  t.state.syncMeta.dirty = false;

  await win.saveTraining();
  await new Promise(r => setTimeout(r, 60)); // let the queued job drain

  check('a failed training push leaves dirty = true', t.state.syncMeta.dirty === true,
        `dirty = ${t.state.syncMeta.dirty}`);
  check('the in-flight flag is cleared despite the failure',
        t.syncScheduled.training === false, `flag = ${t.syncScheduled.training}`);
}

(async () => {
  await scenarioDirtyStartup();
  await scenarioCleanStartup();
  await scenarioTrainingFailureMarksGlobalDirty();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
