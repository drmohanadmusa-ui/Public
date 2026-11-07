/* Minimal jsdom harness for CalendarOS.
   Loads index.html (shell) + app.js with the trailing init() removed, so the
   app's functions can be driven directly without a startup sync firing. */
const fs = require('fs');
const { JSDOM } = require('jsdom');

function loadApp(opts = {}) {
  const shell = fs.readFileSync(__dirname + '/index.html', 'utf8')
    .replace('__APP_JS__', ''); // no inline script — we inject manually
  let js = fs.readFileSync(__dirname + '/app.js', 'utf8');

  // Strip the single auto-start call at the very end of the file.
  const trimmed = js.trimEnd();
  if (!trimmed.endsWith('init();')) {
    throw new Error('harness: app.js no longer ends with init(); — update the harness');
  }
  js = trimmed.slice(0, -('init();'.length));

  const dom = new JSDOM(shell, {
    url: 'https://example.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;

  // --- storage stub -------------------------------------------------------
  const store = new Map();
  win.storage = {
    async get(key) {
      if (!store.has(key)) throw new Error('not found: ' + key);
      return { key, value: store.get(key) };
    },
    async set(key, value) { store.set(key, value); return { key, value }; },
    async delete(key) { store.delete(key); return { key, deleted: true }; },
    async list(prefix) { return { keys: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)) }; },
  };
  win.__store = store;

  // --- fetch stub ---------------------------------------------------------
  const calls = [];
  win.__calls = calls;
  win.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: String(url), method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const handler = opts.fetchHandler;
    const res = handler ? handler(String(url), method, init) : null;
    const rows = res && res.rows !== undefined ? res.rows : [];
    const status = res && res.status !== undefined ? res.status : 200;
    const total = res && res.total !== undefined ? res.total : (Array.isArray(rows) ? rows.length : 0);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (h.toLowerCase() === 'content-range' ? `0-${Math.max(0, total - 1)}/${total}` : null) },
      json: async () => rows,
      text: async () => JSON.stringify(rows),
    };
  };

  // `const`/`let` bindings inside eval don't land on `window`, so expose the
  // ones the tests need explicitly.
  js += `
;window.__t = {
  get state(){ return state; },
  get APP_VERSION(){ return APP_VERSION; },
  get syncScheduled(){ return syncScheduled; },
  get pendingDivergence(){ return pendingDivergence; },
  get pendingCompletionDeletes(){ return pendingCompletionDeletes; },
  get SYNCED_TABLES(){ return SYNCED_TABLES; },
  get BACKED_UP_TABLES(){ return BACKED_UP_TABLES; },
  get CHANGELOG(){ return CHANGELOG; },
  get diagLog(){ return diagLog; },
  get restTimerEnd(){ return _restTimerEnd; },
  get restTimerHandle(){ return _restTimerHandle; },
};
`;
  win.eval(js);
  return win;
}

module.exports = { loadApp };
