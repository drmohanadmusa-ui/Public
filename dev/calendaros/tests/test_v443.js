/* v4.43.0 — undo edits/deletes, exercise tags removed, training buttons trimmed, numpad inputs */
const fs = require('fs');
const { loadApp } = require('./harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log('\n' + t); }

/* ---------- 1. Undo a task edit ---------- */
async function undoTaskEdit() {
  section('1. Ctrl+Z undoes a recurring task edit');
  const win = loadApp({ fetchHandler: () => ({ status:200, rows:[] }) });
  win.__t.state.tasks.recurring = [{
    id:'R1', name:'Daily standup', type:'Daily', detail:'Daily',
    location:'Site A', silo:'Alpha', priority:'High', notes:'',
    start:'2026-01-01', end:null, rescheduleExceptions:[],
  }];
  const t = win.__t.state.tasks.recurring[0];
  // Simulate what saveTaskModal does: snapshot, then mutate
  win.pushUndo({ action:'edit_recurring', snapshot: JSON.parse(JSON.stringify(t)) });
  Object.assign(t, { type:'Weekly', detail:'Monday' });
  await win.saveTasks();
  const task = win.__t.state.tasks.recurring.find(x => x.id === 'R1');
  check('task was changed to Weekly', task && task.type === 'Weekly', task && task.type);
  check('undo stack has an entry', win.__t.state.undoStack.length >= 1);
  // Undo
  await win.undoLast();
  const restored = win.__t.state.tasks.recurring.find(x => x.id === 'R1');
  check('task reverted to Daily', restored && restored.type === 'Daily', restored && restored.type);
  check('undo stack is now empty', win.__t.state.undoStack.length === 0);
}

/* ---------- 2. Undo a one-time task edit ---------- */
async function undoOneTimeEdit() {
  section('2. Ctrl+Z undoes a one-time task edit');
  const win = loadApp({ fetchHandler: () => ({ status:200, rows:[] }) });
  win.__t.state.tasks.oneTime = [{
    id:'T1', name:'Pay invoice', location:'Site A', silo:'Alpha',
    priority:'High', notes:'', due:'2026-09-10', done:false, dueHistory:[],
  }];
  const t = win.__t.state.tasks.oneTime[0];
  win.pushUndo({ action:'edit_oneTime', snapshot: JSON.parse(JSON.stringify(t)) });
  Object.assign(t, { name:'Pay invoice EDITED', priority:'Low', due:'2026-09-15' });
  await win.saveTasks();
  const edited = win.__t.state.tasks.oneTime.find(x => x.id === 'T1');
  check('task was edited', edited && edited.name === 'Pay invoice EDITED' && edited.priority === 'Low');
  await win.undoLast();
  const restored = win.__t.state.tasks.oneTime.find(x => x.id === 'T1');
  check('name reverted', restored && restored.name === 'Pay invoice', restored && restored.name);
  check('priority reverted', restored && restored.priority === 'High', restored && restored.priority);
  check('due reverted', restored && restored.due === '2026-09-10', restored && restored.due);
}

/* ---------- 3. Undo a task deletion ---------- */
async function undoTaskDeletion() {
  section('3. Ctrl+Z restores a deleted task');
  const win = loadApp({ fetchHandler: () => ({ status:200, rows:[] }) });
  win.__t.state.tasks.recurring = [{
    id:'R1', name:'Weekly report', type:'Weekly', detail:'Monday',
    location:'Site A', silo:'Alpha', priority:'High', notes:'',
    start:'2026-01-01', end:null, rescheduleExceptions:[],
  }];
  win.__t.state.tasks.completions = { R1: { '2026-09-08': { status:'done', loggedAt:'2026-09-08T10:00:00Z' } } };
  win.confirm = () => true;
  await win.deleteTask('recurring', 'R1');
  check('task was deleted', win.__t.state.tasks.recurring.length === 0);
  check('completions removed', !win.__t.state.tasks.completions.R1);
  await win.undoLast();
  check('task restored', win.__t.state.tasks.recurring.length === 1);
  check('task name correct', win.__t.state.tasks.recurring[0].name === 'Weekly report');
  check('completions restored', !!win.__t.state.tasks.completions.R1, JSON.stringify(win.__t.state.tasks.completions));
}

/* ---------- 4. Undo still works for completion status changes ---------- */
async function undoCompletionStillWorks() {
  section('4. Completion-status undo path unchanged');
  const win = loadApp({ fetchHandler: () => ({ status:200, rows:[] }) });
  const today = win.todayStr();
  win.__t.state.tasks.oneTime = [{
    id:'T1', name:'Test', done:false, doneDate:null, due:today, location:'Site A', silo:'Alpha', priority:'High', notes:'', dueHistory:[],
  }];
  await win.toggleComplete('oneTime', 'T1', today);
  check('task marked done', win.__t.state.tasks.oneTime[0].done === true);
  await win.undoLast();
  check('task reverted to not done', win.__t.state.tasks.oneTime[0].done === false);
}

/* ---------- 5. Exercise tags removed from library UI ---------- */
function tagsRemovedFromLibrary() {
  section('5. Exercise tags not visible in exercise library');
  const win = loadApp();
  win.__t.state.settings.exerciseTags = [{ id:'t1', name:'Arms' }];
  win.__t.state.training.exercises = [
    { id:'E1', name:'Curl', tags:[], tagIds:['t1'], category:'strength', muscleGroup:'biceps' },
  ];
  win.__t.state.trainingSection = 'exercises';
  win.__t.state.view = 'training';
  win.__t.state.muscleGroupFilter = null;
  win.document.getElementById('app').classList.remove('hidden');
  win.render();
  const html = win.document.getElementById('app').innerHTML;
  check('no tag chip filter for Arms', !html.includes('setExerciseTagFilter'), html.slice(0,100));
  check('no Manage tags link in library', !html.includes('openManageExerciseTagsModal'));
  check('muscle group filter still present', html.includes('All muscles'));
  check('exercise still shows in library', html.includes('Curl'));
}

/* ---------- 6. Tags removed from Add/Edit modals ---------- */
function tagsRemovedFromModals() {
  section('6. No tag fields in Add or Edit exercise modals');
  const html = fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8');
  check('newExTagPills removed from HTML', !html.includes('newExTagPills'));
  check('editExTagPills removed from HTML', !html.includes('editExTagPills'));
  // The function definition itself stays (Resources tab also uses it).
  // What must be gone is every exercise-specific UI entry point: buttons in
  // the library header and the edit modal's "Manage tags" link.
  check('Manage tags button removed from library', !html.includes('title="Manage tags"'));
  check('Manage tags link removed from edit modal',
        !html.includes('openManageExerciseTagsModal();" style="display:inline-block'));
  // The manage tags function itself may still exist (for resources) — that is fine
  // What must be gone is every UI entry point that was exercise-specific
}

/* ---------- 7. Training page button count ---------- */
function trainingButtonCount() {
  section('7. Training page has 4 action buttons, not 6');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  check('Copy Import Template button removed', !js.includes("onclick=\"copyTrainingImportTemplate()\""));
  check('Copy Prompt button removed', !js.includes("onclick=\"copyTrainingImportPrompt()\""));
  check('Export button kept', js.includes("onclick=\"exportTrainingJson()\""));
  // v4.50.x: routes through the Training Goals modal first now (confirm/
  // update goals every time), which then calls copyTrainingReviewPack() —
  // the action is still one tap on the same button, just via that modal.
  check('Copy Review Pack kept', js.includes("onclick=\"openTrainingGoalsModal()\"") && js.includes('function saveTrainingGoalsAndCopyPack(){'));
  check('Paste & Import kept', js.includes("onclick=\"openTrainingPasteImportModal()\""));
  check('Import File kept', js.includes("onchange=\"handleImportTrainingJson(event)\""));
}

/* ---------- 8. Numpad attributes on set row inputs ---------- */
function numpadAttributes() {
  section('8. Set row inputs use inputmode="numeric" and enterkeyhint="next"');
  const html = fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8');
  // The attributes are generated inside the JS template literal,
  // so they appear in the built file as strings within the script tag.
  check('inputmode="numeric" on reps input', html.includes('inputmode="numeric"'));
  check("weight input opens the wheel picker (v4.65.0)", html.includes("openNumPicker(this,'weightKg'"));
  check("reps input opens the wheel picker (v4.65.0)", html.includes("openNumPicker(this,'reps'"));
  check('focusNextTrainInput helper exists', html.includes('function focusNextTrainInput('));
  check('Enter key handler wired to focusNextTrainInput',
        html.includes('focusNextTrainInput(this)'));
}

/* ---------- 9. focusNextTrainInput logic ---------- */
function focusNextInputLogic() {
  section('9. focusNextTrainInput moves focus correctly');
  const win = loadApp();
  // Build a minimal DOM simulating two inputs in a card
  win.document.body.innerHTML = `
    <div data-exercise-id="E1">
      <input type="number" class="train-input set-num-input" id="inp1">
      <input type="number" class="train-input set-num-input" id="inp2">
      <button class="btn secondary sm" id="addBtn">+ Set</button>
    </div>`;
  let focusedId = null;
  win.document.getElementById('inp1').focus = () => { focusedId = 'inp1'; };
  win.document.getElementById('inp2').focus = () => { focusedId = 'inp2'; };
  win.document.getElementById('inp2').select = () => {};
  win.document.getElementById('addBtn').focus = () => { focusedId = 'addBtn'; };

  win.focusNextTrainInput(win.document.getElementById('inp1'));
  check('Enter from inp1 focuses inp2', focusedId === 'inp2', focusedId);
  win.focusNextTrainInput(win.document.getElementById('inp2'));
  check('Enter from inp2 (last input) focuses + Set button', focusedId === 'addBtn', focusedId);
}

/* ---------- 10. Version ---------- */
function versionDiscipline() {
  section('10. Version and changelog');
  const js = fs.readFileSync(__dirname + '/app.js', 'utf8');
  const v = /const APP_VERSION = '([\d.]+)'/.exec(js)[1];
  check('version is at least 4.43.0 (this suite\'s own baseline — later bumps are expected and fine)',
        v.split('.').map(Number).reduce((a,b,i)=>a*1000+b,0) >= 4043000, v);
  check('changelog leads with the shipped version',
        new RegExp(`const CHANGELOG = \\[\\s*\\{ v:'${v.replace(/\./g,'\\.')}'`).test(js));
  check('built file carries the same version',
        fs.readFileSync(__dirname + '/CalendarOS.html', 'utf8').includes(`const APP_VERSION = '${v}'`));
  const win = loadApp();
  check('backup coverage still complete',
        win.__t.SYNCED_TABLES.every(x => win.__t.BACKED_UP_TABLES.includes(x)));
}

(async () => {
  await undoTaskEdit();
  await undoOneTimeEdit();
  await undoTaskDeletion();
  await undoCompletionStillWorks();
  tagsRemovedFromLibrary();
  tagsRemovedFromModals();
  trainingButtonCount();
  numpadAttributes();
  focusNextInputLogic();
  versionDiscipline();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
